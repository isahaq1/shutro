import { PostgreSqlContainer } from '@testcontainers/postgresql';

/** PostgreSQL image used by every Shutro integration test. Latest stable major (`CLAUDE.md`). */
export const POSTGRES_IMAGE = 'postgres:18';

/** Options for {@link startPostgres}. */
export interface StartPostgresOptions {
  /** Docker image. Defaults to {@link POSTGRES_IMAGE}. */
  readonly image?: string;
  /**
   * Trade durability for speed (`fsync=off`, `synchronous_commit=off`, `full_page_writes=off`).
   * Safe for throwaway test databases. Defaults to `true`.
   */
  readonly fast?: boolean;
}

/** A running PostgreSQL container. */
export interface StartedPostgres {
  /** Connection URL (`postgres://user:password@host:port/database`). */
  readonly url: string;
  /** Stops and removes the container. */
  stop(): Promise<void>;
}

/**
 * Starts a disposable PostgreSQL server in Docker.
 *
 * @example
 * ```ts
 * let pg: StartedPostgres;
 * beforeAll(async () => { pg = await startPostgres(); }, 120_000);
 * afterAll(() => pg.stop());
 * ```
 *
 * @throws When Docker is not available. The error comes from Testcontainers: start Docker Desktop (or a Docker
 * daemon) and retry.
 */
export async function startPostgres(options: StartPostgresOptions = {}): Promise<StartedPostgres> {
  const fast = options.fast ?? true;
  const container = await new PostgreSqlContainer(options.image ?? POSTGRES_IMAGE)
    .withDatabase('shutro')
    .withUsername('shutro')
    .withPassword('shutro')
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
    )
    .start();
  return {
    url: container.getConnectionUri(),
    async stop() {
      await container.stop();
    },
  };
}
