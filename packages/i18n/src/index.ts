/**
 * @packageDocumentation
 * `@shutro/i18n`: the pure rules of translatable fields (RFC 0011). A translatable value is a map from language
 * code to text, stored as JSONB; reading resolves the environment language with a fallback to the source language,
 * writing merges into the map. Core applies these on `translate: true` fields; applications can use them on their
 * own JSON.
 */

/** Language → text, as stored in a `translate: true` column (`{ "en_US": "Laptop", "bn_BD": "ল্যাপটপ" }`). */
export type Translations = Readonly<Record<string, string>>;

/** `en_US`, `bn_BD`, `fr`, `pt_BR`. */
export const LANG_CODE: RegExp = /^[a-z]{2,3}(_[A-Z]{2})?$/;

/** True for a well-formed language code. */
export function isLangCode(value: unknown): value is string {
  return typeof value === 'string' && LANG_CODE.test(value);
}

/** True for a plain object whose keys are language codes and whose values are strings. */
export function isTranslations(value: unknown): value is Translations {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([k, v]) => isLangCode(k) && typeof v === 'string');
}

/**
 * The text to show for `lang`: the language itself, then the source language, then the first translation by sorted
 * language code (so a record translated only in `fr_FR` still shows something), else `null`.
 */
export function resolveTranslation(
  value: Translations | null | undefined,
  lang: string,
  source: string,
): string | null {
  if (value === null || value === undefined) return null;
  const own = value[lang];
  if (own !== undefined) return own;
  const fallback = value[source];
  if (fallback !== undefined) return fallback;
  const first = Object.keys(value).sort()[0];
  return first === undefined ? null : (value[first] ?? null);
}

/**
 * The map after writing `value` in `lang`: a string sets that language (and the source language when the record has
 * no source text yet, so readers of other languages see the new text); a map sets every language it names.
 */
export function mergeTranslation(
  existing: Translations | null | undefined,
  value: string | Translations,
  lang: string,
  source: string,
): Translations {
  const base: Record<string, string> = { ...(existing ?? {}) };
  if (typeof value === 'string') {
    if (base[source] === undefined) base[source] = value;
    base[lang] = value;
    return Object.freeze(base);
  }
  for (const [k, v] of Object.entries(value)) base[k] = v;
  return Object.freeze(base);
}
