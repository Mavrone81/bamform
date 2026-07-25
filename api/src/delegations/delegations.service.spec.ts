import { DelegationsService } from './delegations.service';

function fakeUser(id: string) {
  return { id, fullNameCt: Buffer.from('name'), dekVersion: 1 };
}

function buildService(
  opts: {
    delegatorId?: string | null;
    delegateId?: string | null;
    txDelegation?: unknown;
  } = {},
) {
  const created = { id: 'deleg-1' };
  const txDelegationRow = {
    id: 'deleg-1',
    delegatorId: 'delegator-1',
    delegateId: 'delegate-1',
    validFrom: new Date('2026-07-01'),
    validTo: new Date('2026-07-10'),
    reason: null,
    createdBy: 'actor-1',
    revokedAt: null,
    createdAt: new Date('2026-07-01'),
    delegator: fakeUser('delegator-1'),
    delegate: fakeUser('delegate-1'),
    ...(opts.txDelegation as object),
  };

  const tx = {
    delegation: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(txDelegationRow),
      update: jest.fn().mockResolvedValue({}),
    },
  };

  const prisma = {
    appUser: {
      findUnique: jest.fn((args: { where: { id: string } }) => {
        if (args.where.id === 'delegator-1') {
          return Promise.resolve(opts.delegatorId === null ? null : fakeUser('delegator-1'));
        }
        if (args.where.id === 'delegate-1') {
          return Promise.resolve(opts.delegateId === null ? null : fakeUser('delegate-1'));
        }
        return Promise.resolve(fakeUser(args.where.id));
      }),
    },
    delegation: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(txDelegationRow),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const repo = {
    create: jest.fn().mockResolvedValue(created),
    findById: jest.fn().mockResolvedValue({
      id: 'deleg-1',
      delegatorId: 'delegator-1',
      createdBy: 'actor-1',
      revokedAt: null,
    }),
    revoke: jest.fn().mockResolvedValue({}),
    findForUser: jest.fn().mockResolvedValue([txDelegationRow]),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const fieldEncryption = { decrypt: jest.fn().mockReturnValue('Decrypted Name') };

  const service = new DelegationsService(
    prisma as never,
    repo as never,
    audit as never,
    fieldEncryption as never,
  );
  return { service, prisma, repo, audit };
}

const actor = { actorId: 'actor-1' };

describe('DelegationsService#create (PR-038/PR-090 — createdBy is never client-supplied)', () => {
  it('TEAM_LEADER/ENGINEER may create a delegation delegating THEIR OWN authority', async () => {
    const { service, repo, audit } = buildService();
    const result = await service.create({ actorId: 'delegator-1' }, ['TEAM_LEADER'], {
      delegatorId: 'delegator-1',
      delegateId: 'delegate-1',
      validFrom: '2026-07-01T00:00:00Z',
      validTo: '2026-07-10T00:00:00Z',
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        createdBy: 'delegator-1',
        delegatorId: 'delegator-1',
        delegateId: 'delegate-1',
      }),
    );
    expect(audit.record).toHaveBeenCalled();
    expect(result.id).toBe('deleg-1');
  });

  it("a non-ADMIN cannot create a delegation delegating SOMEONE ELSE'S authority", async () => {
    const { service } = buildService();
    await expect(
      service.create({ actorId: 'someone-else' }, ['TEAM_LEADER'], {
        delegatorId: 'delegator-1',
        delegateId: 'delegate-1',
        validFrom: '2026-07-01T00:00:00Z',
        validTo: '2026-07-10T00:00:00Z',
      }),
    ).rejects.toMatchObject({ getResponse: expect.any(Function) });
  });

  it('ADMIN may create a delegation between two OTHER users', async () => {
    const { service, repo } = buildService();
    await service.create({ actorId: 'admin-1' }, ['ADMIN'], {
      delegatorId: 'delegator-1',
      delegateId: 'delegate-1',
      validFrom: '2026-07-01T00:00:00Z',
      validTo: '2026-07-10T00:00:00Z',
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ createdBy: 'admin-1' }),
    );
  });

  it('rejects when delegatorId does not reference a real user', async () => {
    const { service } = buildService({ delegatorId: null });
    await expect(
      service.create({ actorId: 'delegator-1' }, ['TEAM_LEADER'], {
        delegatorId: 'delegator-1',
        delegateId: 'delegate-1',
        validFrom: '2026-07-01T00:00:00Z',
        validTo: '2026-07-10T00:00:00Z',
      }),
    ).rejects.toMatchObject({ getResponse: expect.any(Function) });
  });

  it('never accepts createdBy from the request body — it is always the actor, even if smuggled in the dto object', async () => {
    const { service, repo } = buildService();
    const dtoWithSmuggledField = {
      delegatorId: 'delegator-1',
      delegateId: 'delegate-1',
      validFrom: '2026-07-01T00:00:00Z',
      validTo: '2026-07-10T00:00:00Z',
      createdBy: 'attacker-supplied-id',
    };
    await service.create(
      { actorId: 'delegator-1' },
      ['TEAM_LEADER'],
      dtoWithSmuggledField as never,
    );
    expect(repo.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ createdBy: 'delegator-1' }),
    );
  });
});

describe('DelegationsService#revoke (soft-revoke — INV: no hard delete)', () => {
  it('the delegator may revoke their own delegation', async () => {
    const { service, repo } = buildService();
    await service.revoke({ actorId: 'delegator-1' }, ['TEAM_LEADER'], 'deleg-1');
    expect(repo.revoke).toHaveBeenCalledWith(expect.anything(), 'deleg-1', expect.any(Date));
  });

  it('the creator may revoke even if not the delegator', async () => {
    const { service, repo } = buildService();
    await service.revoke(actor, ['ADMIN'], 'deleg-1'); // actor-1 is createdBy per findById fixture
    expect(repo.revoke).toHaveBeenCalled();
  });

  it('an unrelated user (not delegator, not creator, not ADMIN) is forbidden', async () => {
    const { service } = buildService();
    await expect(
      service.revoke({ actorId: 'random-user' }, ['TEAM_LEADER'], 'deleg-1'),
    ).rejects.toMatchObject({
      getResponse: expect.any(Function),
    });
  });

  it('revoking an already-revoked delegation is idempotent (no error, no double audit write)', async () => {
    const { service, repo, audit } = buildService();
    repo.findById.mockResolvedValue({
      id: 'deleg-1',
      delegatorId: 'delegator-1',
      createdBy: 'actor-1',
      revokedAt: new Date('2026-07-05'),
    });
    const result = await service.revoke({ actorId: 'delegator-1' }, ['TEAM_LEADER'], 'deleg-1');
    expect(repo.revoke).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(result.id).toBe('deleg-1');
  });

  it('404s for an unknown delegation id', async () => {
    const { service, repo } = buildService();
    repo.findById.mockResolvedValue(null);
    await expect(service.revoke(actor, ['ADMIN'], 'nope')).rejects.toMatchObject({
      getResponse: expect.any(Function),
    });
  });
});
