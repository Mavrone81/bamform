import { CanonicalDecimal, type CanonicalValue } from '../crypto/canonical-serialiser';

/**
 * PR-093/ADR-010 — builds the canonical record `record-signer.ts` signs for
 * `POST /jobs/{id}/verify|return|recall|void` and `GET /records/{id}
 * /integrity` recomputes. Deliberately a PLAIN, Prisma-independent shape (no
 * `@prisma/client` row types) so it stays directly unit-testable and so the
 * exact same builder can be called both at signing time (inside the
 * transaction, using the just-inserted `approvalStep`) and at verification
 * time (`IntegrityService`, re-deriving the same input from current data).
 *
 * Uses `CanonicalDecimal` (the slice-3 HARD GATE resolution,
 * `canonical-serialiser.ts`) for every NUMERIC-backed reading — never a JS
 * `number` — so a >15-significant-digit `measurement_result.reading_numeric`
 * (NUMERIC(18,6)) signs losslessly.
 *
 * Array order is APPLICATION-SIGNIFICANT in canonical serialisation (see
 * `canonical-serialiser.ts` rule 3) — every array below is sorted by a
 * stable natural key (UUIDv7 `id`, itself time-ordered) so the SAME logical
 * record hashes identically regardless of the order a caller's query
 * happened to return rows in.
 */

export interface CanonicalJobInput {
  id: string;
  jobNumber: string;
  assetId: string;
  templateRevisionId: string;
  frequency: string;
  /** Uppercase API status at the moment of signing (e.g. 'ARCHIVED' on the final verify — PR-042). */
  status: string;
}

export interface CanonicalTemplateRevisionInput {
  id: string;
  formTemplateId: string;
  revisionCode: string;
  sequenceOrdinal: number;
}

export interface CanonicalSubmitterInput {
  userId: string | null;
  submittedAt: Date | null;
}

export interface CanonicalItemResultInput {
  id: string;
  templateItemId: string;
  status: string;
  remark: string | null;
}

export interface CanonicalMeasurementResultInput {
  id: string;
  templateMeasurementId: string;
  /** Raw decimal digit string straight from Postgres (e.g. Prisma `Decimal#toString()`) — NEVER a JS number. */
  readingNumeric: string | null;
  readingText: string | null;
  judgement: string;
}

export interface CanonicalPartUsedInput {
  id: string;
  partNo: string | null;
  description: string;
  /** Raw decimal digit string — NEVER a JS number (same reason as `readingNumeric`). */
  quantity: string;
}

export interface CanonicalAttachmentInput {
  id: string;
  sha256Hex: string;
}

export interface CanonicalApprovalStepInput {
  id: string;
  stageOrdinal: number;
  action: string;
  actorId: string;
  onBehalfOfId: string | null;
  reason: string | null;
  actedAt: Date;
}

export interface CanonicalJobRecordInput {
  job: CanonicalJobInput;
  templateRevision: CanonicalTemplateRevisionInput;
  submitter: CanonicalSubmitterInput;
  itemResults: CanonicalItemResultInput[];
  measurementResults: CanonicalMeasurementResultInput[];
  partsUsed: CanonicalPartUsedInput[];
  attachments: CanonicalAttachmentInput[];
  /**
   * EVERY approval_step for this job as of the moment of signing, INCLUDING
   * the one currently being created — binding the signature to itself (its
   * own actor/stage/timestamp), so a signature can never be replayed under a
   * different approval_step identity.
   *
   * ##### STANDING INTEGRITY GAP — READ BEFORE RELYING ON "TAMPER-EVIDENT" #####
   * What is committed here is exactly `{id, stageOrdinal, action, actorId,
   * onBehalfOfId, reason, actedAt}`. So the signed content binds an approval
   * step's IDENTITY, TIME and EXISTENCE — and nothing else. Measured by the
   * slice-18-WORKFLOW review (finding X-5), mutating a step directly in the
   * database and re-running `GET /records/{id}/integrity`:
   *
   *   actor_id changed ............... DETECTED
   *   acted_at changed ............... DETECTED
   *   row deleted .................... DETECTED
   *   actor_role_code changed ........ NOT DETECTED
   *   drawn_signature_ct := NULL ..... NOT DETECTED
   *   drawn_signature_ct := garbage .. NOT DETECTED
   *   source_ip changed .............. NOT DETECTED
   *
   * Consequence to state plainly: an archived record can be made to print
   * WITHOUT a signatory's drawn signature (or under a rewritten role) while
   * `/integrity` still certifies it `intact: true`. Field encryption does not
   * close this — its AAD row-binding (`field-encryption.ts`) makes a
   * ciphertext moved between rows undecryptable, which prevents a SWAP but
   * does not make an ERASURE detectable.
   *
   * This is pre-existing and system-wide (slice 7 built verifier signatures
   * the same way); slice 18-WORKFLOW extended it to the performer signature
   * without widening it. Closing it means adding `drawnSignatureSha256` and
   * `actorRoleCode` to `CanonicalApprovalStepInput` — which CHANGES THE SIGNED
   * CONTENT'S KEY SET, invalidating every stored signature on every existing
   * record. That is an owner-visible migration of its own, not a tidy-up: do
   * not do it as a side effect of another slice.
   */
  approvalSteps: CanonicalApprovalStepInput[];
}

function byId<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function buildCanonicalJobRecord(input: CanonicalJobRecordInput): CanonicalValue {
  return {
    job: {
      id: input.job.id,
      jobNumber: input.job.jobNumber,
      assetId: input.job.assetId,
      templateRevisionId: input.job.templateRevisionId,
      frequency: input.job.frequency,
      status: input.job.status,
    },
    templateRevision: {
      id: input.templateRevision.id,
      formTemplateId: input.templateRevision.formTemplateId,
      revisionCode: input.templateRevision.revisionCode,
      sequenceOrdinal: input.templateRevision.sequenceOrdinal,
    },
    submitter: {
      userId: input.submitter.userId,
      submittedAt: input.submitter.submittedAt ?? null,
    },
    itemResults: byId(input.itemResults).map((r) => ({
      id: r.id,
      templateItemId: r.templateItemId,
      status: r.status,
      remark: r.remark,
    })),
    measurementResults: byId(input.measurementResults).map((r) => ({
      id: r.id,
      templateMeasurementId: r.templateMeasurementId,
      reading:
        r.readingNumeric !== null
          ? new CanonicalDecimal(r.readingNumeric)
          : (r.readingText ?? null),
      judgement: r.judgement,
    })),
    partsUsed: byId(input.partsUsed).map((p) => ({
      id: p.id,
      partNo: p.partNo,
      description: p.description,
      quantity: new CanonicalDecimal(p.quantity),
    })),
    attachments: byId(input.attachments).map((a) => ({ id: a.id, sha256: a.sha256Hex })),
    approvalSteps: byId(input.approvalSteps).map((s) => ({
      id: s.id,
      stageOrdinal: s.stageOrdinal,
      action: s.action,
      actorId: s.actorId,
      onBehalfOfId: s.onBehalfOfId,
      reason: s.reason,
      actedAt: s.actedAt,
    })),
  };
}
