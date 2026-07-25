import { attachmentRejectedProblem } from '../common/domain-problems';
import { sniffImageContentType } from './magic-byte';

/**
 * SAMUEL'S CONFIRMED DECISIONS (slice-7-brief.md): the verify action accepts
 * a drawn signature as a base64 PNG data-URL in its request body
 * (`VerifyJobRequest.drawnSignature`, `shared/src/job.ts`). This decodes and
 * validates it — magic-byte content sniff, REUSING `magic-byte.ts`'s
 * `sniffImageContentType` (the same S-30 mechanism `AttachmentsService`
 * uses, per the brief's explicit instruction), restricted to PNG only (a
 * signature-pad capture is always a PNG, never a JPEG/WEBP photo) — and
 * size-bounded, before the caller encrypts + stores it.
 */

const DATA_URL_PREFIX = /^data:image\/png(?:;charset=[^;,]+)?;base64,/i;

/** `DRAWN_SIGNATURE_MAX_BYTES` — a stylus/mouse signature-pad PNG is tiny; 2 MB is generous headroom. */
export const DRAWN_SIGNATURE_MAX_BYTES = 2_097_152;

/**
 * Decodes `drawnSignature` (bare base64 or a `data:image/png;base64,...`
 * data-URL) and validates it is a genuine PNG by magic bytes, never trusting
 * the data-URL's declared MIME type. Throws `422 /errors/attachment-rejected`
 * on any failure — reusing the SAME problem type `AttachmentsService` raises
 * for the identical class of failure (S-30-style content validation).
 */
export function decodeAndValidateDrawnSignature(
  drawnSignature: string,
  maxBytes: number = DRAWN_SIGNATURE_MAX_BYTES,
): Buffer {
  const base64Body = drawnSignature.replace(DATA_URL_PREFIX, '');

  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64Body, 'base64');
  } catch {
    throw attachmentRejectedProblem('drawnSignature is not valid base64.');
  }

  if (buffer.length === 0) {
    throw attachmentRejectedProblem('drawnSignature is empty.');
  }
  if (buffer.length > maxBytes) {
    throw attachmentRejectedProblem(
      `drawnSignature exceeds the ${maxBytes}-byte limit (DRAWN_SIGNATURE_MAX_BYTES).`,
    );
  }
  // S-30-style magic-byte check — the ONLY thing that decides content
  // identity here, never the data-URL's declared `image/png` prefix.
  if (sniffImageContentType(buffer) !== 'image/png') {
    throw attachmentRejectedProblem(
      'drawnSignature content is not a recognised PNG image (magic-byte check failed).',
    );
  }

  return buffer;
}
