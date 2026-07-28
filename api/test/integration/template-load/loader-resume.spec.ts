/**
 * Slice 13-TL fix-pass — loader resume/idempotency under contract-trimmed
 * fields (TEST_PLAN I-TL-28..30; review finding T-1).
 *
 * T-1: the API's zod contract `.trim()`s several string fields
 * (`revisionCode`, `documentNumber`, `title`, `instruction`, `description`,
 * `specDisplay`, `stableKey`, asset-type `code`/`name`). The loader's
 * resume/idempotency checks compare LOCAL YAML values against SERVER-STORED
 * values, so any field whose YAML value carries edge whitespace compares
 * unequal forever. Doc 5's revision code is `'B '` (trailing space, verbatim
 * from the source by design — I-TL-13 asserts it), so an interruption inside
 * doc 5's revision plan wedged EVERY subsequent run with a misleading
 * "not produced by this loader" error, taking docs 6-12 down with it.
 *
 * These tests reproduce that wedge exactly (kill immediately after the `'B '`
 * revision is created, then re-run) and pin the general guarantees the
 * runbook's "re-run the same command" recovery depends on.
 */
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoad } from '../../../../scripts/template-load/src/loader';
import { parseYaml } from '../../../../scripts/template-load/src/yaml-io';
import { createTestApp } from '../helpers/app';
import { createLoginableUser } from '../helpers/auth-fixtures';
import { adminPool, closeAll, resetDatabase } from '../helpers/db';
import { closeRedis, resetRedis } from '../helpers/redis';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const YAML_DIR = join(REPO_ROOT, 'scripts', 'template-load', 'yaml');

const AUTHOR = { email: 'resume.author@bamform.test', password: 'Resume-Author-Pw-2026!' };
const APPROVER = { email: 'resume.approver@bamform.test', password: 'Resume-Approver-Pw-2026!' };

/** Doc 5 (the `'B '` revision code) and doc 6, which sorts after it. */
const DOC5 = 'CE-95-020-00-02.yaml';
const DOC6 = 'CE-95-020-00-03.yaml';

jest.setTimeout(240_000);

describe('loader resume under contract-trimmed fields (I-TL-28..30, review T-1)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let yamlDir: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    // A two-document subset: doc 5 carries the `'B '` code, doc 6 sorts
    // after it and is what the wedge additionally blocked.
    yamlDir = mkdtempSync(join(tmpdir(), 'bamform-tl-resume-'));
    for (const file of [DOC5, DOC6]) {
      copyFileSync(join(YAML_DIR, file), join(yamlDir, file));
    }
  });

  afterAll(async () => {
    await app.close();
    await closeAll();
    await closeRedis();
  });

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
    await createLoginableUser({
      email: AUTHOR.email,
      password: AUTHOR.password,
      fullName: 'Resume Author',
      roleCodes: ['DOC_CONTROLLER', 'ENGINEER'],
    });
    await createLoginableUser({
      email: APPROVER.email,
      password: APPROVER.password,
      fullName: 'Resume Approver',
      roleCodes: ['DOC_CONTROLLER'],
    });
  });

  const load = (log?: (line: string) => void) =>
    runLoad({
      baseUrl,
      author: AUTHOR,
      approver: APPROVER,
      yamlDir,
      createSampleMachines: false,
      log,
    });

  /**
   * Abort the run from the log callback the instant the loader reports
   * creating the revision whose code matches — the POST has already
   * committed server-side, submit/approve have not run. This is exactly the
   * ^C / network-death / token-hiccup window the runbook's recovery covers.
   */
  class SimulatedKill extends Error {}
  /**
   * `armAfter` guards against killing on the wrong document: both documents'
   * plans contain codes `0` and `A`, so an unguarded match on `A` would fire
   * inside doc 5 (processed first) and never reach doc 6.
   */
  const killAfterRevisionCreated = (code: string, armAfter?: string) => {
    let armed = armAfter === undefined;
    return (line: string) => {
      if (!armed) {
        if (line.includes(armAfter!)) armed = true;
        return;
      }
      if (line.includes(`revision ${code}: created`)) throw new SimulatedKill(line);
    };
  };

  it("I-TL-28: an interruption right after doc 5's `'B '` revision is created still resumes cleanly on re-run — the trailing space must not wedge the loader (T-1)", async () => {
    await expect(load(killAfterRevisionCreated('B '))).rejects.toThrow(SimulatedKill);

    // The interrupted revision really is on the server, stored TRIMMED —
    // the asymmetry that caused the wedge.
    const mid = await adminPool.query(
      `SELECT revision_code, sequence_ordinal, status::text
         FROM template_revision r
         JOIN form_template t ON t.id = r.form_template_id
        WHERE t.document_number = 'CE 95 020 00 02'
        ORDER BY sequence_ordinal`,
    );
    expect(mid.rows.map((r) => r.revision_code)).toEqual(['0', 'A', 'B']); // NOT 'B '
    expect(mid.rows[2].status).toBe('draft');

    // The re-run the runbook instructs: must recover, not refuse.
    const summary = await load();
    expect(summary.documents.map((d) => [d.documentNumber, d.action])).toEqual([
      ['CE 95 020 00 02', 'resumed'],
      ['CE 95 020 00 03', 'created'], // the doc the wedge used to block
    ]);

    // Doc 5 ends complete and correct: contiguous ordinals, verbatim codes
    // as stored (trimmed), final revision CURRENT.
    const after = await adminPool.query(
      `SELECT revision_code, sequence_ordinal, status::text
         FROM template_revision r
         JOIN form_template t ON t.id = r.form_template_id
        WHERE t.document_number = 'CE 95 020 00 02'
        ORDER BY sequence_ordinal`,
    );
    expect(after.rows.map((r) => [r.revision_code, r.sequence_ordinal, r.status])).toEqual([
      ['0', 0, 'superseded'],
      ['A', 1, 'superseded'],
      ['B', 2, 'superseded'],
      ['C', 3, 'current'],
    ]);

    // No duplicate revisions were spawned by the resume.
    expect(after.rows).toHaveLength(4);

    // And the resumed document's content is the YAML's content.
    const doc5 = parseYaml(readFileSync(join(yamlDir, DOC5), 'utf8'));
    const counts = await adminPool.query(
      `SELECT
         (SELECT count(*)::int FROM template_item i
            WHERE i.template_revision_id = r.id AND i.active) AS items,
         (SELECT count(*)::int FROM template_measurement m
            WHERE m.template_revision_id = r.id AND m.active) AS measurements
         FROM template_revision r
         JOIN form_template t ON t.id = r.form_template_id
        WHERE t.document_number = 'CE 95 020 00 02' AND r.status = 'current'`,
    );
    expect(counts.rows[0]).toEqual({
      items: doc5.items.length,
      measurements: doc5.measurements.length,
    });
  });

  it('I-TL-29: a third and fourth re-run after the recovery are clean no-ops — the resume does not leave the document permanently "drifted" (no corrective-revision loop)', async () => {
    await expect(load(killAfterRevisionCreated('B '))).rejects.toThrow(SimulatedKill);
    await load();

    const third = await load();
    expect(third.unchanged).toBe(2);
    const fourth = await load();
    expect(fourth.unchanged).toBe(2);

    // Zero domain rows written by the no-op runs: revision count is stable
    // (a trim mismatch in contentMatches would author a new corrective
    // revision on EVERY run — the same defect class as T-1).
    const revisions = await adminPool.query(`SELECT count(*)::int AS n FROM template_revision`);
    expect(revisions.rows[0].n).toBe(4 + 3); // doc 5's 4 + doc 6's 3
  });

  it('I-TL-30: killing at a DIFFERENT point (doc 6, mid-plan) also resumes cleanly — general resumability is intact', async () => {
    // Arm only once doc 5 has fully completed, so the kill lands in doc 6.
    await expect(load(killAfterRevisionCreated('A', 'CE 95 020 00 02: created'))).rejects.toThrow(
      SimulatedKill,
    );

    const summary = await load();
    // Doc 5 was already complete (no-op); doc 6 resumes mid-plan.
    expect(summary.documents.map((d) => [d.documentNumber, d.action])).toEqual([
      ['CE 95 020 00 02', 'unchanged'],
      ['CE 95 020 00 03', 'resumed'],
    ]);
    expect(summary.created).toBe(0);

    const rows = await adminPool.query(
      `SELECT t.document_number, count(*)::int AS revisions,
              count(*) FILTER (WHERE r.status = 'current')::int AS current
         FROM template_revision r
         JOIN form_template t ON t.id = r.form_template_id
        GROUP BY t.document_number ORDER BY t.document_number`,
    );
    expect(rows.rows).toEqual([
      { document_number: 'CE 95 020 00 02', revisions: 4, current: 1 },
      { document_number: 'CE 95 020 00 03', revisions: 3, current: 1 },
    ]);
  });
});
