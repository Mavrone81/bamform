import { ConfigService } from '@nestjs/config';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { StepUpGuard } from '../../src/auth/guards/step-up.guard';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createLoginableUser } from './helpers/auth-fixtures';
import { createTestApp } from './helpers/app';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { closeRedis, resetRedis } from './helpers/redis';

function makeContext(userId: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: { sub: userId } }) }),
  } as unknown as ExecutionContext;
}

describe('S-07/S-08 step-up authentication (PR-091, threat S-4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    await closeAll();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it('S-07 rejects with 403 /errors/step-up-required once the window has lapsed', async () => {
    const { userId } = await createLoginableUser({
      email: 's07@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
    });
    // STEP_UP_WINDOW_SECONDS default is 900s (15 min) — 20 minutes ago is stale.
    await adminPool.query(
      `UPDATE "app_user" SET "last_authenticated_at" = now() - interval '20 minutes' WHERE id = $1`,
      [userId],
    );

    const guard = new StepUpGuard(prisma, new ConfigService({}));

    await expect(guard.canActivate(makeContext(userId))).rejects.toMatchObject({
      response: { type: '/errors/step-up-required', status: 403 },
    });
  });

  it('S-08 permits the request once the actor has authenticated within the window', async () => {
    const { userId } = await createLoginableUser({
      email: 's08@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
    });
    await adminPool.query(`UPDATE "app_user" SET "last_authenticated_at" = now() WHERE id = $1`, [
      userId,
    ]);

    const guard = new StepUpGuard(prisma, new ConfigService({}));

    await expect(guard.canActivate(makeContext(userId))).resolves.toBe(true);
  });

  it('S-08 permits the request again after a successful POST /auth/step-up refreshes the window', async () => {
    const { userId } = await createLoginableUser({
      email: 's08b@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
    });
    await adminPool.query(
      `UPDATE "app_user" SET "last_authenticated_at" = now() - interval '20 minutes' WHERE id = $1`,
      [userId],
    );

    const guard = new StepUpGuard(prisma, new ConfigService({}));
    await expect(guard.canActivate(makeContext(userId))).rejects.toMatchObject({
      response: { type: '/errors/step-up-required' },
    });

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 's08b@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    const accessToken = loginRes.body.accessToken as string;

    const stepUpRes = await request(app.getHttpServer())
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: 'CorrectHorseBattery1!' })
      .expect(200);
    expect(new Date(stepUpRes.body.stepUpValidUntil).getTime()).toBeGreaterThan(Date.now());

    await expect(guard.canActivate(makeContext(userId))).resolves.toBe(true);

    const auditRows = await adminPool.query(
      `SELECT after FROM "audit_event" WHERE entity_type = 'app_user' AND after->>'event' = 'step_up_success'`,
    );
    expect(auditRows.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('POST /auth/step-up rejects a wrong password and writes a step_up_failed audit event', async () => {
    const { userId } = await createLoginableUser({
      email: 's08c@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      roleCodes: ['ENGINEER'],
    });
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 's08c@bevorasg.com', password: 'CorrectHorseBattery1!' })
      .expect(200);
    const accessToken = loginRes.body.accessToken as string;

    await request(app.getHttpServer())
      .post('/api/v1/auth/step-up')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: 'definitely-wrong' })
      .expect(401);

    const auditRows = await adminPool.query(
      `SELECT after FROM "audit_event" WHERE entity_type = 'app_user' AND entity_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [userId],
    );
    expect(auditRows.rows[0].after).toMatchObject({ event: 'step_up_failed' });
  });
});
