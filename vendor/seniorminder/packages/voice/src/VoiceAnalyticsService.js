// ==================================================
// 📄 src/voice/VoiceAnalyticsService.js
// Stateless service for analyzing recorded audio files
// Used by Electron app and other consumers
// ==================================================

import { AppLogger } from '@seniorminder/logger';

import { AudioProcessor, speechSpanOf } from './AudioProcessor.js';
import { EnhancedProcessingService } from './EnhancedProcessingService.js';
import { MetricsCalculator } from './MetricsCalculator.js';
import { applyReliabilityFloors } from './ReliabilityFloors.js';
import { SpeechTranscriber } from './SpeechTranscriber.js';
import { VoiceConstants } from './utils/Constants.js';
import { wordCountOf, wordsIn } from './WordCount.js';

const MODULE_NAME = 'VoiceAnalyticsService';

const { VOICE_ANALYTICS } = VoiceConstants;

/**
 * Voice analysis result structure
 * @typedef {Object} VoiceAnalysisResult
 * @property {number} speechStart - Speech start time in seconds
 * @property {number} speechEnd - Speech end time in seconds
 * @property {number} speechDuration - Total speech duration in seconds
 * @property {number} syllableCount - Detected syllable count
 * @property {Object} cadence - Cadence metrics (WPM, pauses, etc.)
 * @property {Object} pitch - Pitch metrics (mean, std_dev, min, max in Hz)
 * @property {Object} volume - Volume metrics (mean, std_dev, min, max in dB)
 * @property {Object} voiceQuality - Voice quality metrics (clarity, tone, HNR)
 * @property {number} inflection - Overall inflection score (0-10)
 * @property {boolean} metricsReliable - True if pitch/volume/inflection are meaningful (configurable via VOICE_ANALYTICS.MIN_DURATION_FOR_METRICS)
 * @property {boolean} recommendedForBaseline - True if suitable for health trending (configurable via VOICE_ANALYTICS.MIN_DURATION_FOR_BASELINE)
 * @property {string} analyzedAt - ISO timestamp of analysis
 */

/**
 * Baseline comparison result
 * @typedef {Object} BaselineComparison
 * @property {boolean} hasSignificantChanges - True if any metric significantly deviates
 * @property {Object} deviations - Per-metric deviation from baseline
 * @property {Array} alerts - Array of concerning changes
 */

export class VoiceAnalyticsService {
    // Version identifiers for database storage
    static ANALYSIS_VERSION = '1.0';
    static MODEL_VERSION = '1.0.0';
    
    /**
     * Create a VoiceAnalyticsService instance
     * @param {Object} options - Configuration options
     * @param {boolean} options.enableDiarization - Enable speaker diarization (heavier processing)
     * @param {number} options.maxConcurrentWorkers - Max worker threads for diarization
     * @param {number} options.workerTimeoutMs - Timeout for worker processing
     */
    constructor(options = {}) {
        const METHOD_NAME = 'constructor';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'VoiceAnalyticsService initialized.');

        if (!options.ffmpegLocator || typeof options.ffmpegLocator.getPath !== 'function') {
            throw new Error('VoiceAnalyticsService requires ffmpegLocator option with a getPath() method');
        }
        this.ffmpegLocator = options.ffmpegLocator;

        this.audioProcessor = new AudioProcessor({ ffmpegLocator: this.ffmpegLocator });
        this.metricsCalculator = new MetricsCalculator();
        this.transcriber = null; // Lazy load
        
        // Optional: Enable diarization (requires more resources)
        this.enableDiarization = options.enableDiarization ?? false;
        this.processingService = null; // Lazy load if diarization enabled
        this.processingServiceConfig = {
            maxConcurrentWorkers: options.maxConcurrentWorkers || 2,
            workerTimeoutMs: options.workerTimeoutMs || 300000, // 5 minutes
            enableDiarizationByDefault: true
        };
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
            `VoiceAnalyticsService initialized (diarization: ${this.enableDiarization ? 'enabled' : 'disabled'})`);
    }
    
    /**
     * Initialize the service (pre-load transcriber)
     * Call this once at startup to avoid lazy-load delays
     */
    async initialize() {
        await this.getTranscriber();
    }
    
    /**
     * Get or create the speech transcriber (lazy load)
     */
    async getTranscriber() {
        if (!this.transcriber) {
            this.transcriber = new SpeechTranscriber();
            await this.transcriber.initialize();
        }
        return this.transcriber;
    }
    
    /**
     * Get or create the enhanced processing service (lazy load)
     */
    getProcessingService() {
        if (!this.processingService && this.enableDiarization) {
            this.processingService = new EnhancedProcessingService(this.processingServiceConfig);
        }
        return this.processingService;
    }
    
    /**
     * Analyze an audio file and return comprehensive voice metrics
     * 
     * TRANSCRIPTION STRATEGY (Updated 2026-01-17):
     * ============================================
     * When includeTranscription is true, ALWAYS run local Whisper transcription.
     * The result goes to raw_transcript in the database.
     * 
     * HeyGen's transcript (if available) is stored separately in digested_answer
     * by ParallelRecorder - this service doesn't handle that.
     * 
     * @param {string} audioFile - Path to audio file
     * @param {Object} options - Analysis options
     * @param {boolean} options.includeTranscription - Run local Whisper transcription (default: false)
     * @param {boolean} options.includeDiarization - Include speaker diarization
     * @param {string} [options.transcript] - the caller's transcript of THIS audio, with options.transcriptSource
     *        ('whisper' | 'streaming_ear'): WordCount ranks it beside analyzeAudio's own Whisper read
     * @returns {Promise<VoiceAnalysisResult>}
     */
    async analyzeAudio(audioFile, options = {}) {
        const METHOD_NAME = 'analyzeAudio';
        const startTime = Date.now();

        try {
            await AppLogger.info(MODULE_NAME, METHOD_NAME, `Analyzing audio: ${audioFile}`);

            // Step 1: Get audio data
            const audioData = await this.audioProcessor.getAudioData(audioFile);
            if (!audioData || audioData.length === 0) {
                throw new Error('No audio data extracted from file');
            }

            await AppLogger.debug(MODULE_NAME, METHOD_NAME, `Audio data: ${audioData.length} samples`);

            // Step 2: the transcripts of THIS audio (WordCount ranks them). Local Whisper on the file when asked; the
            // caller's transcript of the same audio, with its source, when it has one (the voice-only turn's Whisper
            // read of this recording, or the ear's streaming read). The syllable estimate is gone (Ed, 2026-11-06).
            const transcripts = [];
            let transcription = null;
            let transcriptionSource = null;
            let transcriptionConfidence = null;
            const spanSeconds = speechSpanOf(audioData, this.audioProcessor.sampleRate || 16000).speechDuration;
            if (options.includeTranscription && spanSeconds > 0.5) {
                try {
                    const transcriber = await this.getTranscriber();
                    const transcriptResult = await transcriber.transcribe(audioFile);
                    transcription = transcriptResult.text || transcriptResult.transcription || '';
                    transcriptionSource = 'whisper';
                    transcriptionConfidence = transcriptResult.confidence || null;
                    transcripts.push({ text: transcription, source: 'whisper' });
                    await AppLogger.debug(MODULE_NAME, METHOD_NAME, `Local transcription: "${transcription.substring(0, 50)}..."`);
                } catch (transcriptionError) {
                    await AppLogger.warn(MODULE_NAME, METHOD_NAME,
                        `Transcription failed (continuing with voice metrics): ${transcriptionError.message}`);
                    transcriptionSource = 'error';
                }
            }
            if (typeof options.transcript === 'string' && options.transcriptSource) {
                transcripts.push({ text: options.transcript, source: options.transcriptSource });
            }

            // Step 3: every reading and its evidence; then the reliability floors, each metric on its own evidence
            const raw = this.measurePcm(audioData, { transcripts });
            const { result, floored } = applyReliabilityFloors(raw);

            const processingTime = Date.now() - startTime;
            Object.assign(result, {
                // Transcription (Whisper when includeTranscription is true)
                transcription: transcription || undefined,
                transcriptionSource: transcriptionSource,  // 'whisper', 'error', or null (not run)
                transcriptionConfidence: transcriptionConfidence,
                floored,

                // Metadata
                analyzedAt: new Date().toISOString(),
                processingTimeMs: processingTime,
                analysisVersion: VoiceAnalyticsService.ANALYSIS_VERSION,
                modelVersion: VoiceAnalyticsService.MODEL_VERSION,
            });

            await AppLogger.info(MODULE_NAME, METHOD_NAME,
                `Analysis complete in ${processingTime}ms - WPM: ${result.cadence?.wpm ?? 'N/A'}`
                + (floored.length ? `; under their floors (not recorded): ${floored.map((x) => x.metric).join(', ')}` : ''));

            return result;

        } catch (error) {
            await AppLogger.error(MODULE_NAME, METHOD_NAME, `Analysis failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * EVERY ROW-B READING OF ONE UTTERANCE, AND THE EVIDENCE EACH STANDS ON — before the reliability floors. Pure over
     * the PCM: analyzeAudio decodes and transcribes, then calls this, then applyReliabilityFloors. The floors were
     * derived by running exactly this on the dev1 takes, so what is floored is what was measured.
     * @param {Float32Array} audioData - 16 kHz mono PCM.
     * @param {{transcripts?: Array<{text: string, source: string}>}} [opts] - transcripts of this audio (WordCount).
     * @returns {object} the analysis result, with `evidence`.
     */
    measurePcm(audioData, { transcripts = [] } = {}) {
        const METHOD_NAME = 'measurePcm';
        const sr = this.audioProcessor.sampleRate || 16000;
        const span = speechSpanOf(audioData, sr);
        const words = wordCountOf(transcripts);

        // Step 4: Detect syllables (speech_rate_variability counts them per segment; this whole-clip count is kept for
        // the record only — it is no longer turned into words)
        const syllableCount = this.audioProcessor.detectSyllables(audioData);

        // Minimum duration for reliable voice health metrics (from config)
        const MIN_DURATION_FOR_METRICS = VOICE_ANALYTICS.MIN_DURATION_FOR_METRICS;
        const MIN_DURATION_FOR_BASELINE = VOICE_ANALYTICS.MIN_DURATION_FOR_BASELINE;
        const hasEnoughData = span.speechDuration >= MIN_DURATION_FOR_METRICS;
        const recommendedForBaseline = span.speechDuration >= MIN_DURATION_FOR_BASELINE;

        const cadenceMetrics = this.metricsCalculator.calculateCadenceMetrics(
            audioData, span.speechStart, span.speechEnd, span.speechDuration, words ? words.words : null);

        // OVER THE WHOLE SPEECH SPAN (Ed's ruling, 2026-11-06): pitch, volume, HNR, jitter, shimmer, centroid and
        // inflection read every frame from the span's start to its end — they read at most 2 s (centroid 1 s) from the
        // loudest window, so long speech never gained evidence. No span: the whole clip (the level gates still apply).
        // One buffer for all four, so the pitch tracker's frames are computed once (voicedFrames' cache is per buffer).
        const speech = span.found
            ? audioData.subarray(Math.max(0, Math.floor(span.speechStart * sr)), Math.min(audioData.length, Math.ceil(span.speechEnd * sr)))
            : audioData;
        let pitchMetrics, volumeMetrics, voiceQualityMetrics, inflection;
        try {
            pitchMetrics = this.metricsCalculator.calculatePitchMetrics(speech);
            volumeMetrics = this.metricsCalculator.calculateVolumeMetrics(speech);
            voiceQualityMetrics = this.metricsCalculator.calculateVoiceQualityMetrics(speech);
            inflection = this.metricsCalculator.calculateInflection(speech);
        } catch (metricsError) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, `Metrics calculation failed: ${metricsError.message}`);
            // A failure stores nothing: no value is computed to fill a row.
            pitchMetrics = { mean_hz: null, std_dev: null, p5_hz: null, p95_hz: null, p5_p95_range_hz: null, sample_count: 0 };
            volumeMetrics = { mean_db: null, std_dev: null, p5_db: null, p95_db: null, p5_p95_range_db: null, sample_count: 0 };
            voiceQualityMetrics = { harmonic_to_noise: null, spectral_centroid: null, jitter: null, shimmer: null, voiced_frames: 0, glottal_periods: 0, centroid_windows: 0 };
            inflection = null;
        }

        return {
            // Timing (null when no span was found: nothing is computed to fill a row)
            speechStart: span.found ? span.speechStart : null,
            speechEnd: span.found ? span.speechEnd : null,
            speechDuration: span.found ? span.speechDuration : null,
            totalDuration: audioData.length / sr,

            // Counts
            syllableCount,
            wordCount: words ? words.words : null,
            wordSource: words ? words.source : null,

            cadence: cadenceMetrics,
            pitch: pitchMetrics,
            volume: volumeMetrics,
            voiceQuality: voiceQualityMetrics,
            inflection,

            // What each metric stands on (ReliabilityFloors)
            evidence: {
                spanFound: span.found,
                spanSeconds: span.found ? span.speechDuration : 0,
                words: words ? words.words : null,
                speechSegments: cadenceMetrics.speech_segments ?? 0,
                voicedFrames: voiceQualityMetrics.voiced_frames ?? 0,
                glottalPeriods: voiceQualityMetrics.glottal_periods ?? 0,
                volumeWindows: volumeMetrics.sample_count ?? 0,
                centroidWindows: voiceQualityMetrics.centroid_windows ?? 0,
            },

            // Data quality flags
            metricsReliable: hasEnoughData,
            recommendedForBaseline: recommendedForBaseline,
            confidence: hasEnoughData ? 0.85 : 0.5
        };
    }
    
    /**
    
    /**
     * Compare current analysis against a baseline
     * @param {VoiceAnalysisResult} current - Current analysis
     * @param {Object} baseline - Baseline metrics (from establishBaseline)
     * @returns {BaselineComparison} Comparison result with deviations and alerts
     */
    compareToBaseline(current, baseline) {
        const METHOD_NAME = 'compareToBaseline';
        
        if (!baseline) {
            throw new Error('Baseline required for comparison');
        }
        
        const deviations = {};
        const alerts = [];
        
        // Compare cadence
        if (baseline.cadence?.wpm && current.cadence?.wpm) {
            const wpmDiff = current.cadence.wpm - baseline.cadence.wpm;
            const wpmPct = (wpmDiff / baseline.cadence.wpm) * 100;
            deviations.wpm = { 
                value: current.cadence.wpm, 
                baseline: baseline.cadence.wpm, 
                difference: wpmDiff,
                percentChange: wpmPct 
            };
        }
        
        // Compare pitch (if available)
        if (baseline.pitch?.mean_hz && current.pitch?.mean_hz) {
            const pitchDiff = current.pitch.mean_hz - baseline.pitch.mean_hz;
            const pitchPct = (pitchDiff / baseline.pitch.mean_hz) * 100;
            deviations.pitch = { 
                value: current.pitch.mean_hz, 
                baseline: baseline.pitch.mean_hz, 
                difference: pitchDiff,
                percentChange: pitchPct 
            };
        }
        
        // Compare volume (if available)
        if (baseline.volume?.mean_db && current.volume?.mean_db) {
            const volumeDiff = current.volume.mean_db - baseline.volume.mean_db;
            const volumePct = (volumeDiff / Math.abs(baseline.volume.mean_db)) * 100;
            deviations.volume = { 
                value: current.volume.mean_db, 
                baseline: baseline.volume.mean_db, 
                difference: volumeDiff,
                percentChange: volumePct 
            };
        }
        
        // Compare inflection (if available)
        if (baseline.inflection != null && current.inflection != null) {
            const inflectionDiff = current.inflection - baseline.inflection;
            const inflectionPct = baseline.inflection !== 0 
                ? (inflectionDiff / baseline.inflection) * 100 
                : 0;
            deviations.inflection = { 
                value: current.inflection, 
                baseline: baseline.inflection, 
                difference: inflectionDiff,
                percentChange: inflectionPct 
            };
        }
        
        // Generate alerts for significant deviations
        // Alert thresholds can be configured
        const ALERT_THRESHOLD_PCT = 20;  // 20% change triggers alert
        
        if (deviations.pitch?.percentChange && Math.abs(deviations.pitch.percentChange) > ALERT_THRESHOLD_PCT) {
            alerts.push({
                metric: 'pitch',
                message: 'Significant pitch change detected',
                severity: Math.abs(deviations.pitch.percentChange) > 40 ? 'high' : 'medium',
                percentChange: deviations.pitch.percentChange
            });
        }
        
        if (deviations.inflection?.percentChange && deviations.inflection.percentChange < -ALERT_THRESHOLD_PCT) {
            alerts.push({
                metric: 'inflection',
                message: 'Reduced vocal inflection - may indicate mood changes',
                severity: deviations.inflection.percentChange < -40 ? 'high' : 'medium',
                percentChange: deviations.inflection.percentChange
            });
        }
        
        if (deviations.wpm?.percentChange && deviations.wpm.percentChange < -ALERT_THRESHOLD_PCT) {
            alerts.push({
                metric: 'wpm',
                message: 'Significant decrease in speaking rate - may indicate cognitive changes',
                severity: 'high',
                percentChange: deviations.wpm?.percentChange
            });
        }
        
        const hasSignificantChanges = alerts.length > 0;
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
            `Baseline comparison: ${alerts.length} alerts, significant changes: ${hasSignificantChanges}`);
        
        return {
            hasSignificantChanges,
            deviations,
            alerts,
            comparedAt: new Date().toISOString()
        };
    }
    
    /**
     * Establish a baseline from multiple recordings
     * Only uses recordings with recommendedForBaseline: true
     * @param {Array<VoiceAnalysisResult>} analyses - Array of analysis results
     * @returns {Object} Baseline metrics (averaged)
     */
    establishBaseline(analyses) {
        const METHOD_NAME = 'establishBaseline';
        
        if (!analyses || analyses.length === 0) {
            throw new Error('At least one analysis required to establish baseline');
        }
        
        // Filter to only use high-quality recordings for baseline
        const qualityAnalyses = analyses.filter(a => a.recommendedForBaseline === true);
        const minDuration = VOICE_ANALYTICS.MIN_DURATION_FOR_BASELINE;
        
        if (qualityAnalyses.length === 0) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 
                `No recordings meet baseline quality threshold (${analyses.length} provided, 0 with ${minDuration}+ seconds of speech)`);
            throw new Error(`No recordings meet baseline quality threshold (need ${minDuration}+ seconds of speech)`);
        }
        
        if (qualityAnalyses.length < analyses.length) {
            AppLogger.info(MODULE_NAME, METHOD_NAME, 
                `Using ${qualityAnalyses.length} of ${analyses.length} recordings for baseline (filtered by quality)`);
        }
        
        // Average each metric across all quality analyses
        const baseline = {
            cadence: {
                wpm: this.average(qualityAnalyses.map(a => a.cadence?.wpm)),
                pause_duration_avg: this.average(qualityAnalyses.map(a => a.cadence?.pause_duration_avg)),
                speaking_time_ratio: this.average(qualityAnalyses.map(a => a.cadence?.speaking_time_ratio))
            },
            pitch: {
                mean_hz: this.average(qualityAnalyses.map(a => a.pitch?.mean_hz)),
                std_dev: this.average(qualityAnalyses.map(a => a.pitch?.std_dev)),
                p5_hz: this.average(qualityAnalyses.map(a => a.pitch?.p5_hz)),
                p95_hz: this.average(qualityAnalyses.map(a => a.pitch?.p95_hz))
            },
            volume: {
                mean_db: this.average(qualityAnalyses.map(a => a.volume?.mean_db)),
                std_dev: this.average(qualityAnalyses.map(a => a.volume?.std_dev))
            },
            inflection: this.average(qualityAnalyses.map(a => a.inflection)),
            sampleCount: qualityAnalyses.length,
            totalProvided: analyses.length,
            establishedAt: new Date().toISOString()
        };
        
        AppLogger.info(MODULE_NAME, METHOD_NAME, 
            `Baseline established from ${qualityAnalyses.length} quality recordings`);
        
        return baseline;
    }
    
    /**
     * Perform speaker diarization
     * @param {string} audioFile - Path to audio file
     * @returns {Promise<Object>} Diarization result with speaker segments
     */
    async performDiarization(audioFile) {
        const METHOD_NAME = 'performDiarization';
        
        if (!this.enableDiarization) {
            throw new Error('Diarization not enabled - construct with enableDiarization: true');
        }
        
        const service = this.getProcessingService();
        if (!service) {
            throw new Error('Processing service not available');
        }
        
        await AppLogger.info(MODULE_NAME, METHOD_NAME, `Starting diarization for: ${audioFile}`);
        
        const result = await service.processAudioWithDiarization({
            recordingData: { audioFile },
            diarizationConfig: { enabled: true }
        });
        
        return result;
    }
    
    /**
     * Count words in text
     * @param {string} text - Text to count words in
     * @returns {number} Word count
     */
    countWords(text) {
        return wordsIn(text);   // the one word counter (WordCount)
    }
    
    /**
     * Calculate average of array, filtering nulls/undefined
     * @private
     */
    average(values) {
        const validValues = values.filter(v => v !== null && v !== undefined && !isNaN(v));
        if (validValues.length === 0) return 0;
        return validValues.reduce((sum, v) => sum + v, 0) / validValues.length;
    }
    
    /**
     * Get the analysis version
     * @returns {string} Analysis version
     */
    getAnalysisVersion() {
        return VoiceAnalyticsService.ANALYSIS_VERSION;
    }
    
    /**
     * Get the model version
     * @returns {string} Model version
     */
    getModelVersion() {
        return VoiceAnalyticsService.MODEL_VERSION;
    }
    
    /**
     * Get service status
     * @returns {Object} Service status
     */
    getStatus() {
        return {
            ready: true,
            diarizationEnabled: this.enableDiarization,
            transcriberLoaded: this.transcriber !== null,
            processingServiceLoaded: this.processingService !== null,
            thresholds: {
                minDurationForMetrics: VOICE_ANALYTICS.MIN_DURATION_FOR_METRICS,
                minDurationForBaseline: VOICE_ANALYTICS.MIN_DURATION_FOR_BASELINE,
                idealDurationForHealth: VOICE_ANALYTICS.IDEAL_DURATION_FOR_HEALTH
            },
            capabilities: {
                quickAnalysis: true,
                standardAnalysis: true,
                fullAnalysis: this.enableDiarization,
                baselineComparison: true,
                diarization: this.enableDiarization
            }
        };
    }
    
    /**
     * Graceful shutdown
     */
    async shutdown() {
        const METHOD_NAME = 'shutdown';
        
        AppLogger.info(MODULE_NAME, METHOD_NAME, 'Shutting down VoiceAnalyticsService...');
        
        if (this.processingService) {
            await this.processingService.shutdown();
        }
        
        AppLogger.info(MODULE_NAME, METHOD_NAME, 'VoiceAnalyticsService shutdown complete');
    }
}
