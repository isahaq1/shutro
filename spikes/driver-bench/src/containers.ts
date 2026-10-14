/**
 * Starts PostgreSQL 18 and a PgBouncer (transaction pooling, protocol-level prepared statements) in front of it.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

export const PG_IMAGE = 'postgres:18';
export const PGBOUNCER_IMAGE = 'edoburu/pgbouncer:latest';

export interface Targets {
  /** Direct connection to PostgreSQL. */
  readonly direct: string;
  /** Through PgBouncer in transaction mode. */
  readonly bouncer: string;
  stop(): Promise<void>;
}

export async function startTargets(): Promise<Targets> {
  const network: StartedNetwork = await new Network().start();
  const pg: StartedPostgreSqlContainer = await new PostgreSqlContainer(PG_IMAGE)
    .withNetwork(network)
    .withNetworkAliases('pg')
    .withDatabase('shutro')
    .withUsername('shutro')
    .withPassword('shutro')
    .withCommand([
      'postgres',
      '-c',
      'max_connections=300',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
    ])
    .start();
  const bouncer: StartedTestContainer = await new GenericContainer(PGBOUNCER_IMAGE)
    .withNetwork(network)
    .withEnvironment({
      DATABASE_URL: 'postgres://shutro:shutro@pg:5432/shutro',
      AUTH_TYPE: 'scram-sha-256',
      POOL_MODE: 'transaction',
      MAX_PREPARED_STATEMENTS: '200',
      DEFAULT_POOL_SIZE: '20',
      MAX_CLIENT_CONN: '500',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  return {
    direct: pg.getConnectionUri(),
    bouncer: `postgres://shutro:shutro@${bouncer.getHost()}:${bouncer.getMappedPort(5432)}/shutro`,
    async stop() {
      await bouncer.stop();
      await pg.stop();
      await network.stop();
    },
  };
}
