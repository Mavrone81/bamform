import { randomUUID } from 'node:crypto';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetDocument,
  createAssetType,
  createFormTemplate,
  createScheduleRule,
  getSeededApprovalRouteId,
} from './helpers/fixtures';

const UNIQUE_VIOLATION = '23505';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeAll();
});

/**
 * Slice 27-ASSETDOC. `asset_document` is the route from a machine to a form;
 * it replaces `asset_type.form_template_id @unique`, which made the relation
 * one-to-one in BOTH directions — one form per machine, and one machine type
 * per form.
 *
 * These are shape assertions against the migrated database, not against
 * Prisma's view of it: a nullable `asset_document_id` or a silently-missing
 * foreign key would still let the Prisma client compile and every service
 * test pass, while leaving the production rows orphanable.
 */
async function columnMeta(
  table: string,
  column: string,
): Promise<{ is_nullable: string } | undefined> {
  const result = await adminPool.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return result.rows[0];
}

async function foreignKeyExists(table: string, column: string, target: string): Promise<boolean> {
  const result = await adminPool.query(
    `SELECT 1
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = $1
        AND kcu.column_name = $2
        AND ccu.table_name = $3`,
    [table, column, target],
  );
  return (result.rowCount ?? 0) > 0;
}

describe('asset_document migration (slice 27-ASSETDOC)', () => {
  it('asset_type has stopped being the route to a form — form_template_id is gone', async () => {
    expect(await columnMeta('asset_type', 'form_template_id')).toBeUndefined();
    // ...but it remains the machine-family grouping and keeps its two real
    // properties (spec §4.1).
    expect(await columnMeta('asset_type', 'approval_route_id')).toEqual({ is_nullable: 'NO' });
    expect(await columnMeta('asset_type', 'lead_time_days')).toEqual({ is_nullable: 'NO' });
  });

  it('schedule_rule is keyed by document, not by machine, and cannot be orphaned', async () => {
    expect(await columnMeta('schedule_rule', 'asset_id')).toBeUndefined();
    expect(await columnMeta('schedule_rule', 'asset_document_id')).toEqual({ is_nullable: 'NO' });
    expect(await foreignKeyExists('schedule_rule', 'asset_document_id', 'asset_document')).toBe(
      true,
    );
  });

  it('job carries the document it was raised for, and cannot be orphaned', async () => {
    // `asset_id` STAYS on job — a record is still about a machine. What is new
    // is that it also names WHICH document, which is what stops a completion
    // advancing a sibling document's schedule (spec §4.3).
    expect(await columnMeta('job', 'asset_id')).toEqual({ is_nullable: 'NO' });
    expect(await columnMeta('job', 'asset_document_id')).toEqual({ is_nullable: 'NO' });
    expect(await foreignKeyExists('job', 'asset_document_id', 'asset_document')).toBe(true);
  });

  it('ALLOWS two documents at the same frequency on one machine — the whole point', async () => {
    const approvalRouteId = await getSeededApprovalRouteId();
    const templateA = await createFormTemplate(`DOC-A-${randomUUID()}`);
    const templateB = await createFormTemplate(`DOC-B-${randomUUID()}`);
    const assetTypeId = await createAssetType(templateA, approvalRouteId, `AT-${randomUUID()}`);
    // This test tags the machine's documents itself, so it opts out of the
    // fixture's automatic one-document tag.
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      skipDefaultDocument: true,
    });

    const docA = await createAssetDocument(assetId, templateA);
    const docB = await createAssetDocument(assetId, templateB);

    await createScheduleRule(assetId, {
      frequency: 'M1',
      intervalMonths: 1,
      assetDocumentId: docA,
    });
    // Under the OLD @@unique([asset_id, frequency]) this second rule was
    // impossible — and TE7 in the owner's own 2026 workbook needs exactly it
    // (a monthly pH-meter check AND a monthly preventive maintenance).
    await expect(
      createScheduleRule(assetId, { frequency: 'M1', intervalMonths: 1, assetDocumentId: docB }),
    ).resolves.toEqual(expect.any(String));
  });

  it('REFUSES the same document tagged twice to one machine', async () => {
    const approvalRouteId = await getSeededApprovalRouteId();
    const templateA = await createFormTemplate(`DOC-A-${randomUUID()}`);
    const assetTypeId = await createAssetType(templateA, approvalRouteId, `AT-${randomUUID()}`);
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`, {
      skipDefaultDocument: true,
    });

    await createAssetDocument(assetId, templateA);
    await expect(createAssetDocument(assetId, templateA)).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
  });

  it('LETS two machines share one document — which the old @unique wrongly forbade', async () => {
    // CM02 and CM03 both use CE 95 030 00 01; T8, T69 and ST01 all use
    // CE 95 050 00 01 (spec §4.1).
    const approvalRouteId = await getSeededApprovalRouteId();
    const shared = await createFormTemplate(`DOC-SHARED-${randomUUID()}`);
    const assetTypeId = await createAssetType(shared, approvalRouteId, `AT-${randomUUID()}`);
    const assetOne = await createAsset(assetTypeId, `AS1-${randomUUID()}`, {
      skipDefaultDocument: true,
    });
    const assetTwo = await createAsset(assetTypeId, `AS2-${randomUUID()}`, {
      skipDefaultDocument: true,
    });

    await expect(createAssetDocument(assetOne, shared)).resolves.toEqual(expect.any(String));
    await expect(createAssetDocument(assetTwo, shared)).resolves.toEqual(expect.any(String));
  });

  it('leaves no orphaned schedule_rule or job rows once real rows exist', async () => {
    // The NOT NULL + FK assertions above make an orphan impossible by
    // construction; this runs the query the migration's own backfill had to
    // satisfy, against seeded rows, so it is not vacuous.
    const approvalRouteId = await getSeededApprovalRouteId();
    const templateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(templateId, approvalRouteId, `AT-${randomUUID()}`);
    const assetId = await createAsset(assetTypeId, `AS-${randomUUID()}`);
    await createScheduleRule(assetId, { frequency: 'M1', intervalMonths: 1 });

    const rules = await adminPool.query(
      `SELECT count(*) AS n FROM schedule_rule r
         LEFT JOIN asset_document d ON d.id = r.asset_document_id
        WHERE d.id IS NULL`,
    );
    expect(Number(rules.rows[0].n)).toBe(0);

    const seeded = await adminPool.query(`SELECT count(*) AS n FROM schedule_rule`);
    expect(Number(seeded.rows[0].n)).toBeGreaterThan(0);
  });
});
