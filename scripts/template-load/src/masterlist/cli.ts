// scripts/template-load/src/masterlist/cli.ts
/**
 * Slice masterlist-migration — Task 6: the runnable entrypoint.
 *
 * Mirrors `../cli-load.ts` in shape and rules: credentials come from the
 * environment ONLY, never argv (matched name-for-name); unknown arguments
 * are rejected rather than ignored; DRY RUN is the default and `--apply` is
 * the only way to write anything (`runImport`, Task 4, enforces this itself
 * — this CLI adds no shortcut, env var or prompt that could bypass it).
 *
 * UNLIKE `cli-load.ts`, credentials are required ONLY on the `--apply` path
 * (review fix round 1, IMPORTANT-1/minor): a dry run never constructs an
 * `ApiClient` (`import.ts`'s `runImport` only does that when `apply ===
 * true`), so demanding production credentials just to preview a workbook
 * would make the safe, widely-runnable step needlessly gated.
 *
 * Environment — required for `--apply` only (no secrets ever on argv):
 *   BAMFORM_BASE_URL            e.g. https://form.bevorasg.com  (NO trailing slash)
 *   BAMFORM_AUTHOR_EMAIL        author account (roles DOC_CONTROLLER + ENGINEER)
 *   BAMFORM_AUTHOR_PASSWORD
 *
 * Flags:
 *   --apply              perform real writes (default: dry run, zero network calls)
 *   --year=2026          plan year (default: 2026 — the owner-decided plan year)
 *   --file=<path>        masterlist workbook to read (default: the committed fixture)
 *
 * Run (from a checkout at the repo root — see docs/DEPLOYMENT_RUNBOOK.md §3.6
 * for the full operator procedure, including WHERE this must run):
 *   npm run import:masterlist -- [flags]
 *   npx ts-node -P scripts/template-load/tsconfig.json scripts/template-load/src/masterlist/cli.ts [flags]
 *
 * Always dry run first, diff `scripts/template-load/evidence/masterlist-import.md`
 * against the paper masterlist, THEN `--apply`.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseYaml } from '../yaml-io';
import { renderImportEvidence } from './evidence';
import { runImport, type ImportReport, type ImportTemplateRef } from './import';
import { parseMasterlist } from './parse';
import { reconcile } from './reconcile';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const YAML_DIR = join(__dirname, '..', '..', 'yaml');
const DEFAULT_FIXTURE = join(__dirname, '__fixtures__', 'masterlist.xlsx');
const EVIDENCE_PATH = join(__dirname, '..', '..', 'evidence', 'masterlist-import.md');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name} (see file header).`);
    process.exit(2);
  }
  return value;
}

export interface Args {
  apply: boolean;
  year: number;
  file: string;
}

/**
 * Pure and exported so the dry-run-default safety property is unit-tested
 * directly (review fix round 1, IMPORTANT-3): `apply` must default to
 * `false`, `--apply` must be the ONLY spelling that flips it, and an
 * unrecognised argument must be rejected rather than silently ignored.
 */
export function parseArgs(argv: readonly string[]): Args {
  let apply = false;
  let year = 2026;
  let file = DEFAULT_FIXTURE;
  const unknown: string[] = [];

  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true;
    } else if (arg.startsWith('--year=')) {
      const raw = arg.slice('--year='.length);
      if (!/^\d{4}$/.test(raw)) {
        console.error(`--year must be a 4-digit year (e.g. --year=2026); got "${raw}"`);
        process.exit(2);
      }
      year = Number(raw);
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
    } else {
      unknown.push(arg);
    }
  }

  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}`);
    process.exit(2);
  }

  return { apply, year, file };
}

/**
 * `formFrequencies` for `reconcile()` (Task 3) and the `templates` catalogue
 * `runImport()` (Task 4) needs are both derived from the SAME committed
 * template-load YAML (`scripts/template-load/yaml/*.yaml`) — the same
 * source of truth `cli-load.ts` loads into the running instance. Each file's
 * `asset_type_code` plus its items' distinct `frequency` values become one
 * entry; nothing here touches the network.
 */
function loadTemplateCatalogue(yamlDir: string): {
  formFrequencies: Record<string, string[]>;
  templates: Record<string, ImportTemplateRef>;
} {
  const formFrequencies: Record<string, string[]> = {};
  const templates: Record<string, ImportTemplateRef> = {};
  const files = readdirSync(yamlDir).filter((f) => f.endsWith('.yaml'));
  for (const file of files) {
    const doc = parseYaml(readFileSync(join(yamlDir, file), 'utf8'));
    formFrequencies[doc.assetTypeCode] = [...new Set(doc.items.map((i) => i.frequency as string))];
    templates[doc.assetTypeCode] = { documentNumber: doc.documentNumber, title: doc.title };
  }
  return { formFrequencies, templates };
}

/**
 * Row-level log-line prefixes `import.ts` emits UNINDENTED, one per
 * fully-resolved row outcome (skip / dry-run preview / unmapped-reuse /
 * unmapped-block / hard-error / apply-mode left-unplanned). Requires 2+
 * spaces after the keyword (review fix round 2, MINOR) so this does NOT
 * match the run-level header line `DRY RUN (default) — …`, which has only
 * one space before "RUN" — every genuine row-outcome line is padded to
 * align (`DRY     `, `SKIP    `, `ERROR   `, …), so this is unambiguous.
 * `import.ts` also deliberately keeps its two PER-FREQUENCY diagnostic
 * lines (schedule_rule missing after bootstrap / already manually
 * adjusted) INDENTED so they never match this pattern — a machine can
 * revisit those up to 4 times in the schedule-writing loop, which would
 * otherwise make this over-count rather than under-count. An ordinary
 * successful `--apply` import does not get an unindented line at all, so
 * this remains a LOWER BOUND on rows processed, never an exact count.
 */
const ROW_OUTCOME_RE = /^(?:DRY|SKIP|ERROR|BLOCK|REUSE|NOTE)\s{2,}/;

/**
 * The four state-changing calls in `import.ts` (`POST /assets`,
 * `POST /assets/{id}/documents`, `GET /assets/{id}/schedule` — it
 * materialises bootstrap rows as a side effect, so it counts too — and
 * `PUT /assets/{id}/schedule`) are each logged TWICE: "— attempting"
 * immediately before the network call, "— done" immediately after it
 * resolves (review fix round 2, IMPORTANT). If the process dies mid-call,
 * the "attempting" line survives in the log but the "done" line never
 * gets written — so `attempted > confirmed` is the signal that the LAST
 * state-changing call's outcome is genuinely unknown (it may have applied
 * on the server even though this run never saw that happen). This is
 * deliberately a distinct, narrower pattern than "any POST/PUT/GET line"
 * — ordinary read-only listing calls (`GET /assets?assetTypeId=…`, the
 * unfiltered `GET /assets`, etc.) are NOT tagged `WRITE` and must never be
 * counted as a write attempt.
 */
export const WRITE_ATTEMPT_RE = /^\s+WRITE\s.*— attempting$/;
export const WRITE_DONE_RE = /^\s+WRITE\s.*— done$/;

/**
 * A LOWER BOUND on rows processed (see `ROW_OUTCOME_RE`'s doc comment) —
 * exported, and extracted to its own function rather than left inline in
 * `main()`'s catch block (review fix round 3, MINOR), because this exact
 * classification logic has been wrong in each of the last two review
 * rounds (a false alarm, then a false all-clear) and must not go on
 * resting on hand-tracing. See `cli.spec.ts` for the regression tests —
 * built from REAL `import.ts` log output, not invented strings.
 */
export function countRowOutcomes(logLines: readonly string[]): number {
  return logLines.filter((l) => ROW_OUTCOME_RE.test(l)).length;
}

/**
 * The three honest states the mid-run failure banner can report, given the
 * WRITE-tagged lines the four state-changing `import.ts` calls emit before
 * and after each `await` (see `WRITE_ATTEMPT_RE`/`WRITE_DONE_RE` above).
 * Pure and exported for the same reason as `countRowOutcomes`.
 */
export type WriteState =
  | { kind: 'nothing-attempted' }
  | { kind: 'outcome-unknown'; attempted: number; confirmed: number }
  | { kind: 'all-confirmed'; confirmed: number };

export function classifyWriteState(logLines: readonly string[]): WriteState {
  const attempted = logLines.filter((l) => WRITE_ATTEMPT_RE.test(l)).length;
  const confirmed = logLines.filter((l) => WRITE_DONE_RE.test(l)).length;
  if (attempted === 0) return { kind: 'nothing-attempted' };
  if (attempted > confirmed) return { kind: 'outcome-unknown', attempted, confirmed };
  return { kind: 'all-confirmed', confirmed };
}

async function main(): Promise<void> {
  const { apply, year, file } = parseArgs(process.argv.slice(2));

  // Credentials are read unconditionally (so a typo surfaces the same way
  // either way) but only REQUIRED — via requireEnv's process.exit(2) — on
  // the --apply path. A dry run runs with empty strings that `runImport`
  // never uses (it only constructs an `ApiClient` when `apply === true`).
  const baseUrl = apply
    ? requireEnv('BAMFORM_BASE_URL').replace(/\/+$/, '')
    : (process.env.BAMFORM_BASE_URL ?? '').replace(/\/+$/, '');
  const author = apply
    ? { email: requireEnv('BAMFORM_AUTHOR_EMAIL'), password: requireEnv('BAMFORM_AUTHOR_PASSWORD') }
    : {
        email: process.env.BAMFORM_AUTHOR_EMAIL ?? '',
        password: process.env.BAMFORM_AUTHOR_PASSWORD ?? '',
      };

  const { formFrequencies, templates } = loadTemplateCatalogue(YAML_DIR);
  const rows = parseMasterlist(file);
  const reconciliations = reconcile(rows, formFrequencies);

  // Buffered as well as streamed: `runImport` logs each row as it is
  // processed, so if it rejects mid-run (network failure, unexpected
  // exception — see the catch below) everything printed up to that point
  // has ALREADY reached the operator's terminal in real time. The buffer
  // lets the failure message report accurate counts (see
  // `countRowOutcomes`/`classifyWriteState` above), not just a raw,
  // misleading line total.
  const logLines: string[] = [];
  const log = (line: string): void => {
    logLines.push(line);
    console.log(line);
  };

  let report: ImportReport;
  try {
    report = await runImport({ baseUrl, author, reconciliations, templates, year, apply, log });
  } catch (error) {
    // `runImport` rejects before returning an `ImportReport` on an uncaught
    // error (e.g. a network failure mid-`--apply`) — per-row RESULTS for
    // this run are lost, but every row already processed was already
    // logged above as it happened. Report that plainly rather than letting
    // a bare stack trace be the only sign a migration died partway through
    // — and report it ACCURATELY (review fix round 1 IMPORTANT-2, round 2
    // IMPORTANT): a raw log-line count conflates a header line with a row
    // outcome, and "no write LINES were logged" is not the same claim as
    // "nothing was written" — a write logged "attempting" but not yet
    // "done" may have applied on the server regardless. Never assert more
    // than the log actually supports.
    const rowOutcomes = countRowOutcomes(logLines);
    const writeState = classifyWriteState(logLines);

    console.error('');
    console.error('='.repeat(78));
    console.error(
      `IMPORT FAILED mid-run, in ${apply ? 'APPLY' : 'DRY RUN'} mode. The importer rejected ` +
        'before returning a structured report, so no summary or evidence file will be written ' +
        'this time. From the log above:',
    );
    console.error(
      `  ${rowOutcomes} row(s) reached a final logged outcome (skip / blocked / dry-run preview ` +
        '/ left-unplanned) — a LOWER BOUND on rows processed: an ordinary successful --apply ' +
        'write logs no single summary line, so this can under-count.',
    );
    if (apply) {
      if (writeState.kind === 'nothing-attempted') {
        console.error(
          '  No state-changing call (asset/document create, schedule read-or-materialise, ' +
            'schedule write) was even ATTEMPTED — nothing above appears to have been created ' +
            'or changed.',
        );
      } else if (writeState.kind === 'outcome-unknown') {
        console.error(
          `  ${writeState.confirmed} of ${writeState.attempted} attempted write(s) were ` +
            'confirmed done. The LAST attempted write never logged as done — its outcome is ' +
            'UNKNOWN: it may have applied on the server even though this run never saw that ' +
            'happen. Treat the system as possibly already changed by that one call.',
        );
      } else {
        console.error(
          `  ${writeState.confirmed} write(s) were attempted AND confirmed before the failure ` +
            '— some machines above already exist, partially or fully, in the system.',
        );
      }
    }
    console.error(
      'The importer is idempotent (it re-checks state before writing, and never blindly ' +
        'swallows a 409): once the underlying problem is fixed, it is SAFE to re-run this exact ' +
        'command — already-created machines, documents and schedule rules will be reused, not ' +
        'duplicated or overwritten.',
    );
    console.error('');
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    console.error('='.repeat(78));
    process.exit(1);
    return;
  }

  const c = report.counts;
  const skippedLabels = report.machines.filter((m) => m.status === 'skipped').map((m) => m.label);
  const leftUnplannedCodes = report.machines.filter((m) => m.leftUnplanned).map((m) => m.code);

  console.log('');
  console.log(
    `DONE (${report.dryRun ? 'DRY RUN — nothing was written' : 'APPLY — writes were performed'}): ` +
      `imported ${c.imported} (of which ${c.leftUnplanned} left unplanned) · skipped ${c.skipped}` +
      `${skippedLabels.length ? ` (${skippedLabels.join(', ')})` : ''} · unmapped ${c.unmapped} · ` +
      `hardError ${c.hardError} · leftUnplanned ${c.leftUnplanned}` +
      `${leftUnplannedCodes.length ? ` (${leftUnplannedCodes.join(', ')})` : ''}`,
  );

  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  // Repo-root-relative when possible, so the evidence file is reproducible
  // across machines/runs of the SAME input (review fix round 1, minor) —
  // an absolute path bakes in one laptop's home directory for no benefit.
  const evidenceFile = file.startsWith(REPO_ROOT) ? relative(REPO_ROOT, file) : file;
  writeFileSync(
    EVIDENCE_PATH,
    renderImportEvidence(report, { templates, file: evidenceFile, year }),
  );
  console.log(
    `Evidence written to ${EVIDENCE_PATH} — diff this against the paper masterlist BEFORE --apply.`,
  );

  if (c.hardError > 0 || c.unmapped > 0) {
    console.error('');
    console.error(
      `${c.hardError + c.unmapped} row(s) blocked (hard-error/unmapped) — see the log above and ` +
        'the evidence file for the full reason. Exiting non-zero.',
    );
    process.exit(1);
  }
}

// Guarded so `parseArgs` (and, in principle, `main`) can be imported by
// tests without running the CLI as a side effect of the import itself.
/* istanbul ignore next -- entrypoint glue, exercised by running the CLI, not unit tests */
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
