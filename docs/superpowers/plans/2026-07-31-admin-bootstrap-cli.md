# First-ADMIN Bootstrap CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-time, operator-run CLI that safely creates the first ADMIN account on an empty system, unblocking login/UAT/onboarding.

**Architecture:** One new service method `UsersService.bootstrapFirstAdmin(dto)` holds all logic (reusing the existing Argon2id hashing, field encryption, blind-index and audit path). A thin standalone Nest entrypoint `api/src/bootstrap-admin.ts` (pattern copied from `api/src/worker.ts`) prompts the operator, calls the method, and exits. The method is fail-closed: it refuses if any user already exists, and grants the ADMIN role self-attributed (`granted_by = the new admin's own id`) because `user_role.granted_by` is NOT NULL.

**Tech Stack:** NestJS standalone application context, Prisma (Postgres 16), Argon2id via the existing `PasswordService`, Jest integration tests, Node `readline`/`node:tty` for the interactive prompt.

## Global Constraints

- Node 22 only. NEVER regenerate the lockfile — if a worktree lacks `node_modules`, run `npm ci` (installs from the existing lockfile). NEVER `npm install`.
- Work from the `~/dev/wt-admin-bootstrap` worktree (branch `feat/admin-bootstrap`), never the Desktop copy.
- Non-negotiable #7: no physical DELETE on record tables. (This plan only INSERTs; nothing to delete.)
- The bootstrap must be strictly one-time: it MUST refuse when any `app_user` row exists, and that guard must be inside the same transaction that would create the user (race safety), not only a pre-check.
- The password is NEVER a CLI argument, env var, file, or log line — only ever read from an interactive prompt with terminal echo disabled.
- Reuse the existing crypto path exactly as `UsersService.create` does (`passwordService.hash`, `computeEmailBlindIndex`, `encodeIdentityField`, `toBytes`) — do NOT hand-roll hashing or encryption, or the row will not be a valid, loginable account.
- Password policy matches the API: `password` min length **12**, `email` a valid email, `fullName` non-empty (from `userCreateSchema` in `shared/src/user.ts`).
- Integration tests run with the repo's env: `DATABASE_URL`, `REDIS_URL`, `MINIO_ENDPOINT` set (loopback test containers), and `--forceExit` (the suite leaks handles and hangs otherwise). Command: `cd api && npm run test:integration -- <pattern> --forceExit`.

## File structure

- Modify: `api/src/users/users.service.ts` — add `bootstrapFirstAdmin(dto)` (and export the `BootstrapAdminInput` type).
- Create: `api/test/integration/admin-bootstrap.spec.ts` — integration tests for the method.
- Create: `api/src/bootstrap-admin.ts` — the CLI entrypoint.
- Modify: `api/package.json` — add the `bootstrap:admin` script.

---

### Task 1: `UsersService.bootstrapFirstAdmin` (core logic + fail-closed guard)

**Files:**
- Modify: `api/src/users/users.service.ts` (add the method after `create`, ~line 210; add the `BootstrapAdminInput` interface near `ListUsersParams`, ~line 23)
- Test: `api/test/integration/admin-bootstrap.spec.ts` (new)

**Interfaces:**
- Produces: `export interface BootstrapAdminInput { fullName: string; email: string; password: string }` and `UsersService.bootstrapFirstAdmin(dto: BootstrapAdminInput): Promise<User>`. Creates one `app_user` with role `ADMIN`, `granted_by` = its own id, `must_change_password = false`; records a `create` audit event with `actorId` = the new user's id; returns the `User` DTO. Throws a plain `Error` (message starting `Bootstrap refused:`) if any `app_user` already exists.
- Consumes: existing private `rolesByCode`, and the injected `passwordService`, `blindIndexKey`, `fieldEncryption`, `audit`, `prisma`. Helpers already imported in the file: `computeEmailBlindIndex`, `encodeIdentityField`, `toBytes`, `toUser`, `toUserAuditView`, `uuidv7`, `AuditActionT`, `UserStatusT`.

- [ ] **Step 1: Write the failing tests** — `api/test/integration/admin-bootstrap.spec.ts`:

```ts
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createTestApp } from './helpers/app';
import { closeRedis, resetRedis } from './helpers/redis';
import { UsersService } from '../../src/users/users.service';
import { PasswordService } from '../../src/auth/password/password.service';

describe('First-ADMIN bootstrap — UsersService.bootstrapFirstAdmin', () => {
  let app: INestApplication;
  let users: UsersService;
  let passwords: PasswordService;

  beforeAll(async () => {
    app = await createTestApp();
    users = app.get(UsersService);
    passwords = app.get(PasswordService);
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

  const input = () => ({
    fullName: 'Boot Strap',
    email: `admin-${randomUUID()}@example.com`,
    password: 'correct horse battery',
  });

  it('creates the first admin on an empty system, with the ADMIN role', async () => {
    const dto = input();
    const created = await users.bootstrapFirstAdmin(dto);
    expect(created.email).toBe(dto.email);
    expect(created.roles).toContain('ADMIN');
  });

  it('creates an account whose password actually verifies (can log in)', async () => {
    const dto = input();
    const created = await users.bootstrapFirstAdmin(dto);
    const { rows } = await adminPool.query(
      `SELECT "password_hash" FROM "app_user" WHERE "id" = $1`,
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(await passwords.verify(rows[0].password_hash, dto.password)).toBe(true);
  });

  it('self-grants the ADMIN role (granted_by = the new admin\'s own id)', async () => {
    const created = await users.bootstrapFirstAdmin(input());
    const { rows } = await adminPool.query(
      `SELECT ur."granted_by", r."code"
         FROM "user_role" ur JOIN "role" r ON r."id" = ur."role_id"
        WHERE ur."user_id" = $1 AND ur."active" = true`,
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('ADMIN');
    expect(rows[0].granted_by).toBe(created.id);
  });

  it('does NOT force a password change (operator chose their own password)', async () => {
    const created = await users.bootstrapFirstAdmin(input());
    const { rows } = await adminPool.query(
      `SELECT "must_change_password" FROM "app_user" WHERE "id" = $1`,
      [created.id],
    );
    expect(rows[0].must_change_password).toBe(false);
  });

  it('records a create audit event for the new admin', async () => {
    const created = await users.bootstrapFirstAdmin(input());
    const { rows } = await adminPool.query(
      `SELECT count(*)::int AS n FROM "audit_event"
        WHERE "entity_type" = 'user' AND "entity_id" = $1 AND "action" = 'create'`,
      [created.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('refuses when any user already exists, and writes nothing', async () => {
    await users.bootstrapFirstAdmin(input());
    const { rows: before } = await adminPool.query(`SELECT count(*)::int AS n FROM "app_user"`);
    await expect(users.bootstrapFirstAdmin(input())).rejects.toThrow(/Bootstrap refused/);
    const { rows: after } = await adminPool.query(`SELECT count(*)::int AS n FROM "app_user"`);
    expect(after[0].n).toBe(before[0].n);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `cd api && npm run test:integration -- admin-bootstrap --forceExit`. Expected: FAIL (`users.bootstrapFirstAdmin is not a function`).

- [ ] **Step 3: Implement.** In `api/src/users/users.service.ts`, add the interface near `ListUsersParams` (~line 23):

```ts
export interface BootstrapAdminInput {
  fullName: string;
  email: string;
  password: string;
}
```

Add the method after `create` (after its closing brace, ~line 210):

```ts
  /**
   * One-time first-ADMIN bootstrap (design 2026-07-31). BamForm seeds roles
   * but no users, and `POST /users` needs an ADMIN — so a fresh system has
   * no way to make its first account. This is the only path that creates a
   * user with no acting admin, run once by an operator via
   * `dist/bootstrap-admin.js`.
   *
   * Fail-closed: refuses if ANY user exists (checked inside the tx, so it
   * cannot race a concurrent create), which makes it strictly one-time and
   * never a privilege-injection path. The ADMIN role is self-attributed
   * (`granted_by = the new user's own id`) because `user_role.granted_by`
   * is NOT NULL and there is no external actor. `must_change_password` is
   * false: the operator chose this password at a prompt, so the
   * admin-known-temporary-credential rationale (see `create`) does not apply.
   *
   * Reuses the exact crypto path `create` uses so the row is a valid,
   * loginable account; assumes `dto` is already validated by the caller
   * (the CLI validates against the same policy as `userCreateSchema`).
   */
  async bootstrapFirstAdmin(dto: BootstrapAdminInput): Promise<User> {
    const roles = await this.rolesByCode(['ADMIN']);

    const userId = uuidv7();
    const passwordHash = await this.passwordService.hash(dto.password);
    const emailBidx = computeEmailBlindIndex(dto.email, this.blindIndexKey);
    const fullName = encodeIdentityField(
      dto.fullName,
      { column: 'full_name_ct', rowId: userId },
      this.fieldEncryption,
    );
    const email = encodeIdentityField(
      dto.email,
      { column: 'email_ct', rowId: userId },
      this.fieldEncryption,
    );

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.appUser.count();
      if (existing > 0) {
        throw new Error(
          `Bootstrap refused: ${existing} user(s) already exist. ` +
            'The first-admin bootstrap only runs on an empty system.',
        );
      }

      const row = await tx.appUser.create({
        data: {
          id: userId,
          fullNameCt: toBytes(fullName.ciphertext),
          emailCt: toBytes(email.ciphertext),
          emailBidx: toBytes(emailBidx),
          passwordHash,
          mustChangePassword: false,
          dekVersion: fullName.dekVersion,
          status: UserStatusT.active,
        },
      });

      await tx.userRole.create({
        // Self-grant: no external actor exists for the very first user.
        data: { userId: row.id, roleId: roles[0].id, grantedBy: row.id },
      });

      const withRoles: AppUserWithRoles = {
        ...row,
        userRoles: [
          {
            userId: row.id,
            roleId: roles[0].id,
            grantedBy: row.id,
            grantedAt: new Date(),
            active: true,
            role: roles[0],
          },
        ],
        userAreaScopes: [],
      };
      const after = toUser(withRoles, this.fieldEncryption);

      await this.audit.record(tx, {
        actorId: row.id,
        action: AuditActionT.create,
        entityType: 'user',
        entityId: row.id,
        after: toUserAuditView(withRoles),
      });

      return after;
    });
  }
```

(Note: `this.audit.record`'s `sourceIp`/`requestId` are optional — omit them; there is no request context. Confirm `RecordAuditEventParams` marks them optional; if not, pass `undefined`.)

- [ ] **Step 4: Run, verify pass** — `cd api && npm run test:integration -- admin-bootstrap --forceExit`. Expected: all 6 PASS. Also typecheck: `npm run typecheck`.

- [ ] **Step 5: Commit** — `git add api/src/users/users.service.ts api/test/integration/admin-bootstrap.spec.ts && git commit -m "feat(users): first-ADMIN bootstrap service method (one-time, fail-closed)"`

---

### Task 2: `bootstrap-admin.ts` CLI entrypoint + npm script

**Files:**
- Create: `api/src/bootstrap-admin.ts`
- Modify: `api/package.json` (add `bootstrap:admin`)

**Interfaces:**
- Consumes: `UsersService.bootstrapFirstAdmin` and `BootstrapAdminInput` from Task 1; `AppModule`; `userCreateSchema` from `@bamform/shared` for validation.
- Produces: a runnable `dist/bootstrap-admin.js` and `npm run bootstrap:admin`.

- [ ] **Step 1: Implement the CLI.** Create `api/src/bootstrap-admin.ts`:

```ts
import 'reflect-metadata';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { AppModule } from './app.module';
import { RedactingLogger } from './common/logging/redacting-logger';
import { UsersService } from './users/users.service';

/**
 * `bamform-bootstrap-admin` entrypoint (`dist/bootstrap-admin.js`). One-time,
 * operator-run: creates the first ADMIN on an empty system so the app can be
 * logged into. Design 2026-07-31. Reads credentials only from an interactive
 * prompt (never argv/env/logs); all logic and the fail-closed guard live in
 * `UsersService.bootstrapFirstAdmin`.
 */
const inputSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required.'),
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(12, 'Password must be at least 12 characters.'),
});

/** Prompt for a secret with terminal echo disabled (no history, no display). */
async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // Mute the output stream while the answer is typed.
  const muted = { muted: false };
  const realWrite = (stdout.write as unknown as (...a: unknown[]) => boolean).bind(stdout);
  (stdout as unknown as { write: (...a: unknown[]) => boolean }).write = ((chunk: unknown, ...rest: unknown[]) =>
    muted.muted ? true : realWrite(chunk, ...rest)) as never;
  stdout.write(question);
  muted.muted = true;
  try {
    const answer = await rl.question('');
    return answer;
  } finally {
    muted.muted = false;
    (stdout as unknown as { write: unknown }).write = realWrite;
    stdout.write('\n');
    rl.close();
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new RedactingLogger(),
  });
  try {
    const rl = createInterface({ input: stdin, output: stdout });
    const fullName = (await rl.question('Full name: ')).trim();
    const email = (await rl.question('Email: ')).trim();
    rl.close();
    const password = await promptHidden('Password (min 12 chars, hidden): ');
    const confirm = await promptHidden('Confirm password: ');

    if (password !== confirm) {
      console.error('Error: passwords do not match.');
      process.exitCode = 1;
      return;
    }

    const parsed = inputSchema.safeParse({ fullName, email, password });
    if (!parsed.success) {
      console.error('Error: ' + parsed.error.issues.map((i) => i.message).join(' '));
      process.exitCode = 1;
      return;
    }

    const users = app.get(UsersService);
    const created = await users.bootstrapFirstAdmin(parsed.data);
    console.log(`\nCreated ADMIN account: ${created.email} (id ${created.id}).`);
    console.log('You can now sign in with this account and create further users in the app.');
  } catch (error) {
    console.error(`\nBootstrap failed: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void bootstrap();
```

- [ ] **Step 2: Add the npm script.** In `api/package.json` `"scripts"`, after `"start:dev"`, add:

```json
    "bootstrap:admin": "node dist/bootstrap-admin.js",
```

- [ ] **Step 3: Typecheck and build.** Run `cd api && npm run typecheck` (expect clean) and `npm run build` (expect `dist/bootstrap-admin.js` emitted). Verify: `ls dist/bootstrap-admin.js`.

- [ ] **Step 4: Smoke-verify the guard without a TTY.** The interactive prompt needs a terminal, but the fail-closed path is already covered by Task 1's integration test (`refuses when any user already exists`). Confirm the entrypoint at least wires up and refuses on a non-empty DB by running it against the test DB with input piped in, and confirm it exits non-zero when a user exists (it will read the piped lines; on a seeded-but-userless DB it would create one, so only run this pointed at a DB you intend to bootstrap). Document in the commit message that live creation is operator-run. (No automated test for the prompt layer — it is deliberately thin.)

- [ ] **Step 5: Commit** — `git add api/src/bootstrap-admin.ts api/package.json && git commit -m "feat(cli): bootstrap-admin entrypoint + npm run bootstrap:admin"`

---

## Verification before done

- [ ] `cd api && npm run test:integration -- admin-bootstrap --forceExit` — all green.
- [ ] `cd api && npm run typecheck` clean; `npm run build` emits `dist/bootstrap-admin.js`.
- [ ] Confirm no full-suite regression: `cd api && npm run test:unit` and the contract suite stay green (this change adds a method + an entrypoint; it must not alter existing behaviour).
- [ ] Whole-branch review before merge (per standing flow).

## Self-review notes (author)

- Spec coverage: design §Approach components 1 (service method), 2 (CLI entrypoint), 3 (npm script) each map to a task; the fail-closed guard, self-grant, `must_change_password=false`, audit event, and password-verifies tests all come from design §Testing and are in Task 1. Non-goals (no endpoint/auto-seed/multi-role/reset) are respected — nothing in the plan adds them.
- Type consistency: `BootstrapAdminInput` and `bootstrapFirstAdmin` are defined in Task 1 and consumed identically in Task 2; the audit `entityType` is `'user'` (matching `create`, not the design draft's `'app_user'` — the running code's convention wins).
- The CLI's `promptHidden` mutes stdout while the password is typed; the password never reaches argv, env, or logs. If the muting approach proves brittle across terminals during Task 2, an acceptable equivalent is reading from `node:tty` with `setRawMode` — keep the property (no echo, no history), not the exact mechanism.
