// ==================================================
// 📄 src/voice/SpeechTranscriber.js
// ==================================================
// Uses @xenova/transformers to run Whisper entirely in JavaScript
// Model is loaded once and kept in memory for fast subsequent calls
//
// Performance:
//   First call:  ~3-5s (download + load model)
//   Each call:   ~1-2s (inference only)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { AppLogger } from '@seniorminder/logger';
import { decodeWav } from '@seniorminder/common/WavDecoder';
import { resolveWhisperModel } from '@seniorminder/device';

const MODULE_NAME = 'SpeechTranscriber';

// ══ WHERE WHISPER'S MODEL LIVES, AND WHY IT USED TO DEPEND ON WHO LAUNCHED THE PROCESS ══════════════
//
// This file set `env.cacheDir = process.env.TRANSFORMERS_CACHE || './.cache/transformers'` — a
// RELATIVE path, resolved against the working directory of whatever process happened to construct a
// transcriber. So the cache followed the launcher, and every launcher got its own.
//
// ⚠ MEASURED ON THIS CHECKOUT, 2026-09-21. Four caches, in four directories, holding the same two
// models between them:
//
//     .cache/transformers                        117 MB   (scripts run from the repo root)
//     packages/electron-app/.cache/transformers  1.2 GB   (the app — see the unit's WorkingDirectory)
//     packages/orchestrator/.cache/transformers  117 MB
//     packages/dev-tools/.cache/transformers     117 MB
//
// ⚠ AND ON A PI THE APP'S IS NOT THE REPO ROOT'S. installer/pi/config/seniorminder.service sets
// `WorkingDirectory=/home/seniorminder/seniorminder/packages/electron-app`, and ProcessTranscriber
// forks its child with no `cwd` option, so the child inherits it. Both the main process and the
// transcription child therefore resolve
//
//     /home/seniorminder/seniorminder/packages/electron-app/.cache/transformers
//
// while anything a person runs from `~/seniorminder` — the installer, a warm script, a bench —
// resolves `/home/seniorminder/seniorminder/.cache/transformers`. A warm that filled the second one
// would leave the app looking at the first, and the device would still download the model the first
// time it needed it. That is the whole reason this function exists.
//
// ── THE RULE ───────────────────────────────────────────────────────────────────────────────────────
//   1. TRANSFORMERS_CACHE wins, always. An operator who names a directory gets that directory.
//   2. Otherwise the CANONICAL directory is the repository root's `.cache/transformers`, so every
//      process in the tree agrees regardless of where it was started from.
//   3. ⚠ BUT A DEVICE MUST NEVER RE-DOWNLOAD BECAUSE THIS PATH MOVED. dev1 and Richard's box already
//      hold their model under the app's own cwd. So when the model being asked for ALREADY EXISTS in
//      one of the known directories, that directory is ADOPTED and nothing is fetched. A new Pi has
//      none of them and gets the canonical one; an existing box keeps what it has, and — the part
//      that matters — the app and the warm script now agree about WHICH, because they both ask here.
//
// ⚠ AND IF THE REPOSITORY ROOT CANNOT BE IDENTIFIED, THE OLD BEHAVIOUR IS WHAT HAPPENS. A packaged
// build (asar) has no repo root above this file; there, and anywhere else this is not a checkout, the
// answer is the cwd-relative path it has always been. This changes the shipping path, not every path.

/** The known places a transformers cache can already exist, in preference order. */
function _cacheCandidates(root, cwd) {
    const out = [];
    if (root) {
        out.push(path.join(root, '.cache', 'transformers'));
        // The Pi's live one: the unit's WorkingDirectory.
        out.push(path.join(root, 'packages', 'electron-app', '.cache', 'transformers'));
    }
    // Whatever THIS process's cwd is — today's behaviour, and what every legacy box has.
    out.push(path.resolve(cwd, '.cache', 'transformers'));
    return [...new Set(out)];
}

/** The repository root above this file, or null when there is no checkout above it (a packaged app). */
export function transformersRepoRoot(here = path.dirname(fileURLToPath(import.meta.url))) {
    // src → voice → packages → root
    const candidate = path.resolve(here, '..', '..', '..');
    try {
        if (fs.existsSync(path.join(candidate, 'package.json'))
            && fs.existsSync(path.join(candidate, 'packages'))) return candidate;
    } catch { /* an unreadable parent is the same as no root */ }
    return null;
}

/**
 * PURE-ish (reads the filesystem, writes nothing): the directory @xenova/transformers should cache in.
 *
 * @param {string|null} modelId  e.g. 'Xenova/whisper-tiny.en'. When given, a directory that ALREADY
 *   holds this model is preferred over the canonical one, so moving the default cannot cost a device a
 *   re-download. When null, the canonical directory is returned without looking at the disk.
 * @param {{cwd?: string, env?: object, root?: string|null}} [o]
 * @returns {{dir: string, why: string, adopted: boolean}}
 */
export function resolveTransformersCacheDir(modelId = null, o = {}) {
    const cwd = o.cwd || process.cwd();
    const env = o.env || process.env;
    const root = o.root !== undefined ? o.root : transformersRepoRoot();

    if (env.TRANSFORMERS_CACHE) {
        return { dir: path.resolve(env.TRANSFORMERS_CACHE), why: 'TRANSFORMERS_CACHE is set', adopted: false };
    }
    if (!root) {
        // No checkout above this file — a packaged build. Exactly what it did before.
        return { dir: path.resolve(cwd, '.cache', 'transformers'),
            why: 'no repository root above this file; cwd-relative, as before', adopted: false };
    }
    const canonical = path.join(root, '.cache', 'transformers');
    if (modelId) {
        for (const dir of _cacheCandidates(root, cwd)) {
            let has = false;
            try { has = fs.existsSync(path.join(dir, ...modelId.split('/'))); } catch { has = false; }
            if (!has) continue;
            return {
                dir,
                why: dir === canonical
                    ? `the repository root's cache already holds ${modelId}`
                    : `ADOPTED an existing cache that already holds ${modelId} — moving the default must `
                        + 'never cost a device a re-download',
                adopted: dir !== canonical,
            };
        }
    }
    return { dir: canonical, why: "the repository root's cache", adopted: false };
}

export class SpeechTranscriber {
    // Provider identifier for database storage
    static PROVIDER = 'Whisper';
    
    // Track active instances to prevent conflicts
    static activeInstance = null;

    /**
     * Resolve the Whisper model id and language from options/env — the single source of
     * truth shared by the constructor and any caller that needs to record what actually
     * ran (e.g. ParallelRecorder's stored transcription metadata). English selects the
     * faster `.en` (English-only) model; any other language selects the multilingual one.
     *
     * @param {Object} [options={}]
     * @param {string} [options.model]    - Model size; defaults to the device-class resolver
     *   (resolveWhisperModel: env override → Pi=tiny / desktop=base). Not the old flat 'tiny'.
     * @param {string} [options.language] - Language code; defaults to LANGUAGE, then 'en' (lower-cased).
     * @returns {{ modelName: string, language: string, modelId: string, isEnglishOnly: boolean }}
     */
    static resolveConfig(options = {}) {
        // WHISPER_MODEL is a device-class default (Pi=tiny, desktop=base) resolved in ONE place
        // (@seniorminder/device). An explicit env override still wins inside resolveWhisperModel.
        const modelName = options.model || resolveWhisperModel();
        const language = (options.language || process.env.LANGUAGE || 'en').toLowerCase();
        const modelId = language === 'en'
            ? `Xenova/whisper-${modelName}.en`
            : `Xenova/whisper-${modelName}`;
        return { modelName, language, modelId, isEnglishOnly: modelId.endsWith('.en') };
    }

    /**
     * @param {Object} [options={}]
     * @param {string} [options.model]    - Whisper model size: `'tiny'`, `'base'`, `'small'`,
     *                                      `'medium'`, or `'large'`.  Defaults to the
     *                                      `WHISPER_MODEL` env var, then `'tiny'`.
     *                                      The `.en` English-only variant is automatically
     *                                      selected when `language` is `'en'` for faster
     *                                      inference.
     * @param {string} [options.language] - BCP-47 language code (lower-cased).  Defaults to
     *                                      the `LANGUAGE` env var, then `'en'`.  Non-English
     *                                      values select the multilingual model variant.
     *
     * Construction is synchronous and lightweight — the ONNX model is NOT loaded here.
     * Call `initialize()` (or let `transcribe()` call it lazily) to load the pipeline.
     */
    constructor(options = {}) {
        const METHOD_NAME = 'constructor';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'SpeechTranscriber initializing...');
        
        // Model options - tiny.en is fastest for English. Resolution lives in the static
        // resolveConfig() so other callers (e.g. ParallelRecorder) derive the same values.
        const { modelName, language, modelId, isEnglishOnly } = SpeechTranscriber.resolveConfig(options);
        this.modelName = modelName;
        this.language = language;
        this.modelId = modelId;

        // English-only (.en) models have NO multilingual/task token set. Forcing
        // { language, task } on them makes the decoder emit empty/garbage on
        // borderline-short clips. Track it so transcribe() omits those options for
        // .en and passes them only for the multilingual variants (non-English LANGUAGE).
        this.isEnglishOnly = isEnglishOnly;

        // Pipeline state
        this.pipeline = null;
        this.isLoading = false;
        this.loadPromise = null;
        this.isDisposed = false;
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
            `Whisper config: model=${this.modelId}`);
    }

    /**
     * Initialize the transcription pipeline (loads model)
     * Call this during app startup to preload the model
     */
    async initialize() {
        const METHOD_NAME = 'initialize';
        
        if (this.isDisposed) {
            throw new Error('Cannot initialize disposed SpeechTranscriber');
        }
        
        if (this.pipeline) {
            AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Pipeline already initialized');
            return;
        }
        
        if (this.isLoading) {
            AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Pipeline already loading, waiting...');
            return this.loadPromise;
        }
        
        // Check if another instance is active
        if (SpeechTranscriber.activeInstance && SpeechTranscriber.activeInstance !== this) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 
                'Another SpeechTranscriber instance is active - disposing it first');
            await SpeechTranscriber.activeInstance.dispose();
        }
        
        this.isLoading = true;
        
        this.loadPromise = (async () => {
            const startTime = Date.now();
            AppLogger.info(MODULE_NAME, METHOD_NAME, 
                `Loading Whisper model: ${this.modelId}...`);
            
            try {
                // Dynamic import required: @xenova/transformers is an optional heavy ML
                // dependency with ESM-only characteristics that cause issues when imported
                // at the module level in Electron/Node. Also gracefully handles the case
                // where the package is not installed.
                const { pipeline, env } = await import('@xenova/transformers');

                // Initialize onnx object if it doesn't exist
                env.onnx = env.onnx || {};
                env.onnx.logLevel = 'error';

                env.onnx.wasm = env.onnx.wasm || {};
                env.onnx.wasm.proxy = false;

                // Configure cache directory — ONE resolution, shared with the warm script and the
                // readiness check, so the directory the app reads is the directory they fill. See
                // resolveTransformersCacheDir above for what it used to do and why four caches existed.
                const _cache = resolveTransformersCacheDir(this.modelId);
                env.cacheDir = _cache.dir;
                AppLogger.info(MODULE_NAME, 'initialize',
                    `[whisper-cache] ${env.cacheDir} — ${_cache.why}`);

                // Disable remote model loading after first download (optional)
                // env.allowRemoteModels = true;

                // Create the ASR pipeline
                this.pipeline = await pipeline(
                    'automatic-speech-recognition',
                    this.modelId,
                    {
                        // Use quantized model for speed
                        quantized: true,
                        // This silences the "Removing initializer" graph optimization warnings
                        session_options: {
                            logSeverityLevel: 3,
                            logVerbosityLevel: 0,
                            graph_optimization_level: 'all'
                        }
                    }
                );

                // Mark this as the active instance
                SpeechTranscriber.activeInstance = this;

                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                AppLogger.info(MODULE_NAME, METHOD_NAME, 
                    `✅ Whisper model loaded in ${elapsed}s`);
                
            } catch (error) {
                AppLogger.error(MODULE_NAME, METHOD_NAME, 
                    `Failed to load Whisper model: ${error.message}`);
                throw error;
            } finally {
                this.isLoading = false;
            }
        })();
        
        return this.loadPromise;
    }

    /**
     * Check if model is loaded and ready
     */
    isReady() {
        return this.pipeline !== null && !this.isDisposed;
    }

    /**
     * Transcribe an audio file
     * @param {string} audioFile - Path to audio file (wav, mp3, etc.)
     * @returns {Object} - { transcription, text, words, confidence, isValid }
     */
    async transcribe(audioFile) {
        const METHOD_NAME = 'transcribe';
        
        if (this.isDisposed) {
            throw new Error('Cannot transcribe with disposed SpeechTranscriber');
        }
        
        // Ensure pipeline is loaded
        if (!this.pipeline) {
            await this.initialize();
        }
        
        // Validate file exists
        if (!fs.existsSync(audioFile)) {
            throw new Error(`Audio file not found: ${audioFile}`);
        }
        
        const fileStats = fs.statSync(audioFile);
        if (fileStats.size === 0) {
            throw new Error('Audio file is empty');
        }
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
            `Transcribing: ${path.basename(audioFile)} (${(fileStats.size / 1024).toFixed(1)} KB)`);
        
        const startTime = Date.now();
        
        try {
            // Read audio file and convert to format pipeline expects
            const audioData = await this._loadAudioFile(audioFile);
            
            // ---- TEMP instrumentation: transcription empty-on-first-attempt ----
            // Distinguishes the two live hypotheses for "full file in, empty text out":
            //   (H1) audio reaching Whisper is silent/near-zero despite a full sample
            //        count → loss is in capture/decode/denoise (rms≈0 here).
            //   (H2) audio is healthy (rms normal) yet Whisper returns "" → inference
            //        layer: either a concurrent call on the shared, non-reentrant
            //        pipeline (inFlight>1 below) or a transformers first-call quirk.
            // The static counters are shared across ALL SpeechTranscriber instances
            // (state.transcriber + any wake-word/listener instance), so an overlap from
            // a second instance on the same ONNX backend is caught too.
            let maxAmp = 0, sumSq = 0;
            for (let i = 0; i < audioData.length; i++) {
                const a = audioData[i];
                sumSq += a * a;
                const aa = a < 0 ? -a : a;
                if (aa > maxAmp) maxAmp = aa;
            }
            const rms = audioData.length ? Math.sqrt(sumSq / audioData.length) : 0;
            const onDiskBytes = fs.existsSync(audioFile) ? fs.statSync(audioFile).size : 0;
            SpeechTranscriber._callSeq = (SpeechTranscriber._callSeq || 0) + 1;
            const callId = SpeechTranscriber._callSeq;
            SpeechTranscriber._inFlight = (SpeechTranscriber._inFlight || 0) + 1;
            AppLogger.info(MODULE_NAME, METHOD_NAME,
                `🎙️ Pipeline START call=${callId} inFlight=${SpeechTranscriber._inFlight} ` +
                `samples=${audioData.length} maxAmp=${maxAmp.toFixed(4)} rms=${rms.toFixed(5)} ` +
                `onDiskBytes=${onDiskBytes} file=${path.basename(audioFile)}`);

            // Trim LEADING bit-exact-zero samples before inference. The Pi's PipeWire AEC
            // intermittently prepends a flat run of === 0 samples (~300ms–1s of digital
            // silence emitted post-playback, source node still RUNNING) ahead of real speech.
            // Whisper hallucinates or returns "" on a long leading flat-zero run followed by
            // speech (we've seen maxAmp=0.65 speech return "" then transcribe on retry).
            // Exact-zero comparison ONLY (=== 0): real/quiet speech is never bit-exact zero,
            // so this never eats audio. Leading only — trailing silence is covered by the pad
            // below. If the whole buffer is bit-exact zero, leave it intact so the existing
            // empty/hallucination handling still fires normally. Use slice() (not subarray)
            // so the result is a fresh 0-offset Float32Array — guaranteeing whatever reaches
            // this.pipeline can't expose the original buffer's trimmed leading bytes via
            // .buffer to transformers/onnx (the long-clip branch passes trimmedAudio directly;
            // the pad branch's .set() copies regardless).
            let trimmedAudio = audioData;
            let leadingZeros = 0;
            while (leadingZeros < audioData.length && audioData[leadingZeros] === 0) leadingZeros++;
            if (leadingZeros > 0 && leadingZeros < audioData.length) {
                trimmedAudio = audioData.slice(leadingZeros);
                AppLogger.info(MODULE_NAME, METHOD_NAME,
                    `🔇 Trimmed ${leadingZeros} leading bit-exact-zero samples (${(leadingZeros / 16000 * 1000).toFixed(0)}ms) before Whisper for call=${callId}`);
            }

            // Pad short clips with trailing silence before inference. Whisper drops
            // short, healthy-amplitude utterances (a ~2.3s "yes I did", samples≈36800,
            // rms≈0.026 → ""), while longer clips transcribe fine — a known too-short-
            // input failure mode, not a silence/amplitude problem. Padding to a stable
            // ~5s with zeros gives the encoder enough context without altering the
            // spoken content. The pipeline call passes only {language, task} — no
            // chunk_length_s / no_speech_threshold gate is set that we could be tripping —
            // so length is the lever. Longer clips are passed through untouched.
            // Operates on the leading-zero-trimmed clip, so a trimmed clip still gets padded.
            const MIN_PIPELINE_SAMPLES = 80000; // 5s @ 16kHz
            let pipelineAudio = trimmedAudio;
            if (trimmedAudio.length < MIN_PIPELINE_SAMPLES) {
                pipelineAudio = new Float32Array(MIN_PIPELINE_SAMPLES); // zero-filled
                pipelineAudio.set(trimmedAudio);
                AppLogger.info(MODULE_NAME, METHOD_NAME,
                    `🎙️ Padded short clip ${trimmedAudio.length} → ${pipelineAudio.length} samples (trailing silence) for call=${callId}`);
            }

            // Build pipeline options. CRITICAL: whisper-*.en models are English-only and have
            // no multilingual/task tokens — forcing { language, task } on them makes the decoder
            // return "" on borderline-short clips (confirmed: same clip → "" with these options,
            // correct text without). So pass language/task ONLY for the multilingual variants
            // (selected when LANGUAGE is non-English); omit entirely for .en, which infers English
            // with no prefix. The trim/pad transform above was exonerated — params were the cause.
            let pipelineOptions = {};
            if (!this.isEnglishOnly) {
                // Map app language code (en/es/it) to Whisper language name; default 'english'.
                // Use the constructor-resolved `this.language`, NOT a fresh process.env read,
                // so model selection and the per-utterance language token never disagree.
                const whisperLanguage = {
                    en: 'english',
                    es: 'spanish',
                    it: 'italian',
                }[this.language] || 'english';
                pipelineOptions = { language: whisperLanguage, task: 'transcribe' };
            }

            let result;
            try {
                result = await this.pipeline(pipelineAudio, pipelineOptions);
            } finally {
                SpeechTranscriber._inFlight = Math.max(0, (SpeechTranscriber._inFlight || 1) - 1);
                AppLogger.info(MODULE_NAME, METHOD_NAME,
                    `🎙️ Pipeline END   call=${callId} inFlight=${SpeechTranscriber._inFlight} ` +
                    `text="${(result?.text || '').trim().slice(0, 80)}"`);
            }

            const elapsed = Date.now() - startTime;
            
            // Extract transcription text
            const transcription = (result.text || '').trim();
            
            // Extract words with timestamps if available
            const words = this._extractWords(result);
            
            // Calculate confidence from chunks if available
            const confidence = this._calculateConfidence(result);
            
            AppLogger.info(MODULE_NAME, METHOD_NAME, 
                `Transcribed (${elapsed}ms): "${transcription}"`);
            
            // Validate and return with metadata
            return this.validateTranscriptionResult({
                transcription,
                words,
                confidence,
                model: this.modelName,
                provider: SpeechTranscriber.PROVIDER,
                processingDurationMs: elapsed
            });
            
        } catch (error) {
            AppLogger.error(MODULE_NAME, METHOD_NAME, 
                `Transcription failed: ${error.message}`);
            
            return {
                transcription: '',
                text: '',
                words: [],
                confidence: 0.0,
                isValid: false,
                model: this.modelName,
                provider: SpeechTranscriber.PROVIDER,
                processingDurationMs: null
            };
        }
    }

    /**
     * Load a WAV file from disk and convert it to a normalized Float32Array suitable
     * for the `@xenova/transformers` ASR pipeline.
     *
     * Processing steps:
     *   1. Read raw bytes and validate the RIFF/WAVE header.
     *   2-3. Decode through the one WAV decoder (@seniorminder/common/WavDecoder): the sample format
     *      comes from the header — 16-bit PCM and 32-bit float alike (an enrollment take is float;
     *      it used to be cast to Int16 and reach Whisper as noise), channels averaged to mono.
     *   4. Resample to 16 000 Hz via `_resample()` if the source sample rate differs.
     *
     * This method intentionally avoids the `wavefile` npm package due to compatibility
     * issues in the Electron/Node ESM environment.
     *
     * @param {string} audioFile - Absolute path to a WAV file (PCM or float; WavDecoder).
     * @returns {Promise<Float32Array>} Audio samples at 16 000 Hz, mono, in [-1, 1].
     * @throws {Error} If the file is not a valid WAV, has no `data` chunk, or cannot
     *                 be read from disk.
     * @private
     */
    async _loadAudioFile(audioFile) {
        const METHOD_NAME = '_loadAudioFile';
        
        // The one WAV decoder: the sample format from the header, never assumed.
        const { samples: audioData, sampleRate, channels: numChannels, format } = decodeWav(fs.readFileSync(audioFile));
        AppLogger.debug(MODULE_NAME, METHOD_NAME,
            `WAV: ${sampleRate}Hz, ${format}, ${numChannels}ch`);
        
        // Compute max amplitude with a loop to avoid spreading thousands of args
        // into Math.max (which blows the stack on long audio).
        let maxAmp = 0;
        for (let i = 0; i < audioData.length; i++) {
            const a = audioData[i] < 0 ? -audioData[i] : audioData[i];
            if (a > maxAmp) maxAmp = a;
        }
        AppLogger.debug(MODULE_NAME, METHOD_NAME,
            `Audio: ${audioData.length} samples, max amplitude: ${maxAmp.toFixed(4)}`);
        
        // Resample to 16kHz if needed
        if (sampleRate !== 16000) {
            AppLogger.debug(MODULE_NAME, METHOD_NAME, 
                `Resampling from ${sampleRate}Hz to 16000Hz`);
            return this._resample(audioData, sampleRate, 16000);
        }
        
        return audioData;
    }
    
    /**
     * Resample a Float32Array from one sample rate to another using linear interpolation.
     *
     * Used to convert recordings captured at rates other than 16 000 Hz (e.g. 44 100 Hz
     * from some microphone drivers) into the format required by the Whisper pipeline.
     * Linear interpolation is chosen for simplicity and speed; it introduces minor
     * high-frequency aliasing that is acceptable for speech recognition purposes.
     *
     * Returns the original array unchanged when `fromRate === toRate`.
     *
     * @param {Float32Array} audioData - Source audio samples.
     * @param {number}       fromRate  - Source sample rate in Hz.
     * @param {number}       toRate    - Target sample rate in Hz.
     * @returns {Float32Array} Resampled audio at `toRate`.
     * @private
     */
    _resample(audioData, fromRate, toRate) {
        const METHOD_NAME = '_resample';
        
        if (fromRate === toRate) {
            return audioData;
        }
        
        const ratio = fromRate / toRate;
        const newLength = Math.round(audioData.length / ratio);
        const resampled = new Float32Array(newLength);
        
        for (let i = 0; i < newLength; i++) {
            const srcIndex = i * ratio;
            const srcIndexFloor = Math.floor(srcIndex);
            const srcIndexCeil = Math.min(srcIndexFloor + 1, audioData.length - 1);
            const t = srcIndex - srcIndexFloor;
            
            // Linear interpolation
            resampled[i] = audioData[srcIndexFloor] * (1 - t) + audioData[srcIndexCeil] * t;
        }
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
            `Resampled ${fromRate}Hz → ${toRate}Hz (${audioData.length} → ${newLength} samples)`);
        
        return resampled;
    }

    /**
     * Extract words with timing from result
     * @private
     */
    _extractWords(result) {
        const words = [];
        
        // Check for chunks (word-level timestamps)
        if (result.chunks && Array.isArray(result.chunks)) {
            for (const chunk of result.chunks) {
                if (chunk.text && chunk.timestamp) {
                    words.push({
                        word: chunk.text.trim(),
                        start: chunk.timestamp[0] || 0,
                        end: chunk.timestamp[1] || 0,
                        probability: 0.95  // transformers.js doesn't provide per-word probability
                    });
                }
            }
        }
        
        return words;
    }

    /**
     * Calculate overall confidence
     * @private
     */
    _calculateConfidence(result) {
        // transformers.js doesn't provide confidence scores directly
        // If we have chunks with text, assume reasonable confidence
        if (result.chunks && result.chunks.length > 0) {
            return 0.85;
        }
        if (result.text && result.text.trim().length > 0) {
            return 0.80;
        }
        return 0.0;
    }

    /**
     * Validate and clean transcription results
     */
    validateTranscriptionResult(result) {
        const METHOD_NAME = 'validateTranscriptionResult';
        
        if (!result) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 'Null transcription result');
            return {
                transcription: '',
                text: '',
                words: [],
                confidence: 0.0,
                isValid: false,
                model: null,
                provider: null,
                processingDurationMs: null
            };
        }
        
        // Clean up transcription text
        let cleanTranscription = (result.transcription || '').trim();
        
        // Check for whisper hallucination patterns
        const hallucinations = [
            /^(the and for are but not you all|thank you for watching|thanks for watching)/i,
            /^\s*\.\s*$/,
            /^[^\w]*$/,
            /^[^a-zA-Z0-9]*$/,
            /^\[BLANK_AUDIO\]$/i,
            /(.{10,})\1{3,}/i
        ];
        
        const isHallucination = hallucinations.some(pattern => pattern.test(cleanTranscription));
        // ── T145 (Ed's ruling, dev1 2026-09-01) — CARRY THE REJECTION, DO NOT ONLY LOG IT ────────────
        // This WARN is written INSIDE the transcription child, and ProcessTranscriber's message handler
        // forwards only 'ready', 'transcript' and 'error' — no logs at all. So from the parent's side,
        // and from every log file the operator has, "Whisper returned nothing" and "Whisper returned a
        // hallucination we blanked" are THE SAME OBSERVATION. Twice on 09-01 a cry vanished with no
        // transcript and the answer was unreachable by construction, not by omission. The reason now
        // rides on the result, so the window log can say which happened.
        const rejected = isHallucination ? 'hallucination' : null;
        const rejectedText = isHallucination ? cleanTranscription : null;
        if (isHallucination) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 
                `Detected Whisper hallucination: "${cleanTranscription}"`);
            cleanTranscription = '';
        }
        
        // Validate confidence
        let confidence = result.confidence;
        if (typeof confidence !== 'number' || isNaN(confidence)) {
            confidence = 0.5;
        }
        confidence = Math.max(0.0, Math.min(1.0, confidence));
        
        return {
            transcription: cleanTranscription,
            text: cleanTranscription,  // Alias for compatibility
            words: result.words || [],
            confidence: confidence,
            isValid: cleanTranscription.length > 0,
            model: result.model || null,
            provider: result.provider || null,
            processingDurationMs: result.processingDurationMs || null,
            // T145 — null when nothing was rejected. 'hallucination' plus the blanked text when the
            // validator emptied it, so an EMPTY transcript can say WHICH kind of empty it is.
            rejected,
            rejectedText,
        };
    }

    /**
     * Calculate speech timing from words array
     */
    calculateSpeechTimingFromWords(words) {
        const METHOD_NAME = 'calculateSpeechTimingFromWords';
        
        let speechStart = 0;
        let speechEnd = 0;
        let speechDuration = 0;

        if (words && words.length > 0) {
            const firstValidWord = words.find(word => 
                typeof word.start === 'number' && word.start >= 0);
            const lastValidWord = words.slice().reverse().find(word => 
                typeof word.end === 'number' && word.end >= 0);

            if (firstValidWord && lastValidWord) {
                speechStart = firstValidWord.start;
                speechEnd = lastValidWord.end;
                speechDuration = Math.max(0, speechEnd - speechStart);
            }
        }

        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
            `Speech: ${speechStart.toFixed(2)}s - ${speechEnd.toFixed(2)}s (${speechDuration.toFixed(2)}s)`);
        
        return { speechStart, speechDuration, speechEnd };
    }

    /**
     * Cleanup resources - properly dispose ONNX session
     */
    async dispose() {
        const METHOD_NAME = 'dispose';
        
        if (this.isDisposed) {
            AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Already disposed');
            return;
        }
        
        this.isDisposed = true;
        
        if (this.pipeline) {
            AppLogger.info(MODULE_NAME, METHOD_NAME, 'Disposing pipeline and ONNX session...');
            
            try {
                // The pipeline has a model with a session that needs to be released
                // Access the underlying model and dispose its session
                if (this.pipeline.model) {
                    // Try to dispose the ONNX session
                    if (this.pipeline.model.session) {
                        try {
                            // ONNX Runtime sessions have a release() method
                            if (typeof this.pipeline.model.session.release === 'function') {
                                await this.pipeline.model.session.release();
                                AppLogger.debug(MODULE_NAME, METHOD_NAME, 'ONNX session released');
                            }
                        } catch (sessionError) {
                            AppLogger.warn(MODULE_NAME, METHOD_NAME, 
                                `Failed to release ONNX session: ${sessionError.message}`);
                        }
                    }
                    
                    // Some models have multiple sessions (encoder, decoder for Whisper)
                    if (this.pipeline.model.encoder_session) {
                        try {
                            if (typeof this.pipeline.model.encoder_session.release === 'function') {
                                await this.pipeline.model.encoder_session.release();
                            }
                        } catch (e) {}
                    }
                    if (this.pipeline.model.decoder_session) {
                        try {
                            if (typeof this.pipeline.model.decoder_session.release === 'function') {
                                await this.pipeline.model.decoder_session.release();
                            }
                        } catch (e) {}
                    }
                    if (this.pipeline.model.decoder_merged_session) {
                        try {
                            if (typeof this.pipeline.model.decoder_merged_session.release === 'function') {
                                await this.pipeline.model.decoder_merged_session.release();
                            }
                        } catch (e) {}
                    }
                }
                
                // Try calling dispose on the pipeline itself if available
                if (typeof this.pipeline.dispose === 'function') {
                    await this.pipeline.dispose();
                }
            } catch (error) {
                AppLogger.warn(MODULE_NAME, METHOD_NAME, 
                    `Error during pipeline disposal: ${error.message}`);
            }
            
            this.pipeline = null;
        }
        
        // Clear static reference if this was the active instance
        if (SpeechTranscriber.activeInstance === this) {
            SpeechTranscriber.activeInstance = null;
        }
        
        // Give WASM/ONNX runtime time to clean up
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Hint to garbage collector
        if (global.gc) {
            try {
                global.gc();
                AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Triggered garbage collection');
            } catch (e) {}
        }
        
        AppLogger.info(MODULE_NAME, METHOD_NAME, 'Pipeline disposed');
    }
}