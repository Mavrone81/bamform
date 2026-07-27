import { z } from 'zod';
import {
  assignJobRequestSchema,
  mfaChallengeResponseSchema,
  mfaEnrolConfirmRequestSchema,
  mfaEnrolConfirmResponseSchema,
  mfaEnrolRequestSchema,
  mfaEnrolResponseSchema,
  mfaRecoveryRequestSchema,
  mfaVerifyRequestSchema,
  passwordChangeRequestSchema,
} from '@bamform/shared';
import { enumerateRoutes } from './route-inventory';
import { listOpenapiOperations, getSchema, loadOpenapiDocument } from './openapi-loader';
import { findUndocumentedRoutes, findUnimplementedOpenapiPaths } from './contract-checks';
import { FUTURE_SLICE_OPENAPI_PATHS } from './known-gaps';

/**
 * C-01/C-05 — "Implementation matches specification" (job 5, step 3).
 *
 * Every implemented route (enumerated from the router — see
 * `route-inventory.ts`'s header for why this never boots the real app) must
 * be documented in `api/openapi.yaml`, and every documented path must be
 * implemented UNLESS it is named future work (`known-gaps.ts`'s
 * `FUTURE_SLICE_OPENAPI_PATHS` — the contract deliberately documents the
 * full 13-slice system up front; only slices 1-4 are built).
 */
describe('test:contract — every implemented route is documented, and vice versa', () => {
  const routes = enumerateRoutes();
  const openapiOps = listOpenapiOperations();

  it('has actually enumerated routes (sanity - a broken discovery would vacuously pass)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(30);
    expect(openapiOps.length).toBeGreaterThanOrEqual(30);
  });

  it('every implemented route is documented in openapi.yaml', () => {
    const undocumented = findUndocumentedRoutes(routes, openapiOps);
    expect(undocumented.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('every openapi.yaml path is implemented, unless it is named future work', () => {
    const unimplemented = findUnimplementedOpenapiPaths(
      openapiOps,
      routes,
      FUTURE_SLICE_OPENAPI_PATHS,
    );
    expect(unimplemented.map((op) => `${op.method} ${op.path}`)).toEqual([]);
  });

  // ---- Proof this genuinely catches a violation (not vacuously true) ----
  // A dedicated RED/GREEN run was also done by hand: temporarily adding
  // `@Get('scratch-undocumented') scratch() {}` to AreasController and
  // re-running `npm run test:contract --workspace=api` reproduced exactly
  // this failure shape (`GET /api/v1/areas/scratch-undocumented` reported
  // undocumented), then the handler was removed and the suite went green
  // again — see ci-B-report.md for the transcript. The tests below pin the
  // same behaviour permanently via synthetic fixtures, independent of the
  // real router, so a future refactor of `contract-checks.ts` itself cannot
  // silently make the check vacuous.
  describe('proof: the comparison functions actually catch violations', () => {
    it('flags an implemented route with no matching openapi operation', () => {
      const fakeRoutes = [
        { method: 'GET', path: '/api/v1/assets' },
        { method: 'GET', path: '/api/v1/areas/scratch-undocumented' },
      ];
      const fakeOps = [{ method: 'GET', path: '/assets' }];
      const undocumented = findUndocumentedRoutes(fakeRoutes, fakeOps);
      expect(undocumented).toEqual([{ method: 'GET', path: '/api/v1/areas/scratch-undocumented' }]);
    });

    it("does not flag a route whose param name differs from openapi's", () => {
      const fakeRoutes = [{ method: 'GET', path: '/api/v1/assets/:assetId' }];
      const fakeOps = [{ method: 'GET', path: '/assets/{id}' }];
      expect(findUndocumentedRoutes(fakeRoutes, fakeOps)).toEqual([]);
    });

    it('flags a documented path with no implementing route, unless allowlisted as future work', () => {
      const fakeOps = [
        { method: 'GET', path: '/assets' },
        { method: 'GET', path: '/scratch-future-thing' },
      ];
      const fakeRoutes = [{ method: 'GET', path: '/api/v1/assets' }];
      const withoutAllowlist = findUnimplementedOpenapiPaths(fakeOps, fakeRoutes, []);
      expect(withoutAllowlist).toEqual([{ method: 'GET', path: '/scratch-future-thing' }]);

      const withAllowlist = findUnimplementedOpenapiPaths(fakeOps, fakeRoutes, [
        { method: 'GET', path: '/scratch-future-thing' },
      ]);
      expect(withAllowlist).toEqual([]);
    });
  });
});

/**
 * Response-schema conformance ("where feasible" per the brief — job 5 has no
 * live server/DB to drive real HTTP round-trips against, see
 * `route-inventory.ts`'s header). Statically checks the openapi component
 * schemas against the actual response shape instead:
 * - the two fields the brief explicitly calls out (409 self-approval, no
 *   `active` leak) are asserted directly;
 * - a small keys-subset sweep catches the general class of "response
 *   schema documents/omits a field the implementation doesn't/does produce".
 */
describe('test:contract — response-schema conformance', () => {
  it('TemplateItem does not document the internal `active` field', () => {
    const schema = getSchema('TemplateItem');
    expect(Object.keys(schema.properties as object)).not.toContain('active');
  });

  it('TemplateMeasurement does not document the internal `active` field', () => {
    const schema = getSchema('TemplateMeasurement');
    expect(Object.keys(schema.properties as object)).not.toContain('active');
  });

  it('the approve-revision self-approval response is documented as 409, not 403', () => {
    const doc = listOpenapiOperations();
    expect(doc.some((op) => op.operationId === 'approveRevision')).toBe(true);
    const approve = loadOpenapiDocument().paths['/revisions/{revisionId}/approve'].post;
    expect(approve.responses['409']).toBeDefined();
    expect(JSON.stringify(approve.responses['403'])).not.toMatch(/author/i);
    expect(JSON.stringify(approve.responses['409'])).toMatch(/self-approval/i);
  });

  const RESPONSE_SCHEMAS_WITH_KNOWN_KEYS = [
    { schemaName: 'Area', knownKeys: ['id', 'code', 'name', 'parentId', 'active'] },
    {
      schemaName: 'AssetType',
      knownKeys: [
        'id',
        'code',
        'name',
        'description',
        'formTemplateId',
        'approvalRouteId',
        'leadTimeDays',
        'active',
      ],
    },
    {
      schemaName: 'Asset',
      knownKeys: [
        'id',
        'code',
        'assetTypeId',
        'assetTypeName',
        'description',
        'manufacturer',
        'model',
        'serialNumber',
        'areaId',
        'locationDetail',
        'commissionedOn',
        'scheduleAnchorDate',
        'status',
        'active',
        // Slice 13a / B-09 — see `assets/machine-code.ts`.
        'codeProvisional',
      ],
    },
    {
      // Slice 13a — `users.mapper.ts#toUser` always populates every one of
      // these keys; NEVER a password/passwordHash field (UR-074).
      schemaName: 'User',
      knownKeys: [
        'id',
        'employeeId',
        'fullName',
        'email',
        'status',
        'active',
        'roles',
        'createdAt',
        'updatedAt',
      ],
    },
    {
      schemaName: 'Role',
      knownKeys: ['id', 'code', 'name', 'description'],
    },
    {
      schemaName: 'ScheduleRule',
      knownKeys: [
        'id',
        'assetId',
        'frequency',
        'intervalMonths',
        'anchorDate',
        'lastCompletedOn',
        'nextDueOn',
        'adjustedReason',
        'active',
      ],
    },
    {
      schemaName: 'TemplateItem',
      knownKeys: [
        'id',
        'itemNo',
        'frequency',
        'instruction',
        'mandatory',
        'stableKey',
        'displayOrder',
      ],
    },
    {
      schemaName: 'TemplateMeasurement',
      knownKeys: [
        'id',
        'section',
        'description',
        'unit',
        'specType',
        'lowerLimit',
        'upperLimit',
        'nominal',
        'tolerance',
        'specDisplay',
        'stableKey',
        'displayOrder',
      ],
    },
    {
      // Slice 8 — AuditEventsController#chainStatus (`GET /audit-events/chain-status`)
      // returns exactly these four keys (see audit-events.controller.ts); the
      // slice-7 review caught a contract-vs-code mismatch once, so this is
      // pinned the same way the other response schemas above are.
      schemaName: 'AuditChainStatus',
      knownKeys: ['intact', 'checkedAt', 'eventCount', 'firstBreakSequence'],
    },
    {
      // Slice 11a — `delegations.mapper.ts#toDelegation` always populates
      // every one of these keys (unlike `QueueEntry`/`Job`, which are `allOf`
      // compositions this check cannot introspect — `getSchema` returns the
      // raw node, which has no top-level `.properties` for an `allOf` schema,
      // so those are deliberately excluded here the same way `Job` already is).
      schemaName: 'Delegation',
      knownKeys: [
        'id',
        'delegatorId',
        'delegatorName',
        'delegateId',
        'delegateName',
        'validFrom',
        'validTo',
        'reason',
        'createdBy',
        'revokedAt',
        'createdAt',
      ],
    },
  ];

  it('AuditChainStatus documents all four keys as required (firstBreakSequence is nullable, not optional — the controller always emits the key)', () => {
    const schema = getSchema('AuditChainStatus') as { required?: string[] };
    expect((schema.required ?? []).sort()).toEqual([
      'checkedAt',
      'eventCount',
      'firstBreakSequence',
      'intact',
    ]);
  });

  it.each(RESPONSE_SCHEMAS_WITH_KNOWN_KEYS)(
    'openapi $schemaName documents exactly the keys the mapper produces (no leak, no gap)',
    ({ schemaName, knownKeys }) => {
      const schema = getSchema(schemaName);
      const documentedKeys = Object.keys(schema.properties as object);
      expect(documentedKeys.sort()).toEqual([...knownKeys].sort());
    },
  );
});

/**
 * Slice 13-MFA — openapi vs the Zod DTO, mechanically, in BOTH directions
 * (keys AND required-ness).
 *
 * The standing CI rule says the contract must match the DTOs "exactly,
 * required vs optional", and job 5 has historically only been able to check
 * structure — slice 7 shipped two contract lies it could not catch. Rather
 * than restate the correspondence in a comment and hope, this derives the
 * expected shape from the actual Zod schema the server validates against, so
 * editing one side without the other fails here.
 *
 * `.optional()` in Zod is exactly "not in openapi `required`", and a Zod
 * `.nullable()` non-optional field (like `MfaEnrolConfirmResponse.auth`) is
 * required-but-nullable — the distinction the check preserves.
 */
describe('test:contract — slice 13-MFA schemas match their Zod DTOs exactly', () => {
  function zodShape(schema: z.ZodObject<z.ZodRawShape>): {
    keys: string[];
    required: string[];
  } {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const keys = Object.keys(shape);
    // "Optional" defined behaviourally rather than by a zod internal flag:
    // a field is optional exactly when the schema accepts `undefined`. That
    // is the same thing openapi's `required` means, and it survives zod
    // version changes (zod 4 moved `isOptional()` off the base type).
    const required = keys.filter((key) => !shape[key].safeParse(undefined).success);
    return { keys: keys.sort(), required: required.sort() };
  }

  const CASES: Array<{ schemaName: string; dto: z.ZodObject<z.ZodRawShape> }> = [
    { schemaName: 'MfaChallenge', dto: mfaChallengeResponseSchema },
    { schemaName: 'MfaEnrolRequest', dto: mfaEnrolRequestSchema },
    { schemaName: 'MfaEnrolResponse', dto: mfaEnrolResponseSchema },
    { schemaName: 'MfaEnrolConfirmRequest', dto: mfaEnrolConfirmRequestSchema },
    { schemaName: 'MfaEnrolConfirmResponse', dto: mfaEnrolConfirmResponseSchema },
    { schemaName: 'MfaVerifyRequest', dto: mfaVerifyRequestSchema },
    { schemaName: 'MfaRecoveryRequest', dto: mfaRecoveryRequestSchema },
    { schemaName: 'PasswordChangeRequest', dto: passwordChangeRequestSchema },
  ];

  it.each(CASES)(
    'openapi $schemaName documents the same keys as its Zod DTO',
    ({ schemaName, dto }) => {
      const schema = getSchema(schemaName);
      expect(Object.keys(schema.properties as object).sort()).toEqual(zodShape(dto).keys);
    },
  );

  it.each(CASES)(
    'openapi $schemaName marks the same fields required as its Zod DTO',
    ({ schemaName, dto }) => {
      const schema = getSchema(schemaName) as { required?: string[] };
      expect([...(schema.required ?? [])].sort()).toEqual(zodShape(dto).required);
    },
  );

  it('POST /auth/login documents BOTH 200 shapes — AuthResult and MfaChallenge', () => {
    const login = loadOpenapiDocument().paths['/auth/login'].post;
    const refs = (
      login.responses['200'].content['application/json'].schema.oneOf as Array<{ $ref: string }>
    ).map((entry) => entry.$ref);
    expect(refs).toEqual(['#/components/schemas/AuthResult', '#/components/schemas/MfaChallenge']);
  });

  it('MfaChallenge pins mfaRequired to the literal true, so clients can discriminate on it', () => {
    const schema = getSchema('MfaChallenge') as {
      properties: { mfaRequired: { const?: unknown } };
    };
    expect(schema.properties.mfaRequired.const).toBe(true);
    expect(
      mfaChallengeResponseSchema.safeParse({
        mfaRequired: false,
        mfaEnrolled: true,
        challengeToken: 't',
        expiresIn: 300,
      }).success,
    ).toBe(false);
  });

  it('every new slice-13-MFA path is documented and none is parked in the future-work allowlist', () => {
    const documented = listOpenapiOperations().map((op) => `${op.method} ${op.path}`);
    const NEW_PATHS = [
      'POST /auth/password',
      'POST /auth/mfa/enrol',
      'POST /auth/mfa/enrol/confirm',
      'POST /auth/mfa/verify',
      'POST /auth/mfa/recovery',
      'POST /users/{userId}/mfa-reset',
    ];
    for (const entry of NEW_PATHS) {
      expect(documented).toContain(entry);
    }
    const allowlisted = FUTURE_SLICE_OPENAPI_PATHS.map((gap) => `${gap.method} ${gap.path}`);
    for (const entry of NEW_PATHS) {
      expect(allowlisted).not.toContain(entry);
    }
  });
});

/**
 * Slice 15-SYSWIRE (SYS-2) — `POST /jobs/{jobId}/assign`. Same mechanical
 * openapi-vs-Zod check the 13-MFA schemas get: keys AND required-ness, both
 * directions, derived from the schema the server actually validates against.
 */
describe('test:contract — slice 15-SYSWIRE assign schema matches its Zod DTO exactly', () => {
  function zodShape(schema: z.ZodObject<z.ZodRawShape>): { keys: string[]; required: string[] } {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const keys = Object.keys(shape);
    const required = keys.filter((key) => !shape[key].safeParse(undefined).success);
    return { keys: keys.sort(), required: required.sort() };
  }

  it('openapi AssignJobRequest documents the same keys as assignJobRequestSchema', () => {
    const schema = getSchema('AssignJobRequest');
    expect(Object.keys(schema.properties as object).sort()).toEqual(
      zodShape(assignJobRequestSchema).keys,
    );
  });

  it('openapi AssignJobRequest marks the same fields required as assignJobRequestSchema', () => {
    const schema = getSchema('AssignJobRequest') as { required?: string[] };
    expect([...(schema.required ?? [])].sort()).toEqual(zodShape(assignJobRequestSchema).required);
  });

  it('POST /jobs/{jobId}/assign is documented and not parked in the future-work allowlist', () => {
    const documented = listOpenapiOperations().map((op) => `${op.method} ${op.path}`);
    expect(documented).toContain('POST /jobs/{jobId}/assign');
    const allowlisted = FUTURE_SLICE_OPENAPI_PATHS.map((gap) => `${gap.method} ${gap.path}`);
    expect(allowlisted).not.toContain('POST /jobs/{jobId}/assign');
  });
});
