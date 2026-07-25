/**
 * Minimal real byte signatures for the attachment upload tests — only the
 * magic bytes `sniffImageContentType` inspects need to be correct; the
 * "image" does not need to decode to a real picture.
 */

/** A real JPEG SOI+APP0/JFIF header, padded to a plausible small-photo size. */
export function realJpegBytes(paddingBytes = 200): Buffer {
  const header = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ]);
  return Buffer.concat([header, Buffer.alloc(paddingBytes, 0xaa), Buffer.from([0xff, 0xd9])]);
}

/** S-30 — a Windows PE executable's real magic bytes, renamed to `.jpg` by the caller. */
export function fakeJpegExecutableBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]), // "MZ" DOS header
    Buffer.alloc(64, 0x00),
  ]);
}

/** PNG's real 8-byte signature (ISO/IEC 15948 §5.2), padded — slice 7's drawn-signature fixtures. */
export function realPngBytes(paddingBytes = 100): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, Buffer.alloc(paddingBytes, 0xbb)]);
}

/** Base64 PNG data-URL, matching `VerifyJobRequest.drawnSignature`'s documented shape. */
export function realPngDataUrl(paddingBytes = 100): string {
  return `data:image/png;base64,${realPngBytes(paddingBytes).toString('base64')}`;
}
