import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createLoginableUser, setMustChangePassword } from './helpers/auth-fixtures';
import { createTestApp } from './helpers/app';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { closeRedis, resetRedis } from './helpers/redis';

const PASSWORD = 'CorrectHorseBattery1!';
const NEW_PASSWORD = 'AnEntirelyDifferent9!';

function extractCookie(res: request.Response, name: string): string | undefined {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  return setCookie?.find((cookie) => cookie.startsWith(`${name}=`));
}

async function userRow(userId: string) {
  const { rows } = await adminPool.query(`SELECT * FROM "app_user" WHERE "id" = $1`, [userId]);
  return rows[0];
}

/**
 * Slice 13-MFA §7 — password self-service and the forced-change gate, the
 * slice-13a hole where an ADMIN chose a user's password and then knew that
 * user's credential forever. Under ISO 13485 that makes signature attribution
 * indefensible, so this is a compliance fix as much as a security one.
 */
describe('Slice 13-MFA §7 — POST /auth/password and the forced-change gate', () => {
  let app: INestApplication;
  const originalForceFlag = process.env.FORCE_PASSWORD_CHANGE_ENABLED;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    process.env.FORCE_PASSWORD_CHANGE_ENABLED = originalForceFlag;
    await app.close();
    await closeAll();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
    delete process.env.MFA_ENABLED;
    // Default OFF for every test, exactly as production defaults it
    // (review finding I-3). Tests that need the forcing turn it on
    // explicitly, the way the MFA suite turns on MFA_ENABLED.
    delete process.env.FORCE_PASSWORD_CHANGE_ENABLED;
  });

  async function signIn(email: string): Promise<{ accessToken: string; refreshCookie: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      accessToken: res.body.accessToken,
      refreshCookie: extractCookie(res, 'bf_refresh') as string,
    };
  }

  // ---------------------------------------------------------- the change
  describe('changing your own password', () => {
    it('replaces the password, stamps password_changed_at and audits it', async () => {
      const { userId } = await createLoginableUser({
        email: 'change@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['MAINTAINER'],
      });
      const { accessToken } = await signIn('change@bevorasg.com');

      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);

      const user = await userRow(userId);
      expect(user.password_changed_at).not.toBeNull();

      // The old password no longer works; the new one does.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'change@bevorasg.com', password: PASSWORD })
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'change@bevorasg.com', password: NEW_PASSWORD })
        .expect(200);

      const { rows } = await adminPool.query(
        `SELECT "actor_id", "entity_id", "after"::text AS after
           FROM "audit_event" WHERE "action" = 'password_changed'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(userId);
      expect(rows[0].entity_id).toBe(userId);
      // No password material in the audit payload.
      expect(rows[0].after).not.toContain(PASSWORD);
      expect(rows[0].after).not.toContain(NEW_PASSWORD);
    });

    it('rejects a wrong current password (401) and does not change anything', async () => {
      await createLoginableUser({
        email: 'wrongcurrent@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['MAINTAINER'],
      });
      const { accessToken } = await signIn('wrongcurrent@bevorasg.com');

      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'NotThePassword1!', newPassword: NEW_PASSWORD })
        .expect(401);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'wrongcurrent@bevorasg.com', password: PASSWORD })
        .expect(200);
    });

    it('a wrong current password does NOT lock the account — a stolen token must not be a DoS', async () => {
      const { userId } = await createLoginableUser({
        email: 'nolock@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['MAINTAINER'],
      });
      const { accessToken } = await signIn('nolock@bevorasg.com');

      for (let attempt = 0; attempt < 6; attempt += 1) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/password')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ currentPassword: 'NotThePassword1!', newPassword: NEW_PASSWORD })
          .expect(401);
      }

      const user = await userRow(userId);
      expect(user.failed_login_count).toBe(0);
      expect(user.locked_until).toBeNull();
    });

    it('enforces the 12-character minimum (422), the same policy as /auth/login and POST /users', async () => {
      await createLoginableUser({
        email: 'short@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['MAINTAINER'],
      });
      const { accessToken } = await signIn('short@bevorasg.com');

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: 'short1!' })
        .expect(422);
      expect(res.body).toMatchObject({ type: '/errors/validation-failed' });
    });

    it('is refused without a token (deny-by-default) — and cannot target another account', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(401);
    });

    it('S-44 revokes every OTHER refresh-token family, keeping the caller’s own session alive', async () => {
      const { userId } = await createLoginableUser({
        email: 'sessions@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['MAINTAINER'],
      });
      // Three separate logins = three separate rotation families.
      const deviceA = await signIn('sessions@bevorasg.com');
      const deviceB = await signIn('sessions@bevorasg.com');
      const deviceC = await signIn('sessions@bevorasg.com');

      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${deviceC.accessToken}`)
        .set('Cookie', deviceC.refreshCookie)
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);

      // A and B can no longer refresh...
      for (const device of [deviceA, deviceB]) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .set('Cookie', device.refreshCookie)
          .expect(401);
      }
      // ...C still can.
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', deviceC.refreshCookie)
        .expect(200);

      const { rows } = await adminPool.query(
        `SELECT "revoked_reason" FROM "refresh_token"
          WHERE "user_id" = $1 AND "revoked_at" IS NOT NULL`,
        [userId],
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(
        rows.every((row: { revoked_reason: string }) => row.revoked_reason === 'password_changed'),
      ).toBe(true);
    });

    it('revokes ALL families when the caller presents no refresh cookie (fail closed)', async () => {
      await createLoginableUser({
        email: 'nocookie@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['MAINTAINER'],
      });
      const device = await signIn('nocookie@bevorasg.com');

      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${device.accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);

      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', device.refreshCookie)
        .expect(401);
    });

    it('rate-limits at 10/min per user', async () => {
      await createLoginableUser({
        email: 'pwratelimit@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['MAINTAINER'],
      });
      const { accessToken } = await signIn('pwratelimit@bevorasg.com');

      let last = 0;
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/password')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ currentPassword: 'NotThePassword1!', newPassword: NEW_PASSWORD });
        last = res.status;
      }
      expect(last).toBe(429);
    });
  });

  // -------------------------------------------------- the forced-change gate
  describe('S-43 must_change_password gate', () => {
    it('POST /users creates the user with must_change_password = true when the flag is ON', async () => {
      process.env.FORCE_PASSWORD_CHANGE_ENABLED = 'true';
      await createLoginableUser({
        email: 'creator@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      const { accessToken } = await signIn('creator@bevorasg.com');

      const created = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          fullName: 'New Starter',
          email: 'newstarter@bevorasg.com',
          password: 'AdminChose_This1!',
          roleCodes: ['MAINTAINER'],
        })
        .expect(201);

      expect((await userRow(created.body.id)).must_change_password).toBe(true);
      // ...and the flag is never leaked in the User response shape.
      expect(created.body.mustChangePassword).toBeUndefined();
    });

    it('an EXISTING user is untouched — no back-fill flips the live admin into the gate', async () => {
      const { userId } = await createLoginableUser({
        email: 'existing@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      expect((await userRow(userId)).must_change_password).toBe(false);

      const { accessToken } = await signIn('existing@bevorasg.com');
      await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });

    // =====================================================================
    // S-47 — the SECOND deployment-safety property (review finding I-3).
    // The password-change screen lands in slice 13-UI, exactly as the MFA
    // screens do. If `POST /users` forced the change before that screen
    // existed, the first technician created after deploy would log in fine
    // and then get 403 on every page with no way out. Same hazard as
    // MFA_ENABLED, same default-off master switch, same both-directions
    // proof as S-38.
    // =====================================================================
    describe('S-47 FORCE_PASSWORD_CHANGE_ENABLED gates the forcing, default OFF', () => {
      const ADMIN_CHOSE = 'AdminChose_This1!';

      async function createStarter(email: string): Promise<string> {
        await createLoginableUser({
          email: 'flag-admin@bevorasg.com',
          password: PASSWORD,
          roleCodes: ['ADMIN'],
        });
        const admin = await signIn('flag-admin@bevorasg.com');
        const created = await request(app.getHttpServer())
          .post('/api/v1/users')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({
            fullName: 'New Starter',
            email,
            password: ADMIN_CHOSE,
            roleCodes: ['TEAM_LEADER'],
          })
          .expect(201);
        return created.body.id as string;
      }

      it('flag ABSENT: the new user is NOT forced, and really reaches a normal endpoint', async () => {
        const id = await createStarter('unforced@bevorasg.com');
        expect((await userRow(id)).must_change_password).toBe(false);

        const login = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: 'unforced@bevorasg.com', password: ADMIN_CHOSE })
          .expect(200);

        // Non-vacuous: not "login returned 200", but "a real, guarded,
        // non-allowlisted endpoint actually served this user".
        const jobs = await request(app.getHttpServer())
          .get('/api/v1/jobs')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .expect(200);
        expect(Array.isArray(jobs.body.data)).toBe(true);
        await request(app.getHttpServer())
          .get('/api/v1/assets')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .expect(200);
      });

      it('flag ON: the same user IS forced, and is blocked until they change it', async () => {
        process.env.FORCE_PASSWORD_CHANGE_ENABLED = 'true';
        const id = await createStarter('forced-by-flag@bevorasg.com');
        expect((await userRow(id)).must_change_password).toBe(true);

        const login = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: 'forced-by-flag@bevorasg.com', password: ADMIN_CHOSE })
          .expect(200);

        const blocked = await request(app.getHttpServer())
          .get('/api/v1/jobs')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .expect(403);
        expect(blocked.body).toMatchObject({ type: '/errors/password-change-required' });

        await request(app.getHttpServer())
          .post('/api/v1/auth/password')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .send({ currentPassword: ADMIN_CHOSE, newPassword: NEW_PASSWORD })
          .expect(204);
        await request(app.getHttpServer())
          .get('/api/v1/jobs')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .expect(200);
      });

      it('only the literal "true" turns it on — no truthy coercion, same strictness as MFA_ENABLED', async () => {
        const off = ['false', '0', '1', 'yes', 'on', 'TRUE ', ''];
        for (const [index, value] of off.entries()) {
          await resetDatabase();
          await resetRedis();
          process.env.FORCE_PASSWORD_CHANGE_ENABLED = value;
          const id = await createStarter(`coerce-off-${index}@bevorasg.com`);
          expect([value, (await userRow(id)).must_change_password]).toEqual([value, false]);
        }
        // ...and the exact literal, in either case, does.
        const on = ['true', 'TRUE', 'True'];
        for (const [index, value] of on.entries()) {
          await resetDatabase();
          await resetRedis();
          process.env.FORCE_PASSWORD_CHANGE_ENABLED = value;
          const id = await createStarter(`coerce-on-${index}@bevorasg.com`);
          expect([value, (await userRow(id)).must_change_password]).toEqual([value, true]);
        }
      });

      it('the guard itself is NOT gated — a row that already carries the flag is still blocked with the switch off', async () => {
        // Gating the SETTING and not the GUARD is deliberate: deny-by-default
        // must never be dormant.
        const { userId } = await createLoginableUser({
          email: 'preset@bevorasg.com',
          password: PASSWORD,
          roleCodes: ['ADMIN'],
        });
        await setMustChangePassword(userId, true);
        expect(process.env.FORCE_PASSWORD_CHANGE_ENABLED).toBeUndefined();

        const { accessToken } = await signIn('preset@bevorasg.com');
        const blocked = await request(app.getHttpServer())
          .get('/api/v1/jobs')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(403);
        expect(blocked.body).toMatchObject({ type: '/errors/password-change-required' });
      });
    });

    it('a forced-change user can still authenticate and reach exactly the three allowlisted endpoints', async () => {
      const { userId } = await createLoginableUser({
        email: 'forced@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await setMustChangePassword(userId, true);

      const { accessToken } = await signIn('forced@bevorasg.com');

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);

      // logout is allowlisted too — verified with a FRESH session, since the
      // change above revoked nothing of this one but did clear the gate.
      const second = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'forced@bevorasg.com', password: NEW_PASSWORD })
        .expect(200);
      await setMustChangePassword(userId, true);
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${second.body.accessToken}`)
        .expect(204);
    });

    it.each([
      ['GET', '/api/v1/users'],
      ['GET', '/api/v1/jobs'],
      ['GET', '/api/v1/assets'],
      ['GET', '/api/v1/areas'],
      ['GET', '/api/v1/queue'],
      ['GET', '/api/v1/roles'],
      ['GET', '/api/v1/sync/bootstrap'],
    ])(
      'blocks %s %s with 403 /errors/password-change-required (deny-by-default)',
      async (method, path) => {
        const { userId } = await createLoginableUser({
          email: 'blocked@bevorasg.com',
          password: PASSWORD,
          roleCodes: ['ADMIN'],
        });
        await setMustChangePassword(userId, true);
        const { accessToken } = await signIn('blocked@bevorasg.com');

        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${accessToken}`);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ type: '/errors/password-change-required' });
      },
    );

    it('blocks a RECORD-MUTATING endpoint, not merely reads', async () => {
      const { userId } = await createLoginableUser({
        email: 'mutator@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await setMustChangePassword(userId, true);
      const { accessToken } = await signIn('mutator@bevorasg.com');

      const res = await request(app.getHttpServer())
        .post('/api/v1/areas')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: 'BLOCKED', name: 'Should never be created' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ type: '/errors/password-change-required' });

      const { rows } = await adminPool.query(`SELECT 1 FROM "area" WHERE "code" = 'BLOCKED'`);
      expect(rows).toHaveLength(0);
    });

    it('changing the password clears the gate and the user is immediately unblocked', async () => {
      const { userId } = await createLoginableUser({
        email: 'unblock@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      await setMustChangePassword(userId, true);
      const { accessToken } = await signIn('unblock@bevorasg.com');

      await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);

      expect((await userRow(userId)).must_change_password).toBe(false);
      // The SAME access token now works — the gate is read from the database,
      // not carried as a token claim, so it cannot go stale for 15 minutes.
      await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });

    it('the full admin-creates-user journey: created, blocked, changes password, unblocked', async () => {
      process.env.FORCE_PASSWORD_CHANGE_ENABLED = 'true';
      await createLoginableUser({
        email: 'admin2@bevorasg.com',
        password: PASSWORD,
        roleCodes: ['ADMIN'],
      });
      const admin = await signIn('admin2@bevorasg.com');
      const ADMIN_CHOSE = 'AdminChose_This1!';

      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          fullName: 'Fresh Starter',
          email: 'fresh@bevorasg.com',
          password: ADMIN_CHOSE,
          roleCodes: ['TEAM_LEADER'],
        })
        .expect(201);

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'fresh@bevorasg.com', password: ADMIN_CHOSE })
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/v1/jobs')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .post('/api/v1/auth/password')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ currentPassword: ADMIN_CHOSE, newPassword: NEW_PASSWORD })
        .expect(204);

      await request(app.getHttpServer())
        .get('/api/v1/jobs')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(200);

      // The password the ADMIN knows is dead.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'fresh@bevorasg.com', password: ADMIN_CHOSE })
        .expect(401);
    });
  });
});
