import {
  type Currency,
  defineCurrency,
  defineUom,
  ShutroError,
  type Uom,
} from '../../src/index.js';

export const BDT: Currency = defineCurrency({ code: 'BDT', rounding: '0.01' });
export const USD: Currency = defineCurrency({
  code: 'USD',
  rounding: '0.01',
  roundingMethod: 'half-even',
});
export const JPY: Currency = defineCurrency({ code: 'JPY', rounding: '1' });
export const KWD: Currency = defineCurrency({ code: 'KWD', rounding: '0.001' });
/** Swiss cash rounding: amounts end in .00 or .05. */
export const CHF_CASH: Currency = defineCurrency({ code: 'CHF', rounding: '0.05' });

export const UNIT: Uom = defineUom({ name: 'Units', category: 'Unit', ratio: '1', rounding: '1' });
export const DOZEN: Uom = defineUom({
  name: 'Dozens',
  category: 'Unit',
  ratio: '12',
  rounding: '0.01',
});
export const KG: Uom = defineUom({ name: 'kg', category: 'Weight', ratio: '1', rounding: '0.001' });
export const GRAM: Uom = defineUom({
  name: 'g',
  category: 'Weight',
  ratio: '0.001',
  rounding: '1',
});

/** Runs `fn` and returns the ShutroError it throws (fails the test otherwise). */
export function catchError(fn: () => unknown): ShutroError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ShutroError) return e;
    throw e;
  }
  throw new Error('expected a ShutroError');
}
