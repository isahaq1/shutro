import { describe, expect, test } from 'vitest';
import { calendarDateIn, InvalidIdentityError } from '../../src/index.js';

describe('calendarDateIn (RFC 0003 §7.8: business dates need an explicit time zone)', () => {
  const instant = new Date('2026-10-14T20:30:00Z');

  test.each([
    ['Asia/Dhaka', '2026-10-15'], // UTC+6: already tomorrow
    ['UTC', '2026-10-14'],
    ['America/Los_Angeles', '2026-10-14'],
    ['Pacific/Kiritimati', '2026-10-15'], // UTC+14
  ])('%s → %s', (tz, expected) => {
    expect(calendarDateIn(instant, tz)).toBe(expected);
  });

  test('an unknown time zone is rejected with a hint', () => {
    expect(() => calendarDateIn(instant, 'Mars/Olympus')).toThrow(InvalidIdentityError);
  });
});
