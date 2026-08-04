import { Inject, Injectable } from '@nestjs/common';
import { UserStatusT, type Prisma } from '@prisma/client';
import type { AssignableUser } from '@bamform/shared';
import { decodeIdentityField } from '../auth/crypto/identity-codec';
import { AreaScopeService } from '../common/area-scope';
import { validationFailedProblem } from '../common/domain-problems';
import { decodeCursor, normaliseLimit, paginate, type Page } from '../common/pagination';
import { FIELD_ENCRYPTION_SERVICE } from '../crypto/crypto.tokens';
import type { FieldEncryptionService } from '../crypto/field-encryption';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_RECORD_ROLES } from './job-access';

/** One user, evaluated against one area. */
export interface AssigneeEligibility {
  fullName: string;
  eligible: boolean;
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
   * The boolean form, for the two places that must REPORT rather than refuse:
   * `JobGenerationService` (which generates unassigned rather than failing —
   * see its own note) and the planner grid (which warns that a rule will
   * generate unassigned before it happens).
   *
   * Never use this to gate a write. `assertAssignable` above is the gate, and
   * it names the reason; this one deliberately cannot.
   */
  async isAssignable(assigneeId: string, areaId: string | null): Promise<boolean> {
    try {
      await this.assertAssignable(assigneeId, areaId);
      return true;
    } catch {
      return false;
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
   * The BATCH form, for the planner grid: name and eligibility for a set of
   * (user, area) pairs in a bounded number of queries rather than one pair at
   * a time. Keyed `userId|areaId` — the same user can be eligible for one
   * machine's area and not another's.
   *
   * It exists because the grid must be able to say "this schedule will
   * generate UNASSIGNED work" BEFORE the sweep proves it, and doing that with
   * `isAssignable` per row would be 220 round trips to draw one screen.
   */
  async resolveEligibility(
    pairs: readonly { userId: string; areaId: string | null }[],
  ): Promise<Map<string, AssigneeEligibility>> {
    const resolved = new Map<string, AssigneeEligibility>();
    const userIds = [...new Set(pairs.map((pair) => pair.userId))];
    if (userIds.length === 0) return resolved;

    const users = await this.prisma.appUser.findMany({
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
          eligible: false,
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
        eligible,
      });
    }
    return resolved;
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
