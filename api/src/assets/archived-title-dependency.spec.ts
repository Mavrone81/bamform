import {
  recordsBlockingMachineNumberChange,
  type ArchivedRecordTitle,
} from './archived-title-dependency';

/**
 * The rule that decides whether `PATCH /asset-documents/{id}` may change
 * `machineNumber`. Unit-tested here (Prisma-free by construction) so the four
 * ALLOW branches are pinned cheaply; `asset-documents.spec.ts` proves the same
 * rule end-to-end through the endpoint.
 */
describe('recordsBlockingMachineNumberChange', () => {
  const record = (over: Partial<ArchivedRecordTitle> = {}): ArchivedRecordTitle => ({
    jobNumber: 'JOB-0001',
    templateTitle: 'KNS Wire Bond Preventive Maintenance Record KW___',
    ownMachineNumber: null,
    ...over,
  });

  it('blocks a change an archived record would print differently', () => {
    const blocking = recordsBlockingMachineNumberChange([record()], '13', '21');
    expect(blocking.map((r) => r.jobNumber)).toEqual(['JOB-0001']);
  });

  it('blocks filling a blank an archived record printed empty', () => {
    // "…Record KW___" -> "…Record KW07" is just as much a rewrite of signed
    // evidence as changing one number to another.
    expect(recordsBlockingMachineNumberChange([record()], null, '07')).toHaveLength(1);
  });

  it('blocks clearing a value an archived record printed', () => {
    expect(recordsBlockingMachineNumberChange([record()], '13', null)).toHaveLength(1);
  });

  it('allows the change when no archived record exists at all', () => {
    // The document is NOT frozen by the mere existence of history elsewhere —
    // correcting a typo on a document nothing has been signed against yet is
    // ordinary, legitimate work.
    expect(recordsBlockingMachineNumberChange([], '13', '21')).toEqual([]);
  });

  it('allows the change when the title carries no fillable run', () => {
    // EP01/PM01 print the number already; `resolveTemplateTitle` has nothing
    // to substitute into, so neither value changes what the record prints.
    const fixed = record({ templateTitle: 'Preventive Maintenance Record EP01' });
    expect(recordsBlockingMachineNumberChange([fixed], '13', '21')).toEqual([]);
  });

  it('allows the change when the archived record captured its own number', () => {
    // Slice 31-TITLEBLANK precedence: the record prints `ownMachineNumber`, so
    // the document's value is not one of its sources.
    const own = record({ ownMachineNumber: '99' });
    expect(recordsBlockingMachineNumberChange([own], '13', '21')).toEqual([]);
  });

  it('allows a no-op re-send of the same value', () => {
    expect(recordsBlockingMachineNumberChange([record()], '13', '13')).toEqual([]);
  });

  it('reports every blocking record, and only the blocking ones', () => {
    const records = [
      record({ jobNumber: 'JOB-0001' }),
      record({ jobNumber: 'JOB-0002', ownMachineNumber: '99' }),
      record({ jobNumber: 'JOB-0003', templateTitle: 'Preventive Maintenance Record PM01' }),
      record({ jobNumber: 'JOB-0004' }),
    ];
    const blocking = recordsBlockingMachineNumberChange(records, '13', '21');
    expect(blocking.map((r) => r.jobNumber)).toEqual(['JOB-0001', 'JOB-0004']);
  });

  it('judges each record against its OWN revision title, not a shared one', () => {
    // A record bound to an older revision whose title had no blank is
    // unaffected even while a sibling on the current revision is blocked.
    const records = [
      record({ jobNumber: 'OLD-1', templateTitle: 'Preventive Maintenance Record EP01' }),
      record({ jobNumber: 'NEW-1', templateTitle: 'Preventive Maintenance Record ED____' }),
    ];
    expect(recordsBlockingMachineNumberChange(records, null, '05').map((r) => r.jobNumber)).toEqual(
      ['NEW-1'],
    );
  });
});
