# Design — Migrating the PM masterlist into BamForm

Date: 2026-08-02
Status: agreed with the owner in session; ready for an implementation plan
Source document: `ML-S-MFT-00015 Machine Preventive Maintenance Masterlist Rev 21` (LINXENS)

## 1. Problem

BamForm is live, signed in to, and effectively empty: **one machine, no
documents, no schedule rules, therefore no jobs**. Nothing downstream of an
asset exists, so the app has nothing to show and nothing to do.

The plant's real PM programme lives in `ML-S-MFT-00015`, a spreadsheet
maintained by hand. BamForm exists to replace it. This slice is the one-time
migration that moves the plan into the system; after it, the system owns the
schedule and the masterlist is retired.

## 2. What the masterlist actually is

A **staggered annual work-week calendar**, not a list of intervals.

- Row 4 carries work weeks 1–52 across columns `B`–`BA`; row 5 carries month bands.
- Each machine is one row. Column `A` is `Model -- Code`
  (`ESEC 2008 sc3 plus -- ED01`, `ASM Eagle Xtreme GoCu -- AW01`); some rows
  carry the code alone (`EP01`, `BD01`, `AVS35-01`).
- A cell at (machine, work week) is the frequency due that week: `1M`, `3M`,
  `6M` or `Y`.

**77 rows carry a plan.** Machines get 4, 5 or 13 visits a year. Example:

```
ED01   WW5:6M    WW18:3M   WW30:Y    WW43:3M
ED02   WW6:3M    WW19:Y    WW31:3M   WW44:6M
EP01   WW1,5,9,13,17,21,25,29,33,37,41,45,49 : 1M
```

The stagger is deliberate — ED01 starts at week 5, ED02 at week 6 — so twenty
die-attach machines are not all serviced in the same week.

**This does not require a scheduling redesign.** Because each machine's first
due date comes from its own planned week and the interval carries it forward
independently, the stagger is preserved by seeding alone.

## 3. Current state (verified in code, 2026-08-02)

- **The chain from a document onward is automatic.**
  `ScheduleRuleBootstrapService` iterates a machine's documents, derives the
  frequencies from each document's current template revision's distinct active
  items, and creates `schedule_rule` rows idempotently — called lazily by
  `GET /assets/{id}/schedule` and proactively by every scheduler sweep. Nothing
  else creates schedule rules; there is no endpoint for it.
- **The write paths all exist**: `POST /assets`, `POST /assets/{id}/documents`,
  and `PATCH /assets/{assetId}/schedule` (`ScheduleAdjust`:
  `assetDocumentId`, `frequency`, `nextDueOn`, `adjustedReason` min 10 chars,
  audited).
- `Asset.scheduleAnchorDate` is **required** and is per-asset; the bootstrap
  seeds every rule's `anchorDate` and `nextDueOn` from it, so per-frequency
  dates must be set afterwards via the adjust endpoint.
- **Asset types carry only** `approvalRouteId` and `leadTimeDays`. Since slice
  27 they no longer carry a form — a machine's documents do.
- The 12 CE-95 forms are loaded, one asset type per form.

## 4. Coverage — how the masterlist maps to what is loaded

**75 of 77 machines map to a form already in the system:**

| Machines | Asset type | Masterlist model |
|---|---|---|
| 20 | BESI Die Attach | `ESEC 2008 sc3/hsc3 plus` |
| 13 | KNS Wire Bond | `ConnX-Elite Lite` |
| 12 | Besi Esec Wire Bond | `Besi ESEC 3100/3100 plus/3200` |
| 12 | MB Encapsulation | `MB CME…`, `MB CMT…` |
| 6 | ASM Wire Bond | `ASM Eagle Xtreme GoCu` |
| 5 | Pre-mixer machine | `Pre Mixer DP01–DP05` |
| 3 | AVS 35 | `AVS35-01/02/03` |
| 1 each | OS Loading · Bump Dispensing · Emerald Pick and Place · Powatec Mounting | `IMOS-01` · `BD01` · `EP01` · `PM01` |

Two do not:

- **`MS-620 ST01`** (1M/3M/6M) — imported as a machine with **no document**. It
  appears in the register and generates no jobs until a form exists for it.
- **`DDA 03`** (1M) — **skipped entirely.** Owner: the machine is not on site.

## 5. Decisions (owner, 2026-08-02)

| Question | Decision |
|---|---|
| Is the masterlist authoritative going forward? | **No.** It is the current manual method; BamForm replaces it. This is a one-time migration and the system owns the schedule afterwards. |
| Plan year | **2026** |
| Work-week convention | **Calendar weeks** — week *n* begins `1 Jan 2026 + (n−1) × 7` days. 1 Jan 2026 is a Thursday, so every planned date is a Thursday. |
| Plan vs form frequency conflicts | **Prompt the operator per conflict** and record the choice. |
| `DDA 03` | Skip. |
| `MS-620 ST01` | Import without a document; a form creator (separate slice) will unblock it. |

## 6. Conflicts — there are three

For each machine the frequencies the **plan** schedules were compared with the
frequencies its **form** defines. **72 agree exactly.** Three differ, all in the
same direction — the form defines a frequency the plan does not schedule.
**No machine plans a frequency its form cannot describe.**

```
ASM Eagle Xtreme GoCu -- AW06    plan=[3M,6M]     form also defines [Y]
BD01                             plan=[1M,3M,6M]  form also defines [Y]
EP01                             plan=[1M]        form also defines [3M]
```

These are probably real, not errors — `AW01`–`AW05` all carry `Y` and `AW06`
does not, which reads like a newer machine whose annual has not come round.

Because the bootstrap derives rules **from the form**, doing nothing would
silently schedule work the plant does not plan. So the importer stops at each
conflict and asks:

```
Conflict 1 of 3 — ASM Eagle Xtreme GoCu -- AW06
  Masterlist plan schedules:  3M, 6M
  The PM form also defines:   Y

  [1] Follow the plan  — schedule 3M and 6M only
  [2] Follow the form  — also schedule Y (first due date required)

Choice:
```

Choosing **[1]** deactivates the surplus rule (`active = false`) rather than
deleting it, so the form is untouched and the decision is reversible. The choice
and its reason are written to the evidence file.

## 7. Design — the importer

A CLI in the shape of the existing template loader, which already proves the
pattern: `npm run import:masterlist`.

**It drives the HTTP API, not the database.** The template loader does the same.
That keeps validation, area scoping and the audit trail intact, and means the
migration leaves the same evidence any human action would.

Per machine row carrying a plan:

1. **Parse** column A into model and machine code.
2. **Map** the model to an asset type by the §4 table. An unmapped model is
   reported, never guessed.
3. **Create the machine** — `POST /assets` with `code`, `assetTypeId`,
   `description` (the model), and `scheduleAnchorDate` = that machine's
   **earliest planned date**, so the asset-level anchor is consistent with its
   rules rather than an arbitrary "today".
4. **Attach its document** — `POST /assets/{id}/documents` with the family's
   form template, setting `machineNumber` only where the template title carries
   a fillable run (e.g. `…Record KW___` → `KW13`). Confirmed per template during
   implementation, never assumed.
5. **Read the schedule** — `GET /assets/{id}/schedule`, which lazily bootstraps
   one rule per frequency the form defines.
6. **Set the planned dates** — `PATCH /assets/{id}/schedule` per frequency with
   `nextDueOn` = the machine's first planned week for that frequency, and
   `adjustedReason` = `Migrated from ML-S-MFT-00015 Rev 21 (WW<n>)`, which also
   satisfies the 10-character minimum and leaves the provenance in the audit
   trail.
7. **Resolve conflicts** per §6.

**Required properties:**

- **Dry run by default.** `--apply` performs writes. A dry run prints every
  machine, type, document and date and writes nothing, so all 77 can be checked
  against the spreadsheet before anything is created.
- **Idempotent.** Re-running skips machines that already exist and never
  overwrites a schedule a human has since adjusted.
- **Evidence file** — one row per machine: source label, machine code, asset
  type, document, and each frequency's first due date, plus every conflict and
  how it was resolved. This is what gets diffed against the masterlist.
- **Fails loudly.** An unmapped model, a missing form template or an
  unparseable label stops that machine with a message; it never invents a
  mapping.

## 8. Out of scope

- **The planner UI and its API.** `/assets/{assetId}/schedule` is per-machine;
  there is no cross-machine view, so "everything due in WW12" cannot be asked
  today. That is the masterlist's actual replacement and gets its own slice.
- **The form creator.** All nine authoring endpoints exist; only the screens are
  missing. Separate slice; it unblocks `MS-620 ST01`.
- Any change to scheduling behaviour, the cascade, or job generation.
- The remaining admin UI gaps (asset types, approval routes, archive search,
  exports, reports, audit).

## 9. Risks

1. **The work-week convention is an assumption until verified.** Calendar weeks
   from 1 Jan put every date on a Thursday. If the plant reads WW5 as "week
   beginning Monday 26 Jan", all 77 machines shift three days. The dry run
   prints the dates precisely so this is caught before any write.
2. **`machineNumber` mapping is per-template.** Only some titles carry a
   fillable run. Setting it where it does not belong corrupts a printed title;
   omitting it where it does leaves a blank. Verify per template, do not infer.
3. **Model matching is by pattern.** `ESEC 2008*` → BESI Die Attach and
   `Besi ESEC 3*` → Besi Esec Wire Bond are close enough to confuse. The
   evidence file lists every decision so a human can check all 77.
4. **A partial run leaves a half-built machine** — created, no document. The
   importer is idempotent so re-running completes it, but the evidence file must
   make partial states obvious rather than silently resuming.
