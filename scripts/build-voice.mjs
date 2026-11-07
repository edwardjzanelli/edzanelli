// scripts/build-voice.mjs (npm run build:voice)
//
// Builds website/js/vendor/voice-health-browser.js, the Voice page's measureVoice, from the vendored SeniorMinder
// source with SeniorMinder's own build script, unchanged. No SeniorMinder checkout is needed.
//
//   1. Every file under vendor/seniorminder/ must match vendor/seniorminder/VENDORED.json (same list, same SHA-256),
//      so the bundle is built from exactly what scripts/sync-seniorminder-voice.mjs copied, or not at all.
//   2. vendor/seniorminder/scripts/build-voice-browser.mjs builds it. It finds esbuild where it always does, under
//      its own scripts/voice-browser/, where build:voice installs it first with npm ci from the vendored lockfile.
//      It runs from vendor/seniorminder/, as it runs from the SeniorMinder root, so the module path comments esbuild
//      writes are the same and the code below the banner is byte for byte what SeniorMinder's build writes.
//   3. The banner's source commit is the build script's own `git rev-parse HEAD`, which here would be this
//      repository's commit, not SeniorMinder's. That one comment line is replaced with the commit in VENDORED.json.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = path.join(SITE, 'vendor', 'seniorminder');
const OUT = path.join(SITE, 'website', 'js', 'vendor', 'voice-health-browser.js');

function fail(message) {
    console.error(`build-voice: ${message}`);
    process.exit(1);
}

const stamp = JSON.parse(readFileSync(path.join(VENDOR, 'VENDORED.json'), 'utf8'));

function onDisk(rel = '') {
    const found = [];
    for (const entry of readdirSync(path.join(VENDOR, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') found.push(...onDisk(p)); }
        else if (p !== 'VENDORED.json') found.push(p);
    }
    return found;
}
const listed = new Set(stamp.files.map((f) => f.path));
const extra = onDisk().filter((p) => !listed.has(p));
const differ = stamp.files.filter((f) => {
    try { return createHash('sha256').update(readFileSync(path.join(VENDOR, ...f.path.split('/')))).digest('hex') !== f.sha256; }
    catch { return true; }
});
if (extra.length || differ.length) {
    fail(`vendor/seniorminder/ does not match VENDORED.json (change it only with scripts/sync-seniorminder-voice.mjs):\n`
        + [...differ.map((f) => `  changed or missing: ${f.path}`), ...extra.map((p) => `  not listed: ${p}`)].join('\n'));
}

process.chdir(VENDOR);
const { buildVoiceBrowser } = await import(pathToFileURL(path.join(VENDOR, 'scripts', 'build-voice-browser.mjs')).href);
let built;
try {
    built = await buildVoiceBrowser({ out: OUT });
} catch (e) {
    fail(e.message);
}

const lines = readFileSync(OUT, 'utf8').split('\n');
if (!lines[1].startsWith('// Source commit: ')) fail(`unexpected banner in ${OUT}: ${lines[1]}`);
lines[1] = `// Source commit: ${stamp.commit} (SeniorMinder, vendored into edzanelli.com and verified against vendor/seniorminder/VENDORED.json)`;
writeFileSync(OUT, lines.join('\n'));

console.log(`built website/js/vendor/voice-health-browser.js: ${built.bytes} bytes (${built.gzipBytes} gzipped), SeniorMinder ${stamp.commit.slice(0, 8)}, ${stamp.files.length} vendored files verified`);
