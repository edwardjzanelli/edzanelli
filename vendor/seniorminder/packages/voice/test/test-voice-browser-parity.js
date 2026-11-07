// packages/voice/test/test-voice-browser-parity.js
// @what     builds the browser bundle (scripts/build-voice-browser.mjs) and feeds the same PCM through it and through measurePcm + applyReliabilityFloors
// @expects  every metric, every floored entry and every evidence count from measureVoice is identical to the source's, and the bundle has no Node reference
//
//
// THE BROWSER VERSION IS THE SAME MEASUREMENT (Ed, 2026-11-06). dist/voice-health-browser.js is built for a static
// page on edzanelli.com (another repo): the source modules bundled unchanged, the logger and the Node-only modules
// stubbed at build time. Its one export, measureVoice(pcm, { transcript }), must give exactly what analyzeAudio's
// measure-and-floor stage gives on the same PCM — not close: identical, value for value (Object.is), so a reading on
// the page is a reading SeniorMinder would have stored.
//
// The bench builds its own copy into the temp directory (dist/ is not committed and may be stale), then compares on:
//   (1) synthetic known-answer signals from the voice-health benches (their generators, copied), each also checked
//       against its known answer on the bundle's side — so two equally wrong readings cannot pass as parity;
//   (2) the desk clip in the tree (…_attempt_3.wav, keyboard clicks, gitignored, on this box) and dev1's take 003
//       (C:/tmp/voiceprint/dev1-room, outside the repo); each SKIPs where it is not on disk;
//   (3) one synthetic 45 s voiced signal — LibriVox and Richard's clips live outside the repo and stay there.
// It also prints the bundle's size and measureVoice's time on the 45 s buffer (information, not a pin).
//
// Needs esbuild for the build: npm ci --prefix scripts/voice-browser. Without it the bench FAILS, never skips.
//
// Run:  node packages/voice/test/test-voice-browser-parity.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeWav } from '@seniorminder/common/WavDecoder';
import { VoiceAnalyticsService } from '../src/VoiceAnalyticsService.js';
import { applyReliabilityFloors, METRIC_PATHS } from '../src/ReliabilityFloors.js';
import { buildVoiceBrowser, forbiddenIn } from '../../../scripts/build-voice-browser.mjs';

let pass = 0, fail = 0;
function assert(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const SR = 16000;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const vas = new VoiceAnalyticsService({ ffmpegLocator: { getPath: () => 'ffmpeg' } });
const get = (o, m) => METRIC_PATHS[m].reduce((v, k) => v?.[k], o);

/** Every path at which `a` and `b` differ (Object.is on leaves, so NaN = NaN and 0 ≠ −0), and the leaves compared. */
function differences(a, b, at = '', out = { diffs: [], leaves: 0 }) {
    const isObj = (v) => v !== null && typeof v === 'object';
    if (isObj(a) && isObj(b)) {
        if (Array.isArray(a) !== Array.isArray(b)) { out.diffs.push(`${at || '.'}: array vs object`); return out; }
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
            if (!(k in a) || !(k in b)) { out.diffs.push(`${at}.${k}: only in ${k in a ? 'source' : 'bundle'}`); continue; }
            differences(a[k], b[k], `${at}.${k}`, out);
        }
        return out;
    }
    out.leaves++;
    if (!Object.is(a, b)) out.diffs.push(`${at || '.'}: source ${JSON.stringify(a)} vs bundle ${JSON.stringify(b)}`);
    return out;
}

/** The source's measure-and-floor stage, as analyzeAudio runs it. */
function sourceStage(pcm, transcript) {
    const transcripts = typeof transcript === 'string' ? [{ text: transcript, source: 'whisper' }] : [];
    const { result, floored } = applyReliabilityFloors(vas.measurePcm(pcm, { transcripts }));
    return { metrics: result, floored, evidence: result.evidence };
}

// ── signals (the voice-health benches' generators) ──────────────────────────────────────────────────────
function rng(seed) {   // mulberry32 (four-metrics bench)
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gaussian(rand) { const u = Math.max(rand(), 1e-12), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function harmonic(seconds, f0, harmonics, power) {   // four-metrics bench
    const n = Math.round(seconds * SR), x = new Float32Array(n), a = Math.sqrt(2 * power / harmonics.length);
    for (let i = 0; i < n; i++) { let v = 0; for (const k of harmonics) v += Math.sin(2 * Math.PI * k * f0 * i / SR); x[i] = a * v; }
    return x;
}
function addNoise(x, power, seed) { const r = rng(seed), s = Math.sqrt(power); for (let i = 0; i < x.length; i++) x[i] += s * gaussian(r); return x; }
function concat(parts) { const n = parts.reduce((s, p) => s + p.length, 0), out = new Float32Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
function bursts(seconds, onMs, offMs) {   // four-metrics bench
    const n = Math.round(seconds * SR), x = new Float32Array(n), voice = harmonic(seconds, 125, [1, 2, 3, 4, 5], 0.045);
    const on = Math.round(onMs * SR / 1000), period = Math.round((onMs + offMs) * SR / 1000);
    for (let i = 0; i < n; i++) if (i % period < on) x[i] = voice[i];
    return x;
}
const silence = (seconds) => addNoise(new Float32Array(Math.round(seconds * SR)), 1e-7, 7);   // −70 dBFS room
const complex = (seconds, f0, gain) => {   // whole-span bench
    const n = Math.round(seconds * SR), x = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = 0; for (let k = 1; k <= 5; k++) v += Math.sin(2 * Math.PI * k * f0 * i / SR) / k; x[i] = gain * v / 3; }
    return x;
};
function complexAmps(seconds, f0, amps) {   // words-floors-octave bench
    const n = Math.round(seconds * SR), x = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = 0; amps.forEach((a, k) => { v += a * Math.sin(2 * Math.PI * (k + 1) * f0 * i / SR); }); x[i] = v / 5; }
    return x;
}
function fullScaleSine(seconds) { const x = new Float32Array(Math.round(seconds * SR)); for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * 440 * i / SR); return x; }

/**
 * 45 s of voiced "speech": a glottal-like harmonic source whose F0 glides on a phrase contour (100–160 Hz, mean
 * ~128 Hz), shaped into syllables (120–260 ms) and words, phrases of 2–4 s separated by 300–900 ms pauses, a
 * slowly varying level (±6 dB), and a −60 dBFS room. Seeded: the same samples every run.
 */
function voiced45() {
    const r = rng(45), n = 45 * SR, x = new Float32Array(n);
    let i = Math.round(0.6 * SR), phase = 0;
    while (i < n - SR) {
        const phraseLen = Math.round((2 + 2 * r()) * SR), start = i, f0Base = 110 + 30 * r();
        let s = 0;
        while (s < phraseLen && i < n - SR) {
            const syl = Math.round((0.12 + 0.14 * r()) * SR), gap = Math.round((0.02 + 0.06 * r()) * SR), level = 0.08 * 10 ** ((r() * 12 - 6) / 20);
            for (let k = 0; k < syl && i < n; k++, i++) {
                const t = (i - start) / phraseLen, f0 = f0Base * (1 + 0.18 * Math.sin(Math.PI * t) - 0.08 * t);
                phase += 2 * Math.PI * f0 / SR;
                let v = 0; for (let h = 1; h <= 8; h++) v += Math.sin(h * phase) / h ** 1.2;
                x[i] = level * Math.sin(Math.PI * k / syl) * v;
            }
            i += gap; s += syl + gap;
        }
        i += Math.round((0.3 + 0.6 * r()) * SR);
    }
    return addNoise(x, 1e-6, 46);
}

// ── (0) the bundle ──────────────────────────────────────────────────────────────────────────────────────
console.log('\n(0) the bundle builds, with no Node reference');
const out = path.join(os.tmpdir(), `voice-health-browser-parity-${process.pid}.mjs`);
let bundle = null, built = null;
try {
    built = await buildVoiceBrowser({ out });
    bundle = await import(pathToFileURL(out).href);
} catch (e) {
    assert('0a the bundle builds and loads', false, e.message);
}
if (bundle) {
    const code = fs.readFileSync(out, 'utf8');
    assert('0a the bundle builds and loads; its one export is measureVoice', Object.keys(bundle).join(',') === 'measureVoice',
        `${built.bytes} bytes (${built.gzipBytes} gzipped)`);
    assert('0b its header stamps the source commit and the build date',
        code.startsWith('// voice-health-browser.js') && code.split('\n').slice(0, 3).join('\n').includes(built.commit) && code.includes(`Built: ${built.builtAt}`),
        `commit ${built.commit.slice(0, 8)}${built.dirty ? ' (sources differ from it)' : ''}`);
    // the refusal itself, on its known answers: each forbidden shape is caught, and the bundle has none
    const shapes = ['import fs from "node:fs";', 'const x = require("y");', 'fs.readFileSync(p)', 'import("child_process")', 'if (process.env.X) {}'];
    assert('0c the Node-reference check catches each forbidden shape', shapes.every((s) => forbiddenIn(s).length > 0),
        shapes.map((s) => `${forbiddenIn(s).map((h) => h.name).join('+') || 'MISSED'}`).join(', '));
    assert('0d and the bundle has none', forbiddenIn(code).length === 0, `${forbiddenIn(code).length} hits`);
}

/** Parity on one input, with an optional known answer checked on the bundle's reading. */
function parity(name, pcm, transcript, known) {
    if (!bundle) { assert(`${name}: parity`, false, 'no bundle'); return null; }
    const src = sourceStage(pcm, transcript);
    const web = bundle.measureVoice(pcm, transcript === undefined ? {} : { transcript });
    const m = differences(src.metrics, web.metrics), f = differences(src.floored, web.floored), e = differences(src.evidence, web.evidence);
    const all = [...m.diffs.map((d) => `metrics${d}`), ...f.diffs.map((d) => `floored${d}`), ...e.diffs.map((d) => `evidence${d}`)];
    const recorded = Object.keys(METRIC_PATHS).filter((k) => get(web.metrics, k) != null).length;
    assert(`${name}: identical`, all.length === 0,
        all.length ? all.slice(0, 6).join('; ') : `${m.leaves} metric leaves, ${src.floored.length} floored, ${e.leaves} evidence counts; ${recorded} recorded`);
    if (known) { const [label, ok, detail] = known(web); assert(`${name}: ${label}`, ok, detail); }
    return web;
}

// ── (1) synthetic known-answer signals ──────────────────────────────────────────────────────────────────
console.log('\n(1) synthetic known-answer signals (the voice-health benches)');
{
    // Each signal is long enough that the metric its known answer is about clears its floor (ReliabilityFloors.FLOORS),
    // so the known answer is read, not skipped.
    parity('1a full-scale 440 Hz sine, 2 s', fullScaleSine(2), undefined,
        (w) => ['volume mean is −3.01 ± 0.1 dBFS', Math.abs(w.metrics.volume.mean_db + 3.01) <= 0.1, `mean ${w.metrics.volume.mean_db}`]);
    const P = 0.02, Pn = P / 10;
    parity('1b 125 Hz five-harmonic complex at 10 dB SNR, 8 s', concat([silence(0.5), addNoise(harmonic(8, 125, [1, 2, 3, 4, 5], P), Pn, 11), silence(0.5)]), 'and will I need a jacket',
        (w) => ['HNR 10 ± 2 dB, pitch 125 ± 2 Hz', Math.abs(w.metrics.voiceQuality.harmonic_to_noise - 10) <= 2 && Math.abs(w.metrics.pitch.mean_hz - 125) <= 2,
            `HNR ${w.metrics.voiceQuality.harmonic_to_noise} dB, pitch ${w.metrics.pitch.mean_hz} Hz`]);
    const fast = bursts(2, 120, 80), slow = bursts(2, 300, 400);
    parity('1c fast and slow 2 s burst segments alternating, 32 s', concat(Array.from({ length: 8 }, () => [fast, slow]).flat()), 'one two three four five six seven eight nine ten eleven twelve',
        (w) => ['speech rate variability > 0.3 (fast 10, slow 3 syllables per segment)', w.metrics.cadence.speech_rate_variability > 0.3, `CV ${w.metrics.cadence.speech_rate_variability}, ${w.evidence.speechSegments} segments`]);
    parity('1d 3 s at one level then 3 s 6 dB quieter (whole span)', concat([new Float32Array(SR / 2), complex(3, 120, 0.5), complex(3, 120, 0.25), new Float32Array(SR / 2)]), undefined,
        (w) => ['volume std 3 ± 0.3 dB, pitch 120 ± 2 Hz', Math.abs(w.metrics.volume.std_dev - 3) <= 0.3 && Math.abs(w.metrics.pitch.mean_hz - 120) <= 2,
            `std ${w.metrics.volume.std_dev} dB, pitch ${w.metrics.pitch.mean_hz} Hz`]);
    parity('1e 100 Hz complex with a stronger 2nd harmonic, 6 s', concat([silence(0.5), complexAmps(6, 100, [1, 2.5, 0.5, 0.3, 0.2]), silence(0.5)]), undefined,
        (w) => ['pitch reads 100 ± 2 Hz, not 200', Math.abs(w.metrics.pitch.mean_hz - 100) <= 2, `pitch ${w.metrics.pitch.mean_hz} Hz`]);
    parity('1f digital silence with a transcript, 1 s', new Float32Array(SR), 'hello',
        (w) => ['records nothing', Object.keys(METRIC_PATHS).every((k) => get(w.metrics, k) == null) && w.evidence.spanFound === false, `spanFound ${w.evidence.spanFound}`]);
    parity('1g a −70 dBFS room, no speech, 3 s', silence(3), '(keyboard clicking)',
        (w) => ['records nothing', Object.keys(METRIC_PATHS).every((k) => get(w.metrics, k) == null), `${w.floored.length} floored`]);
}

// ── (2) recordings on this box ──────────────────────────────────────────────────────────────────────────
console.log('\n(2) recordings on this box (each read where it is on disk; none is copied into the repo)');
{
    const desk = path.join(ROOT, 'packages/electron-app/audio/2026/05/13/01KRHTTQ8KQ7N2SYKPESFT3A4X/00MP4P2PBPMVFVFVNJ2CN0JNNZ_attempt_3.wav');
    if (fs.existsSync(desk)) {
        const d = decodeWav(fs.readFileSync(desk));
        parity('2a the desk clip (attempt_3, keyboard clicks, in the tree)', d.samples, '(keyboard clicking)',
            (w) => ['16 kHz, and records nothing (the whole-span bench\'s known answer)', d.sampleRate === SR && Object.keys(METRIC_PATHS).every((k) => get(w.metrics, k) == null),
                `${w.evidence.voicedFrames} voiced frames, span ${w.evidence.spanSeconds} s`]);
    } else {
        console.log('  SKIP  2a the desk clip is not on this box');
    }
    const take = 'C:/tmp/voiceprint/dev1-room/202610300011/003-i-think-i-cut-myself-r1-normal.wav';
    if (fs.existsSync(take)) {
        const d = decodeWav(fs.readFileSync(take));
        // a 2.8 s take: every row-B metric is under its floor, so here the parity is on the evidence and the floored list
        parity('2b dev1 take 003 "I think I cut myself" (outside the repo)', d.samples, 'I think I cut myself.',
            (w) => ['16 kHz, 5 words', d.sampleRate === SR && w.evidence.words === 5, `${w.evidence.voicedFrames} voiced frames, span ${w.evidence.spanSeconds} s, ${w.floored.length} floored`]);
    } else {
        console.log('  SKIP  2b dev1 take 003 is not on this box (C:/tmp/voiceprint/dev1-room/202610300011)');
    }
}

// ── (3) 45 s of voiced signal ───────────────────────────────────────────────────────────────────────────
console.log('\n(3) one synthetic 45 s voiced signal');
{
    const pcm = voiced45();
    const words = Array.from({ length: 110 }, (_, k) => ['the', 'morning', 'was', 'quiet', 'and', 'I', 'had', 'my', 'tea'][k % 9]).join(' ');
    const w = parity('3a 45 s, phrases and pauses, F0 100-160 Hz', pcm, words,
        (r) => ['every row-B metric recorded, pitch inside the designed 95-170 Hz glide', r.floored.length === 0 && Object.keys(METRIC_PATHS).every((k) => get(r.metrics, k) != null)
            && r.metrics.pitch.mean_hz >= 95 && r.metrics.pitch.mean_hz <= 170,
            `pitch ${r.metrics.pitch.mean_hz} Hz, ${r.metrics.cadence.wpm} wpm, span ${r.evidence.spanSeconds} s, ${r.evidence.voicedFrames} voiced frames, floored: ${r.floored.map((f) => f.metric).join(', ') || 'none'}`]);
    if (bundle && w) {
        const time = (fn) => { const t = []; for (let k = 0; k < 5; k++) { const a = performance.now(); fn(); t.push(performance.now() - a); } t.sort((a, b) => a - b); return t; };
        const tb = time(() => bundle.measureVoice(pcm, { transcript: words }));
        const ts = time(() => sourceStage(pcm, words));
        console.log(`  INFO  measureVoice on 45 s in Node ${process.version} (${os.hostname()}): median ${tb[2].toFixed(0)} ms (min ${tb[0].toFixed(0)}, max ${tb[4].toFixed(0)}); source stage median ${ts[2].toFixed(0)} ms`);
        console.log(`  INFO  bundle ${built.bytes} bytes, ${built.gzipBytes} gzipped`);
    }
}

fs.rmSync(out, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
