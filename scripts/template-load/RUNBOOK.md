# Template Load — Staging Execution Runbook (slice 13-TL)

Controller-supervised procedure for loading the twelve CE 95 PM templates into the live
BamForm instance (https://form.bevorasg.com) per **BAMFORM-TLP-001 §6**. The engineer's
tooling never touches the production box directly — every step below runs from a checkout of
this repository on the controller's workstation and talks HTTPS to the real API only
(PR-TLP-07: authenticated, attributable, audited; no DB access anywhere).

> **Production note.** BamForm has a single environment (staging was retired 2026-07-24);
> "staging" in TLP §6 therefore means: run the load on the live box **before go-live, before
> any real records exist**, with the AC-01 verification completed **before** the system is
> handed to users. PR-TLP-12/13: pre-go-live this is safely correctable; after go-live it is
> not.

## 0. Preconditions (all mandatory)

- [ ] The working tree is a clean checkout of the reviewed/merged commit — the YAML in
      `scripts/template-load/yaml/` is EXACTLY what CI's drift guard verified (PR-TLP-09).
- [ ] `node -v` reports v22.x (`export PATH=/opt/homebrew/opt/node@22/bin:$PATH`) and
      `npm ci` has been run at the repo root.
- [ ] The AC-01 evidence pack (`scripts/template-load/evidence/*.md` + `REGISTER.md`) has
      been reviewed by the owner. The register's **outstanding client decisions** list has
      been read out loud: N-01, N-02, N-04 in particular are loaded provisionally
      (TEXT / positional numbering) and stay open items — the load does NOT resolve them.
- [ ] Two REAL named accounts exist on the target (create via the admin UI as
      samuel@vorkhive.com if needed): - an **author** holding roles `DOC_CONTROLLER` **and** `ENGINEER` - an **approver** holding role `DOC_CONTROLLER`, a **different person** (INV-03 —
      self-approval is rejected by the API and the DB).
      Both must have MFA not enforced for the run (MFA flags are off by default).
- [ ] A fresh DB backup exists (`scripts/server/bamform-backup.sh` on the droplet, or a
      manual `pg_dump`) — the rollback path of last resort.

## 1. Dry-run equivalence check (local, no server contact)

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npx tsc --noEmit -p scripts/template-load
npx ts-node -P scripts/template-load/tsconfig.json scripts/template-load/src/cli-extract.ts
git status --porcelain scripts/template-load/
```

**Expected:** the extract prints 12 documents / 146 items and `git status` shows NO
modifications — the committed YAML/evidence equals what the sources produce. If anything is
dirty, STOP: either the source workbooks or the parser changed since review; re-review before
loading (PR-TLP-10).

## 2. Load the templates (no machines yet)

```bash
export BAMFORM_BASE_URL="https://form.bevorasg.com"
export BAMFORM_AUTHOR_EMAIL="<author email>"
read -s BAMFORM_AUTHOR_PASSWORD && export BAMFORM_AUTHOR_PASSWORD
export BAMFORM_APPROVER_EMAIL="<approver email>"
read -s BAMFORM_APPROVER_PASSWORD && export BAMFORM_APPROVER_PASSWORD

npx ts-node -P scripts/template-load/tsconfig.json scripts/template-load/src/cli-load.ts
```

**Expected output:** per document a `created` line ending
`DONE: 12 created, 0 resumed, 0 updated, 0 unchanged.` The run takes a few minutes (34
revisions are authored, submitted and approved through the normal workflow; the approver's
step-up happens automatically when the API demands it).

If the run stops midway (network, expiry): **re-run the same command.** The loader resumes —
completed documents report `unchanged`, the interrupted one continues from where it stopped.
It never duplicates (INV-01/02/07 enforced server-side; the loader only ever reads-then-acts).

## 3. AC-01 verification (the client's, not the engineer's)

In the web UI, as any authenticated reviewer:

1. Open **each of the 12 templates** and its CURRENT revision.
2. Verify against the paper original using the per-document checklist V-1..V-14 in
   `scripts/template-load/evidence/<doc>.md` (each file shows source cell → loaded field for
   every item and measurement).
3. Complete the sign-off table at the end of each evidence file; collect the §7.3 sheet.

**Deviation from PR-TLP-11 (declared):** the TLP prescribes verification against a rendered
blank-template PDF; the system has no blank-template PDF renderer (the PDF pipeline renders
completed records). Verification is therefore against the web UI's rendered checklist plus
the evidence pack. If Quality insists on PDF, print the browser view to PDF.

**Discrepancy path (PR-TLP-12):** pre-go-live, fix the parser/YAML in a reviewed commit, then
re-run step 2 — the loader detects content drift and creates ONE corrective revision through
the normal approval flow (reported as `updated`). The superseded revision remains visible as
history of the correction, which is what an auditor should see.

## 4. Sample machines + schedules + proof of life

Only after the 12 documents are verified (or in parallel on a pilot asset type at the
owner's discretion):

```bash
npx ts-node -P scripts/template-load/tsconfig.json scripts/template-load/src/cli-load.ts \
  --sample-machines --anchor=$(date -u +%F)
```

**Expected:** 13 machines total (2 × ASM Wire Bond — one template, many assets, UR-018;
1 × each other type), every code `PROV-XXXXXXXX`, shown RED/provisional in the admin UI's
machine list, description marking them as SAMPLE (B-09: these are placeholders; the real
asset list is a client deliverable, DP-03).

The scheduler (worker cron, `SCHEDULER_CRON`, default hourly) generates jobs on its next
tick — anchor = today puts every rule inside the 30-day lead window immediately. Verify:

1. Wait for the next tick (or up to one hour), then open the jobs list.
2. Each sample machine has scheduled jobs; the ASM machines' Y job shows the full 14-item
   checklist and all 20 measurements, matching the evidence file for CE 95 020 00 01.
3. `docker logs bamform-worker` on the droplet shows the tick with `generated > 0` and the
   following tick with `generated: 0` (no duplicates).

## 5. Aftercare

- Sample machines stay provisional/RED until the client's real machine list migrates in via
  the admin UI; **do not** confirm their codes.
- Record the run (date, operator names, `DONE:` summary line) in the project ledger.
- The outstanding decisions in `evidence/REGISTER.md` (N-01, N-02, N-04, N-06, OI-08, B-09,
  the doc-9/12 images) go to the client; N-01/N-02 corrections, when decided, are authored as
  new template revisions through the normal document-control workflow — NOT by re-running
  this loader after go-live (PR-TLP-12's asymmetry).

## Rollback

Before go-live, with no real records: restore the pre-load DB backup (step 0), or leave the
loaded rows in place and reload after corrections (the corrective-revision path above is
usually the better audit trail). After go-live: rollback is prohibited (DP-3); corrections go
through new revisions only.
