import { generateKeyPairSync } from 'node:crypto';
import { JwtKeysService } from './jwt-keys.service';

describe('JwtKeysService', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const kid = 'bf-2026-07';
  const service = new JwtKeysService(Buffer.from(pem, 'utf8'), kid);

  it('exposes the signing key under the configured kid', () => {
    expect(service.signingKey.kid).toBe(kid);
    expect(service.signingKey.privateKey.asymmetricKeyType).toBe('ed25519');
  });

  it('resolves the verification key for the current kid', () => {
    const resolved = service.resolveVerificationKey(kid);
    expect(resolved.asymmetricKeyType).toBe('ed25519');
    expect(resolved.type).toBe('public');
  });

  it('throws for an unknown kid (PR-087: verifier only trusts published keys)', () => {
    expect(() => service.resolveVerificationKey('unknown-kid')).toThrow(/unknown kid/i);
  });

  it('throws when kid is undefined', () => {
    expect(() => service.resolveVerificationKey(undefined)).toThrow(/unknown kid/i);
  });

  it('publishes a JWKS document — PR-087: kty=OKP, crv=Ed25519, kid present', async () => {
    const jwks = await service.getJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid });
    expect(typeof jwks.keys[0].x).toBe('string');
    // OKP private key material is the JWK `d` member — must never be published.
    expect((jwks.keys[0] as Record<string, unknown>).d).toBeUndefined();
  });
});
