import { VerifierEligibilityService } from './verifier-eligibility.service';

/** The delivered two-stage route's stage 1 (slice 26-TWOSTAGE). */
const STAGE_MAP = new Map([
  [
    'route-1:1',
    { roleCodes: ['TEAM_LEADER'], label: 'Verified By (Workshop Team Leader)', stageCount: 2 },
  ],
]);

describe('VerifierEligibilityService (UR-050/UR-063 recipient resolution)', () => {
  it('returns [] when the subject has no current stage (not awaiting verification)', async () => {
    const repo = { getStageMap: jest.fn(), findUserIdsWithRoles: jest.fn() };
    const areaScope = { getAllowedAreaIds: jest.fn() };
    const service = new VerifierEligibilityService(repo as never, areaScope as never);
    const result = await service.findEligibleVerifierIds({
      approvalRouteId: 'route-1',
      currentStageOrdinal: null,
      areaId: 'area-1',
    });
    expect(result).toEqual([]);
    expect(repo.getStageMap).not.toHaveBeenCalled();
  });

  it('returns [] when the stage has no configured roles', async () => {
    const repo = {
      getStageMap: jest.fn().mockResolvedValue(new Map()),
      findUserIdsWithRoles: jest.fn(),
    };
    const areaScope = { getAllowedAreaIds: jest.fn() };
    const service = new VerifierEligibilityService(repo as never, areaScope as never);
    const result = await service.findEligibleVerifierIds({
      approvalRouteId: 'route-1',
      currentStageOrdinal: 1,
      areaId: 'area-1',
    });
    expect(result).toEqual([]);
  });

  it('filters candidates by area scope — unrestricted (null) users always pass', async () => {
    const repo = {
      getStageMap: jest.fn().mockResolvedValue(STAGE_MAP),
      findUserIdsWithRoles: jest
        .fn()
        .mockResolvedValue(['unrestricted-user', 'scoped-elsewhere', 'scoped-here']),
    };
    const areaScope = {
      getAllowedAreaIds: jest.fn((userId: string) => {
        if (userId === 'unrestricted-user') return Promise.resolve(null);
        if (userId === 'scoped-elsewhere') return Promise.resolve(['area-2']);
        return Promise.resolve(['area-1']);
      }),
    };
    const service = new VerifierEligibilityService(repo as never, areaScope as never);
    const result = await service.findEligibleVerifierIds({
      approvalRouteId: 'route-1',
      currentStageOrdinal: 1,
      areaId: 'area-1',
    });
    expect(result.sort()).toEqual(['scoped-here', 'unrestricted-user']);
  });

  it('findUsersWithRoleInScope resolves a fixed role (escalate_to_role_id path)', async () => {
    const repo = {
      getStageMap: jest.fn(),
      findUserIdsWithRoles: jest.fn().mockResolvedValue(['admin-1']),
    };
    const areaScope = { getAllowedAreaIds: jest.fn().mockResolvedValue(null) };
    const service = new VerifierEligibilityService(repo as never, areaScope as never);
    const result = await service.findUsersWithRoleInScope('ADMIN', 'area-1');
    expect(repo.findUserIdsWithRoles).toHaveBeenCalledWith(['ADMIN']);
    expect(result).toEqual(['admin-1']);
  });
});
