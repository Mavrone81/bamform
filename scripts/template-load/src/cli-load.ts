/**
 * Slice 13-TL — load CLI (TLP §6 steps 5/9): drive a running BamForm
 * instance from the committed intermediate YAML. See RUNBOOK.md in this
 * directory for the controller-supervised staging procedure.
 *
 * Environment (no secrets on the command line):
 *   BAMFORM_BASE_URL            e.g. https://form.bevorasg.com  (NO trailing slash)
 *   BAMFORM_AUTHOR_EMAIL        author account (roles DOC_CONTROLLER + ENGINEER)
 *   BAMFORM_AUTHOR_PASSWORD
 *   BAMFORM_APPROVER_EMAIL      approver account (role DOC_CONTROLLER, a DIFFERENT person — INV-03)
 *   BAMFORM_APPROVER_PASSWORD
 *
 * Flags:
 *   --sample-machines           also create provisional SAMPLE machines + materialise schedules
 *   --anchor=YYYY-MM-DD         schedule anchor date for sample machines (default: today UTC)
 *
 * Run:
 *   npx ts-node -P scripts/template-load/tsconfig.json scripts/template-load/src/cli-load.ts [flags]
 */
import { join } from 'node:path';
import { runLoad } from './loader';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name} (see file header).`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--sample-machines' && !a.startsWith('--anchor='));
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}`);
    process.exit(2);
  }
  const anchor = args.find((a) => a.startsWith('--anchor='))?.slice('--anchor='.length);
  if (anchor !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
    console.error('--anchor must be YYYY-MM-DD');
    process.exit(2);
  }

  const summary = await runLoad({
    baseUrl: requireEnv('BAMFORM_BASE_URL').replace(/\/+$/, ''),
    author: {
      email: requireEnv('BAMFORM_AUTHOR_EMAIL'),
      password: requireEnv('BAMFORM_AUTHOR_PASSWORD'),
    },
    approver: {
      email: requireEnv('BAMFORM_APPROVER_EMAIL'),
      password: requireEnv('BAMFORM_APPROVER_PASSWORD'),
    },
    yamlDir: join(__dirname, '..', 'yaml'),
    createSampleMachines: args.includes('--sample-machines'),
    scheduleAnchorDate: anchor,
    log: (line) => console.log(line),
  });

  console.log('');
  console.log(
    `DONE: ${summary.created} created, ${summary.resumed} resumed, ` +
      `${summary.updated} updated, ${summary.unchanged} unchanged.`,
  );
  for (const doc of summary.documents) {
    console.log(
      `  ${doc.documentNumber}: ${doc.action}` +
        (doc.sampleMachines.length
          ? ` — sample machines: ${doc.sampleMachines.map((m) => m.code).join(', ')}`
          : ''),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
