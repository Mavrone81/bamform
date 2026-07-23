import type { Prisma } from '@prisma/client';

/**
 * Current `@types/node` (Node 22) made typed arrays generic over
 * `ArrayBufferLike`, so `Buffer` (from `crypto.createHash().digest()`,
 * `randomBytes()`, etc.) defaults to `Buffer<ArrayBufferLike>` — wider than
 * Prisma's `Bytes` scalar, which resolves to `ReturnType<Uint8Array['slice']>`
 * i.e. `Uint8Array<ArrayBuffer>`. The bytes are identical; only the generic
 * parameter differs. This is the single, documented cast point for writing
 * a Node `Buffer` into a Prisma `Bytes` column (`token_hash`, `email_bidx`,
 * the audit hash-chain placeholder).
 */
export function toBytes(buffer: Buffer): Prisma.Bytes {
  return buffer as unknown as Prisma.Bytes;
}
