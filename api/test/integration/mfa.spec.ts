import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { authResultSchema, mfaChallengeResponseSchema } from '@bamform/shared';
import { currentTotpStep, totpCode } from '../../src/auth/mfa/totp';
import { createLoginableUser, enrolMfaForUser, seedRecoveryCodes } from './helpers/auth-fixtures';
import { createTestApp } from './helpers/app';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { closeRedis, resetRedis } from './helpers/redis';

const PASSWORD = 'CorrectHorseBattery1!';

function extractCookie(res: request.Response, name: string): string | undefined {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  return setCookie?.find((cookie) => cookie.startsWith(`${name}=`));
}

async function auditActions(userId: string): Promise<string[]> {
  const { rows } = await adminPool.query(
    `SELECT "action"::text AS action FROM "audit_event"
      WHERE "entity_id" = $1 ORDER BY "sequence"`,
    [userId],
  );
  return rows.map((row: { action: string }) => row.action);
}

async function userRow(userId: string) {
  const { rows } = await adminPool.query(`SELECT * FROM "app_user" WHERE "id" = $1`, [userId]);
  return rows[0];
}

/**
 * Slice 13-MFA integration suite. Runs against real Postgres + Redis, through
 * the real HTTP surface, with real Argon2id, real AES-256-GCM field
 * encryption and the real audit-chain trigger.
 *
 * `MFA_ENABLED` is manipulated through `process.env` inside individual
 * describes rather than by booting two apps: `ConfigService` reads
 * `process.env` live (no `cache: true`, no `envFilePath` under NODE_ENV=test),
 * and `MfaConfig` reads the flag per call rather than latching it at
 * construction — which is itself a property worth having, since it means a
 * production operator can flip the flag with a restart and nothing else.
 */
describe('Slice 13-MFA — TOTP multi-factor authentication', () => {
  let app: INestApplication;
  const originalMfaEnabled = process.env.MFA_ENABLED;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    process.env.MFA_ENABLED = originalMfaEnabled;
    await app.close();
    await closeAll();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
    delete process.env.MFA_ENABLED;
  });

  // =====================================================================
  // S-38 — the deployment-safety property. This is the most important test
  // in the slice: getting it wrong locks the sole production ADMIN out.
  // =====================================================================
  describe('S-38 MFA_ENABLED=false leaves login byte-identical to today', () => {
    it('an ENROLLED ADMIN still logs in in ONE step, with an access token and a refresh cookie', async () => {
      const { userId } = await createLoginableUser({
        email: 'live-admin@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, randomBytes(20));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'live-admin@bevorasg.com', password: PASSWORD })
        .expect(200);

      // The response is an AuthResult, with NO MFA fields grafted on.
      expect(authResultSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.mfaRequired).toBeUndefined();
      expect(res.body.challengeToken).toBeUndefined();
      expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'expiresIn', 'user']);
      expect(extractCookie(res, 'bf_refresh')).toBeDefined();

      // ...and the access token really works, i.e. this is a complete login.
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
    });

    it('the login-success side effects still happen (counters reset, audit written)', async () => {
      const { userId } = await createLoginableUser({
        email: 'sideeffects@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, randomBytes(20));

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'sideeffects@bevorasg.com', password: PASSWORD })
        .expect(200);

      const user = await userRow(userId);
      expect(user.failed_login_count).toBe(0);
      expect(user.last_login_at).not.toBeNull();
      expect(user.last_authenticated_at).not.toBeNull();
      expect(await auditActions(userId)).toContain('login');
    });

    it('voluntary enrolment still works with the flag off (brief §2) — but nobody is challenged', async () => {
      const { userId } = await createLoginableUser({
        email: 'voluntary@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      const server = app.getHttpServer();
      const login = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'voluntary@bevorasg.com', password: PASSWORD })
        .expect(200);

      // Enrolling on the ACCESS token (there is no challenge token to use).
      const enrol = await request(server)
        .post('/api/v1/auth/mfa/enrol')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({})
        .expect(200);

      const { base32Decode } = await import('../../src/auth/mfa/base32');
      const confirm = await request(server)
        .post('/api/v1/auth/mfa/enrol/confirm')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ code: totpCode(base32Decode(enrol.body.secret), currentTotpStep()) })
        .expect(200);

      expect(confirm.body.recoveryCodes).toHaveLength(10);
      // No login was being completed, so no second session is minted.
      expect(confirm.body.auth).toBeNull();
      expect(extractCookie(confirm, 'bf_refresh')).toBeUndefined();
      expect((await userRow(userId)).mfa_enrolled).toBe(true);

      // ...and the user still logs in in ONE step, because the flag is off.
      const again = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'voluntary@bevorasg.com', password: PASSWORD })
        .expect(200);
      expect(again.body.accessToken).toBeDefined();
      expect(again.body.mfaRequired).toBeUndefined();
    });

    it('every /auth/mfa endpoint is closed to an anonymous caller (deny-by-default, not @Public)', async () => {
      const server = app.getHttpServer();
      for (const path of [
        '/api/v1/auth/mfa/enrol',
        '/api/v1/auth/mfa/enrol/confirm',
        '/api/v1/auth/mfa/verify',
        '/api/v1/auth/mfa/recovery',
      ]) {
        const res = await request(server).post(path).send({});
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ type: '/errors/unauthenticated' });
      }
    });

    it('an explicit MFA_ENABLED=false is the same as absent', async () => {
      process.env.MFA_ENABLED = 'false';
      const { userId } = await createLoginableUser({
        email: 'explicit-off@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, randomBytes(20));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'explicit-off@bevorasg.com', password: PASSWORD })
        .expect(200);
      expect(res.body.accessToken).toBeDefined();
    });
  });

  // =====================================================================
  describe('with MFA_ENABLED=true', () => {
    beforeEach(() => {
      process.env.MFA_ENABLED = 'true';
    });

    // ---------------------------------------------------------- challenge
    it('S-39 a MAINTAINER is EXEMPT and still logs in in one step (SEC RS-3 / SO-3)', async () => {
      await createLoginableUser({
        email: 'tech@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['MAINTAINER'],
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'tech@bevorasg.com', password: PASSWORD })
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      expect(res.body.mfaRequired).toBeUndefined();
      expect(extractCookie(res, 'bf_refresh')).toBeDefined();
    });

    it('a MAINTAINER who is ALSO a TEAM_LEADER is challenged — any required role counts (D-1)', async () => {
      await createLoginableUser({
        email: 'dual@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['MAINTAINER', 'TEAM_LEADER'],
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'dual@bevorasg.com', password: PASSWORD })
        .expect(200);
      expect(res.body.mfaRequired).toBe(true);
    });

    it('a challenged login issues NO access token and NO refresh cookie', async () => {
      const { userId } = await createLoginableUser({
        email: 'challenged@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, randomBytes(20));

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'challenged@bevorasg.com', password: PASSWORD })
        .expect(200);

      expect(mfaChallengeResponseSchema.safeParse(res.body).success).toBe(true);
      expect(res.body).toMatchObject({ mfaRequired: true, mfaEnrolled: true, expiresIn: 300 });
      expect(res.body.accessToken).toBeUndefined();
      expect(extractCookie(res, 'bf_refresh')).toBeUndefined();
      // No `login` audit event yet — the user is not logged in.
      expect(await auditActions(userId)).not.toContain('login');
    });

    it('S-35 the challenge token is refused as an access token by every ordinary endpoint', async () => {
      const { userId } = await createLoginableUser({
        email: 'notanaccesstoken@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, randomBytes(20));

      const { body } = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'notanaccesstoken@bevorasg.com', password: PASSWORD })
        .expect(200);

      for (const path of ['/api/v1/auth/me', '/api/v1/users', '/api/v1/jobs']) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${body.challengeToken}`);
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ type: '/errors/unauthenticated' });
      }
    });

    // ------------------------------------------------------------- verify
    it('POST /auth/mfa/verify with a correct code completes the login', async () => {
      const secret = randomBytes(20);
      const { userId } = await createLoginableUser({
        email: 'verify@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['TEAM_LEADER'],
      });
      await enrolMfaForUser(userId, secret);

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'verify@bevorasg.com', password: PASSWORD })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .send({
          challengeToken: login.body.challengeToken,
          code: totpCode(secret, currentTotpStep()),
        })
        .expect(200);

      expect(authResultSchema.safeParse(res.body).success).toBe(true);
      const cookie = extractCookie(res, 'bf_refresh');
      expect(cookie).toBeDefined();
      // S-29: the cookie MfaController sets must carry identical attributes.
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);

      const user = await userRow(userId);
      expect(user.last_authenticated_at).not.toBeNull();
      expect(await auditActions(userId)).toContain('login');
    });

    it('S-36 the SAME code cannot be used twice inside its 30 s window (RFC 6238 §5.2 replay guard)', async () => {
      const secret = randomBytes(20);
      const { userId } = await createLoginableUser({
        email: 'replay@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ENGINEER'],
      });
      await enrolMfaForUser(userId, secret);
      const code = totpCode(secret, currentTotpStep());

      const first = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'replay@bevorasg.com', password: PASSWORD })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .send({ challengeToken: first.body.challengeToken, code })
        .expect(200);

      // The step is burned...
      expect(Number((await userRow(userId)).mfa_last_used_step)).toBe(currentTotpStep());

      // ...so a fresh login presenting the SAME still-valid code is refused.
      const second = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'replay@bevorasg.com', password: PASSWORD })
        .expect(200);
      const replayed = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .send({ challengeToken: second.body.challengeToken, code })
        .expect(401);
      expect(replayed.body).toMatchObject({ type: '/errors/unauthenticated' });
    });

    it('S-45 a challenge token is single-use — replaying it after a successful verify is 401', async () => {
      const secret = randomBytes(20);
      const { userId } = await createLoginableUser({
        email: 'challenge-replay@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, secret);

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'challenge-replay@bevorasg.com', password: PASSWORD })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .send({
          challengeToken: login.body.challengeToken,
          code: totpCode(secret, currentTotpStep()),
        })
        .expect(200);

      // Same challenge token, a code from the NEXT step so the replay guard
      // is not what rejects it — the burned challenge is.
      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/verify')
        .send({
          challengeToken: login.body.challengeToken,
          code: totpCode(secret, currentTotpStep() + 1),
        })
        .expect(401);
    });

    it('a garbage or absent challenge token is 401, indistinguishable from a wrong code', async () => {
      const server = app.getHttpServer();
      await request(server)
        .post('/api/v1/auth/mfa/verify')
        .send({ challengeToken: 'not.a.token', code: '123456' })
        .expect(401);
      await request(server).post('/api/v1/auth/mfa/verify').send({ code: '123456' }).expect(401);
    });

    it('S-37 wrong TOTP codes feed the SAME account-lockout counter a wrong password does', async () => {
      const secret = randomBytes(20);
      const { userId } = await createLoginableUser({
        email: 'lockout@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, secret);
      const server = app.getHttpServer();

      // Two wrong PASSWORDS, then three wrong CODES = five failures total.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await request(server)
          .post('/api/v1/auth/login')
          .send({ email: 'lockout@bevorasg.com', password: 'WrongPassword123!' })
          .expect(401);
      }
      expect((await userRow(userId)).failed_login_count).toBe(2);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const login = await request(server)
          .post('/api/v1/auth/login')
          .send({ email: 'lockout@bevorasg.com', password: PASSWORD })
          .expect(200);
        await request(server)
          .post('/api/v1/auth/mfa/verify')
          .send({ challengeToken: login.body.challengeToken, code: '000000' })
          .expect(401);
      }
      expect((await userRow(userId)).failed_login_count).toBe(4);

      // The fifth failure — a code, not a password — trips the lockout.
      const fifth = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'lockout@bevorasg.com', password: PASSWORD })
        .expect(200);
      const locked = await request(server)
        .post('/api/v1/auth/mfa/verify')
        .send({ challengeToken: fifth.body.challengeToken, code: '000000' })
        .expect(429);
      expect(locked.body).toMatchObject({ type: '/errors/rate-limited' });
      expect(locked.headers['retry-after']).toBeDefined();

      const user = await userRow(userId);
      expect(user.failed_login_count).toBe(5);
      expect(user.locked_until).not.toBeNull();

      // ...and the CORRECT password is now refused at /auth/login too.
      await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'lockout@bevorasg.com', password: PASSWORD })
        .expect(429);
    });

    it('a correct code resets the lockout counter, as a successful password login does', async () => {
      const secret = randomBytes(20);
      const { userId } = await createLoginableUser({
        email: 'reset-counter@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, secret);
      const server = app.getHttpServer();

      const first = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'reset-counter@bevorasg.com', password: PASSWORD })
        .expect(200);
      await request(server)
        .post('/api/v1/auth/mfa/verify')
        .send({ challengeToken: first.body.challengeToken, code: '000000' })
        .expect(401);
      expect((await userRow(userId)).failed_login_count).toBe(1);

      const second = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'reset-counter@bevorasg.com', password: PASSWORD })
        .expect(200);
      await request(server)
        .post('/api/v1/auth/mfa/verify')
        .send({
          challengeToken: second.body.challengeToken,
          code: totpCode(secret, currentTotpStep()),
        })
        .expect(200);
      expect((await userRow(userId)).failed_login_count).toBe(0);
    });

    it('rate-limits /auth/mfa/verify at 10/min per user (brief §6)', async () => {
      const secret = randomBytes(20);
      const { userId } = await createLoginableUser({
        email: 'ratelimit@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['AUDITOR'],
      });
      await enrolMfaForUser(userId, secret);
      // Take the account lockout out of the picture so the 429 under test is
      // unambiguously the per-minute limiter, not the 5-failure lockout.
      await adminPool.query(`UPDATE "app_user" SET "failed_login_count" = 0 WHERE "id" = $1`, [
        userId,
      ]);
      await adminPool.query(`UPDATE "app_user" SET "locked_until" = NULL WHERE "id" = $1`, [
        userId,
      ]);

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'ratelimit@bevorasg.com', password: PASSWORD })
        .expect(200);

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/mfa/verify')
          .send({ challengeToken: login.body.challengeToken, code: '000000' });
        statuses.push(res.status);
      }
      // Whatever the mix of 401/429 from the lockout, the 11th call must be a
      // 429 and the limiter must have fired at or before it.
      expect(statuses[statuses.length - 1]).toBe(429);
      expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    });

    // ---------------------------------------------------------- enrolment
    it('an unenrolled required-role user is challenged with mfaEnrolled:false and can enrol to finish', async () => {
      await createLoginableUser({
        email: 'enrol@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['DOC_CONTROLLER'],
      });
      const server = app.getHttpServer();

      const login = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'enrol@bevorasg.com', password: PASSWORD })
        .expect(200);
      expect(login.body).toMatchObject({ mfaRequired: true, mfaEnrolled: false });

      const enrol = await request(server)
        .post('/api/v1/auth/mfa/enrol')
        .send({ challengeToken: login.body.challengeToken })
        .expect(200);
      expect(enrol.body.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(enrol.body.otpauthUri).toContain('otpauth://totp/BamForm:enrol%40bevorasg.com');
      expect(enrol.body.otpauthUri).toContain('algorithm=SHA1');
      expect(enrol.body.otpauthUri).toContain('digits=6');
      expect(enrol.body.otpauthUri).toContain('period=30');

      const secret = Buffer.from(
        // decode the base32 the server issued, the way an authenticator would
        (await import('../../src/auth/mfa/base32')).base32Decode(enrol.body.secret),
      );

      const confirm = await request(server)
        .post('/api/v1/auth/mfa/enrol/confirm')
        .send({
          challengeToken: login.body.challengeToken,
          code: totpCode(secret, currentTotpStep()),
        })
        .expect(200);

      expect(confirm.body.recoveryCodes).toHaveLength(10);
      expect(authResultSchema.safeParse(confirm.body.auth).success).toBe(true);
      expect(extractCookie(confirm, 'bf_refresh')).toBeDefined();

      await request(server)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${confirm.body.auth.accessToken}`)
        .expect(200);
    });

    it('re-calling /auth/mfa/enrol before confirmation REPLACES the pending secret', async () => {
      const { userId } = await createLoginableUser({
        email: 'restart@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      const server = app.getHttpServer();
      const login = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'restart@bevorasg.com', password: PASSWORD })
        .expect(200);

      const first = await request(server)
        .post('/api/v1/auth/mfa/enrol')
        .send({ challengeToken: login.body.challengeToken })
        .expect(200);
      const second = await request(server)
        .post('/api/v1/auth/mfa/enrol')
        .send({ challengeToken: login.body.challengeToken })
        .expect(200);

      expect(second.body.secret).not.toBe(first.body.secret);
      expect((await userRow(userId)).mfa_enrolled).toBe(false);

      const { base32Decode } = await import('../../src/auth/mfa/base32');
      // The ABANDONED secret no longer works...
      await request(server)
        .post('/api/v1/auth/mfa/enrol/confirm')
        .send({
          challengeToken: login.body.challengeToken,
          code: totpCode(base32Decode(first.body.secret), currentTotpStep()),
        })
        .expect(401);
      // ...and the current one does.
      await request(server)
        .post('/api/v1/auth/mfa/enrol/confirm')
        .send({
          challengeToken: login.body.challengeToken,
          code: totpCode(base32Decode(second.body.secret), currentTotpStep()),
        })
        .expect(200);
    });

    it('an ALREADY-ENROLLED user cannot re-enrol on a challenge token (a stolen password must not swap the authenticator)', async () => {
      const { userId } = await createLoginableUser({
        email: 'noreenrol@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, randomBytes(20));

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'noreenrol@bevorasg.com', password: PASSWORD })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/enrol')
        .send({ challengeToken: login.body.challengeToken })
        .expect(409);
      expect(res.body).toMatchObject({ type: '/errors/mfa-already-enrolled' });
    });

    it('writes an mfa_enrolled audit event in the same transaction, with no code in the payload', async () => {
      const { userId } = await createLoginableUser({
        email: 'audit-enrol@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      const server = app.getHttpServer();
      const login = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'audit-enrol@bevorasg.com', password: PASSWORD })
        .expect(200);
      const enrol = await request(server)
        .post('/api/v1/auth/mfa/enrol')
        .send({ challengeToken: login.body.challengeToken })
        .expect(200);
      const { base32Decode } = await import('../../src/auth/mfa/base32');
      const confirm = await request(server)
        .post('/api/v1/auth/mfa/enrol/confirm')
        .send({
          challengeToken: login.body.challengeToken,
          code: totpCode(base32Decode(enrol.body.secret), currentTotpStep()),
        })
        .expect(200);

      expect(await auditActions(userId)).toContain('mfa_enrolled');

      const { rows } = await adminPool.query(
        `SELECT "after"::text AS after FROM "audit_event" WHERE "action" = 'mfa_enrolled'`,
      );
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].after).recoveryCodesIssued).toBe(10);
      expect(rows[0].after).not.toContain(enrol.body.secret);
      for (const code of confirm.body.recoveryCodes as string[]) {
        expect(rows[0].after).not.toContain(code);
      }
    });

    it('never stores the TOTP secret in cleartext — mfa_secret_ct is AES-GCM ciphertext', async () => {
      const { userId } = await createLoginableUser({
        email: 'ciphertext@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'ciphertext@bevorasg.com', password: PASSWORD })
        .expect(200);
      const enrol = await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/enrol')
        .send({ challengeToken: login.body.challengeToken })
        .expect(200);

      const stored: Buffer = (await userRow(userId)).mfa_secret_ct;
      expect(stored).toBeInstanceOf(Buffer);
      expect(stored.toString('utf8')).not.toContain(enrol.body.secret);
      // 12-byte nonce + 32 bytes of base32 text + 16-byte tag.
      expect(stored.length).toBe(12 + 32 + 16);
    });

    // ----------------------------------------------------- recovery codes
    it('S-40 a recovery code authenticates once, and is refused the second time', async () => {
      const { userId } = await createLoginableUser({
        email: 'recovery@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, randomBytes(20));
      const code = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH';
      await seedRecoveryCodes(userId, [code]);
      const server = app.getHttpServer();

      const first = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'recovery@bevorasg.com', password: PASSWORD })
        .expect(200);
      const redeemed = await request(server)
        .post('/api/v1/auth/mfa/recovery')
        .send({ challengeToken: first.body.challengeToken, code })
        .expect(200);
      expect(authResultSchema.safeParse(redeemed.body).success).toBe(true);
      expect(await auditActions(userId)).toContain('mfa_recovery_code_used');

      // The row is MARKED used, never deleted (INV-07/INV-16).
      const { rows } = await adminPool.query(
        `SELECT "used_at" FROM "mfa_recovery_code" WHERE "user_id" = $1`,
        [userId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].used_at).not.toBeNull();

      const second = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: 'recovery@bevorasg.com', password: PASSWORD })
        .expect(200);
      await request(server)
        .post('/api/v1/auth/mfa/recovery')
        .send({ challengeToken: second.body.challengeToken, code })
        .expect(401);
    });

    it('accepts a recovery code retyped in lowercase with spaces instead of hyphens', async () => {
      const { userId } = await createLoginableUser({
        email: 'retype@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, randomBytes(20));
      const code = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH';
      await seedRecoveryCodes(userId, [code]);

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'retype@bevorasg.com', password: PASSWORD })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/recovery')
        .send({
          challengeToken: login.body.challengeToken,
          code: 'aaaa bbbb cccc dddd eeee ffff gggg hhhh',
        })
        .expect(200);
    });

    it("S-41 another user's recovery code does not authenticate this account", async () => {
      const victim = await createLoginableUser({
        email: 'victim@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      const attacker = await createLoginableUser({
        email: 'attacker@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(victim.userId, randomBytes(20));
      await enrolMfaForUser(attacker.userId, randomBytes(20));
      const victimCode = 'ZZZZ-YYYY-XXXX-WWWW-VVVV-UUUU-TTTT-SSSS';
      await seedRecoveryCodes(victim.userId, [victimCode]);

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'attacker@bevorasg.com', password: PASSWORD })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/recovery')
        .send({ challengeToken: login.body.challengeToken, code: victimCode })
        .expect(401);

      // The victim's code is still unused and still works for the victim.
      const victimLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'victim@bevorasg.com', password: PASSWORD })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/recovery')
        .send({ challengeToken: victimLogin.body.challengeToken, code: victimCode })
        .expect(200);
    });

    it('a wrong recovery code feeds the account-lockout counter', async () => {
      const { userId } = await createLoginableUser({
        email: 'recovery-lockout@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(userId, randomBytes(20));

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'recovery-lockout@bevorasg.com', password: PASSWORD })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/mfa/recovery')
        .send({
          challengeToken: login.body.challengeToken,
          code: 'QQQQ-QQQQ-QQQQ-QQQQ-QQQQ-QQQQ-QQQQ-QQQQ',
        })
        .expect(401);
      expect((await userRow(userId)).failed_login_count).toBe(1);
    });
  });

  // =====================================================================
  describe('S-42 ADMIN MFA reset (POST /users/{userId}/mfa-reset)', () => {
    async function adminToken(): Promise<string> {
      await createLoginableUser({
        email: 'resetter@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'resetter@bevorasg.com', password: PASSWORD })
        .expect(200);
      return res.body.accessToken;
    }

    it('clears the enrolment, invalidates unused recovery codes (marking, not deleting) and audits', async () => {
      const token = await adminToken();
      const subject = await createLoginableUser({
        email: 'subject@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['TEAM_LEADER'],
      });
      await enrolMfaForUser(subject.userId, randomBytes(20));
      await seedRecoveryCodes(subject.userId, [
        'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH',
        'IIII-JJJJ-KKKK-LLLL-MMMM-NNNN-OOOO-PPPP',
      ]);

      await request(app.getHttpServer())
        .post(`/api/v1/users/${subject.userId}/mfa-reset`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const user = await userRow(subject.userId);
      expect(user.mfa_enrolled).toBe(false);
      expect(user.mfa_secret_ct).toBeNull();
      expect(user.mfa_secret_dek_version).toBeNull();
      expect(user.mfa_last_used_step).toBeNull();

      const { rows } = await adminPool.query(
        `SELECT "used_at" FROM "mfa_recovery_code" WHERE "user_id" = $1`,
        [subject.userId],
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((row: { used_at: Date | null }) => row.used_at !== null)).toBe(true);

      const { rows: events } = await adminPool.query(
        `SELECT "actor_id", "entity_id" FROM "audit_event" WHERE "action" = 'mfa_reset'`,
      );
      expect(events).toHaveLength(1);
      expect(events[0].entity_id).toBe(subject.userId);
      expect(events[0].actor_id).not.toBe(subject.userId);
    });

    it('a reset user is challenged with mfaEnrolled:false and must enrol again', async () => {
      // The admin signs in BEFORE the flag goes on — with it on, this ADMIN
      // would itself be challenged and never receive an access token.
      const token = await adminToken();
      const subject = await createLoginableUser({
        email: 'reenrol@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ENGINEER'],
      });
      await enrolMfaForUser(subject.userId, randomBytes(20));

      await request(app.getHttpServer())
        .post(`/api/v1/users/${subject.userId}/mfa-reset`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      process.env.MFA_ENABLED = 'true';
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'reenrol@bevorasg.com', password: PASSWORD })
        .expect(200);
      expect(login.body).toMatchObject({ mfaRequired: true, mfaEnrolled: false });
    });

    it('a non-ADMIN is refused (403) — the reset is not self-service', async () => {
      await createLoginableUser({
        email: 'notadmin@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['TEAM_LEADER'],
      });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'notadmin@bevorasg.com', password: PASSWORD })
        .expect(200);
      const victim = await createLoginableUser({
        email: 'reset-victim@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await enrolMfaForUser(victim.userId, randomBytes(20));

      await request(app.getHttpServer())
        .post(`/api/v1/users/${victim.userId}/mfa-reset`)
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(403);
      expect((await userRow(victim.userId)).mfa_enrolled).toBe(true);
    });

    it('is refused without any token at all (deny-by-default)', async () => {
      const victim = await createLoginableUser({
        email: 'anon-reset@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await request(app.getHttpServer())
        .post(`/api/v1/users/${victim.userId}/mfa-reset`)
        .expect(401);
    });
  });
});
