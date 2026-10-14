import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

/** PostgreSQL image used by every Shutro integration test. Latest stable major (`CLAUDE.md`). */
export const POSTGRES_IMAGE = 'postgres:18';
/** PgBouncer image (≥ 1.21 for protocol-level prepared statements). */
export const PGBOUNCER_IMAGE = 'edoburu/pgbouncer:latest';

/** Options for {@link startPostgres}. */
export interface StartPostgresOptions {
  /** Docker image. Defaults to {@link POSTGRES_IMAGE}. */
  readonly image?: string;
  /**
   * Trade durability for speed (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`).
   * Safe for throwaway test databases. Defaults to `true`.
   */
  readonly fast?: boolean;
  /**
   * Also start PgBouncer in front of the server, in transaction pooling mode with
   * `max_prepared_statements = 200` (the production setup RFC 0003/0007 target). Defaults to `false`.
   */
  readonly pgbouncer?: boolean;
}

/** A running PostgreSQL container (and optionally PgBouncer). */
export interface StartedPostgres {
  /** Direct connection URL (`postgres://user:password@host:port/database`). */
  readonly url: string;
  /** URL through PgBouncer, when started with `pgbouncer: true`. */
  readonly bouncerUrl: string | undefined;
  /** Stops and removes the containers. */
  stop(): Promise<void>;
}

const USER = 'shutro';
const PASSWORD = 'shutro';
const DATABASE = 'shutro';

/**
 * Starts a disposable PostgreSQL server in Docker, optionally behind PgBouncer.
 *
 * @example
 * ```ts
 * let pg: StartedPostgres;
 * beforeAll(async () => { pg = await startPostgres({ pgbouncer: true }); }, 180_000);
 * afterAll(() => pg.stop());
 * ```
 *
 * @throws When Docker is not available. The error comes from Testcontainers: start Docker Desktop (or a Docker
 * daemon) and retry.
 */
export async function startPostgres(options: StartPostgresOptions = {}): Promise<StartedPostgres> {
  const fast = options.fast ?? true;
  const network: StartedNetwork | undefined = options.pgbouncer
    ? await new Network().start()
    : undefined;
  let container = new PostgreSqlContainer(options.image ?? POSTGRES_IMAGE)
    .withDatabase(DATABASE)
    .withUsername(USER)
    .withPassword(PASSWORD)
    .withCommand(
      fast
        ? [
            'postgres',
            '-c',
            'fsync=off',
            '-c',
            'synchronous_commit=off',
            '-c',
            'full_page_writes=off',
          ]
        : ['postgres'],
    );
  if (network !== undefined) container = container.withNetwork(network).withNetworkAliases('pg');
  const pg: StartedPostgreSqlContainer = await container.start();

  let bouncer: StartedTestContainer | undefined;
  if (network !== undefined) {
    bouncer = await new GenericContainer(PGBOUNCER_IMAGE)
      .withNetwork(network)
      .withEnvironment({
        DATABASE_URL: `postgres://${USER}:${PASSWORD}@pg:5432/${DATABASE}`,
        AUTH_TYPE: 'scram-sha-256',
        POOL_MODE: 'transaction',
        MAX_PREPARED_STATEMENTS: '200',
        DEFAULT_POOL_SIZE: '20',
        MAX_CLIENT_CONN: '500',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
  }

  return {
    url: pg.getConnectionUri(),
    bouncerUrl:
      bouncer === undefined
        ? undefined
        : `postgres://${USER}:${PASSWORD}@${bouncer.getHost()}:${bouncer.getMappedPort(5432)}/${DATABASE}`,
    async stop() {
      await bouncer?.stop();
      await pg.stop();
      await network?.stop();
    },
  };
}
