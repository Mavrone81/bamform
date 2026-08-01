import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { APIRequestContext } from '@playwright/test';
// @ts-expect-error -- plain .mjs build helper, shared with vite.sw.config.ts so
// the harness versions its second generation the way the real build does.
import { fingerprintAssets } from '../../scripts/asset-fingerprint.mjs';

/**
 * A real HTTP origin whose contents can be swapped mid-test — i.e. a deploy.
 *
 * Slice 22-SELFUPDATE §5 exists because O-12 was skipped as flaky, and the
 * reason it was flaky is that the previous attempt tried to drive two
 * service-worker generations through Playwright's request interception. This
 * takes the interception out entirely: the app under test is mirrored byte
 * for byte off the real built origin (nginx in CI, `vite preview` locally)
 * onto a throwaway localhost server, which then serves either generation on
 * demand. Everything the browser sees — `/sw.js` served `no-store`, hashed
 * assets served `immutable`, `index.html` served `no-cache`, the SPA
 * fallback — is real HTTP with the same headers `web/nginx.conf` sets, and
 * the service worker running is the real `dist/sw.js`.
 *
 * `127.0.0.1` is deliberate rather than `localhost`: it is a secure context,
 * so service workers register exactly as they do over HTTPS in production.
 *
 * ## What makes generation B a genuine deploy
 *
 * A real deploy changes three things at once, and this changes all three:
 *  - `index.html` points at differently-named asset files;
 *  - the JavaScript itself is different, which is asserted directly rather
 *    than inferred — build B's bundle sets `window.__E2E_BUILD_JS = 'B'`, so
 *    a test that says "the client is running build B" is reporting that new
 *    code executed, not merely that a new file was requested;
 *  - `sw.js` differs byte-wise, **because its version is recomputed from
 *    generation B's asset filenames using the same function the real build
 *    uses** (`web/scripts/asset-fingerprint.mjs`).
 *
 * ## Why that last point is written this way (review finding S-5)
 *
 * This harness used to manufacture the worker difference by string
 * substitution — `swJs.split('bamform-shell-').join('bamform-shell-gen-b-')`
 * — under a comment asserting that a new `VITE_APP_VERSION` is "what
 * web/Dockerfile produces on every deploy". That premise was false in
 * production (`VITE_APP_VERSION` is pinned to `local` there), and because the
 * harness supplied the premise itself, this test **could not fail for the
 * reason production was broken**. A genuinely discriminating, 20/20-stable
 * E2E therefore sat green over a fix that did nothing on the live server.
 *
 * Deriving the worker's version the way the build derives it means the test
 * now breaks if that derivation stops depending on the build output.
 * `scripts/ci/assert-sw-changes-per-build.sh` covers the same property
 * against two real `vite build` runs, which is the check that would have
 * caught S-1 outright.
 *
 * Build A's asset paths keep resolving after the swap. That is the harsher
 * choice on purpose: if the client wrongly stayed on the old `index.html` it
 * would still render happily, and the test would have to catch it by
 * observing the version rather than by noticing a crash.
 */
/**
 * 'B-stale-worker' is generation B served with generation A's `sw.js` — the
 * production shape from review S-1, where `VITE_APP_VERSION` was pinned so
 * every deploy's worker was byte-identical and `registration.update()`
 * correctly reported "no change" forever.
 */
export type Generation = 'A' | 'B' | 'B-stale-worker';

export class DeployServer {
  private files = new Map<string, { body: Buffer; type: string }>();
  private current: Generation = 'A';
  private server: http.Server;
  private origin = '';

  private constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  /** Copies the built app off `baseURL` and stands up both generations. */
  static async mirror(request: APIRequestContext, baseURL: string): Promise<DeployServer> {
    const deploy = new DeployServer();

    const indexHtml = await text(request, `${baseURL}/`);
    const swJs = await text(request, `${baseURL}/sw.js`);

    const assetPaths = [...indexHtml.matchAll(/["'](\/assets\/[^"']+)["']/g)].map((m) => m[1]);
    if (assetPaths.length === 0) {
      throw new Error(`mirrored index.html from ${baseURL} referenced no /assets/ — build broken?`);
    }
    const jsPath = assetPaths.find((p) => p.endsWith('.js'));
    if (!jsPath) throw new Error('mirrored index.html referenced no JS bundle');

    for (const path of assetPaths) {
      deploy.put(path, await text(request, `${baseURL}${path}`), mime(path));
    }
    // Not load-bearing for the update mechanism, but a 404 on the manifest
    // logs a console error that noisy-console assertions elsewhere would
    // rather not see.
    deploy.put(
      '/manifest.webmanifest',
      await text(request, `${baseURL}/manifest.webmanifest`).catch(() => '{}'),
      'application/manifest+json',
    );

    // ---- generation A: exactly what is deployed today ----
    deploy.put('/index.html', stamp(indexHtml, 'A'), 'text/html; charset=utf-8');
    deploy.put('/sw.js', swJs, 'application/javascript; charset=utf-8');

    // ---- generation B: a deploy ----
    const bJsPath = jsPath.replace('/assets/', '/assets/b-');
    deploy.put(
      '/b/index.html',
      stamp(indexHtml, 'B').split(jsPath).join(bJsPath),
      'text/html; charset=utf-8',
    );
    deploy.put(
      bJsPath,
      `${deploy.read(jsPath)}\n;window.__E2E_BUILD_JS='B';`,
      'application/javascript; charset=utf-8',
    );
    // Generation B's worker, versioned the way the REAL BUILD versions it:
    // by fingerprinting the emitted asset filenames. See the class doc (S-5)
    // for why this must not be a hand-made string substitution. If `sw.ts`
    // ever stops deriving its cache name from the build output, the token
    // below stops appearing and this throws rather than silently fabricating
    // a difference production would not have.
    const assetsA = assetPaths.map(basename);
    const assetsB = assetPaths.map((p) => basename(p === jsPath ? bJsPath : p));
    const fingerprintA = fingerprintAssets(assetsA) as string;
    const fingerprintB = fingerprintAssets(assetsB) as string;
    if (fingerprintA === fingerprintB) {
      throw new Error('deploy harness: generations A and B fingerprinted identically');
    }
    if (!swJs.includes(fingerprintA)) {
      throw new Error(
        'deploy harness: the built sw.js does not carry the asset fingerprint ' +
          `${fingerprintA}. The service worker is no longer versioned by build output, which ` +
          'is exactly the production failure (review S-1) this harness must be able to expose.',
      );
    }
    deploy.put(
      '/b/sw.js',
      swJs.split(fingerprintA).join(fingerprintB),
      'application/javascript; charset=utf-8',
    );

    await new Promise<void>((resolve) => deploy.server.listen(0, '127.0.0.1', resolve));
    const { port } = deploy.server.address() as AddressInfo;
    deploy.origin = `http://127.0.0.1:${port}`;
    return deploy;
  }

  get url(): string {
    return this.origin;
  }

  /** The deploy. Every subsequent request is answered from this generation. */
  deploy(generation: Generation): void {
    this.current = generation;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private put(path: string, body: string, type: string): void {
    this.files.set(path, { body: Buffer.from(body), type });
  }

  private read(path: string): string {
    const f = this.files.get(path);
    if (!f) throw new Error(`mirror missing ${path}`);
    return f.body.toString('utf8');
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    // 'B-stale-worker' reproduces PRODUCTION as it actually behaved (review
    // S-1): a real deploy — new index.html, new hashed bundle — shipped with
    // a BYTE-IDENTICAL /sw.js, because VITE_APP_VERSION was pinned to a
    // constant. The service-worker comparison is blind to that deploy by
    // construction, so a client can only escape it via the asset detector.
    const prefix = this.current === 'A' ? '' : '/b';
    const workerPrefix = this.current === 'B' ? '/b' : '';

    // The two files a deploy replaces are looked up under the generation
    // prefix; hashed assets are content-addressed and live at one path each.
    let file =
      this.files.get(`${prefix}${path}`) ??
      (path === '/sw.js' ? undefined : this.files.get(path)) ??
      // SPA fallback, exactly as `try_files $uri $uri/ /index.html` does.
      (path.startsWith('/assets/') ? undefined : this.files.get(`${prefix}/index.html`));

    if (path === '/sw.js') file = this.files.get(`${workerPrefix}/sw.js`);

    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    // The cache headers are copied from web/nginx.conf, not invented: if a
    // future change to that file made a deploy unreachable, this harness
    // must be able to reproduce it rather than paper over it.
    const cacheControl = path.startsWith('/assets/')
      ? 'public, immutable, max-age=31536000'
      : path === '/sw.js'
        ? 'no-cache, no-store, must-revalidate'
        : 'no-cache';

    res.writeHead(200, {
      'Content-Type': file.type,
      'Content-Length': file.body.length,
      'Cache-Control': cacheControl,
      'Service-Worker-Allowed': '/',
    });
    res.end(file.body);
  }
}

/** Marks which generation an `index.html` belongs to, readable from the DOM. */
function stamp(html: string, generation: 'A' | 'B'): string {
  return html.replace('<title>', `<meta name="e2e-build" content="${generation}" /><title>`);
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function mime(path: string): string {
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'application/javascript; charset=utf-8';
}

async function text(request: APIRequestContext, url: string): Promise<string> {
  const res = await request.get(url);
  if (!res.ok()) throw new Error(`mirror fetch ${url} -> ${res.status()}`);
  return res.text();
}
