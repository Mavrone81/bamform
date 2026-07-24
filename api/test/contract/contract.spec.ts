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
      ],
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
  ];

  it.each(RESPONSE_SCHEMAS_WITH_KNOWN_KEYS)(
    'openapi $schemaName documents exactly the keys the mapper produces (no leak, no gap)',
    ({ schemaName, knownKeys }) => {
      const schema = getSchema(schemaName);
      const documentedKeys = Object.keys(schema.properties as object);
      expect(documentedKeys.sort()).toEqual([...knownKeys].sort());
    },
  );
});
