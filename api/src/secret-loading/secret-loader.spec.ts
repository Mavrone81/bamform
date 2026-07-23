import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepoRoot, SecretFileLoader } from './secret-loader';

describe('findRepoRoot', () => {
  it('walks up from a nested directory to find the docker-compose.yml marker', () => {
    const fakeRepoRoot = mkdtempSync(join(tmpdir(), 'bamform-secret-loader-'));
    writeFileSync(join(fakeRepoRoot, 'docker-compose.yml'), '# fixture\n');
    const nested = join(fakeRepoRoot, 'api', 'src', 'nested');
    mkdirSync(nested, { recursive: true });

    try {
      expect(findRepoRoot(nested)).toBe(fakeRepoRoot);
    } finally {
      rmSync(fakeRepoRoot, { recursive: true, force: true });
    }
  });

  it('throws when no marker exists above the start directory', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'bamform-no-marker-'));
    try {
      expect(() => findRepoRoot(orphan)).toThrow(/Could not locate repository root/);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});

describe('SecretFileLoader', () => {
  // secrets/ is git-ignored (repo .gitignore) — safe to write real fixture
  // files into the real repo tree for the duration of this test and remove
  // them afterwards, so `load()` is exercised end-to-end (real
  // findRepoRoot() from this module's real __dirname) rather than via a
  // reimplementation of its logic.
  const repoRoot = findRepoRoot();
  const secretsDir = join(repoRoot, 'secrets');
  const fixtureName = `test-only-secret-${process.pid}`;
  const fixturePath = join(secretsDir, fixtureName);

  afterEach(() => {
    if (existsSync(fixturePath)) {
      rmSync(fixturePath);
    }
  });

  it('loads from the git-ignored secrets/ fallback when no Docker mount exists', () => {
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(fixturePath, 'dev-key-material');

    const loader = new SecretFileLoader();
    const result = loader.load(fixtureName);

    expect(result.toString('utf8')).toBe('dev-key-material');
  });

  it('throws a clear, actionable error when the secret exists nowhere', () => {
    const loader = new SecretFileLoader();
    expect(() => loader.load('definitely-does-not-exist')).toThrow(
      /Secret "definitely-does-not-exist" not found.*generate-dev-secrets\.sh/s,
    );
  });
});
