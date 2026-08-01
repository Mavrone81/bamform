# Slice A — QA-format printed record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GET /records/{id}/pdf` produce the controlled Excel form — one machine, one page — so the download passes the QA check.

**Architecture:** `pdf-html-template.ts` stays a pure function of a plain input shape (no Prisma, no Puppeteer) so layout is unit-testable without a browser or database. This slice replaces its stacked-`<h2>` body with a page: boxed header grid, frequency selection band, `No | Freq | Instruction | Status | Remark` checklist, measurement table, standing-content block, three-cell signature row, page footer. The assembly service gains the three fields the new layout needs (per-item frequency, in-scope flag, banner options); everything else it already has.

**Tech Stack:** TypeScript, NestJS, Prisma, Zod, Jest, Puppeteer + distro Chromium.

## Global Constraints

- **Never invalidate a signed record.** The footer digest is the STORED `latestApprovalStep(job).contentHash` — `pdf-record-assembly.service.ts:40`: "never recomputed here, never a new digest." No task may compute a digest.
- **Escape every piece of user-authored text.** SECURITY_ARCHITECTURE.md §8. Use the existing `esc()`; the drawn-signature `<img src>` is the only trusted interpolation.
- **`pdf-html-template.ts` stays Prisma- and Puppeteer-independent.** It is a pure function; keep it that way.
- **Signature captions come from `signatureBlockLabel()`.** Do not hard-code captions; the stage-label snapshot wins (slice 26-TWOSTAGE M1).
- **CI gates:** `npm run format:check`; `npm run gen:api-types` after any `api/openapi.yaml` change; any new migration needs a `-- Reversal:` header in its first 20 lines. The pre-push hook (`scripts/git-hooks/pre-push`, merged in `a56ced7`) runs all three.
- **No new npm dependencies.**

---

### Task 1: Carry the frequency banner into standing content

The band must show what the paper shows. Deriving the options from the template's item frequencies does **not** reproduce it — verified across all 12 forms, 5 disagree. `CE-95-012-00-02` has M1 items only but prints all four options; `CE-95-030-00-01` and `CE-95-050-00-01` have no Y items but print Y.

`evidence.ts:53` currently labels the banner "informational, not loaded — TLP §4.1". This task deliberately reverses that. No migration: `template_revision.standing_content` is a JSON column.

**Files:**
- Modify: `shared/src/template.ts:67-75` (`standingContentSchema`)
- Modify: `api/openapi.yaml` (`StandingContent` schema)
- Modify: `scripts/template-load/src/loader.ts:407-418` (`standingContentPayload`)
- Modify: `scripts/template-load/src/evidence.ts:53` (drop the "not loaded" wording)
- Test: `api/test/integration/template-standing-content.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `StandingContent.frequencyBanner?: string | null` — the verbatim banner string, e.g. `"Three Monthly (3M) Six Monthly (6M) Yearly (Y)"`.

- [ ] **Step 1: Write the failing test**

```ts
// api/test/integration/template-standing-content.spec.ts
import { standingContentSchema } from '@bamform/shared';

describe('standingContentSchema — frequencyBanner', () => {
  it('accepts and preserves a verbatim banner string', () => {
    const parsed = standingContentSchema.parse({
      specialTools: null,
      frequencyBanner: 'Monthly (1M) Three Monthly (3M) Six Monthly (6M) Yearly (Y)',
    });
    expect(parsed.frequencyBanner).toBe(
      'Monthly (1M) Three Monthly (3M) Six Monthly (6M) Yearly (Y)',
    );
  });

  it('accepts null and absent — forms loaded before this field exist', () => {
    expect(standingContentSchema.parse({ frequencyBanner: null }).frequencyBanner).toBeNull();
    expect(standingContentSchema.parse({}).frequencyBanner).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd api && npx jest --config jest.unit.config.js template-standing-content`
Expected: FAIL — `frequencyBanner` is stripped by the schema, so it is `undefined`, not the string.

- [ ] **Step 3: Add the field to the schema**

In `shared/src/template.ts`, inside `standingContentSchema`, after `remarks`:

```ts
  /**
   * The form's printed frequency banner, VERBATIM (e.g. "Monthly (1M) Three
   * Monthly (3M) Six Monthly (6M) Yearly (Y)"). Loaded from the workbook so
   * the printed record can reproduce the paper's selection band.
   *
   * NOT derivable from the template's item frequencies: 5 of the 12 loaded
   * forms print options they have no items for — CE-95-012-00-02 has monthly
   * items only and prints all four.
   */
  frequencyBanner: z.string().nullable().optional(),
```

- [ ] **Step 4: Add it to the OpenAPI contract**

In `api/openapi.yaml`, under `components.schemas.StandingContent.properties`, alongside `remarks`:

```yaml
        frequencyBanner:
          type: string
          nullable: true
          description: >-
            The form's printed frequency banner, verbatim. Reproduced on the
            printed record's selection band. Not derivable from item
            frequencies.
```

- [ ] **Step 5: Regenerate the web API types**

Run: `npm run gen:api-types`
Then: `git diff --stat web/src/api/generated` — expect `openapi-types.ts` modified. Commit the result; job 5 fails if it is stale.

- [ ] **Step 6: Persist it from the loader**

In `scripts/template-load/src/loader.ts`, `standingContentPayload`, after `remarks: sc.remarks,`:

```ts
    frequencyBanner: doc.frequencyBanner,
```

In `scripts/template-load/src/evidence.ts:53`, replace the row text:

```ts
    `| Frequency banner (loaded into standing content) | ${show(doc.frequencyBanner)} |`,
```

- [ ] **Step 7: Run the tests**

Run: `cd api && npx jest --config jest.unit.config.js template-standing-content`
Expected: PASS, both cases.

- [ ] **Step 8: Commit**

```bash
git add shared/src/template.ts api/openapi.yaml web/src/api/generated \
  scripts/template-load/src/loader.ts scripts/template-load/src/evidence.ts \
  api/test/integration/template-standing-content.spec.ts
git commit -m "feat(templates): load the printed frequency banner into standing content"
```

---

### Task 2: Extend the PDF input shape

The new layout needs three things the input does not carry: each checklist row's frequency, whether that row was in scope for this visit, and the banner options.

**Files:**
- Modify: `api/src/pdf/pdf-html-template.ts:42-47` (`PdfChecklistItemInput`), `:92-117` (`PdfRecordInput`), `:70-77` (`PdfStandingContentInput`)
- Modify: `api/src/pdf/pdf-record-assembly.service.ts`
- Test: `api/src/pdf/pdf-html-template.spec.ts`

**Interfaces:**
- Consumes: `StandingContent.frequencyBanner` from Task 1.
- Produces:
  - `PdfChecklistItemInput` gains `frequency: string` (`'M1' | 'M3' | 'M6' | 'Y'`) and `inScope: boolean`.
  - `PdfRecordInput` gains `machineCode: string` and `frequencyScope: string[]`.
  - `PdfStandingContentInput` gains `frequencyBanner?: string | null`.

This task ends green. It delivers the shape plus the one piece of logic that
shape implies — `itemInScope` — and does **not** assert markup that later tasks
render. Do not commit a failing test here.

- [ ] **Step 1: Write the failing test**

```ts
// append to api/src/pdf/pdf-html-template.spec.ts
// (add `itemInScope` to the import list at the top of the file)
describe('itemInScope', () => {
  it('is true when the row frequency is in the visit scope', () => {
    expect(itemInScope('M3', ['M3', 'M6'])).toBe(true);
    expect(itemInScope('M6', ['M3', 'M6'])).toBe(true);
  });

  it('is false for a yearly row on a six-monthly visit', () => {
    expect(itemInScope('Y', ['M3', 'M6'])).toBe(false);
  });

  it('is false against an empty scope rather than throwing', () => {
    expect(itemInScope('M3', [])).toBe(false);
  });
});
```

(`baseInput` is the existing helper in that spec; extend its literal with `machineCode: 'AW02'`, `frequencyScope: ['M3', 'M6']`, and `frequency`/`inScope` on each checklist row so the file still compiles.)

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template`
Expected: FAIL — `itemInScope` is not exported.

- [ ] **Step 3: Widen the interfaces**

In `api/src/pdf/pdf-html-template.ts`:

```ts
export interface PdfChecklistItemInput {
  itemNo: number;
  /** `'M1' | 'M3' | 'M6' | 'Y'` — printed in the sheet's Freq column (column B of the workbook). */
  frequency: string;
  /**
   * False when the row's frequency is outside this visit's scope — a Y item on
   * a 6M visit. Such rows still PRINT, still numbered: the sheet stays whole
   * and only the cell is closed.
   */
  inScope: boolean;
  instruction: string;
  status: string;
  remark: string | null;
}
```

Add to `PdfStandingContentInput`:

```ts
  /** The form's printed banner, verbatim. Absent for forms loaded before Task 1. */
  frequencyBanner?: string | null;
```

Add to `PdfRecordInput`, after `assetCode`:

```ts
  /** The machine this record covers. One record is one machine — printed in the header. */
  machineCode: string;
  /** Every frequency in scope for this visit, e.g. `['M3','M6']` for a 6M. */
  frequencyScope: string[];
```

- [ ] **Step 4: Add the scope helper**

In `api/src/pdf/pdf-html-template.ts`, exported so the assembly service computes
`inScope` from one shared definition and the rule stays unit-testable without a
database:

```ts
/**
 * Whether a checklist row applies to this visit. A Y row on a 6M visit is out
 * of scope: it still PRINTS, still numbered, but its cell is closed.
 * `job.frequency_scope` already carries the cascade — a Y visit arrives as
 * `['M3','M6','Y']` — so plain membership is the whole rule.
 */
export function itemInScope(frequency: string, scope: readonly string[]): boolean {
  return scope.includes(frequency);
}
```

- [ ] **Step 5: Populate them in the assembly service**

In `api/src/pdf/pdf-record-assembly.service.ts`, where the checklist array is built, add to each row:

```ts
        frequency: item.templateItem.frequency,
        inScope: itemInScope(item.templateItem.frequency, job.frequencyScope),
```

and on the record object:

```ts
      machineCode: job.asset.assetCode,
      frequencyScope: job.frequencyScope,
```

Import `itemInScope` from `./pdf-html-template`. Confirm the template item's
`frequency` is selected by the query — if the include omits it, add it. Run
`npm run typecheck` to find out.

- [ ] **Step 6: Run the tests**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template && npm run typecheck`
Expected: PASS — all three `itemInScope` cases green, typecheck clean. Nothing
in this task asserts markup, so the suite must be fully green before you commit.

- [ ] **Step 7: Commit**

```bash
git add api/src/pdf/pdf-html-template.ts api/src/pdf/pdf-record-assembly.service.ts api/src/pdf/pdf-html-template.spec.ts
git commit -m "feat(pdf): carry per-item frequency, scope and machine into the record input"
```

---

### Task 3: The header grid and frequency band

**Files:**
- Modify: `api/src/pdf/pdf-html-template.ts` (body markup + `<style>`)
- Test: `api/src/pdf/pdf-html-template.spec.ts`

**Interfaces:**
- Consumes: `machineCode`, `frequencyScope`, `standingContent.frequencyBanner` from Task 2.
- Produces: `renderFrequencyBand(banner, scope)` — module-private.

- [ ] **Step 1: Write the failing tests**

```ts
it('prints the machine in the header grid', () => {
  const html = renderRecordHtml(baseInput({ machineCode: 'AW02' }));
  expect(html).toContain('<span>Machine</span><span>AW02</span>');
});

it('marks the selected frequency in the band and leaves the others unmarked', () => {
  const html = renderRecordHtml(
    baseInput({
      frequencyScope: ['M3', 'M6'],
      standingContent: { frequencyBanner: 'Three Monthly (3M) Six Monthly (6M) Yearly (Y)' },
    }),
  );
  expect(html).toContain('<span class="on">Six Monthly (6M)</span>');
  expect(html).toContain('<span class="off">Yearly (Y)</span>');
});

it('falls back to the scope itself when no banner was loaded', () => {
  const html = renderRecordHtml(
    baseInput({ frequencyScope: ['M3'], standingContent: { frequencyBanner: null } }),
  );
  expect(html).toContain('<span class="on">3M</span>');
});

it('escapes a banner containing markup', () => {
  const html = renderRecordHtml(
    baseInput({ standingContent: { frequencyBanner: '<script>x</script> (3M)' } }),
  );
  expect(html).not.toContain('<script>');
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template`
Expected: FAIL — none of that markup exists yet.

- [ ] **Step 3: Implement the band renderer**

```ts
/**
 * The sheet's frequency band. The banner is printed VERBATIM and split on its
 * "(3M)"-style tokens so each option can be marked or greyed; a token is
 * "on" when its code is in this visit's scope.
 *
 * Falls back to rendering the scope codes alone when no banner was loaded —
 * forms loaded before the banner was persisted must still print a band.
 */
function renderFrequencyBand(banner: string | null | undefined, scope: string[]): string {
  const codeOf = (token: string): string | null => {
    const m = /\(([0-9]+M|Y)\)/i.exec(token);
    if (!m) return null;
    const raw = m[1].toUpperCase();
    return raw === 'Y' ? 'Y' : `M${raw.replace('M', '')}`;
  };

  if (!banner) {
    const spans = scope
      .map((f) => `<span class="on">${esc(f === 'Y' ? 'Y' : f.replace('M', '') + 'M')}</span>`)
      .join(' &nbsp; ');
    return `<div class="p-band">${spans}</div>`;
  }

  // Split before each "Monthly (3M)"-style group: the code marks the end of one.
  const tokens = banner.split(/(?<=\))\s+/).filter((t) => t.trim() !== '');
  const spans = tokens
    .map((token) => {
      const code = codeOf(token);
      const on = code !== null && scope.includes(code);
      return `<span class="${on ? 'on' : 'off'}">${esc(token.trim())}</span>`;
    })
    .join(' &nbsp; ');
  return `<div class="p-band">${spans}</div>`;
}
```

- [ ] **Step 4: Replace the header block and banner in the body**

Replace the existing `.header-block` div and the `frequency-banner` div with:

```ts
  <div class="p-head">
    <div class="p-head-l">
      <div class="p-org">${esc(input.assetDescription)}</div>
      <div class="p-title">${esc(input.documentTitle)}</div>
    </div>
    <div class="p-head-r">
      <span>Document No.</span><span>${esc(input.documentNumber)}</span>
      <span>Revision</span><span>${esc(input.revisionCode)}</span>
      <span>Machine</span><span>${esc(input.machineCode)}</span>
      <span>Job No.</span><span>${esc(input.jobNumber)}</span>
      <span>Date</span><span>${esc(input.dueOn)}</span>
    </div>
  </div>
  ${renderFrequencyBand(input.standingContent.frequencyBanner, input.frequencyScope)}
```

- [ ] **Step 5: Add the styles**

In the `<style>` block, replacing `.header-block` and `.frequency-banner`:

```css
  .p-head { display: grid; grid-template-columns: 1fr 13rem; border: 1px solid #1a1a1a; }
  .p-head-l { padding: 5px 7px; border-right: 1px solid #1a1a1a; }
  .p-org { font-size: 8px; letter-spacing: 0.1em; text-transform: uppercase; color: #666; }
  .p-title { font-size: 13px; font-weight: 700; line-height: 1.15; margin-top: 2px; }
  .p-head-r { display: grid; grid-template-columns: auto 1fr; }
  .p-head-r span { padding: 2px 6px; border-bottom: 1px solid #c4c4c4; }
  .p-head-r span:nth-child(odd) { color: #555; border-right: 1px solid #c4c4c4; }
  .p-band { border: 1px solid #1a1a1a; border-top: none; text-align: center;
            padding: 4px; background: #ececec; font-weight: 700; }
  .p-band .off { color: #999; font-weight: 400; }
  .p-band .on { text-decoration: underline; text-underline-offset: 2px; }
```

- [ ] **Step 6: Run the tests**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template`
Expected: the four Step-1 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src/pdf/pdf-html-template.ts api/src/pdf/pdf-html-template.spec.ts
git commit -m "feat(pdf): boxed header grid and the sheet's frequency selection band"
```

---

### Task 4: The checklist table

**Files:**
- Modify: `api/src/pdf/pdf-html-template.ts:143-152` (`renderChecklist`)
- Test: `api/src/pdf/pdf-html-template.spec.ts`

**Interfaces:**
- Consumes: `PdfChecklistItemInput` with `frequency` and `inScope` from Task 2.
- Produces: `renderChecklist(items)` — same name, new columns.

- [ ] **Step 1: Write the failing tests**

```ts
it('prints No, Freq, Instruction, Status and Remark in that order', () => {
  const html = renderRecordHtml(baseInput({}));
  const head = /<thead>.*?<\/thead>/s.exec(html)![0];
  expect(head.indexOf('No')).toBeLessThan(head.indexOf('Freq'));
  expect(head.indexOf('Freq')).toBeLessThan(head.indexOf('Maintenance Instruction'));
  expect(head.indexOf('Maintenance Instruction')).toBeLessThan(head.indexOf('Status'));
  expect(head.indexOf('Status')).toBeLessThan(head.indexOf('Remark'));
});

it('prints each row\'s frequency in the Freq column', () => {
  const html = renderRecordHtml(
    baseInput({
      checklist: [
        { itemNo: 1, frequency: 'M3', inScope: true, instruction: 'Clean', status: 'DONE', remark: null },
        { itemNo: 9, frequency: 'M6', inScope: true, instruction: 'Fans', status: 'DONE', remark: null },
      ],
    }),
  );
  expect(html).toContain('<td class="p-fq">M3</td>');
  expect(html).toContain('<td class="p-fq">M6</td>');
});

it('prints an out-of-scope row, numbered, with an em dash and a reason', () => {
  const html = renderRecordHtml(
    baseInput({
      frequencyScope: ['M3', 'M6'],
      checklist: [
        { itemNo: 13, frequency: 'Y', inScope: false, instruction: 'Calibrate', status: 'NOT_EVALUATED', remark: null },
      ],
    }),
  );
  expect(html).toContain('>13<');
  expect(html).toContain('—');
  expect(html).toContain('Not in scope (6M)');
});

it('prints the status word, not a glyph, and flags NOT_DONE', () => {
  const html = renderRecordHtml(
    baseInput({
      checklist: [
        { itemNo: 12, frequency: 'M6', inScope: true, instruction: 'ESD', status: 'NOT_DONE', remark: 'WO-2291' },
      ],
    }),
  );
  expect(html).toContain('NOT DONE');
  expect(html).toContain('class="c fail-ink"');
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template`
Expected: FAIL — the table still has `#`/`Instruction`/`Status`/`Remark`.

- [ ] **Step 3: Rewrite `renderChecklist`**

```ts
/** `NOT_APPLICABLE` prints as `N/A`, `NOT_DONE` as `NOT DONE` — the sheet's own words. */
function statusWord(status: string): string {
  if (status === 'NOT_APPLICABLE') return 'N/A';
  if (status === 'NOT_DONE') return 'NOT DONE';
  return status;
}

/** The coarsest frequency in scope, for the "Not in scope (6M)" reason. */
function scopeLabel(scope: string[]): string {
  const order = ['M1', 'M3', 'M6', 'Y'];
  const widest = [...scope].sort((a, b) => order.indexOf(b) - order.indexOf(a))[0] ?? '';
  return widest === 'Y' ? 'Y' : widest.replace('M', '') + 'M';
}

function renderChecklist(items: PdfChecklistItemInput[], scope: string[]): string {
  if (items.length === 0) return '<p class="muted">No checklist items.</p>';
  const rows = items
    .map((item) => {
      if (!item.inScope) {
        return `<tr class="p-out"><td class="p-no">${item.itemNo}</td><td class="p-fq">${esc(item.frequency)}</td><td>${esc(item.instruction)}</td><td class="c">—</td><td>Not in scope (${esc(scopeLabel(scope))})</td></tr>`;
      }
      const cls = item.status === 'NOT_DONE' ? 'c fail-ink' : 'c';
      return `<tr><td class="p-no">${item.itemNo}</td><td class="p-fq">${esc(item.frequency)}</td><td>${esc(item.instruction)}</td><td class="${cls}">${esc(statusWord(item.status))}</td><td>${esc(item.remark)}</td></tr>`;
    })
    .join('');
  return `<table class="p"><thead><tr><th class="p-no">No</th><th class="p-fq">Freq</th><th class="l">Maintenance Instruction</th><th class="p-st">Status</th><th class="l">Remark</th></tr></thead><tbody>${rows}</tbody></table>`;
}
```

Update the call site to `${renderChecklist(input.checklist, input.frequencyScope)}` and delete the `<h2>Checklist</h2>` heading above it.

- [ ] **Step 4: Add the styles**

```css
  table.p { width: 100%; border-collapse: collapse; }
  table.p th, table.p td { border: 1px solid #8a8a8a; padding: 3px 5px; text-align: left; vertical-align: middle; }
  table.p thead th { background: #ececec; font-size: 9px; text-align: center; font-weight: 700; }
  table.p thead th.l { text-align: left; }
  table.p td.c { text-align: center; }
  .p-no { width: 24px; text-align: center; }
  .p-fq { width: 32px; text-align: center; }
  .p-st { width: 58px; text-align: center; }
  .p-out { color: #777; }
  .fail-ink { color: #a8261c; font-weight: 700; }
```

- [ ] **Step 5: Run the tests**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template`
Expected: PASS, including Task 2's Freq-column test.

- [ ] **Step 6: Commit**

```bash
git add api/src/pdf/pdf-html-template.ts api/src/pdf/pdf-html-template.spec.ts
git commit -m "feat(pdf): checklist prints No/Freq/Instruction/Status/Remark with out-of-scope rows"
```

---

### Task 4b: The measurement table

Spec §4.4. The current table survives from the old report: it heads the column
`Judgement` and carries `class="measurements"`, so it neither matches the sheet's
wording nor picks up the page styles from Task 4.

**Files:**
- Modify: `api/src/pdf/pdf-html-template.ts:154-163` (`renderMeasurements`)
- Test: `api/src/pdf/pdf-html-template.spec.ts`

**Interfaces:**
- Consumes: `PdfMeasurementInput` (unchanged), the `table.p` styles from Task 4.
- Produces: `renderMeasurements(rows)` — same name and signature, new columns.

- [ ] **Step 1: Write the failing tests**

```ts
it('heads the measurement result column "Result", not "Judgement"', () => {
  const html = renderRecordHtml(baseInput({}));
  expect(html).toContain('<th class="p-mk">Result</th>');
  expect(html).not.toContain('<th>Judgement</th>');
});

it('prints the specification verbatim and flags a FAIL', () => {
  const html = renderRecordHtml(
    baseInput({
      measurements: [
        { description: '91 steps calibration', unit: 'μm/encoder', specDisplay: '0.19 – 0.21 μm/encoder', reading: '0.218', judgement: 'FAIL', remark: null },
      ],
    }),
  );
  expect(html).toContain('0.19 – 0.21 μm/encoder');
  expect(html).toContain('class="c fail-ink"');
});

it('prints an em dash for a measurement with no reading', () => {
  const html = renderRecordHtml(
    baseInput({
      measurements: [
        { description: 'Vacuum Check', unit: 'mmHg', specDisplay: '> -600 mmHg', reading: null, judgement: 'NOT_EVALUATED', remark: null },
      ],
    }),
  );
  expect(html).toContain('<td class="c">—</td>');
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template`
Expected: FAIL — the header still reads `Judgement` and a null reading renders empty.

- [ ] **Step 3: Rewrite `renderMeasurements`**

```ts
function renderMeasurements(rows: PdfMeasurementInput[]): string {
  if (rows.length === 0) return '<p class="muted">No measurements.</p>';
  const body = rows
    .map((m) => {
      const reading = m.reading === null || m.reading === '' ? '—' : `${esc(m.reading)}${m.unit ? ` ${esc(m.unit)}` : ''}`;
      const cls = m.judgement === 'FAIL' ? 'c fail-ink' : 'c';
      return `<tr><td>${esc(m.description)}</td><td class="p-sp">${esc(m.specDisplay)}</td><td class="c">${reading}</td><td class="${cls}">${esc(m.judgement)}</td><td>${esc(m.remark)}</td></tr>`;
    })
    .join('');
  return `<div class="p-sect">Measurement Records</div>
  <table class="p"><thead><tr><th class="l">Description</th><th class="p-sp">Specification</th><th class="p-mk">Reading</th><th class="p-mk">Result</th><th class="l">Remark</th></tr></thead><tbody>${body}</tbody></table>`;
}
```

Delete the `<h2>Measurements</h2>` heading above the call site — the `p-sect` band replaces it.

- [ ] **Step 4: Add the two column widths**

```css
  .p-sp { width: 110px; }
  .p-mk { width: 44px; text-align: center; }
```

- [ ] **Step 5: Run the tests**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/pdf/pdf-html-template.ts api/src/pdf/pdf-html-template.spec.ts
git commit -m "feat(pdf): measurement table in the sheet's columns and wording"
```

---

### Task 5: Standing content, signature row and page footer

**Files:**
- Modify: `api/src/pdf/pdf-html-template.ts` (body below the measurement table; `renderSignatures`)
- Test: `api/src/pdf/pdf-html-template.spec.ts`

**Interfaces:**
- Consumes: `renderChecklist` from Task 4; `signatureBlockLabel()` unchanged.
- Produces: `renderStandingBlock(sc, partsUsed)` — module-private.

- [ ] **Step 1: Write the failing tests**

```ts
it('prints standing content as one labelled block, not separate headings', () => {
  const html = renderRecordHtml(
    baseInput({ standingContent: { ppe: ['Safety Shoes'], safety: 'Lock out.' } }),
  );
  expect(html).toContain('<dt>PPE</dt>');
  expect(html).not.toContain('<h2>PPE</h2>');
});

it('prints three signature cells with the captions signatureBlockLabel gives', () => {
  const html = renderRecordHtml(
    baseInput({
      signatures: [
        { approvalStepId: 's1', stageOrdinal: 0, action: 'SUBMITTED', actorName: 'R. Tan', actorRoleCode: 'MAINTAINER', actedAt: '2026-08-14' },
      ],
    }),
  );
  expect(html).toContain('Maintenance Performed By');
  expect(html).toContain('R. Tan');
});

it('prints the stored digest in the footer without recomputing it', () => {
  const html = renderRecordHtml(baseInput({ footer: { recordId: 'r1', integrityDigestHex: 'deadbeef', renderedAt: '2026-08-14T00:00:00Z' } }));
  expect(html).toContain('deadbeef');
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template`
Expected: FAIL on the first two; the digest test already passes and is a regression guard.

- [ ] **Step 3: Implement the standing block**

```ts
function renderStandingBlock(
  sc: PdfStandingContentInput,
  partsUsed: PdfPartUsedInput[],
): string {
  const partsLine =
    partsUsed.length === 0
      ? '<span class="muted">None.</span>'
      : partsUsed
          .map((p) => `${esc(p.partNo)} — ${esc(p.description)} — Qty ${esc(p.quantity)}`)
          .join('<br />');
  const ppe = sc.ppe && sc.ppe.length > 0 ? sc.ppe.map(esc).join(' · ') : '<span class="muted">None specified.</span>';
  return `<div class="p-sect">Special Tools · Parts · PPE · Safety</div>
  <dl class="p-standing">
    <dt>Special Tools</dt><dd>${esc(sc.specialTools) || '<span class="muted">None specified.</span>'}</dd>
    <dt>Parts Used</dt><dd>${partsLine}</dd>
    <dt>PPE</dt><dd>${ppe}</dd>
    <dt>Safety</dt><dd>${esc(sc.safety) || '<span class="muted">None specified.</span>'}</dd>
    <dt>Remarks</dt><dd>${esc(sc.remarks) || '<span class="muted">None.</span>'}</dd>
  </dl>`;
}
```

- [ ] **Step 4: Rewrite `renderSignatures` as a three-cell row**

```ts
function renderSignatures(signatures: PdfSignatureInput[]): string {
  if (signatures.length === 0) return '<p class="muted">No approval actions recorded yet.</p>';
  const cells = signatures
    .map((s) => {
      const img = s.drawnSignatureBase64
        ? `<img class="drawn-signature" src="data:image/png;base64,${s.drawnSignatureBase64}" alt="" />`
        : '<div class="p-sigline"></div>';
      return `<div>
        <div class="lbl">${esc(signatureBlockLabel(s.stageOrdinal, s.action, s.stageLabel))}</div>
        ${img}
        <div class="p-signm">${esc(s.actorName)} · ${esc(s.actedAt)}</div>
      </div>`;
    })
    .join('');
  return `<div class="p-sign">${cells}</div>`;
}
```

- [ ] **Step 5: Replace the body's tail**

Delete the `<h2>Special Tools</h2>`, `<h2>Parts Required</h2>`, `<h2>PPE</h2>`, `<h2>Safety</h2>`, `<h2>Parts Used</h2>`, `<h2>Signatures</h2>` and `<h2>Remarks</h2>` sections and their calls. In their place, after the measurement table:

```ts
  ${renderStandingBlock(input.standingContent, input.partsUsed)}
  ${renderSignatures(input.signatures)}
  ${renderAttachments(input.attachments)}
  <div class="p-foot">
    <span>${esc(input.documentNumber)} Rev ${esc(input.revisionCode)} · ${esc(input.machineCode)} · ${esc(input.jobNumber)}</span>
    <span>SHA-256 ${esc(input.footer.integrityDigestHex)}</span>
  </div>
```

- [ ] **Step 6: Add the styles**

```css
  .p-sect { border: 1px solid #1a1a1a; border-top: none; background: #ececec;
            padding: 3px 5px; font-weight: 700; font-size: 9px;
            letter-spacing: 0.05em; text-transform: uppercase; }
  .p-standing { border: 1px solid #8a8a8a; border-top: none; display: grid; grid-template-columns: 90px 1fr; }
  .p-standing dt { padding: 3px 5px; border-right: 1px solid #c4c4c4; border-bottom: 1px solid #c4c4c4; font-weight: 700; color: #444; }
  .p-standing dd { margin: 0; padding: 3px 5px; border-bottom: 1px solid #c4c4c4; }
  .p-sign { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid #1a1a1a; border-top: none; }
  .p-sign > div { padding: 5px 6px; }
  .p-sign > div + div { border-left: 1px solid #8a8a8a; }
  .p-sign .lbl { font-size: 8px; font-weight: 700; color: #444; text-transform: uppercase; }
  .p-sigline { height: 22px; border-bottom: 1px solid #1a1a1a; margin-top: 3px; }
  .p-signm { font-size: 8px; color: #444; padding-top: 2px; }
  .p-foot { margin-top: 10px; padding-top: 4px; border-top: 1px solid #8a8a8a;
            display: flex; justify-content: space-between; font-size: 8px; color: #555; }
```

- [ ] **Step 7: Run the tests**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api/src/pdf/pdf-html-template.ts api/src/pdf/pdf-html-template.spec.ts
git commit -m "feat(pdf): standing-content block, three-cell signature row and page footer"
```

---

### Task 6: Print CSS — A4, margins, repeating headers

**Files:**
- Modify: `api/src/pdf/pdf-html-template.ts` (`<style>`)
- Modify: `api/src/pdf/pdf-render.service.ts` (Puppeteer `pdf()` options)
- Test: `api/src/pdf/pdf-html-template.spec.ts`

**Interfaces:**
- Consumes: all markup from Tasks 3–5.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

```ts
it('declares A4 with margins and repeats table headers across pages', () => {
  const html = renderRecordHtml(baseInput({}));
  expect(html).toContain('@page { size: A4 portrait;');
  expect(html).toContain('thead { display: table-header-group; }');
  expect(html).toContain('tr { break-inside: avoid; }');
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template`
Expected: FAIL — no `@page` rule exists.

- [ ] **Step 3: Add the print rules**

At the top of the `<style>` block:

```css
  @page { size: A4 portrait; margin: 14mm 12mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9.5px; color: #1a1a1a; margin: 0; }
  /* Chromium repeats a thead on every page only with table-header-group. */
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  .p-sign, .p-standing { break-inside: avoid; }
```

- [ ] **Step 4: Confirm the renderer does not fight the @page rule**

In `api/src/pdf/pdf-render.service.ts`, the `page.pdf({...})` call must pass `printBackground: true` and must NOT pass a `margin` (that would override `@page`). Set `format` only if `@page` is absent — since it is now present, remove any `format: 'A4'` and `margin` options and rely on the stylesheet, so one file owns the page geometry.

- [ ] **Step 5: Add "Page N of M"**

Spec §4.7. CSS in the document body cannot count pages — Chromium exposes the
counters only to Puppeteer's header/footer templates. In
`api/src/pdf/pdf-render.service.ts`, on the `page.pdf({...})` call:

```ts
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;font-family:Arial,Helvetica,sans-serif;' +
        'font-size:8px;color:#555;padding:0 12mm;text-align:right;">' +
        'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
```

`displayHeaderFooter` reserves vertical space from the `@page` margin, so the
14mm bottom margin from Step 3 already accommodates it. An empty
`headerTemplate` is required: omitting it makes Chromium print its default
title/URL header.

- [ ] **Step 6: Run the tests**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template && npm run typecheck`
Expected: PASS, clean. Page numbering is not unit-testable — it is asserted by
eye in the end-to-end check under "Verification before done".

- [ ] **Step 7: Commit**

```bash
git add api/src/pdf/pdf-html-template.ts api/src/pdf/pdf-render.service.ts api/src/pdf/pdf-html-template.spec.ts
git commit -m "feat(pdf): A4 page geometry, repeating table headers and page numbering"
```

---

### Task 7: Golden-file coverage and the digest-stability guard

Risk 2 in the spec: `CE-95-043-00-01` has 18 items, 10 of them monthly. This task proves the layout holds and that re-rendering an archived record does not disturb its digest.

**Files:**
- Create: `api/src/pdf/__fixtures__/record-shapes.ts`
- Create: `api/src/pdf/pdf-html-template.golden.spec.ts`
- Test: both of the above

**Interfaces:**
- Consumes: `renderRecordHtml` and every input type from Tasks 2–6.
- Produces: `recordShape(name)` returning a `PdfRecordInput` for `'single-3m'`, `'monthly-only'`, `'long-18-item'`, `'voided'`.

- [ ] **Step 1: Write the fixtures**

```ts
// api/src/pdf/__fixtures__/record-shapes.ts
import type { PdfRecordInput } from '../pdf-html-template';

const base: PdfRecordInput = {
  recordId: 'rec-1', jobNumber: 'PM-4471',
  documentNumber: 'CE 95 020 00 01', documentTitle: 'ASM Wire Bond Preventive Maintenance Record',
  revisionCode: 'C', assetCode: 'AW02', assetDescription: 'Bevora Semiconductor · Assembly',
  machineCode: 'AW02', frequency: 'M6', frequencyScope: ['M3', 'M6'],
  dueOn: '2026-08-14', status: 'ARCHIVED',
  standingContent: {
    frequencyBanner: 'Three Monthly (3M) Six Monthly (6M) Yearly (Y)',
    ppe: ['Safety Shoes', 'Ear Plugs (If required)'],
    safety: 'Please switch off the main power and put the lock out/ tag on the power disconnect.',
    remarks: 'For Y maintenance, 3M and 6M must be performed at the same time.',
  },
  checklist: [
    { itemNo: 1, frequency: 'M3', inScope: true, instruction: 'Inspection and check safety interlock / emergency stop is functional', status: 'DONE', remark: null },
    { itemNo: 13, frequency: 'Y', inScope: false, instruction: 'Calibrate Workholder, BH Setup, Heater Block Setup, Bond Force', status: 'NOT_EVALUATED', remark: null },
  ],
  measurements: [
    { description: 'Heater Block Flatness Check', unit: 'um', specDisplay: 'Hmin ≤ 20 um', reading: '17.4', judgement: 'PASS', remark: null },
    { description: '91 steps calibration', unit: 'μm/encoder', specDisplay: '0.19 – 0.21 μm/encoder', reading: '0.218', judgement: 'FAIL', remark: 'Above upper limit' },
  ],
  partsUsed: [{ partNo: 'ASM-4471-FLT', description: 'Air filter element', quantity: '2', remarks: null }],
  attachments: [],
  signatures: [
    { approvalStepId: 's1', stageOrdinal: 0, action: 'SUBMITTED', actorName: 'R. Tan', actorRoleCode: 'MAINTAINER', actedAt: '2026-08-14' },
  ],
  footer: { recordId: 'rec-1', integrityDigestHex: 'deadbeefcafe', renderedAt: '2026-08-14T02:00:00Z' },
};

export function recordShape(name: string): PdfRecordInput {
  if (name === 'monthly-only') {
    return {
      ...base,
      documentNumber: 'CE 95 012 00 02', frequency: 'M1', frequencyScope: ['M1'],
      standingContent: { ...base.standingContent, frequencyBanner: 'Monthly (1M) Three Monthly (3M) Six Monthly (6M) Yearly (Y)' },
      checklist: [{ itemNo: 1, frequency: 'M1', inScope: true, instruction: 'Monthly check', status: 'DONE', remark: null }],
    };
  }
  if (name === 'long-18-item') {
    return {
      ...base,
      documentNumber: 'CE 95 043 00 01', frequencyScope: ['M1', 'M3', 'M6', 'Y'],
      checklist: Array.from({ length: 18 }, (_, i) => ({
        itemNo: i + 1,
        frequency: i < 10 ? 'M1' : i < 14 ? 'M3' : i < 17 ? 'M6' : 'Y',
        inScope: true,
        instruction: `Maintenance instruction number ${i + 1} for the long-form pagination case`,
        status: 'DONE',
        remark: null,
      })),
    };
  }
  if (name === 'voided') {
    return { ...base, voidNotice: { reason: 'Wrong machine', voidedAt: '2026-08-15', voidedByName: 'S. Kumar' } };
  }
  return base;
}
```

- [ ] **Step 2: Write the golden tests**

```ts
// api/src/pdf/pdf-html-template.golden.spec.ts
import { renderRecordHtml } from './pdf-html-template';
import { recordShape } from './__fixtures__/record-shapes';

describe('QA-format record — golden shapes', () => {
  for (const name of ['single-3m', 'monthly-only', 'long-18-item', 'voided']) {
    it(`renders ${name} stably`, () => {
      expect(renderRecordHtml(recordShape(name))).toMatchSnapshot();
    });
  }

  it('prints every one of the 18 rows on a long form', () => {
    const html = renderRecordHtml(recordShape('long-18-item'));
    for (let n = 1; n <= 18; n++) {
      expect(html).toContain(`<td class="p-no">${n}</td>`);
    }
  });

  it('never recomputes the digest — the stored hex is printed verbatim', () => {
    const shape = recordShape('single-3m');
    const html = renderRecordHtml({ ...shape, footer: { ...shape.footer, integrityDigestHex: 'aaaa1111' } });
    expect(html).toContain('aaaa1111');
    expect(html).not.toContain('deadbeefcafe');
  });

  it('still marks a voided record while showing intact content', () => {
    const html = renderRecordHtml(recordShape('voided'));
    expect(html).toContain('RECORD VOID');
    expect(html).toContain('Wrong machine');
    expect(html).toContain('<td class="p-no">1</td>');
  });
});
```

- [ ] **Step 3: Run to create the snapshots**

Run: `cd api && npx jest --config jest.unit.config.js pdf-html-template.golden`
Expected: PASS, 4 snapshots written. **Read each snapshot before committing** — a snapshot test that was never eyeballed proves only that output is stable, not that it is right.

- [ ] **Step 4: Run the whole PDF suite plus the gates**

Run:
```bash
cd api && npx jest --config jest.unit.config.js pdf && npm run typecheck
cd .. && npm run format:check
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add api/src/pdf/__fixtures__/record-shapes.ts api/src/pdf/pdf-html-template.golden.spec.ts api/src/pdf/__snapshots__
git commit -m "test(pdf): golden coverage for form shapes and digest stability"
```

---

## Verification before done

- [ ] `cd api && npx jest --config jest.unit.config.js pdf` — green.
- [ ] `cd api && npm run typecheck` — clean.
- [ ] `npm run format:check` — clean.
- [ ] `npm run gen:api-types && git diff --exit-code web/src/api/generated` — no drift (Task 1 changed `openapi.yaml`).
- [ ] Render one real record end to end against a running stack and **look at the PDF**. Chromium's print pipeline is the only authority on page breaks; no unit test substitutes for it (spec risk 3).
- [ ] Re-render a record archived before this change and confirm `GET /records/{id}/integrity` still passes.
- [ ] Whole-branch review before merge, per standing flow.

## Notes for the implementer

- **Do not add a migration.** `template_revision.standing_content` is a JSON column; Task 1 needs no schema change.
- **The banner fallback matters.** Every record archived before Task 1 has no `frequencyBanner`. `renderFrequencyBand` must keep printing a band for them — that path is tested in Task 3 Step 1.
- **Spec risk 1 is still open:** no QA-approved specimen PDF has been supplied. This plan reconstructs the layout from the extracted workbook and the current PDF's block list. If a specimen arrives, diff it against Task 7's snapshots before calling the slice done.
