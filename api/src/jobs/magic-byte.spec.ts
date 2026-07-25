import { sniffImageContentType } from './magic-byte';

/**
 * SECURITY_ARCHITECTURE.md §10.1 / TEST_PLAN.md S-30: "upload a renamed
 * executable as .jpg — rejected by magic-byte check". This is the pure
 * content-sniffing function `AttachmentsService` calls BEFORE trusting the
 * client-declared MIME type or filename extension — a `.jpg` with the wrong
 * bytes must be rejected regardless of what multer/the client claims.
 */
describe('sniffImageContentType (§10.1, S-30)', () => {
  it('recognises a real JPEG by its FF D8 FF magic bytes', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    expect(sniffImageContentType(jpeg)).toBe('image/jpeg');
  });

  it('recognises a real PNG by its 8-byte signature', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(sniffImageContentType(png)).toBe('image/png');
  });

  it('recognises a real WEBP by its RIFF....WEBP container', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]), // chunk size, irrelevant to sniffing
      Buffer.from('WEBP', 'ascii'),
    ]);
    expect(sniffImageContentType(webp)).toBe('image/webp');
  });

  it('S-30: rejects a Windows PE executable renamed to .jpg — MZ header, not FF D8 FF', () => {
    // "MZ" DOS header is how every Windows .exe/.dll begins, regardless of
    // what filename or declared Content-Type accompanies the upload.
    const fakeJpeg = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(sniffImageContentType(fakeJpeg)).toBeNull();
  });

  it('S-30: rejects an ELF executable renamed to .png', () => {
    const fakePng = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    expect(sniffImageContentType(fakePng)).toBeNull();
  });

  it('S-30: rejects a shell script renamed to .webp', () => {
    const fakeWebp = Buffer.from('#!/bin/sh\necho pwned\n', 'ascii');
    expect(sniffImageContentType(fakeWebp)).toBeNull();
  });

  it('rejects an empty buffer', () => {
    expect(sniffImageContentType(Buffer.alloc(0))).toBeNull();
  });

  it('rejects a truncated buffer shorter than any signature', () => {
    expect(sniffImageContentType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('rejects a RIFF container that is not WEBP (e.g. a renamed WAV)', () => {
    const fakeWebp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
    ]);
    expect(sniffImageContentType(fakeWebp)).toBeNull();
  });
});
