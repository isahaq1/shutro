import { sql } from '@shutro/sql';
import { describe, expect, test } from 'vitest';
import { defineModel, f, InvalidModelError, isModel, ShutroError } from '../../src/index.js';

function invalid(fn: () => unknown): InvalidModelError {
  try {
    fn();
  } catch (e) {
    if (e instanceof InvalidModelError) {
      expect(e).toBeInstanceOf(ShutroError);
      expect(e.code).toBe('INVALID_MODEL');
      expect(e.message).toContain(e.hint);
      return e;
    }
    throw e;
  }
  throw new Error('expected InvalidModelError');
}

const saleOrder = () =>
  defineModel('sale.order', {
    label: 'Sales Order',
    order: ['dateOrder desc', 'id desc'],
    companyScoped: { required: true },
    tracking: ['state', 'partner', 'amountTotal'],
    fields: {
      name: f.char({ required: true, readonly: true, sequence: 'sale.order' }),
      partner: f.many2one('res.partner', { required: true, index: true }),
      dateOrder: f.datetime({ required: true }),
      currency: f.many2one('res.currency', { required: true }),
      lines: f.one2many('sale.order.line', 'order'),
      amountTotal: f.monetary({
        currency: 'currency',
        store: true,
        depends: ['lines.subtotal'],
        compute: 'computeAmounts',
      }),
      weight: f.quantity({ uom: 'weightUom' }),
      weightUom: f.many2one('uom.uom'),
      state: f.state({
        states: { draft: 'Quotation', sale: 'Sales Order', cancel: 'Cancelled' },
        initial: 'draft',
        transitions: {
          confirm: { from: ['draft'], to: 'sale' },
          cancel: { from: ['draft', 'sale'], to: 'cancel' },
        },
      }),
    },
    methods: {
      computeAmounts(): void {},
    },
    sqlConstraints: {
      nameUniquePerCompany: {
        unique: ['company', 'name'],
        message: 'Order reference must be unique per company.',
      },
      positiveTotal: { check: sql`amount_total >= 0`, message: 'The total cannot be negative.' },
    },
    indexes: [
      { fields: ['partner', 'dateOrder'] },
      { fields: ['name'], where: sql`state = 'draft'` },
    ],
    constraints: {
      validityAfterOrderDate: {
        depends: ['dateOrder'],
        check: () => [],
        message: 'Expiration date is before the order date.',
      },
    },
  });

describe('defineModel', () => {
  test('returns a frozen model with naming derived from the model name', () => {
    const model = saleOrder();
    expect(isModel(model)).toBe(true);
    expect(Object.isFrozen(model)).toBe(true);
    expect(model.name).toBe('sale.order');
    expect(model.table).toBe('sale_order');
    expect(model.label).toBe('Sales Order');
    expect(defineModel('res.partner', { fields: {} }).label).toBe('Res Partner');
    expect(defineModel('res.partner', { table: 'partners', fields: {} }).table).toBe('partners');
  });

  test('implicit fields, archivable and companyScoped opt-ins', () => {
    const model = saleOrder();
    expect(Object.keys(model.fields)).toEqual([
      'id',
      'createdAt',
      'updatedAt',
      'createdBy',
      'updatedBy',
      'displayName',
      'company',
      'name',
      'partner',
      'dateOrder',
      'currency',
      'lines',
      'amountTotal',
      'weight',
      'weightUom',
      'state',
    ]);
    expect(model.fields.id).toMatchObject({
      kind: 'bigint',
      required: true,
      readonly: true,
      identity: true,
    });
    expect(model.fields.company).toMatchObject({
      kind: 'many2one',
      target: 'res.company',
      required: true,
    });
    expect(model.fields.createdBy).toMatchObject({
      kind: 'many2one',
      target: 'res.users',
      readonly: true,
      required: false,
    });
    expect(model.fields.displayName).toMatchObject({
      kind: 'char',
      computed: true,
      store: false,
      readonly: true,
    });
    expect(model.archivable).toBe(false);
    expect('active' in model.fields).toBe(false);

    const partner = defineModel('res.partner', {
      archivable: true,
      companyScoped: { required: false },
      fields: {},
    });
    expect(partner.fields.active).toMatchObject({ kind: 'boolean', default: true });
    expect(partner.fields.company).toMatchObject({ required: false });
    expect(partner.archivable).toBe(true);
  });

  test('column names: snake_case, many2one gets _id, x2many and non-stored computes have none', () => {
    const model = saleOrder();
    expect(model.columns).toMatchObject({
      id: 'id',
      createdAt: 'created_at',
      createdBy: 'created_by_id',
      company: 'company_id',
      dateOrder: 'date_order',
      partner: 'partner_id',
      amountTotal: 'amount_total',
      weightUom: 'weight_uom_id',
    });
    expect(model.columns.lines).toBeUndefined();
    expect(model.columns.displayName).toBeUndefined();
    const custom = defineModel('x.y', { fields: { legacy: f.char({ column: 'legacy_name' }) } });
    expect(custom.columns.legacy).toBe('legacy_name');
  });

  test('labels default to humanized keys; explicit labels win', () => {
    const model = saleOrder();
    expect(model.fields.amountTotal.label).toBe('Amount Total');
    expect(model.fields.createdAt.label).toBe('Created At');
    expect(
      defineModel('x.y', { fields: { vat: f.char({ label: 'Tax ID' }) } }).fields.vat.label,
    ).toBe('Tax ID');
  });

  test('order, recName, tracking', () => {
    const model = saleOrder();
    expect(model.order).toEqual([
      { field: 'dateOrder', direction: 'desc' },
      { field: 'id', direction: 'desc' },
    ]);
    expect(defineModel('x.y', { fields: {} }).order).toEqual([{ field: 'id', direction: 'asc' }]);
    expect(model.recName).toBe('name'); // a `name` field is the default recName
    expect(defineModel('x.y', { fields: {} }).recName).toBe('id');
    expect(defineModel('x.y', { recName: 'code', fields: { code: f.char() } }).recName).toBe(
      'code',
    );
    expect(model.tracking).toEqual(['state', 'partner', 'amountTotal']);
  });

  test('SQL constraints and indexes get deterministic names', () => {
    const model = saleOrder();
    expect(model.sqlConstraints).toEqual([
      {
        key: 'nameUniquePerCompany',
        name: 'sale_order_name_unique_per_company',
        kind: 'unique',
        fields: ['company', 'name'],
        columns: ['company_id', 'name'],
        where: undefined,
        message: 'Order reference must be unique per company.',
      },
      {
        key: 'positiveTotal',
        name: 'sale_order_positive_total',
        kind: 'check',
        fields: [],
        columns: [],
        check: expect.anything(),
        message: 'The total cannot be negative.',
      },
    ]);
    expect(model.indexes.map((i) => i.name)).toEqual([
      'sale_order_partner_id_date_order_idx',
      'sale_order_name_idx',
    ]);
    expect(model.indexes[1]?.where).toBeDefined();
  });

  test('describe() is plain, JSON-serializable metadata (RFC 0001 §9)', () => {
    const d = saleOrder().describe();
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(d).toMatchObject({
      name: 'sale.order',
      label: 'Sales Order',
      table: 'sale_order',
      recName: 'name',
    });
    expect(d.fields['amountTotal']).toEqual({
      kind: 'monetary',
      label: 'Amount Total',
      help: null,
      column: 'amount_total',
      pgType: 'numeric',
      required: false,
      readonly: true,
      store: true,
      computed: true,
      compute: 'computeAmounts',
      depends: ['lines.subtotal'],
      hasDefault: false,
      index: null,
      copy: true,
      tracking: true,
      translate: false,
      sequence: null,
      deprecated: null,
      groups: [],
      currencyField: 'currency',
    });
    expect(d.fields['state']).toMatchObject({
      kind: 'state',
      selection: [
        ['draft', 'Quotation'],
        ['sale', 'Sales Order'],
        ['cancel', 'Cancelled'],
      ],
      initial: 'draft',
      transitions: {
        confirm: { from: ['draft'], to: 'sale' },
        cancel: { from: ['draft', 'sale'], to: 'cancel' },
      },
    });
    expect(d.fields['lines']).toMatchObject({
      kind: 'one2many',
      target: 'sale.order.line',
      inverseField: 'order',
      column: null,
    });
    expect(d.fields['displayName']?.compute).toBe('inline');
    expect(d.methods).toEqual(['computeAmounts']);
    expect(d.sqlConstraints.map((c) => c.name)).toEqual([
      'sale_order_name_unique_per_company',
      'sale_order_positive_total',
    ]);
    expect(d.constraints).toEqual([
      {
        key: 'validityAfterOrderDate',
        depends: ['dateOrder'],
        message: 'Expiration date is before the order date.',
      },
    ]);
  });
});

describe('validation', () => {
  test('model names', () => {
    invalid(() => defineModel('SaleOrder', { fields: {} }));
    invalid(() => defineModel('', { fields: {} }));
  });

  test('field keys: camelCase, not reserved, real descriptors', () => {
    invalid(() => defineModel('x.y', { fields: { snake_case: f.char() } }));
    invalid(() => defineModel('x.y', { fields: { id: f.char() } as never }));
    invalid(() => defineModel('x.y', { fields: { env: f.char() } as never }));
    invalid(() => defineModel('x.y', { fields: { ensureOne: f.char() } as never }));
    invalid(() => defineModel('x.y', { fields: { fake: { kind: 'char' } } as never }));
  });

  test('displayName may be redefined, the other implicit fields may not', () => {
    const m = defineModel('x.y', {
      fields: {
        displayName: f.char({ store: true, depends: ['code'], compute: () => undefined }),
        code: f.char(),
      },
    });
    expect(m.fields.displayName.store).toBe(true);
    invalid(() => defineModel('x.y', { fields: { createdAt: f.datetime() } as never }));
  });

  test('column collisions', () => {
    invalid(() =>
      defineModel('x.y', {
        fields: { partnerId: f.integer(), partner: f.many2one('res.partner') },
      }),
    );
    invalid(() => defineModel('x.y', { fields: { a: f.char({ column: 'b' }), b: f.char() } }));
    invalid(() => defineModel('x.y', { table: 'Bad Table', fields: {} }));
  });

  test('monetary.currency and quantity.uom must name a many2one of the right model', () => {
    const e1 = invalid(() =>
      defineModel('x.y', { fields: { amount: f.monetary({ currency: 'currnecy' }) } as never }),
    );
    expect(e1.message).toMatch(/currnecy/);
    invalid(() =>
      defineModel('x.y', {
        fields: {
          amount: f.monetary({ currency: 'partner' }),
          partner: f.many2one('res.partner'),
        } as never,
      }),
    );
    invalid(() =>
      defineModel('x.y', {
        fields: {
          qty: f.quantity({ uom: 'partner' }),
          partner: f.many2one('res.partner'),
        } as never,
      }),
    );
    expect(
      defineModel('x.y', {
        fields: { qty: f.quantity({ uom: 'uom' }), uom: f.many2one('uom.uom') },
      }).fields.qty.uomField,
    ).toBe('uom');
  });

  test('compute by name must be a method; methods must be camelCase functions', () => {
    invalid(() => defineModel('x.y', { fields: { a: f.char({ compute: 'computeA' }) } as never }));
    invalid(() => defineModel('x.y', { fields: {}, methods: { bad_name: () => undefined } }));
    invalid(() =>
      defineModel('x.y', { fields: {}, methods: { ensureOne: () => undefined } as never }),
    );
  });

  test('order, recName, tracking refer to existing fields', () => {
    invalid(() => defineModel('x.y', { order: ['nope desc'], fields: {} } as never));
    invalid(() => defineModel('x.y', { order: ['id sideways'], fields: {} } as never));
    invalid(() =>
      defineModel('x.y', { order: ['lines'], fields: { lines: f.one2many('a.b', 'c') } } as never),
    );
    invalid(() => defineModel('x.y', { recName: 'nope', fields: {} } as never));
    invalid(() => defineModel('x.y', { tracking: ['nope'], fields: {} } as never));
  });

  test('SQL constraints, indexes and constraints are validated', () => {
    invalid(() =>
      defineModel('x.y', {
        fields: {},
        sqlConstraints: { 'bad key': { unique: ['id'], message: 'x' } },
      }),
    );
    invalid(() =>
      defineModel('x.y', {
        fields: {},
        sqlConstraints: { k: { unique: ['nope'], message: 'x' } } as never,
      }),
    );
    invalid(() =>
      defineModel('x.y', {
        fields: { l: f.one2many('a.b', 'c') },
        sqlConstraints: { k: { unique: ['l'], message: 'x' } },
      }),
    );
    invalid(() =>
      defineModel('x.y', { fields: {}, sqlConstraints: { k: { unique: ['id'], message: '' } } }),
    );
    invalid(() =>
      defineModel('x.y', {
        fields: {},
        sqlConstraints: { k: { check: 'id > 0', message: 'x' } } as never,
      }),
    );
    invalid(() => defineModel('x.y', { fields: {}, indexes: [{ fields: [] }] }));
    invalid(() =>
      defineModel('x.y', {
        fields: {},
        constraints: { k: { depends: [], check: () => [], message: 'x' } },
      }),
    );
  });
});
