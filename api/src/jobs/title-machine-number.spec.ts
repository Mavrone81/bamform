import { assetDocumentUpdateSchema, titleMachineNumberInputSchema } from '@bamform/shared';

/**
 * Slice 31-TITLEBLANK — the request schema for the technician's entry into
 * the blank in a form's title.
 *
 * The bounds are not arbitrary: they are the SAME bounds the admin-set
 * `asset_document.machine_number` has carried since slice 27, because it is
 * the same blank on the same form filled by a different person. The last test
 * here pins that equality directly against the real sibling schema, so a
 * future change to one that is not made to the other fails rather than
 * silently letting the technician's box accept something the admin's box
 * would refuse (or vice versa).
 */
const parse = (value: unknown) => titleMachineNumberInputSchema.safeParse(value);

describe('titleMachineNumberInputSchema', () => {
  it('accepts a plain form number and trims surrounding whitespace', () => {
    const result = parse({ titleMachineNumber: '  01  ' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.titleMachineNumber).toBe('01');
  });

  it('accepts an explicit null — that is how a mistyped value is CLEARED', () => {
    const result = parse({ titleMachineNumber: null });
    expect(result.success).toBe(true);
    expect(result.success && result.data.titleMachineNumber).toBeNull();
  });

  it.each(['', '   ', '\t'])(
    'rejects the empty/whitespace-only value %j — nothing zero-width reaches a controlled title',
    (value) => {
      expect(parse({ titleMachineNumber: value }).success).toBe(false);
    },
  );

  it('rejects an ABSENT field — the caller must say whether it means a value or a clear', () => {
    expect(parse({}).success).toBe(false);
  });

  it('accepts exactly 50 characters and rejects 51', () => {
    expect(parse({ titleMachineNumber: 'x'.repeat(50) }).success).toBe(true);
    expect(parse({ titleMachineNumber: 'x'.repeat(51) }).success).toBe(false);
  });

  it('accepts the shapes the real templates need (AVS 35-____, IMOS 0__, the bare ______)', () => {
    for (const value of ['01', '35-01', 'IMOS 01', 'AVS35-01']) {
      expect(parse({ titleMachineNumber: value }).success).toBe(true);
    }
  });

  it('has the SAME bounds as the admin-set asset_document.machineNumber it overrides', () => {
    const cases = ['', ' ', 'x'.repeat(50), 'x'.repeat(51), '01', '  01  '];
    for (const value of cases) {
      const mine = parse({ titleMachineNumber: value });
      const admin = assetDocumentUpdateSchema.safeParse({ machineNumber: value });
      expect([value, mine.success]).toEqual([value, admin.success]);
      if (mine.success && admin.success) {
        expect(mine.data.titleMachineNumber).toBe(admin.data.machineNumber);
      }
    }
  });
});
