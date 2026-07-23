import { appPool, closeAll, resetDatabase } from './helpers/db';

const INSUFFICIENT_PRIVILEGE = '42501';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeAll();
});

/**
 * DBD §7.1 / non-negotiable #7: the bamform_app role that api/prisma/grants.sql
 * grants is what the api actually connects as. These assert Postgres itself
 * refuses the statement — permission is checked before any row is touched,
 * so `WHERE false` is enough; no fixture rows are needed.
 */
describe('DBD §7.1 role grants (bamform_app)', () => {
  it('I-INV-08 denies UPDATE on audit_event to bamform_app', async () => {
    await expect(
      appPool.query(`UPDATE "audit_event" SET entity_type = 'x' WHERE false`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('I-INV-09 denies DELETE on approval_step to bamform_app', async () => {
    await expect(appPool.query(`DELETE FROM "approval_step" WHERE false`)).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });

  it('I-INV-10 denies DELETE on a record table (job) to bamform_app', async () => {
    await expect(appPool.query(`DELETE FROM "job" WHERE false`)).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });

  it('I-INV-10 denies DELETE on every table bamform_app can otherwise write to', async () => {
    const tables = await appPool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.role_table_grants
         WHERE grantee = 'bamform_app' AND privilege_type = 'INSERT'
         ORDER BY table_name`,
    );
    expect(tables.rowCount).toBeGreaterThan(0);

    for (const { table_name: tableName } of tables.rows) {
      await expect(appPool.query(`DELETE FROM "${tableName}" WHERE false`)).rejects.toMatchObject({
        code: INSUFFICIENT_PRIVILEGE,
      });
    }
  });
});
