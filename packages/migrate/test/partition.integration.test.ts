/**
 * The migrator and partitioned models (RFC 0015 §7.2): PARTITION BY in the plan, a composite primary key, and
 * partitions that are not reported as unknown tables.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRegistry,
  defineModel,
  defineModule,
  f,
  partitionStatements,
  type Registry,
  rangePartitions,
} from '@shutro/core';
import { createDriver, type Driver } from '@shutro/driver-pg';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  applyMigrations,
  planMigration,
  readLiveSchema,
  writeMigrationFile,
} from '../src/index.js';

const Users = defineModel('res.users', { fields: { login: f.char({ required: true }) } });
const Currency = defineModel('res.currency', { fields: { name: f.char({ required: true }) } });
const Company = defineModel('res.company', {
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});
const Move = defineModel('account.move.line', {
  partition: { by: 'range', key: 'date' },
  fields: { date: f.date({ required: true }), name: f.char({ required: true }) },
});
const registry = buildRegistry({
  modules: [defineModule({ name: 'base', models: [Users, Currency, Company, Move] })],
}) as Registry;

let pg: StartedPostgres;
let driver: Driver;
let dir: string;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3 });
  dir = mkdtempSync(join(tmpdir(), 'shutro-partition-'));
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('plan, apply, partitions, and an empty second plan', async () => {
  const plan = await planMigration({ driver, registry });
  const create = plan.statements.find((s) => s.sql.startsWith('CREATE TABLE "account_move_line"'));
  expect(create?.sql).toContain('PRIMARY KEY ("id", "date")');
  expect(create?.sql).toMatch(/\) PARTITION BY RANGE \("date"\)$/);
  await writeMigrationFile({ dir, name: 'init', plan });
  await applyMigrations({ driver, dir, registry });
  for (const statement of partitionStatements(
    Move,
    rangePartitions(Move, { from: '2026-01', to: '2026-03' }),
  ))
    await driver.query({ text: statement, params: [] });

  const live = await readLiveSchema(driver);
  expect(Object.keys(live.tables)).not.toContain('account_move_line_2026_01');
  expect(live.tables['account_move_line']?.primaryKey).toEqual(['id', 'date']);
  expect((await planMigration({ driver, registry })).operations).toEqual([]);
});
