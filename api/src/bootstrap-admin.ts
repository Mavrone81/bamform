import 'reflect-metadata';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { AppModule } from './app.module';
import { RedactingLogger } from './common/logging/redacting-logger';
import { UsersService } from './users/users.service';

/**
 * `bamform-bootstrap-admin` entrypoint (`dist/bootstrap-admin.js`). One-time,
 * operator-run: creates the first ADMIN on an empty system so the app can be
 * logged into. Design 2026-07-31. Reads credentials only from an interactive
 * prompt (never argv/env/logs); all logic and the fail-closed guard live in
 * `UsersService.bootstrapFirstAdmin`.
 *
 * Validates locally with the same policy `userCreateSchema` (`@bamform/shared`)
 * enforces on `fullName`/`email`/`password`, but as its own schema rather
 * than reusing that schema directly: `userCreateSchema` also requires
 * `roleCodes` (min 1) for the normal admin-creates-a-user flow, which does
 * not apply here — the first admin self-grants ADMIN, there is no actor to
 * choose a role.
 */
export const inputSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, 'Full name is required.')
    .max(200, 'Full name must be at most 200 characters.'),
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(12, 'Password must be at least 12 characters.'),
});

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

async function bootstrap(): Promise<void> {
  // `promptHidden` forces `terminal: true` on stdin so readline echoes each
  // keystroke through the (mutable) output write rather than the kernel tty
  // driver — that's what makes muting effective (verified with a pty
  // harness: keystrokes are invisible on the terminal and backspace-editing
  // still works). But forcing `terminal: true` on a non-TTY stdin (a pipe,
  // e.g. `echo ... | npm run bootstrap:admin`) makes readline wait on
  // keypress events that a plain pipe never emits, hanging forever instead
  // of failing. Fail fast instead, before even opening the Nest app context.
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
    const rl = createInterface({ input: stdin, output: stdout });
    const fullName = (await rl.question('Full name: ')).trim();
    const email = (await rl.question('Email: ')).trim();
    rl.close();
    const password = await promptHidden('Password (min 12 chars, hidden): ');
    const confirm = await promptHidden('Confirm password: ');

    if (password !== confirm) {
      console.error('Error: passwords do not match.');
      process.exitCode = 1;
      return;
    }

    const parsed = inputSchema.safeParse({ fullName, email, password });
    if (!parsed.success) {
      console.error('Error: ' + parsed.error.issues.map((i) => i.message).join(' '));
      process.exitCode = 1;
      return;
    }

    const users = app.get(UsersService);
    const created = await users.bootstrapFirstAdmin(parsed.data);
    console.log(`\nCreated ADMIN account: ${created.email} (id ${created.id}).`);
    console.log('You can now sign in with this account and create further users in the app.');
  } catch (error) {
    console.error(`\nBootstrap failed: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

// Only self-invoke when run directly (`node dist/bootstrap-admin.js`), not
// when imported — e.g. by `bootstrap-admin.spec.ts`, which imports
// `inputSchema` to unit-test the validation policy without launching Nest
// or opening any prompt.
if (require.main === module) {
  void bootstrap();
}
