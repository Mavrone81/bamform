# Slice 30 — Parts Used capture UI (offline, add/edit/soft-remove) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a maintainer record, edit, and remove the parts they used on a PM job, offline, so the parts reach the signed record.

**Architecture:** The parts backend (create + offline sync dispatch + canonical + PDF rendering) already exists; this slice adds the missing edit/soft-remove capability and the web capture UI. Every parts mutation becomes a **client-keyed `PUT` upsert** (`PUT /jobs/{id}/parts/{partId}` where `partId` is a client-generated `uuidv7`), mirroring how item and measurement results already work — so a part is addressable for edit/remove immediately, even before its first sync, and replays idempotently through the existing generic outbox. Removal is a soft flag (`part_used.active = false`), never a physical `DELETE`.

**Tech Stack:** NestJS + Prisma (Postgres 16) api; React 19 + Vite PWA web with Dexie/IndexedDB offline outbox; Zod schemas in `@bamform/shared`; Jest (api unit + integration) and Vitest (web).

## Global Constraints

- Node 22 only. Active `node` is v22.23.1. NEVER regenerate a lockfile (npm 11 / node 26 drops platform bindings). If a worktree lacks `node_modules`, run `npm ci` (installs from the existing lockfile, does not regenerate it).
- Work from `/Users/mavronesamuel/dev/bamform` worktrees, never the Desktop copy (iCloud-evicted, reads blank).
- Non-negotiable #7: NO physical `DELETE` on record tables. Removal is `active = false`.
- Non-negotiable #1: the outbox never clears an entry optimistically; a mutation is confirmed only after server ack. Reuse the existing `append`/`appendJobMutation` path, which already honours this.
- Edit window: parts may be added/edited/removed only while the job is `ASSIGNED` or `IN_PROGRESS`. Enforce via the existing `assertJobWritable(job.status)` (`api/src/jobs/job-status-guard.ts`), exactly as `PartsService.recordPart` and `ResultsService` do.
- Offline replay idempotency is keyed by the outbox mutation id (`mutation.id`), passed as the `idempotencyKey` — same contract the `item`/`measurement`/`part` sync cases already use (`api/src/sync/sync-outbox.service.ts`).
- Canonical signed record must reflect only `active = true` parts. Slice A does NOT change the canonical serialisation shape (no `active` field enters the hash), so the golden hash U-SIG-01 is UNCHANGED — verify it does not move.
- CI gate: all jobs green per slice (`.github/workflows/ci.yml`). The contract job (5) requires new routes to be present in `api/openapi.yaml` and `api/test/contract/route-roles.ts`.

## File structure

- `api/prisma/schema.prisma` — add `active Boolean @default(true)` to `PartUsed`.
- `api/prisma/migrations/<ts>_part_used_active_flag/migration.sql` — the additive column.
- `shared/src/job.ts` — add `partUpsertInputSchema` / `PartUpsertInput`.
- `api/src/jobs/parts.service.ts` — add `upsertPart(...)` (create-or-update by id, soft-remove).
- `api/src/jobs/jobs.controller.ts` — add `@Put(':jobId/parts/:partId')`.
- `api/src/jobs/job-include.ts` — filter `JOB_FULL_INCLUDE.partsUsed` to `active: true`.
- `api/src/sync/outbox-dispatch.ts` — match `PUT /jobs/{id}/parts/{partId}` → new `part-upsert` route.
- `api/src/sync/sync-outbox.service.ts` — dispatch the `part-upsert` case to `upsertPart`.
- `api/openapi.yaml` + `api/test/contract/route-roles.ts` — declare the new route.
- `web/src/screens/RecordCapture.tsx` — a Parts Used section (list/add/edit/remove) enqueuing `PUT` upserts.
- Tests colocated per existing convention (`*.spec.ts` in api, `api/test/integration/*.spec.ts`, `web/**/*.test.ts(x)`).

---

### Task 1: `part_used.active` column + migration

**Files:**
- Modify: `api/prisma/schema.prisma` (the `model PartUsed` block, ~line 828)
- Create: `api/prisma/migrations/20260731000000_part_used_active_flag/migration.sql`
- Test: `api/test/integration/parts-upsert.spec.ts` (new; first assertion is the default)

**Interfaces:**
- Produces: `part_used.active BOOLEAN NOT NULL DEFAULT true`; Prisma field `active: boolean` on `PartUsed`.

- [ ] **Step 1: Write the failing test** — `api/test/integration/parts-upsert.spec.ts`:

```ts
import { adminPool, closeAll, resetDatabase } from './helpers/db';
import { createJobFixture } from './helpers/fixtures';

describe('part_used.active', () => {
  beforeEach(async () => { await resetDatabase(); });
  afterAll(async () => { await closeAll(); });

  it('defaults active=true on insert', async () => {
    const { jobId, authorId } = await createJobFixture('PM-PARTS-1', 'in_progress');
    const { rows } = await adminPool.query(
      `INSERT INTO "part_used" ("job_id","description","quantity","recorded_by")
       VALUES ($1,'Filter','1',$2) RETURNING "active"`,
      [jobId, authorId],
    );
    expect(rows[0].active).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `cd api && npm run test:integration -- parts-upsert`. Expected: FAIL (`column "active" does not exist`).

- [ ] **Step 3: Add the column.** In `schema.prisma` `model PartUsed`, add after `remarks String?`:

```prisma
  /// Slice 30 — soft-remove flag. A maintainer may remove a part during the
  /// capture window; #7 forbids physical DELETE, so removal sets active=false.
  /// Every read/canonical/PDF path filters to active=true (JOB_FULL_INCLUDE).
  active      Boolean  @default(true)
```

Create `api/prisma/migrations/20260731000000_part_used_active_flag/migration.sql`:

```sql
-- Slice 30 — soft-remove flag for parts. Additive, nullable-safe via DEFAULT.
ALTER TABLE "part_used" ADD COLUMN "active" boolean NOT NULL DEFAULT true;
```

Apply it to the test DB the way the repo's integration setup does (the `test:integration` script runs migrations; if the harness needs it applied manually, run the project's migrate step against the test DATABASE_URL — do NOT use the global `npx prisma` which is v7 and rejects the v6 schema; use the repo's `api` prisma: `npm run -w api prisma migrate deploy` equivalent already wired in CI, or `node_modules/.bin/prisma migrate deploy` from `api/`).

- [ ] **Step 4: Run it, verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Commit** — `git add api/prisma web-nothing api/test/integration/parts-upsert.spec.ts && git commit -m "feat(parts): add part_used.active soft-remove column"`

---

### Task 2: `PartsService.upsertPart` + `PUT /jobs/:id/parts/:partId` + shared schema

**Files:**
- Modify: `shared/src/job.ts` (after `partUsedInputSchema`, ~line 135)
- Modify: `api/src/jobs/parts.service.ts`
- Modify: `api/src/jobs/jobs.controller.ts` (after the `@Post(':jobId/parts')` handler, ~line 196)
- Test: `api/test/integration/parts-upsert.spec.ts` (extend)

**Interfaces:**
- Produces: `partUpsertInputSchema` = `{ partNo?: string|null, description: string, quantity: number>0, remarks?: string|null, active?: boolean }` (default `active: true`); `PartUpsertInput` type. `PartsService.upsertPart(jobId: string, partId: string, dto: PartUpsertInput, idempotencyKey: string|undefined, actor: ActorMeta, roles: string[]): Promise<PartUsed>`. Route `PUT /jobs/{jobId}/parts/{partId}` returns 200 with the `PartUsed` DTO.
- Consumes: `assertJobWritable`, `JobsService.loadForMutation`, `AuditEventService.record`, `IdempotencyService`, `toPartUsed` (all already used by `recordPart`).

- [ ] **Step 1: Write the failing tests** — add to `parts-upsert.spec.ts` (build the app like other integration specs — see `records-pdf.spec.ts` for `createTestApp`, `mintAccessToken`, `authHeader`). Cover create, update, soft-remove, edit-window rejection, idempotent replay:

```ts
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './helpers/app';
import { authHeader, mintAccessToken } from './helpers/test-auth';
import { createUser, grantRole } from './helpers/fixtures';

// inside describe, with app in beforeAll and a MAINTAINER token helper:
it('PUT creates a part with a client-supplied id', async () => {
  const { jobId, assignedTo } = await makeInProgressJobAssignedToMaintainer();
  const partId = randomUUID();
  const res = await request(app.getHttpServer())
    .put(`/api/v1/jobs/${jobId}/parts/${partId}`)
    .set(...authHeader(token))
    .set('Idempotency-Key', randomUUID())
    .send({ description: 'HEPA filter', quantity: 2, partNo: 'F-100' })
    .expect(200);
  expect(res.body.id).toBe(partId);
  expect(res.body.description).toBe('HEPA filter');
});

it('PUT updates the same part id', async () => {
  /* create as above, then PUT same partId with quantity:5, expect 200 + quantity 5,
     and assert exactly one row exists for that id in part_used. */
});

it('PUT active:false soft-removes (row stays, active=false, absent from GET job)', async () => {
  /* create, then PUT {..., active:false}; query part_used → active=false;
     GET /api/v1/jobs/:id → partsUsed does NOT contain partId (needs Task 3 filter). */
});

it('rejects a part edit when the job is not writable (e.g. submitted)', async () => {
  /* build a submitted job; PUT parts → expect 409/422 domain problem from assertJobWritable. */
});

it('is idempotent on replay with the same Idempotency-Key', async () => {
  /* PUT twice with same key+body → one row, identical response. */
});
```

Add a `makeInProgressJobAssignedToMaintainer()` local helper using `createJobFixture(jobNo,'in_progress',{assignedTo})` + `createUser`/`grantRole(...,'MAINTAINER')` + `mintAccessToken(app, uid, ['MAINTAINER'])` (mirror `records-pdf.spec.ts`).

- [ ] **Step 2: Run, verify fail** — `cd api && npm run test:integration -- parts-upsert`. Expected: FAIL (route 404 / `upsertPart` undefined).

- [ ] **Step 3: Implement.** In `shared/src/job.ts`:

```ts
export const partUpsertInputSchema = z.object({
  partNo: z.string().trim().min(1).nullable().optional(),
  description: z.string().trim().min(1),
  quantity: z.number().positive(),
  remarks: z.string().nullable().optional(),
  active: z.boolean().optional().default(true),
});
export type PartUpsertInput = z.infer<typeof partUpsertInputSchema>;
```

Export nothing else new (it flows through `shared/src/index.ts`'s `export * from './job'`). Build shared before the api typechecks: `npm run build -w shared`.

In `parts.service.ts`, add `upsertPart` modelled on `recordPart` but keyed by `partId` (create-or-update) and honouring `active`:

```ts
async upsertPart(
  jobId: string,
  partId: string,
  dto: PartUpsertInput,
  idempotencyKey: string | undefined,
  actor: ActorMeta,
  roles: string[],
): Promise<PartUsed> {
  let fingerprint: Buffer | undefined;
  if (idempotencyKey) {
    fingerprint = this.idempotency.fingerprint({ jobId, partId, ...dto });
    const replay = await this.idempotency.checkReplay(idempotencyKey, fingerprint, actor.actorId);
    if (replay) return replay.body as PartUsed;
  }
  const job = await this.jobs.loadForMutation(actor.actorId, roles, jobId);
  assertJobWritable(job.status);

  return this.prisma.$transaction(async (tx) => {
    const existing = await tx.partUsed.findUnique({ where: { id: partId } });
    // A part id belongs to exactly one job; a mismatched job is a client bug.
    if (existing && existing.jobId !== jobId) {
      throw notFoundProblem('Part', partId); // import from ../common/domain-problems
    }
    const row = await tx.partUsed.upsert({
      where: { id: partId },
      create: {
        id: partId, jobId,
        partNo: dto.partNo ?? null, description: dto.description,
        quantity: dto.quantity, remarks: dto.remarks ?? null,
        active: dto.active, recordedBy: actor.actorId,
      },
      update: {
        partNo: dto.partNo ?? null, description: dto.description,
        quantity: dto.quantity, remarks: dto.remarks ?? null,
        active: dto.active,
      },
    });
    await this.audit.record(tx, {
      actorId: actor.actorId,
      action: existing ? AuditActionT.update : AuditActionT.create,
      entityType: 'part_used',
      entityId: row.id,
      after: { partNo: row.partNo, description: row.description, quantity: row.quantity.toNumber(), active: row.active },
      sourceIp: actor.sourceIp, requestId: actor.requestId,
    });
    const dtoOut = toPartUsed(row);
    if (idempotencyKey && fingerprint) {
      await this.idempotency.recordWithin(tx,
        { key: idempotencyKey, userId: actor.actorId, endpoint: 'PUT /jobs/{jobId}/parts/{partId}', fingerprint },
        { status: 200, body: dtoOut });
    }
    return dtoOut;
  });
}
```

Add `import { notFoundProblem } from '../common/domain-problems';` if not present. In `jobs.controller.ts` add:

```ts
@Put(':jobId/parts/:partId')
@Roles(...JOB_RECORD_ROLES)
upsertPart(
  @Param('jobId') jobId: string,
  @Param('partId') partId: string,
  @Body(new ZodValidationPipe(partUpsertInputSchema)) dto: PartUpsertInput,
  @Headers('idempotency-key') idempotencyKey: string | undefined,
  @CurrentUser() user: AccessTokenClaims,
  @Req() req: Request,
) {
  return this.parts.upsertPart(jobId, partId, dto,
    idempotencyKey, { actorId: user.sub, ...requestMeta(req) }, user.roles);
}
```

Import `partUpsertInputSchema`, `type PartUpsertInput` from `@bamform/shared` and ensure `Put` is imported from `@nestjs/common` in the controller.

- [ ] **Step 4: Run, verify pass** — `npm run test:integration -- parts-upsert`. All pass (the `active:false` GET-absence assertion may still fail until Task 3 — if so, split that one assertion into Task 3; the create/update/idempotent/edit-window ones must pass here).

- [ ] **Step 5: Commit** — `git add shared api && git commit -m "feat(parts): PUT upsert endpoint with client-keyed id and soft-remove"`

---

### Task 3: Exclude soft-removed parts from every read/canonical/PDF path

**Files:**
- Modify: `api/src/jobs/job-include.ts:26` (`JOB_FULL_INCLUDE.partsUsed`)
- Test: `api/test/integration/parts-upsert.spec.ts` (the `active:false` GET-absence assertion) + `api/test/integration/records-pdf.spec.ts` (PDF excludes a removed part)

**Interfaces:**
- Consumes: nothing new. Produces: every consumer of `JOB_FULL_INCLUDE`/`JobFullRow` (reads, canonical in integrity/verification/submission/approval-transitions, PDF assembly, `toJob` mapper) now sees only `active=true` parts, with no per-consumer change.

- [ ] **Step 1: Write/enable the failing tests** — (a) enable the `active:false` GET-absence assertion from Task 2; (b) add to `records-pdf.spec.ts`: build an archived record, `PUT` a part then `PUT` it `active:false` BEFORE archiving, render the PDF, assert the removed part's description is ABSENT and a kept part's description is PRESENT. (Do the parts writes during `in_progress`, before submit/verify.)

- [ ] **Step 2: Run, verify fail** — the removed part still appears. `npm run test:integration -- parts-upsert records-pdf`.

- [ ] **Step 3: Implement** — in `job-include.ts` change:

```ts
  // Slice 30 — soft-removed parts (active=false) never reach a read, the
  // canonical signed record, or the PDF. One filter here covers every
  // JobFullRow consumer (DRY), same reasoning as the frozen-revision
  // items/measurements `where: { active: true }` above.
  partsUsed: { where: { active: true } },
```

(replaces `partsUsed: true,`).

- [ ] **Step 4: Run, verify pass** — `npm run test:integration -- parts-upsert records-pdf`. Also run the canonical/integrity specs to confirm the golden hash is unchanged: `npm run test:unit -- canonical` and `npm run test:integration -- records-integrity`. Expected: PASS, golden hash unchanged.

- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(parts): exclude soft-removed parts from reads, canonical and PDF"`

---

### Task 4: Offline sync route for the part upsert

**Files:**
- Modify: `api/src/sync/outbox-dispatch.ts` (the `OutboxRoute` union + `matchOutboxRoute` PUT branch)
- Modify: `api/src/sync/sync-outbox.service.ts` (the `switch (route.kind)`)
- Test: `api/src/sync/outbox-dispatch.spec.ts` + `api/test/integration/sync-outbox*.spec.ts` (find the existing sync-outbox integration spec and add a part-upsert case)

**Interfaces:**
- Consumes: `PartsService.upsertPart`, `partUpsertInputSchema`.
- Produces: `matchOutboxRoute('PUT', '/jobs/{id}/parts/{partId}')` → `{ kind: 'part-upsert', jobId, partId }`; sync dispatch applies it (status 200, applied true).

- [ ] **Step 1: Write failing tests** — in `outbox-dispatch.spec.ts` add:

```ts
it('matches PUT /jobs/{id}/parts/{partId} as a part upsert', () => {
  expect(matchOutboxRoute('PUT', '/jobs/J1/parts/P1'))
    .toEqual({ kind: 'part-upsert', jobId: 'J1', partId: 'P1' });
});
```

Plus an integration test in the existing sync-outbox spec: post an outbox batch containing a `PUT /jobs/{id}/parts/{partId}` mutation, assert `applied: true` and the part exists.

- [ ] **Step 2: Run, verify fail** — `cd api && npm run test:unit -- outbox-dispatch` (route match returns null today).

- [ ] **Step 3: Implement** — in `outbox-dispatch.ts` add to the union `| { kind: 'part-upsert'; jobId: string; partId: string }`, a `const PARTS_UPSERT_PATH = /^\/jobs\/([^/]+)\/parts\/([^/]+)$/;`, and in the `PUT` branch (before returning null):

```ts
const partUpsert = PARTS_UPSERT_PATH.exec(path);
if (partUpsert) return { kind: 'part-upsert', jobId: partUpsert[1], partId: partUpsert[2] };
```

In `sync-outbox.service.ts` add a case after `part`:

```ts
case 'part-upsert': {
  const dto = parseMutationBody(partUpsertInputSchema, mutation.body);
  await this.parts.upsertPart(route.jobId, route.partId, dto, mutation.id, actor, roles);
  return { id: mutation.id, status: 200, applied: true };
}
```

Import `partUpsertInputSchema`. Update the doc comment on `OutboxRoute` (the allow-list list) to include the new PUT parts route.

- [ ] **Step 4: Run, verify pass** — `npm run test:unit -- outbox-dispatch` and the sync-outbox integration spec. PASS.

- [ ] **Step 5: Commit** — `git add api && git commit -m "feat(sync): replay PUT /jobs/{id}/parts/{partId} through the offline outbox"`

---

### Task 5: OpenAPI + contract route declaration

**Files:**
- Modify: `api/openapi.yaml` (add the `put` on `/jobs/{jobId}/parts/{partId}`)
- Modify: `api/test/contract/route-roles.ts` (declare the route's roles = `JOB_RECORD_ROLES`)
- Test: `api/test/contract/contract.spec.ts` (existing gate — no new test authored; it must stay green)

**Interfaces:**
- Consumes: the route from Task 2. Produces: contract job (5) passes with the route present.

- [ ] **Step 1: Run the contract test to see it fail** — `cd api && npm run test:contract`. Expected: FAIL (route implemented but undocumented / not in route inventory).

- [ ] **Step 2: Add the OpenAPI path.** Under `/jobs/{jobId}/parts/{partId}` add a `put` mirroring the existing `POST /jobs/{jobId}/parts` operation (request body `PartUpsertInput` — add that schema alongside `PartUsedInput` with the extra `active` boolean; response 200 `PartUsed`; `Idempotency-Key` header; same security/roles). Match the surrounding YAML style exactly.

- [ ] **Step 3: Declare the route roles** in `route-roles.ts`: add `PUT /jobs/{jobId}/parts/{partId}` → the same role set as `POST /jobs/{jobId}/parts` (`JOB_RECORD_ROLES`). Check `api/test/contract/known-gaps.ts` — remove any entry that would now be a false gap.

- [ ] **Step 4: Run, verify pass** — `npm run test:contract`. PASS.

- [ ] **Step 5: Commit** — `git add api && git commit -m "docs(api): document PUT /jobs/{id}/parts/{partId} in openapi + contract"`

---

### Task 6: Web — Parts Used capture section in RecordCapture

**Files:**
- Modify: `web/src/screens/RecordCapture.tsx`
- Test: `web/src/screens/RecordCapture.parts.test.tsx` (new) — or extend the existing RecordCapture test if there is one; check `web/src/screens/` for `RecordCapture*.test.tsx`.

**Interfaces:**
- Consumes: `appendJobMutation` (`web/src/offline/sync-engine.ts:182`), `uuidv7` (`web/src/lib/uuidv7.ts`), the cached job's `partsUsed` (`cached.job.partsUsed`, shape `PartUsed`). Produces: outbox entries `PUT /jobs/{jobId}/parts/{partId}` with body `{ partNo, description, quantity, remarks, active, clientRecordedAt }`.

- [ ] **Step 1: Write failing component tests** — new `RecordCapture.parts.test.tsx`. Mirror the existing RecordCapture test setup (mock services/db; look at how item/measurement capture is tested). Assertions:
  - Adding a part (fill description + quantity, submit the row) calls `appendJobMutation` with `method:'PUT'`, `path` matching `/jobs/<jobId>/parts/<uuid>`, body containing the entered `description`/`quantity` and `active:true`.
  - Editing an existing part re-enqueues a `PUT` to the SAME `partId` with the new values.
  - Removing a part enqueues a `PUT` to that `partId` with `active:false`, and the row disappears from the list.
  - Existing parts from `cached.job.partsUsed` render on load.

- [ ] **Step 2: Run, verify fail** — `cd web && npm test -- RecordCapture.parts`. Expected: FAIL (no parts UI).

- [ ] **Step 3: Implement** — add a `Parts Used` section to `RecordCapture.tsx`, following the photos-staging and item/measurement patterns already in the file:
  - Local state `const [parts, setParts] = useState<PartRow[]>([])` where `PartRow = { id: string; partNo: string; description: string; quantity: string; remarks: string }`. Hydrate from `cached.job.partsUsed` in the same effect that hydrates `itemResults`/`readings` (~line 166).
  - An "Add part" control that creates a row with `id: uuidv7()` and, on confirm, calls:
    ```ts
    await appendJobMutation(db, {
      userId, jobId, method: 'PUT', path: `/jobs/${jobId}/parts/${part.id}`,
      body: { partNo: part.partNo || null, description: part.description,
              quantity: Number(part.quantity), remarks: part.remarks || null,
              active: true, clientRecordedAt: new Date().toISOString() },
      clientRecordedAt: new Date().toISOString(),
    });
    ```
  - Edit re-enqueues the same shape to the same `part.id`.
  - Remove enqueues the same shape with `active: false` and drops the row from local state.
  - Gate the section to the writable window (only render add/edit/remove controls when the job is `assigned`/`in_progress`, consistent with how the item/measurement inputs are gated).
  - Respect quota handling: `appendJobMutation` returns an `AppendResult`; on `{ ok:false, reason:'quota-exceeded' }` set the existing `quotaBanner`, exactly as the item/measurement handlers do — never show the part as saved if the outbox write failed (non-negotiable #1).
  - Follow `web/DESIGN.md` component styling; match the existing sections' markup/aria.

- [ ] **Step 4: Run, verify pass** — `cd web && npm test -- RecordCapture.parts`. Also run the full web unit suite `npm test` and typecheck/build (`npm run build`). PASS.

- [ ] **Step 5: Commit** — `git add web && git commit -m "feat(web): parts-used capture UI with offline add/edit/remove"`

---

### Task 7: End-to-end — capture a part offline, sync, it lands on the record

**Files:**
- Test: extend `api/test/integration/records-pdf.spec.ts` OR the Playwright journey suite (`web` e2e) — prefer the api integration path (cheaper, deterministic) unless a Playwright parts journey is warranted.

**Interfaces:**
- Consumes everything above.

- [ ] **Step 1: Write the test** — through the REAL sync path: post an outbox batch to `POST /api/v1/sync/outbox` containing a `PUT /jobs/{id}/parts/{partId}` mutation for an in-progress job, then drive the job to archived, render the PDF, and assert the part appears in the `Parts Used` section. (This proves the offline dispatch → canonical → PDF chain end to end.)

- [ ] **Step 2: Run, verify it exercises the whole chain** — `cd api && npm run test:integration -- records-pdf`. It should pass once Tasks 1–4 are in.

- [ ] **Step 3–5:** If it reveals a gap, fix in the owning task; then commit `test(parts): e2e offline part capture reaches the signed PDF`.

---

## Verification before done

- [ ] Run the full api unit + integration + contract suites and the web unit suite locally (integration may need `--max-old-space-size=4096`).
- [ ] Confirm golden hash U-SIG-01 is UNCHANGED (Slice A adds no canonical field).
- [ ] Opus review of the whole branch before merge (per standing flow).
- [ ] Merge to main; confirm all CI jobs green; verify `=== Deploy OK: <sha> ===` on box 165 and prod health.

## Self-review notes (author)

- Spec coverage: Slice A of the design spec §4 — every element (edit/soft-remove via UPDATE+active flag, offline via outbox, exclude removed from signed record, edit-window guard) has a task. Special Tools (Slice B) is a separate plan.
- The client-keyed `PUT` upsert is a deliberate refinement over the spec's "POST add + PUT edit" wording: it is the only clean way to make an offline-added part editable/removable before its first sync, and it mirrors the existing item/measurement upsert contract. The existing `POST /jobs/{id}/parts` and its `kind:'part'` sync case are left intact (unused by the new UI) to avoid disturbing their tests.
- Type consistency: `partUpsertInputSchema`/`PartUpsertInput`, `upsertPart`, `part-upsert` route kind, and the `PUT /jobs/{jobId}/parts/{partId}` path are used identically across Tasks 2, 4, 5, 6, 7.
