// scripts/build-voice-browser.mjs
//
// BUILDS dist/voice-health-browser.js: the voice-health measurement as one browser ES module, for the static page
// on edzanelli.com (another repo). One export, measureVoice(float32Pcm16k, { transcript }) → { metrics, floored,
// evidence } — analyzeAudio's measure-and-floor stage (VoiceAnalyticsService.measurePcm, then applyReliabilityFloors),
// bundled from the source modules unchanged: AudioProcessor (speechSpanOf, countSyllables), MetricsCalculator,
// LevelGate, ReliabilityFloors (the floors), WordCount, utils/Constants.
//
// What is swapped at build time, and only at build time (scripts/voice-browser/stubs):
//   @seniorminder/logger           → no-op AppLogger and guardChild (the real one writes files)
//   child_process                  → a spawn that throws (only AudioProcessor.getAudioData decodes with ffmpeg)
//   SpeechTranscriber.js,
//   EnhancedProcessingService.js   → classes that throw if constructed (VoiceAnalyticsService builds them lazily;
//                                    measurePcm never does). Their fs/path/url/worker imports never enter the bundle.
// Any other Node built-in or package a source module reaches fails the build: nothing is resolved silently.
//
// The output is refused (exit 1, file removed) if it contains a node: import, require(, fs, child_process or
// process. — the page must not depend on Node. The header stamps the source commit and the build date; a source
// tree that differs from that commit is stamped so.
//
// dist/ is gitignored. esbuild is a build-only dependency kept out of the workspace tree:
//   npm ci --prefix scripts/voice-browser        (once)
//   node scripts/build-voice-browser.mjs         (writes dist/voice-health-browser.js)
//   node scripts/build-voice-browser.mjs --out <file>

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOL = path.join(ROOT, 'scripts', 'voice-browser');
const STUBS = path.join(TOOL, 'stubs');
const VOICE_SRC = path.join(ROOT, 'packages', 'voice', 'src');
export const DEFAULT_OUT = path.join(ROOT, 'dist', 'voice-health-browser.js');

/** Patterns the bundle must not contain. Each is a Node dependency the page cannot have. */
export const FORBIDDEN = Object.freeze([
    ['node: import', /["']node:/],
    ['require(', /\brequire\s*\(/],
    ['fs', /\bfs\b/],
    ['child_process', /child_process/],
    ['process.', /(?<![\w$.])process\./],
]);

/** Every forbidden reference in `code`, with its line. */
export function forbiddenIn(code) {
    const hits = [];
    code.split('\n').forEach((line, i) => {
        for (const [name, re] of FORBIDDEN) if (re.test(line)) hits.push({ name, line: i + 1, text: line.trim().slice(0, 120) });
    });
    return hits;
}

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** The source commit, and whether the bundled sources differ from it. */
function sourceStamp() {
    let commit = 'unknown', dirty = false;
    try {
        commit = git(['rev-parse', 'HEAD']);
        dirty = git(['status', '--porcelain', '--', 'packages/voice/src', 'scripts/voice-browser', 'scripts/build-voice-browser.mjs']) !== '';
    } catch { /* not a git checkout: the stamp says unknown */ }
    return { commit, dirty };
}

const STUB_PACKAGES = { '@seniorminder/logger': 'logger.js', 'child_process': 'spawn.js', 'node:child_process': 'spawn.js' };
const STUB_SOURCES = new Set(['SpeechTranscriber.js', 'EnhancedProcessingService.js']);

/** The build-time swaps above, and a refusal for any other bare import. */
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
            return { errors: [{ text: `"${args.path}" (imported by ${path.relative(ROOT, args.importer)}) is not in the browser bundle — stub it in scripts/build-voice-browser.mjs or keep it out of the measurement` }] };
        });
    },
};

/** Build the bundle to `out`. Returns { out, bytes, gzipBytes, commit, dirty, builtAt }. Throws on any refusal. */
export async function buildVoiceBrowser({ out = DEFAULT_OUT } = {}) {
    let esbuild;
    try {
        esbuild = createRequire(path.join(TOOL, 'package.json'))('esbuild');
    } catch {
        throw new Error('esbuild is not installed for this build — run: npm ci --prefix scripts/voice-browser');
    }
    const { commit, dirty } = sourceStamp();
    const builtAt = new Date().toISOString();
    const banner = [
        '// voice-health-browser.js — SeniorMinder voice-health measurement (measureVoice), bundled for the browser.',
        `// Source commit: ${commit}${dirty ? ' (the bundled sources differed from this commit when built)' : ''}`,
        `// Built: ${builtAt} by scripts/build-voice-browser.mjs. Generated file; do not edit.`,
    ].join('\n');

    mkdirSync(path.dirname(out), { recursive: true });
    await esbuild.build({
        entryPoints: [path.join(TOOL, 'entry.js')],
        outfile: out,
        bundle: true,
        format: 'esm',
        platform: 'neutral',
        target: 'es2022',
        charset: 'utf8',
        legalComments: 'none',
        banner: { js: banner },
        plugins: [browserStubs],
        logLevel: 'silent',
    });

    const code = readFileSync(out, 'utf8');
    const hits = forbiddenIn(code);
    if (hits.length) {
        rmSync(out, { force: true });
        throw new Error(`the bundle references Node — refused:\n${hits.map((h) => `  ${h.name} at line ${h.line}: ${h.text}`).join('\n')}`);
    }
    return { out, bytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length, commit, dirty, builtAt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const i = process.argv.indexOf('--out');
    const out = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : DEFAULT_OUT;
    try {
        const r = await buildVoiceBrowser({ out });
        console.log(`wrote ${path.relative(ROOT, r.out) || r.out}: ${r.bytes} bytes (${r.gzipBytes} gzipped), source ${r.commit}${r.dirty ? ' (sources differ from it)' : ''}, built ${r.builtAt}`);
        if (!existsSync(r.out)) process.exit(1);
    } catch (e) {
        console.error(`build-voice-browser: ${e.message}`);
        process.exit(1);
    }
}
