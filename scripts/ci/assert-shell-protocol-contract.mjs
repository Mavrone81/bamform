#!/usr/bin/env node
/**
 * Tripwire binding the two halves of the Android shell's JS bridge, and
 * pinning the two security invariants that make that bridge safe.
 *
 * WHY THIS EXISTS
 *
 * The shell's trust boundary is one origin-scoped message channel. The
 * adversarial review of 2026-07-28 (`.superpowers/sdd/android-shell-review.md`)
 * broke the FIRST design of that channel — `addJavascriptInterface`, which is
 * injected into every frame and cannot express an origin rule — with two
 * zero-interaction takeovers (a cross-origin `<iframe>`, and a cross-origin
 * form POST). The fix replaced it with
 * `WebViewCompat.addWebMessageListener(webView, CHANNEL, setOf(configuredOrigin), …)`
 * plus a re-check of `isMainFrame` / `sourceOrigin` on every message.
 *
 * The re-review then found the real remaining hole (R-1): **nothing
 * mechanical in this repo reads the Kotlin at all.** `.github/workflows/ci.yml`
 * never invoked Gradle and `android/app/src` has no test source set, so
 * widening `setOf(configuredOrigin)` to `setOf("*")`, or deleting the
 * `if (!isMainFrame) return` line, would have gone green through every gate
 * the repo has. A security fix no gate can regression-test is one refactor
 * away from being undone — and this specific fix was undone once already by
 * exactly that kind of unexamined assumption.
 *
 * Two independently-written halves also have to agree on a wire format that
 * no single compiler sees: Kotlin
 * (`android/app/src/main/java/com/bamform/shell/ShellBridge.kt`) and
 * TypeScript (`web/src/components/ShellServerControl.tsx`). Each half has its
 * own passing tests; nothing checks them against each other. Drift is silent
 * — the disclosure simply never appears on a provisioned device.
 *
 * WHAT IS ASSERTED (all static — no Gradle, no emulator, no network)
 *
 *   A. `ShellBridge.CHANNEL` === `SHELL_CHANNEL`
 *   B. `ShellBridge.PROTOCOL_VERSION` === `SHELL_PROTOCOL_VERSION`
 *   C. MainActivity registers the channel by the CONSTANT, not a literal
 *      that could drift from it
 *   D. Message-type vocabulary agrees, directionally:
 *        Kotlin-accepted types === types the web half posts
 *        Kotlin-emitted types  === types the web half handles
 *   E. SECURITY — the `addWebMessageListener` allow-list is exactly
 *      `setOf(configuredOrigin)`: never `"*"`, never empty, never widened
 *   F. SECURITY — `onPostMessage` still applies all four guards
 *      (subframe / sourceOrigin / protocol version / size+JSON) BEFORE it
 *      dispatches on the message type
 *   G. `ServerConfig.normalize` lowercases the host, because its output is
 *      what feeds the allow-list in (E) — a mixed-case host would produce an
 *      allow-list rule the WebView does not match (review R-6)
 *
 * WHAT IS **NOT** ASSERTED — read this before trusting the gate
 *
 * These are textual assertions over source. They prove the guards are
 * PRESENT and the constants AGREE. They do not execute `onPostMessage`, so
 * they cannot prove the guards still *work* — a change that keeps the lines
 * but breaks their meaning (e.g. redefining `sameOrigin`) passes here. The
 * behavioural equivalent is a Robolectric test on `onPostMessage`; see
 * `.superpowers/sdd/android-shell-report.md` for why it is a follow-up.
 * Runtime coverage of the Kotlin comes from the emulator runs recorded in
 * the review, which are manual.
 *
 * Every extraction below is anchored, and a FAILED EXTRACTION IS A FAILURE,
 * never a pass. A tripwire that silently passes is worse than no tripwire.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const KOTLIN_BRIDGE = 'android/app/src/main/java/com/bamform/shell/ShellBridge.kt';
const KOTLIN_ACTIVITY = 'android/app/src/main/java/com/bamform/shell/MainActivity.kt';
const KOTLIN_CONFIG = 'android/app/src/main/java/com/bamform/shell/ServerConfig.kt';
const WEB_CONTROL = 'web/src/components/ShellServerControl.tsx';

const failures = [];

/** Read a required file, or die. A missing half is drift too. */
function read(rel) {
  const abs = resolve(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    console.error(
      `FAIL: ${rel} does not exist. Both halves of the shell protocol must be ` +
        `present for this contract to mean anything. If the file MOVED, update ` +
        `scripts/ci/assert-shell-protocol-contract.mjs; do not delete the check.`,
    );
    process.exit(1);
  }
  return readFileSync(abs, 'utf8');
}

/**
 * Single anchored capture. Returns the capture group, or exits non-zero —
 * an anchor that stops matching means this script no longer understands the
 * code it is guarding, which is exactly when a silent pass would be worst.
 */
function must(text, rel, re, what) {
  const m = text.match(re);
  if (!m) {
    console.error(
      `FAIL: could not find ${what} in ${rel}.\n` +
        `       pattern: ${re}\n` +
        `       This checker is out of step with the source. Fix the pattern ` +
        `(or the source), but do NOT delete the check — it is the only ` +
        `mechanical guard on the shell's trust boundary.`,
    );
    process.exit(1);
  }
  return m[1];
}

/** All matches of an anchored pattern; empty is a failure. */
function mustAll(text, rel, re, what) {
  const found = [...text.matchAll(re)].map((m) => m[1]);
  if (found.length === 0) {
    console.error(
      `FAIL: found no ${what} in ${rel}.\n` +
        `       pattern: ${re}\n` +
        `       Fix the pattern or the source; do not delete the check.`,
    );
    process.exit(1);
  }
  return [...new Set(found)].sort();
}

/**
 * The `{ … }` block that follows an anchor, brace-matched rather than
 * indentation-guessed — an indentation heuristic would either over-capture
 * (letting unrelated code satisfy a security assertion) or stop matching on
 * a reformat. Exits non-zero if the anchor is absent or the braces do not
 * close.
 */
function mustBlock(text, rel, anchorRe, what) {
  const m = text.match(anchorRe);
  if (!m) {
    console.error(
      `FAIL: could not find ${what} in ${rel}.\n` +
        `       pattern: ${anchorRe}\n` +
        `       Fix the pattern or the source; do not delete the check.`,
    );
    process.exit(1);
  }
  const open = text.indexOf('{', m.index + m[0].length - 1);
  if (open === -1) {
    console.error(`FAIL: ${what} in ${rel} is not followed by a block.`);
    process.exit(1);
  }
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  console.error(`FAIL: ${what} in ${rel} has an unbalanced block — cannot parse.`);
  process.exit(1);
}

/**
 * Strip comments so documentation that *quotes* the protocol cannot satisfy
 * an assertion about the protocol. ShellBridge.kt's KDoc spells out all four
 * message shapes; without this, deleting the real dispatch would still pass.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const bridgeSrc = read(KOTLIN_BRIDGE);
const activitySrc = read(KOTLIN_ACTIVITY);
const configSrc = read(KOTLIN_CONFIG);
const webSrc = read(WEB_CONTROL);

const bridgeCode = stripComments(bridgeSrc);
const activityCode = stripComments(activitySrc);
const configCode = stripComments(configSrc);
const webCode = stripComments(webSrc);

// --- A/B. the two shared constants ----------------------------------------
const kotlinChannel = must(
  bridgeCode,
  KOTLIN_BRIDGE,
  /\bconst\s+val\s+CHANNEL\s*=\s*"([^"]+)"/,
  'ShellBridge.CHANNEL',
);
const kotlinVersion = must(
  bridgeCode,
  KOTLIN_BRIDGE,
  /\bconst\s+val\s+PROTOCOL_VERSION\s*=\s*(\d+)/,
  'ShellBridge.PROTOCOL_VERSION',
);
const webChannel = must(
  webCode,
  WEB_CONTROL,
  /export\s+const\s+SHELL_CHANNEL\s*=\s*['"]([^'"]+)['"]/,
  'SHELL_CHANNEL',
);
const webVersion = must(
  webCode,
  WEB_CONTROL,
  /export\s+const\s+SHELL_PROTOCOL_VERSION\s*=\s*(\d+)/,
  'SHELL_PROTOCOL_VERSION',
);

if (kotlinChannel !== webChannel) {
  failures.push(
    `channel name drift: ShellBridge.CHANNEL = "${kotlinChannel}" but ` +
      `SHELL_CHANNEL = "${webChannel}". The shell would register a channel ` +
      `the page never looks for, so the Server disclosure would silently ` +
      `never appear on any device. (${KOTLIN_BRIDGE} vs ${WEB_CONTROL})`,
  );
}
if (kotlinVersion !== webVersion) {
  failures.push(
    `protocol version drift: ShellBridge.PROTOCOL_VERSION = ${kotlinVersion} ` +
      `but SHELL_PROTOCOL_VERSION = ${webVersion}. Both halves drop messages ` +
      `whose "v" does not match, so every message would be silently ignored ` +
      `in both directions. (${KOTLIN_BRIDGE} vs ${WEB_CONTROL})`,
  );
}

// --- C. the registration uses the constant --------------------------------
const registeredChannel = must(
  activityCode,
  KOTLIN_ACTIVITY,
  /addWebMessageListener\s*\(\s*webView\s*,\s*([A-Za-z0-9_.]+)\s*,/,
  'the channel argument of addWebMessageListener',
);
if (registeredChannel !== 'ShellBridge.CHANNEL') {
  failures.push(
    `${KOTLIN_ACTIVITY}: addWebMessageListener registers "${registeredChannel}" ` +
      `instead of the shared constant ShellBridge.CHANNEL. A literal here can ` +
      `drift from the constant this script checks, defeating assertion (A).`,
  );
}

// --- D. message-type vocabulary, directionally ----------------------------
// Kotlin accepts: the branches of `when (json.optString("type"))`.
const whenBlock = mustBlock(
  bridgeCode,
  KOTLIN_BRIDGE,
  /when\s*\(\s*json\.optString\("type"\)\s*\)\s*\{/,
  'the `when (json.optString("type"))` dispatch',
);
const kotlinAccepts = mustAll(
  whenBlock,
  KOTLIN_BRIDGE,
  /"([A-Za-z][A-Za-z0-9_]*)"\s*->/g,
  'inbound message types',
);
// Kotlin emits: every `.put("type", "…")`.
const kotlinEmits = mustAll(
  bridgeCode,
  KOTLIN_BRIDGE,
  /\.put\(\s*"type"\s*,\s*"([A-Za-z][A-Za-z0-9_]*)"\s*\)/g,
  'outbound message types',
);
// Web posts: `type: '…'` inside the JSON.stringify payloads.
const webPosts = mustAll(
  webCode,
  WEB_CONTROL,
  /JSON\.stringify\(\{[^}]*?\btype:\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]/g,
  'posted message types',
);
// Web handles: `message.type === '…'`.
const webHandles = mustAll(
  webCode,
  WEB_CONTROL,
  /\bmessage\.type\s*===\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]/g,
  'handled message types',
);

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
if (!eq(kotlinAccepts, webPosts)) {
  failures.push(
    `page→shell vocabulary drift: the shell dispatches on ` +
      `[${kotlinAccepts.join(', ')}] but the page posts ` +
      `[${webPosts.join(', ')}]. Messages of an unlisted type are dropped ` +
      `silently by ShellBridge.onPostMessage. (${KOTLIN_BRIDGE} vs ${WEB_CONTROL})`,
  );
}
if (!eq(kotlinEmits, webHandles)) {
  failures.push(
    `shell→page vocabulary drift: the shell emits [${kotlinEmits.join(', ')}] ` +
      `but the page handles [${webHandles.join(', ')}]. Replies of an ` +
      `unhandled type are dropped silently by the page. ` +
      `(${KOTLIN_BRIDGE} vs ${WEB_CONTROL})`,
  );
}

// --- E. SECURITY: the allow-list is exactly the configured origin ----------
// This is the whole trust boundary. `addWebMessageListener` creates the
// `window.BamFormShell` object ONLY in documents whose origin matches this
// set; widening it to "*" re-creates the every-frame injection that review
// A-1 used to take the app over with zero user interaction.
const allowList = must(
  activityCode,
  KOTLIN_ACTIVITY,
  /addWebMessageListener\s*\(\s*webView\s*,\s*[A-Za-z0-9_.]+\s*,\s*([\s\S]*?)\s*,\s*shellBridge\s*,/,
  'the origin allow-list argument of addWebMessageListener',
);
const allowListFlat = allowList.replace(/\s+/g, '');
if (allowListFlat !== 'setOf(configuredOrigin)') {
  failures.push(
    `SECURITY — ${KOTLIN_ACTIVITY}: the addWebMessageListener origin ` +
      `allow-list is \`${allowListFlat}\`, not \`setOf(configuredOrigin)\`.\n` +
      `      This set IS the shell's trust boundary: the window.${kotlinChannel} ` +
      `object is created only in documents whose origin it matches. ` +
      `"*" (or any extra entry) hands a live bridge to off-origin documents — ` +
      `that is review finding A-1, a zero-interaction full takeover of which ` +
      `server the tablet loads BamForm, and the credentials typed into it, ` +
      `from. If you are widening this deliberately, you are changing the ` +
      `threat model; re-run the review's attack suite first.`,
  );
}

// --- F. SECURITY: onPostMessage still guards before it dispatches ----------
const guardRegion = must(
  bridgeCode,
  KOTLIN_BRIDGE,
  /override\s+fun\s+onPostMessage\s*\(([\s\S]*?)when\s*\(\s*json\.optString\("type"\)\s*\)/,
  'the body of onPostMessage up to its type dispatch',
);
const GUARDS = [
  {
    re: /if\s*\(\s*!isMainFrame\s*\)\s*return/,
    name: 'the subframe refusal `if (!isMainFrame) return`',
    why:
      'The allow-list in (E) is origin-scoped, NOT frame-scoped. The review ' +
      'proved this: an attacker page that embeds the configured origin in an ' +
      'iframe DOES get a live window.' +
      kotlinChannel +
      ' in that inner frame ' +
      '(measured: window-bam-props=["' +
      kotlinChannel +
      '"], postMessage did ' +
      'not throw). This single line is the only thing that dropped those ' +
      'messages. It is load-bearing, not defence in depth.',
  },
  {
    re: /ServerConfig\.sameOrigin\s*\(\s*activity\.currentOrigin\(\)\s*,\s*sourceOrigin/,
    name: 'the `sourceOrigin` re-check against the configured origin',
    why:
      'Re-checks the calling frame against the CURRENT configured origin, so ' +
      'a listener left registered across a server switch cannot serve a stale ' +
      'origin.',
  },
  {
    re: /json\.optInt\("v",\s*-?\d+\)\s*!=\s*PROTOCOL_VERSION/,
    name: 'the protocol-version check',
    why: 'Messages of another version must be ignored, not best-effort parsed.',
  },
  {
    re: /text\.length\s*>\s*MAX_MESSAGE_CHARS/,
    name: 'the message-size cap',
    why: 'Bounds the JSON parsed from an untrusted document.',
  },
];
for (const g of GUARDS) {
  if (!g.re.test(guardRegion)) {
    failures.push(
      `SECURITY — ${KOTLIN_BRIDGE}: onPostMessage no longer applies ${g.name} ` +
        `before dispatching on the message type.\n      ${g.why}`,
    );
  }
}

// --- G. normalize() lowercases the host (review R-6) -----------------------
// normalize()'s output is what feeds the allow-list in (E). An un-lowercased
// host risks an allow-list rule the WebView does not match — it fails CLOSED
// (no channel at all), but the symptom is "the Server field never appears"
// with no explanation anywhere.
const normalizeBody = mustBlock(
  configCode,
  KOTLIN_CONFIG,
  /fun\s+normalize\s*\(\s*raw:\s*String\s*\)\s*:\s*String\?\s*\{/,
  'the body of ServerConfig.normalize',
);
if (!/uri\.host\s*\?\.lowercase\(\)/.test(normalizeBody)) {
  failures.push(
    `${KOTLIN_CONFIG}: ServerConfig.normalize no longer lowercases the host. ` +
      `Its output feeds the addWebMessageListener allow-list, which is ` +
      `matched case-sensitively on the host; a mixed-case host would fail ` +
      `closed (no channel) and present as "the Server field never appears" ` +
      `(review R-6).`,
  );
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error('FAIL: Android shell protocol/security contract violated\n');
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(
  `PASS: Android shell contract — channel "${kotlinChannel}", protocol v${kotlinVersion} ` +
    `agreed across Kotlin and TypeScript; page→shell [${kotlinAccepts.join(', ')}], ` +
    `shell→page [${kotlinEmits.join(', ')}]; origin allow-list is ` +
    `setOf(configuredOrigin); onPostMessage applies all ${GUARDS.length} guards ` +
    `before dispatch; normalize() lowercases the host.`,
);
