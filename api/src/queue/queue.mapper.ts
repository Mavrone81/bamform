import type { QueueEntry } from '@bamform/shared';
import { toJobSummary } from '../jobs/mappers';
import type { JobSummaryRow } from '../jobs/job-include';

const MS_PER_HOUR = 3_600_000;

/**
 * `submittedByName` is deliberately OMITTED (left `undefined`, an optional
 * field) — same established convention `jobs/mappers.ts` documents for
 * `assignedToName` etc: no read path through slice 10 decrypts `app_user`
 * names for a COLLECTION response (only the single-entity `CurrentUser`/
 * `Delegation` read paths do, see `delegations.mapper.ts`'s doc comment).
 * Wiring per-row name decryption into a collection endpoint is the
 * verifier-queue UI's concern (slice 11b), not this backend slice.
 */
/**
 * Slice 26-TWOSTAGE — the stage this entry is waiting at, resolved by the
 * caller (`QueueService`) from the same stage map it uses to decide
 * eligibility. Passed in rather than looked up here so the mapper stays a
 * pure function of its inputs, like every other field it maps.
 */
export interface QueueEntryStage {
  ordinal: number;
  label: string;
  /** Total stages on the record's route — lets a client say "1 of 2". */
  count: number;
}

export function toQueueEntry(
  row: JobSummaryRow & { submittedAt: Date | null },
  onBehalfOf: string | null,
  now: Date,
  escalatedDisplayThresholdHours: number,
  stage: QueueEntryStage,
): QueueEntry {
  if (!row.submittedAt) {
    throw new Error(
      `Job ${row.id} appears in a verification queue but has no submittedAt — data invariant violation (a SUBMITTED job must have submittedAt set).`,
    );
  }
  const summary = toJobSummary(row, now);
  const ageHours = (now.getTime() - row.submittedAt.getTime()) / MS_PER_HOUR;
  return {
    ...summary,
    submittedAt: row.submittedAt.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    escalated: ageHours >= escalatedDisplayThresholdHours,
    onBehalfOf,
    stageOrdinal: stage.ordinal,
    stageCount: stage.count,
    stageLabel: stage.label,
  };
}
