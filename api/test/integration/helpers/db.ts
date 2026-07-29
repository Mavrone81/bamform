import { Pool } from 'pg';

/**
 * Two connections, mirroring how BamForm actually talks to Postgres:
 *
 *  - `adminPool` — whatever DATABASE_URL points at in CI (the initdb owner,
 *    `bamform` in docker-compose.ci.yml / .github/workflows/ci.yml). Used
 *    for fixture setup/teardown and for every assertion that is not itself
 *    about the restricted role's permissions.
 *  - `appPool` — the `bamform_app` role that api/prisma/grants.sql creates
 *    and grants (DBD §7.1). Used only by the I-INV-08/09/10 permission
 *    tests, which must observe Postgres actually refuse the statement.
 *
 * CI has no separate DATABASE_APP_URL secret (there is only one ephemeral
 * Postgres user); `appUrl` is derived from DATABASE_URL by swapping in the
 * bamform_app credentials grants.sql creates when the role doesn't already
 * exist. Set DATABASE_APP_URL explicitly to override.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} must be set to run the integration suite (see docker-compose.test.yml)`,
    );
  }
  return value;
}

function withCredentials(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}

export const adminUrl = requireEnv('DATABASE_URL');

export const appUrl =
  process.env.DATABASE_APP_URL ??
  withCredentials(adminUrl, 'bamform_app', 'bamform_app_ci_only_not_a_real_secret');

export const adminPool = new Pool({ connectionString: adminUrl });
export const appPool = new Pool({ connectionString: appUrl });

/**
 * Tables that hold mutable/append-only application data — truncated between
 * tests for isolation. Deliberately excludes the PR-DBD-09 seeded reference
 * data (`role`, `approval_route`, `approval_stage`, `approval_stage_role`),
 * which every test relies on being present.
 */
const RESETTABLE_TABLES = [
  'idempotency_key',
  'notification',
  'record_export',
  'audit_event',
  'approval_step',
  'attachment',
  'part_used',
  'measurement_result',
  'item_result',
  'job',
  'schedule_rule',
  // Slice 27-ASSETDOC — parent of `schedule_rule`/`job`, child of
  // `asset`/`form_template`, so it sits between them in this child-first list.
  'asset_document',
  'template_measurement',
  'template_item',
  'template_revision',
  'form_template',
  'asset',
  'asset_type',
  'refresh_token',
  // Slice 13-MFA — listed BEFORE `app_user` (it has an ON DELETE RESTRICT FK
  // to it); TRUNCATE ... CASCADE would cope either way, but the list is kept
  // child-first by convention.
  'mfa_recovery_code',
  'delegation',
  'user_area_scope',
  'user_role',
  'app_user',
  'area',
];

export async function resetDatabase(): Promise<void> {
  await adminPool.query(
    `TRUNCATE TABLE ${RESETTABLE_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE;`,
  );
}

export async function closeAll(): Promise<void> {
  await adminPool.end();
  await appPool.end();
}
