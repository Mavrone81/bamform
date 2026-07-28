# Template Load — Ambiguity Register and Cross-Document Checks

Generated with the AC-01 evidence pack (BAMFORM-TLP-001 §7.2). Regenerate with
`npx ts-node -P scripts/template-load/tsconfig.json scripts/template-load/src/cli-extract.ts`.

## Cross-document checks (X-1..X-6)

| # | Check | Result |
|---|---|---|
| X-1 | All 12 documents present | PASS (12) |
| X-2 | Total item count = 145 (TLP §2) | **ATTENTION — source total is 146** — CE 95 050 00 03 has 11 instruction rows, not the 10 the TLP counted (N-04); the source wins, pending client confirmation |
| X-3 | Each asset type maps to exactly one template | PASS (12 distinct codes) |
| X-4 | Every supplied asset code exists and is correctly typed | PENDING — B-09: the real asset list is a client deliverable; this slice creates clearly-marked provisional SAMPLE machines only (decision 2026-07-27) |
| X-5 | Cascade produces the correct item set for a Y job | Proven per asset type by the loader e2e (api/test/integration/template-load/load-e2e.spec.ts, U-CAS-08) |
| X-6 | No template has an unparsed or inverted specification | **ATTENTION — 5 specification(s) escalated as TEXT pending client decisions (no inverted range is ever loaded):** |

- CE 95 020 00 01 — "Track Height Calibration, Top Plate": `-295 - -305` (printed range is high-to-low (-295 > -305) — inverted per INV-04; client decision required)
- CE 95 020 00 03 — "Maximum Window Clamp Opening": `75 mils` (specification does not match any TLP §4.2 printed form)
- CE 95 020 00 03 — "Rail Width Measurement": `35mm Plate` (specification does not match any TLP §4.2 printed form)
- CE 95 020 00 03 — "Rail Height Calibration": `Optimal` (qualitative specification with no numeric content)
- CE 95 020 00 03 — "Bond Force  DAC": `6.4 - 7,1 counts/gram` (comma-decimal number in specification — client to confirm intended value)

Total measurements across the set: 84.

## Outstanding client decisions (TLP §8.2, updated by this load)

- [x] **B-04** — decided: corrected to 95 – 105 g, loaded as client revision D of CE 95 020 00 01.
- [ ] B-02 — confirm the wording of the revision-gap note on CE 95 010 00 01.
- [ ] B-03 — confirm the as-printed treatment of out-of-order revision dates (doc CE 95 055 00 01 per the TLP, and the same anomaly found on CE 95 020 00 02, CE 95 030 00 01, CE 95 050 00 01).
- [ ] B-05 — confirm the mapping of short approver names (Sara/Suren) to individuals; history entries are loaded verbatim as free text.
- [ ] **B-09 — supply the real asset list (machine codes per document). Blocking for go-live; sample machines are placeholders.**
- [ ] OI-08 — confirm the cascade rule on CE 95 043 00 01 (its Remarks omit 3M; CE 95 050 00 01 prints the same wording, and CE 95 030 00 01 prints a third variant — see those documents' evidence files).
- [ ] Confirm whether the embedded images in CE 95 043 00 01 / CE 95 055 00 01 are instructionally required (not loaded in Release 1).
- [ ] **N-01** — CE 95 020 00 01 "Track Height Calibration, Top Plate": printed `-295 - -305` (high-to-low, no unit). Loaded as TEXT pending decision.
- [ ] **N-02** — CE 95 020 00 03 "Bond Force  DAC": printed `6.4 - 7,1 counts/gram` (comma decimal). Loaded as TEXT pending decision.
- [ ] N-03 — CE 95 020 00 03 PRS Calibration prints "XY =" twice (evident intent YX). Both loaded verbatim.
- [ ] **N-04** — CE 95 050 00 03 has an unnumbered instruction row; source has 11 rows / set total 146 (TLP counted 10 / 145). Items renumbered positionally; confirm.
- [ ] N-05 — TLP §5.1 states 21 measurements for CE 95 020 00 01; the source sheet has 20.
- [ ] N-06 — CE 95 020 00 02 dual-variant USL/LSL table: confirm the two-measurements-per-row modelling and the inconsistent USL/LSL column labels.
- [ ] N-08 — qualitative/single-value specifications loaded as TEXT (see X-6 list): confirm intended judgements.
- [ ] **N-11** — grouped calibration section labels are space-joined (e.g. CE 95 020 00 01 rows 58-63 → "BH Setup & Calibration Heater Block Setup"). TLP §4.1's "blank inherits the section above" would split a genuinely two-section group instead; TLP §5.1 lists those as separate sections. This is the label a technician sees — accept the join, or split per §4.1 (parser change + regeneration). See the per-document evidence tables for every affected group.

## Per-document ambiguity register

### CE 95 010 00 01 — BESI Die Attach

- **N-08** [A61, A64]: the inline curing oven calibration block is free text with Pass/Fail tick columns; loaded as a single PASS_FAIL measurement whose spec_display ("Pass / Fail") is synthesised from those columns. Source cells shown in the evidence table.
- **B-01** [A1, B1, D1]: formula error(s) in the Revision History header (A1, B1, D1) — header values re-entered from the intact title block (TLP §3 B-01).
- **B-02**: revision codes run 0, A, C, D, E — the sequence has a gap. Client answered "no need" (Q8): loaded with contiguous sequence ordinals while the historical letters are retained; the gap stays visible here and in the revision history (TLP §3 B-02, PR-TLP-03).

### CE 95 012 00 01 — Emerald Pick and Place

- **N-09**: worksheet is named "CE ", not the document number. Cosmetic; the document number is taken from the title block.

### CE 95 012 00 02 — Powatec Mounting

- **N-09**: worksheet is named "CE ", not the document number. Cosmetic; the document number is taken from the title block.

### CE 95 020 00 01 — ASM Wire Bond

- **N-11** [B58, B59]: section label "BH Setup & Calibration Heater Block Setup" was space-joined from 2 printed labels ("BH Setup & Calibration", "Heater Block Setup") in the group starting at row 58. TLP §4.1's rule is "verbatim; blank inherits the section above", which for a genuinely two-section group would instead read "BH Setup & Calibration" then "Heater Block Setup" as SEPARATE sections. Where the label merely wrapped across rows the join is correct. Client to confirm per group: accept the joined label, or split per §4.1 (a parser change + regeneration).
- **B-04** [J66]: specification at J66 printed as "95 - 28 g" — loaded as "95 - 105 g" per B-04 (client revision D).
- **N-11** [B68, B69, B70]: section label "Wire Clamp Calibration Wire Clamp Force Verification" was space-joined from 3 printed labels ("Wire Clamp Calibration", "Wire Clamp Force", "Verification") in the group starting at row 68. TLP §4.1's rule is "verbatim; blank inherits the section above", which for a genuinely two-section group would instead read "Wire Clamp Calibration" then "Wire Clamp Force" then "Verification" as SEPARATE sections. Where the label merely wrapped across rows the join is correct. Client to confirm per group: accept the joined label, or split per §4.1 (a parser change + regeneration).
- **N-11** [B71, B72]: section label "Transducer Calibration (TVC)" was space-joined from 2 printed labels ("Transducer Calibration", "(TVC)") in the group starting at row 71. TLP §4.1's rule is "verbatim; blank inherits the section above", which for a genuinely two-section group would instead read "Transducer Calibration" then "(TVC)" as SEPARATE sections. Where the label merely wrapped across rows the join is correct. Client to confirm per group: accept the joined label, or split per §4.1 (a parser change + regeneration).
- **N-01** [J61]: "Track Height Calibration, Top Plate" specification printed as "-295 - -305" — high-to-low printed range with no unit; inverted per INV-04 and NOT client-dispositioned (unlike B-04). Loaded as spec_type TEXT verbatim (the B-04 option (b) mechanism), pending a client decision. PR-TLP-05.
- **N-05**: TLP §5.1 states 21 calibration measurements; the source sheet has 20 measurement rows. The source wins; discrepancy recorded.

### CE 95 020 00 02 — Besi Esec Wire Bond

- **N-10**: printed item numbering is non-contiguous (skips before 10) — loaded verbatim as printed.
- **N-06** [I57, K57, I58, K58]: the calibration table carries TWO machine-variant limit pairs (ESEC 3100 / plus and ESEC 3200) in explicit USL/LSL columns. Loaded as two measurements per printed row (descriptions suffixed with the variant) so no limit is lost; a technician records the pair matching the machine's variant. Additionally the USL/LSL column labels are inconsistently ordered in the source (the USL column holds the SMALLER endpoint at I57, K57, I58, K58); parsed limits use min/max so no inverted range is loaded. Client to confirm both the modelling and the intended labels.
- **N-07** [Q38]: stray cell outside the form grid: Q38 = "Preheat, Bond Process heat, and Post Heat blocks calibration\r\n" — not loaded.
- **B-03**: revision history dates are out of chronological order as printed (0=2021-03-24, A=2021-09-21, B=2023-08-06, C=2023-03-20). Loaded in printed order with dates AS PRINTED; not silently reordered (TLP §3 B-03, PR-TLP-03). NOTE: TLP §3 flags this defect only on CE 95 055 00 01; the same anomaly exists here.

### CE 95 020 00 03 — KNS Wire Bond

- **B-06**: worksheet is named "CE 95 020 00 01" — copied from CE 95 020 00 01 (TLP §3 B-06). Cosmetic; the document number is taken from the title block.
- **N-10**: printed item numbering is non-contiguous (skips before 10) — loaded verbatim as printed.
- **N-08** [J53]: "Maximum Window Clamp Opening" specification "75 mils" is specification does not match any TLP §4.2 printed form — loaded as spec_type TEXT verbatim; client to confirm the intended judgement. (sheet1!J53)
- **N-08** [J55]: "Rail Width Measurement" specification "35mm Plate" is specification does not match any TLP §4.2 printed form — loaded as spec_type TEXT verbatim; client to confirm the intended judgement. (sheet1!J55)
- **N-08** [J57]: "Rail Height Calibration" specification "Optimal" is qualitative specification with no numeric content — loaded as spec_type TEXT verbatim; client to confirm the intended judgement. (sheet1!J57)
- **N-02** [J61]: "Bond Force  DAC" specification printed as "6.4 - 7,1 counts/gram" — comma decimal (evident intent 7.1). Loaded as spec_type TEXT verbatim pending a client decision. (sheet1!J61)
- **N-03** [J65, J66, J67, J68]: "PRS Calibration" prints the spec line label "XY =" twice — evident intent is YX for one of them. Both lines loaded verbatim; client to confirm.
- **N-07** [AA53]: stray cell outside the form grid: AA53 = "a" — not loaded.

### CE 95 030 00 01 — MB Encapsulation

- **B-03**: revision history dates are out of chronological order as printed (0=2021-04-01, A=2021-05-19, B=2021-09-21, C=2023-04-10, D=2023-03-20). Loaded in printed order with dates AS PRINTED; not silently reordered (TLP §3 B-03, PR-TLP-03). NOTE: TLP §3 flags this defect only on CE 95 055 00 01; the same anomaly exists here.

### CE 95 030 00 03 — Pre-mixer machine

- **N-09**: worksheet is named "CE ", not the document number. Cosmetic; the document number is taken from the title block.
- **N-08** [I50, K50]: the record table prints bare LCL/UCL column values; spec_display is synthesised as "LCL n / UCL n" with unit "mbar" (TLP §4.2's explicit-LCL/UCL row). Source cells shown in the evidence table.

### CE 95 043 00 01 — Bump Dispensing

- **N-09**: worksheet is named "Bachelor Bump BD01", not the document number. Cosmetic; the document number is taken from the title block.
- **B-01** [D1]: formula error(s) in the Revision History header (D1) — header values re-entered from the intact title block (TLP §3 B-01).

### CE 95 050 00 01 — MB E-Test

- **B-03**: revision history dates are out of chronological order as printed (0=2021-04-05, A=2021-04-19, B=2021-09-21, C=2023-04-27, D=2023-03-20). Loaded in printed order with dates AS PRINTED; not silently reordered (TLP §3 B-03, PR-TLP-03). NOTE: TLP §3 flags this defect only on CE 95 055 00 01; the same anomaly exists here.

### CE 95 050 00 03 — OS Loading

- **N-09**: worksheet is named "CE ", not the document number. Cosmetic; the document number is taken from the title block.
- **N-04** [sheet1!A29]: the checklist has 11 instruction rows but the printed numbering is defective: one row ("Check all machine switches condition") has no printed number and the printed sequence skips 9. Items are loaded with positional numbers 1..11; the printed numbers are preserved in the AC-01 evidence. TLP §2 counted 10 items for this document (and 145 in total) — the source sheet has 11 (146 in total). Client to confirm.
- **N-10**: printed item numbering is non-contiguous (skips before 10) — loaded verbatim as printed.

### CE 95 055 00 01 — AVS 35

- **B-03**: revision history dates are out of chronological order as printed (0=2022-12-15, A=2022-04-27). Loaded in printed order with dates AS PRINTED; not silently reordered (TLP §3 B-03, PR-TLP-03).
