import { applyAreaScope, AreaScopeService } from './area-scope';

describe('applyAreaScope (PR-API-10 mechanism)', () => {
  it('adds no filter when unrestricted (null)', () => {
    expect(applyAreaScope({ status: 'ACTIVE' }, null)).toEqual({ status: 'ACTIVE' });
  });

  it('adds an `in` filter on the given column when scoped', () => {
    expect(applyAreaScope({ status: 'ACTIVE' }, ['area-1', 'area-2'])).toEqual({
      status: 'ACTIVE',
      areaId: { in: ['area-1', 'area-2'] },
    });
  });

  it('filters out everything for a user scoped to zero areas (not the same as unrestricted)', () => {
    expect(applyAreaScope({}, [])).toEqual({ areaId: { in: [] } });
  });

  it('supports a custom column name for entities that reach area via a join', () => {
    expect(applyAreaScope({}, ['area-1'], 'asset.areaId')).toEqual({
      'asset.areaId': { in: ['area-1'] },
    });
  });
});

describe('AreaScopeService', () => {
  it('returns null (unrestricted) when the user has no ACTIVE user_area_scope rows', async () => {
    const prisma = { userAreaScope: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new AreaScopeService(prisma as never);

    await expect(service.getAllowedAreaIds('user-1')).resolves.toBeNull();
    // Slice 13-UI-B (SYS-10): the read filters to `active: true` — a
    // soft-removed scope (INV-16: revocation cannot DELETE the row) must
    // never count against the user.
    expect(prisma.userAreaScope.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', active: true },
      select: { areaId: true },
    });
  });

  it('returns the scoped area ids when the user has user_area_scope rows', async () => {
    const prisma = {
      userAreaScope: {
        findMany: jest.fn().mockResolvedValue([{ areaId: 'area-1' }, { areaId: 'area-2' }]),
      },
    };
    const service = new AreaScopeService(prisma as never);

    await expect(service.getAllowedAreaIds('user-1')).resolves.toEqual(['area-1', 'area-2']);
  });
});
