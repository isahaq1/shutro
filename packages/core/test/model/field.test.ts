import { describe, expect, test } from 'vitest';
import { f, InvalidFieldError, isField, ShutroError } from '../../src/index.js';

function invalid(fn: () => unknown): InvalidFieldError {
  try {
    fn();
  } catch (e) {
    if (e instanceof InvalidFieldError) {
      expect(e).toBeInstanceOf(ShutroError);
      expect(e.code).toBe('INVALID_FIELD');
      expect(e.message).toContain(e.hint);
      return e;
    }
    throw e;
  }
  throw new Error('expected InvalidFieldError');
}

describe('field descriptors are frozen metadata', () => {
  test('char with defaults', () => {
    const field = f.char();
    expect(isField(field)).toBe(true);
    expect(Object.isFrozen(field)).toBe(true);
    expect(field).toMatchObject({
      kind: 'char',
      required: false,
      readonly: false,
      store: true,
      computed: false,
      pgType: 'text',
    });
  });

  test('options are normalized', () => {
    const field = f.char({ required: true, size: 64, label: 'Name', index: 'trigram' });
    expect(field).toMatchObject({
      required: true,
      size: 64,
      label: 'Name',
      index: 'trigram',
      pgType: 'varchar(64)',
    });
  });

  test('isField rejects look-alikes', () => {
    expect(isField({ kind: 'char' })).toBe(false);
    expect(isField(null)).toBe(false);
  });
});

describe('scalar kinds and PostgreSQL types', () => {
  test.each([
    [f.text(), 'text'],
    [f.html(), 'text'],
    [f.boolean(), 'boolean'],
    [f.integer(), 'integer'],
    [f.bigint(), 'bigint'],
    [f.float(), 'double precision'],
    [f.decimal({ scale: 2 }), 'numeric(32, 2)'],
    [f.decimal({ scale: 4, precision: 20 }), 'numeric(20, 4)'],
    [f.decimal({ scale: 'product.price' }), 'numeric'], // named precision: resolved at registry build
    [f.monetary({ currency: 'currency' }), 'numeric'],
    [f.quantity({ uom: 'uom' }), 'numeric'],
    [f.date(), 'date'],
    [f.datetime(), 'timestamptz'],
    [f.selection({ a: 'A' }), 'text'],
    [f.json(), 'jsonb'],
    [f.binary(), 'bytea'],
  ])('%o → %s', (field, pgType) => {
    expect(field.pgType).toBe(pgType);
  });

  test('boolean is never nullable and defaults to false', () => {
    expect(f.boolean()).toMatchObject({ required: true, default: false });
    expect(f.boolean({ default: true })).toMatchObject({ default: true });
  });

  test('decimal scale and precision are validated', () => {
    expect(invalid(() => f.decimal({ scale: -1 })).message).toMatch(/scale/);
    expect(invalid(() => f.decimal({ scale: 2, precision: 1 })).message).toMatch(/precision/);
    expect(invalid(() => f.decimal({ scale: 1.5 })).message).toMatch(/scale/);
  });

  test('char size must be a positive integer', () => {
    invalid(() => f.char({ size: 0 }));
    invalid(() => f.char({ size: 2.5 }));
  });

  test('defaults for decimal-valued fields reject binary floats', () => {
    invalid(() => f.decimal({ scale: 2, default: 0.1 as unknown as string }));
    expect(f.decimal({ scale: 2, default: '0.10' }).default).toBe('0.10');
    expect(f.monetary({ currency: 'currency', default: '0' }).default).toBe('0');
  });

  test('float is marked discouraged in metadata', () => {
    expect(f.float().discouraged).toMatch(/Decimal/);
  });
});

describe('selection and state', () => {
  test('selection keeps labels in order', () => {
    const field = f.selection({ consu: 'Goods', service: 'Service' }, { default: 'consu' });
    expect(field.selection).toEqual([
      ['consu', 'Goods'],
      ['service', 'Service'],
    ]);
    expect(field.default).toBe('consu');
    expect(field.extensible).toBe(false);
  });

  test('dynamic selection', () => {
    const codes = (): readonly string[] => ['en_US', 'bn_BD'];
    expect(f.selection(codes).selection).toBe(codes);
  });

  test('selection rejects empty maps and non-identifier keys', () => {
    invalid(() => f.selection({}));
    invalid(() => f.selection({ 'with space': 'x' }));
  });

  test('state: initial and transitions are validated at runtime too', () => {
    const field = f.state({
      states: { draft: 'Quotation', sale: 'Sales Order', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        confirm: { from: ['draft'], to: 'sale' },
        cancel: { from: ['draft', 'sale'], to: 'cancel' },
      },
    });
    expect(field).toMatchObject({
      kind: 'state',
      readonly: true,
      required: true,
      default: 'draft',
      initial: 'draft',
    });
    expect(field.transitions.confirm).toEqual({ from: ['draft'], to: 'sale' });
    const loose = f.state as unknown as (o: unknown) => unknown;
    invalid(() => loose({ states: { draft: 'D' }, initial: 'nope', transitions: {} }));
    invalid(() =>
      loose({
        states: { draft: 'D' },
        initial: 'draft',
        transitions: { x: { from: ['zzz'], to: 'draft' } },
      }),
    );
    invalid(() =>
      loose({
        states: { draft: 'D' },
        initial: 'draft',
        transitions: { x: { from: ['draft'], to: 'zzz' } },
      }),
    );
    invalid(() =>
      loose({
        states: { draft: 'D' },
        initial: 'draft',
        transitions: { x: { from: [], to: 'draft' } },
      }),
    );
  });
});

describe('relations', () => {
  test('many2one defaults to ondelete restrict and column <name>_id (set by the model)', () => {
    const field = f.many2one('res.partner', { required: true, index: true });
    expect(field).toMatchObject({
      kind: 'many2one',
      target: 'res.partner',
      ondelete: 'restrict',
      required: true,
      index: true,
      pgType: 'bigint',
    });
    expect(f.many2one('res.partner', { ondelete: 'set null' }).ondelete).toBe('set null');
    invalid(() => f.many2one('res.partner', { required: true, ondelete: 'set null' } as never));
  });

  test('one2many needs an inverse and is never stored', () => {
    const field = f.one2many('sale.order.line', 'order', { copy: true });
    expect(field).toMatchObject({
      kind: 'one2many',
      target: 'sale.order.line',
      inverseField: 'order',
      store: false,
      copy: true,
    });
    invalid(() => f.one2many('sale.order.line', ''));
  });

  test('many2many', () => {
    expect(f.many2many('account.tax', { relation: 'product_taxes_rel' })).toMatchObject({
      kind: 'many2many',
      target: 'account.tax',
      relation: 'product_taxes_rel',
      store: false,
    });
    invalid(() => f.many2many('account.tax', { relation: 'Bad Name' }));
  });

  test('model names must be dotted lower-case identifiers', () => {
    invalid(() => f.many2one('ResPartner'));
    invalid(() => f.many2one(''));
    invalid(() => f.many2one('res.partner.'));
  });
});

describe('compute and related options', () => {
  test('compute as a function or a method name, with depends', () => {
    const inline = f.char({ store: true, depends: ['name'], compute: () => undefined });
    expect(inline).toMatchObject({
      computed: true,
      store: true,
      depends: ['name'],
      readonly: true,
    });
    const named = f.monetary({
      currency: 'currency',
      compute: 'computeAmounts',
      depends: ['lines.subtotal'],
    });
    expect(named).toMatchObject({ computed: true, store: false, compute: 'computeAmounts' });
  });

  test('computed fields are not stored unless store: true', () => {
    expect(f.char({ compute: () => undefined }).store).toBe(false);
  });

  test('depends without compute, or store: true on a relation, is an error', () => {
    invalid(() => f.char({ depends: ['x'] } as never));
    invalid(() => f.one2many('a.b', 'c', { store: true } as never));
  });

  test('an inverse makes a computed field writable', () => {
    expect(f.char({ compute: () => undefined, inverse: () => undefined }).readonly).toBe(false);
  });

  test('sequence implies readonly', () => {
    expect(f.char({ required: true, sequence: 'sale.order' })).toMatchObject({
      readonly: true,
      sequence: { code: 'sale.order', gapless: false },
    });
    expect(f.char({ sequence: { code: 'account.move', gapless: true } }).sequence).toEqual({
      code: 'account.move',
      gapless: true,
    });
  });

  test('translate is only for text-like fields', () => {
    expect(f.text({ translate: true }).pgType).toBe('jsonb');
    expect(f.char({ translate: true }).pgType).toBe('jsonb');
  });
});
