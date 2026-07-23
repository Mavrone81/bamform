import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Unique to the repository root — used to anchor the dev/test fallback path. */
const REPO_ROOT_MARKER = 'docker-compose.yml';

/**
 * Walks up from `startDir` looking for the repository root marker. Robust to
 * whether this module runs from `api/src` (ts-jest/ts-node) or `api/dist/src`
 * (compiled), unlike a hardcoded relative `../../..`.
 */
export function findRepoRoot(startDir: string = __dirname): string {
  let dir = startDir;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, REPO_ROOT_MARKER))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`Could not locate repository root (looked for ${REPO_ROOT_MARKER} above ${startDir})`);
}

/**
 * Loads secret key material exclusively from file mounts — never from an
 * environment variable (BUILD_HANDOFF non-negotiable #9; PR-SEC-15/16: env
 * vars leak via /proc, `docker inspect` and crash dumps).
 *
 * Production: `/run/secrets/<dockerSecretName>`, matching the Docker secret
 * names declared in `docker-compose.yml`.
 *
 * Local dev/test: falls back to the git-ignored `secrets/` directory at the
 * repository root (SECURITY_ARCHITECTURE.md deployment runbook generates the
 * same files there with `openssl`; `scripts/dev/generate-dev-secrets.sh`
 * mirrors that for local development and CI).
 */
export class SecretFileLoader {
  load(dockerSecretName: string, devFileName: string = dockerSecretName): Buffer {
    const dockerPath = join('/run/secrets', dockerSecretName);
    if (existsSync(dockerPath)) {
      return readFileSync(dockerPath);
    }

    const devPath = join(findRepoRoot(), 'secrets', devFileName);
    if (existsSync(devPath)) {
      return readFileSync(devPath);
    }

    throw new Error(
      `Secret "${dockerSecretName}" not found at ${dockerPath} or ${devPath}. ` +
        'Run scripts/dev/generate-dev-secrets.sh for local dev/test.',
    );
  }
}
