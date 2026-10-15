/**
 * An extended model works end to end: tables include extension columns, the ORM reads and writes them.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  asId,
  buildRegistry,
  createShutro,
  createTableStatements,
  defineModel,
  defineModule,
  extendModel,
  f,
  toDecimal,
} from '../../src/index.js';
import { base } from './fixtures.js';

const sale = defineModule({
  name: 'sale',
  depends: [base()],
  models: [
    defineModel('sale.order', {
      fields: {
        name: f.char({ required: true }),
        partner: f.many2one('res.partner', { required: true }),
      },
    }),
  ],
});
const saleMargin = defineModule({
  name: 'sale_margin',
  depends: [sale],
  models: [],
  extensions: [
    extendModel('sale.order', {
      fields: { margin: f.decimal({ scale: 2, required: true, default: '0' }), rush: f.boolean() },
    }),
  ],
});
const registry = buildRegistry({ modules: [saleMargin] });

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  await driver.query(compile(sql`INSERT INTO res_currency (name) VALUES (${'BDT'})`));
  await driver.query(
    compile(sql`INSERT INTO res_company (name, currency_id) VALUES (${'Co'}, ${1})`),
  );
  await driver.query(
    compile(sql`INSERT INTO res_partner (name, active) VALUES (${'Acme'}, ${true})`),
  );
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

test('extension columns exist and round-trip through create / search / write', async () => {
  const shutro = createShutro({ driver, registry });
  const result = await shutro.run({ user: 1, company: 1 }, async (env) => {
    const orders = await env
      .model('sale.order')
      .create([{ name: 'SO1', partner: asId(1, 'res.partner'), margin: '12.5', rush: true }]);
    await orders.write({ margin: '13' });
    const found = (await env.model('sale.order').search({ where: { rush: true } })).ensureOne();
    return {
      margin: found.margin.toFixed(),
      rush: found.rush,
      origin: registry.describe('sale.order').fields['margin']?.origin,
    };
  });
  expect(result).toEqual({ margin: '13', rush: true, origin: { module: 'sale_margin' } });
  const [row] = await driver.query<{ margin: unknown }>(
    compile(sql`SELECT margin FROM sale_order WHERE name = ${'SO1'}`),
  );
  expect(String(row?.margin)).toBe('13');
});
