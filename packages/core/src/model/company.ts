/**
 * Multi-company consistency (RFC 0003 §7.4): a `checkCompany` many2one must point at a shared record (no company) or
 * at a record of the referencing record's company. Synthesized as a business constraint by `defineModel`.
 */

import { CrossCompanyError } from '../errors.js';

interface RecLike {
  readonly id: number;
  readonly company: { readonly id: number } | null;
  readonly [key: string]: unknown;
}
interface SetLike {
  readonly env: { readonly flags: { readonly checkCompany: boolean } };
  load(spec: Record<string, readonly string[]>): Promise<Iterable<RecLike>>;
}

/** The check function of the synthesized `companyConsistency` constraint. Throws rather than returning failing records. */
export function companyConsistencyCheck(
  model: string,
  keys: readonly string[],
): (records: never) => Promise<readonly never[]> {
  return async (records: never): Promise<readonly never[]> => {
    const set = records as unknown as SetLike;
    if (!set.env.flags.checkCompany) return [];
    const spec: Record<string, readonly string[]> = {};
    for (const key of keys) spec[key] = ['company'];
    const loaded = await set.load(spec);
    const offending: {
      id: number;
      field: string;
      company: number | null;
      targetCompany: number;
    }[] = [];
    for (const record of loaded) {
      const company = record.company?.id ?? null;
      for (const key of keys) {
        const target = record[key] as { readonly company: { readonly id: number } | null } | null;
        const targetCompany = target?.company?.id ?? null;
        if (target === null || targetCompany === null || targetCompany === company) continue;
        offending.push({ id: record.id, field: key, company, targetCompany });
      }
    }
    if (offending.length > 0) throw new CrossCompanyError(model, offending);
    return [];
  };
}
