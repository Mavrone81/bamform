import { generateKeyPairSync } from 'node:crypto';
import { RecordSigningService } from './record-signer';
import { computeContentHash } from './content-hash';
import { buildGoldenRecordFixture } from './canonical-record.fixture';

function generateEd25519Pem(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

describe('RecordSigningService (PR-094, PR-SEC-07)', () => {
  it('rejects a non-Ed25519 key at construction', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => new RecordSigningService(Buffer.from(pem), 'kid-1')).toThrow(/Ed25519/);
  });

  it('U-SIG-09: signature verifies against the published public key', () => {
    const service = new RecordSigningService(Buffer.from(generateEd25519Pem()), 'kid-1');
    const hash = computeContentHash(buildGoldenRecordFixture());
    const signature = service.sign(hash);
    expect(service.verify(hash, signature, service.getPublicKey())).toBe(true);
  });

  it('U-SIG-10: signature verified against the wrong key is invalid', () => {
    const service = new RecordSigningService(Buffer.from(generateEd25519Pem()), 'kid-1');
    const otherService = new RecordSigningService(Buffer.from(generateEd25519Pem()), 'kid-2');
    const hash = computeContentHash(buildGoldenRecordFixture());
    const signature = service.sign(hash);
    expect(service.verify(hash, signature, otherService.getPublicKey())).toBe(false);
  });

  it('a signature does not verify against a different (tampered) content hash', () => {
    const service = new RecordSigningService(Buffer.from(generateEd25519Pem()), 'kid-1');
    const hash = computeContentHash(buildGoldenRecordFixture());
    const signature = service.sign(hash);
    const tamperedHash = Buffer.from(hash);
    tamperedHash[0] ^= 0xff;
    expect(service.verify(tamperedHash, signature)).toBe(false);
  });

  it('exposes the configured kid', () => {
    const service = new RecordSigningService(Buffer.from(generateEd25519Pem()), 'bf-rec-2026-07');
    expect(service.kid).toBe('bf-rec-2026-07');
  });
});
