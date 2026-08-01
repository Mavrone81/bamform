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
