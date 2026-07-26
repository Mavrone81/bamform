import { generateKeyPairSync } from 'node:crypto';
import { AccessTokenService } from '../jwt/access-token.service';
import { MFA_CHALLENGE_AUDIENCE, MfaChallengeTokenService } from './mfa-challenge-token.service';

const ISSUER = 'https://form.bevorasg.com';
const ACCESS_AUDIENCE = 'bamform-api';

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
}

function services() {
  const { privateKey, publicKey } = keys();
  const signingKey = { kid: 'test-kid', privateKey };
  const resolve = () => publicKey;
  return {
    access: new AccessTokenService(signingKey, resolve, ISSUER, ACCESS_AUDIENCE, 900),
    challenge: new MfaChallengeTokenService(signingKey, resolve, ISSUER, 300),
  };
}

/**
 * S-35 — the MFA challenge token must be impossible to use as an access
 * token (brief §4.2/§12). It is signed by the SAME Ed25519 key as the access
 * token (one key, one JWKS, PR-087), so the ONLY thing separating them is
 * the audience/`typ` binding — which is exactly why this is asserted in both
 * directions rather than assumed.
 */
describe('S-35 MFA challenge token is not an access token, and vice versa', () => {
  it('a challenge token is REJECTED by AccessTokenService.verify', async () => {
    const { access, challenge } = services();
    const { token } = await challenge.sign('11111111-1111-7111-8111-111111111111');
    await expect(access.verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('an access token is REJECTED by MfaChallengeTokenService.verify', async () => {
    const { access, challenge } = services();
    const { token } = await access.sign('11111111-1111-7111-8111-111111111111', ['ADMIN']);
    await expect(challenge.verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('carries a distinct audience and typ so the difference is visible on the wire', async () => {
    const { challenge } = services();
    const { token } = await challenge.sign('11111111-1111-7111-8111-111111111111');
    const [header, payload] = token
      .split('.')
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
    expect(payload.aud).toBe(MFA_CHALLENGE_AUDIENCE);
    expect(payload.aud).not.toBe(ACCESS_AUDIENCE);
    expect(header.typ).toBe('mfa-challenge+jwt');
  });

  it('carries no `roles` claim — it authorises nothing but the MFA endpoints', async () => {
    const { challenge } = services();
    const { token } = await challenge.sign('11111111-1111-7111-8111-111111111111');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.roles).toBeUndefined();
  });

  it('round-trips its own token, exposing the subject and a jti for the denylist', async () => {
    const { challenge } = services();
    const userId = '11111111-1111-7111-8111-111111111111';
    const { token, expiresIn } = await challenge.sign(userId);
    const claims = await challenge.verify(token);
    expect(claims.sub).toBe(userId);
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(expiresIn).toBe(300);
  });

  it('rejects an expired challenge token', async () => {
    const { privateKey, publicKey } = keys();
    const expired = new MfaChallengeTokenService(
      { kid: 'test-kid', privateKey },
      () => publicKey,
      ISSUER,
      -1,
    );
    const { token } = await expired.sign('11111111-1111-7111-8111-111111111111');
    await expect(expired.verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token signed by a different key (S-03 equivalent)', async () => {
    const { challenge } = services();
    const other = services().challenge;
    const { token } = await other.sign('11111111-1111-7111-8111-111111111111');
    await expect(challenge.verify(token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects `alg: none` and HS256 forgeries (S-01/S-02 equivalent)', async () => {
    const { challenge } = services();
    const claims = Buffer.from(
      JSON.stringify({
        sub: '11111111-1111-7111-8111-111111111111',
        aud: MFA_CHALLENGE_AUDIENCE,
        iss: ISSUER,
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString('base64url');

    for (const alg of ['none', 'HS256']) {
      const header = Buffer.from(JSON.stringify({ alg, typ: 'mfa-challenge+jwt' })).toString(
        'base64url',
      );
      await expect(challenge.verify(`${header}.${claims}.`)).rejects.toMatchObject({ status: 401 });
    }
  });
});
