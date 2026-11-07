// ==================================================
// 📄 src/voice/ReliabilityFloors.js
// ==================================================
//
// ══ A MEASURE THAT ISN'T RELIABLE ON THE EVIDENCE IT HAS IS NOT RECORDED (Ed's ruling, 2026-11-06) ═════════════════
//
// Every row-B metric names the ONE evidence it stands on (span seconds, words, voiced frames, glottal periods, volume
// windows, centroid windows, speech segments) and the minimum of it, and applyReliabilityFloors — the one place the
// floors are enforced, called once by VoiceAnalyticsService.analyzeAudio — nulls exactly the metrics under their own
// floor. Each metric is judged on its own evidence: one metric under its floor never suppresses another that meets
// its own (Ed's addendum), so a short phrase still stores the pitch and volume its voiced frames support. A null is
// not stored (VoiceMetricsRecorder skips it): no row. Nothing is computed to fill one.
//
// THE FLOORS ARE MEASURED, NOT GUESSED, two ways (FLOORS says which set each): repeat pairs, and an alternating
// split-half on longer real speech (--split-half, Ed's rulings). The pairs: scripts/voice-health-floors.mjs runs analyzeAudio's own measurePcm on the nine
// dev1 enrollment takes (three phrases, three times each), cut to growing lengths, and sets each floor at the least
// evidence above which repeats of the same phrase at the same effort agree within the tolerance stated beside it.
//
// A METRIC ALSO NEEDS REAL SPEECH (Ed's ruling, 2026-11-06): pauses, speaking_time_ratio, rate variability and wpm
// measure a span, and a span of keyboard clicks is a span; volume and centroid windows pass on clicks too. Each is
// recorded only when the clip holds SPEECH.words transcript words or SPEECH.voicedFrames voiced frames, besides its
// own floor.
// Pure, no imports.

/**
 * The floors. `evidence` is a key of measurePcm's `evidence`; a metric is recorded when that evidence ≥ `min`.
 * `min: Infinity` is a floor the takes never reached (repeats never agreed within `tolerance`): not recorded until
 * longer repeats show where it is. `derived` says where the number came from.
 */
export const FLOORS = Object.freeze({
    // Three derivations, all scripts/voice-health-floors.mjs, 2026-11-06, on measurePcm reading the whole speech span
    // (p5/p95 for min/max, the P.56 active level for volume, the centroid on voiced windows), tolerances fixed before
    // any ran:
    //   ACCURACY    wpm only (--wpm-accuracy): the least transcript words at or above which every one of the 29
    //               known-text clips reads within the tolerance of its known wpm. Split halves are the wrong test for
    //               wpm: they measure the rate change inside one answer and splice words at the joins (Ed's ruling).
    //   PAIRS       repeats of one phrase at one effort agree (dev1 takes 001+007, 003+009, 005+008; two phrases above)
    //   SPLIT-HALF  the two ALTERNATING halves of one recording agree (even and odd 0.5 s chunks): 38 recordings — 9
    //               60 s cuts of three LibriVox readers of A Tale of Two Cities ch. 1, 26 of Richard's clips that
    //               MATCH patient 3's record (12 session takes, 0.829 / 0.504) and 3 dev1 takes; two recordings above.
    // Every other metric carries the higher of PAIRS and SPLIT-HALF. "(n)" is the recordings above the floor.
    'cadence.wpm': { evidence: 'words', min: 6, tolerance: '±15 % of the rate' },   // accuracy: 28 of 29 within (Set the clock to 2pm read 5 words for 6); 4 clips at 6 words or more, all within
    'cadence.pause_duration_avg': { evidence: 'spanSeconds', min: 14.3, tolerance: '±0.10 s' },   // split-half (9)
    'cadence.speaking_time_ratio': { evidence: 'spanSeconds', min: 4.93, tolerance: '±0.10' },   // split-half (9)
    'cadence.speech_rate_variability': { evidence: 'speechSegments', min: 14, tolerance: '±0.10 CV' },   // split-half (6 of 9 with segments)
    'pitch.mean_hz': { evidence: 'voicedFrames', min: 625, tolerance: '±1 semitone' },   // split-half (9)
    'pitch.std_dev': { evidence: 'voicedFrames', min: 2062, tolerance: '±35 %' },   // split-half (2): halves of about 30 s of speech
    'pitch.p5_hz': { evidence: 'voicedFrames', min: 364, tolerance: '±2 semitones' },   // split-half (9)
    'pitch.p95_hz': { evidence: 'voicedFrames', min: 701, tolerance: '±2 semitones' },   // pairs 20; raised by split-half (154.8 vs 186.5 Hz at 671)
    'pitch.p5_p95_range_hz': { evidence: 'voicedFrames', min: 448, tolerance: '±35 %' },   // split-half (9)
    'volume.mean_db': { evidence: 'volumeWindows', min: 85, tolerance: '±3 dB' },   // pairs 31; raised by split-half (-27.9 vs -24.4 dBFS at 84) (10)
    'volume.std_dev': { evidence: 'volumeWindows', min: 54, tolerance: '±1.5 dB' },   // split-half (15)
    'volume.p5_db': { evidence: 'volumeWindows', min: 85, tolerance: '±4 dB' },   // split-half (10)
    'volume.p95_db': { evidence: 'volumeWindows', min: 399, tolerance: '±3 dB' },   // pairs 28; raised by split-half (-22.2 vs -19.0 dBFS at 392) (9)
    'volume.p5_p95_range_db': { evidence: 'volumeWindows', min: 73, tolerance: '±4 dB' },   // split-half (11)
    'voiceQuality.harmonic_to_noise': { evidence: 'voicedFrames', min: 141, tolerance: '±2 dB' },   // split-half (12)
    'voiceQuality.spectral_centroid': { evidence: 'centroidWindows', min: 65, tolerance: '±15 %' },   // pairs 11; raised by split-half (2144 vs 2572 Hz at 63) (10)
    'voiceQuality.jitter': { evidence: 'glottalPeriods', min: 458, tolerance: '±0.01 (1 point of jitter)' },   // split-half (9)
    'voiceQuality.shimmer': { evidence: 'glottalPeriods', min: 392, tolerance: '±0.03 (3 points of shimmer)' },   // pairs 98; raised by split-half (0.128 vs 0.181 at 385) (9)
    'inflection': { evidence: 'voicedFrames', min: 147, tolerance: '±1 on 0-10' },   // split-half (11); also needs every input recorded (pitch.std_dev: 2062 frames)
    // REMOVED (Ed's ruling: a metric that reaches no floor is not computed or stored): cadence.pause_count (halves 19
    // vs 26 pauses at 29.9 s each) and cadence.pause_duration_total (5.10 vs 5.53 s) — both grow with the span, so
    // halves of any length differ by more than ±1 pause and ±0.15 s.
});

/**
 * REAL SPEECH (Ed's ruling, 2026-11-06). A metric in `metrics` is recorded only when the clip has at least `words`
 * transcript words, or at least `voicedFrames` voiced frames. `voicedFrames` from scripts/voice-health-floors.mjs
 * --voiced-floor on 106 recordings on mimma (Richard's 27 MATCH clips, the 9 dev1 takes, mimma's 70 captures): one
 * more than the most any recording Whisper read no words in reached — the desk clip's keyboard clicks, 9 frames. Real
 * speech read 18 ("Good.", 0.25 s) and up.
 *
 * The ruling names the span metrics (pauses, speaking_time_ratio, rate variability, wpm). The volume metrics and the
 * centroid are here too: over the whole span the desk clip's clicks fill 48 volume windows, past the volume std and
 * range floors, and "keyboard clicks must record nothing". Pitch, HNR, jitter and shimmer stand on voiced frames or
 * the periods inside them, at floors of 127 and up, so this never decides them; they are listed so the rule is one.
 */
export const SPEECH = Object.freeze({
    words: 2,
    voicedFrames: 10,
    metrics: Object.freeze(['cadence.wpm', 'cadence.pause_duration_avg', 'cadence.speaking_time_ratio', 'cadence.speech_rate_variability',
        'pitch.mean_hz', 'pitch.std_dev', 'pitch.p5_hz', 'pitch.p95_hz', 'pitch.p5_p95_range_hz',
        'volume.mean_db', 'volume.std_dev', 'volume.p5_db', 'volume.p95_db', 'volume.p5_p95_range_db',
        'voiceQuality.harmonic_to_noise', 'voiceQuality.spectral_centroid', 'voiceQuality.jitter', 'voiceQuality.shimmer']),
});

/** Where each row-B metric lives in the analysis result. */
export const METRIC_PATHS = Object.freeze({
    'cadence.wpm': ['cadence', 'wpm'],
    'cadence.pause_duration_avg': ['cadence', 'pause_duration_avg'],
    'cadence.speaking_time_ratio': ['cadence', 'speaking_time_ratio'],
    'cadence.speech_rate_variability': ['cadence', 'speech_rate_variability'],
    'pitch.mean_hz': ['pitch', 'mean_hz'],
    'pitch.std_dev': ['pitch', 'std_dev'],
    'pitch.p5_hz': ['pitch', 'p5_hz'],
    'pitch.p95_hz': ['pitch', 'p95_hz'],
    'pitch.p5_p95_range_hz': ['pitch', 'p5_p95_range_hz'],
    'volume.mean_db': ['volume', 'mean_db'],
    'volume.std_dev': ['volume', 'std_dev'],
    'volume.p5_db': ['volume', 'p5_db'],
    'volume.p95_db': ['volume', 'p95_db'],
    'volume.p5_p95_range_db': ['volume', 'p5_p95_range_db'],
    'voiceQuality.harmonic_to_noise': ['voiceQuality', 'harmonic_to_noise'],
    'voiceQuality.spectral_centroid': ['voiceQuality', 'spectral_centroid'],
    'voiceQuality.jitter': ['voiceQuality', 'jitter'],
    'voiceQuality.shimmer': ['voiceQuality', 'shimmer'],
    'inflection': ['inflection'],
});

/** inflection_score is computed from these; it is recorded only when every one of them is (its own evidence). */
export const INFLECTION_INPUTS = Object.freeze(['pitch.mean_hz', 'pitch.std_dev', 'voiceQuality.harmonic_to_noise', 'volume.mean_db', 'volume.std_dev']);

/** A floor's minimum as it is written into the analysis (JSON has no Infinity). */
const needOf = (floor) => (Number.isFinite(floor.min) ? floor.min : 'not reached (no floor on the measured speech)');
const get = (o, p) => p.reduce((v, k) => (v == null ? undefined : v[k]), o);
const set = (o, p, v) => { let t = o; for (const k of p.slice(0, -1)) t = t[k] ?? (t[k] = {}); t[p[p.length - 1]] = v; };

/**
 * THE ONE PLACE THE FLOORS ARE ENFORCED. Returns a copy of `raw` (measurePcm's result) with every metric under its
 * own floor set to null, and the list of what was floored and why. Metrics that were already null stay null and are
 * not listed (they had no reading to floor). The timing rows stand on the span existing: measurePcm already reports
 * them null when no span was found, and they are measurements of the span, not estimates from it.
 * @param {object} raw
 * A span metric (SPEECH.metrics) that meets its floor is still nulled when the clip is not real speech (SPEECH).
 * @param {object} [floors] - FLOORS (a pin may pass its own)
 * @param {object} [speech] - SPEECH (a pin may pass its own)
 * @returns {{result: object, floored: Array<{metric: string, evidence: string, have: number|string|null, need: number|string}>}}
 */
export function applyReliabilityFloors(raw, floors = FLOORS, speech = SPEECH) {
    const result = structuredClone(raw);
    const ev = raw.evidence || {};
    const floored = [];
    // real speech, for the span metrics: enough words, or enough voiced frames
    const isSpeech = (Number.isFinite(ev.words) && ev.words >= speech.words) || (Number.isFinite(ev.voicedFrames) && ev.voicedFrames >= speech.voicedFrames);
    for (const [metric, path] of Object.entries(METRIC_PATHS)) {
        if (metric === 'inflection') continue;
        const floor = floors[metric];
        const value = get(result, path);
        if (value == null || !floor) continue;
        const have = ev[floor.evidence];
        if (!(Number.isFinite(have) && have >= floor.min)) {
            set(result, path, null);
            floored.push({ metric, evidence: floor.evidence, have: Number.isFinite(have) ? have : null, need: needOf(floor) });
        } else if (speech.metrics.includes(metric) && !isSpeech) {
            set(result, path, null);
            floored.push({ metric, evidence: 'speech (words or voicedFrames)', have: `${ev.words ?? 0} words, ${ev.voicedFrames ?? 0} voiced frames`,
                need: `${speech.words} words or ${speech.voicedFrames} voiced frames` });
        }
    }
    // inflection_score: its own floor, and every input recorded
    if (result.inflection != null) {
        const missing = INFLECTION_INPUTS.filter((m) => get(result, METRIC_PATHS[m]) == null);
        const floor = floors.inflection;
        const have = floor ? ev[floor.evidence] : null;
        if (missing.length || (floor && !(Number.isFinite(have) && have >= floor.min))) {
            result.inflection = null;
            floored.push({ metric: 'inflection', evidence: missing.length ? `inputs (${missing.join(', ')})` : floor.evidence,
                have: missing.length ? null : have, need: floor ? needOf(floor) : null });
        }
    }
    return { result, floored };
}
