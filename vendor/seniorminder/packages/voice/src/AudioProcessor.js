// ==================================================
// 📄 src/voice/AudioProcessor.js
// ==================================================

// node core in ESM
import { spawn } from 'child_process';

import { AppLogger, guardChild } from '@seniorminder/logger';
import { DEPTH_DB, MIN_RUN_MS, levelGate, meanPower } from './LevelGate.js';
import { VoiceConstants } from './utils/Constants.js';
const { AUDIO, THRESHOLDS, PITCH } = VoiceConstants;

const MODULE_NAME = 'AudioProcessor';

/** The syllable detector's frames: the mean power of each 20 ms window (the last one may be short). */
export function syllableFramePowers(audioData, sampleRate = AUDIO.SAMPLE_RATE) {
    const windowSize = Math.floor(sampleRate * AUDIO.SYLLABLE_WINDOW_MS / 1000); // 20ms window
    const powers = [];
    for (let i = 0; i < audioData.length; i += windowSize) powers.push(meanPower(audioData, i, Math.min(i + windowSize, audioData.length)));
    return powers;
}

/**
 * THE ONE SYLLABLE DETECTOR. Counts energy bursts in PCM: a 20 ms window within DEPTH_DB.SYLLABLE of the loudest
 * window (LevelGate — relative to the clip's own level, so the count does not move with the mic's gain) opens a
 * syllable, MIN_SYLLABLE_GAP_MS of windows under it closes one. Pure, so the whole-clip word estimate
 * (AudioProcessor.detectSyllables) and each 2 s segment of speech_rate_variability
 * (MetricsCalculator.calculateSpeechRateVariability) count with the same detector.
 * @param {Float32Array} audioData - PCM samples.
 * @param {number} [sampleRate]
 * @param {{loudest?: number}} [opts] - the loudest 20 ms window's mean power to judge against, when `audioData` is
 *   part of a clip (a segment is judged against its whole speech span, so a quiet segment's room noise is not a
 *   syllable). Default: this audio's own loudest window.
 *   `depthDb` — the syllable depth; DEPTH_DB.SYLLABLE unless a measurement sweeps it.
 * @returns {number} syllable count.
 */
export function countSyllables(audioData, sampleRate = AUDIO.SAMPLE_RATE, { loudest, depthDb = DEPTH_DB.SYLLABLE } = {}) {
    if (!audioData || audioData.length === 0) return 0;

    const powers = syllableFramePowers(audioData, sampleRate);
    const gate = levelGate(loudest ?? powers, depthDb);
    const minSyllableGap = THRESHOLDS.MIN_SYLLABLE_GAP_MS / AUDIO.SYLLABLE_WINDOW_MS; // Min windows for gap

    let syllableCount = 0;
    let inSyllable = false;
    let silenceWindows = 0;

    for (const power of powers) {
        if (gate.passes(power)) {
            if (!inSyllable) {
                syllableCount++;
                inSyllable = true;
            }
            silenceWindows = 0;
        } else {
            if (inSyllable) {
                silenceWindows++;
                if (silenceWindows >= minSyllableGap) {
                    inSyllable = false;
                    silenceWindows = 0;
                }
            }
        }
    }
    return syllableCount;
}

/**
 * The speech span: from the start of the first to the end of the last MIN_RUN_MS run of continuous speech windows
 * (10 ms). A window is speech when its mean power clears BOTH
 *   - the room: the clip's 10th-percentile window × (1 + SPEECH_THRESHOLD_FACTOR) — relative to the clip's own quiet,
 *     which is what keeps a steady television or fan out of the span; and
 *   - the clip: within DEPTH_DB.SPEECH of its loudest window (LevelGate) — the pause detector's own line between
 *     sound and pause. This replaced the absolute MIN_SPEECH_ENERGY_THRESHOLD (0.015 summed, about −40 dBFS), under
 *     which a quiet clip had no span at all. Both are relative, so the span does not move with the mic's gain.
 * Pure.
 * @returns {{found: boolean, speechStart: number, speechEnd: number, speechDuration: number,
 *   loudest: number, noiseFloor: number, threshold: number}} seconds; powers are mean squares.
 */
export function speechSpanOf(audioData, sampleRate = AUDIO.SAMPLE_RATE) {
    const windowSize = Math.floor(sampleRate * AUDIO.WINDOW_SIZE_MS / 1000); // 10ms window
    const powers = [];
    for (let i = 0; i < audioData.length; i += windowSize) powers.push(meanPower(audioData, i, Math.min(i + windowSize, audioData.length)));

    const gate = levelGate(powers, DEPTH_DB.SPEECH);
    const sorted = [...powers].sort((a, b) => a - b);
    const noiseFloor = sorted[Math.floor(sorted.length * THRESHOLDS.NOISE_FLOOR_PERCENTILE)] || 0; // Default to 0 if array is empty
    const threshold = Math.max(noiseFloor * (1 + THRESHOLDS.SPEECH_THRESHOLD_FACTOR), gate.floor);

    // An edge is MIN_RUN_MS of continuous sound: the span opens at the first window that begins such a run and closes
    // at the last window that ends one, so an isolated click cannot open or close it (Ed's ruling, 2026-11-06).
    const run = Math.ceil(MIN_RUN_MS / AUDIO.WINDOW_SIZE_MS);
    let first = -1, last = -1, n = 0;
    for (let i = 0; i < powers.length; i++) {
        n = powers[i] > threshold ? n + 1 : 0;
        if (n >= run) { if (first === -1) first = i - run + 1; last = i; }
    }
    if (first === -1) return { found: false, speechStart: 0, speechEnd: 0, speechDuration: 0, loudest: gate.loudest, noiseFloor, threshold };

    const speechStart = first * windowSize / sampleRate;
    const speechEnd = (last + 1) * windowSize / sampleRate;
    return { found: true, speechStart, speechEnd, speechDuration: speechEnd - speechStart, loudest: gate.loudest, noiseFloor, threshold };
}

export class AudioProcessor {
    /**
     * @param {object} options
     * @param {{ getPath: () => string }} options.ffmpegLocator - Either a
     *        `FFmpegLocator` instance (main thread) or a `FFmpegPathRef`
     *        (worker thread). Both expose `getPath()` returning the
     *        absolute path to the FFmpeg binary.
     */
    constructor(options = {}) {
        const METHOD_NAME = 'constructor';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'AudioProcessor initialized.');

        if (!options.ffmpegLocator || typeof options.ffmpegLocator.getPath !== 'function') {
            throw new Error('AudioProcessor requires ffmpegLocator option with a getPath() method');
        }
        this.ffmpegLocator = options.ffmpegLocator;

        this.sampleRate = AUDIO.SAMPLE_RATE;
    }
    
    async getAudioData(audioFile) {
        const METHOD_NAME = 'getAudioData';
        await AppLogger.debug(MODULE_NAME, METHOD_NAME, `Getting audio data from: ${audioFile}`);
        
        return new Promise((resolve, reject) => {
            const ffmpegProcess = spawn(this.ffmpegLocator.getPath(), [
                '-i', audioFile,
                '-f', 'f32le',
                '-acodec', 'pcm_f32le',
                '-ac', '1',
                '-ar', this.sampleRate.toString(),
                '-'
            ], {
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true
            });
            guardChild(ffmpegProcess, 'ffmpeg decode');   // E17 — an 'error' listener on the child and its streams, from spawn

            let audioBuffer = Buffer.alloc(0);
            
            ffmpegProcess.stdout.on('data', (data) => {
                audioBuffer = Buffer.concat([audioBuffer, data]);
            });

            ffmpegProcess.on('close', async (code) => {
                if (code !== 0) {
                    await AppLogger.error(MODULE_NAME, METHOD_NAME, 'Failed to read audio data');
                    reject(new Error('Failed to read audio data'));
                    return;
                }
                const float32Data = new Float32Array(audioBuffer.length / 4);
                for (let i = 0; i < float32Data.length; i++) {
                    float32Data[i] = audioBuffer.readFloatLE(i * 4);
                }
                await AppLogger.debug(MODULE_NAME, METHOD_NAME, `Audio data extracted: ${float32Data.length} samples`);
                resolve(float32Data);
            });

            ffmpegProcess.on('error', async (err) => {
                await AppLogger.error(MODULE_NAME, METHOD_NAME, `FFmpeg error: ${err.message}`);
                reject(err);
            });
        });
    }

    detectSyllables(audioData) {
        const METHOD_NAME = 'detectSyllables';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Detecting syllables in ${audioData.length} samples`);
        
        const syllableCount = countSyllables(audioData, this.sampleRate);

        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Detected ${syllableCount} syllables`);
        return syllableCount;
    }

    async detectSpeechBoundaries(audioFile) {
        const METHOD_NAME = 'detectSpeechBoundaries';
        await AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Detecting speech boundaries...');
        
        const audioData = await this.getAudioData(audioFile);
        if (audioData.length === 0) {
            await AppLogger.warn(MODULE_NAME, METHOD_NAME, 'No audio data to analyze for speech boundaries');
            return { speechStart: 0, speechDuration: 0, speechEnd: 0 }; 
        }

        const span = speechSpanOf(audioData, this.sampleRate);

        await AppLogger.debug(MODULE_NAME, METHOD_NAME, `Audio analysis - Loudest power: ${span.loudest.toExponential(3)}, Noise floor: ${span.noiseFloor.toExponential(3)}, Threshold: ${span.threshold.toExponential(3)}`);

        if (!span.found) {
            await AppLogger.warn(MODULE_NAME, METHOD_NAME, 'No clear speech boundaries detected');
            return { speechStart: 0, speechDuration: audioData.length / this.sampleRate, speechEnd: 0 };
        }

        await AppLogger.debug(MODULE_NAME, METHOD_NAME, `Speech boundaries detected: ${span.speechStart.toFixed(2)}s to ${span.speechEnd.toFixed(2)}s (${span.speechDuration.toFixed(2)}s)`);

        return { speechStart: span.speechStart, speechDuration: span.speechDuration, speechEnd: span.speechEnd };
    }
}