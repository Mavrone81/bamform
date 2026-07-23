import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { SignJWT, UnsecuredJWT, exportJWK } from 'jose';
import { AccessTokenService } from './access-token.service';

const ISSUER = 'https://form.bevorasg.com';
const AUDIENCE = 'bamform-api';
const KID = 'bf-2026-07';

function makeService(privateKey: KeyObject, publicKey: KeyObject, kid = KID): AccessTokenService {
  const keys = new Map<string, KeyObject>([[kid, publicKey]]);
  return new AccessTokenService(
    { kid, privateKey },
    (resolveKid) => {
      const key = resolveKid && keys.get(resolveKid);
      if (!key) throw new Error(`unknown kid: ${String(resolveKid)}`);
      return key;
    },
    ISSUER,
    AUDIENCE,
    900,
  );
}

describe('AccessTokenService', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const service = makeService(privateKey, publicKey);

  it('signs and verifies a token carrying exactly PR-086s seven claims', async () => {
    const { token } = await service.sign('user-1', ['MAINTAINER', 'TEAM_LEADER']);
    const claims = await service.verify(token);

    expect(Object.keys(claims).sort()).toEqual(
      ['aud', 'exp', 'iat', 'iss', 'jti', 'roles', 'sub'].sort(),
    );
    expect(claims.sub).toBe('user-1');
    expect(claims.roles).toEqual(['MAINTAINER', 'TEAM_LEADER']);
    expect(claims.aud).toBe(AUDIENCE);
    expect(claims.iss).toBe(ISSUER);
    expect(typeof claims.jti).toBe('string');
  });

  it('S-01 rejects a token with alg: none', async () => {
    const forged = new UnsecuredJWT({ sub: 'attacker', roles: ['ADMIN'] })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .encode();

    await expect(service.verify(forged)).rejects.toMatchObject({
      response: { type: '/errors/unauthenticated', status: 401 },
    });
  });

  it('S-02 rejects a token signed HS256 with the public key as the "secret"', async () => {
    const jwk = await exportJWK(publicKey);
    const confusedSecret = Buffer.from(JSON.stringify(jwk), 'utf8');
    const forged = await new SignJWT({ sub: 'attacker', roles: ['ADMIN'] })
      .setProtectedHeader({ alg: 'HS256', kid: KID })
      .setIssuedAt()
      .setExpirationTime('15m')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(confusedSecret);

    await expect(service.verify(forged)).rejects.toMatchObject({
      response: { type: '/errors/unauthenticated', status: 401 },
    });
  });

  it('S-03 rejects a token signed with the wrong key (same kid, different keypair)', async () => {
    const rogue = generateKeyPairSync('ed25519');
    const forged = await new SignJWT({ sub: 'attacker', roles: ['ADMIN'] })
      .setProtectedHeader({ alg: 'EdDSA', kid: KID })
      .setIssuedAt()
      .setExpirationTime('15m')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(rogue.privateKey);

    await expect(service.verify(forged)).rejects.toMatchObject({
      response: { type: '/errors/unauthenticated', status: 401 },
    });
  });

  it('S-04 rejects an expired token', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ sub: 'user-1', roles: ['MAINTAINER'] })
      .setProtectedHeader({ alg: 'EdDSA', kid: KID })
      .setIssuedAt(nowSeconds - 1000)
      .setExpirationTime(nowSeconds - 1)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(privateKey);

    await expect(service.verify(expired)).rejects.toMatchObject({
      response: { type: '/errors/unauthenticated', status: 401 },
    });
  });

  it('S-05 rejects a token with a tampered roles claim (signature no longer matches)', async () => {
    const { token } = await service.sign('user-1', ['MAINTAINER']);
    const [headerB64, payloadB64, signatureB64] = token.split('.');

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    payload.roles = ['ADMIN'];
    const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const tampered = `${headerB64}.${tamperedPayloadB64}.${signatureB64}`;

    await expect(service.verify(tampered)).rejects.toMatchObject({
      response: { type: '/errors/unauthenticated', status: 401 },
    });
  });
});
