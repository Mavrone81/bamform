import { UnprocessableEntityException } from '@nestjs/common';
import { AssignableUserService, eligibilityKey } from './assignable-user.service';

/**
 * REVIEW FINDING — the eligibility check must not report an infrastructure
 * failure as a finding about a person.
 *
 * `checkAssignable` used to be `isAssignable(): Promise<boolean>` wrapping a
 * bare `catch`, so a Prisma connection error, a statement timeout or a decrypt
 * failure all came back as `false` — indistinguishable from a technician who
 * genuinely lost their role. On the scheduler sweep that `false` was written
 * into the job's creation audit event as `defaultAssigneeUnavailable: true`,
 * which is append-only, hash-chained and kept seven years: a two-second
 * database blip would have left a permanent, unfalsifiable record asserting
 * that a named human was no longer eligible.
 *
 * These test the seam directly, with fakes, because the failure they describe
 * cannot be provoked against a healthy database.
 */
describe('AssignableUserService#checkAssignable — three verdicts, not a boolean', () => {
  /** The service with only the collaborators this method actually touches. */
  function makeService(opts: {
    user?: unknown;
    findUnique?: () => Promise<unknown>;
    allowedAreaIds?: string[] | null;
    getAllowedAreaIds?: () => Promise<string[] | null>;
  }) {
    const prisma = {
      appUser: {
        findUnique:
          opts.findUnique ??
          jest.fn(async () => opts.user ?? { id: 'u-1', status: 'active', userRoles: [] }),
      },
    };
    const areaScope = {
      getAllowedAreaIds: opts.getAllowedAreaIds ?? jest.fn(async () => opts.allowedAreaIds ?? null),
    };
    return new AssignableUserService(prisma as never, areaScope as never, {} as never);
  }

  const maintainer = {
    id: 'u-1',
    status: 'active',
    userRoles: [{ role: { code: 'MAINTAINER' } }],
  };

  it('reports `assignable` when the check runs and passes', async () => {
    const service = makeService({ user: maintainer });
    expect(await service.checkAssignable('u-1', 'area-1')).toEqual({
      verdict: 'assignable',
      detail: null,
    });
  });

  describe('a check that RAN and refused is a finding about the person', () => {
    it('reports `not-assignable` for an inactive account, with the reason', async () => {
      const service = makeService({ user: { ...maintainer, status: 'deactivated' } });
      const result = await service.checkAssignable('u-1', 'area-1');
      expect(result.verdict).toBe('not-assignable');
      expect(result.detail).toMatch(/active user/);
    });

    it('reports `not-assignable` for a user holding no result-recording role', async () => {
      const service = makeService({
        user: { ...maintainer, userRoles: [{ role: { code: 'AUDITOR' } }] },
      });
      const result = await service.checkAssignable('u-1', 'area-1');
      expect(result.verdict).toBe('not-assignable');
      expect(result.detail).toMatch(/no role that can record results/);
    });

    it('reports `not-assignable` when the area scope does not reach the machine', async () => {
      const service = makeService({ user: maintainer, allowedAreaIds: ['other-area'] });
      const result = await service.checkAssignable('u-1', 'area-1');
      expect(result.verdict).toBe('not-assignable');
      expect(result.detail).toMatch(/area scope/);
    });

    it('reports `not-assignable` for a user who does not exist', async () => {
      const service = makeService({ findUnique: jest.fn(async () => null) });
      expect((await service.checkAssignable('nobody', null)).verdict).toBe('not-assignable');
    });
  });

  /**
   * ############################################################
   * THE REGRESSION THIS FILE EXISTS FOR.
   * ############################################################
   */
  describe('a check that COULD NOT RUN is a finding about the system', () => {
    it('reports `unknown` when the user lookup throws, never `not-assignable`', async () => {
      const service = makeService({
        findUnique: jest.fn(async () => {
          throw new Error('Connection terminated unexpectedly');
        }),
      });

      const result = await service.checkAssignable('u-1', 'area-1');
      expect(result.verdict).toBe('unknown');
      // The old code returned `false` here, which the sweep recorded — for
      // seven years, in the hash chain — as "this person is no longer
      // eligible". Nothing about the person has been established.
      expect(result.verdict).not.toBe('not-assignable');
      expect(result.detail).toMatch(/Connection terminated/);
    });

    it('reports `unknown` when the AREA-SCOPE lookup throws', async () => {
      // The second of the two reads, and the one most easily missed: the user
      // row loaded fine, so a naive guard would have concluded "eligible" or
      // "not eligible" from a half-completed check.
      const service = makeService({
        user: maintainer,
        getAllowedAreaIds: jest.fn(async () => {
          throw new Error('statement timeout');
        }),
      });

      const result = await service.checkAssignable('u-1', 'area-1');
      expect(result.verdict).toBe('unknown');
      expect(result.detail).toMatch(/statement timeout/);
    });

    /**
     * The sweep runs unattended over every rule in the plant. This method is
     * contractually non-throwing so one bad row cannot abort the run.
     */
    it('never throws, whatever comes out of the lookups', async () => {
      for (const thrown of [
        new Error('boom'),
        'a bare string',
        null,
        { weird: true },
      ] as unknown[]) {
        const service = makeService({
          findUnique: jest.fn(async () => {
            throw thrown;
          }),
        });
        await expect(service.checkAssignable('u-1', null)).resolves.toBeDefined();
      }
    });

    /**
     * The fix must not have gone the other way. A domain refusal is an
     * `HttpException`, and only that becomes `not-assignable`; if everything
     * became `unknown`, a technician who really had left would be reported for
     * ever as "we could not check" and the plan would never get corrected.
     */
    it('still classifies a domain refusal as a refusal, not as unknown', async () => {
      const service = makeService({
        findUnique: jest.fn(async () => {
          throw new UnprocessableEntityException({
            type: '/errors/validation-failed',
            detail: 'assigneeId does not name an active user.',
          });
        }),
      });
      const result = await service.checkAssignable('u-1', null);
      expect(result.verdict).toBe('not-assignable');
      expect(result.detail).toBe('assigneeId does not name an active user.');
    });
  });

  /**
   * `assertAssignable` is the GATE, used by the endpoints a human is waiting
   * on. It must keep throwing — including infrastructure errors, which a
   * request should surface as a 500 rather than silently converting into "that
   * person cannot be assigned".
   */
  describe('assertAssignable, the gate, is unchanged', () => {
    it('propagates an infrastructure error rather than converting it to a refusal', async () => {
      const service = makeService({
        findUnique: jest.fn(async () => {
          throw new Error('Connection terminated unexpectedly');
        }),
      });
      await expect(service.assertAssignable('u-1', null)).rejects.toThrow(/Connection terminated/);
    });

    it('still raises the 422 for a genuine refusal', async () => {
      const service = makeService({ user: { ...maintainer, status: 'deactivated' } });
      await expect(service.assertAssignable('u-1', null)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });
});

describe('AssignableUserService#resolveEligibility — the grid degrades, it does not vanish', () => {
  function makeService(findMany: () => Promise<unknown[]>) {
    const prisma = { appUser: { findMany: jest.fn(findMany) } };
    return new AssignableUserService(prisma as never, {} as never, {} as never);
  }

  /**
   * Losing the whole year's plan because a supporting lookup blipped would be
   * a far worse outcome than drawing it and saying which lines could not be
   * checked. The grid's own rules query has already succeeded by this point.
   */
  it('reports `unknown` for every pair when the lookup fails, instead of throwing', async () => {
    const service = makeService(async () => {
      throw new Error('Connection terminated unexpectedly');
    });

    const resolved = await service.resolveEligibility([
      { userId: 'u-1', areaId: 'area-1' },
      { userId: 'u-2', areaId: null },
    ]);

    expect(resolved.get(eligibilityKey('u-1', 'area-1'))).toEqual({
      fullName: 'Unknown',
      verdict: 'unknown',
    });
    expect(resolved.get(eligibilityKey('u-2', null))?.verdict).toBe('unknown');
    // Not `not-assignable` — the same untruth as the sweep's, on a screen a
    // planner acts from.
    expect([...resolved.values()].some((entry) => entry.verdict === 'not-assignable')).toBe(false);
  });

  it('makes no query at all when there is nothing to resolve', async () => {
    const service = makeService(async () => []);
    expect((await service.resolveEligibility([])).size).toBe(0);
  });

  /**
   * A row that is simply absent is a database anomaly (the FK is RESTRICT and
   * nothing deletes an `app_user`, INV-16) — still not a finding about the
   * person, so still `unknown` rather than `not-assignable`.
   */
  it('reports `unknown` for a user whose row is missing', async () => {
    const service = makeService(async () => []);
    const resolved = await service.resolveEligibility([{ userId: 'ghost', areaId: 'area-1' }]);
    expect(resolved.get(eligibilityKey('ghost', 'area-1'))?.verdict).toBe('unknown');
  });
});
