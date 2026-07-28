/**
 * Slice 13-TL — the committed intermediate YAML and AC-01 evidence pack are
 * exactly what extraction from the current source workbooks produces
 * (TEST_PLAN I-TL-17..18).
 *
 * PR-TLP-08: the YAML committed under scripts/template-load/yaml/ is THE
 * reviewable artefact between spreadsheet and database; PR-TLP-09: staging
 * and production load from that identical YAML; PR-TLP-10: source_sha256
 * pins the exact source file. This spec regenerates everything in memory
 * and fails on ANY byte difference — a changed source workbook, a changed
 * parser, or a hand-edited YAML/evidence file all surface here instead of
 * silently diverging from what the client verified.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllForms } from '../../../../scripts/template-load/src/parse';
import { emitYaml, parseYaml, yamlFileName } from '../../../../scripts/template-load/src/yaml-io';
import {
  renderEvidence,
  renderRegister,
  evidenceFileName,
} from '../../../../scripts/template-load/src/evidence';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FORMS_DIR = join(REPO_ROOT, 'Sample of Forms');
const YAML_DIR = join(REPO_ROOT, 'scripts', 'template-load', 'yaml');
const EVIDENCE_DIR = join(REPO_ROOT, 'scripts', 'template-load', 'evidence');

describe('committed YAML + evidence drift guard (I-TL-17..18)', () => {
  const docs = parseAllForms(FORMS_DIR);

  it('I-TL-17: the 12 committed YAML files byte-match re-extraction from the sources, and round-trip losslessly', () => {
    const expectedNames = docs.map((d) => yamlFileName(d)).sort();
    const committed = readdirSync(YAML_DIR)
      .filter((f) => f.endsWith('.yaml'))
      .sort();
    expect(committed).toEqual(expectedNames);

    for (const doc of docs) {
      const emitted = emitYaml(doc);
      const onDisk = readFileSync(join(YAML_DIR, yamlFileName(doc)), 'utf8');
      expect({ file: yamlFileName(doc), text: onDisk }).toEqual({
        file: yamlFileName(doc),
        text: emitted,
      });
      // Round-trip: the loader reads back exactly the document that was
      // extracted (the load pipeline runs from YAML, not from .xlsx).
      expect(parseYaml(onDisk)).toEqual(doc);
    }
  });

  it('I-TL-18: the committed AC-01 evidence pack (12 per-form files + the register) byte-matches regeneration', () => {
    for (const doc of docs) {
      const emitted = renderEvidence(doc, FORMS_DIR);
      const onDisk = readFileSync(join(EVIDENCE_DIR, evidenceFileName(doc)), 'utf8');
      expect({ file: evidenceFileName(doc), text: onDisk }).toEqual({
        file: evidenceFileName(doc),
        text: emitted,
      });
    }
    const register = renderRegister(docs);
    expect(readFileSync(join(EVIDENCE_DIR, 'REGISTER.md'), 'utf8')).toBe(register);
  });
});
