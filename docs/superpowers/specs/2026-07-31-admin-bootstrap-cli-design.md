# Design — First-ADMIN bootstrap CLI

**Date:** 2026-07-31
**Status:** Approved (brainstorming) — pending implementation plan
**Branch:** `feat/admin-bootstrap` (worktree `~/dev/wt-admin-bootstrap`), off `main` @ `47d5c86`

## Problem

BamForm ships with **no user accounts** and no supported way to create the first one. The seed migration (`20260723180100_seed_reference_data`) creates roles (incl. `ADMIN`) and approval routes but no `app_user` row. The only user-creation path, `POST /api/v1/users`, is gated `@Roles('ADMIN')` — so creating any user, including the first, requires an already-authenticated admin. There is no self-registration, no default admin, and no create-admin script. Result: a fresh deployment cannot be logged into at all, which blocks UAT and production onboarding.

## Goal

A one-time, operator-run command that safely creates the **first ADMIN** account directly against the database, after which the normal in-app admin flow (`POST /api/v1/users`) takes over. Strictly one-time: it must refuse to run once any user exists, so it can never become a privilege-injection path.

## Non-goals (YAGNI)

- No HTTP endpoint (a public first-admin endpoint is network-exposed and a target even when guarded).
- No auto-seed on deploy (would bake a privileged credential into deploy config/env).
- No multi-role bootstrap, no password reset/rotate, no "create another admin". One admin, once. Everything after the first user goes through the existing app.

## Approach

A standalone Nest entrypoint plus one service method, mirroring the existing `worker.ts` pattern.

### Components

1. **`UsersService.bootstrapFirstAdmin(dto)`** — new method on the existing service (which already injects everything needed: `PasswordService`, the email blind-index key, field encryption, Prisma, `AuditEventService`, and role lookup). Keeping the logic here means the Argon2id hashing, identity-field encryption, and blind-index computation are reused from exactly one place, so the created row is valid and login works immediately.

   Behaviour, in a single transaction:
   - **Fail-closed guard:** count `app_user` rows; if `> 0`, throw a domain error (`"Bootstrap refused: N user(s) already exist."`). Checked before prompting (fast feedback) and again inside the transaction (race safety).
   - Create the `AppUser` (hashed password, encrypted `full_name`/`email`, email blind-index), with `must_change_password = false` — the operator chose their own password interactively, so the "admin-known temporary credential" rationale that drives forced change elsewhere does not apply here.
   - Grant the `ADMIN` role via a `UserRole` row with **`granted_by = <the new user's own id>`** (self-grant). `user_role.granted_by` is `NOT NULL` and FK to `app_user`, so a bootstrap with no external actor cannot use `null`; self-attribution is honest and satisfies the FK with no schema change.
   - Record an audit event: `action: create`, `entityType: app_user`, `entityId: newUser.id`, `actorId: newUser.id` (`audit_event.actor_id` is nullable, but self-attribution reads better than a null system actor here and mirrors the self-grant).
   - Return the created `User` DTO (never includes the password — `shared` `User` has no password field).

2. **`api/src/bootstrap-admin.ts`** — thin CLI entrypoint. `NestFactory.createApplicationContext(AppModule)` (no HTTP), resolve `UsersService`, run an interactive prompt, call `bootstrapFirstAdmin`, print a clear success line (email + role), close the context, exit `0`; on the fail-closed guard or validation error, print the message and exit non-zero.

   Prompt: full name, email, then password entered **twice with echo muted** (stdin raw / no terminal echo). Validate locally against the same policy the API uses (`userCreateSchema`: email format, password `min(12)`, full name non-empty) and re-prompt or exit with a clear message on invalid input, before touching the database.

3. **`npm run bootstrap:admin`** (in `api/package.json`) — runs the compiled `dist/bootstrap-admin.js`, the same way the worker runs in production on box 165. Documented as: build, then run the script, answer the prompts.

### Data flow

```
operator ── prompts ──▶ bootstrap-admin.ts ──▶ UsersService.bootstrapFirstAdmin(dto)
                                                     │
                                    ┌────────────────┴─────────────────┐
                                    ▼                                  ▼
                       guard: count(app_user)==0            single tx: create user
                       else refuse + exit≠0                 + self-grant ADMIN role
                                                            + audit event
                                                                     │
                                                                     ▼
                                                     operator logs in via the normal
                                                     login screen; creates further
                                                     users through POST /api/v1/users
```

### Error handling

- **A user already exists:** refuse, non-zero exit, no prompt for a password wasted (guard runs first). This is the security-critical path — it must be impossible to create a second admin this way.
- **Invalid input** (bad email, password < 12, mismatched confirmation, empty name): reported before any DB write; the operator retries.
- **DB/connection failure:** surface the error and exit non-zero; nothing partially created (single transaction).

### Testing

Integration tests on `UsersService.bootstrapFirstAdmin` (the CLI prompt layer is deliberately thin and not unit-tested; all logic is in the service):

- Creates the admin when `app_user` is empty; the returned DTO has the ADMIN role and the given email.
- The created admin's password **verifies** through `PasswordService` (proves the row can actually log in).
- `user_role.granted_by` equals the new admin's own id (self-grant), and role is `ADMIN`.
- An `audit_event` row is written (`action: create`, `entityType: app_user`).
- **Refuses** when any user already exists — throws, writes nothing (assert count unchanged).
- Idempotent-refusal: a second call after a successful first also refuses.

### Security notes

- The password is only ever typed at the operator's terminal — never a CLI argument, env var, file, or log line, so it does not enter shell history or process listings.
- The command has the same DB reach as the app itself; it grants no new capability beyond "create the first user", and self-disables permanently once that user exists.
- No change to `granted_by` nullability or any existing invariant; the app's role/audit model is untouched.

## Files

- New: `api/src/bootstrap-admin.ts` (CLI entrypoint).
- Modify: `api/src/users/users.service.ts` (add `bootstrapFirstAdmin`).
- Modify: `api/src/users/users.module.ts` only if the entrypoint needs a provider export (likely not — it resolves `UsersService` from `AppModule`).
- Modify: `api/package.json` (add `bootstrap:admin` script).
- New: `api/test/integration/admin-bootstrap.spec.ts`.
- Possibly: a domain problem for the refusal (`api/src/common/domain-problems.ts`) if a suitable one does not exist.
