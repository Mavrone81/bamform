import { DRAWN_SIGNATURE_MAX_BYTES, decodeAndValidateDrawnSignature } from './drawn-signature';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function realPngBytes(paddingBytes = 50): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.alloc(paddingBytes, 0xcc)]);
}

function fakePngExecutableBytes(): Buffer {
  // "MZ" DOS header — same S-30 attack shape as magic-byte.spec.ts, renamed as a PNG here.
  return Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(30, 0x00)]);
}

describe("decodeAndValidateDrawnSignature (SAMUEL'S CONFIRMED DECISIONS, S-30-style magic-byte check)", () => {
  it('decodes a data-URL-prefixed PNG', () => {
    const dataUrl = `data:image/png;base64,${realPngBytes().toString('base64')}`;
    const decoded = decodeAndValidateDrawnSignature(dataUrl);
    expect(decoded.equals(realPngBytes())).toBe(true);
  });

  it('decodes bare base64 (no data-URL prefix)', () => {
    const bare = realPngBytes().toString('base64');
    const decoded = decodeAndValidateDrawnSignature(bare);
    expect(decoded.equals(realPngBytes())).toBe(true);
  });

  it('rejects a renamed executable disguised as a PNG data-URL (S-30-equivalent)', () => {
    const dataUrl = `data:image/png;base64,${fakePngExecutableBytes().toString('base64')}`;
    expect(() => decodeAndValidateDrawnSignature(dataUrl)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ type: '/errors/attachment-rejected' }),
      }),
    );
  });

  it('rejects an empty payload', () => {
    expect(() => decodeAndValidateDrawnSignature('data:image/png;base64,')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ type: '/errors/attachment-rejected' }),
      }),
    );
  });

  it('rejects a payload over the size cap', () => {
    const oversized = `data:image/png;base64,${realPngBytes(DRAWN_SIGNATURE_MAX_BYTES).toString('base64')}`;
    expect(() => decodeAndValidateDrawnSignature(oversized)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ type: '/errors/attachment-rejected' }),
      }),
    );
  });

  it('accepts a JPEG-shaped or WEBP-shaped payload as REJECTED — only PNG is a valid drawn signature', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const dataUrl = `data:image/png;base64,${jpeg.toString('base64')}`;
    expect(() => decodeAndValidateDrawnSignature(dataUrl)).toThrow();
  });
});
