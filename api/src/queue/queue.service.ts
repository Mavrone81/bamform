import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { QueueEntry } from '@bamform/shared';
import { AreaScopeService } from '../common/area-scope';
import { decodeCursor, encodeCursor, normaliseLimit, type Page } from '../common/pagination';
import { DelegationsRepository } from '../delegations/delegations.repository';
import type { JobSummaryRow } from '../jobs/job-include';
import { toQueueEntry } from './queue.mapper';
import { QueueRepository } from './queue.repository';

export interface GetQueueParams {
  limit?: unknown;
  cursor?: string;
}

interface TaggedEntry {
  row: JobSummaryRow;
  onBehalfOf: string | null;
}

const DEFAULT_ESCALATION_DISPLAY_HOURS = 72;

/**
 * PR-073/076/081/UR-049 — `GET /queue`: the caller's verification queue
 * PLUS any active delegator's, resolved at REQUEST TIME (PR-076 — never
 * cached, never derived from the JWT). A job qualifies for an identity's
 * (caller's, or an active delegator's) queue when: `SUBMITTED`, that
 * identity is not the submitter, that identity holds a role satisfying the
 * job's CURRENT stage, and the job's area is within that identity's scope
 * (or they are unrestricted) — PR-073, applied per-identity, not just the
 * caller.
 */
@Injectable()
export class QueueService {
  constructor(
    private readonly repo: QueueRepository,
    private readonly areaScope: AreaScopeService,
    private readonly delegations: DelegationsRepository,
    private readonly config: ConfigService,
  ) {}

  async getQueue(userId: string, params: GetQueueParams): Promise<Page<QueueEntry>> {
    const now = new Date();
    const limit = normaliseLimit(params.limit);
    // Display-only "looks overdue" hint on a queue entry (QueueEntry.escalated)
    // — INDEPENDENT of whether a BullMQ escalation notification is actually
    // scheduled for a given job (that is driven by `approval_stage.escalation_hours`,
    // which is per-stage and NULL by default — see `notifications/escalation.service.ts`'s
    // doc comment for why these two are deliberately different numbers).
    const escalationDisplayHours = Number(
      this.config.get('VERIFICATION_ESCALATION_HOURS') ?? DEFAULT_ESCALATION_DISPLAY_HOURS,
    );

    const stageMap = await this.repo.getStageRoleMap();

    const ownRoles = await this.repo.getUserRoleCodes(userId);
    const ownEntries = await this.eligibleEntriesFor(userId, ownRoles, stageMap, null);

    const activeDelegators = await this.delegations.findActiveDelegatorsFor(userId, now);
    const delegatedEntryLists = await Promise.all(
      activeDelegators.map(async ({ delegatorId }) => {
        const delegatorRoles = await this.repo.getUserRoleCodes(delegatorId);
        return this.eligibleEntriesFor(delegatorId, delegatorRoles, stageMap, delegatorId);
      }),
    );

    const merged = dedupeById([...ownEntries, ...delegatedEntryLists.flat()]);
    merged.sort((a, b) => (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));

    const cursor = decodeCursor(params.cursor);
    const afterCursor = cursor ? merged.filter((entry) => entry.row.id > cursor) : merged;

    const hasMore = afterCursor.length > limit;
    const page = hasMore ? afterCursor.slice(0, limit) : afterCursor;
    const nextCursor = hasMore ? encodeCursor(page[page.length - 1].row.id) : null;

    return {
      data: page.map((entry) =>
        toQueueEntry(entry.row, entry.onBehalfOf, now, escalationDisplayHours),
      ),
      page: { nextCursor, hasMore, limit },
    };
  }

  /** PR-073 eligibility for ONE identity (the caller, or one of their active delegators). */
  private async eligibleEntriesFor(
    identityUserId: string,
    identityRoles: string[],
    stageMap: Map<string, string[]>,
    onBehalfOf: string | null,
  ): Promise<TaggedEntry[]> {
    if (identityRoles.length === 0) {
      return [];
    }
    const allowedAreaIds = await this.areaScope.getAllowedAreaIds(identityUserId);
    const candidates = await this.repo.findCandidateSubmittedJobs(identityUserId, allowedAreaIds);
    return candidates
      .filter((row) => {
        if (row.currentStageOrdinal == null) return false;
        const roleCodes = stageMap.get(`${row.approvalRouteId}:${row.currentStageOrdinal}`) ?? [];
        return roleCodes.some((code) => identityRoles.includes(code));
      })
      .map((row) => ({ row, onBehalfOf }));
  }
}

/** First occurrence wins (own-eligibility entries are listed before delegated ones — see `getQueue`). */
function dedupeById(entries: TaggedEntry[]): TaggedEntry[] {
  const seen = new Set<string>();
  const result: TaggedEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.row.id)) continue;
    seen.add(entry.row.id);
    result.push(entry);
  }
  return result;
}
