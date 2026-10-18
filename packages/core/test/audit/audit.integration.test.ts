/**
 * The audit trail on PostgreSQL (RFC 0013): rows for creates, tracked writes (with exact old values), transitions,
 * recomputed stored values, deletes and superuser scopes; coalescing per transaction; savepoint rollback; the
 * tracking flag; the append-only trigger; records.trail().
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  type AuditEntry,
  coalesceAudit,
  createShutro,
  createTableStatements,
  type Env,
  type Id,
  isTracked,
  readTrail,
  type Shutro,
  toDecimal,
} from '../../src/index.js';
import { registry, type S, SaleOrder } from './fixtures.js';

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
let ids: { bdt: Id<'res.currency'>; acme: Id<'res.partner'>; globex: Id<'res.partner'> };

async function run<T>(fn: (env: Env<S>) => Promise<T>, reason?: string): Promise<T> {
  return shutro.run({ user: 1, company: 1, ...(reason === undefined ? {} : { reason }) }, fn);
}

const brief = (rows: readonly AuditEntry[]): string[] =>
  rows.map(
    (r) =>
      `${r.action}${r.field === null ? '' : `:${r.field}`}=${JSON.stringify(r.old)}>${JSON.stringify(r.new)}`,
  );

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 5, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  shutro = createShutro({ driver, registry });
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  const [bdt] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_currency (name, rounding, decimal_places) VALUES (${'BDT'}, ${'0.01'}, ${2}) RETURNING id`,
    ),
  );
  await driver.query(
    compile(sql`INSERT INTO res_company (name, currency_id) VALUES (${'Co'}, ${bdt?.id ?? 0})`),
  );
  const [acme, globex] = await driver.query<{ id: number }>(
    compile(sql`INSERT INTO res_partner (name) VALUES (${'Acme'}), (${'Globex'}) RETURNING id`),
  );
  ids = {
    bdt: (bdt?.id ?? 0) as Id<'res.currency'>,
    acme: (acme?.id ?? 0) as Id<'res.partner'>,
    globex: (globex?.id ?? 0) as Id<'res.partner'>,
  };
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

describe('audit trail', () => {
  test('which fields are tracked', () => {
    expect(['partner', 'note', 'amountTotal', 'state'].every((k) => isTracked(SaleOrder, k))).toBe(
      true,
    );
    expect(isTracked(SaleOrder, 'untracked')).toBe(false);
    expect(isTracked(SaleOrder, 'lines')).toBe(false);
  });

  test('create, tracked writes with exact old values, transitions, recomputes, coalescing, unlink', async () => {
    const id = await run(async (env) => {
      const so = (
        await env.model('sale.order').create([
          {
            name: 'A1',
            partner: ids.acme,
            currency: ids.bdt,
            note: 'first',
            lines: { create: [{ name: 'l', currency: ids.bdt, priceUnit: '10' }] },
          },
        ])
      ).first();
      await env.flush(); // the compute runs: amountTotal null → 10.00
      await so.write({ note: 'second', untracked: 'ignored' });
      await so.write({ note: 'third' }); // coalesced with the previous write: first → third
      await so.write({ partner: ids.globex });
      await so.confirm();
      await (await so.lines.load()).first().write({ priceUnit: '25' }); // recompute: 10.00 → 25.00
      await env.flush();
      return so.id;
    }, 'test:audit');

    const rows = await readTrail(driver, { model: 'sale.order', recordIds: [id] });
    expect(brief(rows.slice(0, 4))).toEqual([
      'write:amountTotal={"amount":"10.00","currency":"BDT"}>{"amount":"25.00","currency":"BDT"}',
      'write:state="draft">"sale"',
      `write:partner=${ids.acme}>${ids.globex}`,
      'write:note="first">"third"',
    ]);
    // The first computed value belongs to the creation row (RFC 0013 §7.2).
    expect(rows).toHaveLength(5);
    expect(rows[4]).toMatchObject({
      action: 'create',
      old: null,
      new: {
        partner: ids.acme,
        note: 'first',
        amountTotal: { amount: '10.00', currency: 'BDT' },
        state: 'draft',
      },
    });
    expect(new Set(rows.map((r) => r.tx)).size).toBe(1);
    expect(
      rows.every(
        (r) => r.uid === 1 && r.companyId === 1 && r.su === false && r.reason === 'test:audit',
      ),
    ).toBe(true);
    expect(rows.every((r) => r.at.getTime() === rows[0]?.at.getTime())).toBe(true);

    await run(async (env) => {
      const so = (await env.model('sale.order').browse([id]).load()).first();
      await so.unlink();
      await env.flush();
    });
    const [unlink] = await readTrail(driver, {
      model: 'sale.order',
      recordIds: [id],
      action: 'unlink',
    });
    expect(unlink?.old).toEqual({
      partner: ids.globex,
      note: 'third',
      amountTotal: { amount: '25.00', currency: 'BDT' },
      state: 'sale',
    });
  });

  test('a rolled-back savepoint leaves no rows; tracking off collects nothing; su scopes are recorded', async () => {
    const id = await run(async (env) => {
      const so = (
        await env.model('sale.order').create([{ name: 'B1', partner: ids.acme, currency: ids.bdt }])
      ).first();
      await env.flush();
      await env
        .transaction(async (tx) => {
          const inner = (await tx.model('sale.order').browse([so.id]).load()).first();
          await inner.write({ note: 'never' });
          throw new Error('abort savepoint');
        })
        .catch(() => undefined);
      const quiet = env.withFlags({ tracking: false });
      await (await quiet.model('sale.order').browse([so.id]).load())
        .first()
        .write({ note: 'silent' });
      await env.asSuperuser({ reason: 'maintenance' }, async () => undefined);
      await env.flush();
      return so.id;
    });
    const rows = await readTrail(driver, { model: 'sale.order', recordIds: [id] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'create',
      new: {
        partner: ids.acme,
        note: null,
        amountTotal: { amount: '0.00', currency: 'BDT' },
        state: 'draft',
      },
    });
    const [su] = await readTrail(driver, { action: 'su', limit: 1 });
    expect(su).toMatchObject({ action: 'su', su: true, reason: 'maintenance', model: null });
  });

  test('records.trail() reads newest first; the table refuses updates and deletes', async () => {
    const id = await run(async (env) => {
      const so = (
        await env.model('sale.order').create([{ name: 'C1', partner: ids.acme, currency: ids.bdt }])
      ).first();
      await so.write({ note: 'x' }); // same transaction as the creation: folded into the create row
      const trail = await so.trail();
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({ action: 'create', new: { note: 'x' } });
      return so.id;
    });
    await run(async (env) => {
      const so = (await env.model('sale.order').browse([id]).load()).first();
      await so.write({ note: 'y' });
      expect(brief(await so.trail({ field: 'note' }))).toEqual(['write:note="x">"y"']);
      expect((await so.trail()).length).toBe(2);
      // Pages: newest first, then older than the last row seen.
      const [newest] = await so.trail({ limit: 1 });
      const older = await so.trail({ before: newest?.id as number });
      expect(older.map((e) => e.action)).toEqual(['create']);
    });
    await expect(
      driver.query(compile(sql`UPDATE shutro_audit SET reason = ${'tampered'}`)),
    ).rejects.toThrow(/append-only/);
    await expect(driver.query(compile(sql`DELETE FROM shutro_audit`))).rejects.toThrow(
      /append-only/,
    );
  });

  test('coalescing keeps the first old and the last new, and drops round trips', () => {
    const row = (
      field: string,
      old: unknown,
      next: unknown,
    ): Parameters<typeof coalesceAudit>[0][number] => ({
      at: new Date(0),
      tx: 't',
      uid: 1,
      companyId: 1,
      su: false,
      reason: null,
      action: 'write',
      model: 'm',
      recordId: 1,
      field,
      old,
      new: next,
    });
    const out = coalesceAudit([
      row('a', 1, 2),
      row('b', 'x', 'y'),
      row('a', 2, 3),
      row('b', 'y', 'x'),
    ]);
    expect(out.map((r) => [r.field, r.old, r.new])).toEqual([['a', 1, 3]]);
  });
});
