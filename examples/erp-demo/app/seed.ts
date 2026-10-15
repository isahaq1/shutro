/**
 * Demo data. The first user is inserted with SQL: every ORM create records `created_by`, which references
 * res.users, so the ORM cannot create the very first user (docs/feedback.md #5).
 */
import type { Shutro } from '@shutro/core';
import type { Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import type { S } from './types.ts';

/** Ids the scenario refers to. */
export interface Seeded {
  readonly users: {
    readonly admin: number;
    readonly alice: number;
    readonly bob: number;
    readonly mona: number;
    readonly carol: number;
  };
  readonly company: number;
  readonly currencies: { readonly bdt: number; readonly usd: number };
  readonly partners: { readonly rahim: number; readonly acme: number };
  readonly products: { readonly laptop: number; readonly mouse: number; readonly support: number };
  readonly vat: number;
}

/** Users' groups, as the application would load them from its own user model. */
export const GROUPS: Readonly<Record<keyof Seeded['users'], readonly string[]>> = {
  admin: ['base.admin', 'sale.manager', 'account.manager'],
  alice: ['sale.user'],
  bob: ['sale.user'],
  mona: ['sale.manager'],
  carol: ['account.user'],
};

export async function seed(driver: Driver, shutro: Shutro<S>): Promise<Seeded> {
  const [admin] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_users (login, name) VALUES (${'admin'}, ${'Administrator'}) RETURNING id`,
    ),
  );
  const adminId = Number(admin?.id);
  // The company does not exist yet: the identity is not checked against the database (docs/feedback.md #6).
  return shutro.run({ user: adminId, company: 1, groups: GROUPS.admin, reason: 'seed' }, (env) =>
    env.asSuperuser({ reason: 'seed demo data' }, async (su) => {
      const [bdt, usd] = (await su.model('res.currency').create([{ name: 'BDT' }, { name: 'USD' }]))
        .ids;
      const company = (
        await su.model('res.company').create([{ name: 'Paragon BD', currency: bdt as never }])
      ).first();
      await su.model('res.currency.rate').create([
        { currency: usd as never, date: '2026-01-01', rate: '0.0083333333' },
        { currency: usd as never, date: '2026-10-01', rate: '0.0082' },
      ]);
      const users = (
        await su.model('res.users').create([
          { login: 'alice', name: 'Alice (sales)' },
          { login: 'bob', name: 'Bob (sales)' },
          { login: 'mona', name: 'Mona (sales manager)' },
          { login: 'carol', name: 'Carol (accounting)' },
        ])
      ).ids;
      const units = (
        await su
          .model('uom.uom')
          .create([{ name: { en_US: 'Units', bn_BD: 'একক' }, category: 'Unit' }])
      ).first();
      const vat = (
        await su
          .model('account.tax')
          .create([{ name: { en_US: 'VAT 15%', bn_BD: 'ভ্যাট ১৫%' }, rate: '0.15' }])
      ).first();
      const [rahim, acme] = (
        await su.model('res.partner').create([
          { name: 'Rahim Traders', email: 'orders@rahim.example', isCompany: true },
          {
            name: 'Acme Corp',
            email: 'buyer@acme.example',
            isCompany: true,
            currency: usd as never,
          },
        ])
      ).ids;
      const [laptop, mouse, support] = (
        await su.model('product.product').create([
          {
            name: { en_US: 'Laptop', bn_BD: 'ল্যাপটপ' },
            listPrice: '85000',
            uom: units.id,
            tax: vat.id,
          },
          { name: { en_US: 'Mouse', bn_BD: 'মাউস' }, listPrice: '1200', uom: units.id, tax: vat.id },
          { name: 'Support (hour)', kind: 'service', listPrice: '5000', uom: units.id },
        ])
      ).ids;
      // A catalog import: one COPY statement.
      await su.model('product.product').copy(
        Array.from({ length: 500 }, (_, i) => ({
          name: `Accessory ${i + 1}`,
          listPrice: String(100 + i),
          uom: units.id,
        })),
      );
      return {
        users: {
          admin: adminId,
          alice: users[0] as number,
          bob: users[1] as number,
          mona: users[2] as number,
          carol: users[3] as number,
        },
        company: company.id,
        currencies: { bdt: bdt as number, usd: usd as number },
        partners: { rahim: rahim as number, acme: acme as number },
        products: { laptop: laptop as number, mouse: mouse as number, support: support as number },
        vat: vat.id,
      };
    }),
  );
}
