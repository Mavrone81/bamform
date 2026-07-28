/**
 * Slice 13-TL — parsing the 12 REAL PM workbooks into the TLP §6.1
 * intermediate model (TEST_PLAN I-TL-05..16).
 *
 * Expectations here were derived by reading the raw sheet XML of every
 * workbook by hand — item counts, frequency distributions, measurement
 * rows, standing content and the source defects (TLP §3 B-01..B-09 plus
 * the further anomalies this slice found, registered as N-01..). Where the
 * TLP's own inventory disagrees with the source files (its 145-item total,
 * its 21-measurement count for doc 4), the SOURCE wins and the discrepancy
 * is asserted as a captured ambiguity, never silently absorbed.
 */
import { join } from 'node:path';
import { parseAllForms } from '../../../../scripts/template-load/src/parse';
import { parseSpec } from '../../../../scripts/template-load/src/spec';
import type { ParsedDocument } from '../../../../scripts/template-load/src/model';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FORMS_DIR = join(REPO_ROOT, 'Sample of Forms');

let docs: Map<string, ParsedDocument>;
beforeAll(() => {
  docs = new Map(parseAllForms(FORMS_DIR).map((d) => [d.documentNumber, d]));
});
const doc = (n: string): ParsedDocument => {
  const d = docs.get(n);
  if (!d) throw new Error(`document ${n} not parsed`);
  return d;
};

const freqCount = (d: ParsedDocument) => {
  const acc: Record<string, number> = {};
  for (const item of d.items) acc[item.frequency] = (acc[item.frequency] ?? 0) + 1;
  return acc;
};

describe('template-load parser — all 12 real workbooks (I-TL-05..16)', () => {
  it('I-TL-05: parses all 12 documents with the correct document numbers and titles', () => {
    expect([...docs.keys()].sort()).toEqual([
      'CE 95 010 00 01',
      'CE 95 012 00 01',
      'CE 95 012 00 02',
      'CE 95 020 00 01',
      'CE 95 020 00 02',
      'CE 95 020 00 03',
      'CE 95 030 00 01',
      'CE 95 030 00 03',
      'CE 95 043 00 01',
      'CE 95 050 00 01',
      'CE 95 050 00 03',
      'CE 95 055 00 01',
    ]);
    // Titles verbatim, including machine-identifier blanks (TLP §4.1) and
    // doc 12's embedded CRLF.
    expect(doc('CE 95 010 00 01').title).toBe(
      'BESI Die Attach Preventive Maintenance Record ED____',
    );
    expect(doc('CE 95 020 00 01').title).toBe('ASM Wire Bond Preventive Maintenance Record');
    expect(doc('CE 95 030 00 03').title).toBe(
      'Pre-mixer machine Preventive Maintenance Record DP_____',
    );
    expect(doc('CE 95 055 00 01').title).toBe(
      'Preventive Maintenance Work Instruction / \r\nRecord AVS 35-____',
    );
  });

  it('I-TL-06: item counts and per-frequency distributions match the source sheets', () => {
    // TLP §2 inventory column "Items" — EXCEPT doc CE 95 050 00 03, where
    // the source truly has 11 instruction rows (see I-TL-12); the TLP's 145
    // total is a miscount of the source.
    expect(doc('CE 95 010 00 01').items).toHaveLength(18);
    expect(freqCount(doc('CE 95 010 00 01'))).toEqual({ M3: 14, M6: 3, Y: 1 });
    expect(doc('CE 95 012 00 01').items).toHaveLength(6);
    expect(freqCount(doc('CE 95 012 00 01'))).toEqual({ M1: 4, M3: 2 });
    expect(doc('CE 95 012 00 02').items).toHaveLength(4);
    expect(freqCount(doc('CE 95 012 00 02'))).toEqual({ M1: 4 });
    expect(doc('CE 95 020 00 01').items).toHaveLength(14);
    expect(freqCount(doc('CE 95 020 00 01'))).toEqual({ M3: 8, M6: 4, Y: 2 }); // TLP §5.1 ✓
    expect(doc('CE 95 020 00 02').items).toHaveLength(15);
    expect(freqCount(doc('CE 95 020 00 02'))).toEqual({ M3: 5, M6: 5, Y: 5 });
    expect(doc('CE 95 020 00 03').items).toHaveLength(15);
    expect(freqCount(doc('CE 95 020 00 03'))).toEqual({ M3: 8, M6: 5, Y: 2 });
    expect(doc('CE 95 030 00 01').items).toHaveLength(13);
    expect(freqCount(doc('CE 95 030 00 01'))).toEqual({ M1: 6, M3: 4, M6: 3 });
    expect(doc('CE 95 030 00 03').items).toHaveLength(9);
    expect(freqCount(doc('CE 95 030 00 03'))).toEqual({ M3: 4, M6: 3, Y: 2 });
    expect(doc('CE 95 043 00 01').items).toHaveLength(18);
    expect(freqCount(doc('CE 95 043 00 01'))).toEqual({ M1: 10, M3: 5, M6: 1, Y: 2 }); // TLP §5.2 ✓
    expect(doc('CE 95 050 00 01').items).toHaveLength(10);
    expect(freqCount(doc('CE 95 050 00 01'))).toEqual({ M1: 6, M3: 1, M6: 3 });
    expect(doc('CE 95 050 00 03').items).toHaveLength(11); // source reality; TLP says 10
    expect(freqCount(doc('CE 95 050 00 03'))).toEqual({ M1: 4, M3: 2, M6: 5 });
    expect(doc('CE 95 055 00 01').items).toHaveLength(13);
    expect(freqCount(doc('CE 95 055 00 01'))).toEqual({ M1: 4, M3: 2, M6: 2, Y: 5 }); // TLP §5.3 ✓

    const total = [...docs.values()].reduce((sum, d) => sum + d.items.length, 0);
    expect(total).toBe(146); // NOT the TLP's 145 — the X-2 discrepancy is registered
    expect(
      doc('CE 95 050 00 03').ambiguities.some((a) => a.code === 'N-04' && /145/.test(a.message)),
    ).toBe(true);
  });

  it('I-TL-07: instructions are verbatim in the interior, edge-trimmed only (PR-TLP-04 read per the TLP §6.1 example, which itself trims edges; the API contract trims edges server-side)', () => {
    const asm = doc('CE 95 020 00 01');
    expect(asm.items[0].instruction).toBe(
      'Inspection and check safety interlock / emergency stop is functional',
    );
    expect(asm.items[3].instruction).toBe('Clean work holder linear scale');
    expect(asm.items[12].instruction).toBe(
      'Calibrate Workholder, BH Setup, Heater Block Setup, Bond Force',
    );
    // Interior quirks survive verbatim: doc 6's double space, doc 1's typo.
    expect(
      doc('CE 95 020 00 03').measurements.some((m) => m.description === 'Bond Force  DAC'),
    ).toBe(true);
    expect(
      doc('CE 95 010 00 01').items.some(
        (i) => i.instruction === 'Check Lower & Upper Jaw of tape Hold & Trasport',
      ),
    ).toBe(true);
    // Doc 9's curly apostrophe survives verbatim.
    expect(doc('CE 95 043 00 01').items[4].instruction).toBe(
      'Check if the optical sensors to control dancing rollers’ position work well',
    );
  });

  it('I-TL-08: standing content maps per TLP §4.1 — PPE with qualifiers, safety, procedure, remarks verbatim', () => {
    const asm = doc('CE 95 020 00 01');
    expect(asm.standingContent.ppe).toEqual([
      'Safety Shoes',
      'Ear Plugs (If required)',
      'Safety Glass (If Required)',
      'Hand Gloves (If Required)',
    ]);
    expect(asm.standingContent.safety).toBe(
      'Please switch off the main power and put the lock out/ tag on the power disconnect.  (if required)',
    );
    expect(asm.standingContent.procedure).toBe(
      'A thorough inspection on the machine must be done at least one month prior to the maintenance.\n' +
        'Prepare the list of parts which may have to be replaced. Source the parts before commencing the job',
    );
    expect(asm.standingContent.remarks).toBe(
      'For Y maintenance, 3M and 6M must be performed at the same time.',
    );
    expect(asm.standingContent.specialTools).toBe('________________________');
    expect(asm.standingContent.partsRequired).toEqual([]); // empty rows dropped, table kept

    // Doc 8 differs: "Note:" block instead of "Procedure:", PPE without
    // qualifiers, machine-downtime line, double space in remarks — verbatim.
    const premixer = doc('CE 95 030 00 03');
    expect(premixer.standingContent.ppe).toEqual([
      'Safety Shoes',
      'Ear Plugs (If required)',
      'Safety Glass',
      'Hand Gloves',
    ]);
    expect(premixer.standingContent.procedure).toBe(
      'To make sure have stock on hand for the list of parts that need to be replaced. Source the parts before commencing the job\n' +
        'To request machine down time before carrying out machine PM',
    );
    expect(premixer.standingContent.remarks).toBe(
      'For Y maintenance,  3M and 6M must be performed at the same time.',
    );

    // The cascade anomaly remarks (docs 7, 9, 10) are captured verbatim —
    // OI-08 territory, never normalised.
    expect(doc('CE 95 030 00 01').standingContent.remarks).toBe(
      'For 6M maintenance, 1M and 3M must be performed at the same time.',
    );
    expect(doc('CE 95 043 00 01').standingContent.remarks).toBe(
      'For 6M and Y maintenance, 1M and 6M must be performed at the same time.',
    );
    expect(doc('CE 95 050 00 01').standingContent.remarks).toBe(
      'For 6M and Y maintenance, 1M and 6M must be performed at the same time.',
    );
  });

  it('I-TL-09: doc 4 measurements — 20 rows in the source (TLP §5.1 says 21; discrepancy registered), sections inherited, B-04 corrected per client revision D, the -295 - -305 anomaly escalated as TEXT', () => {
    const asm = doc('CE 95 020 00 01');
    expect(asm.measurements).toHaveLength(20);
    expect(asm.ambiguities.some((a) => a.code === 'N-05' && /21/.test(a.message))).toBe(true);

    // Section inheritance: rows 54-55 belong to " Workholder Calibration".
    expect(asm.measurements[0].section).toBe('Workholder Calibration');
    expect(asm.measurements[1].section).toBe('Workholder Calibration');
    expect(asm.measurements[1].description).toBe('Vacuum Check with WCTP + LF');

    // B-04 — the ONLY client-dispositioned correction (slice brief §0:
    // corrected to 95–105 g by client revision D; never load the inverted
    // range).
    const b04 = asm.measurements.find((m) =>
      m.description.includes('Bond Force Verification Input Force 100g'),
    );
    expect(b04).toBeDefined();
    expect(b04!.specType).toBe('RANGE');
    expect(b04!.lowerLimit).toBe(95);
    expect(b04!.upperLimit).toBe(105);
    expect(b04!.specDisplay).toBe('95 - 105 g');
    expect(b04!.sourceSpecDisplay).toBe('95 - 28 g'); // the defective source text, trimmed, preserved
    expect(b04!.correction).toContain('B-04');

    // The OTHER high-to-low printed range (' -295 - -305', no unit) has NO
    // client disposition — loaded as TEXT verbatim and escalated (N-01),
    // per PR-TLP-05 (never guess) with the B-04 option (b) mechanism.
    const trackTop = asm.measurements.find((m) =>
      m.description.includes('Track Height Calibration, Top Plate'),
    );
    expect(trackTop!.specType).toBe('TEXT');
    expect(trackTop!.specDisplay).toBe('-295 - -305');
    expect(trackTop!.lowerLimit).toBeNull();
    expect(trackTop!.upperLimit).toBeNull();
    expect(asm.ambiguities.some((a) => a.code === 'N-01')).toBe(true);

    // Representative parsed specs across the §4.2 forms:
    const byDesc = (s: string) => asm.measurements.find((m) => m.description.includes(s))!;
    expect(byDesc('Heater Block Flatness Check')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: null,
      upperLimit: 20,
      unit: 'um',
      specDisplay: 'Hmin ≤ 20 um',
    });
    expect(byDesc('Vacuum Check')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: -600,
      upperLimit: null,
      unit: 'mmHg',
    });
    expect(byDesc('Bond Head Position Flat Level')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: -36500,
      upperLimit: -30500,
      unit: 'um',
    });
    expect(byDesc('Heater Block Temperature Measurement')).toMatchObject({
      specType: 'TOLERANCE',
      nominal: 150,
      tolerance: 5,
      lowerLimit: 145,
      upperLimit: 155,
      unit: '°C',
    });
    expect(byDesc('Track Height Calibration, Rear Track')).toMatchObject({
      specType: 'TOLERANCE',
      nominal: 0,
      tolerance: 30,
      lowerLimit: -30,
      upperLimit: 30,
      unit: 'um',
    });
    expect(byDesc('Transducer Calibration US2')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: 100,
      upperLimit: 180,
      unit: '%',
    });
    expect(byDesc('Tranducer Impedance')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: 5,
      upperLimit: 24,
      unit: 'ohm',
    });
  });

  it('I-TL-10: doc 6 (KNS) measurements — 24 spec lines including continuation rows, Pass/Fail judgements, and unparseable specs escalated as TEXT', () => {
    const kns = doc('CE 95 020 00 03');
    expect(kns.measurements).toHaveLength(24);

    // Continuation rows: Bond head Flatness has TWO spec lines.
    const flatness = kns.measurements.filter((m) => m.description.includes('Bond head Flatness'));
    expect(flatness).toHaveLength(2);
    expect(flatness[0].specDisplay).toBe('Side to Side <30 ENC');
    expect(flatness[0]).toMatchObject({ specType: 'RANGE', lowerLimit: null, upperLimit: 30 });
    expect(flatness[1].specDisplay).toBe('Front to Back <10 ENC');

    // PRS Calibration has FOUR spec lines (XX, YY, XY, XY — the duplicated
    // XY label is registered, evident intent YX).
    const prs = kns.measurements.filter((m) => m.description.includes('PRS Calibration'));
    expect(prs).toHaveLength(4);
    expect(prs[0]).toMatchObject({ specType: 'RANGE', lowerLimit: 0.1384, upperLimit: 0.153 });
    expect(new Set(prs.map((m) => m.stableKey)).size).toBe(4); // keys deduplicated
    expect(kns.ambiguities.some((a) => a.code === 'N-03')).toBe(true);

    // Bare Pass / Fail judgements (TLP §5.5).
    for (const name of ['Clamp Calibration', 'Gripper Force', 'Ejector Force']) {
      const m = kns.measurements.find((x) => x.description.includes(name))!;
      expect(m.specType).toBe('PASS_FAIL');
    }

    // Qualitative / single-value / defective specs → TEXT, escalated.
    expect(kns.measurements.find((m) => m.description.includes('Rail Height'))!.specType).toBe(
      'TEXT',
    ); // "Optimal"
    expect(kns.measurements.find((m) => m.description.includes('Rail Width'))!.specType).toBe(
      'TEXT',
    ); // "35mm Plate"
    expect(
      kns.measurements.find((m) => m.description.includes('Maximum Window Clamp'))!.specType,
    ).toBe('TEXT'); // "75 mils"
    const dac = kns.measurements.find((m) => m.description.includes('Bond Force  DAC'))!;
    expect(dac.specType).toBe('TEXT'); // "6.4 - 7,1 counts/gram" — comma decimal, N-02
    expect(dac.specDisplay).toBe('6.4 - 7,1 counts/gram');
    expect(kns.ambiguities.some((a) => a.code === 'N-02')).toBe(true);

    // Parseable tolerance with qualifier text.
    expect(
      kns.measurements.find((m) => m.description.includes('Resonant Frequency'))!,
    ).toMatchObject({ specType: 'TOLERANCE', nominal: 122, tolerance: 5 });
    // "to"-separated labelled range.
    expect(kns.measurements.find((m) => m.specDisplay.includes('XX ='))!).toMatchObject({
      specType: 'RANGE',
      lowerLimit: 0.1384,
      upperLimit: 0.153,
      unit: 'mils',
    });
  });

  it('I-TL-11: doc 5 (Besi Esec) dual-variant USL/LSL table — two measurements per row (19 rows → 38), min/max normalised, label-swap registered (N-06); doc 8 LCL/UCL → RANGE 290..310 mbar; doc 1 → single PASS_FAIL', () => {
    const esec = doc('CE 95 020 00 02');
    expect(esec.measurements).toHaveLength(38);
    const temp3100 = esec.measurements.find(
      (m) =>
        m.description.includes('Temperature Measurement 150°C') &&
        m.description.includes('ESEC 3100'),
    )!;
    // Source prints USL=145 / LSL=155 — labels inconsistent; loaded as
    // lower=min, upper=max (both endpoints preserved), swap registered.
    expect(temp3100).toMatchObject({ specType: 'RANGE', lowerLimit: 145, upperLimit: 155 });
    expect(temp3100.specDisplay).toBe('USL 145 / LSL 155');
    expect(esec.ambiguities.some((a) => a.code === 'N-06')).toBe(true);
    const focus3200 = esec.measurements.find(
      (m) => m.description.includes('upper focus limit') && m.description.includes('ESEC 3200'),
    )!;
    expect(focus3200).toMatchObject({ specType: 'RANGE', lowerLimit: 3.6, upperLimit: 4.6 });

    const premixer = doc('CE 95 030 00 03');
    expect(premixer.measurements).toHaveLength(1);
    expect(premixer.measurements[0]).toMatchObject({
      specType: 'RANGE',
      lowerLimit: 290,
      upperLimit: 310,
      unit: 'mbar',
      section: 'Resin tank sealing test',
      description: 'Vaccum reading after one hour setting 300mbar',
    });

    const besiDa = doc('CE 95 010 00 01');
    expect(besiDa.measurements).toHaveLength(1);
    expect(besiDa.measurements[0].specType).toBe('PASS_FAIL');
    expect(besiDa.measurements[0].description).toContain('Recipe name');
  });

  it('I-TL-12: doc 11 (OS Loading) — the unnumbered instruction row and the numbering skip are captured; items renumbered positionally with printed numbers preserved', () => {
    const os = doc('CE 95 050 00 03');
    expect(os.items).toHaveLength(11);
    expect(os.items.map((i) => i.itemNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(os.items.map((i) => i.printedNo)).toEqual([
      '1',
      '2',
      '3',
      null, // the row with no printed number — "Check all machine switches condition"
      '4',
      '5',
      '6',
      '7',
      '8',
      '10', // printed numbering also skips 9
      '11',
    ]);
    expect(os.items[3].instruction).toBe('Check all machine switches condition');
    expect(os.ambiguities.some((a) => a.code === 'N-04')).toBe(true);
  });

  it('I-TL-13: revision histories parsed verbatim with Excel serials converted; B-02 gap and out-of-order dates (B-03 on doc 12, and the same anomaly on docs 5/7/10) registered', () => {
    const besiDa = doc('CE 95 010 00 01');
    expect(besiDa.revisionHistory.map((r) => r.code)).toEqual(['0', 'A', 'C', 'D', 'E']);
    expect(besiDa.revisionHistory[0].date).toBe('2021-03-22'); // serial 44277
    expect(besiDa.ambiguities.some((a) => a.code === 'B-02')).toBe(true);

    const asm = doc('CE 95 020 00 01');
    expect(asm.revisionHistory).toEqual([
      {
        code: '0',
        date: '2021-03-24',
        details: 'New Release',
        revisedBy: 'Jess Lai Yoon Kiaw',
        approvedBy: 'Heng Cheng Kim',
      },
      {
        code: 'A',
        date: '2021-05-19',
        details:
          '1. Retitle to add ASM\r\n2. Updated PM frequency\r\n3. Updated to include calibration reading recording',
        revisedBy: 'Jess Lai Yoon Kiaw',
        approvedBy: 'Heng Cheng Kim',
      },
      {
        code: 'B',
        date: '2021-09-21',
        details:
          '1. Include temperature measurement recording \r\n2.  Include quaterly inspection for safety interlock / emergency stop',
        revisedBy: 'Jess Lai Yoon Kiaw',
        approvedBy: 'Heng Cheng Kim',
      },
      {
        code: 'C',
        date: '2024-03-20',
        details: 'Update intruction for Item 2 and 3',
        revisedBy: 'Sara',
        approvedBy: 'Suren',
      },
    ]);

    // Doc 5 keeps its trailing-space revision code 'B ' verbatim.
    expect(doc('CE 95 020 00 02').revisionHistory.map((r) => r.code)).toEqual([
      '0',
      'A',
      'B ',
      'C',
    ]);

    // Out-of-order revision dates: TLP §3 flags doc 12 only (B-03); the
    // same anomaly exists in docs 5, 7 and 10 and is registered for each.
    for (const n of ['CE 95 055 00 01', 'CE 95 020 00 02', 'CE 95 030 00 01', 'CE 95 050 00 01']) {
      expect(doc(n).ambiguities.some((a) => a.code === 'B-03')).toBe(true);
    }
    // In-order histories carry no B-03 entry.
    expect(doc('CE 95 020 00 01').ambiguities.some((a) => a.code === 'B-03')).toBe(false);
  });

  it('I-TL-14: stable keys follow PR-TLP-06 (document number + slug), unique within each document', () => {
    const asm = doc('CE 95 020 00 01');
    const temp = asm.measurements.find((m) =>
      m.description.includes('Heater Block Temperature Measurement'),
    )!;
    expect(temp.stableKey).toBe('CE-95-020-00-01::heater-block-temperature-measurement');
    expect(asm.items[0].stableKey).toMatch(/^CE-95-020-00-01::/);
    for (const d of docs.values()) {
      const keys = [...d.items.map((i) => i.stableKey), ...d.measurements.map((m) => m.stableKey)];
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('I-TL-15: loaded revision codes — doc 4 loads as client revision D (B-04 correction); every other document loads at its printed revision', () => {
    expect(doc('CE 95 020 00 01').printedRevision).toBe('C');
    expect(doc('CE 95 020 00 01').loadRevision).toBe('D');
    expect(doc('CE 95 010 00 01').printedRevision).toBe('E');
    expect(doc('CE 95 010 00 01').loadRevision).toBe('E');
    expect(doc('CE 95 012 00 01').loadRevision).toBe('0');
    // B-01: doc 1's Revision History header holds #REF! errors and doc 9's
    // holds #VALUE! — headers re-entered from the (intact) title block, and
    // the error registered.
    expect(doc('CE 95 010 00 01').ambiguities.some((a) => a.code === 'B-01')).toBe(true);
    expect(doc('CE 95 043 00 01').ambiguities.some((a) => a.code === 'B-01')).toBe(true);
  });

  it('I-TL-16: stray out-of-grid cells (doc 5 Q38, doc 6 AA53) are surfaced as ambiguities, not silently dropped and not loaded', () => {
    expect(
      doc('CE 95 020 00 02').ambiguities.some((a) => a.code === 'N-07' && a.cells.includes('Q38')),
    ).toBe(true);
    expect(
      doc('CE 95 020 00 03').ambiguities.some((a) => a.code === 'N-07' && a.cells.includes('AA53')),
    ).toBe(true);
  });
});

describe('specification parser (TLP §4.2 forms)', () => {
  it('parses every printed form from the §4.2 table', () => {
    expect(parseSpec('5 – 24 ohm')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: 5,
      upperLimit: 24,
      unit: 'ohm',
    });
    expect(parseSpec('150°C ± 5°C')).toMatchObject({
      specType: 'TOLERANCE',
      nominal: 150,
      tolerance: 5,
      lowerLimit: 145,
      upperLimit: 155,
      unit: '°C',
    });
    expect(parseSpec('-36500 ~ -30500 um')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: -36500,
      upperLimit: -30500,
      unit: 'um',
    });
    expect(parseSpec('± 30 um')).toMatchObject({
      specType: 'TOLERANCE',
      nominal: 0,
      tolerance: 30,
      lowerLimit: -30,
      upperLimit: 30,
      unit: 'um',
    });
    expect(parseSpec('Hmin ≤ 20 um')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: null,
      upperLimit: 20,
      unit: 'um',
    });
    expect(parseSpec('>-600 mmHg')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: -600,
      upperLimit: null,
      unit: 'mmHg',
    });
    expect(parseSpec('Pass / Fail')).toMatchObject({ specType: 'PASS_FAIL' });
    expect(parseSpec('100 – 180 %')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: 100,
      upperLimit: 180,
      unit: '%',
    });
  });

  it('handles the real-file variants beyond the §4.2 table', () => {
    expect(parseSpec('0.19 – 0.21 μm/encoder')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: 0.19,
      upperLimit: 0.21,
      unit: 'μm/encoder',
    });
    expect(parseSpec('-0.50 ~ 0.5 mm')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: -0.5,
      upperLimit: 0.5,
      unit: 'mm',
    });
    expect(parseSpec('XX = +0.13840 to + 0.15300 mils')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: 0.1384,
      upperLimit: 0.153,
      unit: 'mils',
    });
    expect(parseSpec('122 ± 5KHz (High Freq)')).toMatchObject({
      specType: 'TOLERANCE',
      nominal: 122,
      tolerance: 5,
      lowerLimit: 117,
      upperLimit: 127,
    });
    expect(parseSpec('93 - 107%')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: 93,
      upperLimit: 107,
      unit: '%',
    });
    expect(parseSpec('Side to Side <30 ENC')).toMatchObject({
      specType: 'RANGE',
      lowerLimit: null,
      upperLimit: 30,
      unit: 'ENC',
    });
    expect(parseSpec('30 ± 2 psi')).toMatchObject({
      specType: 'TOLERANCE',
      nominal: 30,
      tolerance: 2,
      unit: 'psi',
    });
  });

  it('NEVER guesses: inverted, comma-decimal, single-value and qualitative specs come back unparsed (TEXT) with a reason — PR-TLP-05', () => {
    expect(parseSpec('95 - 28 g').specType).toBe('TEXT'); // B-04 raw (correction applied elsewhere, by explicit client decision)
    expect(parseSpec('-295 - -305').specType).toBe('TEXT'); // high-to-low
    expect(parseSpec('6.4 - 7,1 counts/gram').specType).toBe('TEXT'); // comma decimal
    expect(parseSpec('75 mils').specType).toBe('TEXT');
    expect(parseSpec('35mm Plate').specType).toBe('TEXT');
    expect(parseSpec('Optimal').specType).toBe('TEXT');
    for (const raw of ['95 - 28 g', '-295 - -305', '6.4 - 7,1 counts/gram', 'Optimal']) {
      expect(parseSpec(raw).unparsedReason).toBeTruthy();
    }
  });
});
