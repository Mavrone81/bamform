import { inputSchema } from './bootstrap-admin';

/**
 * Unit coverage for `bootstrap-admin.ts`'s local validation policy. The CLI
 * itself is deliberately un-unit-tested (it needs a real TTY) — this only
 * exercises `inputSchema`, imported directly so importing this module does
 * NOT launch Nest, open a DB connection, or prompt for anything: `bootstrap()`
 * only self-invokes when the file is run directly (`require.main === module`),
 * not when imported by a test.
 */
describe('bootstrap-admin inputSchema', () => {
  const valid = {
    fullName: 'Ada Lovelace',
    email: 'ada@example.com',
    password: 'ThrowawayPW123!',
  };

  it('accepts a valid full name (<=200 chars), email, and 12+ char password', () => {
    const result = inputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects a password shorter than 12 characters', () => {
    const result = inputSchema.safeParse({ ...valid, password: '1234567890a' }); // 11 chars
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email address', () => {
    const result = inputSchema.safeParse({ ...valid, email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty/whitespace-only full name', () => {
    const result = inputSchema.safeParse({ ...valid, fullName: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects a full name over 200 characters (matches userCreateSchema.fullName.max(200))', () => {
    const result = inputSchema.safeParse({ ...valid, fullName: 'A'.repeat(201) });
    expect(result.success).toBe(false);
  });
});
