import { describe, expect, it } from 'vitest';
// THE REAL SCHEMA, not a regex over its source text and not a re-typed
// magic number. Mirrors `web/e2e/support/fake-server.ts`'s own rule (see its
// header, slice 28 review M-2) for why the import reaches into `shared/src`
// directly rather than `@bamform/shared`: `web` does not depend on the
// published package, and `shared/dist` is never built by the unit-test job.
// `zod` is hoisted to the repo root `node_modules`, so this resolves without
// touching `web/package.json` or the lockfile.
//
// Review MINOR (round 2): this import crosses `web/tsconfig.json`'s
// `rootDir: "src"` boundary, which `tsc --noEmit` on that project refuses.
// Rather than reach for `/// <reference types="node" />` to paper over a
// DIFFERENT problem (that reference is program-global and would silently
// let `process`/`Buffer` typecheck as though this were Node code, disarming
// the fence that catches a browser-source file calling a Node global that
// does not exist at runtime) this file is named so `web/tsconfig.json` can
// `exclude` it by name — see that file. Nothing else imports this file, so
// TypeScript never re-admits it via the import graph. Vitest does not read
// `tsconfig.json`'s `include`/`exclude` at all; it discovers this file the
// same way it discovers every other `src/**/*.test.ts`
// (`vitest.config.ts`), so it still runs in `npm run test:unit`.
import { scheduleAdjustRequestSchema } from '../../../shared/src/schedule';
import { MIN_REASON } from './MachineSchedule';

function parses(adjustedReasonLength: number): boolean {
  return scheduleAdjustRequestSchema.safeParse({
    frequency: 'M1',
    nextDueOn: '2028-01-01',
    adjustedReason: 'x'.repeat(adjustedReasonLength),
  }).success;
}

describe('MachineSchedule.MIN_REASON vs. the real scheduleAdjustRequestSchema', () => {
  it('is exactly the schema’s floor — one character short fails, exactly MIN_REASON succeeds', () => {
    expect(parses(MIN_REASON - 1)).toBe(false);
    expect(parses(MIN_REASON)).toBe(true);
  });
});
