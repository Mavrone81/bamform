import { QueueService } from './queue.service';

/**
 * Unit-level (job 3 has no Postgres/Redis) — the MERGE/DEDUPE/PAGINATION
 * logic (own + delegated queues, PR-076) is intricate enough to deserve
 * direct coverage independent of the real-Postgres round trip
 * (`test/integration/queue.spec.ts` proves the actual area/role SQL).
 */
function jobRow(id: string, approvalRouteId = 'route-1', currentStageOrdinal = 1) {
  return {
    id,
    jobNumber: `PM-${id}`,
    approvalRouteId,
    currentStageOrdinal,
    frequency: 'M1',
    frequencyScope: ['M1'],
    dueOn: new Date('2026-07-01'),
    status: 'submitted',
    assignedTo: null,
    submittedAt: new Date('2026-07-20T00:00:00Z'),
    asset: { code: 'AW03', areaId: 'area-1' },
    templateRevision: { revisionCode: 'A', formTemplate: { documentNumber: 'DOC-1' } },
  };
}

function buildService(opts: {
  stageMap?: Map<string, string[]>;
  ownRoles?: string[];
  ownCandidates?: ReturnType<typeof jobRow>[];
  delegators?: { delegatorId: string }[];
  delegatorRolesById?: Record<string, string[]>;
  delegatorCandidatesById?: Record<string, ReturnType<typeof jobRow>[]>;
}) {
  const stageMap = opts.stageMap ?? new Map([['route-1:1', ['TEAM_LEADER']]]);
  const repo = {
    getStageRoleMap: jest.fn().mockResolvedValue(stageMap),
    getUserRoleCodes: jest.fn((userId: string) =>
      Promise.resolve(
        userId === 'caller'
          ? (opts.ownRoles ?? ['TEAM_LEADER'])
          : (opts.delegatorRolesById?.[userId] ?? []),
      ),
    ),
    findCandidateSubmittedJobs: jest.fn((userId: string) =>
      Promise.resolve(
        userId === 'caller'
          ? (opts.ownCandidates ?? [])
          : (opts.delegatorCandidatesById?.[userId] ?? []),
      ),
    ),
  };
  const areaScope = { getAllowedAreaIds: jest.fn().mockResolvedValue(null) };
  const delegations = {
    findActiveDelegatorsFor: jest.fn().mockResolvedValue(opts.delegators ?? []),
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const service = new QueueService(
    repo as never,
    areaScope as never,
    delegations as never,
    config as never,
  );
  return { service, repo, delegations };
}

describe('QueueService#getQueue (PR-073/076/081)', () => {
  it('returns only role-eligible SUBMITTED jobs from the own candidate set', async () => {
    const { service } = buildService({
      ownCandidates: [jobRow('a', 'route-1', 1), jobRow('b', 'route-1', 2)], // stage 2 has no configured role -> filtered out
    });
    const page = await service.getQueue('caller', {});
    expect(page.data.map((e) => e.id)).toEqual(['a']);
    expect(page.data[0].onBehalfOf).toBeNull();
  });

  it('a non-verifier (no roles matching any stage) gets an empty queue, not an error', async () => {
    const { service } = buildService({ ownRoles: ['MAINTAINER'], ownCandidates: [jobRow('a')] });
    const page = await service.getQueue('caller', {});
    expect(page.data).toEqual([]);
  });

  it("includes an active delegator's eligible entries, tagged onBehalfOf", async () => {
    const { service } = buildService({
      ownCandidates: [],
      delegators: [{ delegatorId: 'delegator-1' }],
      delegatorRolesById: { 'delegator-1': ['TEAM_LEADER'] },
      delegatorCandidatesById: { 'delegator-1': [jobRow('d1')] },
    });
    const page = await service.getQueue('caller', {});
    expect(page.data.map((e) => e.id)).toEqual(['d1']);
    expect(page.data[0].onBehalfOf).toBe('delegator-1');
  });

  it('de-dupes a job that would otherwise appear via both own eligibility and a delegator — own wins, onBehalfOf stays null', async () => {
    const { service } = buildService({
      ownCandidates: [jobRow('shared')],
      delegators: [{ delegatorId: 'delegator-1' }],
      delegatorRolesById: { 'delegator-1': ['TEAM_LEADER'] },
      delegatorCandidatesById: { 'delegator-1': [jobRow('shared')] },
    });
    const page = await service.getQueue('caller', {});
    expect(page.data).toHaveLength(1);
    expect(page.data[0].onBehalfOf).toBeNull();
  });

  it('excludes a delegator once findActiveDelegatorsFor no longer returns them (revoked/expired — resolved at request time, PR-076)', async () => {
    const { service, delegations } = buildService({ ownCandidates: [] });
    delegations.findActiveDelegatorsFor.mockResolvedValue([]); // simulates revoked/expired
    const page = await service.getQueue('caller', {});
    expect(page.data).toEqual([]);
  });

  it('paginates the merged, sorted result (limit + cursor)', async () => {
    const { service } = buildService({
      ownCandidates: [jobRow('a'), jobRow('b'), jobRow('c')],
    });
    const page1 = await service.getQueue('caller', { limit: 2 });
    expect(page1.data.map((e) => e.id)).toEqual(['a', 'b']);
    expect(page1.page.hasMore).toBe(true);
    expect(page1.page.nextCursor).not.toBeNull();

    const page2 = await service.getQueue('caller', { limit: 2, cursor: page1.page.nextCursor! });
    expect(page2.data.map((e) => e.id)).toEqual(['c']);
    expect(page2.page.hasMore).toBe(false);
  });
});
