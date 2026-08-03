import { changedPrintedAssetFields } from './archived-asset-print-dependency';

/**
 * The rule that decides whether `PATCH /assets/{id}` may proceed when the
 * machine has archived records. `assets.spec.ts` proves the same rule
 * end-to-end; these pin the ALLOW branches cheaply.
 */
describe('changedPrintedAssetFields', () => {
  const current = { code: 'AW02' };

  it('reports the machine code when it changes', () => {
    expect(changedPrintedAssetFields(current, { code: 'AW03' })).toEqual([
      { pointer: '/code', subject: 'the machine code', before: 'AW02', after: 'AW03' },
    ]);
  });

  it('ignores fields the caller did not send', () => {
    expect(changedPrintedAssetFields(current, {})).toEqual([]);
  });

  it('ignores a no-op re-send of the same value', () => {
    expect(changedPrintedAssetFields(current, { code: 'AW02' })).toEqual([]);
  });

  it('never reports a field that does not reach a rendered artefact', () => {
    // MEASURED, not assumed: `pdf-html-template.ts` emits exactly one
    // asset-derived value, `esc(input.machineCode)`. `description` (like
    // `manufacturer`, `model`, `areaId`, `locationDetail`, `status` and
    // `active`) is never rendered and is absent from the export manifest, so
    // describing or re-siting a machine must never be blocked by an archived
    // record. None of them are part of `AssetPrintedFields`, so the guard
    // structurally cannot consider them — this asserts the shape stays so.
    const proposed = {
      description: 'Rewritten',
      manufacturer: 'ASM',
      model: 'X',
      active: false,
    } as Partial<{ code: string }>;
    expect(changedPrintedAssetFields(current, proposed)).toEqual([]);
  });
});
