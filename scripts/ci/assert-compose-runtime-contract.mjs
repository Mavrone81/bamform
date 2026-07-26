#!/usr/bin/env node
/**
 * Tripwire for the "compose grant" class of production outage.
 *
 * This exact failure has now taken production down TWICE:
 *
 *   962e669 (slice 6) — `MinioModule` called
 *     `SecretFileLoader.load('minio_root_password')` at module-init, but
 *     docker-compose.yml granted that secret only to services that did not
 *     boot the module. `bamform-api` crash-looped, 502 at the edge.
 *
 *   30f0bbb (slice 12) — the same module was added to `WorkerModule`, and the
 *     same secret was again not granted. `bamform-worker` crash-looped for
 *     ~11 hours (674 restarts): no job scheduling, no notifications, no PDF
 *     rendering, no export ZIPs, no daily audit-chain verification.
 *
 * Both slices passed full code review and all 11 CI jobs. The review gate
 * reads code; it does not read compose grants, and no test boots a service
 * with only the secrets its compose entry actually provides. So the defect is
 * invisible until the container starts in production.
 *
 * Two assertions, both static (no Docker, no network):
 *
 *   A. For each entrypoint, every secret name passed as a string literal to
 *      `SecretFileLoader.load()` anywhere in that entrypoint's transitive
 *      import graph must be granted to the corresponding compose service.
 *
 *   B. Every `node dist/<name>.js` healthcheck command must have a
 *      corresponding `api/src/<name>.ts` source file. `bamform-api`'s
 *      healthcheck pointed at a `dist/healthcheck.js` that was never written,
 *      so the container reported `unhealthy` for its entire production life
 *      (found 2026-07-26) while serving traffic perfectly well.
 *
 * The compose parser below is deliberately strict: if it cannot find the
 * structure it expects it EXITS NON-ZERO rather than reporting success on an
 * empty parse. A tripwire that silently passes is worse than no tripwire.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const COMPOSE = resolve(REPO_ROOT, 'docker-compose.yml');

/** entrypoint source file → the compose service that runs it */
const ENTRYPOINTS = [
  { entry: 'api/src/main.ts', service: 'bamform-api' },
  { entry: 'api/src/worker.ts', service: 'bamform-worker' },
];

const failures = [];
const warnings = [];

// ---------------------------------------------------------------------------
// Minimal compose reader — top-level `services:`, two-space indented service
// keys, and the `secrets:` / `healthcheck:` blocks beneath them.
// ---------------------------------------------------------------------------
function parseCompose(text) {
  const lines = text.split('\n');
  const services = {};

  let inServices = false;
  let current = null;
  let block = null; // 'secrets' | 'healthcheck' | null

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;

    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    // Any other column-0 key ends the services section.
    if (/^[A-Za-z_]/.test(line)) {
      inServices = false;
      current = null;
      block = null;
      continue;
    }
    if (!inServices) continue;

    // "  bamform-api:" — a service name
    const svc = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (svc) {
      current = svc[1];
      services[current] = { secrets: [], healthcheck: null };
      block = null;
      continue;
    }
    if (!current) continue;

    // "    secrets:" / "    healthcheck:" — or the inline-list form
    const key = line.match(/^ {4}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (key) {
      const [, name, inline] = key;
      if (name === 'secrets') {
        block = 'secrets';
        // inline form: `secrets: [postgres_password, app_password]`
        const list = inline.match(/^\[(.*)\]$/);
        if (list) {
          services[current].secrets.push(
            ...list[1]
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          );
          block = null;
        }
      } else if (name === 'healthcheck') {
        block = 'healthcheck';
      } else {
        block = null;
      }
      continue;
    }

    if (block === 'secrets') {
      const item = line.match(/^ {6}- ([A-Za-z0-9_-]+)\s*$/);
      if (item) services[current].secrets.push(item[1]);
      // `- source: x` long form would need handling if ever adopted
      else if (/^ {6}- source:/.test(line)) {
        failures.push(
          `compose: long-form secret grant under "${current}" is not understood by ` +
            `this checker — extend scripts/ci/assert-compose-runtime-contract.mjs`,
        );
      }
      continue;
    }

    if (block === 'healthcheck') {
      const test = line.match(/^ {6}test:\s*(.+)$/);
      if (test) services[current].healthcheck = test[1];
      continue;
    }
  }

  return services;
}

// ---------------------------------------------------------------------------
// Transitive relative-import walk from an entrypoint.
// ---------------------------------------------------------------------------
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // package import — out of scope
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, 'index.ts'),
    // emitted-JS specifiers ("./x.js") that resolve to a .ts source
    base.replace(/\.js$/, '.ts'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function walk(entryAbs) {
  const seen = new Set();
  const queue = [entryAbs];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const specs = [
      ...src.matchAll(/^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*export\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);

    for (const spec of specs) {
      const next = resolveImport(file, spec);
      if (next) queue.push(next);
    }
  }
  return seen;
}

function secretsLoadedIn(files) {
  const found = new Map(); // secret name → source file
  for (const file of files) {
    if (/\.spec\.ts$/.test(file)) continue; // tests are not the runtime graph
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/\.load\(\s*(['"])([A-Za-z0-9_]+)\1\s*\)/g)) {
      if (!found.has(m[2])) found.set(m[2], relative(REPO_ROOT, file));
    }
    // A non-literal argument cannot be checked statically — surface it so the
    // hole is visible rather than silently unverified.
    for (const m of src.matchAll(
      /SecretFileLoader[\s\S]{0,80}?\.load\(\s*([A-Za-z_$][\w$]*)\s*\)/g,
    )) {
      warnings.push(
        `${relative(REPO_ROOT, file)}: SecretFileLoader.load(${m[1]}) uses a ` +
          `non-literal name — this checker cannot verify the compose grant.`,
      );
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
if (!existsSync(COMPOSE)) {
  console.error('FAIL: docker-compose.yml not found');
  process.exit(1);
}

const services = parseCompose(readFileSync(COMPOSE, 'utf8'));

// Guard against a silently-empty parse.
for (const { service } of ENTRYPOINTS) {
  if (!services[service]) {
    console.error(
      `FAIL: compose service "${service}" not found — the parser in this ` +
        `script is out of step with docker-compose.yml. Fix the parser; do ` +
        `not delete the check.`,
    );
    process.exit(1);
  }
}

// --- A. secret grants ------------------------------------------------------
for (const { entry, service } of ENTRYPOINTS) {
  const entryAbs = resolve(REPO_ROOT, entry);
  if (!existsSync(entryAbs)) {
    failures.push(`entrypoint ${entry} does not exist`);
    continue;
  }
  const graph = walk(entryAbs);
  const needed = secretsLoadedIn(graph);
  const granted = new Set(services[service].secrets);

  for (const [secret, where] of needed) {
    if (!granted.has(secret)) {
      failures.push(
        `${service}: boots code that loads secret "${secret}" (${where}) but ` +
          `docker-compose.yml does not grant it to that service. The container ` +
          `WILL crash-loop on deploy. Add "- ${secret}" to its secrets list.`,
      );
    }
  }
}

// --- B. healthcheck targets exist -----------------------------------------
for (const [name, svc] of Object.entries(services)) {
  if (!svc.healthcheck) continue;
  const m = svc.healthcheck.match(/node["'\s,]+dist\/([A-Za-z0-9_.-]+)\.js/);
  if (!m) continue;
  const source = resolve(REPO_ROOT, 'api', 'src', `${m[1]}.ts`);
  if (!existsSync(source)) {
    failures.push(
      `${name}: healthcheck runs "node dist/${m[1]}.js" but api/src/${m[1]}.ts ` +
        `does not exist — the probe can only ever fail and the container will ` +
        `report unhealthy forever.`,
    );
  }
}

// ---------------------------------------------------------------------------
for (const w of warnings) console.warn(`::warning::${w}`);

if (failures.length) {
  console.error('FAIL: compose runtime contract violated\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  process.exit(1);
}

console.log(
  `PASS: compose runtime contract — secret grants and healthcheck targets ` +
    `verified for ${ENTRYPOINTS.map((e) => e.service).join(', ')}`,
);
