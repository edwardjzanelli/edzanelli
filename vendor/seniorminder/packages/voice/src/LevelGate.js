// ==================================================
// 📄 src/voice/LevelGate.js
// ==================================================
//
// ══ THE ONE LEVEL GATE OF THE VOICE-HEALTH PATH: "LOUD ENOUGH" MEANS "NEAR THIS CLIP'S OWN LOUDEST FRAME" ══
//
// Every voice-health gate that asks "is this frame speech / voiced / loud enough" asks it here, and asks it the same
// way: the frame's MEAN POWER (mean square) against the loudest frame's mean power, less a depth in dB. Like with like
// — power against power, so a 10 ms frame, a 20 ms window and a 30 ms pitch frame all compare honestly — and
// relative to the clip itself, so the answer does not move with the microphone's gain. A visitor's unknown mic at
// −45 dBFS and the box's Anker at −10 dBFS find the same syllables, the same voiced frames, the same pauses.
//
// What it replaced (2026-11-06): the syllable detector's absolute 0.3 summed energy per 20 ms (about −30 dBFS, so a
// quiet clip had no syllables at all), the speech span's absolute 0.015 floor, and two gates comparing a frame's RMS
// with the loudest window's SUMMED energy (pitch frames and volume windows — loud speech had none).
//
// Pure, no imports.

/**
 * The depths, in dB below the clip's loudest frame. Each is the one its gate always meant.
 *   SPEECH   a frame is speech, not a pause: within 5 % of the loudest RMS (20·log10(20) = 26.02 dB) — the pause
 *            detector's own figure; the speech span uses it too, so the span and the pauses agree on what is sound.
 *   VOICED   a pitch frame or a volume window is loud enough to read: 1 % of the loudest power (20 dB) — the
 *            "VERY LIBERAL" 1 % both gates were written to apply.
 *   SYLLABLE a syllable nucleus: within 10 dB of the loudest. VALIDATED on known text (2026-11-06): 29 clips — 9
 *            dev1 enrollment takes of his voice ("I just fell", "Help me", "I think I cut myself") and 20 desk TTS
 *            tapes — hand-counted, then countSyllables at 10 / 15 / 20 dB: mean |error| 1.31 / 1.62 / 2.31 syllables
 *            (his takes alone: 0.22 / 0.00 / 0.67; the TTS tapes undercount at every depth). 10 dB is the lowest overall.
 */
export const DEPTH_DB = Object.freeze({
    SPEECH: 20 * Math.log10(1 / 0.05),
    VOICED: 20,
    SYLLABLE: 10,
});

/**
 * The shortest stretch that counts as a run of sound or of silence: 100 ms. A pause must be longer than this
 * (MetricsCalculator.analyzePauses), and a speech span's edge must be this long of continuous sound
 * (AudioProcessor.speechSpanOf) — so a gate-open click (dev1's Anker, −54 dBFS for ~30 ms in bit-exact silence,
 * 2026-11-06) can neither start nor end the span.
 */
export const MIN_RUN_MS = 100;

/** Mean power (mean square) of x[from..to). 0 for an empty span. */
export function meanPower(x, from = 0, to = x.length) {
    const n = to - from;
    if (n <= 0) return 0;
    let s = 0;
    for (let i = from; i < to; i++) s += x[i] * x[i];
    return s / n;
}

/**
 * The gate. `reference` is either the loudest frame's mean power (a number — when the caller judges part of a clip
 * against the whole clip, as one 2 s segment against its speech span), or the frame powers themselves, whose maximum
 * is taken. A frame passes when its mean power is above loudest × 10^(−depthDb/10).
 *
 * A clip whose loudest frame is 0 (bit-exact digital silence) has no frame that passes — nothing in it is speech.
 * @param {number|ArrayLike<number>} reference
 * @param {number} depthDb
 * @returns {{loudest: number, floor: number, depthDb: number, passes: (power: number) => boolean}}
 */
export function levelGate(reference, depthDb) {
    let loudest = 0;
    if (typeof reference === 'number') loudest = reference;
    else for (let i = 0; i < reference.length; i++) if (reference[i] > loudest) loudest = reference[i];
    const floor = loudest > 0 ? loudest * 10 ** (-depthDb / 10) : Infinity;
    return { loudest, floor, depthDb, passes: (power) => power > floor };
}
