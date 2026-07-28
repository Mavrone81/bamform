import { Injectable } from '@nestjs/common';
import { AreaScopeService } from '../common/area-scope';
import { QueueRepository } from './queue.repository';

export interface EligibilitySubject {
  approvalRouteId: string;
  currentStageOrdinal: number | null;
  areaId: string | null;
}

/**
 * "Who can act on this job right now" — the same PR-073 rule `GET /queue`
 * applies to a caller (role satisfies the current stage + area scope),
 * inverted to "given a job, which users" rather than "given a user, which
 * jobs". Reused by the submitted/escalation notification recipient
 * resolution (UR-050/UR-063) so that logic isn't a second, drifting copy of
 * the eligibility rule `QueueService` enforces for reads.
 */
@Injectable()
export class VerifierEligibilityService {
  constructor(
    private readonly repo: QueueRepository,
    private readonly areaScope: AreaScopeService,
  ) {}

  async findEligibleVerifierIds(subject: EligibilitySubject): Promise<string[]> {
    if (subject.currentStageOrdinal == null) {
      return [];
    }
    const stageMap = await this.repo.getStageMap();
    const roleCodes =
      stageMap.get(`${subject.approvalRouteId}:${subject.currentStageOrdinal}`)?.roleCodes ?? [];
    if (roleCodes.length === 0) {
      return [];
    }
    const candidateIds = await this.repo.findUserIdsWithRoles(roleCodes);
    const eligible: string[] = [];
    for (const userId of candidateIds) {
      const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);
      if (
        allowedAreaIds === null ||
        (subject.areaId !== null && allowedAreaIds.includes(subject.areaId))
      ) {
        eligible.push(userId);
      }
    }
    return eligible;
  }

  /** Users holding `roleCode`, filtered to `areaId` scope — the escalation-target-role path (`approval_stage.escalate_to_role_id`), which is a fixed role rather than "whoever satisfies the current stage". */
  async findUsersWithRoleInScope(roleCode: string, areaId: string | null): Promise<string[]> {
    const candidateIds = await this.repo.findUserIdsWithRoles([roleCode]);
    const eligible: string[] = [];
    for (const userId of candidateIds) {
      const allowedAreaIds = await this.areaScope.getAllowedAreaIds(userId);
      if (allowedAreaIds === null || (areaId !== null && allowedAreaIds.includes(areaId))) {
        eligible.push(userId);
      }
    }
    return eligible;
  }
}
