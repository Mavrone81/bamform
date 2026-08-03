import { randomUUID } from 'node:crypto';
import { assetCodeSchema, frequencySchema } from '@bamform/shared';
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import {
  createAsset,
  createAssetType,
  createFormTemplate,
  createTemplateMeasurement,
  createTemplateRevision,
  createUser,
  getSeededApprovalRouteId,
} from './helpers/fixtures';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeAll();
});

describe('DBD §7 schema-enforced invariants', () => {
  it('I-INV-01 rejects a second current revision for the same template (partial unique index)', async () => {
    const authorId = await createUser('author');
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);

    await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'current',
    });

    await expect(
      createTemplateRevision(formTemplateId, authorId, { sequenceOrdinal: 1, status: 'current' }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it('I-INV-02 rejects a revision sequence gap (defect B-02 prevented)', async () => {
    const authorId = await createUser('author');
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);

    await createTemplateRevision(formTemplateId, authorId, { sequenceOrdinal: 0, status: 'draft' });

    await expect(
      createTemplateRevision(formTemplateId, authorId, { sequenceOrdinal: 5, status: 'draft' }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('I-INV-03 rejects a revision whose author approves their own work', async () => {
    const authorId = await createUser('author');
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);

    await expect(
      createTemplateRevision(formTemplateId, authorId, {
        sequenceOrdinal: 0,
        status: 'current',
        approvedBy: authorId,
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('I-INV-04 rejects lower_limit > upper_limit (defect B-04 prevented)', async () => {
    const authorId = await createUser('author');
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const revisionId = await createTemplateRevision(formTemplateId, authorId, {
      sequenceOrdinal: 0,
      status: 'draft',
    });

    await expect(
      createTemplateMeasurement(revisionId, { lowerLimit: 105, upperLimit: 95 }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    // Sanity check: the same limits in the correct (lower <= upper) order
    // are accepted — the CHECK constraint rejects only the inversion, not
    // the values themselves.
    await expect(
      createTemplateMeasurement(revisionId, { lowerLimit: 95, upperLimit: 105 }),
    ).resolves.toEqual(expect.any(String));
  });

  it('I-INV-06 rejects a duplicate asset code (defect B-09 prevented)', async () => {
    // @bamform/shared's assetCodeSchema (UR-003 shape) validates the fixture
    // code before it reaches the database — the same schema the api and web
    // workspaces will both import once slice 2+ build request validation
    // (ADR-002: shared validation, not duplicated per side).
    const code = assetCodeSchema.parse('AW01');

    const approvalRouteId = await getSeededApprovalRouteId();
    const formTemplateId = await createFormTemplate(`DOC-${randomUUID()}`);
    const assetTypeId = await createAssetType(
      formTemplateId,
      approvalRouteId,
      `AT-${randomUUID()}`,
    );

    await createAsset(assetTypeId, code);

    await expect(createAsset(assetTypeId, code)).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
  });

  it('@bamform/shared frequencySchema matches the frequency_t values fixtures use', () => {
    expect(frequencySchema.parse('M1')).toBe('M1');
    expect(() => frequencySchema.parse('M2')).toThrow();
  });

  it('sanity: adminPool can reach the seeded reference data', async () => {
    const roles = await adminPool.query('SELECT code FROM "role" ORDER BY code');
    expect(roles.rows.map((r: { code: string }) => r.code)).toEqual([
      'ADMIN',
      'AUDITOR',
      'DOC_CONTROLLER',
      'ENGINEER',
      'MAINTAINER',
      // Slice 18-WORKFLOW's additive seed (20260728020000) — the six
      // original roles are all still here, which is the point.
      'PLANNER',
      'TEAM_LEADER',
    ]);
  });
});
