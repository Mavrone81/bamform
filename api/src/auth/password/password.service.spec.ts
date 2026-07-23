import { ConfigService } from '@nestjs/config';
import { PasswordService } from './password.service';

/**
 * PRD §10 test focus ("Argon2 params") + SECURITY_ARCHITECTURE.md §5.1/§8:
 * Argon2id, m=65536 KiB, t=3, p=4, 32-byte output. Params must come from
 * ARGON2_MEMORY_KIB/ARGON2_ITERATIONS/ARGON2_PARALLELISM (.env.example),
 * not hardcoded defaults chosen independently of the config.
 */
describe('PasswordService', () => {
  function makeService(overrides: Record<string, string> = {}): PasswordService {
    const values: Record<string, string> = {
      ARGON2_MEMORY_KIB: '65536',
      ARGON2_ITERATIONS: '3',
      ARGON2_PARALLELISM: '4',
      ...overrides,
    };
    const config = { get: (key: string) => values[key] } as unknown as ConfigService;
    return new PasswordService(config);
  }

  it('U-ENC-09: hashes with argon2id and the configured parameters encoded in the hash', async () => {
    const service = makeService();
    const hash = await service.hash('a-correct-horse-battery-staple');

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).toContain('m=65536');
    expect(hash).toContain('t=3');
    expect(hash).toContain('p=4');
  });

  it('verifies a matching password', async () => {
    const service = makeService();
    const hash = await service.hash('correct-password-123456');

    await expect(service.verify(hash, 'correct-password-123456')).resolves.toBe(true);
  });

  it('rejects a non-matching password', async () => {
    const service = makeService();
    const hash = await service.hash('correct-password-123456');

    await expect(service.verify(hash, 'wrong-password-123456')).resolves.toBe(false);
  });

  it('honours a different configured memory cost', async () => {
    const service = makeService({ ARGON2_MEMORY_KIB: '19456' });
    const hash = await service.hash('a-correct-horse-battery-staple');

    expect(hash).toContain('m=19456');
  });

  it('verify() never throws on a malformed hash — returns false', async () => {
    const service = makeService();
    await expect(service.verify('not-an-argon2-hash', 'anything')).resolves.toBe(false);
  });
});
