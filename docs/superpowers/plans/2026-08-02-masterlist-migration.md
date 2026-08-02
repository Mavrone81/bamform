# Masterlist Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import `ML-S-MFT-00015 Rev 21` into BamForm — 77 machines, their PM documents, and their 2026 schedule — so the system holds the plant's real programme and the spreadsheet can be retired.

**Architecture:** A CLI in the shape of the existing template loader, living beside it at `scripts/template-load/src/masterlist/` so it reuses the proven `xlsx.ts` reader and `ApiClient` rather than duplicating a zip parser or an auth flow. All parsing, mapping and date arithmetic are pure functions in their own files, unit-tested without a workbook or a server; only the orchestrator touches the network. It drives the HTTP API, never the database, so validation, area scoping and the audit trail stay intact.

**Tech Stack:** TypeScript, ts-node, the repo's own `xlsx.ts` (no spreadsheet dependency), Jest.

## Global Constraints

- **Drive the HTTP API, never the database.** Same as the template loader.
- **Dry run is the default.** Writes happen only with `--apply`.
- **Idempotent.** Re-running must not duplicate a machine or overwrite a schedule a human has adjusted. Re-check state before writing; never swallow a 409 blindly.
- **Never guess a mapping.** An unmapped model, a missing template or an unparseable label is reported and that machine is skipped — it is never assigned an arbitrary asset type.
- **Secrets come from the environment**, never argv — matching `cli-load.ts` (`BAMFORM_BASE_URL`, `BAMFORM_AUTHOR_EMAIL`, `BAMFORM_AUTHOR_PASSWORD`).
- **`DDA 03` is skipped** by owner decision (machine not on site). `MS-620 ST01` is imported **without** a document.
- Work weeks are **calendar weeks in 2026**: week *n* begins `1 Jan 2026 + (n−1) × 7` days.
- No new npm dependency. No migration. `npm run format:check` before every commit.

---

### Task 1: Parse the masterlist

**Files:**

- Create: `scripts/template-load/src/masterlist/parse.ts`
- Create: `scripts/template-load/src/masterlist/parse.spec.ts`

**Interfaces:**

- Consumes: `readWorkbook` from `../xlsx`.
- Produces:

```ts
export interface PlannedVisit {
  workWeek: number;
  frequency: 'M1' | 'M3' | 'M6' | 'Y';
}
export interface MasterlistRow {
  /** Verbatim column A, whitespace-collapsed. */
  label: string;
  /** Text before `--`, or the whole label when there is no separator. */
  model: string;
  /** Text after `--`, or the whole label when there is no separator. */
  code: string;
  visits: PlannedVisit[];
}
export function parseMasterlist(path: string): MasterlistRow[];
```

- [ ] **Step 1: Write the failing test**

```ts
// scripts/template-load/src/masterlist/parse.spec.ts
import { join } from 'node:path';
import { parseMasterlist } from './parse';

const FIXTURE = join(__dirname, '__fixtures__', 'masterlist.xlsx');

describe('parseMasterlist', () => {
  const rows = parseMasterlist(FIXTURE);

  it('reads every machine row that carries a plan', () => {
    expect(rows).toHaveLength(77);
  });

  it('splits "Model -- CODE" into model and code', () => {
    const ed01 = rows.find((r) => r.code === 'ED01')!;
    expect(ed01.model).toBe('ESEC 2008 sc3 plus');
    expect(ed01.code).toBe('ED01');
  });

  it('treats a label with no separator as its own code', () => {
    const ep01 = rows.find((r) => r.code === 'EP01')!;
    expect(ep01.model).toBe('EP01');
  });

  it('reads the planned visits in work-week order', () => {
    const ed01 = rows.find((r) => r.code === 'ED01')!;
    expect(ed01.visits).toEqual([
      { workWeek: 5, frequency: 'M6' },
      { workWeek: 18, frequency: 'M3' },
      { workWeek: 30, frequency: 'Y' },
      { workWeek: 43, frequency: 'M3' },
    ]);
  });

  it('reads a monthly machine as thirteen visits', () => {
    const ep01 = rows.find((r) => r.code === 'EP01')!;
    expect(ep01.visits).toHaveLength(13);
    expect(ep01.visits.every((v) => v.frequency === 'M1')).toBe(true);
  });

  it('excludes rows with no planned visit', () => {
    expect(rows.some((r) => r.visits.length === 0)).toBe(false);
    expect(rows.some((r) => /internal document/i.test(r.label))).toBe(false);
  });
});
```

- [ ] **Step 2: Add the fixture**

Copy the real workbook to `scripts/template-load/src/masterlist/__fixtures__/masterlist.xlsx`. It is the controlled source document and the tests assert against its real content, exactly as the template-load tests assert against the real CE-95 workbooks.

- [ ] **Step 3: Run, verify fail**

Run: `npx jest --config api/jest.unit.config.js masterlist/parse` — expect FAIL (`parseMasterlist` is not defined). If that config does not pick the path up, use the repo's script-test config; note which in your report.

- [ ] **Step 4: Implement**

```ts
import { readWorkbook } from '../xlsx';

const FREQ: Record<string, PlannedVisit['frequency']> = {
  '1M': 'M1',
  '3M': 'M3',
  '6M': 'M6',
  Y: 'Y',
};

const rowOf = (ref: string): number => Number(ref.replace(/[A-Z]+/g, ''));
const colOf = (ref: string): string => ref.replace(/\d+/g, '');

/**
 * `ML-S-MFT-00015` is a work-week matrix: row 4 carries week numbers across
 * the columns, row 5 month bands, and each machine is one row from row 6 with
 * a frequency in the cell for every week it is due.
 */
export function parseMasterlist(path: string): MasterlistRow[] {
  const sheet = readWorkbook(path).sheets[0];

  const weekOfColumn: Record<string, number> = {};
  for (const ref of Object.keys(sheet.cells)) {
    if (rowOf(ref) !== 4) continue;
    const week = Number(sheet.cells[ref]);
    if (Number.isInteger(week) && week >= 1 && week <= 53) weekOfColumn[colOf(ref)] = week;
  }

  const byRow = new Map<number, MasterlistRow>();
  for (const ref of Object.keys(sheet.cells)) {
    if (colOf(ref) !== 'A' || rowOf(ref) < 6) continue;
    const label = sheet.cells[ref].replace(/\s+/g, ' ').trim();
    if (label === '') continue;
    const sep = label.indexOf('--');
    const model = (sep === -1 ? label : label.slice(0, sep)).trim();
    const code = (sep === -1 ? label : label.slice(sep + 2)).trim();
    byRow.set(rowOf(ref), { label, model, code, visits: [] });
  }

  for (const ref of Object.keys(sheet.cells)) {
    const row = byRow.get(rowOf(ref));
    if (!row || colOf(ref) === 'A') continue;
    const week = weekOfColumn[colOf(ref)];
    const frequency = FREQ[sheet.cells[ref].trim()];
    // A cell that is neither under a week column nor a known frequency is
    // sheet furniture (notes, legend) — not a silent data loss.
    if (week === undefined || frequency === undefined) continue;
    row.visits.push({ workWeek: week, frequency });
  }

  return [...byRow.values()]
    .filter((r) => r.visits.length > 0)
    .map((r) => ({ ...r, visits: r.visits.sort((a, b) => a.workWeek - b.workWeek) }));
}
```

- [ ] **Step 5: Run, verify pass** — all six tests green.

- [ ] **Step 6: Commit**

```bash
git add scripts/template-load/src/masterlist/
git commit -m "feat(masterlist): parse the work-week matrix into machine rows"
```

---

### Task 2: Map models to asset types, and work weeks to dates

**Files:**

- Create: `scripts/template-load/src/masterlist/mapping.ts`
- Create: `scripts/template-load/src/masterlist/mapping.spec.ts`

**Interfaces:**

- Consumes: `MasterlistRow` from Task 1.
- Produces:

```ts
export function workWeekToDate(workWeek: number, year: number): string; // 'YYYY-MM-DD'
export function assetTypeCodeForModel(model: string, code: string): string | null;
export const SKIPPED_CODES: readonly string[]; // ['DDA 03']
```

- [ ] **Step 1: Write the failing test**

```ts
import { workWeekToDate, assetTypeCodeForModel, SKIPPED_CODES } from './mapping';

describe('workWeekToDate — calendar weeks, owner decision 2026-08-02', () => {
  it('puts week 1 on 1 January', () => {
    expect(workWeekToDate(1, 2026)).toBe('2026-01-01');
  });

  it('advances exactly seven days per week', () => {
    expect(workWeekToDate(5, 2026)).toBe('2026-01-29');
    expect(workWeekToDate(18, 2026)).toBe('2026-04-30');
    expect(workWeekToDate(30, 2026)).toBe('2026-07-23');
    expect(workWeekToDate(52, 2026)).toBe('2026-12-24');
  });

  it('rejects a week outside 1-53 rather than producing a wild date', () => {
    expect(() => workWeekToDate(0, 2026)).toThrow();
    expect(() => workWeekToDate(54, 2026)).toThrow();
  });
});

describe('assetTypeCodeForModel', () => {
  it.each([
    ['ESEC 2008 sc3 plus', 'ED01', 'BESI_DIE_ATTACH'],
    ['ESEC 2008 hsc3 plus', 'ED07', 'BESI_DIE_ATTACH'],
    ['ASM Eagle Xtreme GoCu', 'AW01', 'ASM_WIRE_BOND'],
    ['ConnX-Elite Lite KW01', 'KW01', 'KNS_WIRE_BOND'],
    ['Besi ESEC 3200', 'BW01', 'BESI_ESEC_WIRE_BOND'],
    ['MB CME 3010 + TI2270', 'MB01', 'MB_ENCAPSULATION'],
    ['EP01', 'EP01', 'EMERALD_PICK_PLACE'],
    ['PM01', 'PM01', 'POWATEC_MOUNTING'],
    ['BD01', 'BD01', 'BUMP_DISPENSING'],
    ['AVS35-01', 'AVS35-01', 'AVS_35'],
  ])('maps %s / %s', (model, code, expected) => {
    expect(assetTypeCodeForModel(model, code)).toBe(expected);
  });

  it('does NOT confuse Besi Die Attach with Besi Esec Wire Bond', () => {
    // "ESEC 2008" is die attach; "Besi ESEC 3xxx" is wire bond. Both contain
    // "ESEC" — matching loosely puts twenty machines on the wrong form.
    expect(assetTypeCodeForModel('ESEC 2008 hsc3 plus', 'ED03')).toBe('BESI_DIE_ATTACH');
    expect(assetTypeCodeForModel('Besi ESEC 3100 plus', 'BW02')).toBe('BESI_ESEC_WIRE_BOND');
  });

  it('returns null for a model with no form rather than guessing', () => {
    expect(assetTypeCodeForModel('MS-620 ST01', 'MS-620 ST01')).toBeNull();
  });

  it('lists DDA 03 as skipped', () => {
    expect(SKIPPED_CODES).toContain('DDA 03');
  });
});
```

- [ ] **Step 2: Run, verify fail** — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Owner decision 2026-08-02: CALENDAR weeks, not ISO. Week n begins
 * `1 Jan + (n-1) x 7` days, so in 2026 every planned date is a Thursday.
 * Getting this wrong shifts all 77 machines by the same few days and every
 * later due date inherits the error, so the range is checked rather than
 * trusted.
 */
export function workWeekToDate(workWeek: number, year: number): string {
  if (!Number.isInteger(workWeek) || workWeek < 1 || workWeek > 53) {
    throw new Error(`work week out of range: ${workWeek}`);
  }
  const date = new Date(Date.UTC(year, 0, 1));
  date.setUTCDate(date.getUTCDate() + (workWeek - 1) * 7);
  return date.toISOString().slice(0, 10);
}

/** Owner decision: the machine is not on site, so it is not imported at all. */
export const SKIPPED_CODES = ['DDA 03'] as const;

/**
 * ORDER MATTERS. `Besi ESEC 3xxx` (wire bond) must be tested before the
 * looser `ESEC 2008` (die attach) is reached, and both contain "ESEC".
 * Anything unmatched returns null and is reported, never guessed.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/besi\s+esec\s+3/i, 'BESI_ESEC_WIRE_BOND'],
  [/esec\s+2008/i, 'BESI_DIE_ATTACH'],
  [/asm\s+eagle/i, 'ASM_WIRE_BOND'],
  [/connx-elite/i, 'KNS_WIRE_BOND'],
  [/mb\s+(cme|cmt)/i, 'MB_ENCAPSULATION'],
  [/os\s+loading|imos/i, 'OS_LOADING'],
  [/pre\s?mixer|^dp\d/i, 'PRE_MIXER'],
  [/^bd\d/i, 'BUMP_DISPENSING'],
  [/^avs35/i, 'AVS_35'],
  [/^ep\d/i, 'EMERALD_PICK_PLACE'],
  [/^pm\d/i, 'POWATEC_MOUNTING'],
];
```

**These codes were verified against `asset_type_code` in
`scripts/template-load/yaml/*.yaml`, which is the authority.** Note two that are
easy to get wrong: it is `EMERALD_PICK_PLACE`, not `..._AND_PLACE`, and
`PRE_MIXER`, not `PRE_MIXER_MACHINE`. A twelfth code, `MB_E_TEST`, exists and is
matched by no rule — see Task 2b.

export function assetTypeCodeForModel(model: string, code: string): string | null {
  for (const [pattern, assetTypeCode] of RULES) {
    if (pattern.test(model) || pattern.test(code)) return assetTypeCode;
  }
  return null;
}
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add scripts/template-load/src/masterlist/
git commit -m "feat(masterlist): model-to-asset-type rules and calendar work-week dates"
```

---

### Task 2b: Derive the machine number that fills a template title

**Files:**

- Modify: `scripts/template-load/src/masterlist/mapping.ts`
- Modify: `scripts/template-load/src/masterlist/mapping.spec.ts`

**Why this exists:** `AssetDocument.machineNumber` fills the blank in a template
title — `…Record KW___` + `13` renders `…Record KW13`. **8 of the 12 templates
carry such a blank**, so this is the common case, not an exception:

```
KNS Wire Bond … Record KW___          Besi Esec Wire Bond … Record EW_____
BESI Die Attach … Record ED____       Pre-mixer … Record DP_____
MB E-Test … Record______              MB Encapsulation … Record MB_____
OS Loading … Record IMOS 0__          AVS … Record AVS 35-____
```

The prefix is already printed in the title, so the value supplied is the
machine code's **numeric tail**, not the whole code: `KW13` → `13`, `ED01` →
`01`, `AVS35-01` → `01`. Getting this wrong prints `…Record KWKW13` on a
controlled record. Where a title has no blank, `machineNumber` stays null,
which is always valid.

**Interfaces:**

- Produces: `export function machineNumberFor(templateTitle: string, code: string): string | null;`

- [ ] **Step 1: Write the failing test**

```ts
import { machineNumberFor } from './mapping';

describe('machineNumberFor', () => {
  it('returns the numeric tail for a title with a blank', () => {
    expect(machineNumberFor('KNS Wire Bond Preventive Maintenance Record KW___', 'KW13')).toBe('13');
    expect(machineNumberFor('BESI Die Attach Preventive Maintenance Record ED____', 'ED01')).toBe('01');
  });

  it('handles a hyphenated code', () => {
    expect(machineNumberFor('Preventive Maintenance Work Instruction / Record AVS 35-____', 'AVS35-01')).toBe('01');
  });

  it('returns null when the title has no blank to fill', () => {
    // Emerald's title is a fixed "EP01" — filling it would corrupt the title.
    expect(machineNumberFor('Emerald Pick and Place Preventive Maintenance Record EP01', 'EP01')).toBeNull();
  });

  it('returns null when the code has no numeric tail rather than guessing', () => {
    expect(machineNumberFor('MB E-Test Preventive Maintenance Record______', 'MS-620 ST01')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

```ts
/**
 * The blank in a template title is a run of underscores. The prefix before it
 * is already printed, so what gets supplied is the machine code's trailing
 * digits — `KW13` fills `KW___` with `13`, never `KW13`.
 */
export function machineNumberFor(templateTitle: string, code: string): string | null {
  if (!/_{2,}/.test(templateTitle)) return null;
  const trimmed = code.trim();
  // A real machine code is a single token — ED01, KW13, AVS35-01. A label with
  // a space in it is a model-plus-station string like `MS-620 ST01`, whose
  // trailing digits belong to the station, not to a machine number. Taking
  // them would print `…Record 01` on a controlled record for a machine that
  // has no number at all.
  if (/\s/.test(trimmed)) return null;
  const tail = /(\d+)\s*$/.exec(trimmed);
  return tail ? tail[1] : null;
}
```

**The whitespace guard is not optional.** Without it this function contradicts
its own test above: `MS-620 ST01` matches `/(\d+)\s*$/` on the `01` of `ST01`
and returns `"01"` where the test requires `null`.

- [ ] **Step 4: Verify against every real template**

Print each template title beside the machine number the rule would produce for
one of its machines, and eyeball all 12:

```bash
grep -h "^title:" scripts/template-load/yaml/*.yaml
```

Report any title whose blank is not a plain underscore run — the rule assumes it
is, and `OS Loading … IMOS 0__` in particular already carries a leading `0`, so
check whether `IMOS-01` should supply `01` or `1`. **If it is ambiguous, stop
and ask rather than choosing.**

- [ ] **Step 5: Run, verify pass; commit**

```bash
git add scripts/template-load/src/masterlist/
git commit -m "feat(masterlist): derive the machine number that fills a template title"
```

---

### Task 3: Reconcile the plan against each form

**Files:**

- Create: `scripts/template-load/src/masterlist/reconcile.ts`
- Create: `scripts/template-load/src/masterlist/reconcile.spec.ts`

**Interfaces:**

- Consumes: `MasterlistRow`, `assetTypeCodeForModel`.
- Produces:

```ts
export interface Reconciliation {
  row: MasterlistRow;
  assetTypeCode: string | null;
  /** Frequencies the plan schedules, in cascade order. */
  planned: string[];
  /** Frequencies the form defines. */
  formDefines: string[];
  /** In the form but not the plan — the operator is asked about each. */
  surplus: string[];
  /** In the plan but not the form — a hard error; the form cannot describe it. */
  missing: string[];
}
export function reconcile(
  rows: MasterlistRow[],
  formFrequencies: Record<string, string[]>,
): Reconciliation[];
```

- [ ] **Step 1: Write the failing test**

```ts
import { reconcile } from './reconcile';

const forms = {
  ASM_WIRE_BOND: ['M3', 'M6', 'Y'],
  EMERALD_PICK_AND_PLACE: ['M1', 'M3'],
};

const row = (code: string, model: string, freqs: string[]) => ({
  label: model,
  model,
  code,
  visits: freqs.map((f, i) => ({ workWeek: i * 4 + 1, frequency: f as never })),
});

describe('reconcile', () => {
  it('reports no difference when plan and form agree', () => {
    const [r] = reconcile([row('AW01', 'ASM Eagle Xtreme GoCu', ['M3', 'M6', 'Y'])], forms);
    expect(r.surplus).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('reports a frequency the form defines but the plan does not schedule', () => {
    const [r] = reconcile([row('AW06', 'ASM Eagle Xtreme GoCu', ['M3', 'M6'])], forms);
    expect(r.surplus).toEqual(['Y']);
    expect(r.missing).toEqual([]);
  });

  it('reports a frequency the plan needs but the form cannot describe', () => {
    const [r] = reconcile([row('EP01', 'EP01', ['M1', 'M6'])], forms);
    expect(r.missing).toEqual(['M6']);
  });

  it('leaves assetTypeCode null for an unmapped model', () => {
    const [r] = reconcile([row('MS-620 ST01', 'MS-620 ST01', ['M1'])], forms);
    expect(r.assetTypeCode).toBeNull();
  });

  it('deduplicates a repeated frequency — EP01 is thirteen monthly visits, one rule', () => {
    const [r] = reconcile([row('EP01', 'EP01', ['M1', 'M1', 'M1'])], forms);
    expect(r.planned).toEqual(['M1']);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

```ts
const ORDER = ['M1', 'M3', 'M6', 'Y'];
const sortFreq = (a: string, b: string) => ORDER.indexOf(a) - ORDER.indexOf(b);

/**
 * A machine visited thirteen times a year at 1M needs ONE 1M schedule rule,
 * not thirteen — `schedule_rule` is unique on (asset_document, frequency).
 * The visit list is a calendar; the rule set is its distinct frequencies.
 *
 * `missing` (planned but not in the form) is a HARD error: the form has no
 * items at that frequency, so the job would generate with nothing to fill.
 * Across Rev 21 it is empty for every machine — if it ever fires, the form and
 * the plan have genuinely diverged and a human must look.
 */
export function reconcile(
  rows: MasterlistRow[],
  formFrequencies: Record<string, string[]>,
): Reconciliation[] {
  return rows.map((row) => {
    const assetTypeCode = assetTypeCodeForModel(row.model, row.code);
    const planned = [...new Set(row.visits.map((v) => v.frequency))].sort(sortFreq);
    const formDefines = assetTypeCode ? (formFrequencies[assetTypeCode] ?? []) : [];
    return {
      row,
      assetTypeCode,
      planned,
      formDefines: [...formDefines].sort(sortFreq),
      surplus: formDefines.filter((f) => !planned.includes(f)).sort(sortFreq),
      missing: planned.filter((f) => !formDefines.includes(f)).sort(sortFreq),
    };
  });
}
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add scripts/template-load/src/masterlist/
git commit -m "feat(masterlist): reconcile planned frequencies against each form"
```

---

### Task 4: The importer

**Files:**

- Create: `scripts/template-load/src/masterlist/import.ts`
- Modify: `package.json` (root `scripts`)

**Interfaces:**

- Consumes: everything from Tasks 1–3, plus `ApiClient` from `../client`.
- Produces: `runImport(options): Promise<ImportReport>`.

**Reuse, do not reinvent:** `loader.ts:535-585` already creates a machine, attaches a document idempotently by re-check, and materialises the schedule with a `GET`. Follow that sequence exactly. The differences are that real machines pass a `code` (so the server does not issue a provisional `PROV-XXXXXXXX`), and that this task adds the schedule adjust afterwards.

- [ ] **Step 1: Write the failing test**

Test the pure decision function, not the network:

```ts
import { plannedDueDates } from './import';

describe('plannedDueDates', () => {
  it('takes the FIRST planned week for each frequency', () => {
    const visits = [
      { workWeek: 5, frequency: 'M6' as const },
      { workWeek: 18, frequency: 'M3' as const },
      { workWeek: 30, frequency: 'Y' as const },
      { workWeek: 43, frequency: 'M3' as const },
    ];
    expect(plannedDueDates(visits, 2026)).toEqual({
      M6: '2026-01-29',
      M3: '2026-04-30',
      Y: '2026-07-23',
    });
  });

  it('uses the earliest of thirteen monthly visits', () => {
    const visits = [1, 5, 9].map((w) => ({ workWeek: w, frequency: 'M1' as const }));
    expect(plannedDueDates(visits, 2026)).toEqual({ M1: '2026-01-01' });
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement the pure part**

```ts
/**
 * One due date per frequency: the machine's FIRST planned week for it. The
 * interval carries it forward from there, which is what preserves the
 * masterlist's deliberate stagger without modelling the calendar.
 */
export function plannedDueDates(
  visits: readonly PlannedVisit[],
  year: number,
): Record<string, string> {
  const first: Record<string, number> = {};
  for (const v of visits) {
    if (first[v.frequency] === undefined || v.workWeek < first[v.frequency]) {
      first[v.frequency] = v.workWeek;
    }
  }
  return Object.fromEntries(
    Object.entries(first).map(([freq, week]) => [freq, workWeekToDate(week, year)]),
  );
}
```

- [ ] **Step 4: Implement the orchestrator**

Per reconciled row, in this order — the document must exist before the schedule `GET`, because the bootstrap iterates documents:

1. Skip if `SKIPPED_CODES` contains the code. Record it.
2. If `assetTypeCode` is null → create the machine with **no document**, record it, continue.
3. If `missing` is non-empty → **do not import**; record a hard error.
4. Resolve `surplus` by prompting (Task 5).
5. `GET /api/v1/assets?code=<code>` — if it exists, reuse it; else `POST /api/v1/assets` with `code`, `assetTypeId`, `description` = the model, and `scheduleAnchorDate` = the earliest planned date.
6. `GET /api/v1/assets/{id}/documents`; if the family's template is not attached, `POST` it with `machineNumber` from `machineNumberFor(templateTitle, code)` (Task 2b) — null where the title has no blank.
7. `GET /api/v1/assets/{id}/schedule` — materialises the rules.
8. For each planned frequency, `PATCH /api/v1/assets/{id}/schedule` with `{ assetDocumentId, frequency, nextDueOn, adjustedReason: 'Migrated from ML-S-MFT-00015 Rev 21 (WW<n>)' }`. That string is over the 10-character minimum and puts the provenance in the audit trail.
9. For each `surplus` frequency the operator chose to drop, `PATCH` it inactive rather than deleting — reversible, and the form is untouched.

Under dry run, log every call that would be made and perform none.

- [ ] **Step 5: Run tests + typecheck; commit**

```bash
git add scripts/template-load/src/masterlist/ package.json
git commit -m "feat(masterlist): importer creating machines, documents and planned schedules"
```

---

### Task 5: The conflict prompt

**Files:**

- Create: `scripts/template-load/src/masterlist/prompt.ts`
- Create: `scripts/template-load/src/masterlist/prompt.spec.ts`

**Interfaces:**

- Produces: `parseConflictChoice(raw: string): 'plan' | 'form' | null` and `promptConflict(r: Reconciliation, index: number, total: number): Promise<'plan' | 'form'>`.

- [ ] **Step 1: Write the failing test**

```ts
import { parseConflictChoice } from './prompt';

describe('parseConflictChoice', () => {
  it('accepts 1 for plan and 2 for form', () => {
    expect(parseConflictChoice('1')).toBe('plan');
    expect(parseConflictChoice('2')).toBe('form');
  });
  it('tolerates whitespace', () => {
    expect(parseConflictChoice('  2 ')).toBe('form');
  });
  it('rejects anything else rather than defaulting', () => {
    // Defaulting silently would schedule or drop PM work nobody chose.
    for (const bad of ['', '3', '0', 'y', 'plan', '1.0']) {
      expect(parseConflictChoice(bad)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

```ts
export function parseConflictChoice(raw: string): 'plan' | 'form' | null {
  const t = raw.trim();
  if (t === '1') return 'plan';
  if (t === '2') return 'form';
  return null;
}
```

`promptConflict` prints the §6 block from the spec and re-asks until
`parseConflictChoice` returns non-null. Under `--follow-plan` it returns
`'plan'` without prompting, so a dry run is non-interactive; document that flag
in the CLI header.

- [ ] **Step 4: Run, verify pass; commit**

```bash
git add scripts/template-load/src/masterlist/
git commit -m "feat(masterlist): interactive conflict prompt"
```

---

### Task 6: CLI entry, evidence file and runbook

**Files:**

- Create: `scripts/template-load/src/masterlist/cli.ts`
- Create: `scripts/template-load/src/masterlist/evidence.ts`
- Modify: `package.json`
- Modify: `docs/DEPLOYMENT_RUNBOOK.md`

- [ ] **Step 1: CLI**

Mirror `cli-load.ts`: read `BAMFORM_BASE_URL`, `BAMFORM_AUTHOR_EMAIL`, `BAMFORM_AUTHOR_PASSWORD` from the environment; accept `--apply`, `--year=2026`, `--follow-plan`, `--file=<path>`; reject unknown arguments. Default is a dry run.

- [ ] **Step 2: Evidence file**

Write `scripts/template-load/evidence/masterlist-import.md`: one row per machine — source label, code, asset type, document, and each frequency with its first due date — plus a conflicts section recording each choice, and a section listing skipped and unmapped machines. This is the artefact that gets diffed against the spreadsheet.

- [ ] **Step 3: npm script**

```json
"import:masterlist": "ts-node -P scripts/template-load/tsconfig.json scripts/template-load/src/masterlist/cli.ts"
```

- [ ] **Step 4: Runbook §3.6**

Document the migration: prerequisites (templates loaded, an author account with DOC_CONTROLLER + ENGINEER), the dry run, how to read the evidence file, then `--apply`. State that it is idempotent and safe to re-run, and that `DDA 03` is deliberately absent.

- [ ] **Step 5: Full gates and commit**

```bash
cd api && npx jest --config jest.unit.config.js
cd .. && npm run format:check
git add -A && git commit -m "feat(masterlist): CLI, evidence file and runbook procedure"
```

---

## Verification before done

- [ ] All unit tests green; `npm run format:check` clean.
- [ ] **Dry run against production** prints 77 machines — 75 with a type and document, `MS-620 ST01` with none, `DDA 03` absent — and writes nothing.
- [ ] **Spot-check the dates by hand**: `ED01` 6M on 2026-01-29, 3M on 2026-04-30, Y on 2026-07-23. Confirm with the owner that these are the intended weeks **before** `--apply`.
- [ ] Exactly 3 conflicts prompt: `AW06`, `BD01`, `EP01`.
- [ ] After `--apply`, re-run the dry run: it must report every machine as already present and propose no writes.
- [ ] `GET /assets/{id}/schedule` for `ED01` returns the planned dates, and a job appears once inside its lead time.

## Notes for the implementer

- **The `--` separator is not uniform.** Some labels use `--`, some a single code with no separator, and spacing varies (`ESEC 2008 sc3 plus --  ED02` has two spaces). Collapse whitespace before splitting.
- **`machineNumber` on the document is per-template.** Only some titles carry a fillable run. Check each template's title before setting it; where the title has no blank, leave it null — that is always valid.
- **Do not touch `DDA 03`.** It is not a bug that it is missing.
