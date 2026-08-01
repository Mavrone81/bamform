import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer, { type Browser } from 'puppeteer';
import { RenderSemaphore } from './render-semaphore';

const DEFAULT_CONCURRENCY = 2;

/**
 * PR-117 — headless Chromium, WORKER-side only (never `api`, which must
 * never block on a browser process — see `pdf.tokens.ts`'s doc comment).
 * `api/Dockerfile`'s runtime image bundles the distro `chromium` package and
 * sets `PUPPETEER_SKIP_DOWNLOAD=true` / `PUPPETEER_EXECUTABLE_PATH` so
 * Puppeteer never tries to fetch its own copy there; outside that image
 * (bare `npm ci`, e.g. this repo's CI unit/integration jobs and local dev),
 * neither env var is set, so Puppeteer downloads and uses its own bundled
 * Chromium at install time — the exact same `puppeteer.launch()` call below
 * works unmodified in both environments.
 *
 * A SINGLE long-lived `Browser` is launched lazily on first use and reused
 * across renders (launching a fresh browser per PDF is the expensive part —
 * P-08 "PDF render < 5s" would be unachievable per-call otherwise); only
 * PAGES are opened/closed per render. `RenderSemaphore` (PR-116 note/P-08)
 * caps how many pages may be mid-render at once, independent of this
 * browser's own internal process/tab limits.
 */
@Injectable()
export class ChromiumBrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(ChromiumBrowserService.name);
  private browserPromise: Promise<Browser> | null = null;
  readonly semaphore: RenderSemaphore;

  constructor(private readonly config: ConfigService) {
    const configured = Number(this.config.get('PDF_RENDER_CONCURRENCY'));
    this.semaphore = new RenderSemaphore(
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CONCURRENCY,
    );
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      const executablePath = this.config.get<string>('PUPPETEER_EXECUTABLE_PATH');
      this.browserPromise = puppeteer.launch({
        headless: true,
        executablePath: executablePath || undefined,
        // Running as root inside the container (and commonly in CI runners)
        // — the Chromium sandbox needs a non-root user or extra capabilities
        // neither provides; SECURITY_ARCHITECTURE.md §8 accepts this because
        // Chromium here only ever renders a server-generated HTML template
        // (never arbitrary caller-supplied HTML/URLs — see
        // `pdf-render.service.ts`), so the attack surface --no-sandbox would
        // otherwise mitigate does not apply.
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      this.browserPromise.catch((error: unknown) => {
        this.logger.error(`Chromium failed to launch: ${String(error)}`);
        this.browserPromise = null; // allow a later render to retry rather than permanently wedging
      });
    }
    return this.browserPromise;
  }

  /** Renders `html` to a PDF buffer, holding one semaphore permit for the duration. */
  async renderPdf(html: string): Promise<Buffer> {
    return this.semaphore.withPermit(async () => {
      const browser = await this.getBrowser();
      const page = await browser.newPage();
      try {
        // `setContent`'s `waitUntil` only supports 'load'/'domcontentloaded'
        // (unlike `page.goto`, which also accepts 'networkidle0/2') — fine
        // here since the HTML is fully self-contained (inline CSS, inline
        // base64 signature images, no external requests to wait out).
        await page.setContent(html, { waitUntil: 'load' });
        // These `page.pdf()` options own the page geometry, not the
        // stylesheet's `@page` rule: Puppeteer only consults `@page` when
        // `preferCSSPageSize` is `true` (default `false`, and not set here),
        // so `format`/`margin` below are the sole authority — verified
        // against the vendored `puppeteer-core@21.11.0`
        // (`common/util.js:313-355`), where omitting them sends US Letter
        // (8.5x11in) with zero margins to CDP instead.
        const pdf = await page.pdf({
          format: 'A4',
          margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: '<span></span>',
          footerTemplate:
            '<div style="width:100%;font-family:Arial,Helvetica,sans-serif;' +
            'font-size:8px;color:#555;padding:0 12mm;text-align:right;">' +
            'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
        });
        return Buffer.from(pdf);
      } finally {
        await page.close();
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browserPromise) {
      try {
        const browser = await this.browserPromise;
        await browser.close();
      } catch (error) {
        this.logger.warn(`error closing Chromium on shutdown: ${String(error)}`);
      }
    }
  }
}
