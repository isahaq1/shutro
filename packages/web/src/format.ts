/**
 * Display formatting. Money and decimals stay strings end to end: `Intl.NumberFormat` formats a decimal string
 * exactly, so no amount ever passes through a JavaScript number (CLAUDE.md money rule).
 */
import type { FieldMeta } from './api.js';

const formatters = new Map<string, Intl.NumberFormat>();
function nf(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (f === undefined) {
    f = new Intl.NumberFormat(locale, options);
    formatters.set(key, f);
  }
  return f;
}

/** `en_US` → `en-US`. */
const locale = (lang: string): string => lang.replace('_', '-');

/** A decimal string formatted exactly (Intl treats strings as exact decimals). */
function decimal(value: string, lang: string, places?: number): string {
  const f = nf(
    locale(lang),
    places === undefined
      ? { maximumFractionDigits: 20 }
      : { minimumFractionDigits: places, maximumFractionDigits: places },
  );
  return f.format(value as unknown as number); // a string: formatted exactly, not converted
}

interface MoneyValue {
  readonly amount: string;
  readonly currency: string;
}

export const isMoney = (v: unknown): v is MoneyValue =>
  typeof v === 'object' && v !== null && 'amount' in v && 'currency' in v;

function money(value: MoneyValue, lang: string): string {
  try {
    return nf(locale(lang), { style: 'currency', currency: value.currency }).format(
      value.amount as unknown as number,
    );
  } catch {
    return `${value.currency} ${value.amount}`;
  }
}

function date(value: string, lang: string): string {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return value;
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: 'medium', timeZone: 'UTC' }).format(
    Date.UTC(y, m - 1, d),
  );
}

function datetime(value: string, lang: string, tz: string): string {
  return new Intl.DateTimeFormat(locale(lang), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  }).format(new Date(value));
}

export function relative(value: string, lang: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}

/** A field value as text, for lists, cards and the timeline. */
export function display(
  value: unknown,
  field: FieldMeta | undefined,
  lang: string,
  tz: string,
): string {
  if (value === null || value === undefined || value === '') return '';
  if (isMoney(value)) return money(value, lang);
  if (typeof value === 'object' && 'name' in value)
    return String((value as { name: unknown }).name);
  if (field === undefined) return String(value);
  switch (field.kind) {
    case 'selection':
    case 'state':
      return field.selection?.find(([k]) => k === value)?.[1] ?? String(value);
    case 'boolean':
      return value === true ? 'Yes' : 'No';
    case 'date':
      return date(String(value), lang);
    case 'datetime':
      return datetime(String(value), lang, tz);
    case 'decimal':
    case 'quantity':
      return decimal(String(value), lang, field.scale);
    case 'integer':
      return nf(locale(lang), {}).format(Number(value));
    default:
      return String(value);
  }
}

/** Numbers and amounts align right, with tabular figures. */
export const numeric = (field: FieldMeta | undefined): boolean =>
  field !== undefined && ['integer', 'decimal', 'monetary', 'quantity'].includes(field.kind);

/** A stable hue per app, so each app keeps its color everywhere. */
export function hueOf(name: string): number {
  const fixed: Readonly<Record<string, number>> = {
    account: 160,
    sale: 277,
    purchase: 25,
    project: 205,
    settings: 250,
    partner: 300,
    product: 55,
  };
  const known = fixed[name];
  if (known !== undefined) return known;
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}

/** Badge tone of a workflow state. */
export function stateTone(
  state: string,
): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' {
  if (['cancel', 'cancelled', 'rejected'].includes(state)) return 'danger';
  if (['done', 'posted', 'paid', 'sale', 'purchase', 'closed'].includes(state)) return 'success';
  if (['draft', 'new'].includes(state)) return 'neutral';
  if (['sent', 'to_approve', 'waiting', 'partial'].includes(state)) return 'warning';
  return 'info';
}

/** English plural of a label: `Sales order` → `Sales orders`, `Company` → `Companies`, `Tax` → `Taxes`. */
export function plural(label: string): string {
  if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(label)) return `${label}es`;
  return `${label}s`;
}
