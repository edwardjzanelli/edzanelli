// scripts/sync-seniorminder-voice.mjs
//
// THE ONLY WAY vendor/seniorminder/ CHANGES. It copies SeniorMinder's voice-health measurement, the build that bundles
// it for the browser, and the parity bench that proves the bundle identical to the source, at the paths they have in
// SeniorMinder, and stamps vendor/seniorminder/VENDORED.json with the source commit, the date, and every file's
// SHA-256. build:voice (scripts/build-voice.mjs) refuses to build from a vendored tree that differs from that stamp.
//
//   node scripts/sync-seniorminder-voice.mjs [--from <SeniorMinder checkout>]    default C:\work\SeniorMinder\seniorminder
//
// The file list is never written by hand. It is three parts, each computed from the checkout:
//   1. the files the bundle reaches: the metafile of an esbuild run with build-voice-browser.mjs's own entry, options
//      and stubs. Its output is compared with what buildVoiceBrowser itself writes, banner aside; any difference and
//      the sync refuses, so the list is the list of the real bundle;
//   2. the build: scripts/build-voice-browser.mjs and every tracked file under scripts/voice-browser/;
//   3. the parity bench, packages/voice/test/test-voice-browser-parity.js, and every module it reaches under Node
//      (an esbuild metafile with only third-party packages left external), plus the package.json of each package
//      those modules sit in, which Node needs for "type": "module" and for the @seniorminder/* exports.
// Every file must be tracked and unchanged in the checkout, or the sync refuses. What is copied is the committed blob
// at HEAD (git cat-file), not the working tree, so line endings are the commit's on every machine.
// Vendored files no longer in the list are deleted. node_modules under vendor/ (build:voice's esbuild) is left alone.
//
// 4. packages/voice/src/SentimentAnalyzer.js, for the Voice page's sentiment card. The Lambda scores sentiment the
//    way SeniorMinder does, so the sync hands it what it needs, read out of SeniorMinder rather than retyped:
//      lambda/session-token/sentiment-prompt.txt    the prompt the vendored analyzer sends, byte for byte, with
//                                                   {{transcript}} where it puts the trimmed transcript;
//      lambda/session-token/sentiment-request.json  the model, max_tokens and the fewest words it scores.
//    The prompt, max_tokens and the word floor come from running the vendored analyzer itself against a stand-in
//    LLM service that records what it is asked. The model is not in the analyzer: SchedulerInit.js builds its
//    LLM service with an OpenAIProvider, and the sync reads that model from SchedulerInit.js at the same commit.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerVendoredSeniorMinder, vendored } from './seniorminder-resolve.mjs';

const SITE = fileURLToPath(new URL('..', import.meta.url));
const LAMBDA = path.join(SITE, 'lambda', 'session-token');
const VENDOR = path.join(SITE, 'vendor', 'seniorminder');
const STAMP = path.join(VENDOR, 'VENDORED.json');
const DEFAULT_FROM = 'C:\\work\\SeniorMinder\\seniorminder';

const BUILD_SCRIPT = 'scripts/build-voice-browser.mjs';
const BENCH = 'packages/voice/test/test-voice-browser-parity.js';
const SENTIMENT = 'packages/voice/src/SentimentAnalyzer.js';
const SCHEDULER = 'packages/orchestrator/src/scheduler/SchedulerInit.js';
const PLACEHOLDER = '{{transcript}}';

function fail(message) {
    console.error(`sync-seniorminder-voice: ${message}`);
    process.exit(1);
}

const i = process.argv.indexOf('--from');
const FROM = path.resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1] : DEFAULT_FROM);
if (!existsSync(path.join(FROM, BUILD_SCRIPT))) fail(`${FROM} is not a SeniorMinder checkout (no ${BUILD_SCRIPT})`);
// esbuild writes each module's path, relative to the working directory its service started in, as a comment; every
// build below runs from the checkout, as build-voice-browser.mjs does there. Every path here is absolute.
process.chdir(FROM);

const git = (args, opts = {}) => execFileSync('git', args, { cwd: FROM, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts });
const posix = (p) => p.split(path.sep).join('/');

let esbuild;
try {
    esbuild = createRequire(path.join(FROM, 'scripts', 'voice-browser', 'package.json'))('esbuild');
} catch {
    fail(`esbuild is not installed in the checkout; run there: npm ci --prefix scripts/voice-browser`);
}

// ── 1. the files the bundle reaches ─────────────────────────────────────────────────────────────────────────────
// The same entry, options and swaps as build-voice-browser.mjs, with a metafile. The swaps are restated here because
// the build does not export its plugin; the output comparison below is what makes the restatement safe.
const TOOL = path.join(FROM, 'scripts', 'voice-browser');
const STUBS = path.join(TOOL, 'stubs');
const VOICE_SRC = path.join(FROM, 'packages', 'voice', 'src');
const STUB_PACKAGES = { '@seniorminder/logger': 'logger.js', 'child_process': 'spawn.js', 'node:child_process': 'spawn.js' };
const STUB_SOURCES = new Set(['SpeechTranscriber.js', 'EnhancedProcessingService.js']);
const browserStubs = {
    name: 'voice-browser-stubs',
    setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === 'entry-point') return undefined;
            if (STUB_PACKAGES[args.path]) return { path: path.join(STUBS, STUB_PACKAGES[args.path]) };
            if (args.path.startsWith('.')) {
                const abs = path.resolve(args.resolveDir, args.path);
                if (path.dirname(abs) === VOICE_SRC && STUB_SOURCES.has(path.basename(abs))) return { path: path.join(STUBS, 'unavailable.js') };
                return undefined;
            }
            return { errors: [{ text: `"${args.path}" is not in the browser bundle` }] };
        });
    },
};
const listed = await esbuild.build({
    entryPoints: [path.join(TOOL, 'entry.js')],
    outfile: path.join(os.tmpdir(), 'voice-health-browser-sync.js'),
    write: false, metafile: true, absWorkingDir: FROM,
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', charset: 'utf8', legalComments: 'none',
    plugins: [browserStubs], logLevel: 'silent',
});
const bundleFiles = Object.keys(listed.metafile.inputs);

// The real build, to a temporary file: its code, banner aside, must be the code the metafile describes.
const { buildVoiceBrowser } = await import(pathToFileURL(path.join(FROM, BUILD_SCRIPT)).href);
const realOut = path.join(os.tmpdir(), `voice-health-browser-sync-${process.pid}.js`);
let real;
try {
    await buildVoiceBrowser({ out: realOut });
    real = readFileSync(realOut, 'utf8');
} finally {
    rmSync(realOut, { force: true });
}
const code = (text) => text.replace(/^\n+/, '');
if (code(real.split('\n').slice(3).join('\n')) !== code(listed.outputFiles[0].text)) fail('the restated build does not produce the bundle build-voice-browser.mjs produces; update the swaps above to match it');

// ── 2. the build ────────────────────────────────────────────────────────────────────────────────────────────────
const buildFiles = [BUILD_SCRIPT, ...git(['ls-files', '--', 'scripts/voice-browser']).split('\n').filter(Boolean)];

// ── 3. the parity bench and what it reaches under Node ──────────────────────────────────────────────────────────
const thirdPartyExternal = {
    name: 'third-party-external',
    setup(build) {
        build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (args.kind === 'entry-point' || path.isAbsolute(args.path) || args.path.startsWith('@seniorminder/')) return undefined;
            return { path: args.path, external: true };
        });
    },
};
const bench = await esbuild.build({
    entryPoints: [path.join(FROM, BENCH)], absWorkingDir: FROM,
    bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', outfile: 'bench.js',
    plugins: [thirdPartyExternal], logLevel: 'silent',
});
const benchFiles = Object.keys(bench.metafile.inputs);
const packageJsons = [...new Set(benchFiles.map((f) => f.match(/^packages\/[^/]+\//)?.[0]).filter(Boolean))].map((p) => `${p}package.json`);
const benchExternals = [...new Set(Object.values(bench.metafile.outputs).flatMap((o) => o.imports.filter((x) => x.external).map((x) => x.path)))]
    .filter((p) => !p.startsWith('node:') && !builtinModules.includes(p));

// ── the list, checked against the checkout ──────────────────────────────────────────────────────────────────────
const files = [...new Set([...bundleFiles, ...buildFiles, ...benchFiles, ...packageJsons, SENTIMENT].map(posix))].sort();
const outside = files.filter((f) => f.startsWith('..') || path.isAbsolute(f) || f.includes('node_modules/'));
if (outside.length) fail(`files outside the checkout's own tree:\n  ${outside.join('\n  ')}`);

const tracked = new Set(git(['ls-files', '--', ...files]).split('\n').filter(Boolean));
const untracked = files.filter((f) => !tracked.has(f));
if (untracked.length) fail(`not tracked in SeniorMinder (commit them first):\n  ${untracked.join('\n  ')}`);
const changed = git(['status', '--porcelain', '--', ...files]).split('\n').filter(Boolean);
if (changed.length) fail(`uncommitted changes in SeniorMinder (commit or stash them first):\n  ${changed.join('\n  ')}`);

const commit = git(['rev-parse', 'HEAD']).trim();

// ── copy, prune, stamp ──────────────────────────────────────────────────────────────────────────────────────────
const stamped = [];
for (const f of files) {
    const bytes = execFileSync('git', ['cat-file', 'blob', `${commit}:${f}`], { cwd: FROM, maxBuffer: 64 << 20 });
    const dest = path.join(VENDOR, ...f.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    stamped.push({ path: f, sha256: createHash('sha256').update(bytes).digest('hex') });
}

const keep = new Set(files);
const removed = [];
function prune(rel = '') {
    const dir = path.join(VENDOR, rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            prune(p);
            if (readdirSync(path.join(VENDOR, p)).length === 0) rmdirSync(path.join(VENDOR, p));
        } else if (p !== 'VENDORED.json' && !keep.has(p)) {
            rmSync(path.join(VENDOR, p));
            removed.push(p);
        }
    }
}
prune();

writeFileSync(STAMP, JSON.stringify({
    source: 'SeniorMinder',
    commit,
    date: new Date().toISOString(),
    syncedBy: 'scripts/sync-seniorminder-voice.mjs',
    note: 'Generated. Do not edit anything under vendor/seniorminder by hand; run the sync script again.',
    benchNeeds: benchExternals,
    files: stamped,
}, null, 2) + '\n');

// ── 4. the sentiment prompt and request, for the Lambda ─────────────────────────────────────────────────────────
registerVendoredSeniorMinder();
const { SentimentAnalyzer } = await import(vendored(SENTIMENT));
const asked = [];
const analyzer = new SentimentAnalyzer({
    llmService: { generateCompletion: async (prompt, options) => { asked.push({ prompt, options }); return '{}'; } },
});
const words = (n) => Array.from({ length: n }, () => 'word').join(' ');

let minWords = null;
for (let n = 1; n <= 50 && minWords === null; n++) {
    asked.length = 0;
    await analyzer.analyze(words(n));
    if (asked.length) minWords = n;
}
if (minWords === null) fail(`${SENTIMENT} sent nothing for up to 50 words; the sync cannot read its prompt`);

const marker = `sync-marker-5e0c ${words(minWords)}`;
asked.length = 0;
await analyzer.analyze(marker);
const [{ prompt, options }] = asked;
if (prompt.includes(PLACEHOLDER)) fail(`the prompt in ${SENTIMENT} already contains ${PLACEHOLDER}`);
if (prompt.split(marker).length !== 2) fail(`the transcript does not appear exactly once in the prompt ${SENTIMENT} sends`);
const unknown = Object.keys(options ?? {}).filter((k) => k !== 'maxTokens');
if (unknown.length) fail(`${SENTIMENT} now passes ${unknown.join(', ')} to the LLM service; the Lambda mirrors only maxTokens`);

const scheduler = execFileSync('git', ['cat-file', 'blob', `${commit}:${SCHEDULER}`], { cwd: FROM, encoding: 'utf8', maxBuffer: 64 << 20 });
if (!/new SentimentAnalyzer\(\{ llmService: state\.llmService \}\)/.test(scheduler)) fail(`${SCHEDULER} no longer builds the SentimentAnalyzer on state.llmService`);
const models = [...scheduler.matchAll(/new OpenAIProvider\(\{ model: '([^']+)' \}\)/g)].map((m) => m[1]);
if (models.length !== 1) fail(`expected one OpenAIProvider model in ${SCHEDULER}, found ${models.length}`);

writeFileSync(path.join(LAMBDA, 'sentiment-prompt.txt'), prompt.replace(marker, PLACEHOLDER));
writeFileSync(path.join(LAMBDA, 'sentiment-request.json'), JSON.stringify({
    note: 'Generated by scripts/sync-seniorminder-voice.mjs. Do not edit; run the sync again.',
    model: models[0],
    max_tokens: options.maxTokens,
    min_words: minWords,
    placeholder: PLACEHOLDER,
    source: { commit, prompt_and_max_tokens_and_min_words: SENTIMENT, model: SCHEDULER },
}, null, 2) + '\n');

console.log(`vendored ${files.length} files from SeniorMinder ${commit} into ${posix(path.relative(SITE, VENDOR))}/`);
console.log(`  sentiment: wrote lambda/session-token/sentiment-prompt.txt (${prompt.length - marker.length} characters around the transcript) and sentiment-request.json (${models[0]}, max_tokens ${options.maxTokens}, at least ${minWords} words)`);
console.log(`  bundle ${bundleFiles.length}, build ${buildFiles.length}, bench and its modules ${benchFiles.length + packageJsons.length} (overlapping)`);
if (removed.length) console.log(`  removed ${removed.length} no longer listed: ${removed.join(', ')}`);
console.log(`  the bench also needs, from npm: ${benchExternals.join(', ') || 'nothing'}`);
