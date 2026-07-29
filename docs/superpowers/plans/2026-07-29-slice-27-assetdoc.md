# Slice 27-ASSETDOC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one machine carry several PM documents, each with its own schedule, so an admin can tag documents to a machine and a maintainer can pick which form to start.

**Architecture:** A new `asset_document` join table replaces `AssetType.formTemplateId @unique` as the route from machine to form. `ScheduleRule` re-keys from `(assetId, frequency)` to `(assetDocumentId, frequency)`, which is what allows two documents at the same interval on one machine. `Job` gains `assetDocumentId` so the completion cascade and void recompute advance only their own document's schedule.

**Tech Stack:** NestJS 10, Prisma, PostgreSQL 16, Jest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-asset-documents-design.md`. Read it before Task 1.
- **Backend only.** Do not touch `web/` or `android/`. The admin and maintainer screens are slice 28-ASSETDOC-UI.
- **Node 22** at `/opt/homebrew/opt/node@22/bin`. Default `node` is v26 and breaks the toolchain.
- **Never `~/Desktop`** — iCloud-evicted, `grep` returns empty with exit 0 there.
- TDD watched-red. Exit codes captured **directly** (`cmd; echo "exit=$?"`), never through a pipe.
- Zero new dependencies; lockfile byte-identical.
- Production has 6 jobs and **zero archived records** — no backfill of signed data is needed or wanted.
- Worktree: `git worktree add /Users/mavronesamuel/dev/wt-27-assetdoc -b feat/slice-27-assetdoc origin/main`

---

### Task 1: `asset_document`, and the re-key

**Files:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/20260730000000_asset_document/migration.sql`
- Test: `api/test/integration/asset-document-migration.spec.ts`

**Interfaces:**
- Produces: Prisma model `AssetDocument`; `ScheduleRule.assetDocumentId`; `Job.assetDocumentId`; `AssetType.formTemplateId` removed.

- [ ] **Step 1: Write the failing integration test**

```typescript
// api/test/integration/asset-document-migration.spec.ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

describe('asset_document migration', () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it('every pre-existing asset ends up with exactly one document', async () => {
    const assets = await prisma.asset.findMany({ select: { id: true } });
    for (const a of assets) {
      const docs = await prisma.assetDocument.findMany({ where: { assetId: a.id } });
      expect(docs).toHaveLength(1);
    }
  });

  it('every schedule rule points at a document, none orphaned', async () => {
    const orphans = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM schedule_rule r
      LEFT JOIN asset_document d ON d.id = r.asset_document_id
      WHERE d.id IS NULL`;
    expect(Number(orphans[0].n)).toBe(0);
  });

  it('every job points at a document, none orphaned', async () => {
    const orphans = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM job j
      LEFT JOIN asset_document d ON d.id = j.asset_document_id
      WHERE d.id IS NULL`;
    expect(Number(orphans[0].n)).toBe(0);
  });

  it('ALLOWS two documents at the same frequency on one machine — the whole point', async () => {
    const { assetId, templateA, templateB } = await seedTwoTemplatesOneAsset(prisma);
    const a = await prisma.assetDocument.create({ data: { assetId, formTemplateId: templateA } });
    const b = await prisma.assetDocument.create({ data: { assetId, formTemplateId: templateB } });
    await prisma.scheduleRule.create({ data: ruleFor(a.id, 'M1') });
    // Under the OLD @@unique([assetId, frequency]) this second rule was impossible.
    await expect(prisma.scheduleRule.create({ data: ruleFor(b.id, 'M1') })).resolves.toBeDefined();
  });

  it('REFUSES the same document tagged twice to one machine', async () => {
    const { assetId, templateA } = await seedTwoTemplatesOneAsset(prisma);
    await prisma.assetDocument.create({ data: { assetId, formTemplateId: templateA } });
    await expect(
      prisma.assetDocument.create({ data: { assetId, formTemplateId: templateA } }),
    ).rejects.toThrow(/unique/i);
  });
});
```

Write `seedTwoTemplatesOneAsset` and `ruleFor` as local helpers; copy the seeding style from `api/test/integration/helpers/fixtures.ts`.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/mavronesamuel/dev/wt-27-assetdoc
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run build --workspace=shared && npx prisma generate --schema=api/prisma/schema.prisma
bash scripts/dev/run-integration-tests.sh 2>&1 | tail -30; echo "exit=$?"
```

Expected: relation `asset_document` does not exist. Any other reason — stop and find out why.

- [ ] **Step 3: Write the migration**

```sql
-- api/prisma/migrations/20260730000000_asset_document/migration.sql
--
-- Slice 27-ASSETDOC. A machine carries MANY documents.
--
-- Before: asset -> asset_type -> form_template_id (UNIQUE). One machine, one
-- form; and because the FK was UNIQUE, one form could not even be shared by
-- two machine types. The owner's 2026 schedule needs 12 machines to carry
-- several documents each, and 9 machine+frequency combinations to carry two
-- or more at the SAME interval (TE7: monthly pH check AND monthly PM).

CREATE TABLE asset_document (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  asset_id         uuid NOT NULL REFERENCES asset(id),
  form_template_id uuid NOT NULL REFERENCES form_template(id),
  machine_number   text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT asset_document_asset_template_key UNIQUE (asset_id, form_template_id)
);

CREATE INDEX asset_document_asset_active_idx ON asset_document (asset_id) WHERE active;

COMMENT ON COLUMN asset_document.machine_number IS
  'Fills the blank in the template title ("…Record KW___" + "13" -> "…Record KW13"). NULL is always valid: several documents carry the number in the printed title already (CE 95 012 00 01 is fixed "EP01"), so this is never required and never a validation error.';

-- Preserve today's configuration exactly: one document per existing asset,
-- taken from the asset type it already resolves through.
INSERT INTO asset_document (asset_id, form_template_id)
SELECT a.id, t.form_template_id
FROM asset a JOIN asset_type t ON t.id = a.asset_type_id
ON CONFLICT (asset_id, form_template_id) DO NOTHING;

-- schedule_rule: backfill, then swap the key. Backfill-then-drop rather than
-- a bare swap so the 6 existing rows survive.
ALTER TABLE schedule_rule ADD COLUMN asset_document_id uuid REFERENCES asset_document(id);
UPDATE schedule_rule r SET asset_document_id = d.id
  FROM asset_document d WHERE d.asset_id = r.asset_id;
ALTER TABLE schedule_rule ALTER COLUMN asset_document_id SET NOT NULL;
DROP INDEX IF EXISTS "schedule_rule_asset_id_frequency_key";
ALTER TABLE schedule_rule DROP CONSTRAINT IF EXISTS "schedule_rule_asset_id_frequency_key";
ALTER TABLE schedule_rule DROP COLUMN asset_id;
CREATE UNIQUE INDEX schedule_rule_document_frequency_key
  ON schedule_rule (asset_document_id, frequency);

-- job: same treatment. This is what stops a completion advancing ANOTHER
-- document's schedule (completion-cascade / void-schedule-recompute resolve
-- rules from the job).
ALTER TABLE job ADD COLUMN asset_document_id uuid REFERENCES asset_document(id);
UPDATE job j SET asset_document_id = d.id
  FROM asset_document d WHERE d.asset_id = j.asset_id;
ALTER TABLE job ALTER COLUMN asset_document_id SET NOT NULL;

-- asset_type stops being the route to a form. It remains the machine-family
-- grouping and keeps approval_route_id and lead_time_days.
ALTER TABLE asset_type DROP COLUMN form_template_id;
```

- [ ] **Step 4: Update `schema.prisma`**

Add the `AssetDocument` model exactly as in spec §4.1, add `assetDocumentId`/`assetDocument` to `ScheduleRule` (dropping `assetId`/`asset`) and to `Job`, remove `formTemplateId`/`formTemplate` from `AssetType`, and add the `assetDocuments` back-relations to `Asset` and `FormTemplate`.

- [ ] **Step 5: Run the tests — all five must pass**

```bash
bash scripts/dev/run-integration-tests.sh 2>&1 | tail -30; echo "exit=$?"
```

- [ ] **Step 6: Commit**

```bash
git add api/prisma api/test/integration/asset-document-migration.spec.ts
git commit -m "feat(assetdoc): asset_document — a machine carries many documents"
```

---

### Task 2: The form-number blank

**Files:**
- Create: `shared/src/template-title.ts`
- Test: `shared/src/template-title.spec.ts` (or the api unit suite if `shared/` has no runner — check and follow the existing pattern)
- Modify: `shared/src/index.ts` (export)

**Interfaces:**
- Produces:
  - `titleHasFillableRun(title: string): boolean`
  - `resolveTemplateTitle(title: string, machineNumber: string | null | undefined): string`

- [ ] **Step 1: Write the failing test, using the REAL titles**

```typescript
// shared/src/template-title.spec.ts
import { titleHasFillableRun, resolveTemplateTitle } from './template-title';

// The twelve real titles, verbatim from scripts/template-load/yaml/*.yaml.
const WITH_RUN = [
  'BESI Die Attach Preventive Maintenance Record ED____',
  'KNS Wire Bond Preventive Maintenance Record KW___',
  'Besi Esec Wire Bond Preventive Maintenance Record EW_____',
  'MB Encapsulation Preventive Maintenance Record MB_____',
  'Pre-mixer machine Preventive Maintenance Record DP_____',
  'Preventive Maintenance Work Instruction / \r\nRecord AVS 35-____',
  'OS Loading Preventive Maintenance Record IMOS 0__',
  'MB E-Test Preventive Maintenance Record______',
];
const WITHOUT_RUN = [
  'Preventive Maintenance Record EP01',
  'Preventive Maintenance Record PM01',
  'ASM Wire Bond Preventive Maintenance Record',
  'Bump Dispensing Preventive Maintenance WI and Record',
];

describe('titleHasFillableRun', () => {
  it.each(WITH_RUN)('true for %s', (t) => expect(titleHasFillableRun(t)).toBe(true));
  it.each(WITHOUT_RUN)('false for %s', (t) => expect(titleHasFillableRun(t)).toBe(false));

  it('is true for exactly 8 of the 12 real templates', () => {
    // A flag that returned true for everything would pass the per-title checks
    // above only by accident of ordering; this pins the split itself.
    expect([...WITH_RUN, ...WITHOUT_RUN].filter(titleHasFillableRun)).toHaveLength(8);
  });

  it('a single underscore is not a blank — it is punctuation', () => {
    expect(titleHasFillableRun('Record for A_B')).toBe(false);
  });
});

describe('resolveTemplateTitle', () => {
  it('substitutes the number into the run', () => {
    expect(resolveTemplateTitle('KNS Wire Bond Preventive Maintenance Record KW___', '13'))
      .toBe('KNS Wire Bond Preventive Maintenance Record KW13');
  });

  it('leaves the blank intact when no number is given — as the paper form is', () => {
    const t = 'BESI Die Attach Preventive Maintenance Record ED____';
    expect(resolveTemplateTitle(t, null)).toBe(t);
  });

  it('leaves a title with no run untouched, number or not', () => {
    expect(resolveTemplateTitle('Preventive Maintenance Record EP01', '99'))
      .toBe('Preventive Maintenance Record EP01');
  });

  it('substitutes only the FIRST run', () => {
    expect(resolveTemplateTitle('A ___ B ___', '7')).toBe('A 7 B ___');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npm run test:unit --workspace=api -- template-title; echo "exit=$?"
```

(If `shared/` has its own runner, use it; check `shared/package.json` first and follow whatever exists rather than inventing a new test setup.)

- [ ] **Step 3: Implement**

```typescript
// shared/src/template-title.ts
/**
 * The machine-number blank in a controlled document's title.
 *
 * Slice 27-ASSETDOC. The admin fills exactly one thing when tagging a document
 * to a machine (owner, 2026-07-29: "Only the form number is filled by admin");
 * everything else on the form is maintainer capture.
 *
 * Measured against the 12 real templates: 8 carry a run of underscores
 * (ED____, KW___, EW_____, MB_____, DP_____, AVS 35-____, IMOS 0__, and
 * 050-00-01's bare ______), 2 have the number printed already (EP01, PM01),
 * and 2 have no machine designation at all. A single underscore is punctuation,
 * not a blank — hence the {2,}.
 */
const FILLABLE_RUN = /_{2,}/;

export function titleHasFillableRun(title: string): boolean {
  return FILLABLE_RUN.test(title);
}

/**
 * Substitution happens at RENDER, never at tag time, so a template revision
 * that changes the title stays correct. Slice 23-PDFA freezes the rendered
 * result at archive, so an archived record keeps the title it was signed under.
 */
export function resolveTemplateTitle(
  title: string,
  machineNumber: string | null | undefined,
): string {
  if (!machineNumber) return title;
  return title.replace(FILLABLE_RUN, machineNumber);
}
```

Export both from `shared/src/index.ts`.

- [ ] **Step 4: Run — all must pass. Then commit**

```bash
npm run test:unit --workspace=api -- template-title; echo "exit=$?"
git add shared/src/template-title.ts shared/src/template-title.spec.ts shared/src/index.ts
git commit -m "feat(assetdoc): the form-number blank, measured against the 12 real titles"
```

---

### Task 3: Schedule rules are created per document

**Files:**
- Modify: `api/src/scheduling/schedule-rule-bootstrap.service.ts`
- Test: `api/src/scheduling/schedule-rule-bootstrap.service.spec.ts`

**Interfaces:**
- Consumes: `AssetDocument` (Task 1).
- Produces: bootstrap now iterates `asset_document` rows, not assets. Frequencies still come from the current revision's distinct active `templateItem.frequency` (existing logic at lines 72-75) — now per document.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('ScheduleRuleBootstrapService (slice 27)', () => {
  it('creates rules per DOCUMENT, so two documents on one machine both get one', async () => {
    const { svc, prisma } = makeBootstrap();
    // doc A has 1M items, doc B also has 1M items, same asset
    const result = await svc.run();
    const rules = await prisma.scheduleRule.findMany({ where: { frequency: 'M1' } });
    expect(rules.map((r) => r.assetDocumentId).sort()).toEqual([docA.id, docB.id].sort());
  });

  it('skips inactive documents', async () => {
    const { svc, prisma } = makeBootstrap();
    await prisma.assetDocument.update({ where: { id: docB.id }, data: { active: false } });
    await svc.run();
    expect(await prisma.scheduleRule.count({ where: { assetDocumentId: docB.id } })).toBe(0);
  });

  it('is still idempotent — a second run creates nothing', async () => {
    const { svc, prisma } = makeBootstrap();
    await svc.run();
    const before = await prisma.scheduleRule.count();
    await svc.run();
    expect(await prisma.scheduleRule.count()).toBe(before);
  });
});
```

- [ ] **Step 2: Run and watch it fail.** `npm run test:unit --workspace=api -- schedule-rule-bootstrap; echo "exit=$?"`

- [ ] **Step 3: Implement.** Change the outer query from assets to `assetDocument.findMany({ where: { active: true }, include: { formTemplate: true } })`, resolve the current revision per document, and create rules with `assetDocumentId`. Keep `createMany({ skipDuplicates: true })` — idempotence now rests on the new `(asset_document_id, frequency)` unique index. Update the audit `after` payload to name the document.

- [ ] **Step 4: Run, then commit.**

```bash
npm run test:unit --workspace=api -- schedule-rule-bootstrap; echo "exit=$?"
git add api/src/scheduling/schedule-rule-bootstrap.service.ts api/src/scheduling/schedule-rule-bootstrap.service.spec.ts
git commit -m "feat(assetdoc): bootstrap schedule rules per document"
```

---

### Task 4: Job generation selects the template from the document

**Files:**
- Modify: `api/src/scheduling/job-generation.service.ts:67,84,102-140`
- Test: `api/src/scheduling/job-generation.service.spec.ts`

**Interfaces:**
- Consumes: Task 1, Task 3.
- Produces: jobs carry `assetDocumentId`; `templateRevisionId` resolves from `rule.assetDocument.formTemplateId`.

- [ ] **Step 1: Write the failing test**

```typescript
it('raises jobs with DIFFERENT templates for two documents on one machine', async () => {
  const { svc, prisma } = makeGenerator();   // docA -> templateA, docB -> templateB, same asset, both due
  await svc.run();
  const jobs = await prisma.job.findMany({ where: { assetId }, select: { templateRevisionId: true, assetDocumentId: true } });
  expect(jobs).toHaveLength(2);
  expect(new Set(jobs.map((j) => j.templateRevisionId)).size).toBe(2);
  expect(new Set(jobs.map((j) => j.assetDocumentId)).size).toBe(2);
});

it('still takes the approval route from the asset TYPE, not the document', async () => {
  // The approval chain is a property of the machine family; only the FORM moved.
  const { svc, prisma } = makeGenerator();
  await svc.run();
  const job = await prisma.job.findFirstOrThrow({ where: { assetId } });
  expect(job.approvalRouteId).toBe(assetType.approvalRouteId);
});
```

- [ ] **Step 2: Run and watch it fail.** `npm run test:unit --workspace=api -- job-generation; echo "exit=$?"`

- [ ] **Step 3: Implement.** `include: { assetDocument: { include: { formTemplate: true, asset: { include: { assetType: true } } } } }`. Line 105 becomes `where: { formTemplateId: rule.assetDocument.formTemplateId, status: 'current' }`. Line 139 keeps `approvalRouteId: asset.assetType.approvalRouteId`. Set `assetDocumentId` on the created job. `leadTimeDays` still from `assetType`.

- [ ] **Step 4: Run, then commit.**

```bash
npm run test:unit --workspace=api -- job-generation; echo "exit=$?"
git add api/src/scheduling/job-generation.service.ts api/src/scheduling/job-generation.service.spec.ts
git commit -m "feat(assetdoc): job generation resolves the template from the document"
```

---

### Task 5: A completion must not advance another document's schedule

**This is the task that matters. Everything else is plumbing.**

**Files:**
- Modify: `api/src/scheduling/completion-cascade.service.ts`
- Modify: `api/src/scheduling/void-schedule-recompute.service.ts`
- Test: `api/test/integration/cross-document-schedule.spec.ts`

**Interfaces:**
- Consumes: `Job.assetDocumentId` (Task 1).
- Produces: both services resolve rules by `job.assetDocumentId` + the job's frozen `frequencyScope`, never by `assetId`.

**Why:** both services walk backwards from a completed job to the rules it satisfies, resolving by `assetId` + `frequencyScope`. With several documents per machine, completing a machine's PM would advance its pH check's schedule too — the pH check would silently stop coming due, and nothing would look wrong. This is the most dangerous defect available in this slice.

- [ ] **Step 1: Write the failing integration tests**

```typescript
// api/test/integration/cross-document-schedule.spec.ts
describe('schedules do not leak across documents on one machine', () => {
  it('completing document A leaves document B\'s schedule untouched', async () => {
    const { assetId, docA, docB } = await seedTwoDocumentsBothMonthly(prisma);
    const before = await ruleFor(prisma, docB, 'M1');

    await archiveAJobFor(prisma, docA, 'M1');   // full submit -> verify -> verify -> ARCHIVED

    const after = await ruleFor(prisma, docB, 'M1');
    expect(after.nextDueOn).toEqual(before.nextDueOn);
    expect(after.lastCompletedOn).toEqual(before.lastCompletedOn);

    const advanced = await ruleFor(prisma, docA, 'M1');
    expect(advanced.nextDueOn).not.toEqual(before.nextDueOn);   // A really did move
  });

  it('voiding document A\'s archived job leaves document B\'s schedule untouched', async () => {
    const { docA, docB } = await seedTwoDocumentsBothMonthly(prisma);
    const jobId = await archiveAJobFor(prisma, docA, 'M1');
    const before = await ruleFor(prisma, docB, 'M1');

    await voidArchivedJob(prisma, jobId, 'wrong machine');

    const after = await ruleFor(prisma, docB, 'M1');
    expect(after.nextDueOn).toEqual(before.nextDueOn);
    expect(after.lastCompletedOn).toEqual(before.lastCompletedOn);
  });

  it('the 3M cascade still reaches 1M WITHIN a document, and only within it', async () => {
    // Frequency cascade (3M satisfies 1M) must survive the re-key — it is
    // scoped by frequencyScope, which is orthogonal to the document.
    const { docA, docB } = await seedTwoDocumentsWith1MAnd3M(prisma);
    await archiveAJobFor(prisma, docA, 'M3');
    expect((await ruleFor(prisma, docA, 'M1')).lastCompletedOn).not.toBeNull();
    expect((await ruleFor(prisma, docB, 'M1')).lastCompletedOn).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch them fail.** Expect the leakage assertions to fail — document B's schedule WILL have moved. Record that observed failure in the report; it is the proof the tests are not vacuous.

```bash
bash scripts/dev/run-integration-tests.sh 2>&1 | tail -30; echo "exit=$?"
```

- [ ] **Step 3: Implement.** In both services, replace the `assetId`-scoped rule lookup with one scoped by `assetDocumentId` taken from the job, keeping the existing `frequencyScope` filter and the rolling `addCalendarMonthsClamped` arithmetic **unchanged**. In `void-schedule-recompute`, the "most recent still-valid completion" query must also be scoped to the same document — a sibling document's archived job is not a valid completion for this one.

- [ ] **Step 4: Run — all three pass, and every pre-existing scheduling test still passes.**

```bash
bash scripts/dev/run-integration-tests.sh 2>&1 | tail -20; echo "exit=$?"
npm run test:unit --workspace=api; echo "exit=$?"
```

- [ ] **Step 5: Commit**

```bash
git add api/src/scheduling/completion-cascade.service.ts api/src/scheduling/void-schedule-recompute.service.ts api/test/integration/cross-document-schedule.spec.ts
git commit -m "fix(assetdoc): a completion advances only its own document's schedule"
```

---

### Task 6: The tagging API

**Files:**
- Create: `api/src/assets/asset-documents.controller.ts`, `asset-documents.service.ts`
- Modify: `api/openapi.yaml`, `shared/src/asset.ts`, `api/src/assets/assets.module.ts`
- Test: `api/src/assets/asset-documents.service.spec.ts`, `api/test/integration/asset-documents.spec.ts`

**Interfaces:**
- Produces: `GET /assets/{assetId}/documents` (any role that can view the asset), `POST /assets/{assetId}/documents` (ADMIN), `PATCH /asset-documents/{id}` (ADMIN). The GET response carries `titleHasFillableRun` and `resolvedTitle`, derived per Task 2 — never stored.

- [ ] **Step 1: Write the failing tests**

```typescript
it('lists a machine\'s documents with the resolved title', async () => {
  const res = await get(`/assets/${assetId}/documents`).expect(200);
  expect(res.body.data[0]).toMatchObject({
    machineNumber: '13',
    resolvedTitle: 'KNS Wire Bond Preventive Maintenance Record KW13',
    titleHasFillableRun: true,
  });
});

it('reports titleHasFillableRun false for a fixed title, so no field is offered', async () => {
  const res = await get(`/assets/${epAssetId}/documents`).expect(200);
  expect(res.body.data[0].titleHasFillableRun).toBe(false);
});

it('accepts a machineNumber for a fixed title without error — never a validation failure', async () => {
  // Owner: "Is ok some forms are already pre updated just allow user to choose".
  await post(`/assets/${epAssetId}/documents`, { formTemplateId: epTemplate, machineNumber: '99' })
    .expect(201);
});

it('rejects tagging the same document twice to one machine', async () => {
  await post(`/assets/${assetId}/documents`, { formTemplateId: tpl }).expect(201);
  await post(`/assets/${assetId}/documents`, { formTemplateId: tpl }).expect(409);
});

it('is ADMIN-only for write', async () => {
  await postAs('MAINTAINER', `/assets/${assetId}/documents`, { formTemplateId: tpl }).expect(403);
});

it('deactivates rather than deletes', async () => {
  await patch(`/asset-documents/${docId}`, { active: false }).expect(200);
  expect(await prisma.assetDocument.findUnique({ where: { id: docId } })).not.toBeNull();
});
```

- [ ] **Step 2: Run and watch them fail.** `bash scripts/dev/run-integration-tests.sh 2>&1 | tail -20; echo "exit=$?"`

- [ ] **Step 3: Implement** the service, controller, zod schemas in `shared/src/asset.ts`, and the OpenAPI paths. Follow `api/src/assets/assets.controller.ts` for the guard/scope pattern exactly — do not invent a new authorisation shape. There is no DELETE route.

- [ ] **Step 4: Run, then commit.**

```bash
npm run test:contract --workspace=api; echo "exit=$?"
npm run test:route-coverage --workspace=api; echo "exit=$?"
bash scripts/dev/run-integration-tests.sh 2>&1 | tail -20; echo "exit=$?"
git add api/src/assets shared/src/asset.ts api/openapi.yaml api/test/integration/asset-documents.spec.ts
git commit -m "feat(assetdoc): tag documents to a machine over the API"
```

---

### Task 7: The template loader stops creating one asset type per document

**Files:**
- Modify: `scripts/template-load/src/loader.ts:504-520`
- Test: `api/test/integration/template-load/loader-endpoints.spec.ts`

**Interfaces:**
- Consumes: Task 6's API.

**Why:** the loader creates an `AssetType` per document, carrying `formTemplateId`. That column is gone. The loader must create the template and leave tagging to an admin — a document is no longer owned by a machine family.

- [ ] **Step 1: Write the failing test**

```typescript
it('loads all 12 templates without creating an asset type per document', async () => {
  const templates = await listAll('/api/v1/templates');
  expect(templates).toHaveLength(12);
  // Asset types are now a machine-family grouping, decoupled from documents.
  const types = await listAll('/api/v1/asset-types');
  expect(types.every((t) => !('formTemplateId' in t))).toBe(true);
});
```

- [ ] **Step 2: Run and watch it fail.** **Step 3:** Remove the asset-type-per-document creation; keep template + revision + item + measurement loading unchanged. **Step 4:** Re-run the loader against a clean DB and confirm all 12 templates load with their revisions and items intact.

```bash
bash scripts/dev/run-integration-tests.sh 2>&1 | tail -20; echo "exit=$?"
git add scripts/template-load/src/loader.ts api/test/integration/template-load/loader-endpoints.spec.ts
git commit -m "feat(assetdoc): the loader creates documents, not machine families"
```

---

## Final verification

- [ ] Full battery, exit codes captured directly:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm run lint; echo "lint=$?"
npm run format:check; echo "format=$?"
npm run typecheck; echo "typecheck=$?"
npm run test:unit --workspace=api; echo "unit=$?"
bash scripts/dev/run-integration-tests.sh; echo "integration=$?"
npm run test:contract --workspace=api; echo "contract=$?"
npm run test:route-coverage --workspace=api; echo "routes=$?"
npm run test:scope-coverage --workspace=api; echo "scope=$?"
npm run test:security --workspace=api; echo "security=$?"
git diff --stat origin/main -- package-lock.json web android   # MUST be empty
```

- [ ] Migration applies cleanly to a database seeded in the OLD shape, and re-running it is a no-op.
- [ ] Write `.superpowers/sdd/slice-27-assetdoc-report.md`: the observed red run for Task 5 (the leakage assertions failing before the fix — this is the slice's key evidence), what the migration did to the 6 existing rows, deviations, concerns.
- [ ] Do **not** merge or push. Adversarial Opus review follows and will try to make one machine's completion satisfy another machine's — or another document's — schedule.
