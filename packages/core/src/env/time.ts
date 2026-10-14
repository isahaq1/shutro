import { InvalidIdentityError } from '../errors.js';

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Validates an IANA time zone name (`'Asia/Dhaka'`, `'UTC'`).
 * @throws {InvalidIdentityError} when the runtime doesn't know the zone.
 */
export function assertTimeZone(tz: string): void {
  formatterFor(tz);
}

function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz);
  if (cached !== undefined) return cached;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(tz, formatter);
    return formatter;
  } catch {
    throw new InvalidIdentityError(
      `${JSON.stringify(tz)} is not a known IANA time zone.`,
      "Use a name such as 'Asia/Dhaka', 'Europe/Berlin' or 'UTC' (see the tz database).",
    );
  }
}

/**
 * The calendar date (`'YYYY-MM-DD'`) of an instant in a time zone. Business dates always need an explicit zone
 * (RFC 0003 §7.8): `2026-10-14T20:30Z` is already the 15th in Dhaka.
 *
 * @throws {InvalidIdentityError} for an unknown time zone.
 */
export function calendarDateIn(instant: Date, tz: string): string {
  const parts = formatterFor(tz).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
