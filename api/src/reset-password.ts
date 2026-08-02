import 'reflect-metadata';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { AppModule } from './app.module';
import { RedactingLogger } from './common/logging/redacting-logger';
import { UsersService } from './users/users.service';

/**
 * `bamform-reset-password` entrypoint (`dist/reset-password.js`). Operator-run
 * recovery: sets an existing user's password from an interactive prompt, so a
 * system whose credentials have been lost can be got back into.
 *
 * WHY IT EXISTS. There is no other way in. `userUpdateSchema` carries no
 * password field, so an ADMIN cannot reset anyone else's password over the
 * API. `POST /auth/password` is self-service and needs a live session.
 * `bootstrap-admin` refuses the moment any user exists — by design, it is
 * one-time and fail-closed. `users.service.ts`'s own SYS-11 comment already
 * names the endgame: "recovery is psql surgery on the box". This is that
 * surgery performed through the app's own crypto, so the stored hash is a real
 * Argon2id hash and the change lands in the audit trail.
 *
 * WHAT PROTECTS IT. The same guards as `bootstrap-admin`: credentials come
 * ONLY from an interactive prompt (never argv, env or a file, so they cannot
 * leak into shell history, `docker inspect` or the deploy log), the new
 * password is typed with echo muted, and the command refuses to run without a
 * TTY. It grants no capability an attacker with a shell on the container
 * lacks — such an attacker can already read the secrets and talk to Postgres —
 * but it must never become reachable any other way.
 */
const passwordSchema = z.string().min(12, 'Password must be at least 12 characters.');

/** Prompt for a secret with terminal echo disabled (no history, no display). */
async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // Mute the output stream while the answer is typed.
  const muted = { muted: false };
  const realWrite = (stdout.write as unknown as (...a: unknown[]) => boolean).bind(stdout);
  (stdout as unknown as { write: (...a: unknown[]) => boolean }).write = ((
    chunk: unknown,
    ...rest: unknown[]
  ) => (muted.muted ? true : realWrite(chunk, ...rest))) as never;
  stdout.write(question);
  muted.muted = true;
  try {
    const answer = await rl.question('');
    return answer;
  } finally {
    muted.muted = false;
    (stdout as unknown as { write: unknown }).write = realWrite;
    stdout.write('\n');
    rl.close();
  }
}

/**
 * Parse the operator's choice from the printed list. Accepts a 1-based row
 * number only — NOT a raw id, so a mistyped uuid can never silently miss and
 * reset nothing, and the operator has to have looked at the list.
 */
export function parseSelection(raw: string, count: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  if (n < 1 || n > count) return null;
  return n - 1;
}

async function run(): Promise<void> {
  // Same reasoning as bootstrap-admin: `promptHidden` forces `terminal: true`,
  // which on a non-TTY stdin waits forever on keypress events a pipe never
  // emits. Fail fast before opening the Nest app context.
  if (!stdin.isTTY) {
    console.error(
      'Error: this command must be run interactively from a terminal (stdin is not a TTY).',
    );
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new RedactingLogger(),
  });
  try {
    const users = app.get(UsersService);
    const all = await users.listAllForOperatorRecovery();

    if (all.length === 0) {
      console.error('No users exist. Use `npm run bootstrap:admin` to create the first ADMIN.');
      process.exitCode = 1;
      return;
    }

    console.log('\nUsers on this system:\n');
    all.forEach((u, i) => {
      const roles = u.roles.length > 0 ? u.roles.join(', ') : '(no roles)';
      const state = u.active ? '' : ' [INACTIVE]';
      console.log(`  ${String(i + 1).padStart(2)}. ${u.email}${state}`);
      console.log(`      ${u.fullName} — ${roles}`);
    });

    const rl = createInterface({ input: stdin, output: stdout });
    const choice = await rl.question('\nReset which user? (number, or blank to cancel): ');
    rl.close();

    if (choice.trim() === '') {
      console.log('Cancelled. No password was changed.');
      return;
    }

    const index = parseSelection(choice, all.length);
    if (index === null) {
      console.error(`Error: enter a number between 1 and ${all.length}.`);
      process.exitCode = 1;
      return;
    }

    const target = all[index];
    const password = await promptHidden(`New password for ${target.email} (min 12, hidden): `);
    const confirm = await promptHidden('Confirm password: ');

    if (password !== confirm) {
      console.error('Error: passwords do not match. No password was changed.');
      process.exitCode = 1;
      return;
    }

    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      console.error('Error: ' + parsed.error.issues.map((i) => i.message).join(' '));
      process.exitCode = 1;
      return;
    }

    await users.resetPasswordAsOperator(target.id, parsed.data);
    console.log(`\nPassword reset for ${target.email}.`);
    console.log('Sign in with that address and the password you just set.');
  } catch (error) {
    console.error(`\nPassword reset failed: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

// Only self-invoke when run directly, not when imported by the spec that
// unit-tests `parseSelection` without launching Nest or opening a prompt.
if (require.main === module) {
  void run();
}
