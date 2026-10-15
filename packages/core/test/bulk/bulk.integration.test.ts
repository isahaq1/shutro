/**
 * Bulk operations and partitioning on PostgreSQL (RFC 0015): COPY keeps create() semantics and escapes every value;
 * partitioned models route rows to partitions, refuse many2one references, and work through the ORM.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  AccessError,
  buildRegistry,
  type ComputeSet,
  copyField,
  createShutro,
  createTableStatements,
  type DefaultLoaded,
  defineGroup,
  defineModel,
  defineModule,
  defineSequence,
  type Env,
  f,
  type Id,
  InvalidModelError,
  InvalidRelationError,
  partitionStatements,
  rangePartitions,
  toDecimal,
} from '../../src/index.js';

type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
type Lines = ComputeSet<S, 'stock.move', DefaultLoaded<S, 'stock.move'>>;

const Users = defineModel('res.users', {
  access: { 'base.user': ['read'] },
  fields: { login: f.char({ required: true }) },
});
const Currency = defineModel('res.currency', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
});
const Company = defineModel('res.company', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});
const Product = defineModel('product.product', {
  access: {
    'base.user': ['read', 'create', 'write'],
    'base.importer': ['read', 'create', 'import'],
  },
  fields: {
    name: f.char({ required: true }),
    code: f.char({ required: true, readonly: true, sequence: 'product' }),
    note: f.text(),
    active: f.boolean({ default: true }),
    price: f.decimal({ scale: 2, required: true, default: '0' }),
    data: f.binary(),
  },
});
const StockMove = defineModel('stock.move', {
  access: { 'base.user': ['read', 'create', 'write', 'import'] },
  partition: { by: 'range', key: 'date' },
  fields: {
    date: f.date({ required: true }),
    product: f.many2one('product.product', { required: true }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    doubled: f.decimal({
      scale: 3,
      store: true,
      depends: ['quantity'],
      compute(records: unknown): void {
        for (const m of records as Lines) m.doubled = m.quantity.times(2);
      },
    }),
  },
});
const registry = buildRegistry({
  modules: [
    defineModule({
      name: 'base',
      groups: [
        defineGroup({ code: 'base.user' }),
        defineGroup({ code: 'base.importer', implies: ['base.user'] }),
      ],
      sequences: [defineSequence({ code: 'product', prefix: 'P', padding: 4 })],
      models: [Users, Currency, Company, Product, StockMove],
    }),
  ],
});

let pg: StartedPostgres;
let driver: Driver;

async function as<T>(groups: readonly string[], fn: (env: Env<S>) => Promise<T>): Promise<T> {
  return createShutro({ driver, registry }).run({ user: 1, company: 1, groups }, fn);
}

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 4, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  for (const statement of partitionStatements(
    StockMove,
    rangePartitions(StockMove, { from: '2026-01', to: '2026-04' }),
  ))
    await driver.query({ text: statement, params: [] });
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  const [bdt] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_currency (name, rounding) VALUES (${'BDT'}, ${'0.01'}) RETURNING id`,
    ),
  );
  await driver.query(
    compile(sql`INSERT INTO res_company (name, currency_id) VALUES (${'Co'}, ${bdt?.id ?? 0})`),
  );
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

describe('COPY', () => {
  test('field escaping', () => {
    expect(copyField(null)).toBe('\\N');
    expect(copyField(true)).toBe('t');
    expect(copyField('a\tb\nc\\d\re')).toBe('a\\tb\\nc\\\\d\\re');
    expect(copyField(new Uint8Array([1, 255]))).toBe('\\\\x01ff');
    expect(copyField('\\N')).toBe('\\\\N'); // the literal text, not a null
  });

  test('a bulk copy keeps create() semantics: defaults, sequences, hostile text, bytes, ids in order', async () => {
    const rows = Array.from({ length: 2_500 }, (_, i) => ({
      name: i === 0 ? "tab\there, newline\nthere, back\\slash, quote ' and \\N" : `Product ${i}`,
      ...(i % 2 === 0 ? { note: null } : { note: `note ${i}` }),
      ...(i === 1 ? { data: new Uint8Array([0, 10, 92, 255]) } : {}),
    }));
    const products = await as(['base.importer'], async (env) => {
      const before = env.stats().queries;
      const created = await env.model('product.product').copy(rows);
      expect(env.stats().queries - before).toBeLessThanOrEqual(4); // ids, COPY, sequence numbers (autonomous), ...
      return created.read(['name', 'code', 'active', 'price']);
    });
    expect(products).toHaveLength(2_500);
    expect(products[0]).toMatchObject({
      name: rows[0]?.name,
      code: 'P0001',
      active: true,
      price: '0',
    });
    expect(products[2_499]?.code).toBe('P2500');
    const ids = products.map((p) => p['id'] as number);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    const [first] = await driver.query<{ name: string; note: string | null }>(
      compile(sql`SELECT name, note FROM product_product WHERE id = ${ids[0]}`),
    );
    expect(first).toEqual({ name: rows[0]?.name, note: null });
    const [bytes] = await driver.query<{ data: Uint8Array }>(
      compile(sql`SELECT data FROM product_product WHERE id = ${ids[1]}`),
    );
    expect([...(bytes?.data ?? [])]).toEqual([0, 10, 92, 255]);
  });

  test('copy needs the import permission', async () => {
    await expect(
      as(['base.user'], (env) => env.model('product.product').copy([{ name: 'x' }])),
    ).rejects.toBeInstanceOf(AccessError);
  });
});

describe('partitioning', () => {
  test('declaration rules', () => {
    expect(() =>
      defineModel('x.p', { partition: { by: 'range', key: 'date' }, fields: { date: f.date() } }),
    ).toThrow(InvalidModelError);
    expect(() =>
      defineModel('x.q', {
        partition: { by: 'range', key: 'date' },
        fields: { date: f.date({ required: true }), ref: f.char({ required: true }) },
        sqlConstraints: { refUnique: { unique: ['ref'], message: 'x' } },
      }),
    ).toThrow(/partition key/);
    const Ref = defineModel('x.ref', { fields: { move: f.many2one('stock.move') } });
    expect(() =>
      buildRegistry({
        modules: [defineModule({ name: 'x', depends: registry.modules as never, models: [Ref] })],
      }),
    ).toThrow(InvalidRelationError);
    expect(
      rangePartitions(StockMove, { from: '2026-11', to: '2027-02' }).map((p) => p.name),
    ).toEqual(['stock_move_2026_11', 'stock_move_2026_12', 'stock_move_2027_01']);
    expect(partitionStatements(StockMove, [{ name: 'stock_move_old', default: true }])).toEqual([
      'CREATE TABLE IF NOT EXISTS "stock_move_old" PARTITION OF "stock_move" DEFAULT',
    ]);
  });

  test('rows route to partitions; create, copy, compute, search and write work through the ORM', async () => {
    const product = (
      await driver.query<{ id: number }>(
        compile(sql`SELECT id FROM product_product ORDER BY id LIMIT 1`),
      )
    )[0]?.id as Id<'product.product'>;
    await as(['base.user'], async (env) => {
      await env.model('stock.move').create([
        { date: '2026-01-15', product, quantity: '2' },
        { date: '2026-02-03', product, quantity: '3' },
      ]);
      await env.model('stock.move').copy([{ date: '2026-03-31', product, quantity: '5' }]);
      await env.flush();
      const feb = await env
        .model('stock.move')
        .search({ where: { date: { gte: '2026-02-01', lt: '2026-03-01' } } });
      expect(feb.mapped('doubled').map(String)).toEqual(['6']);
      await feb.write({ quantity: '4' });
      await env.flush();
      expect(String(feb.first().doubled)).toBe('8');
    });
    const placement = await driver.query<{ part: string; n: number }>(
      compile(
        sql`SELECT tableoid::regclass::text AS part, count(*)::int AS n FROM stock_move GROUP BY 1 ORDER BY 1`,
      ),
    );
    expect(placement).toEqual([
      { part: 'stock_move_2026_01', n: 1 },
      { part: 'stock_move_2026_02', n: 1 },
      { part: 'stock_move_2026_03', n: 1 },
    ]);
    await expect(
      as(['base.user'], (env) => env.model('stock.move').create([{ date: '2027-01-01', product }])),
    ).rejects.toThrow(/No partition accepts the row/);
  });
});
