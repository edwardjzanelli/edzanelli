// ==================================================
// 📄 src/voice/MetricsCalculator.js
// ==================================================
import { AppLogger } from '@seniorminder/logger';

import { countSyllables, speechSpanOf, syllableFramePowers } from './AudioProcessor.js';
import { DEPTH_DB, MIN_RUN_MS, levelGate, meanPower } from './LevelGate.js';
import { VoiceConstants } from './utils/Constants.js';

const MODULE_NAME = 'MetricsCalculator';

const { AUDIO, PITCH } = VoiceConstants;

/**
 * inflection_score's volume term divides the dB spread by the mean level measured from 96 dB below full scale
 * (the 16-bit floor). Volume is now stored as plain dBFS; this puts the old +96 back IN THE RATIO ONLY, so the
 * 0-10 volume term is the same number it always was.
 */
const INFLECTION_VOLUME_FLOOR_DB = 96;
/** r is capped here before 10·log10(r / (1 − r)), so a noiseless frame reads 40 dB instead of infinity. */
const HNR_MAX_R = 0.9999;
/**
 * The pitch frame: three periods of the lowest F0 searched (PITCH.MIN_FREQ), since estimatePitchForWindow only trusts
 * a period that fits three times — 800 samples (50 ms) at 60 Hz. The hop stays 7.5 ms.
 */
const PITCH_FRAME_SAMPLES = Math.ceil(3 * AUDIO.SAMPLE_RATE / PITCH.MIN_FREQ);
const PITCH_HOP_SAMPLES = Math.floor(AUDIO.SAMPLE_RATE * 0.0075);
/**
 * Period marks (jitter, shimmer): the next glottal peak is looked for between these fractions of the local period
 * after the last; a pair of consecutive periods counts only within PERIOD_FACTOR of each other and a pair of
 * consecutive peak amplitudes within AMPLITUDE_FACTOR — the usual guards (Praat's 1.3 and 1.6) against a mark that
 * slipped a period or landed on a secondary peak.
 */
const PERIOD_SEARCH = Object.freeze({ from: 0.75, to: 1.25 });
const PERIOD_FACTOR = 1.3;
const AMPLITUDE_FACTOR = 1.6;
/** periodMarks: a sub-cycle near half the matched lag is the glottal cycle when it matches at least this share as well. */
const SUBCYCLE_MATCH = 0.9;
/**
 * THE PITCH TRACKER'S CONSTANTS — Praat's defaults for its autocorrelation pitch analysis (Boersma 1993; Praat's
 * "To Pitch (ac)"): a frame is voiced when its best candidate's corrected autocorrelation reaches VOICING_THRESHOLD;
 * OCTAVE_COST favours the higher of two octaves per octave; OCTAVE_JUMP_COST and VOICED_UNVOICED_COST are the path's
 * transition costs (per 10 ms). BRIDGE_SECONDS is ours, not Praat's: the octave-jump cost also applies across an
 * unvoiced gap this short (voicedFrames). The old tracker took each frame's highest raw correlation over 0.3, alone.
 */
const TRACK = Object.freeze({ VOICING_THRESHOLD: 0.45, OCTAVE_COST: 0.01, OCTAVE_JUMP_COST: 0.35, VOICED_UNVOICED_COST: 0.14, MAX_CANDIDATES: 15, BRIDGE_SECONDS: 0.2 });

/**
 * The p-th percentile of a list, linear between the two nearest ranks (numpy's default): p 0 is the least, 100 the
 * greatest. Pure.
 * @param {number[]} values - at least one number.
 * @param {number} p - 0..100.
 * @returns {number}
 */
export function percentile(values, p) {
    const s = Float64Array.from(values).sort();
    const r = (p / 100) * (s.length - 1), lo = Math.floor(r), hi = Math.ceil(r);
    return s[lo] + (s[hi] - s[lo]) * (r - lo);
}

/**
 * THE ACTIVE SPEECH LEVEL, ITU-T P.56 style, over per-window mean powers. For a threshold c, A(c) is the mean power
 * of the windows at or above c; P.56 scans c UP from the quietest and stops at the first c where A(c) stands no more
 * than P56_MARGIN_DB (15.9 dB, its M) above c. The windows at or above that c are the active ones, A(c) the active
 * level. Scanning from the bottom is what keeps it off the loudest moment: one click 20 dB over the speech makes a
 * second crossing near the click, above the first, which the scan never reaches. Here a window is a 20 ms frame, not
 * P.56's envelope with its 0.2 s hangover — P.56's method on frames, not a certified P.56 meter. Pure.
 * @param {number[]} powers - each window's mean power (linear).
 * @returns {{active: boolean[], levelPower: number, thresholdPower: number}|null} null when no window has power.
 */
export function activeSpeechLevel(powers) {
    const asc = powers.filter((p) => p > 0).sort((a, b) => a - b);
    if (!asc.length) return null;
    const margin = 10 ** (P56_MARGIN_DB / 10);
    const suffix = new Float64Array(asc.length + 1);
    for (let i = asc.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + asc[i];
    let c = asc[asc.length - 1];
    for (let i = 0; i < asc.length; i++) {
        if (suffix[i] / (asc.length - i) <= margin * asc[i]) { c = asc[i]; break; }   // the top window always satisfies it
    }
    const active = powers.map((p) => p > 0 && p >= c);
    let s = 0, n = 0;
    powers.forEach((p, i) => { if (active[i]) { s += p; n++; } });
    return { active, levelPower: s / n, thresholdPower: c };
}
/** P.56's margin M: the active level stands this far above the activity threshold. */
const P56_MARGIN_DB = 15.9;

/**
 * The magnitude spectrum of a power-of-two window by an iterative radix-2 FFT: bins 0..L/2-1, each √(re² + im²) of
 * Σ x[n]·e^(−2πikn/L) — the same numbers calculateSpectrum's DFT gives, in O(L log L). Pure.
 * @param {Float32Array|number[]} x - L samples, L a power of two.
 * @returns {number[]} L/2 magnitudes.
 */
export function magnitudeSpectrumFft(x) {
    const L = x.length;
    const re = Float64Array.from(x), im = new Float64Array(L);
    for (let i = 1, j = 0; i < L; i++) {
        let bit = L >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
    }
    for (let len = 2; len <= L; len <<= 1) {
        const ang = -2 * Math.PI / len, half = len >> 1;
        for (let i = 0; i < L; i += len) {
            for (let k = 0; k < half; k++) {
                const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
                const a = i + k, b = a + half;
                const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - xr; im[b] = im[a] - xi;
                re[a] += xr; im[a] += xi;
            }
        }
    }
    const out = new Array(L / 2);
    for (let k = 0; k < L / 2; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    return out;
}

export class MetricsCalculator {
    /**
     * Initializes the calculator with the project-wide sample rate from VoiceConstants.
     * No external state is required; all public methods are stateless and accept raw
     * Float32Array audio data directly.
     */
    constructor() {
        const METHOD_NAME = 'constructor';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'MetricsCalculator initializing...');
        
        this.sampleRate = AUDIO.SAMPLE_RATE;
        /** voicedFrames per audio buffer (a WeakMap: a clip's frames go when its buffer does). */
        this._voicedFramesCache = new WeakMap();
    }
    
    // ==================================================
    // CADENCE METRICS (Speech Rate & Timing Analysis)
    // ==================================================
    
    /**
     * Enhanced cadence metrics calculation including pause analysis
     */
    calculateCadenceMetrics(audioData, speechStart, speechEnd, speechDuration, wordCount) {
        const METHOD_NAME = 'calculateCadenceMetrics';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Calculating cadence metrics for ${wordCount ?? 'no'} words in ${speechDuration.toFixed(2)}s`);

        // No span, no cadence: nothing is computed to fill a row (2026-11-06).
        if (!(speechDuration > 0)) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 'No speech span for cadence analysis');
            return {
                wpm: null,
                pause_duration_avg: null,
                speech_rate_variability: null,
                speaking_time_ratio: null,
                speech_segments: 0
            };
        }

        // Words per minute from a transcript's words (WordCount.wordCountOf) — never estimated. No words, no wpm.
        const wpm = Number.isFinite(wordCount) ? Math.round((wordCount * 60) / speechDuration) : null;

        // Analyze pauses in the audio data
        const pauseAnalysis = this.analyzePauses(audioData, speechStart, speechEnd);

        // Calculate speech rate variability (how consistent the speaking rate is); null = fewer than two segments with speech
        const segmentRates = this.speechSegmentRates(audioData, speechStart, speechEnd);
        const speechRateVariability = this.calculateSpeechRateVariability(audioData, speechStart, speechEnd);

        // Active speech time over the speech span (the pause detector inside the span)
        const speakingTimeRatio = this.calculateSpeakingTimeRatio(audioData, speechStart, speechEnd);

        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Cadence: WPM=${wpm ?? 'n/a'}, Pauses=${pauseAnalysis.count}, Speaking ratio=${speakingTimeRatio === null ? 'n/a' : speakingTimeRatio.toFixed(2)}`);

        // pause_count and pause_duration_total are no longer metrics (Ed's ruling, 2026-11-06): both grow with the
        // span, so the two halves of 60 s of one reader never agreed within ±1 pause or ±0.15 s (19 vs 26 pauses, 5.10
        // vs 5.53 s at 29.9 s each) — no floor on any speech. pause_duration_avg and speaking_time_ratio stay.
        return {
            wpm: wpm,
            pause_duration_avg: Number(pauseAnalysis.avgDuration.toFixed(2)),
            speech_rate_variability: speechRateVariability === null ? null : Number(speechRateVariability.toFixed(3)),
            speaking_time_ratio: speakingTimeRatio === null ? null : Number(speakingTimeRatio.toFixed(3)),
            // evidence, not a metric: the 2 s segments of the span with speech (ReliabilityFloors)
            speech_segments: segmentRates.length
        };
    }

    /**
     * speaking_time_ratio: (span − pauses inside the span) ÷ span (Ed's ruling, 2026-11-06). The span is the speech
     * span (speechSpanOf — what detectSpeechBoundaries hands the cadence), the pauses those analyzePauses finds inside
     * it; silence before he starts or after he finishes does not count.
     * @param {Float32Array} audioData - Full recording PCM data.
     * @param {number} [speechStart] - span start, s; with `speechEnd`. Omitted: speechSpanOf(audioData).
     * @param {number} [speechEnd] - span end, s.
     * @returns {number|null} ratio in [0, 1]; 0 when there is no span (no speech); null for an empty clip.
     */
    calculateSpeakingTimeRatio(audioData, speechStart, speechEnd) {
        if (!audioData || audioData.length === 0) return null;
        if (speechStart === undefined || speechEnd === undefined) {
            const span = speechSpanOf(audioData, this.sampleRate);
            speechStart = span.speechStart; speechEnd = span.speechEnd;
        }
        const spanSeconds = speechEnd - speechStart;
        if (!(spanSeconds > 0)) return 0;
        const pauses = this.analyzePauses(audioData, speechStart, speechEnd);
        return Math.max(0, Math.min(1, (spanSeconds - pauses.totalDuration) / spanSeconds));
    }

    /**
     * Analyze pauses in speech
     */
    analyzePauses(audioData, speechStart, speechEnd) {
        const METHOD_NAME = 'analyzePauses';
        
        // Convert time to sample indices
        const startSample = Math.floor(speechStart * this.sampleRate);
        const endSample = Math.floor(speechEnd * this.sampleRate);
        const speechData = audioData.slice(startSample, endSample);
        
        if (speechData.length === 0) {
            return { count: 0, totalDuration: 0, avgDuration: 0 };
        }
        
        // 10 ms windows' mean power; a pause is a window that is not speech (LevelGate, DEPTH_DB.SPEECH: under 5% of
        // the loudest window's RMS — the figure this detector always used, now said as power against power)
        const windowSize = Math.floor(this.sampleRate * 0.01); // 10ms windows
        const energyValues = [];

        for (let i = 0; i < speechData.length - windowSize; i += windowSize) {
            energyValues.push(meanPower(speechData, i, i + windowSize));
        }

        if (energyValues.length === 0) {
            return { count: 0, totalDuration: 0, avgDuration: 0 };
        }

        const speech = levelGate(energyValues, DEPTH_DB.SPEECH);

        // Find pause segments
        const pauses = [];
        let pauseStart = -1;

        for (let i = 0; i < energyValues.length; i++) {
            const timeSeconds = (i * windowSize) / this.sampleRate;

            if (!speech.passes(energyValues[i])) {
                // Start of pause
                if (pauseStart === -1) {
                    pauseStart = timeSeconds;
                }
            } else {
                // End of pause
                if (pauseStart !== -1) {
                    const pauseDuration = timeSeconds - pauseStart;
                    // Only count pauses longer than MIN_RUN_MS (100 ms)
                    if (pauseDuration > MIN_RUN_MS / 1000) {
                        pauses.push(pauseDuration);
                    }
                    pauseStart = -1;
                }
            }
        }
        
        // Handle pause that extends to end
        if (pauseStart !== -1) {
            const pauseDuration = (speechData.length / this.sampleRate) - pauseStart;
            if (pauseDuration > MIN_RUN_MS / 1000) {
                pauses.push(pauseDuration);
            }
        }
        
        const totalPauseDuration = pauses.reduce((sum, duration) => sum + duration, 0);
        const avgPauseDuration = pauses.length > 0 ? totalPauseDuration / pauses.length : 0;
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Found ${pauses.length} pauses, total duration: ${totalPauseDuration.toFixed(2)}s`);
        
        return {
            count: pauses.length,
            totalDuration: totalPauseDuration,
            avgDuration: avgPauseDuration
        };
    }

    /**
     * The speaking rate of each 2 s segment of the speech span: ITS OWN syllable count (countSyllables, the one
     * syllable detector) per second; a segment with no syllables is no speech and is left out. Their count is the
     * evidence speech_rate_variability is floored on (ReliabilityFloors).
     * @returns {number[]} syllables per second of each segment with speech.
     */
    speechSegmentRates(audioData, speechStart, speechEnd) {
        // Divide speech into segments and calculate rate for each
        const segmentDuration = 2.0; // 2-second segments
        const speechDuration = speechEnd - speechStart;
        if (!(speechDuration >= segmentDuration)) return [];

        const numSegments = Math.floor(speechDuration / segmentDuration);
        const segmentRates = [];

        // Convert to sample indices
        const startSample = Math.floor(speechStart * this.sampleRate);
        const segmentSamples = Math.floor(segmentDuration * this.sampleRate);
        // Every segment is judged against the WHOLE speech span's loudest window, never its own: a segment of room
        // tone judged against itself would find its own loudest hiss a syllable.
        const spanPowers = syllableFramePowers(audioData.subarray(startSample, Math.floor(speechEnd * this.sampleRate)), this.sampleRate);
        const loudest = levelGate(spanPowers, DEPTH_DB.SYLLABLE).loudest;

        for (let i = 0; i < numSegments; i++) {
            const segmentStartSample = startSample + (i * segmentSamples);
            const segmentEndSample = Math.min(segmentStartSample + segmentSamples, audioData.length);
            const segmentData = audioData.slice(segmentStartSample, segmentEndSample);

            const syllables = countSyllables(segmentData, this.sampleRate, { loudest });
            if (syllables > 0) {
                segmentRates.push(syllables / segmentDuration);
            }
        }
        return segmentRates;
    }

    /**
     * Speech rate variability: the coefficient of variation of speechSegmentRates.
     * @returns {number|null} CV; null when fewer than two segments have speech — nothing is stored, never a 0.
     */
    calculateSpeechRateVariability(audioData, speechStart, speechEnd) {
        const METHOD_NAME = 'calculateSpeechRateVariability';
        const segmentRates = this.speechSegmentRates(audioData, speechStart, speechEnd);

        if (segmentRates.length < 2) {
            return null;
        }

        // Calculate coefficient of variation
        const meanRate = segmentRates.reduce((sum, rate) => sum + rate, 0) / segmentRates.length;
        const variance = segmentRates.reduce((sum, rate) => sum + Math.pow(rate - meanRate, 2), 0) / segmentRates.length;
        const stdDev = Math.sqrt(variance);
        const coefficientOfVariation = meanRate > 0 ? stdDev / meanRate : 0;

        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Speech rate variability: ${coefficientOfVariation.toFixed(3)} (CV)`);

        return coefficientOfVariation;
    }

    // ==================================================
    // CLARITY METRICS (Signal Quality & Intelligibility)
    // ==================================================
    
    /**
     * Enhanced clarity metrics calculation - reuses existing methods where possible
     */
    calculateClarityMetrics(audioData) {
        const METHOD_NAME = 'calculateClarityMetrics';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Calculating clarity metrics for ${audioData.length} samples`);
        
        if (audioData.length === 0) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 'No audio data for clarity calculation');
            return {
                snr_db: 0,
                high_freq_ratio: 0,
                consonant_clarity: 0,
                spectral_clarity: 0
            };
        }
        
        // Find highest energy section for analysis (reuse existing logic)
        const windowSize = Math.floor(this.sampleRate * 0.02);
        let maxEnergy = 0;
        let bestStartIndex = 0;
        
        for (let i = 0; i < audioData.length - windowSize; i += windowSize) {
            let energy = 0;
            for (let j = i; j < i + windowSize && j < audioData.length; j++) {
                energy += audioData[j] * audioData[j];
            }
            if (energy > maxEnergy) {
                maxEnergy = energy;
                bestStartIndex = i;
            }
        }
        
        // Analyze larger window around speech
        const analysisWindowSize = Math.min(8000, audioData.length - bestStartIndex);
        const speechData = audioData.slice(bestStartIndex, bestStartIndex + analysisWindowSize);
        
        // Calculate Signal-to-Noise Ratio
        const snrDb = this.calculateSignalToNoiseRatio(speechData);
        
        // Calculate High Frequency Ratio (reuse existing tone calculation logic)
        const highFreqRatio = this.calculateHighFrequencyRatio(speechData);
        
        // Calculate Consonant Clarity using existing ZCR logic from old calculateClarity
        const consonantClarity = this.calculateConsonantClaritySimple(speechData);
        
        // Calculate Spectral Clarity using existing spectral methods
        const spectralClarity = this.calculateSpectralClaritySimple(speechData);
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Clarity: SNR=${snrDb.toFixed(1)}dB, HF ratio=${highFreqRatio.toFixed(3)}, Consonant=${consonantClarity.toFixed(3)}, Spectral=${spectralClarity.toFixed(3)}`);
        
        return {
            snr_db: Number(snrDb.toFixed(1)),
            high_freq_ratio: Number(highFreqRatio.toFixed(3)),
            consonant_clarity: Number(consonantClarity.toFixed(3)),
            spectral_clarity: Number(spectralClarity.toFixed(3))
        };
    }

    /**
     * Simple consonant clarity using existing ZCR logic from old calculateClarity
     */
    calculateConsonantClaritySimple(audioData) {
        if (audioData.length === 0) return 0;
        
        // Zero crossing rate (from existing calculateClarity method)
        let zeroCrossings = 0;
        for (let i = 1; i < audioData.length; i++) {
            if ((audioData[i] >= 0) !== (audioData[i - 1] >= 0)) {
                zeroCrossings++;
            }
        }
        const zcr = zeroCrossings / (audioData.length / this.sampleRate);
        
        // High frequency energy ratio (from existing calculateClarity method)
        let totalEnergy = 0;
        let highFreqEnergy = 0;
        
        for (let i = 0; i < audioData.length; i++) {
            const energy = audioData[i] * audioData[i];
            totalEnergy += energy;
            
            if (i > 0) {
                const diff = Math.abs(audioData[i] - audioData[i - 1]);
                highFreqEnergy += diff * diff;
            }
        }
        
        const highFreqRatio = totalEnergy > 0 ? highFreqEnergy / totalEnergy : 0;
        
        // Combine ZCR and high freq ratio for consonant clarity
        const zcrScore = Math.min(1, zcr / 1000);
        const hfScore = Math.min(1, highFreqRatio * 2);
        
        return (zcrScore + hfScore) / 2;
    }

    /**
     * Calculate High Frequency Ratio (simplified version)
     */
    calculateHighFrequencyRatio(audioData) {
        if (audioData.length < 512) return 0;
        
        // Use existing spectrum calculation
        const windowSize = Math.min(1024, audioData.length);
        const window = audioData.slice(0, windowSize);
        const spectrum = this.calculateSpectrum(window); // Reuse existing method
        
        let totalEnergy = 0;
        let highFreqEnergy = 0;
        
        for (let i = 0; i < spectrum.length; i++) {
            const frequency = i * this.sampleRate / (2 * spectrum.length);
            const energy = spectrum[i] * spectrum[i];
            
            totalEnergy += energy;
            
            // High frequency range: above 2kHz (good for consonants)
            if (frequency > 2000) {
                highFreqEnergy += energy;
            }
        }
        
        return totalEnergy > 0 ? highFreqEnergy / totalEnergy : 0;
    }

    /**
     * Calculate Signal-to-Noise Ratio (new method)
     */
    calculateSignalToNoiseRatio(audioData) {
        if (audioData.length === 0) return 0;
        
        // Calculate signal power (RMS of entire signal)
        const signalRMS = this.calculateRMSEnergy(audioData); // Reuse existing method
        const signalPower = signalRMS * signalRMS;
        
        // Estimate noise floor from quieter portions
        const windowSize = Math.floor(this.sampleRate * 0.01); // 10ms windows
        const energyValues = [];
        
        for (let i = 0; i < audioData.length - windowSize; i += windowSize) {
            const window = audioData.slice(i, i + windowSize);
            const energy = this.calculateRMSEnergy(window); // Reuse existing method
            energyValues.push(energy * energy); // Convert to power
        }
        
        if (energyValues.length === 0) return 0;
        
        // Sort energies and take bottom 20% as noise estimate
        energyValues.sort((a, b) => a - b);
        const noiseEstimateCount = Math.max(1, Math.floor(energyValues.length * 0.2));
        let noisePower = 0;
        for (let i = 0; i < noiseEstimateCount; i++) {
            noisePower += energyValues[i];
        }
        noisePower = noisePower / noiseEstimateCount;
        
        // Calculate SNR in dB
        const snr = noisePower > 0 ? 10 * Math.log10(signalPower / noisePower) : 30;
        
        return Math.max(0, Math.min(40, snr)); // Clamp between 0-40dB
    }

    /**
     * Simple spectral clarity using existing spectral methods
     */
    calculateSpectralClaritySimple(audioData) {
        if (audioData.length < 512) return 0;
        
        const windowSize = Math.min(1024, audioData.length);
        const window = audioData.slice(0, windowSize);
        const spectrum = this.calculateSpectrum(window); // Reuse existing method
        
        // Use existing spectral centroid method
        const centroid = this.calculateSpectralCentroid(spectrum);
        
        // Use existing spectral rolloff method  
        const rolloff = this.calculateSpectralRolloff(spectrum);
        
        // Simple spectral clarity based on centroid and rolloff
        const centroidScore = Math.min(1, centroid / 4000); // Normalize to 4kHz
        const rolloffScore = Math.min(1, rolloff / 8000);   // Normalize to 8kHz
        
        return (centroidScore + rolloffScore) / 2;
    }

    // ==================================================
    // PITCH METRICS (Fundamental Frequency Analysis)
    // ==================================================
    
    /**
     * Enhanced pitch metrics calculation
     */
    calculatePitchMetrics(audioData) {
        const METHOD_NAME = 'calculatePitchMetrics';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Calculating pitch metrics for ${audioData.length} samples`);

        const pitchValues = this.voicedFrames(audioData).map((f) => f.pitch);

        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Found ${pitchValues.length} valid pitch values`);
        
        if (pitchValues.length < 3) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 'Not enough pitch data');
            return { mean_hz: null, std_dev: null, p5_hz: null, p95_hz: null, p5_p95_range_hz: null, sample_count: pitchValues.length };
        }

        // ROBUST PERCENTILES, NOT EXTREMES (Ed's ruling, 2026-11-06): min and max were single frames, which no amount
        // of speech makes stable; the 5th and 95th percentiles of the voiced frames' F0 are, and the names say so.
        const pitchP5 = percentile(pitchValues, 5);
        const pitchP95 = percentile(pitchValues, 95);
        const pitchMean = pitchValues.reduce((sum, p) => sum + p, 0) / pitchValues.length;
        const pitchStdDev = Math.sqrt(
            pitchValues.reduce((sum, p) => sum + Math.pow(p - pitchMean, 2), 0) / pitchValues.length
        );

        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Pitch: Mean=${pitchMean.toFixed(1)}Hz, StdDev=${pitchStdDev.toFixed(1)}Hz, P5-P95=${pitchP5.toFixed(1)}-${pitchP95.toFixed(1)}Hz`);

        return {
            mean_hz: Number(pitchMean.toFixed(1)),
            std_dev: Number(pitchStdDev.toFixed(1)),
            p5_hz: Number(pitchP5.toFixed(1)),
            p95_hz: Number(pitchP95.toFixed(1)),
            p5_p95_range_hz: Number((pitchP95 - pitchP5).toFixed(1)),
            sample_count: pitchValues.length
        };
    }

    /**
     * THE PITCH TRACKER'S VOICED FRAMES — the one framing pitch metrics, harmonic_to_noise, jitter and shimmer all
     * read. Over the whole buffer (measurePcm passes the speech span); PITCH_FRAME_SAMPLES frames (three periods of PITCH.MIN_FREQ:
     * 50 ms) on a PITCH_HOP_SAMPLES (7.5 ms) hop; a frame over the level gate whose estimatePitchForWindow finds an
     * F0 in PITCH.MIN_FREQ..MAX_FREQ (60-500 Hz) is voiced.
     * @param {Float32Array} audioData - Full recording PCM data.
     * @returns {Array<{start: number, window: Float32Array, pitch: number}>} each voiced frame — its first sample in
     *   `audioData`, its samples, its F0 in Hz — in time order.
     */
    voicedFrames(audioData) {
        // One clip is read by pitch, HNR and the period marks, and again inside inflection: the frames are computed once
        // per buffer (the 50 ms frame costs ~3x the old 30 ms one, so six passes would not be free on a Pi).
        const cached = this._voicedFramesCache.get(audioData);
        if (cached) return cached;
        // THE WHOLE BUFFER (Ed's ruling, 2026-11-06): it read at most 2 s from the loudest 20 ms window, so a long answer
        // never gained evidence past 2 s. measurePcm hands this the speech span; a direct caller gets the clip it passed.
        const bestStartIndex = 0;
        const speechData = audioData;

        // A frame is loud enough to read within DEPTH_DB.VOICED (1% of the power) of the loudest frame (LevelGate).
        // ⚠ Like with like: it compared the frame's RMS with 1% of the loudest 20 ms window's SUMMED energy, which
        // rejected every frame once that window passed ~0.47 RMS — loud speech read pitch 0 and HNR null (2026-11-06).
        const pitchWindowSize = PITCH_FRAME_SAMPLES;
        const hop = PITCH_HOP_SAMPLES;
        const starts = [];
        const powers = [];
        for (let i = 0; i < speechData.length - pitchWindowSize; i += hop) {
            starts.push(i);
            powers.push(meanPower(speechData, i, i + pitchWindowSize));
        }
        const loudEnough = levelGate(powers, DEPTH_DB.VOICED);

        // PATH TRACKING (Praat's, Boersma 1993): every frame offers its pitch candidates (pitchCandidates) and an
        // UNVOICED candidate; frames under the level gate offer only the unvoiced one. The path through the frames that
        // maximises Σ strength − Σ transition cost is the pitch track: a voiced-to-voiced step costs
        // TRACK.OCTAVE_JUMP_COST per octave jumped, a voiced/unvoiced switch TRACK.VOICED_UNVOICED_COST, both scaled to
        // Praat's 10 ms step. An isolated octave jump (one frame at 2F or F/2 inside a smooth contour) no longer
        // survives: it would have to pay two octave jumps to visit.
        //
        // ⚠ AND ACROSS A SHORT GAP (2026-11-06, dev1 take 009): Praat charges no jump across unvoiced frames, so a voiced
        // run that begins after a consonant begins free — take 009's "cut myself" re-entered at 485 Hz (a strong r = 0.65
        // at a third of the period) after 127 ms unvoiced, against 141 Hz before the gap. Here a voiced frame within
        // TRACK.BRIDGE_SECONDS of the path's last voiced frame also pays the jump from THAT frame's F0; past it (a pause,
        // a new phrase) the pitch may reset freely. The path keeps, per state, its last voiced F0 and when it was.
        const tsc = 0.01 / (hop / this.sampleRate);
        const bridgeFrames = Math.round(TRACK.BRIDGE_SECONDS * this.sampleRate / hop);
        const UNVOICED = { f: 0, strength: TRACK.VOICING_THRESHOLD };
        const cands = starts.map((i, k) => (loudEnough.passes(powers[k])
            ? [UNVOICED, ...this.pitchCandidates(speechData.subarray(i, i + pitchWindowSize))]
            : [{ f: 0, strength: 0 }]));
        const jump = (f1, f2) => TRACK.OCTAVE_JUMP_COST * tsc * Math.abs(Math.log2(f1 / f2));
        const score = [], from = [], lastF = [], lastK = [];
        for (let k = 0; k < cands.length; k++) {
            const n = cands[k].length;
            score.push(new Float64Array(n)); from.push(new Int32Array(n));
            lastF.push(new Float64Array(n)); lastK.push(new Int32Array(n));
            for (let j = 0; j < n; j++) {
                const c = cands[k][j];
                if (k === 0) { score[k][j] = c.strength; lastF[k][j] = c.f; lastK[k][j] = c.f ? 0 : -1; continue; }
                let best = -Infinity, arg = 0;
                for (let i = 0; i < cands[k - 1].length; i++) {
                    const p = cands[k - 1][i];
                    let cost = 0;
                    if (p.f && c.f) cost = jump(p.f, c.f);
                    else if (p.f || c.f) {
                        cost = TRACK.VOICED_UNVOICED_COST * tsc;
                        // unvoiced -> voiced: the jump from the path's last voiced frame, when it is within the bridge
                        if (c.f && lastK[k - 1][i] >= 0 && k - lastK[k - 1][i] <= bridgeFrames) cost += jump(lastF[k - 1][i], c.f);
                    }
                    const s = score[k - 1][i] - cost;
                    if (s > best) { best = s; arg = i; }
                }
                score[k][j] = best + c.strength;
                from[k][j] = arg;
                lastF[k][j] = c.f ? c.f : lastF[k - 1][arg];
                lastK[k][j] = c.f ? k : lastK[k - 1][arg];
            }
        }
        const frames = [];
        if (cands.length) {
            let j = 0;
            const last = cands.length - 1;
            for (let i = 1; i < cands[last].length; i++) if (score[last][i] > score[last][j]) j = i;
            for (let k = last; k >= 0; k--) {
                const c = cands[k][j];
                if (c.f > 0) frames.push({ start: bestStartIndex + starts[k], window: speechData.slice(starts[k], starts[k] + pitchWindowSize), pitch: c.f });
                j = from[k][j];
            }
            frames.reverse();
        }
        this._voicedFramesCache.set(audioData, frames);
        return frames;
    }

    /**
     * Estimate the dominant fundamental frequency (F0) of a full audio buffer.
     *
     * Locates the highest-energy 20 ms window to identify the most active speech
     * region, then runs normalized autocorrelation over an 8 000-sample analysis
     * window centred on that region.  The lag that yields the highest correlation
     * in the range [sampleRate/PITCH.MAX_FREQ, sampleRate/PITCH.MIN_FREQ] is
     * converted to Hz.
     *
     * Unlike `estimatePitchForWindow()`, this method operates on the full recording
     * and returns a single representative pitch value rather than a per-window estimate.
     * Falls back to 150 Hz when no clear periodicity is found.
     *
     * @param {Float32Array} audioData - Full recording PCM data.
     * @returns {number} Estimated pitch in Hz (typically 70–300).  Returns 150 on failure.
     */
    estimatePitch(audioData) {
        const METHOD_NAME = 'estimatePitch';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Estimating pitch for ${audioData.length} samples`);
        
        if (audioData.length === 0) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 'No audio data for pitch calculation');
            return 150;
        }

        // Find the portion with actual speech by looking for higher energy
        const windowSize = Math.floor(this.sampleRate * 0.02); // 20ms windows
        let maxEnergy = 0;
        let bestStartIndex = 0;
        
        // Find the window with highest energy (likely speech)
        for (let i = 0; i < audioData.length - windowSize; i += windowSize) {
            let energy = 0;
            for (let j = i; j < i + windowSize && j < audioData.length; j++) {
                energy += audioData[j] * audioData[j];
            }
            if (energy > maxEnergy) {
                maxEnergy = energy;
                bestStartIndex = i;
            }
        }
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Max energy for pitch: ${maxEnergy.toFixed(6)} at index ${bestStartIndex}`);
        
        // Use a larger window around the highest energy section
        const analysisWindowSize = Math.min(8000, audioData.length - bestStartIndex);
        const analysisData = audioData.slice(bestStartIndex, bestStartIndex + analysisWindowSize);
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Pitch analysis window: ${analysisWindowSize} samples`);
        
        const minPeriod = Math.floor(this.sampleRate / PITCH.MAX_FREQ);
        const maxPeriod = Math.floor(this.sampleRate / PITCH.MIN_FREQ);

        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Pitch period range: ${minPeriod} to ${maxPeriod} samples`);

        let bestCorrelation = 0;
        let bestLag = 0;
        let correlationCount = 0;

        for (let lag = minPeriod; lag < Math.min(maxPeriod, analysisData.length / 2); lag++) {
            let correlation = 0;
            let norm1 = 0, norm2 = 0;

            for (let i = 0; i < analysisData.length - lag; i++) {
                correlation += analysisData[i] * analysisData[i + lag];
                norm1 += analysisData[i] * analysisData[i];
                norm2 += analysisData[i + lag] * analysisData[i + lag];
            }

            if (norm1 > 0 && norm2 > 0) {
                correlation = correlation / Math.sqrt(norm1 * norm2);
            }

            if (correlation > bestCorrelation) {
                bestCorrelation = correlation;
                bestLag = lag;
            }
            correlationCount++;
        }
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Tested ${correlationCount} pitch periods, best correlation: ${bestCorrelation.toFixed(4)} at lag ${bestLag}`);

        const estimatedPitch = bestLag > 0 ? Math.round(this.sampleRate / bestLag) : 150;
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Pitch estimated: ${estimatedPitch} Hz`);

        return estimatedPitch;
    }
    
    /**
     * PITCH CANDIDATES of one frame — Praat's autocorrelation method (Boersma 1993). The DC-removed frame is Hann-windowed
     * and its autocorrelation divided by the WINDOW's own normalised autocorrelation, r(τ) = (r_a(τ)/r_a(0)) /
     * (r_w(τ)/r_w(0)): without that correction the taper makes every longer lag read lower, which is a bias towards the
     * higher octave (the old tracker's 500 Hz frames). Each local maximum of r in PITCH.MIN_FREQ..MAX_FREQ is a
     * candidate, its lag and height refined by a parabola; its strength is r − TRACK.OCTAVE_COST · log2(MIN_FREQ · τ),
     * which, all else equal, prefers the higher of two octaves (against sub-harmonic picks).
     * @param {Float32Array} windowData - PITCH_FRAME_SAMPLES of PCM.
     * @returns {Array<{f: number, r: number, strength: number}>} up to TRACK.MAX_CANDIDATES, strongest first.
     */
    pitchCandidates(windowData) {
        const L = windowData.length;
        if (L < 3) return [];
        const rw = this._hannAutocorrelation(L);
        let mean = 0;
        for (let i = 0; i < L; i++) mean += windowData[i];
        mean /= L;
        const a = new Float64Array(L);
        for (let i = 0; i < L; i++) a[i] = (windowData[i] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / L));
        const minLag = Math.max(2, Math.floor(this.sampleRate / PITCH.MAX_FREQ));
        const maxLag = Math.min(Math.ceil(this.sampleRate / PITCH.MIN_FREQ), Math.floor(L / 3));
        const ac = (tau) => { let s = 0; for (let i = 0; i + tau < L; i++) s += a[i] * a[i + tau]; return s; };
        const r0 = ac(0);
        if (!(r0 > 0)) return [];
        const r = new Float64Array(maxLag + 2);
        for (let tau = minLag - 1; tau <= maxLag + 1; tau++) r[tau] = (ac(tau) / r0) / rw[tau];
        const out = [];
        for (let tau = minLag; tau <= maxLag; tau++) {
            if (!(r[tau] > 0 && r[tau] > r[tau - 1] && r[tau] >= r[tau + 1])) continue;
            const y0 = r[tau - 1], y1 = r[tau], y2 = r[tau + 1], den = y0 - 2 * y1 + y2;
            const d = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den)) : 0;
            const lag = tau + d, peak = Math.min(1, y1 - 0.25 * (y0 - y2) * d);
            const f = this.sampleRate / lag;
            if (f < PITCH.MIN_FREQ || f > PITCH.MAX_FREQ) continue;
            out.push({ f, r: peak, strength: peak - TRACK.OCTAVE_COST * Math.log2(PITCH.MIN_FREQ * lag / this.sampleRate) });
        }
        out.sort((x, y) => y.strength - x.strength);
        return out.slice(0, TRACK.MAX_CANDIDATES);
    }

    /** The Hann window's normalised autocorrelation r_w(τ)/r_w(0) for frame length L (cached per L). @private */
    _hannAutocorrelation(L) {
        if (!this._rwCache) this._rwCache = new Map();
        let rw = this._rwCache.get(L);
        if (rw) return rw;
        const w = new Float64Array(L);
        for (let i = 0; i < L; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / L);
        rw = new Float64Array(L);
        let z = 0;
        for (let i = 0; i < L; i++) z += w[i] * w[i];
        for (let tau = 0; tau < L; tau++) { let s = 0; for (let i = 0; i + tau < L; i++) s += w[i] * w[i + tau]; rw[tau] = s / z; }
        this._rwCache.set(L, rw);
        return rw;
    }

    /**
     * One frame's F0 on its own: its strongest pitch candidate, when that is at least TRACK.VOICING_THRESHOLD; else 0.
     * voicedFrames does not use this — it tracks a path across frames — but a single frame has no path.
     * @param {Float32Array|number[]} windowData - PCM samples for one analysis window (PITCH_FRAME_SAMPLES).
     * @returns {number} Estimated pitch in Hz, or 0 if no reliable pitch is detected.
     */
    estimatePitchForWindow(windowData) {
        const best = this.pitchCandidates(Float32Array.from(windowData))[0];
        return best && best.r >= TRACK.VOICING_THRESHOLD ? best.f : 0;
    }

    // ==================================================
    // VOICE QUALITY METRICS (Tone & Harmonic Analysis)
    // ==================================================
    
    /**
     * Enhanced voice quality metrics calculation - replaces subjective tone scoring
     */
    calculateVoiceQualityMetrics(audioData) {
        const METHOD_NAME = 'calculateVoiceQualityMetrics';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Calculating voice quality metrics for ${audioData.length} samples`);
        
        if (audioData.length === 0) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 'No audio data for voice quality calculation');
            return { harmonic_to_noise: null, spectral_centroid: null, jitter: null, shimmer: null, voiced_frames: 0, glottal_periods: 0, centroid_windows: 0 };
        }

        // The centroid reads the whole buffer (Ed's ruling, 2026-11-06): it read 1 s from the loudest 20 ms window, so a
        // long answer never gained centroid windows past 1 s. measurePcm hands this the speech span.
        const speechData = audioData;

        // Harmonic-to-Noise Ratio in dB, on the pitch tracker's own voiced frames (null when none is voiced)
        const harmonicToNoise = this.calculateHarmonicToNoiseRatio(audioData);
        const hnrValue = harmonicToNoise === null ? null : Number(harmonicToNoise.toFixed(1));
        // Local jitter and shimmer, period by period on the same voiced frames (null when under three periods).
        // Four decimals: a healthy voice reads under ~0.01 and ~0.04, which three decimals would barely tell apart.
        const marks = this.periodMarks(audioData);
        const jitterRaw = this.calculateJitter(audioData, marks);
        const shimmerRaw = this.calculateShimmer(audioData, marks);
        const jitter = jitterRaw === null ? null : Number(jitterRaw.toFixed(4));
        const shimmer = shimmerRaw === null ? null : Number(shimmerRaw.toFixed(4));
        // evidence, not metrics (ReliabilityFloors): voiced frames, glottal periods, centroid windows
        const voicedFrames = this.voicedFrames(audioData).length;
        const glottalPeriods = marks.reduce((n, run) => n + Math.max(0, run.length - 1), 0);

        if (speechData.length < 1024) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 'Speech data too short for voice quality analysis');
            return { harmonic_to_noise: hnrValue, spectral_centroid: null, jitter, shimmer, voiced_frames: voicedFrames, glottal_periods: glottalPeriods, centroid_windows: 0 };
        }

        // Average Spectral Centroid (brightness/darkness of voice), on VOICED windows only (Ed's ruling, 2026-11-06):
        // a window counts when its start, centre and end lie in the pitch tracker's voiced frames, so pauses and clicks do not.
        const centroid = this.calculateAverageSpectralCentroid(speechData, this.voicedFrames(audioData));

        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Voice Quality: HNR=${hnrValue === null ? 'n/a' : `${hnrValue} dB`}, Centroid=${centroid.hz === null ? 'n/a' : `${centroid.hz.toFixed(0)}Hz`}, Jitter=${jitter ?? 'n/a'}, Shimmer=${shimmer ?? 'n/a'}`);

        return {
            harmonic_to_noise: hnrValue,
            spectral_centroid: centroid.hz === null ? null : Number(centroid.hz.toFixed(0)),
            jitter,
            shimmer,
            voiced_frames: voicedFrames,
            glottal_periods: glottalPeriods,
            centroid_windows: centroid.windows
        };
    }

    /**
     * Calculate average spectral centroid using existing methods.
     * @returns {{hz: number|null, windows: number}} the mean centroid over the 1024-sample windows that have one, and
     *   how many did (its evidence, ReliabilityFloors); hz null when none did
     */
    calculateAverageSpectralCentroid(audioData, voiced = null) {
        const METHOD_NAME = 'calculateAverageSpectralCentroid';

        const windowSize = Math.min(1024, audioData.length);
        let totalCentroid = 0;
        let windowCount = 0;
        // voiced: the samples a voiced frame covers (frames index into this same buffer); no list, every window counts
        let covered = null;
        if (voiced) {
            covered = new Uint8Array(audioData.length);
            for (const f of voiced) covered.fill(1, f.start, Math.min(audioData.length, f.start + f.window.length));
        }

        // Analyze multiple windows and average the centroids
        for (let i = 0; i < audioData.length - windowSize; i += windowSize / 2) {
            // voiced at its start, middle and end: a window straddling the edge of a voiced run reads what follows it
            if (covered && !(covered[i] && covered[i + (windowSize >> 1)] && covered[i + windowSize - 1])) continue;
            const window = audioData.slice(i, i + windowSize);
            const spectrum = this.calculateSpectrum(window); // Reuse existing method
            const centroid = this.calculateSpectralCentroid(spectrum); // Reuse existing method
            
            if (centroid > 0) {
                totalCentroid += centroid;
                windowCount++;
            }
        }
        
        const avgCentroid = windowCount > 0 ? totalCentroid / windowCount : null;
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Average spectral centroid: ${avgCentroid === null ? 'n/a' : avgCentroid.toFixed(0)}Hz (${windowCount} windows)`);
        
        return { hz: avgCentroid, windows: windowCount };
    }

    /**
     * Harmonic-to-Noise Ratio, autocorrelation method, at the speaker's own F0. For each of the pitch tracker's
     * voiced frames (voicedFrames), r is the frame's normalized autocorrelation at its pitch period:
     * Σ x[i]·x[i+T] / √(Σ x[i]² · Σ x[i+T]²) on the DC-removed frame, T = sampleRate / F0. r is averaged over the
     * voiced frames, then HNR = 10·log10(r / (1 − r)). For a periodic signal in white noise r is the harmonic share
     * of the power, so HNR is that signal's SNR.
     * @param {Float32Array} audioData - Full recording PCM data.
     * @returns {number|null} HNR in dB; null when no frame is voiced.
     */
    calculateHarmonicToNoiseRatio(audioData) {
        const METHOD_NAME = 'calculateHarmonicToNoiseRatio';

        const frames = this.voicedFrames(audioData);
        let sumR = 0;
        let count = 0;
        for (const { window, pitch } of frames) {
            const period = Math.round(this.sampleRate / pitch);
            if (period <= 0 || period >= window.length) continue;
            let mean = 0;
            for (let i = 0; i < window.length; i++) mean += window[i];
            mean /= window.length;
            let cross = 0, e1 = 0, e2 = 0;
            for (let i = 0; i + period < window.length; i++) {
                const a = window[i] - mean, b = window[i + period] - mean;
                cross += a * b; e1 += a * a; e2 += b * b;
            }
            if (e1 <= 0 || e2 <= 0) continue;
            sumR += cross / Math.sqrt(e1 * e2);
            count++;
        }
        if (count === 0) {
            AppLogger.debug(MODULE_NAME, METHOD_NAME, 'No voiced frames for harmonic-to-noise ratio');
            return null;
        }

        const r = Math.min(HNR_MAX_R, Math.max(1 - HNR_MAX_R, sumR / count));
        const hnrDb = 10 * Math.log10(r / (1 - r));

        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Harmonic-to-noise ratio: ${hnrDb.toFixed(1)} dB (mean r ${r.toFixed(4)}, ${count} voiced frames)`);

        return hnrDb;
    }

    /**
     * GLOTTAL PERIOD MARKS on the pitch tracker's voiced frames — what local jitter and shimmer are measured on.
     * Consecutive voiced frames (one hop apart) are one voiced run. In each run, from its first sample, every next mark
     * is placed by WAVEFORM MATCHING (Praat's cross-correlation method): the lag between PERIOD_SEARCH.from and .to of
     * the local period (the covering frame's F0) whose cycle best matches the cycle just ended, refined to a sub-sample
     * lag by a parabola through the correlation peak. A cycle's amplitude is its peak |sample|.
     *
     * Matching whole cycles, not picking each cycle's highest sample: on his dev1 takes peak-picking hopped between two
     * near-equal peaks of a cycle and read jitter 0.055-0.10; matching read 0.017-0.051 (2026-11-06).
     * @param {Float32Array} audioData - Full recording PCM data.
     * @returns {Array<Array<{pos: number, amp: number}>>} each run's marks: a cycle's start and its peak amplitude.
     */
    periodMarks(audioData) {
        const frames = this.voicedFrames(audioData);
        const runs = [];
        let run = [];
        for (const f of frames) {
            if (run.length && f.start - run[run.length - 1].start !== PITCH_HOP_SAMPLES) { runs.push(run); run = []; }
            run.push(f);
        }
        if (run.length) runs.push(run);

        const marked = [];
        for (const r of runs) {
            const a = r[0].start, b = r[r.length - 1].start + PITCH_FRAME_SAMPLES;
            const periodAt = (pos) => {
                const k = Math.max(0, Math.min(r.length - 1, Math.round((pos - a - PITCH_FRAME_SAMPLES / 2) / PITCH_HOP_SAMPLES)));
                return this.sampleRate / r[k].pitch;
            };
            const marks = [];
            let p = a;
            for (;;) {
                const T = periodAt(p), L = Math.round(T);
                const lo = Math.ceil(PERIOD_SEARCH.from * T), hi = Math.floor(PERIOD_SEARCH.to * T);
                const ip = Math.floor(p);
                if (ip + hi + L >= b) break;
                const corr = (lag, len = L) => {
                    let c = 0, e1 = 0, e2 = 0;
                    for (let i = 0; i < len; i++) { const u = audioData[ip + i], v = audioData[ip + lag + i]; c += u * v; e1 += u * u; e2 += v * v; }
                    return e1 > 0 && e2 > 0 ? c / Math.sqrt(e1 * e2) : 0;
                };
                const cs = [];
                let best = lo;
                for (let lag = lo; lag <= hi; lag++) { cs.push(corr(lag)); if (cs[cs.length - 1] > cs[best - lo]) best = lag; }
                const k = best - lo, y0 = cs[k - 1] ?? cs[k], y1 = cs[k], y2 = cs[k + 1] ?? cs[k], den = y0 - 2 * y1 + y2;
                let P = best + (den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den)) : 0);
                // THE CYCLE, NOT TWO OF THEM: a voice whose periods alternate (T·1.01, T·0.99, ...) is periodic at 2T,
                // and the tracker may read 2T (corrected r(2T) = 1 beats r(T) ≈ 0.93-0.98, which Praat's octave cost
                // does not overturn). Jitter is per glottal cycle, so a sub-cycle near P/2 that matches the next one
                // within SUBCYCLE_MATCH of the whole match is the cycle.
                const lo2 = Math.max(Math.ceil(this.sampleRate / PITCH.MAX_FREQ), Math.ceil(0.4 * P)), hi2 = Math.floor(0.6 * P);
                if (lo2 <= hi2) {
                    const cs2 = [];
                    let best2 = lo2;
                    for (let lag = lo2; lag <= hi2; lag++) { cs2.push(corr(lag, lag)); if (cs2[cs2.length - 1] > cs2[best2 - lo2]) best2 = lag; }
                    const k2 = best2 - lo2, z0 = cs2[k2 - 1] ?? cs2[k2], z1 = cs2[k2], z2 = cs2[k2 + 1] ?? cs2[k2], den2 = z0 - 2 * z1 + z2;
                    if (z1 >= SUBCYCLE_MATCH * y1) P = best2 + (den2 < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (z0 - z2) / den2)) : 0);
                }
                let amp = 0;
                for (let i = ip; i < ip + Math.round(P); i++) amp = Math.max(amp, Math.abs(audioData[i]));
                marks.push({ pos: p, amp });
                p += P;
            }
            marked.push(marks);
        }
        return marked;
    }

    /**
     * LOCAL JITTER, the standard definition: the mean absolute difference between consecutive glottal periods divided
     * by the mean period — period by period on periodMarks. A period counts only inside PITCH.MIN_FREQ..MAX_FREQ, and
     * a pair of consecutive periods only within PERIOD_FACTOR of each other; pairs never span two voiced runs.
     *
     * It replaced (2026-11-06) the period-to-period difference of whole 30 ms WINDOWS' integer-lag pitch estimates on
     * a 7.5 ms hop, unvoiced windows included — the variation of the pitch contour and its quantization, not of the
     * glottal cycle (the real clip read 0.167; a healthy voice reads under ~0.01).
     * @param {Float32Array} audioData - Full recording PCM data.
     * @param {Array} [marks] - periodMarks(audioData), when the caller has them.
     * @returns {number|null} jitter as a fraction (0.01 = 1 %); null under three periods.
     */
    calculateJitter(audioData, marks = this.periodMarks(audioData)) {
        const METHOD_NAME = 'calculateJitter';
        const minP = this.sampleRate / PITCH.MAX_FREQ, maxP = this.sampleRate / PITCH.MIN_FREQ;
        let periods = 0, periodSum = 0, pairs = 0, diffSum = 0;
        for (const run of marks) {
            let prev = null;
            for (let k = 1; k < run.length; k++) {
                const P = run[k].pos - run[k - 1].pos;
                if (P < minP || P > maxP) { prev = null; continue; }
                periods++; periodSum += P;
                if (prev !== null && Math.max(P, prev) / Math.min(P, prev) <= PERIOD_FACTOR) { pairs++; diffSum += Math.abs(P - prev); }
                prev = P;
            }
        }
        if (periods < 3 || pairs < 1) {
            AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Not enough glottal periods for jitter calculation');
            return null;
        }
        const jitter = (diffSum / pairs) / (periodSum / periods);
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Jitter (local): ${jitter.toFixed(4)} (${periods} periods, ${pairs} pairs)`);
        return jitter;
    }

    /**
     * LOCAL SHIMMER, the standard definition: the mean absolute difference between consecutive periods' peak
     * amplitudes divided by the mean amplitude — on periodMarks' cycles (each cycle's peak |sample|). A pair counts only
     * within AMPLITUDE_FACTOR of each other, never across two voiced runs. A ratio of amplitudes, so the mic's gain
     * cancels.
     *
     * It replaced (2026-11-06) the difference of consecutive 10 ms RMS windows over the whole region, silence and
     * syllable envelopes included — the loudness contour, not the cycle (the real clip read 0.55).
     * @param {Float32Array} audioData - Full recording PCM data.
     * @param {Array} [marks] - periodMarks(audioData), when the caller has them.
     * @returns {number|null} shimmer as a fraction (0.04 = 4 %); null under three periods.
     */
    calculateShimmer(audioData, marks = this.periodMarks(audioData)) {
        const METHOD_NAME = 'calculateShimmer';
        let peaks = 0, ampSum = 0, pairs = 0, diffSum = 0;
        for (const run of marks) {
            let prev = null;
            for (const { amp } of run) {
                if (!(amp > 0)) { prev = null; continue; }
                peaks++; ampSum += amp;
                if (prev !== null && Math.max(amp, prev) / Math.min(amp, prev) <= AMPLITUDE_FACTOR) { pairs++; diffSum += Math.abs(amp - prev); }
                prev = amp;
            }
        }
        if (peaks < 3 || pairs < 1) {
            AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Not enough glottal peaks for shimmer calculation');
            return null;
        }
        const shimmer = (diffSum / pairs) / (ampSum / peaks);
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Shimmer (local): ${shimmer.toFixed(4)} (${peaks} peaks, ${pairs} pairs)`);
        return shimmer;
    }

    // ==================================================
    // VOLUME METRICS (Amplitude & Dynamic Range Analysis)
    // ==================================================
    
    /**
     * Volume: the ACTIVE 20 ms windows (activeSpeechLevel, ITU-T P.56 style), each window's level in plain dBFS (0 =
     * full scale; a full-scale sine is −3). mean_db is the active speech level; p5_db and p95_db the 5th and 95th
     * percentiles of the active windows' levels (dBFS); std_dev and p5_p95_range_db spreads between levels, in dB.
     * @returns {{mean_db: number|null, std_dev: number|null, p5_db: number|null, p95_db: number|null,
     *   p5_p95_range_db: number|null, sample_count: number}} all null (nothing stored) when under three windows are active.
     */
    calculateVolumeMetrics(audioData) {
        const METHOD_NAME = 'calculateVolumeMetrics';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Calculating volume metrics for ${audioData.length} samples`);
        
        const windowSize = Math.floor(this.sampleRate * 0.02);

        // The whole buffer (Ed's ruling, 2026-11-06): it read at most 2 s from the loudest 20 ms window, so a long
        // answer never gained volume windows past 2 s. measurePcm hands this the speech span.
        const speechData = audioData;

        // THE ACTIVE WINDOWS, P.56 style (Ed's ruling, 2026-11-06): the windows over the activity threshold that
        // activeSpeechLevel finds by scanning up from the quietest. They were the windows within DEPTH_DB.VOICED of the
        // single loudest one, so one loud moment moved which windows counted and so the mean — halves of one answer
        // read -9.1 against -19.9 dBFS at the top.
        const powers = [];
        for (let i = 0; i < speechData.length - windowSize; i += windowSize) powers.push(meanPower(speechData, i, i + windowSize));
        const asl = activeSpeechLevel(powers);

        // No reading is null, never 0: 0 dBFS is full scale, a real (and the loudest) level.
        const noReading = { mean_db: null, std_dev: null, p5_db: null, p95_db: null, p5_p95_range_db: null, sample_count: 0 };
        const dbValues = asl ? powers.filter((p, i) => asl.active[i]).map((p) => 10 * Math.log10(p)) : [];
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Volume: ${powers.length} windows, ${dbValues.length} active (threshold ${asl ? (10 * Math.log10(asl.thresholdPower)).toFixed(1) : '-'} dBFS)`);
        if (dbValues.length < 3) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 'Not enough energy data for volume metrics analysis');
            return noReading;
        }

        // mean: the active speech level, the active windows' mean POWER in dBFS (a full-scale sine reads -3). The
        // spread and the percentiles are over the active windows' levels in dB.
        const meanDb = 10 * Math.log10(asl.levelPower);
        const meanOfDb = dbValues.reduce((sum, val) => sum + val, 0) / dbValues.length;
        const volumeStdDev = Math.sqrt(dbValues.reduce((sum, val) => sum + Math.pow(val - meanOfDb, 2), 0) / dbValues.length);
        const p5 = percentile(dbValues, 5), p95 = percentile(dbValues, 95);

        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Volume: active level ${meanDb.toFixed(1)} dBFS, P5-P95 ${p5.toFixed(1)} to ${p95.toFixed(1)} dBFS, StdDev ${volumeStdDev.toFixed(1)} dB`);

        return {
            mean_db: Number(meanDb.toFixed(1)),
            std_dev: Number(volumeStdDev.toFixed(1)),
            p5_db: Number(p5.toFixed(1)),
            p95_db: Number(p95.toFixed(1)),
            p5_p95_range_db: Number((p95 - p5).toFixed(1)),
            sample_count: dbValues.length
        };
    }

    /**
     * Calculate a single representative volume level in dB for the recording.
     *
     * Identifies the highest-energy 20 ms window, then computes the RMS level over
     * an 8 000-sample analysis window centred on that region.  The RMS is converted
     * to dB with a +96 dB offset so that typical speech falls in the audible 40–80 dB
     * range.  Result is clamped to [0, 100].
     *
     * For per-window volume statistics (min, max, std-dev) use `calculateVolumeMetrics()`.
     *
     * @param {Float32Array} audioData - Full recording PCM data.
     * @returns {number} Volume in dB, clamped to [0, 100].  Returns 0 for silent input.
     */
    calculateVolume(audioData) {
        const METHOD_NAME = 'calculateVolume';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Calculating volume for ${audioData.length} samples`);
        
        if (audioData.length === 0) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 'No audio data for volume calculation');
            return 0;
        }
        
        // Find highest energy section
        const windowSize = Math.floor(this.sampleRate * 0.02);
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Using window size: ${windowSize} samples`);
        
        let maxEnergy = 0;
        let bestStartIndex = 0;
        let energyCount = 0;
        
        for (let i = 0; i < audioData.length - windowSize; i += windowSize) {
            let energy = 0;
            for (let j = i; j < i + windowSize && j < audioData.length; j++) {
                energy += audioData[j] * audioData[j];
            }
            energyCount++;
            if (energy > maxEnergy) {
                maxEnergy = energy;
                bestStartIndex = i;
            }
        }
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Analyzed ${energyCount} energy windows, max energy: ${maxEnergy.toFixed(6)} at index ${bestStartIndex}`);
        
        // Analyze larger window around speech
        const analysisWindowSize = Math.min(8000, audioData.length - bestStartIndex);
        const speechData = audioData.slice(bestStartIndex, bestStartIndex + analysisWindowSize);
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Analysis window size: ${analysisWindowSize} samples`);
        
        let sum = 0;
        for (let i = 0; i < speechData.length; i++) {
            sum += speechData[i] * speechData[i];
        }
        const rms = Math.sqrt(sum / speechData.length);
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `RMS in speech window: ${rms.toFixed(6)}`);
        
        if (rms > 0) {
            const db = 20 * Math.log10(rms) + 96;
            AppLogger.debug(MODULE_NAME, METHOD_NAME, `Volume calculated: ${db.toFixed(1)} dB`);
            return Math.max(0, Math.min(100, Math.round(db)));
        }
        
        AppLogger.warn(MODULE_NAME, METHOD_NAME, 'RMS is zero - no volume detected');
        return 0;
    }

    // ==================================================
    // DERIVED METRICS (Composite Analysis)
    // ==================================================
    
    /**
     * Compute a composite vocal expressiveness score on a 0–10 scale.
     *
     * Combines three sub-metrics with the following weighting:
     *   - 50% pitch variation    — coefficient of variation of F0 (most perceptually salient).
     *   - 30% voice quality      — harmonic share of the power, from the HNR (dB) of `calculateVoiceQualityMetrics()`.
     *   - 20% volume variation   — dB spread over the mean level above the 16-bit floor (dBFS + 96).
     *
     * Scores < 1.5 suggest monotone or fatigue-related speech; scores ≥ 7 indicate
     * highly animated delivery.  Returns 5.0 (neutral) for empty input.
     *
     * @param {Float32Array} audioData - Full recording PCM data.
     * @returns {number} Inflection score in [0, 10], rounded to one decimal place.
     */
    calculateInflection(audioData) {
        const METHOD_NAME = 'calculateInflection';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Calculating inflection for ${audioData.length} samples`);
        
        if (audioData.length === 0) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 'No audio data for inflection calculation');
            return null;
        }
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Calculating inflection components...');
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Calculating pitch metrics...');
        const pitchMetrics = this.calculatePitchMetrics(audioData);
        // Every term needs its own reading: a missing one is not a 0 (nothing is computed to fill a row, 2026-11-06).
        if (!(pitchMetrics.mean_hz > 0)) return null;
        const pitchVariationScore = Math.max(0, Math.min(10, (pitchMetrics.std_dev / pitchMetrics.mean_hz) * 100));

        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Calculating voice quality metrics...');
        const voiceQualityMetrics = this.calculateVoiceQualityMetrics(audioData);
        // The tone term is the harmonic SHARE of the power, 0-1, x10 — what the old ratio claimed to be. HNR (dB)
        // gives it back exactly: share = 1 / (1 + 10^(−HNR/10)).
        const hnrDb = voiceQualityMetrics.harmonic_to_noise;
        if (hnrDb === null) return null;
        const voiceQualityVariation = 10 / (1 + 10 ** (-hnrDb / 10));

        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Calculating volume metrics...');
        const volumeMetrics = this.calculateVolumeMetrics(audioData);
        // The volume CV is taken against the level above the 16-bit floor, as it always was (INFLECTION_VOLUME_FLOOR_DB).
        if (volumeMetrics.mean_db === null) return null;
        const volumeAboveFloor = volumeMetrics.mean_db + INFLECTION_VOLUME_FLOOR_DB;
        const volumeVariationScore = volumeAboveFloor > 0 ?
            Math.max(0, Math.min(10, (volumeMetrics.std_dev / volumeAboveFloor) * 100)) : 0;

        const inflectionScore = (pitchVariationScore * 0.5 + voiceQualityVariation * 0.3 + volumeVariationScore * 0.2);
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Inflection = ${inflectionScore.toFixed(2)}/10`);
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Weighting: Pitch 50% (most noticeable), Tone 30% (richness), Volume 20% (emphasis)');
        
        const result = Math.max(0, Math.round(inflectionScore * 10) / 10);
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Inflection calculated: ${result}/10`);
        return result;
    }

    // ==================================================
    // UTILITY METHODS (Shared Analysis Functions)
    // ==================================================

    /**
     * Compute the Root Mean Square energy of a magnitude or PCM array.
     *
     * Shared utility used by virtually every method in this class — cadence pause
     * detection, SNR estimation, volume metrics, jitter/shimmer calculation, and
     * the VAD energy comparisons inside `calculatePitchMetrics()`.
     *
     * @param {Float32Array|number[]} audioData - PCM samples or magnitude values.
     * @returns {number} RMS value ≥ 0.  Returns 0 for an empty array.
     */
    calculateRMSEnergy(audioData) {
        if (audioData.length === 0) return 0;
        
        let sum = 0;
        for (let i = 0; i < audioData.length; i++) {
            sum += audioData[i] * audioData[i];
        }
        return Math.sqrt(sum / audioData.length);
    }

    /**
     * Compute the spectral centroid (centre of mass) of a magnitude spectrum.
     *
     * The centroid represents the "brightness" of the sound — higher values indicate
     * more high-frequency energy.  Typical conversational speech centroids fall in
     * the 1 000–3 000 Hz range.  Used by `calculateSpectralClaritySimple()` and
     * `calculateAverageSpectralCentroid()`.
     *
     * @param {number[]} spectrum - Magnitude spectrum array from `calculateSpectrum()`,
     *                              where index `i` maps to frequency
     *                              `i * sampleRate / (2 * spectrum.length)` Hz.
     * @returns {number} Centroid frequency in Hz.  Returns 0 for a zero-magnitude spectrum.
     */
    calculateSpectralCentroid(spectrum) {
        let weightedSum = 0;
        let magnitudeSum = 0;
        
        for (let i = 0; i < spectrum.length; i++) {
            const frequency = i * this.sampleRate / (2 * spectrum.length);
            weightedSum += frequency * spectrum[i];
            magnitudeSum += spectrum[i];
        }
        
        return magnitudeSum > 0 ? weightedSum / magnitudeSum : 0;
    }
    
    /**
     * Find the spectral rolloff frequency — the frequency below which 85% of the
     * total spectral energy is contained.
     *
     * A useful proxy for the upper bandwidth of speech.  Clearer, higher-quality
     * recordings tend to have a higher rolloff.  Used by `calculateSpectralClaritySimple()`.
     *
     * @param {number[]} spectrum - Magnitude spectrum array from `calculateSpectrum()`.
     * @returns {number} Rolloff frequency in Hz.  Returns `sampleRate / 2` (Nyquist)
     *                   if the threshold is never reached.
     */
    calculateSpectralRolloff(spectrum) {
        const totalEnergy = spectrum.reduce((sum, mag) => sum + mag * mag, 0);
        const threshold = totalEnergy * 0.85;
        
        let cumulativeEnergy = 0;
        for (let i = 0; i < spectrum.length; i++) {
            cumulativeEnergy += spectrum[i] * spectrum[i];
            if (cumulativeEnergy >= threshold) {
                return i * this.sampleRate / (2 * spectrum.length);
            }
        }
        
        return this.sampleRate / 2;
    }
    
    /**
     * Compute the magnitude spectrum of an audio window via a naive DFT.
     *
     * Returns an array of length `audioWindow.length / 2` where each element is the
     * magnitude `√(real² + imag²)` at the corresponding frequency bin.  Bin `k` maps
     * to `k * sampleRate / audioWindow.length` Hz.
     *
     * Note: This is an O(n²) DFT, not an FFT.  It is intentionally kept simple for
     * portability and correctness at the window sizes used here (≤ 1 024 samples).
     * Do not call on large buffers.
     *
     * @param {Float32Array|number[]} audioWindow - PCM samples for one analysis window.
     *                                              Length should be a power of two for
     *                                              consistent bin spacing.
     * @returns {number[]} Magnitude spectrum of length `audioWindow.length / 2`.
     */
    calculateSpectrum(audioWindow) {
        // A power-of-two window (every caller's 1024) takes the FFT: the same bins as the DFT below, in O(n log n) — the
        // centroid now reads every window of the speech span, ~1 400 windows for 45 s (Ed's ruling, 2026-11-06).
        const L = audioWindow.length;
        if (L >= 2 && (L & (L - 1)) === 0) return magnitudeSpectrumFft(audioWindow);
        const spectrum = new Array(audioWindow.length / 2).fill(0);
        
        for (let k = 0; k < spectrum.length; k++) {
            let real = 0, imag = 0;
            
            for (let n = 0; n < audioWindow.length; n++) {
                const angle = -2 * Math.PI * k * n / audioWindow.length;
                real += audioWindow[n] * Math.cos(angle);
                imag += audioWindow[n] * Math.sin(angle);
            }
            
            spectrum[k] = Math.sqrt(real * real + imag * imag);
        }
        
        return spectrum;
    }
}