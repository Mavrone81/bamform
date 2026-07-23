import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PR-API-10 / ADR-005: "Where a user has rows in `user_area_scope`, every
 * collection query is filtered to those areas. Absence of rows means
 * unrestricted. Scoping is applied in the repository layer, not by callers,
 * so a new endpoint cannot forget it."
 *
 * This is the reusable mechanism this slice establishes for every later
 * collection endpoint (jobs, schedules, ...) to reuse rather than
 * reimplement per module. `AccessTokenClaims` (PR-086) deliberately carries
 * no area-scope claim, so this always re-reads `user_area_scope` fresh from
 * the database rather than trusting anything from the JWT.
 */
@Injectable()
export class AreaScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns `null` when the user has no `user_area_scope` rows (unrestricted
   * visibility), otherwise the list of area ids their collection reads must
   * be filtered to.
   */
  async getAllowedAreaIds(userId: string): Promise<string[] | null> {
    const rows = await this.prisma.userAreaScope.findMany({
      where: { userId },
      select: { areaId: true },
    });
    if (rows.length === 0) {
      return null;
    }
    return rows.map((row) => row.areaId);
  }
}

/**
 * Applies the area-scope filter to a Prisma `where` clause. Repositories
 * call this rather than inlining the `areaId: { in: [...] }` shape
 * themselves, so the mechanism is one reviewable place, not copy-pasted per
 * endpoint (BUILD_HANDOFF "Code Organization" for this slice).
 *
 * `allowedAreaIds === null` means unrestricted (no filter added) —
 * `[]` (a user scoped to zero areas) legitimately filters out everything.
 */
export function applyAreaScope<W extends Record<string, unknown>>(
  where: W,
  allowedAreaIds: string[] | null,
  column = 'areaId',
): W {
  if (allowedAreaIds === null) {
    return where;
  }
  return { ...where, [column]: { in: allowedAreaIds } };
}
