# BamForm design system — industrial clarity

Slice 14-DESIGN. This document is the working reference for anyone building
BamForm screens (13-UI-B builds the admin surface from exactly these parts).
The system is hand-rolled CSS: design tokens in `src/styles/tokens.css`,
the component layer in `src/styles/global.css`, plus a handful of small React
components. **Zero runtime dependencies, zero fetched assets** — the CSP is
`default-src 'self'` with no font/CDN exceptions and stays that way.

## 1. Direction

BamForm is an instrument, not a consumer app. Its users are gloved
technicians standing at a machine (phones/tablets, glare, arm's length) and
verifiers/admins at desks. The direction, per the owner: **industrial
clarity** — "modern, direct and sleek, not confusing, easy to navigate".

Concretely:

- **One calibrated light theme.** Cool-steel canvas (`#e9edf0`), white
  instrument panels, graphite ink (`#16191d`). No dark mode by design: a
  single palette we can prove readable in plant-floor glare beats two we
  cannot. The tokens are the seam if a dark theme is ever wanted.
- **Graphite chrome.** The app bar, bottom tabs and side rail are near-black
  with the brand amber reserved for exactly one job: marking _where you are_
  (active tab indicator, identity plate rule) and the brand mark itself.
  Amber is never body text on light surfaces (contrast).
- **A disciplined signal system.** Four tones — good / bad / attention /
  info (+ neutral) — each an `ink / tint / edge` triple: dark ink on a pale
  tinted plate with a saturated edge and a 4px left rule. Status is always
  **icon + words + tone**, never colour alone (A-05). Lifecycle badges show
  the **verbatim server vocabulary** (`IN_PROGRESS`, `ARCHIVED`) in mono
  caps: in a controlled-document system the screen, the audit trail and the
  PDF must agree word-for-word, and the mono face makes machine words read
  as instrument states.
- **Type with an industrial accent, zero bytes fetched.** Display face is a
  condensed industrial grotesque from faces every target OS ships:
  `Bahnschrift` (Windows's DIN 1451 revival), `Avenir Next Condensed`
  (iOS/macOS), `Roboto Condensed` (Android). DIN is literally the typeface
  of industrial signage. All codes, numbers, statuses and inputs ride the
  monospace stack with tabular figures. Body is the system stack for
  legibility. (A self-hosted webfont was considered and rejected: the CSP
  and the zero-dependency rule outweigh typographic novelty here.)
- **Motion is an afterthought, deliberately.** 120–160ms colour/width
  transitions, one spinner, everything inside
  `prefers-reduced-motion: no-preference` guards or globally collapsed by
  the `reduce` override.
- **Touch targets:** 44px floor everywhere (`--tap-min`), 48px default
  buttons/nav (`--tap-comfort`), 56px on capture controls and terminal
  actions (`--tap-capture`).

## 2. Tokens (`src/styles/tokens.css`)

| Group     | Tokens                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| Type      | `--font-display/body/mono`, `--text-xs…2xl`, `--leading-*`, `--tracking-*`                                          |
| Space     | `--space-1…7` (4px grid: 4/8/12/16/24/32/48)                                                                        |
| Targets   | `--tap-min` 44 / `--tap-comfort` 48 / `--tap-capture` 56                                                            |
| Shape     | `--radius-1` 3px, `--radius-2` 6px, `--radius-round`, `--border-width`, `--border-width-strong`, `--rule-width` 4px |
| Elevation | `--shadow-1/2/nav`                                                                                                  |
| Z-layers  | `--z-nav` 40, `--z-appbar` 41, `--z-overlay` 50, `--z-toast` 60, `--z-skip` 100                                     |
| Motion    | `--motion-fast` 120ms, `--motion-med` 160ms, `--motion-ease`                                                        |
| Neutrals  | `--color-canvas/panel/panel-sunken/ink/ink-soft/ink-faint/border/border-strong`                                     |
| Chrome    | `--color-chrome/chrome-ink/chrome-ink-soft/chrome-line/brand-amber`                                                 |
| Actions   | `--color-accent(+hover/ink/text)`, `--color-destructive(+hover/ink)`, `--color-focus`                               |
| Signals   | `--signal-{good,bad,attention,info,neutral}-{ink,tint,edge}` (+`good/bad/neutral-solid`)                            |
| Layout    | `--shell-max-form` 34rem, `--shell-max-content` 50rem, `--appbar-height`, `--tabbar-height`, `--rail-width`         |

Rule: screens consume tokens (directly or through the component classes) —
no hard-coded colours or sizes in screen files.

## 3. Component inventory (what 13-UI-B builds from)

CSS class patterns (in `global.css`, matching the codebase's existing idiom)
unless noted as a React component:

| Part                                                          | Use                        | Notes                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.app-shell`                                                  | page content column        | `--focus` modifier = 34rem single-task forms; `--standalone` = gate screens rendered without the nav shell                                                                                                             |
| `NavShell` (component)                                        | navigation shell           | graphite app bar + bottom tabs on phone, side rail ≥768px; role-aware tabs (presentation only, see §4); wrap any authenticated routed screen                                                                           |
| `.appbar`, `.nav-tabs`, `.nav-rail`, `.nav-item`              | shell chrome               | safe-area insets built in; hidden variant is `display:none` (absent from a11y tree)                                                                                                                                    |
| `.screen-header`, `.microlabel`, `.screen-meta`, `.back-link` | screen headers             | eyebrow + h1 + mono meta line + quiet back button                                                                                                                                                                      |
| `button` (default)                                            | secondary action           | white plate, strong border, 48px                                                                                                                                                                                       |
| `.btn-primary`                                                | THE action                 | engineering blue, one per view                                                                                                                                                                                         |
| `.btn-destructive`                                            | destructive confirm        | solid signal red; only ever behind an explicit confirmation step                                                                                                                                                       |
| `.btn-quiet`, `.btn-block`, `.btn-capture`                    | modifiers                  | quiet = borderless; capture = 56px/18px text                                                                                                                                                                           |
| `.field`, `.field-hint`, `.field-error`, `.checkbox-field`    | form fields                | 48px inputs, mono digits, 16px font (stops iOS zoom)                                                                                                                                                                   |
| `.status-chip[data-tone]`                                     | inline status              | icon span + label span; tones good/bad/attention/info/neutral                                                                                                                                                          |
| `StatusBadge` (component)                                     | record lifecycle           | verbatim enum + icon + tone mapping for SCHEDULED…VOIDED                                                                                                                                                               |
| `SyncStatusChip` (component)                                  | offline sync state         | unchanged API; carries `role="status"`                                                                                                                                                                                 |
| `.banner[data-tone]`                                          | inline alert / toast idiom | left-rule tinted plate; there is no floating toast layer by design — an instrument reports state inline, where the operator is looking                                                                                 |
| `.card`, `.card-row`, `.card-title`                           | panel                      | white panel, hairline border, faint shadow                                                                                                                                                                             |
| `.card-button[data-rule]`                                     | tappable row card          | job/queue rows; 4px left status rule (neutral/attention/bad/good)                                                                                                                                                      |
| `.data-list`                                                  | list of cards              | the mobile-first "table"; 13-UI-B: use this below `md`, a real table above if needed                                                                                                                                   |
| `.kv-row`, `.kv-label`, `.kv-value`                           | label/value rows           | review + meta surfaces, mono values                                                                                                                                                                                    |
| `.review-item`, `.review-remark`                              | reviewed checklist row     | instruction + result chip + optional remark; the chip wraps onto its own line on narrow phones instead of squeezing the instruction                                                                                    |
| `.dialog`, `.dialog-actions`                                  | confirm panel              | heavy 2px ink border; inline for confirms (admin reset). For TRUE modality use it on a native `<dialog>` + `showModal()` (step-up does): top layer, trapped focus, inert background, Esc = cancel, `::backdrop` styled |
| `.empty-state` (+`-glyph`, `-title`)                          | designed empty states      | glyph + title + hint                                                                                                                                                                                                   |
| `.loading-state`, `.loading-spinner`                          | loading                    | spinner animates only under `prefers-reduced-motion: no-preference`                                                                                                                                                    |
| `.segmented`                                                  | one-tap capture control    | 56px segments; pressed = solid signal fill + white ink                                                                                                                                                                 |
| `.checklist-item`, `.checklist-instruction`, `.item-no`       | capture rows               | numbered plate + instruction + segmented control                                                                                                                                                                       |
| `.progress-plate/track/fill`                                  | capture progress           | presentational bar + text readout                                                                                                                                                                                      |
| `.action-bar`                                                 | terminal action            | heavy top rule + full-width primary                                                                                                                                                                                    |
| `Menu` (screen)                                               | overflow destinations      | role-aware item list + identity plate                                                                                                                                                                                  |
| `InstallHint` (component)                                     | PWA install                | `beforeinstallprompt` / iOS instructions; localStorage dismissal (the one allowed persisted UI flag)                                                                                                                   |
| `BrandMark` (component)                                       | the mark                   | hex nut + check; same geometry as `public/icon.svg`                                                                                                                                                                    |

## 4. Navigation model

- Phone (<768px): sticky graphite app bar (brand + connectivity chip) +
  fixed bottom tabs **Jobs / Queue / Menu**. Tablet/desktop (≥768px): fixed
  232px side rail with the same items, connectivity chip and the signed-in
  identity.
- The **Queue tab appears for TEAM_LEADER / ENGINEER / ADMIN** (the roles
  whose day job it is). Everyone else reaches the queue via **Menu** — a
  MAINTAINER acting as delegate is two taps from it. This is presentation
  derived from server-returned roles, never enforcement (non-negotiable #6);
  every route stays URL-reachable and the server refuses what it refuses.
- Menu also carries Delegations, Change password and (ADMIN only) the MFA
  reset. Gate screens (forced password change, recovery codes, sign-in)
  deliberately render without the shell.
- `html { scroll-padding }` keeps anything scrolled into view clear of the
  fixed bars.

## 5. Contrast (measured, not eyeballed)

WCAG 2.x ratios computed from the hex values (script in the slice report;
re-run it if any token changes). Minimums: 4.5:1 text, 3:1 large text/UI.

| Pair                                                 |              Ratio | Min |
| ---------------------------------------------------- | -----------------: | :-: |
| ink `#16191d` on panel `#ffffff`                     |              17.63 | 4.5 |
| ink on canvas `#e9edf0`                              |              14.98 | 4.5 |
| ink-soft `#3f4650` on panel / canvas                 |        9.53 / 8.10 | 4.5 |
| ink-faint `#5a626c` on panel / canvas                |        6.18 / 5.25 | 4.5 |
| white on accent `#0f4d8a` (primary btn)              |               8.58 | 4.5 |
| accent text on panel / canvas                        |        8.58 / 7.28 | 4.5 |
| white on destructive `#a1160f`                       |               7.96 | 4.5 |
| good ink `#15602f` on panel / on tint `#e3f3e7`      |        7.65 / 6.64 | 4.5 |
| bad ink `#a1160f` on panel / on tint `#fdeae8`       |        7.96 / 6.87 | 4.5 |
| attention ink `#7a4a00` on panel / on tint `#fdf2dd` |        7.48 / 6.74 | 4.5 |
| info ink `#1b4d7d` on tint `#e6f0f9`                 |               7.57 | 4.5 |
| neutral ink `#3f4650` on tint `#eceff2`              |               8.26 | 4.5 |
| white on good/bad/neutral solids (pressed segments)  | 7.65 / 7.96 / 9.53 | 4.5 |
| chrome ink white on chrome `#16191d`                 |              17.63 | 4.5 |
| chrome ink-soft `#9aa5b1` on chrome                  |               7.05 | 4.5 |
| focus ring `#0b62d6` on panel / canvas               |        5.63 / 4.78 | 3.0 |
| input border `#78828d` on panel                      |               3.91 | 3.0 |
| good/bad/attention edges on panel                    | 5.04 / 4.99 / 3.88 | 3.0 |
| brand amber `#f5b82e` on chrome (graphic only)       |               9.89 | 3.0 |
| chrome focus ring `#7cb8ff` on chrome                |               8.53 | 3.0 |
| online dot `#58c07e` on chrome (paired with text)    |               7.77 | 3.0 |

Also: `axe-core` (wcag2a + wcag2aa + wcag21aa) reports **zero violations**
on every screen (`npm run test:a11y`).

## 6. PWA

- `public/manifest.webmanifest`: complete (`id`, `standalone`,
  `orientation: any`, theme `#16191d` on background `#e9edf0`).
- Icon set generated from the original mark (`public/icon.svg`, hex nut +
  check): `icon-192/512.png` (any), `icon-maskable-192/512.png` (full-bleed,
  mark inside the 80% safe zone), `apple-touch-icon.png` (180).
- iOS metas (`apple-mobile-web-app-*`), `viewport-fit=cover`, and
  `env(safe-area-inset-*)` padding in the app bar / tab bar / gate screens.
- `InstallHint` on the job list; dismissal persisted under
  `bamform.install-hint-dismissed`.
- The service worker (`src/sw.ts`) is **untouched** — icons ride the
  existing runtime stale-while-revalidate shell cache.

## 7. Screenshot index (`web/design-screenshots/`, committed)

Captured by `npx playwright test --project=design` (never run in CI); each
name exists at `-375`, `-768` and `-1280`. The set doubles as the nav-shell
evidence: 375 shows app bar + bottom tabs, 768/1280 the side rail.

| File prefix                  | Screen / state                                           |
| ---------------------------- | -------------------------------------------------------- |
| `01-sign-in`                 | SignIn, password step                                    |
| `02-sign-in-totp`            | SignIn, 6-digit code step                                |
| `03-sign-in-recovery`        | SignIn, recovery-code step                               |
| `04-mfa-enrolment`           | MFA enrolment (QR + manual key)                          |
| `05-recovery-codes`          | one-time recovery-codes gate                             |
| `06-job-list`                | JobList (overdue + on-schedule jobs, sync chips)         |
| `07-record-capture`          | RecordCapture, untouched                                 |
| `08-record-capture-midfill`  | RecordCapture mid-fill (item recorded, progress moving)  |
| `09-verifier-queue`          | VerifierQueue with a submitted record                    |
| `10-record-review`           | RecordReview, view mode                                  |
| `11-record-review-sign`      | RecordReview, signature pad with a drawn stroke          |
| `12-delegations`             | Delegations with an active grant                         |
| `13-menu-technician`         | Menu as MAINTAINER (queue entry present, no admin entry) |
| `14-change-password`         | ChangePassword, voluntary                                |
| `15-change-password-forced`  | ChangePassword, forced gate (shell-less)                 |
| `16-menu-admin`              | Menu as ADMIN                                            |
| `17-admin-mfa-reset-confirm` | AdminMfaReset with the destructive confirm open          |
