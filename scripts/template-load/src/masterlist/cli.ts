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
 * Environment (no secrets on the command line):
 *   BAMFORM_BASE_URL            e.g. https://form.bevorasg.com  (NO trailing slash)
 *   BAMFORM_AUTHOR_EMAIL        author account (roles DOC_CONTROLLER + ENGINEER)
 *   BAMFORM_AUTHOR_PASSWORD
 *
 * Flags:
 *   --apply              perform real writes (default: dry run, zero network calls)
 *   --year=2026          plan year (default: 2026 — the owner-decided plan year)
 *   --file=<path>        masterlist workbook to read (default: the committed fixture)
 *
 * Run:
 *   npm run import:masterlist -- [flags]
 *   npx ts-node -P scripts/template-load/tsconfig.json scripts/template-load/src/masterlist/cli.ts [flags]
 *
 * See docs/DEPLOYMENT_RUNBOOK.md §3.6 for the full operator procedure —
 * always dry run first, diff `scripts/template-load/evidence/masterlist-import.md`
 * against the paper masterlist, THEN `--apply`.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseYaml } from '../yaml-io';
import { renderImportEvidence } from './evidence';
import { runImport, type ImportReport, type ImportTemplateRef } from './import';
import { parseMasterlist } from './parse';
import { reconcile } from './reconcile';

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

interface Args {
  apply: boolean;
  year: number;
  file: string;
}

function parseArgs(argv: readonly string[]): Args {
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

async function main(): Promise<void> {
  const { apply, year, file } = parseArgs(process.argv.slice(2));

  const baseUrl = requireEnv('BAMFORM_BASE_URL').replace(/\/+$/, '');
  const author = {
    email: requireEnv('BAMFORM_AUTHOR_EMAIL'),
    password: requireEnv('BAMFORM_AUTHOR_PASSWORD'),
  };

  const { formFrequencies, templates } = loadTemplateCatalogue(YAML_DIR);
  const rows = parseMasterlist(file);
  const reconciliations = reconcile(rows, formFrequencies);

  // Buffered as well as streamed: `runImport` logs each row as it is
  // processed, so if it rejects mid-run (network failure, unexpected
  // exception — see the catch below) everything printed up to that point
  // has ALREADY reached the operator's terminal in real time. The buffer
  // just lets the failure message report how many lines that was.
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
    // a bare stack trace be the only sign a migration died partway through.
    console.error('');
    console.error('='.repeat(78));
    console.error(
      `IMPORT FAILED mid-run, in ${apply ? 'APPLY' : 'DRY RUN'} mode. ${logLines.length} ` +
        'row-level log line(s) above are everything recoverable from this run — the importer ' +
        'rejected before returning a structured report, so no summary or evidence file will be ' +
        'written this time.',
    );
    if (apply) {
      console.error(
        'Some writes may already have happened for machines logged above before the failure.',
      );
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
      `imported ${c.imported} · skipped ${c.skipped}` +
      `${skippedLabels.length ? ` (${skippedLabels.join(', ')})` : ''} · unmapped ${c.unmapped} · ` +
      `hardError ${c.hardError} · leftUnplanned ${c.leftUnplanned}` +
      `${leftUnplannedCodes.length ? ` (${leftUnplannedCodes.join(', ')})` : ''}`,
  );

  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, renderImportEvidence(report, { templates, file, year }));
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
