import { decodeIdentityField, encodeIdentityField } from './identity-codec';

describe('identity codec (temporary passthrough pending slice 3 field encryption)', () => {
  it('round-trips a UTF-8 string through encode/decode', () => {
    const encoded = encodeIdentityField('Jane Tan 陈');
    expect(encoded).toBeInstanceOf(Buffer);
    expect(decodeIdentityField(encoded)).toBe('Jane Tan 陈');
  });
});
