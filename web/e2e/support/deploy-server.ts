import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { APIRequestContext } from '@playwright/test';

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
 *  - `sw.js` differs BYTE-WISE (its versioned cache name changes), which is
 *    the only thing that makes the browser treat it as a new worker at all;
 *  - `index.html` points at differently-named asset files;
 *  - the JavaScript itself is different, which is asserted directly rather
 *    than inferred — build B's bundle sets `window.__E2E_BUILD_JS = 'B'`, so
 *    a test that says "the client is running build B" is reporting that new
 *    code executed, not merely that a new file was requested.
 *
 * Build A's asset paths keep resolving after the swap. That is the harsher
 * choice on purpose: if the client wrongly stayed on the old `index.html` it
 * would still render happily, and the test would have to catch it by
 * observing the version rather than by noticing a crash.
 */
export class DeployServer {
  private files = new Map<string, { body: Buffer; type: string }>();
  private current: 'A' | 'B' = 'A';
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
    // A byte-different worker with a different versioned cache name — what
    // `web/Dockerfile` produces from a new `VITE_APP_VERSION` on every deploy.
    deploy.put(
      '/b/sw.js',
      swJs.split('bamform-shell-').join('bamform-shell-gen-b-'),
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
  deploy(generation: 'A' | 'B'): void {
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
    const prefix = this.current === 'B' ? '/b' : '';

    // The two files a deploy replaces are looked up under the generation
    // prefix; hashed assets are content-addressed and live at one path each.
    let file =
      this.files.get(`${prefix}${path}`) ??
      (path === '/sw.js' ? undefined : this.files.get(path)) ??
      // SPA fallback, exactly as `try_files $uri $uri/ /index.html` does.
      (path.startsWith('/assets/') ? undefined : this.files.get(`${prefix}/index.html`));

    if (path === '/sw.js') file = this.files.get(`${prefix}/sw.js`);

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
