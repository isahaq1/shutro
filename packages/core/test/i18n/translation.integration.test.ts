/**
 * Translatable fields on PostgreSQL (RFC 0011): JSONB storage, reads per language with fallback, string and map
 * writes, search and order in the environment language, shared cache across withLang environments.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, expectTypeOf, test } from 'vitest';
import {
  createShutro,
  createTableStatements,
  type Env,
  type Shutro,
  type TranslatedKeys,
  type Translations,
  toDecimal,
  ValidationError,
  type WriteValues,
} from '../../src/index.js';
import { registry, type S } from './fixtures.js';

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;

async function run<T>(lang: string, fn: (env: Env<S>) => Promise<T>): Promise<T> {
  return shutro.run({ user: 1, company: 1, lang }, fn);
}

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 5, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  shutro = createShutro({ driver, registry, sourceLang: 'en_US' });
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

describe('translatable fields', () => {
  test('types: string reads, string-or-map writes, translations() on translatable keys only', () => {
    expectTypeOf<TranslatedKeys<S, 'product.template'>>().toEqualTypeOf<'name' | 'description'>();
    expectTypeOf<WriteValues<S, 'product.template'>['name']>().toEqualTypeOf<
      string | Translations | undefined
    >();
    expectTypeOf<WriteValues<S, 'product.template'>['code']>().toEqualTypeOf<
      string | null | undefined
    >();
  });

  test('create in the source language, read in other languages with fallback, write per language', async () => {
    const id = await run('en_US', async (env) => {
      const laptop = (
        await env
          .model('product.template')
          .create([{ name: 'Laptop', description: 'Thin and light' }])
      ).first();
      expect(laptop.name).toBe('Laptop');
      expect(laptop.translations('name')).toEqual({ en_US: 'Laptop' });
      await env.flush();
      return laptop.id;
    });
    const [row] = await driver.query<{ name: Translations }>(
      compile(sql`SELECT name FROM product_template WHERE id = ${id}`),
    );
    expect(row?.name).toEqual({ en_US: 'Laptop' }); // JSONB

    await run('bn_BD', async (env) => {
      const laptop = (await env.model('product.template').browse([id]).load()).first();
      expect(laptop.name).toBe('Laptop'); // no bn_BD text: the source language
      await laptop.write({ name: 'ল্যাপটপ' });
      expect(laptop.name).toBe('ল্যাপটপ');
      expect(laptop.translations('name')).toEqual({ en_US: 'Laptop', bn_BD: 'ল্যাপটপ' });
      // Same transaction, same cache: the English environment sees the English text without a refetch.
      const en = env.withLang('en_US');
      const queries = env.stats().queries;
      expect((await en.model('product.template').browse([id]).load()).first().name).toBe('Laptop');
      expect(env.stats().queries).toBe(queries);
      expect(
        (await env.withLang('fr_FR').model('product.template').browse([id]).load()).first().name,
      ).toBe('Laptop');
      await env.flush();
    });
    const [after] = await driver.query<{ name: Translations }>(
      compile(sql`SELECT name FROM product_template WHERE id = ${id}`),
    );
    expect(after?.name).toEqual({ en_US: 'Laptop', bn_BD: 'ল্যাপটপ' });
  });

  test('a map sets several languages; a bad map is a validation error; a first write fills the source', async () => {
    await run('bn_BD', async (env) => {
      const mouse = (await env.model('product.template').create([{ name: 'মাউস' }])).first();
      expect(mouse.translations('name')).toEqual({ en_US: 'মাউস', bn_BD: 'মাউস' }); // the source gets the first text
      await mouse.write({ name: { en_US: 'Mouse', fr_FR: 'Souris' } });
      expect(mouse.translations('name')).toEqual({ en_US: 'Mouse', bn_BD: 'মাউস', fr_FR: 'Souris' });
      expect(mouse.name).toBe('মাউস');
      await expect(mouse.write({ name: { 'en-US': 'x' } as never })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(mouse.write({ name: { en_US: 1 } as never })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await env.flush();
    });
  });

  test('json fields round-trip as objects, not as JSON strings', async () => {
    const id = await run('en_US', async (env) => {
      const p = (
        await env.model('product.template').create([{ name: 'Cable', meta: { tags: ['usb'] } }])
      ).first();
      await env.flush();
      await p.write({ meta: { tags: ['usb', 'c'] } });
      await env.flush();
      return p.id;
    });
    const [row] = await driver.query<{ meta: unknown }>(
      compile(sql`SELECT meta FROM product_template WHERE id = ${id}`),
    );
    expect(row?.meta).toEqual({ tags: ['usb', 'c'] });
    await run('en_US', async (env) => {
      const p = (await env.model('product.template').browse([id]).load()).first();
      expect(p.meta).toEqual({ tags: ['usb', 'c'] });
      await p.unlink();
    });
  });

  test('search and order use the environment language with the source fallback', async () => {
    await run('bn_BD', async (env) => {
      await env.model('product.template').create([{ name: { en_US: 'Keyboard' } }]); // no bn text
      const products = env.model('product.template');
      expect(
        (await products.search({ where: { name: { ilike: 'ল্যাপ%' } } })).mapped('name'),
      ).toEqual(['ল্যাপটপ']);
      expect((await products.search({ where: { name: 'Keyboard' } })).mapped('name')).toEqual([
        'Keyboard',
      ]); // fallback in SQL
      // Order by the displayed name: Bengali names sort by Unicode, 'Keyboard' (fallback) sorts first.
      expect((await products.search({ order: ['name'] })).mapped('name')).toEqual([
        'Keyboard',
        'মাউস',
        'ল্যাপটপ',
      ]);
    });
    await run('en_US', async (env) => {
      const products = env.model('product.template');
      expect((await products.search({ where: { name: { ilike: 'ল্যাপ%' } } })).ids).toEqual([]);
      expect((await products.search({ order: ['name'] })).mapped('name')).toEqual([
        'Keyboard',
        'Laptop',
        'Mouse',
      ]);
    });
  });
});

test('the display name of a translated record name is the text in the environment language', async () => {
  const id = await run('en_US', async (env) => {
    const chair = (await env.model('product.template').create([{ name: 'Chair' }])).first();
    await chair.write({ name: { en_US: 'Chair', bn_BD: 'চেয়ার' } });
    expect((await chair.load(['displayName'])).first().displayName).toBe('Chair');
    await env.flush();
    return chair.id;
  });
  await run('bn_BD', async (env) => {
    const chair = (await env.model('product.template').browse([id]).load(['displayName'])).first();
    expect(chair.displayName).toBe('চেয়ার');
  });
  await run('fr_FR', async (env) => {
    const chair = (await env.model('product.template').browse([id]).load(['displayName'])).first();
    expect(chair.displayName).toBe('Chair'); // no French text: the source language, never "[object Object]"
  });
});
