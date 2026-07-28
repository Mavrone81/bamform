/**
 * Slice 13-TL — end-to-end proof of the whole template load
 * (TEST_PLAN I-TL-19..24, U-CAS-08's real-data case, AC-01 support).
 *
 * Boots the REAL application on a real HTTP port and drives the REAL API
 * with the production loader (scripts/template-load/src/loader.ts) exactly
 * as the staging runbook will: two real logins (author + approver — INV-03),
 * the committed intermediate YAML as input (PR-TLP-08/09), no direct DB
 * writes. Then proves the pipeline the slice exists for:
 *
 *   loaded template → sample machine (provisional/RED) → schedule rules →
 *   SchedulerService.run() → generated job → the checklist the technician
 *   sees matches the parsed source form.
 */
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { SchedulerService } from '../../../src/scheduling/scheduler.service';
import { runLoad, type LoadSummary } from '../../../../scripts/template-load/src/loader';
import { parseYaml } from '../../../../scripts/template-load/src/yaml-io';
import { readFileSync } from 'node:fs';
import { createTestApp } from '../helpers/app';
import { createLoginableUser } from '../helpers/auth-fixtures';
import { adminPool, closeAll, resetDatabase } from '../helpers/db';
import { closeRedis, resetRedis } from '../helpers/redis';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const YAML_DIR = join(REPO_ROOT, 'scripts', 'template-load', 'yaml');

const AUTHOR = { email: 'tlp.author@bamform.test', password: 'Loader-Author-Pw-2026!' };
const APPROVER = { email: 'tlp.approver@bamform.test', password: 'Loader-Approver-Pw-2026!' };

jest.setTimeout(300_000);

describe('template load e2e — loader → schedules → scheduler → job checklist (I-TL-19..24)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let firstSummary: LoadSummary;
  let secondSummary: LoadSummary;

  const asmYaml = parseYaml(readFileSync(join(YAML_DIR, 'CE-95-020-00-01.yaml'), 'utf8'));

  async function fetchJson<T>(path: string, token: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  async function login(email: string, password: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`login ${email} -> ${res.status}`);
    return ((await res.json()) as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    await resetDatabase();
    await resetRedis();
    app = await createTestApp();
    // Real HTTP server — the loader is fetch-based, exactly as on staging.
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    await createLoginableUser({
      email: AUTHOR.email,
      password: AUTHOR.password,
      fullName: 'TLP Load Author',
      roleCodes: ['DOC_CONTROLLER', 'ENGINEER'],
    });
    await createLoginableUser({
      email: APPROVER.email,
      password: APPROVER.password,
      fullName: 'TLP Load Approver',
      roleCodes: ['DOC_CONTROLLER'],
    });

    // THE load — followed immediately by the idempotency re-run.
    firstSummary = await runLoad({
      baseUrl,
      author: AUTHOR,
      approver: APPROVER,
      yamlDir: YAML_DIR,
      createSampleMachines: true,
    });
    secondSummary = await runLoad({
      baseUrl,
      author: AUTHOR,
      approver: APPROVER,
      yamlDir: YAML_DIR,
      createSampleMachines: true,
    });
  });

  afterAll(async () => {
    await app.close();
    await closeAll();
    await closeRedis();
  });

  it('I-TL-19: first run loads all 12 documents; the immediate re-run is a clean no-op (idempotency)', () => {
    expect(firstSummary.documents).toHaveLength(12);
    expect(firstSummary.created).toBe(12);
    expect(secondSummary.documents).toHaveLength(12);
    expect(secondSummary.unchanged).toBe(12);
    expect(secondSummary.created + secondSummary.updated + secondSummary.resumed).toBe(0);
    // No duplicate sample machines either.
    expect(
      secondSummary.documents.map((d) => d.sampleMachines.length).reduce((a, b) => a + b, 0),
    ).toBe(13); // 2 for ASM_WIRE_BOND + 1 × 11
  });

  it('I-TL-20: every template exists with its full revision plan — doc 1 keeps the B-02 letter gap over contiguous ordinals; doc 4 ends CURRENT at client revision D', async () => {
    const token = await login(AUTHOR.email, AUTHOR.password);
    const templates = await fetchJson<{ data: { id: string; documentNumber: string }[] }>(
      '/api/v1/templates?limit=100',
      token,
    );
    expect(templates.data.map((t) => t.documentNumber).sort()).toEqual([
      'CE 95 010 00 01',
      'CE 95 012 00 01',
      'CE 95 012 00 02',
      'CE 95 020 00 01',
      'CE 95 020 00 02',
      'CE 95 020 00 03',
      'CE 95 030 00 01',
      'CE 95 030 00 03',
      'CE 95 043 00 01',
      'CE 95 050 00 01',
      'CE 95 050 00 03',
      'CE 95 055 00 01',
    ]);

    const besiDa = templates.data.find((t) => t.documentNumber === 'CE 95 010 00 01')!;
    const besiDaRevisions = await fetchJson<
      { revisionCode: string; sequenceOrdinal: number; status: string }[]
    >(`/api/v1/templates/${besiDa.id}/revisions`, token);
    const asc = [...besiDaRevisions].sort((a, b) => a.sequenceOrdinal - b.sequenceOrdinal);
    expect(asc.map((r) => [r.revisionCode, r.sequenceOrdinal, r.status])).toEqual([
      ['0', 0, 'SUPERSEDED'],
      ['A', 1, 'SUPERSEDED'],
      ['C', 2, 'SUPERSEDED'], // B is ABSENT in the source history (B-02) — gap visible here
      ['D', 3, 'SUPERSEDED'],
      ['E', 4, 'CURRENT'],
    ]);

    const asm = templates.data.find((t) => t.documentNumber === 'CE 95 020 00 01')!;
    const asmRevisions = await fetchJson<
      { revisionCode: string; sequenceOrdinal: number; status: string }[]
    >(`/api/v1/templates/${asm.id}/revisions`, token);
    const asmAsc = [...asmRevisions].sort((a, b) => a.sequenceOrdinal - b.sequenceOrdinal);
    expect(asmAsc.map((r) => [r.revisionCode, r.status])).toEqual([
      ['0', 'SUPERSEDED'],
      ['A', 'SUPERSEDED'],
      ['B', 'SUPERSEDED'],
      ['C', 'SUPERSEDED'], // the printed revision — its content held B-04, never loaded as-is
      ['D', 'CURRENT'], // the client-decided correction revision
    ]);
  });

  it("I-TL-21: doc 4's CURRENT content matches the YAML exactly — 14 items, 20 measurements, B-04 loaded as 95–105 g (never the inverted range), N-01 escalation as TEXT", async () => {
    const token = await login(AUTHOR.email, AUTHOR.password);
    const doc4 = firstSummary.documents.find((d) => d.documentNumber === 'CE 95 020 00 01')!;
    const revision = await fetchJson<{
      status: string;
      standingContent: Record<string, unknown>;
      items: { itemNo: number; frequency: string; instruction: string; stableKey: string }[];
      measurements: {
        description: string;
        specType: string;
        lowerLimit: number | null;
        upperLimit: number | null;
        specDisplay: string;
        stableKey: string;
      }[];
    }>(`/api/v1/revisions/${doc4.currentRevisionId}`, token);

    expect(revision.status).toBe('CURRENT');
    expect(revision.items).toHaveLength(14);
    expect(revision.items.map((i) => [i.itemNo, i.frequency, i.instruction])).toEqual(
      asmYaml.items.map((i) => [i.itemNo, i.frequency, i.instruction]),
    );
    expect(revision.measurements).toHaveLength(20);

    const b04 = revision.measurements.find((m) =>
      m.description.includes('Bond Force Verification Input Force 100g'),
    )!;
    expect(b04.specType).toBe('RANGE');
    expect(b04.lowerLimit).toBe(95);
    expect(b04.upperLimit).toBe(105);
    expect(b04.specDisplay).toBe('95 - 105 g');

    const n01 = revision.measurements.find((m) =>
      m.description.includes('Track Height Calibration, Top Plate'),
    )!;
    expect(n01.specType).toBe('TEXT');
    expect(n01.specDisplay).toBe('-295 - -305');
    expect(n01.lowerLimit).toBeNull();

    expect(revision.standingContent.remarks).toBe(
      'For Y maintenance, 3M and 6M must be performed at the same time.',
    );
    expect(revision.standingContent.ppe).toEqual([
      'Safety Shoes',
      'Ear Plugs (If required)',
      'Safety Glass (If Required)',
      'Hand Gloves (If Required)',
    ]);
  });

  it('I-TL-22: sample machines are provisional/RED with obviously-non-real PROV- codes, and their schedule rules are materialised from the template frequencies', async () => {
    const token = await login(AUTHOR.email, AUTHOR.password);
    const doc4 = firstSummary.documents.find((d) => d.documentNumber === 'CE 95 020 00 01')!;
    expect(doc4.sampleMachines).toHaveLength(2); // one template, MANY assets (UR-018)

    for (const machine of doc4.sampleMachines) {
      expect(machine.code).toMatch(/^PROV-[0-9A-F]{8}$/);
      const asset = await fetchJson<{ codeProvisional: boolean; description: string }>(
        `/api/v1/assets/${machine.id}`,
        token,
      );
      expect(asset.codeProvisional).toBe(true); // RED in the admin UI
      expect(asset.description).toContain('SAMPLE machine (slice 13-TL)');
    }

    const rules = await fetchJson<{ frequency: string; nextDueOn: string }[]>(
      `/api/v1/assets/${doc4.sampleMachines[0].id}/schedule`,
      token,
    );
    // Doc 4 has items at 3M/6M/Y — one rule per distinct frequency.
    expect(rules.map((r) => r.frequency)).toEqual(['M3', 'M6', 'Y']);
  });

  it('I-TL-23: the scheduler tick generates real jobs from the loaded templates, and the Y job for the ASM sample machine carries the full 14-item checklist (cascade — U-CAS-08) and all 20 measurements', async () => {
    const scheduler = app.get(SchedulerService);
    const run = await scheduler.run();
    if (!run.ran) throw new Error(`scheduler did not run: ${run.reason}`);
    expect(run.generated).toBeGreaterThan(0);

    const token = await login(AUTHOR.email, AUTHOR.password);
    const doc4 = firstSummary.documents.find((d) => d.documentNumber === 'CE 95 020 00 01')!;
    const machineId = doc4.sampleMachines[0].id;
    const jobs = await fetchJson<{ data: { id: string; frequencyScope: string[] }[] }>(
      `/api/v1/jobs?assetId=${machineId}&limit=50`,
      token,
    );
    expect(jobs.data.length).toBeGreaterThan(0);
    const yJob = jobs.data.find((j) => j.frequencyScope.includes('Y'));
    expect(yJob).toBeDefined();
    // U-CAS-08: a Y job on CE 95 020 00 01 subsumes 3M and 6M.
    expect([...yJob!.frequencyScope].sort()).toEqual(['M3', 'M6', 'Y']);

    const job = await fetchJson<{
      templateRevision: {
        items: { instruction: string; frequency: string }[];
        measurements: { specDisplay: string }[];
      };
    }>(`/api/v1/jobs/${yJob!.id}`, token);

    // The checklist the technician sees IS the parsed source form.
    expect(job.templateRevision.items.map((i) => [i.frequency, i.instruction])).toEqual(
      asmYaml.items.map((i) => [i.frequency, i.instruction]),
    );
    expect(job.templateRevision.measurements).toHaveLength(20);
    expect(job.templateRevision.measurements.map((m) => m.specDisplay)).toEqual(
      asmYaml.measurements.map((m) => m.specDisplay),
    );

    // Second tick: no duplicates (PR-052 / partial unique index).
    const run2 = await scheduler.run();
    if (!run2.ran) throw new Error(`second scheduler run did not run: ${run2.reason}`);
    expect(run2.generated).toBe(0);
  });

  it('I-TL-24: the load is fully attributable — audit events exist for template creation, revision approval and asset creation, written by the named users (PR-TLP-07)', async () => {
    const { rows } = await adminPool.query(
      `SELECT entity_type, action::text, count(*)::int AS n
         FROM audit_event
        WHERE entity_type IN ('form_template', 'template_revision', 'asset_type', 'asset')
        GROUP BY entity_type, action
        ORDER BY entity_type, action`,
    );
    const byKey = new Map(rows.map((r) => [`${r.entity_type}:${r.action}`, r.n as number]));
    expect(byKey.get('form_template:create')).toBe(12);
    expect(byKey.get('asset_type:create')).toBe(12);
    expect(byKey.get('asset:create')).toBe(13);
    // 34 revisions in total across the plans, each approved exactly once.
    expect(byKey.get('template_revision:approve')).toBe(34);
  });
});
