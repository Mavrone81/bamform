#!/usr/bin/env node
/**
 * Tripwire on the Android shell's IN-APP UPDATE path — a code-delivery
 * channel, and therefore the highest-consequence surface the shell has.
 *
 * WHY THIS EXISTS
 *
 * Slice 21-SHELL gave the shell the ability to fetch an APK and hand it to
 * the platform installer. Everything that makes that safe is a handful of
 * lines that a compiler is perfectly happy without:
 *
 *   - the update origin is a PINNED https constant, not the
 *     runtime-configurable content origin (an admin, or an on-path attacker
 *     on the cleartext plant LAN the shell deliberately supports, must not
 *     get to choose which binary the device is invited to install);
 *   - the manifest's `apkUrl` is re-checked against that origin before a
 *     single byte is requested;
 *   - the downloaded bytes are hashed and compared to the published SHA-256,
 *     and the archive's signing certificate is compared to the running app's,
 *     BEFORE any installer intent is constructed;
 *   - neither fetch follows redirects, which is the way off a pinned origin;
 *   - the web page cannot trigger any of it — no bridge message type exists.
 *
 * Delete any one of those and the build still compiles, lint still passes,
 * and the emulator still shows a working update. That is the same shape of
 * hole the re-review (R-1) found in the bridge, and the same answer applies:
 * a security property no gate can regression-test is one refactor away from
 * being undone.
 *
 * It also pins the ANTI-DRIFT property that made this slice necessary. The
 * page published at form.bevorasg.com/app linked to `bamform-1.1.apk` with a
 * footer reading "v1.1", while that binary carried versionName 1.0.0 and
 * versionCode 1. Two hand-maintained descriptions of one artefact had already
 * disagreed. So: the page must contain no hard-coded APK filename, and the
 * manifest must be generated from the built APK by Gradle.
 *
 * WHAT IS **NOT** ASSERTED — read before trusting this gate
 *
 * These are textual assertions over source. They prove the checks are
 * PRESENT and ordered; they do not execute them. A change that keeps the
 * lines but breaks their meaning (redefining `isTrustedUpdateUrl` to return
 * true, say) passes here — assertion 3 pins that function's own body for
 * exactly that reason, but the general limitation stands. Runtime evidence
 * is the emulator run recorded in `.superpowers/sdd/slice-21-shell-report.md`,
 * including the deliberate wrong-hash refusal, and it is manual.
 *
 * Every extraction is anchored, and A FAILED EXTRACTION IS A FAILURE, never
 * a pass.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const K_MANIFEST = 'android/app/src/main/java/com/bamform/shell/UpdateManifest.kt';
const K_SERVICE = 'android/app/src/main/java/com/bamform/shell/UpdateService.kt';
const K_CONTROLLER = 'android/app/src/main/java/com/bamform/shell/UpdateController.kt';
const K_BRIDGE = 'android/app/src/main/java/com/bamform/shell/ShellBridge.kt';
const GRADLE = 'android/app/build.gradle.kts';
const ANDROID_MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const NET_CONFIG = 'android/app/src/main/res/xml/network_security_config.xml';
const PAGE = 'android/download-page/index.html';
const SRC_ROOT = 'android/app/src';

const failures = [];

function read(rel) {
  const abs = resolve(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    console.error(
      `FAIL: ${rel} does not exist. The in-app update path is a code-delivery ` +
        `channel and every file this contract names is part of it. If the file ` +
        `MOVED, update scripts/ci/assert-shell-update-contract.mjs; do not ` +
        `delete the check.`,
    );
    process.exit(1);
  }
  return readFileSync(abs, 'utf8');
}

function must(text, rel, re, what) {
  const m = text.match(re);
  if (!m) {
    console.error(
      `FAIL: could not find ${what} in ${rel}.\n` +
        `       pattern: ${re}\n` +
        `       This checker is out of step with the source. Fix the pattern ` +
        `(or the source), but do NOT delete the check — it is the only ` +
        `mechanical guard on the shell's update channel.`,
    );
    process.exit(1);
  }
  return m[1];
}

/** Brace-matched block following an anchor. */
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
 * Comments are stripped before every code assertion. These files document
 * their own security rules at length; without this, deleting the code would
 * still satisfy an assertion about the code.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const manifestSrc = stripComments(read(K_MANIFEST));
const serviceSrc = stripComments(read(K_SERVICE));
const controllerSrc = stripComments(read(K_CONTROLLER));
const bridgeSrc = stripComments(read(K_BRIDGE));
const gradleSrc = stripComments(read(GRADLE));
const androidManifest = read(ANDROID_MANIFEST);
const netConfig = read(NET_CONFIG);
const pageSrc = read(PAGE);

// --- 1. SECURITY: the update origin is a pinned https constant -------------
const updateOrigin = must(
  manifestSrc,
  K_MANIFEST,
  /\bconst\s+val\s+UPDATE_ORIGIN\s*=\s*"([^"]+)"/,
  'UpdateManifest.UPDATE_ORIGIN',
);
const updateHost = must(
  manifestSrc,
  K_MANIFEST,
  /\bconst\s+val\s+UPDATE_HOST\s*=\s*"([^"]+)"/,
  'UpdateManifest.UPDATE_HOST',
);
const manifestUrl = must(
  manifestSrc,
  K_MANIFEST,
  /\bconst\s+val\s+MANIFEST_URL\s*=\s*"([^"]+)"/,
  'UpdateManifest.MANIFEST_URL',
);
const updateDir = must(
  manifestSrc,
  K_MANIFEST,
  /\bconst\s+val\s+UPDATE_DIR\s*=\s*"([^"]+)"/,
  'UpdateManifest.UPDATE_DIR',
);

if (!/^https:\/\/[a-z0-9.-]+$/.test(updateOrigin)) {
  failures.push(
    `SECURITY — ${K_MANIFEST}: UPDATE_ORIGIN is "${updateOrigin}", which is not a ` +
      `bare https:// origin. This constant is the ONLY thing that keeps the ` +
      `update channel off the runtime-configurable content origin. Cleartext ` +
      `here means an on-path attacker on the plant LAN chooses which APK the ` +
      `device is offered.`,
  );
}
if (updateOrigin !== `https://${updateHost}`) {
  failures.push(
    `${K_MANIFEST}: UPDATE_HOST ("${updateHost}") is not the host of ` +
      `UPDATE_ORIGIN ("${updateOrigin}"). isTrustedUpdateUrl compares against ` +
      `both; a mismatch makes one of the two checks vacuous.`,
  );
}
if (!manifestUrl.startsWith(updateOrigin + updateDir) || !manifestUrl.endsWith('.json')) {
  failures.push(
    `SECURITY — ${K_MANIFEST}: MANIFEST_URL ("${manifestUrl}") is not a .json ` +
      `under ${updateOrigin}${updateDir}. The manifest is read from exactly one ` +
      `URL and that URL must be on the pinned origin.`,
  );
}

// --- 2. the Gradle publisher targets the same origin -----------------------
const gradleOrigin = must(
  gradleSrc,
  GRADLE,
  /\bval\s+updateOriginUrl\s*=\s*"([^"]+)"/,
  'the updateOriginUrl used to write version.json',
);
if (gradleOrigin !== updateOrigin) {
  failures.push(
    `origin drift: ${GRADLE} writes apkUrls on "${gradleOrigin}" but ` +
      `${K_MANIFEST} only accepts "${updateOrigin}". Every installed device ` +
      `would refuse the manifest this build produces — the update path would ` +
      `be silently dead, which is exactly the failure mode nobody notices.`,
  );
}

// --- 3. SECURITY: isTrustedUpdateUrl still pins scheme, host and directory --
const trustBody = mustBlock(
  manifestSrc,
  K_MANIFEST,
  /fun\s+isTrustedUpdateUrl\s*\(\s*raw:\s*String\s*\)\s*:\s*Boolean\s*\{/,
  'the body of isTrustedUpdateUrl',
);
const TRUST_RULES = [
  {
    re: /!raw\.startsWith\(\s*UPDATE_ORIGIN\s*\+\s*UPDATE_DIR\s*\)\s*\)\s*return\s+false/,
    name: 'the authority-anchored prefix test against UPDATE_ORIGIN + UPDATE_DIR',
    why:
      'Pins scheme, host and directory in one comparison, and is what rejects ' +
      'https://form.bevorasg.com.evil.tld/app/ — a host that a naive ' +
      '"contains the host" check would accept.',
  },
  {
    re: /uri\.scheme\s*!=\s*"https"\s*\)\s*return\s+false/,
    name: 'the https scheme check',
    why: 'A cleartext APK download is an APK an on-path attacker chooses.',
  },
  {
    re: /uri\.host\?\.lowercase\(\)\s*!=\s*UPDATE_HOST\s*\)\s*return\s+false/,
    name: 'the host check against UPDATE_HOST',
    why: 'Independent of the prefix test, and survives a lenient URL parser.',
  },
  {
    re: /uri\.userInfo\s*!=\s*null\s*\)\s*return\s+false/,
    name: 'the userinfo rejection',
    why: 'https://form.bevorasg.com@evil.tld/ parses with host evil.tld.',
  },
];
for (const rule of TRUST_RULES) {
  if (!rule.re.test(trustBody)) {
    failures.push(
      `SECURITY — ${K_MANIFEST}: isTrustedUpdateUrl no longer applies ${rule.name}.\n` +
        `      ${rule.why}`,
    );
  }
}

// --- 4. SECURITY: the update path never consults the configured origin ------
// This is the whole separation of privilege: serving BamForm's pages is a
// much smaller thing than shipping code to the devices, and the shell lets an
// admin re-point the former at any host (including cleartext ones).
for (const [rel, src] of [
  [K_MANIFEST, manifestSrc],
  [K_SERVICE, serviceSrc],
  [K_CONTROLLER, controllerSrc],
]) {
  for (const token of ['ServerConfig', 'configuredOrigin', 'currentOrigin']) {
    if (src.includes(token)) {
      failures.push(
        `SECURITY — ${rel} references \`${token}\`. The update channel must be ` +
          `pinned to UPDATE_ORIGIN and must NOT be steerable by the ` +
          `runtime-configurable content origin: whoever can point the shell at a ` +
          `server would otherwise also choose which APK it downloads and offers ` +
          `to install.`,
      );
    }
  }
}

// --- 5/6. SECURITY: order of operations inside UpdateService.download -------
const downloadBody = mustBlock(
  serviceSrc,
  K_SERVICE,
  /fun\s+download\s*\(([\s\S]{0,400}?)\)\s*:\s*DownloadOutcome\s*\{/,
  'the body of UpdateService.download',
);

const iTrust = downloadBody.search(/UpdateManifest\.isTrustedUpdateUrl\s*\(/);
const iOpen = downloadBody.search(/openConnection\s*\(/);
const iDigest = downloadBody.search(/MessageDigest\.getInstance\("SHA-256"\)/);
const iCompare = downloadBody.search(/!=\s*manifest\.sha256/);
const iVerify = downloadBody.search(/verifyApkIdentity\s*\(/);
const iOk = downloadBody.search(/DownloadOutcome\.Ok\s*\(/);

if (iTrust === -1) {
  failures.push(
    `SECURITY — ${K_SERVICE}: download() no longer re-checks ` +
      `UpdateManifest.isTrustedUpdateUrl before requesting the APK. parse() ` +
      `checking it is not enough: this is the last statement before an ` +
      `outbound request built from network-supplied text.`,
  );
} else if (iOpen !== -1 && iTrust > iOpen) {
  failures.push(
    `SECURITY — ${K_SERVICE}: download() opens the connection BEFORE checking ` +
      `isTrustedUpdateUrl. The check must gate the request, not follow it.`,
  );
}
if (iDigest === -1 || iCompare === -1) {
  failures.push(
    `SECURITY — ${K_SERVICE}: download() no longer hashes the stream and ` +
      `compares it to manifest.sha256. Without it a truncated, cached or ` +
      `substituted file reaches the installer.`,
  );
}
if (iVerify === -1) {
  failures.push(
    `SECURITY — ${K_SERVICE}: download() no longer calls verifyApkIdentity. ` +
      `The hash only proves the bytes match what the MANIFEST claims; the ` +
      `signer check is what makes a forged manifest insufficient to ship code.`,
  );
}
if (iOk !== -1 && iCompare !== -1 && iCompare > iOk) {
  failures.push(
    `SECURITY — ${K_SERVICE}: download() returns DownloadOutcome.Ok before it ` +
      `compares the hash. Ok is the only value the caller will install.`,
  );
}
if (iOk !== -1 && iVerify !== -1 && iVerify > iOk) {
  failures.push(
    `SECURITY — ${K_SERVICE}: download() returns DownloadOutcome.Ok before ` +
      `verifyApkIdentity. Ok is the only value the caller will install.`,
  );
}
if (!/dir\.deleteRecursively\(\)/.test(downloadBody)) {
  failures.push(
    `${K_SERVICE}: download() no longer deletes the download directory on the ` +
      `failure paths. A refused APK must not be left on disk where a later ` +
      `FileProvider grant could reach it.`,
  );
}

// Neither fetch may follow redirects — that is the way off a pinned origin.
const fetchBody = mustBlock(
  serviceSrc,
  K_SERVICE,
  /fun\s+fetchManifest\s*\(\s*\)\s*:\s*UpdateManifest\?\s*\{/,
  'the body of UpdateService.fetchManifest',
);
for (const [what, body] of [
  ['fetchManifest', fetchBody],
  ['download', downloadBody],
]) {
  if (!/instanceFollowRedirects\s*=\s*false/.test(body)) {
    failures.push(
      `SECURITY — ${K_SERVICE}: ${what}() no longer sets ` +
        `instanceFollowRedirects = false. A 30x is precisely how a request ` +
        `pinned to ${updateOrigin} ends up somewhere else.`,
    );
  }
  if (!/!is\s+HttpsURLConnection/.test(body)) {
    failures.push(
      `SECURITY — ${K_SERVICE}: ${what}() no longer asserts the connection is ` +
        `an HttpsURLConnection.`,
    );
  }
}

// --- 7. SECURITY: the signer comparison is a real comparison ---------------
const verifyBody = mustBlock(
  serviceSrc,
  K_SERVICE,
  /fun\s+verifyApkIdentity\s*\(([\s\S]{0,300}?)\)\s*:\s*String\?\s*\{/,
  'the body of UpdateService.verifyApkIdentity',
);
if (!/getPackageArchiveInfo\s*\(/.test(verifyBody)) {
  failures.push(
    `SECURITY — ${K_SERVICE}: verifyApkIdentity no longer reads the downloaded ` +
      `archive's own package info.`,
  );
}
if (!/downloadedSigners\.intersect\(installedSigners\)\.isEmpty\(\)/.test(verifyBody)) {
  failures.push(
    `SECURITY — ${K_SERVICE}: verifyApkIdentity no longer compares the ` +
      `downloaded archive's signing certificates against the running app's. ` +
      `That comparison is what makes forging an update require the release ` +
      `keystore rather than merely a foothold on the web server.`,
  );
}
if (!/archive\.packageName\s*!=\s*context\.packageName/.test(verifyBody)) {
  failures.push(
    `SECURITY — ${K_SERVICE}: verifyApkIdentity no longer checks that the ` +
      `archive is the same package as the running app.`,
  );
}

// --- 8. SECURITY: exactly one install intent, and it is on the verified path
const archiveMime = 'application/vnd.android.package-archive';
const srcFiles = walk(resolve(REPO_ROOT, SRC_ROOT));
const mimeFiles = srcFiles.filter((p) => readFileSync(p, 'utf8').includes(archiveMime));
if (mimeFiles.length !== 1 || !mimeFiles[0].endsWith('UpdateController.kt')) {
  failures.push(
    `SECURITY — the "${archiveMime}" install intent appears in ` +
      `[${mimeFiles.map((p) => p.slice(REPO_ROOT.length + 1)).join(', ')}]. ` +
      `It must appear exactly once, in UpdateController.launchInstaller, which ` +
      `is reachable only from a verified DownloadOutcome.Ok.`,
  );
}
const installerBody = mustBlock(
  controllerSrc,
  K_CONTROLLER,
  /private\s+fun\s+launchInstaller\s*\(\s*\)\s*\{/,
  'the body of UpdateController.launchInstaller',
);
if (!/val\s+file\s*=\s*verifiedApk\s*\?:\s*return/.test(installerBody)) {
  failures.push(
    `SECURITY — ${K_CONTROLLER}: launchInstaller no longer sources its file ` +
      `from \`verifiedApk\`, the field that is only ever assigned from ` +
      `DownloadOutcome.Ok. Any other source bypasses both gates.`,
  );
}
const assignments = [...controllerSrc.matchAll(/verifiedApk\s*=\s*([^\n]+)/g)].map((m) =>
  m[1].trim(),
);
const allowedAssignments = new Set(['outcome.file', 'null']);
for (const a of assignments) {
  if (!allowedAssignments.has(a)) {
    failures.push(
      `SECURITY — ${K_CONTROLLER}: \`verifiedApk = ${a}\`. This field feeds the ` +
        `install intent and may only be assigned from a verified ` +
        `DownloadOutcome.Ok (\`outcome.file\`) or cleared (\`null\`).`,
    );
  }
}
if (
  !/DownloadOutcome\.Ok\s*->\s*\{[\s\S]{0,200}?verifiedApk\s*=\s*outcome\.file/.test(controllerSrc)
) {
  failures.push(
    `SECURITY — ${K_CONTROLLER}: the DownloadOutcome.Ok branch no longer sets ` +
      `verifiedApk. If the assignment moves, re-point this assertion; do not ` +
      `delete it.`,
  );
}

// --- 9. the page cannot drive any of this ----------------------------------
if (/Update/.test(bridgeSrc)) {
  failures.push(
    `SECURITY — ${K_BRIDGE} mentions the update path. The JS bridge must have ` +
      `NO update message type: a page (or anything that reaches a page) must ` +
      `not be able to start a check, a download or an install. If an update ` +
      `message is genuinely wanted, that is a threat-model change — re-run the ` +
      `review's attack suite and update this gate deliberately.`,
  );
}

// --- 10. the permission is declared, and the production host stays HTTPS ----
if (
  !/uses-permission\s+android:name="android\.permission\.REQUEST_INSTALL_PACKAGES"/.test(
    androidManifest,
  )
) {
  failures.push(
    `${ANDROID_MANIFEST}: REQUEST_INSTALL_PACKAGES is not declared, so the ` +
      `install intent cannot work. (It grants the right to ASK; the user still ` +
      `confirms in Android's installer.)`,
  );
}
const pinBlock = netConfig.match(
  /<domain-config\s+cleartextTrafficPermitted="false">[\s\S]*?<\/domain-config>/,
);
if (!pinBlock || !pinBlock[0].includes(updateHost)) {
  failures.push(
    `SECURITY — ${NET_CONFIG}: ${updateHost} is no longer pinned to ` +
      `cleartextTrafficPermitted="false". The base-config permits cleartext ` +
      `GLOBALLY (by design — plant LAN IPs), so this domain-config is the only ` +
      `thing stopping the update host from being reachable over http.`,
  );
}

// --- 11. ANTI-DRIFT: the page describes no release of its own --------------
// HTML comments are stripped first for the same reason Kotlin comments are:
// the page's own explanation of this rule quotes the filename the rule bans.
const pageCode = pageSrc.replace(/<!--[\s\S]*?-->/g, ' ');
const hardCodedApk = pageCode.match(/[A-Za-z0-9_-]+\.apk(?![A-Za-z0-9_])/g);
if (hardCodedApk) {
  failures.push(
    `${PAGE} hard-codes an APK filename (${[...new Set(hardCodedApk)].join(', ')}). ` +
      `The page must read version.json — the same file the app reads — so the ` +
      `two can never disagree about the current release. The published page ` +
      `linked to bamform-1.1.apk while the binary said 1.0.0; that is the bug ` +
      `this check exists to prevent recurring.`,
  );
}
if (!/fetch\(\s*'version\.json'/.test(pageSrc)) {
  failures.push(
    `${PAGE} no longer reads version.json. It must fill its version label, ` +
      `download link, size and checksum from the manifest at load time.`,
  );
}
if (/[0-9a-f]{64}/.test(pageSrc)) {
  failures.push(
    `${PAGE} contains a hard-coded 64-hex string — almost certainly a SHA-256 ` +
      `of a specific build. Checksums come from version.json.`,
  );
}

// --- 12. ANTI-DRIFT: the manifest is generated by the build ----------------
const genBody = mustBlock(
  gradleSrc,
  GRADLE,
  /abstract\s+class\s+GenerateUpdateManifest\s*:\s*DefaultTask\(\)\s*\{/,
  'the GenerateUpdateManifest task class',
);
for (const [re, what] of [
  [/builtArtifactsLoader\.get\(\)\.load\(/, "AGP's built-artifact metadata for the APK"],
  [/element\.versionCode/, 'versionCode read from the built artefact'],
  [/element\.versionName/, 'versionName read from the built artefact'],
  [/sha256Of\(publishedApk\)/, 'the SHA-256 computed from the published APK'],
]) {
  if (!re.test(genBody)) {
    failures.push(
      `${GRADLE}: GenerateUpdateManifest no longer derives ${what}. Every ` +
        `field except the release note must come from the binary; a ` +
        `hand-supplied value can drift from it, and an installed app decides ` +
        `whether to download new code based on that value.`,
    );
  }
}
if (!/finalizedBy\(manifestTask\)/.test(gradleSrc)) {
  failures.push(
    `${GRADLE}: assembleRelease no longer finalizedBy the manifest task, so a ` +
      `release can be produced without its manifest — and the stale one beside ` +
      `it would keep describing the previous binary.`,
  );
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error('FAIL: Android shell update-channel contract violated\n');
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(
  `PASS: Android shell update channel — origin pinned to ${updateOrigin} ` +
    `(manifest ${manifestUrl}), Gradle publishes to the same origin; ` +
    `isTrustedUpdateUrl keeps ${TRUST_RULES.length} rules; the update sources ` +
    `never consult the configured content origin; download() checks the URL ` +
    `before connecting and verifies SHA-256 + signer certificate before Ok; ` +
    `neither fetch follows redirects; exactly one install intent, fed only by ` +
    `verifiedApk; the bridge exposes nothing; ${updateHost} stays HTTPS-only; ` +
    `the download page hard-codes no release; version.json is generated from ` +
    `the built APK and assembleRelease cannot skip it.`,
);
