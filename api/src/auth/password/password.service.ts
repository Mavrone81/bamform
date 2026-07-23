import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';

/**
 * Argon2id password hashing — SECURITY_ARCHITECTURE.md §5.1/§8:
 * m=65536 KiB, t=3, p=4, 32-byte output, 16-byte salt (argon2's default).
 * Parameters come from ARGON2_MEMORY_KIB/ARGON2_ITERATIONS/ARGON2_PARALLELISM
 * (.env.example) rather than being chosen independently in code, so a
 * documented re-benchmark on the target host (.env.example comment) actually
 * takes effect.
 */
@Injectable()
export class PasswordService {
  constructor(private readonly config: ConfigService) {}

  // node-argon2's shipped .d.cts types `HashOptions.type` as the string union
  // 'argon2d' | 'argon2i' | 'argon2id', but the native binding underneath
  // actually indexes on the *numeric* enum (argon2.argon2id === 2) — passing
  // the string looks up `names['argon2id']` (undefined) instead of
  // `names[2]`. The numeric constant is what the library's own README uses
  // and it round-trips correctly (verified: hash() output above is tagged
  // `$argon2id$...`). Cast through `unknown` to bridge the mismatched .d.ts.
  private get options(): argon2.HashOptions {
    return {
      type: argon2.argon2id,
      memoryCost: Number(this.config.get('ARGON2_MEMORY_KIB') ?? 65536),
      timeCost: Number(this.config.get('ARGON2_ITERATIONS') ?? 3),
      parallelism: Number(this.config.get('ARGON2_PARALLELISM') ?? 4),
      hashLength: 32,
    } as unknown as argon2.HashOptions;
  }

  hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, this.options) as Promise<string>;
  }

  /**
   * Never throws — a malformed/foreign hash (or a corrupted row) verifies as
   * `false` rather than raising, so callers can always branch on a boolean
   * without a try/catch at every call site.
   */
  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext, this.options);
    } catch {
      return false;
    }
  }
}
