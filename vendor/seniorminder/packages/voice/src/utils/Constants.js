// ==================================================
// src/voice/utils/Constants.js
// ==================================================

/**
 * Central configuration object for the entire voice package.
 *
 * All numeric values use SI units with the unit embedded in the key name
 * (e.g. `_MS` = milliseconds, `_HZ` = hertz).  Import the individual
 * sub-objects via destructuring:
 *
 * @example
 * const { AUDIO, THRESHOLDS, PITCH } = VoiceConstants;
 */
export const VoiceConstants = {
    /**
     * Core audio capture settings shared by AudioRecorder and AudioProcessor.
     */
    AUDIO: {
        /** Sample rate used for all FFmpeg capture and analysis (16 kHz). */
        SAMPLE_RATE: 16000,
        /** Hard cap on a single recording in milliseconds (30 s). */
        MAX_DURATION_MS: 30000,
        /** Default output filename when no path is supplied. */
        OUTPUT_FILE: 'recording.wav',
        /** FFmpeg energy-window size for speech-boundary detection (ms). */
        WINDOW_SIZE_MS: 10,
        /** Energy-window size used specifically for syllable detection (ms). */
        SYLLABLE_WINDOW_MS: 20,
        /**
         * Voice Activity Detection (VAD) timing parameters.
         * All values are in milliseconds unless noted.
         */
        SILENCE_DETECTION: {
            /** Stop recording after this many ms of continuous silence. */
            SILENCE_THRESHOLD_MS: 2000,
            /** VAD analysis chunk size — audio is evaluated in this window. */
            ANALYSIS_WINDOW_MS: 100,
            /** Pre-speech audio retained before the first voiced frame (ms). */
            SPEECH_START_BUFFER_MS: 750,
            /** Post-speech audio retained after the last voiced frame (ms). */
            SILENCE_END_BUFFER_MS: 500
        }
    },
    
    /**
     * Energy and VAD decision thresholds used across AudioProcessor,
     * AudioRecorder, and MetricsCalculator.
     */
    THRESHOLDS: {
        /** Percentile of the energy distribution used to estimate the noise floor
         *  in `AudioProcessor.detectSpeechBoundaries()` (0.1 = bottom 10%). */
        NOISE_FLOOR_PERCENTILE: 0.1,
        /** Multiplier applied to the noise floor to derive the speech-detection
         *  threshold: `threshold = noiseFloor * (1 + SPEECH_THRESHOLD_FACTOR)`. */
        SPEECH_THRESHOLD_FACTOR: 5.0,
        /** Absolute lower bound for the speech energy threshold, preventing the
         *  threshold from being set too low on near-silent recordings. AudioRecorder's
         *  live turn VAD only: the voice-health speech span (AudioProcessor.speechSpanOf)
         *  is relative to the clip's own loudest window (LevelGate) since 2026-11-06. */
        MIN_SPEECH_ENERGY_THRESHOLD: 0.015,
        /** Capture-integrity floor (samples). A saved or denoised utterance with
         *  fewer samples than this is treated as a capture/processing FAILURE
         *  (header-only or sample-empty WAV), NOT as a valid recording or as the
         *  patient staying silent. 0.25 s at 16 kHz mono = 4000 samples (~8 KB WAV
         *  incl. 44-byte header) — below the shortest real "yes"/"no", so it never
         *  rejects a genuine terse answer. Used by AudioRecorder.saveAudioFromMemory
         *  and NoiseReduction's output checks. */
        MIN_CAPTURE_SAMPLES: 4000,
        /** Minimum inter-syllable gap in ms; shorter gaps merge into one syllable. */
        MIN_SYLLABLE_GAP_MS: 50,
        /**
         * Voice Activity Detection thresholds used by `AudioRecorder`.
         */
        VAD: {
            /** Legacy factor — kept for reference; dynamic calibration is used instead. */
            ENERGY_THRESHOLD_FACTOR: 0.15,
            /** Minimum ms of continuous energy above threshold to open a speech segment. */
            MIN_SPEECH_DURATION_MS: 200,
            /** Minimum ms of energy below threshold before a silence gap is declared. */
            MIN_SILENCE_DURATION_MS: 150,
            /** `energyThreshold = noiseFloor × NOISE_FLOOR_MULTIPLIER`. */
            NOISE_FLOOR_MULTIPLIER: 3.0,
            /** Consecutive above-threshold frames required before speech start is declared
             *  (~300 ms at the default 100 ms `ANALYSIS_WINDOW_MS`). */
            MIN_CONSECUTIVE_SPEECH_FRAMES: 3,
            /** Number of analysis windows averaged together during noise-floor calibration. */
            CALIBRATION_WINDOWS: 2,
            /** Delay before calibration begins (ms), allowing video-playback audio to settle. */
            CALIBRATION_DELAY_MS: 500,
            /** Hard cap on the measured noise floor to prevent impossibly high thresholds
             *  when ambient noise is louder than expected. */
            MAX_NOISE_FLOOR: 0.01,
            /** If no speech onset is detected within this many ms of calibration
             *  completing, the recording is stopped with `silenceOnly: true`. */
            NO_SPEECH_TIMEOUT_MS: 10000
        }
    },
    
    /**
     * THE F0 RANGE of the voice-health path — the one range the pitch tracker searches (estimatePitchForWindow),
     * voicedFrames keeps, and jitter's periods must fall in (MetricsCalculator). 60-500 Hz (Ed, 2026-11-06): the
     * old 70-300 Hz keep cut off most women's reading voices. The pitch frame is sized from MIN_FREQ (three of its
     * periods).
     */
    PITCH: {
        /** Lower bound of expected human speech pitch in Hz. */
        MIN_FREQ: 60,
        /** Upper bound of expected human speech pitch in Hz. */
        MAX_FREQ: 500
    },

    /**
     * Heuristics used when estimating word count from syllable counts
     * in the absence of a transcription.
     */
    SPEECH_RATES: {
        /** Average syllables per word in English conversational speech. */
        SYLLABLES_PER_WORD: 1.3,
        /** Minimum plausible words-per-minute rate; values below this are clamped. */
        MIN_WPM: 30,
        /** Maximum plausible words-per-minute rate; values above this are clamped. */
        MAX_WPM: 400
    },

    /**
     * Whisper model identifiers and supported language codes.
     * Pass `MODELS.*` values as the `model` option to `SpeechTranscriber`.
     */
    WHISPER: {
        MODELS: {
            /** ~39 MB, fastest inference (~1 s). */
            TINY: 'tiny',
            /** ~142 MB, recommended balance of speed and accuracy (~2–3 s). */
            BASE: 'base',
            /** ~466 MB, better accuracy (~3–4 s). */
            SMALL: 'small',
            /** ~1.5 GB, excellent accuracy (~5–8 s). */
            MEDIUM: 'medium',
            /** ~2.9 GB, highest accuracy (slowest). */
            LARGE: 'large'
        },
        /** BCP-47 language codes accepted by the multilingual Whisper variants. */
        LANGUAGES: {
            ENGLISH: 'en',
            SPANISH: 'es',
            FRENCH: 'fr'
        }
    },

    /**
     * Per-mode recording limits used by `ContinuousRecorder`.
     * `SINGLE` is used for one-shot CLI recordings; `CONTINUOUS` for the
     * background loop that runs during LiveAvatar conversations.
     */
    RECORDING_MODES: {
        SINGLE: {
            /** Maximum recording length in ms for single-shot mode (60 s). */
            MAX_DURATION_MS: 60000,
            /** Silence gap that stops the recording in ms (3 s). */
            SILENCE_THRESHOLD_MS: 3000,
            DESCRIPTION: 'Single recording mode - longer duration, user-controlled'
        },
        CONTINUOUS: {
            /** Maximum recording length in ms per segment in continuous mode (30 s). */
            MAX_DURATION_MS: 30000,
            /** Silence gap that stops each segment in ms (3 s). */
            SILENCE_THRESHOLD_MS: 3000,
            DESCRIPTION: 'Continuous recording mode - shorter segments, auto-start'
        }
    },

    /**
     * Tuning parameters for `ContinuousRecorder` that
     * control file retention, worker-pool sizing, and retry back-off timing.
     */
    CONTINUOUS_RECORDER_CONFIG: {
        /** When true, source WAV files are deleted after processing completes. */
        DELETE_AUDIO_AFTER_PROCESSING: false,
        /** When true, JSON result files are written even for silence-only recordings. */
        SAVE_SILENCE_RESULTS: true,
        /** Maximum worker threads that may run concurrently in the processing pool. */
        MAX_CONCURRENT_WORKERS: 3,
        /** Per-worker hard timeout in ms before the thread is forcibly terminated (5 min). */
        WORKER_TIMEOUT_MS: 300000,
        /** Pause between consecutive recordings in continuous mode (ms). */
        PAUSE_BETWEEN_RECORDINGS_MS: 500,
        /** Back-off delay when the worker pool is at capacity before retrying (ms). */
        WORKER_POOL_RETRY_DELAY_MS: 2000,
        /** Back-off delay after a recording failure before the next attempt (ms). */
        RECORDING_FAILURE_RETRY_DELAY_MS: 2000,
        /** Back-off delay for unclassified errors in the continuous-mode loop (ms). */
        GENERAL_ERROR_RETRY_DELAY_MS: 1000
    },

    /**
     * Speech-duration gates used by `VoiceAnalyticsService` to decide which
     * metrics are meaningful for a given recording.
     *
     * Rationale: very short utterances ("yes", "five") do not contain enough
     * sustained phonation to produce reliable pitch or inflection readings;
     * health-baseline trending requires even longer samples to capture natural
     * speech biomarkers.
     */
    VOICE_ANALYTICS: {
        /** Recordings shorter than this (s) get WPM only — pitch/volume/inflection
         *  calculations are skipped. */
        MIN_DURATION_FOR_METRICS: 2.0,
        /** Recordings shorter than this (s) are excluded from health baseline and
         *  trend calculations. */
        MIN_DURATION_FOR_BASELINE: 5.0,
        /** Target speech duration (s) for dedicated voice-health check-in questions
         *  where the full biomarker suite should be captured. */
        IDEAL_DURATION_FOR_HEALTH: 10.0
    }
};