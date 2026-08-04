import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { UserStatusT, type Prisma } from '@prisma/client';
import type { AssigneeEligibilityT, AssignableUser } from '@bamform/shared';
import { decodeIdentityField } from '../auth/crypto/identity-codec';
import { AreaScopeService } from '../common/area-scope';
import { validationFailedProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { FIELD_ENCRYPTION_SERVICE } from '../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_RECORD_ROLES } from './job-access';

/**
 * THE THREE-WAY VERDICT — review finding, slice 32-PLANNERJOB.
 *
 * Assignability used to be a boolean, and that was a fail-soft defect. The
 * check reads three tables; when one of those reads FAILS (a dropped
 * connection, a statement timeout), a boolean has nowhere to put "I could not
 * tell" and the answer collapses into `false` — indistinguishable from a
 * technician who genuinely lost their role.
 *
 * That mattered because the consequences are asymmetric and one of them is
 * PERMANENT. On the sweep path a `false` writes `defaultAssigneeUnavailable:
 * true` into the job's creation audit event, which is append-only, hash-
 * chained and kept seven years — so a two-second database blip would have left
 * a permanent, unfalsifiable record asserting that a named person was no
 * longer eligible, and told the planner to go and fix a role grant that was
 * never broken.
 *
 *   'assignable'     — the check ran and passed.
 *   'not-assignable' — the check ran and REFUSED. A fact about the person.
 *   'unknown'        — the check could not be completed. A fact about the
 *                      SYSTEM, and never recorded as if it were about the
 *                      person.
 *
 * Same class of bug as the swallowed Prisma error on
 * `fix/archived-record-immutability`: a `catch` written for one failure mode
 * silently absorbing another.
 */
export type AssigneeVerdict = AssigneeEligibilityT;

/** The outcome of one eligibility check, with the reason where there is one. */
export interface AssigneeCheck {
  verdict: AssigneeVerdict;
  /**
   * For `'not-assignable'`, the server's own refusal text (which of the three
   * conditions failed). For `'unknown'`, what went wrong instead. Never shown
   * to a planner as a cause when the verdict is `'unknown'`.
   */
  detail: string | null;
}

/** One user, evaluated against one area. */
export interface AssigneeEligibility {
  fullName: string;
  verdict: AssigneeVerdict;
}

/**
 * WHO MAY BE GIVEN MAINTENANCE WORK — slice 32-PLANNERJOB.
 *
 * ONE RULE, THREE CALLERS. Assignment now happens at two levels and is
 * checked at three moments, and every one of them has to mean the same thing
 * or a planner gets a refusal they cannot explain:
 *
 *   1. `POST /jobs/{jobId}/assign` and `POST /jobs/adhoc` — assign or
 *      reassign ONE occurrence (`AssignmentService`, `AdhocJobService`).
 *   2. `PUT /schedule/{scheduleRuleId}/default-assignee` — set who NORMALLY
 *      does a machine's PM (`PlannerScheduleService`).
 *   3. `JobGenerationService`, at the moment a job is created from a rule
 *      carrying a default — because eligibility can lapse between (2) and
 *      (3) and usually will: people leave, roles are revoked, area scopes are
 *      narrowed.
 *
 * THE RULE. The assignee must be able to actually WORK the job, or the
 * assignment is a dead end by construction:
 *   * ACTIVE — a deactivated account is refused at login (slice 13a).
 *   * HOLDS A RESULT-RECORDING ROLE (MAINTAINER/TEAM_LEADER/ENGINEER,
 *     API_SPECIFICATION.md §4.1) — result capture is `@Roles(JOB_RECORD_ROLES)`.
 *   * AREA SCOPE REACHES THE MACHINE — an area-scoped user cannot even open
 *     an out-of-scope job (`JobAccessService`, PR-API-10). A user with NO
 *     active scope rows is unrestricted; a machine with NO area is therefore
 *     assignable only to unrestricted users, which is what the area check
 *     below does with its null branch.
 *
 * `list` and `assert` are the SAME predicate expressed twice — once as SQL,
 * once as a check — which is exactly the kind of duplication that rots. It is
 * held together by `assignable-users.spec.ts`, which feeds the list's own
 * output back through `POST /assign` and requires every row to be accepted
 * and a deliberately-excluded user to be refused.
 */
@Injectable()
export class AssignableUserService {
  private readonly logger = new Logger(AssignableUserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly areaScope: AreaScopeService,
    @Inject(FIELD_ENCRYPTION_SERVICE) private readonly fieldEncryption: FieldEncryptionService,
  ) {}

  /**
   * Throws 422 `validation-failed` naming WHICH of the three conditions
   * failed. All three are 422 rather than 403: they are a defect in the
   * CHOSEN ASSIGNEE, not an authorisation failure of the caller.
   */
  async assertAssignable(assigneeId: string, areaId: string | null): Promise<void> {
    const assignee = await this.prisma.appUser.findUnique({
      where: { id: assigneeId },
      include: { userRoles: { where: { active: true }, include: { role: true } } },
    });
    if (!assignee || assignee.status !== UserStatusT.active) {
      throw validationFailedProblem('assigneeId does not name an active user.');
    }
    const roleCodes = assignee.userRoles.map((userRole) => userRole.role.code);
    if (!roleCodes.some((code) => JOB_RECORD_ROLES.includes(code))) {
      throw validationFailedProblem(
        'The assignee holds no role that can record results (MAINTAINER/TEAM_LEADER/ENGINEER — API_SPECIFICATION.md §4.1).',
      );
    }
    const assigneeAreaIds = await this.areaScope.getAllowedAreaIds(assigneeId);
    if (assigneeAreaIds !== null && (!areaId || !assigneeAreaIds.includes(areaId))) {
      throw validationFailedProblem(
        "The assignee's area scope does not include this job's area — they could never open it (PR-API-10).",
      );
    }
  }

  /**
   * The NON-THROWING form, for the places that must REPORT rather than refuse:
   * `JobGenerationService` (which generates unassigned rather than failing —
   * see its own note) and the planner grid.
   *
   * IT NEVER THROWS, because the sweep runs unattended over every rule in the
   * plant and one bad row must not abort the run. But it never LIES either:
   * only a domain refusal (`HttpException` — `assertAssignable`'s own 422)
   * becomes `'not-assignable'`. Anything else is the check FAILING rather than
   * the person failing it, and is reported as `'unknown'` so the caller can
   * say so instead of inventing a cause. See `AssigneeVerdict`.
   *
   * Never use this to gate a write. `assertAssignable` above is the gate; it
   * names the reason and lets infrastructure errors propagate, which is
   * correct for a request a human is waiting on.
   */
  async checkAssignable(assigneeId: string, areaId: string | null): Promise<AssigneeCheck> {
    try {
      await this.assertAssignable(assigneeId, areaId);
      return { verdict: 'assignable', detail: null };
    } catch (error) {
      // `assertAssignable` raises `validationFailedProblem`, an
      // `UnprocessableEntityException`. Narrowing on `HttpException` — rather
      // than on "anything thrown" — is the whole fix: a Prisma connection
      // error, a statement timeout or a decrypt failure is NOT a verdict about
      // this person and must never be recorded as one.
      if (error instanceof HttpException) {
        const body = error.getResponse();
        const detail =
          typeof body === 'object' && body !== null && 'detail' in body
            ? String((body as { detail: unknown }).detail)
            : error.message;
        return { verdict: 'not-assignable', detail };
      }
      const detail = describeThrown(error);
      this.logger.error(
        `could not determine whether ${assigneeId} may be assigned in area ${areaId ?? 'none'}: ` +
          `${detail}. Reporting 'unknown' — this is NOT a finding about the user.`,
      );
      return { verdict: 'unknown', detail };
    }
  }

  /**
   * Every user `assertAssignable` would accept for `areaId`, as the picker
   * needs them — the standard cursor page (PR-API-14/15).
   *
   * The area rule is expressed in SQL rather than filtered afterwards, so the
   * page size means what it says: filtering a fetched page in memory would
   * silently return fewer than `limit` rows and make `hasMore` a lie.
   */
  async list(areaId: string | null, query: { limit?: unknown; cursor?: string }) {
    const limit = normaliseLimit(query.limit);
    const afterId = decodeCursor(query.cursor);

    const candidates = await this.prisma.appUser.findMany({
      where: {
        status: UserStatusT.active,
        userRoles: { some: { active: true, role: { code: { in: JOB_RECORD_ROLES } } } },
        ...areaScopeReaches(areaId),
        id: afterId ? { gt: afterId } : undefined,
      },
      include: { userRoles: { where: { active: true }, include: { role: true } } },
      // `id ASC` is the cursor key, as in every other paginated read here
      // (PR-API-14: every id is a UUIDv7).
      orderBy: { id: 'asc' },
      take: limit + 1,
    });

    const page = paginate(candidates, limit);
    return {
      data: page.data.map((user) => ({
        id: user.id,
        fullName: this.nameOf(user.id, user.fullNameCt, user.dekVersion),
        // Only the roles that put them on this list. The caller has no reason
        // to learn that a technician also happens to hold AUDITOR.
        roles: user.userRoles
          .map((userRole) => userRole.role.code)
          .filter((code) => JOB_RECORD_ROLES.includes(code))
          .sort(),
      })),
      page: page.page,
    } satisfies Page<AssignableUser>;
  }

  /**
   * The BATCH form, for the planner grid: name and verdict for a set of
   * (user, area) pairs in a bounded number of queries rather than one pair at
   * a time. Keyed `userId|areaId` — the same user can be assignable for one
   * machine's area and not another's.
   *
   * It exists because the grid must be able to say "this schedule will
   * generate UNASSIGNED work" BEFORE the sweep proves it, and doing that with
   * `checkAssignable` per row would be 220 round trips to draw one screen.
   *
   * IT DEGRADES RATHER THAN DISAPPEARING. If the lookup fails, every pair is
   * reported `'unknown'` instead of the error propagating: losing the whole
   * year's plan because a supporting query blipped would be a far worse
   * outcome than drawing it with "could not check who normally does this" on
   * the affected lines. The grid's own rules query has already succeeded by
   * this point, so the plan itself is sound.
   *
   * It never reports `'not-assignable'` for a reason it did not actually
   * establish — same rule as `checkAssignable`.
   */
  async resolveEligibility(
    pairs: readonly { userId: string; areaId: string | null }[],
  ): Promise<Map<string, AssigneeEligibility>> {
    const resolved = new Map<string, AssigneeEligibility>();
    const userIds = [...new Set(pairs.map((pair) => pair.userId))];
    if (userIds.length === 0) return resolved;

    let users: Awaited<ReturnType<typeof this.findEligibilityRows>>;
    try {
      users = await this.findEligibilityRows(userIds);
    } catch (error) {
      this.logger.error(
        `could not resolve standing-assignee eligibility for ${userIds.length} user(s): ` +
          `${describeThrown(error)}. Reporting 'unknown' for all of them — this is NOT a finding ` +
          'about them.',
      );
      for (const pair of pairs) {
        resolved.set(eligibilityKey(pair.userId, pair.areaId), {
          // No name either: it comes from the same row the lookup failed to
          // read, and inventing one would be a second untruth.
          fullName: 'Unknown',
          verdict: 'unknown',
        });
      }
      return resolved;
    }
    const byId = new Map(users.map((user) => [user.id, user]));

    for (const pair of pairs) {
      const user = byId.get(pair.userId);
      // A default assignee whose row has vanished cannot happen (the FK is
      // RESTRICT and nothing in this system deletes an `app_user`, INV-16),
      // so this is a guard against a hand-edited database, not a branch the
      // application reaches. Reported as ineligible with no name rather than
      // crashing a whole page of the plan.
      if (!user) {
        resolved.set(eligibilityKey(pair.userId, pair.areaId), {
          fullName: 'Unknown user',
          // 'unknown', NOT 'not-assignable'. A missing row is a fact about the
          // DATABASE, and reporting it as ineligibility would tell a planner
          // that a named person had lost their role.
          verdict: 'unknown',
        });
        continue;
      }
      const roleCodes: string[] = user.userRoles.map((userRole) => userRole.role.code);
      // The same three conditions as `assertAssignable`, in the same order.
      // `userAreaScopes` is already filtered to active rows, so an empty
      // array IS "unrestricted" (PR-API-10's read-side convention).
      const eligible =
        user.status === UserStatusT.active &&
        roleCodes.some((code) => JOB_RECORD_ROLES.includes(code)) &&
        (user.userAreaScopes.length === 0 ||
          (pair.areaId !== null &&
            user.userAreaScopes.some((scope) => scope.areaId === pair.areaId)));

      resolved.set(eligibilityKey(pair.userId, pair.areaId), {
        fullName: this.nameOf(user.id, user.fullNameCt, user.dekVersion),
        verdict: eligible ? 'assignable' : 'not-assignable',
      });
    }
    return resolved;
  }

  /** The one query `resolveEligibility` makes — extracted so its failure has
   * a single, catchable seam. */
  private findEligibilityRows(userIds: string[]) {
    return this.prisma.appUser.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        status: true,
        fullNameCt: true,
        dekVersion: true,
        userRoles: { where: { active: true }, select: { role: { select: { code: true } } } },
        userAreaScopes: { where: { active: true }, select: { areaId: true } },
      },
    });
  }

  /**
   * `app_user.full_name` is application-layer encrypted (DBD §6.2). Decoded
   * through the SAME helper `users.mapper.ts#toUser` uses — never a second
   * codec, and never into an audit payload (PR-SEC-02: those carry a
   * ciphertext digest, see `toUserAuditView`).
   */
  private nameOf(userId: string, fullNameCt: Uint8Array, dekVersion: number): string {
    return decodeIdentityField(
      fullNameCt,
      dekVersion,
      { column: 'full_name_ct', rowId: userId },
      this.fieldEncryption,
    );
  }
}

/**
 * A message for something thrown, WITHOUT assuming it is an `Error`.
 *
 * `(error as Error).message` is the idiom everywhere else in this codebase and
 * is fine in a request handler, where a `TypeError` from a `throw null` simply
 * becomes a 500. It is NOT fine in `checkAssignable`, whose whole contract is
 * that it never throws: the scheduler sweep runs unattended over every rule in
 * the plant, and a handler that blew up while REPORTING a failure would abort
 * the run and leave the rest of the plant's PM unraised. Caught by
 * `assignable-user.service.spec.ts`, which throws a bare `null` at it.
 */
function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return 'a non-serialisable value was thrown';
  }
}

/** The map key for `resolveEligibility` — a user is judged PER AREA. */
export function eligibilityKey(userId: string, areaId: string | null): string {
  return `${userId}|${areaId ?? ''}`;
}

/**
 * The area half of the rule, as a Prisma `where` fragment: unrestricted (no
 * active `user_area_scope` rows) OR holding an active scope on this area.
 * A machine with no area at all is reachable only by unrestricted users —
 * `assertAssignable`'s `!areaId` branch, said in SQL.
 */
function areaScopeReaches(areaId: string | null): Prisma.AppUserWhereInput {
  if (!areaId) {
    return { userAreaScopes: { none: { active: true } } };
  }
  return {
    OR: [
      { userAreaScopes: { none: { active: true } } },
      { userAreaScopes: { some: { active: true, areaId } } },
    ],
  };
}
