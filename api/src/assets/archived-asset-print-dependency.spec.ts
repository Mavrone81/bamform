import { changedPrintedAssetFields } from './archived-asset-print-dependency';

/**
 * The rule that decides whether `PATCH /assets/{id}` may proceed when the
 * machine has archived records. `assets.spec.ts` proves the same rule
 * end-to-end; these pin the ALLOW branches cheaply.
 */
describe('changedPrintedAssetFields', () => {
  const current = { code: 'AW02', description: 'ASM wire bonder' };

  it('reports the machine code when it changes', () => {
    const changed = changedPrintedAssetFields(current, { code: 'AW03' });
    expect(changed).toEqual([
      { pointer: '/code', subject: 'the machine code', before: 'AW02', after: 'AW03' },
    ]);
  });

  it('reports the description when it changes', () => {
    const changed = changedPrintedAssetFields(current, { description: 'ASM wire bonder mk2' });
    expect(changed.map((f) => f.pointer)).toEqual(['/description']);
  });

  it('reports both when both change', () => {
    const changed = changedPrintedAssetFields(current, { code: 'AW03', description: 'new' });
    expect(changed.map((f) => f.pointer)).toEqual(['/code', '/description']);
  });

  it('ignores fields the caller did not send', () => {
    expect(changedPrintedAssetFields(current, {})).toEqual([]);
  });

  it('ignores a no-op re-send of the same values', () => {
    expect(
      changedPrintedAssetFields(current, { code: 'AW02', description: 'ASM wire bonder' }),
    ).toEqual([]);
  });

  it('never reports a field that does not print on the record', () => {
    // `manufacturer`, `model`, `areaId`, `locationDetail`, `status` and
    // `active` are absent from the PDF assembly entirely — re-siting or
    // retiring a machine must never be blocked by an archived record. They are
    // not part of `AssetPrintedFields`, so they cannot even be passed here;
    // this asserts the shape stays that way.
    const proposed = { manufacturer: 'ASM', model: 'X', active: false } as Partial<{
      code: string;
      description: string | null;
    }>;
    expect(changedPrintedAssetFields(current, proposed)).toEqual([]);
  });

  it('renders a cleared description as (blank), not as empty quotes', () => {
    const changed = changedPrintedAssetFields(current, { description: null });
    expect(changed[0]).toMatchObject({ before: 'ASM wire bonder', after: '(blank)' });
  });

  it('treats a previously-blank description as (blank) on the before side', () => {
    const changed = changedPrintedAssetFields(
      { code: 'AW02', description: null },
      { description: 'now described' },
    );
    expect(changed[0]).toMatchObject({ before: '(blank)', after: 'now described' });
  });
});
