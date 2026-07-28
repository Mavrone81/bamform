/**
 * Slice 13-TL — extraction CLI (TLP §6 step 3): parse the twelve source
 * workbooks in `Sample of Forms/` and (re)generate the committed
 * intermediate YAML (scripts/template-load/yaml/) and the AC-01 evidence
 * pack (scripts/template-load/evidence/).
 *
 * Deterministic: running it twice produces byte-identical output, and the
 * drift guard (api/test/integration/template-load/yaml-drift.spec.ts,
 * I-TL-17/18) fails CI if the committed artefacts do not match the current
 * sources + parser.
 *
 * Run: npx ts-node -P scripts/template-load/tsconfig.json scripts/template-load/src/cli-extract.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderEvidence, renderRegister, evidenceFileName } from './evidence';
import { parseAllForms } from './parse';
import { emitYaml, yamlFileName } from './yaml-io';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const FORMS_DIR = join(REPO_ROOT, 'Sample of Forms');
const YAML_DIR = join(REPO_ROOT, 'scripts', 'template-load', 'yaml');
const EVIDENCE_DIR = join(REPO_ROOT, 'scripts', 'template-load', 'evidence');

function main(): void {
  const docs = parseAllForms(FORMS_DIR);
  mkdirSync(YAML_DIR, { recursive: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  for (const doc of docs) {
    writeFileSync(join(YAML_DIR, yamlFileName(doc)), emitYaml(doc));
    writeFileSync(join(EVIDENCE_DIR, evidenceFileName(doc)), renderEvidence(doc, FORMS_DIR));
    console.log(
      `${doc.documentNumber}: ${doc.items.length} items, ${doc.measurements.length} measurements, ` +
        `${doc.ambiguities.length} register entries -> ${yamlFileName(doc)}`,
    );
  }
  writeFileSync(join(EVIDENCE_DIR, 'REGISTER.md'), renderRegister(docs));

  const totalItems = docs.reduce((n, d) => n + d.items.length, 0);
  console.log(`TOTAL: ${docs.length} documents, ${totalItems} items.`);
}

main();
