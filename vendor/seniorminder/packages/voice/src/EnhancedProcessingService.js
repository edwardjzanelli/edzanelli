// ==================================================
// src/voice/EnhancedProcessingService.js
// Service for managing enhanced audio processing with optional diarization
// ==================================================

// node core in ESM
import path from 'path';
import { fileURLToPath } from 'url';

import { AppLogger } from '@seniorminder/logger';
import { WorkerPool } from './workers/WorkerPool.js';

const MODULE_NAME = 'EnhancedProcessingService';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class EnhancedProcessingService {
    constructor(config = {}) {
        const METHOD_NAME = 'constructor';
        
        this.config = {
            maxConcurrentWorkers: config.maxConcurrentWorkers || 3,
            workerTimeoutMs: config.workerTimeoutMs || 600000, // 10 minutes for enhanced processing
            enableDiarizationByDefault: config.enableDiarizationByDefault || false,
            ...config
        };

        // Initialize worker pool for enhanced processing
        this.workerPool = new WorkerPool({
            maxConcurrentWorkers: this.config.maxConcurrentWorkers,
            workerTimeoutMs: this.config.workerTimeoutMs,
            workerScriptPath: path.join(__dirname, 'workers/EnhancedAudioProcessingWorker.js')
        });

        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
            `EnhancedProcessingService initialized with ${this.config.maxConcurrentWorkers} max workers`);
    }

    /**
     * Process audio with optional diarization
     * @param {Object} params - Processing parameters
     * @param {Object} params.recordingData - Recording data from voice analyzer
     * @param {Object} params.config - Processing configuration
     * @param {Object} params.deviceConfig - Device configuration
     * @param {Object} params.diarizationConfig - Diarization configuration
     * @returns {Promise<Object>} Processing results
     */
    async processAudio(params) {
        const METHOD_NAME = 'processAudio';
        const { recordingData, config, deviceConfig, diarizationConfig = {} } = params;
        
        try {
            AppLogger.info(MODULE_NAME, METHOD_NAME, 
                `Starting enhanced processing${diarizationConfig.enabled ? ' with diarization' : ''}`);

            // Check if worker pool can accept work
            if (!this.workerPool.canAcceptWork()) {
                const status = this.workerPool.getStatus();
                throw new Error(`Processing service busy (${status.active}/${status.maxWorkers}). Try again later.`);
            }

            // Prepare worker data
            const workerData = {
                recordingData,
                config,
                deviceConfig,
                diarizationConfig: {
                    enabled: diarizationConfig.enabled || this.config.enableDiarizationByDefault,
                    ...diarizationConfig
                }
            };

            // Generate job name
            const audioFileName = recordingData.fileInfo?.shortTimestamp || 'unknown';
            const jobName = `enhanced_processing_${audioFileName}${diarizationConfig.enabled ? '_with_diarization' : ''}`;

            // Submit work to worker pool
            const results = await this.workerPool.submitWork(workerData, jobName);

            AppLogger.info(MODULE_NAME, METHOD_NAME, 
                `Enhanced processing completed for ${audioFileName}`);

            return {
                success: true,
                results,
                enhanced: true,
                diarizationEnabled: diarizationConfig.enabled || this.config.enableDiarizationByDefault
            };

        } catch (error) {
            AppLogger.error(MODULE_NAME, METHOD_NAME, 
                `Enhanced processing failed: ${error.message}`);
            
            return {
                success: false,
                error: error.message,
                enhanced: true
            };
        }
    }

    /**
     * Process audio with transcription only (legacy compatibility)
     * @param {Object} params - Processing parameters
     * @returns {Promise<Object>} Processing results
     */
    async processAudioTranscriptionOnly(params) {
        return this.processAudio({
            ...params,
            diarizationConfig: { enabled: false }
        });
    }

    /**
     * Process audio with both transcription and diarization
     * @param {Object} params - Processing parameters
     * @returns {Promise<Object>} Processing results
     */
    async processAudioWithDiarization(params) {
        return this.processAudio({
            ...params,
            diarizationConfig: { enabled: true, ...params.diarizationConfig }
        });
    }

    /**
     * Process multiple audio files
     * @param {Array} audioFiles - Array of processing parameters
     * @returns {Promise<Array>} Array of results
     */
    async processBatch(audioFiles) {
        const METHOD_NAME = 'processBatch';
        
        try {
            AppLogger.info(MODULE_NAME, METHOD_NAME, 
                `Starting batch processing of ${audioFiles.length} files`);

            const processingPromises = audioFiles.map(params => 
                this.processAudio(params)
            );

            const results = await Promise.allSettled(processingPromises);

            const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
            const failed = results.length - successful;

            AppLogger.info(MODULE_NAME, METHOD_NAME, 
                `Batch processing completed: ${successful} successful, ${failed} failed`);

            return results.map(result => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    return {
                        success: false,
                        error: result.reason.message,
                        enhanced: true
                    };
                }
            });

        } catch (error) {
            AppLogger.error(MODULE_NAME, METHOD_NAME, 
                `Batch processing failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get service status
     * @returns {Object} Service status information
     */
    getStatus() {
        const poolStatus = this.workerPool.getStatus();
        const jobHistory = this.workerPool.getJobHistory();

        return {
            ready: true,
            enhanced: true,
            workerPool: poolStatus,
            recentJobs: {
                completed: jobHistory.completed.length,
                failed: jobHistory.failed.length,
                active: jobHistory.active.length
            },
            config: {
                maxWorkers: this.config.maxConcurrentWorkers,
                timeoutMs: this.config.workerTimeoutMs,
                diarizationByDefault: this.config.enableDiarizationByDefault
            },
            capabilities: {
                transcription: true,
                voiceMetrics: true,
                diarization: true,
                speakerIdentification: true,
                batchProcessing: true
            }
        };
    }

    /**
     * Get detailed job history
     * @returns {Object} Job history from worker pool
     */
    getJobHistory() {
        return this.workerPool.getJobHistory();
    }

    /**
     * Check if service can accept new work
     * @returns {boolean} True if can accept work
     */
    canAcceptWork() {
        return this.workerPool.canAcceptWork();
    }

    /**
     * Update configuration
     * @param {Object} newConfig - New configuration options
     */
    updateConfig(newConfig) {
        const METHOD_NAME = 'updateConfig';
        
        this.config = {
            ...this.config,
            ...newConfig
        };
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Configuration updated');
    }

    /**
     * Graceful shutdown of the service
     */
    async shutdown() {
        const METHOD_NAME = 'shutdown';
        
        AppLogger.info(MODULE_NAME, METHOD_NAME, 'Shutting down enhanced processing service...');
        
        await this.workerPool.shutdown();
        
        AppLogger.info(MODULE_NAME, METHOD_NAME, 'Enhanced processing service shutdown complete');
    }
}
