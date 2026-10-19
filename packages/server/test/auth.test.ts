/**
 * Password hashing (RFC 0020 §7.7): scrypt, salted, constant-time verification, minimum length.
 */
import { describe, expect, test } from 'vitest';
import { HttpError, hashPassword, MIN_PASSWORD, verifyPassword } from '../src/index.js';

describe('passwords', () => {
  test('hashes are salted scrypt and verify only the right password', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$15\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
    expect(a).not.toBe(b); // a fresh salt each time
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterz', a)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

  test('unicode is normalized, so the same password typed differently still matches', async () => {
    const hash = await hashPassword('café crème brûlée');
    expect(await verifyPassword('café crème brûlée', hash)).toBe(true);
  });

  test(`passwords shorter than ${MIN_PASSWORD} characters are refused with the field named`, async () => {
    const error = await hashPassword('short').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(422);
    expect((error as HttpError).fields).toEqual(['password']);
  });
});
