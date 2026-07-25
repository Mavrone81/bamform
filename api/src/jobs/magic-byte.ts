import type { AttachmentContentType } from '@bamform/shared';

/**
 * SECURITY_ARCHITECTURE.md §10.1: "File upload | Magic-byte inspection, not
 * extension. Allowlist `image/jpeg`, `image/png`, `image/webp`." TEST_PLAN.md
 * S-30: a renamed executable as `.jpg` must be rejected by CONTENT
 * inspection, not by trusting the client's declared MIME type or the
 * filename extension — both of which `AttachmentsService` deliberately never
 * consults for this decision (PR-034).
 *
 * Deliberately dependency-free (no `file-type` npm package) — three fixed
 * byte signatures cover the entire allowlist, so a hand-rolled sniff avoids
 * adding a dependency whose own supply chain would then gate every photo
 * upload.
 */
export function sniffImageContentType(buffer: Buffer): AttachmentContentType | null {
  if (isJpeg(buffer)) return 'image/jpeg';
  if (isPng(buffer)) return 'image/png';
  if (isWebp(buffer)) return 'image/webp';
  return null;
}

/** JPEG/JFIF/EXIF all begin with the SOI marker FF D8 FF (ITU-T T.81 Annex B). */
function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/** PNG's fixed 8-byte signature (ISO/IEC 15948 §5.2). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buffer: Buffer): boolean {
  return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * WEBP is a RIFF container: bytes 0-3 "RIFF", bytes 4-7 a little-endian
 * chunk size (not validated here — irrelevant to format identity), bytes
 * 8-11 the four-character-code "WEBP".
 */
function isWebp(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}
