// ==================================================
// src/workers/WorkerPool.js
// ==================================================

// node core in ESM
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';

import { AppLogger } from '@seniorminder/logger';

const MODULE_NAME = 'WorkerPool';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Manages a pool of worker threads for concurrent processing
 * 
 * Supports two modes:
 * 1. workerScriptPath - path to worker script file
 * 2. workerFactory - factory function that creates Worker instances
 */
export class WorkerPool {
    /**
     * @param {Object}   [config={}]
     * @param {number}   [config.maxConcurrentWorkers=3]  - Maximum number of worker threads
     *                                                       that may run simultaneously.
     * @param {number}   [config.workerTimeoutMs=300000]  - Per-worker timeout in milliseconds.
     *                                                       Workers that exceed this are terminated
     *                                                       and their job recorded as failed.
     * @param {string|URL} [config.workerScriptPath]      - Path/URL to the worker script file.
     *                                                       Used when `workerFactory` is not provided.
     *                                                       Defaults to `AudioProcessingWorker.js`
     *                                                       if neither option is supplied.
     * @param {Function} [config.workerFactory]           - Factory function `(workerData) => Worker`.
     *                                                       Takes precedence over `workerScriptPath`
     *                                                       when both are supplied.
     */
    constructor(config = {}) {
        const METHOD_NAME = 'constructor';
        
        this.config = {
            maxConcurrentWorkers: config.maxConcurrentWorkers || 3,
            workerTimeoutMs: config.workerTimeoutMs || 300000, // 5 minutes
            workerScriptPath: config.workerScriptPath || null,
            workerFactory: config.workerFactory || null,
            ...config
        };

        // Validate that we have either a path or factory
        if (!this.config.workerScriptPath && !this.config.workerFactory) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, 
                'No workerScriptPath or workerFactory provided - using default AudioProcessingWorker.js');
            this.config.workerScriptPath = new URL('./AudioProcessingWorker.js', import.meta.url);
        }

        // Worker pool state
        this.activeWorkers = new Map(); // workerId -> { worker, data, startTime, status }
        this.workerIdCounter = 0;
        this.completedJobs = [];
        this.failedJobs = [];

        const mode = this.config.workerFactory ? 'factory' : 'script path';
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
            `WorkerPool initialized (${mode}): max ${this.config.maxConcurrentWorkers} workers, timeout ${this.config.workerTimeoutMs}ms`
        );
    }

    /**
     * Generate a unique worker ID string for tracking a job in `activeWorkers`.
     * Format: `worker_<incrementing counter>_<epoch ms>`.
     *
     * @returns {string} Unique worker identifier.
     */
    generateWorkerId() {
        return `worker_${++this.workerIdCounter}_${Date.now()}`;
    }

    /**
     * Get current pool status
     */
    getStatus() {
        const active = this.activeWorkers.size;
        const completed = this.completedJobs.length;
        const failed = this.failedJobs.length;
        const maxWorkers = this.config.maxConcurrentWorkers;
        
        return {
            active,
            completed,
            failed,
            maxWorkers,
            canStartNew: active < maxWorkers,
            activeWorkerIds: Array.from(this.activeWorkers.keys())
        };
    }

    /**
     * Log pool status
     */
    logStatus() {
        const METHOD_NAME = 'logStatus';
        const status = this.getStatus();
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
            `Pool Status: ${status.active}/${status.maxWorkers} active, ${status.completed} completed, ${status.failed} failed`
        );
        
        return status;
    }

    /**
     * Check if pool can accept new work
     */
    canAcceptWork() {
        return this.getStatus().canStartNew;
    }

    /**
     * Create a worker using either factory or script path
     * @private
     */
    _createWorker(workerData) {
        if (this.config.workerFactory) {
            // Use factory function
            return this.config.workerFactory(workerData);
        } else {
            // Use script path
            return new Worker(this.config.workerScriptPath, {
                workerData: workerData
            });
        }
    }

    /**
     * Submit work to the pool
     * @param {Object} workerData - Data to pass to worker
     * @param {string} jobName - Optional name for the job (for logging)
     * @returns {Promise<Object>} - Promise that resolves with worker results
     */
    async submitWork(workerData, jobName = 'unnamed_job') {
        const METHOD_NAME = 'submitWork';
        
        // Check if we can start a new worker
        if (!this.canAcceptWork()) {
            const status = this.getStatus();
            throw new Error(`Worker pool at capacity (${status.active}/${status.maxWorkers}). Try again later.`);
        }
        
        const workerId = this.generateWorkerId();
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Starting worker ${workerId} for job: ${jobName}`);
        
        return new Promise((resolve, reject) => {
            // Create worker thread using factory or path
            const worker = this._createWorker(workerData);

            // Add to active workers pool
            const workerInfo = {
                worker: worker,
                data: workerData,
                startTime: Date.now(),
                status: 'starting',
                workerId: workerId,
                jobName: jobName
            };
            
            this.activeWorkers.set(workerId, workerInfo);
            
            AppLogger.debug(MODULE_NAME, METHOD_NAME, 
                `Worker ${workerId} spawned (${this.activeWorkers.size}/${this.config.maxConcurrentWorkers} active)`
            );

            // Set timeout for worker
            const timeout = setTimeout(() => {
                if (this.activeWorkers.has(workerId)) {
                    AppLogger.error(MODULE_NAME, METHOD_NAME, 
                        `Worker ${workerId} timed out after ${this.config.workerTimeoutMs}ms`
                    );
                    worker.terminate();
                    this.handleWorkerCompletion(workerId, 'timeout', null, 'Worker timed out');
                    reject(new Error(`Worker ${workerId} timed out`));
                }
            }, this.config.workerTimeoutMs);

            // Handle messages from worker
            worker.on('message', (message) => {
                if (!this.activeWorkers.has(workerId)) return; // Worker already cleaned up
                
                const workerInfo = this.activeWorkers.get(workerId);
                
                switch (message.type) {
                    case 'progress':
                        workerInfo.status = message.stage || 'processing';
                        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
                            `Worker ${workerId} [${message.stage}]: ${message.message}`
                        );
                        break;
                        
                    case 'complete':
                        clearTimeout(timeout);
                        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
                            `Worker ${workerId} completed successfully for job: ${jobName}`
                        );
                        
                        worker.terminate();
                        this.handleWorkerCompletion(workerId, 'completed', message.results, null);
                        resolve(message.results);
                        break;
                        
                    case 'error':
                        clearTimeout(timeout);
                        AppLogger.error(MODULE_NAME, METHOD_NAME, 
                            `Worker ${workerId} error: ${message.error}`
                        );
                        
                        worker.terminate();
                        this.handleWorkerCompletion(workerId, 'failed', null, message.error);
                        reject(new Error(message.error));
                        break;
                        
                    default:
                        AppLogger.debug(MODULE_NAME, METHOD_NAME, 
                            `Worker ${workerId} unknown message: ${message.type}`
                        );
                }
            });

            // Handle worker errors
            worker.on('error', (error) => {
                clearTimeout(timeout);
                if (this.activeWorkers.has(workerId)) {
                    AppLogger.error(MODULE_NAME, METHOD_NAME, 
                        `Worker ${workerId} thread error: ${error.message}`
                    );
                    this.handleWorkerCompletion(workerId, 'failed', null, error.message);
                    reject(error);
                }
            });

            // Handle worker exit
            worker.on('exit', (code) => {
                clearTimeout(timeout);
                if (code !== 0 && this.activeWorkers.has(workerId)) {
                    AppLogger.error(MODULE_NAME, METHOD_NAME, 
                        `Worker ${workerId} stopped with exit code ${code}`
                    );
                    this.handleWorkerCompletion(workerId, 'failed', null, `Exit code ${code}`);
                    reject(new Error(`Worker stopped with exit code ${code}`));
                }
            });
        });
    }

    /**
     * Finalize a worker after it stops — successfully or otherwise.
     *
     * Removes the worker from `activeWorkers`, computes wall-clock duration,
     * appends a job record to `completedJobs` or `failedJobs`, then calls
     * `cleanup()` to trim history and `logStatus()` to emit the updated pool state.
     *
     * @param {string}      workerId - ID returned by `generateWorkerId()`.
     * @param {string}      status   - One of `'completed'`, `'failed'`, or `'timeout'`.
     * @param {Object|null} results  - Payload from the worker's `complete` message, or null.
     * @param {string|null} error    - Error message string, or null on success.
     */
    handleWorkerCompletion(workerId, status, results, error) {
        const METHOD_NAME = 'handleWorkerCompletion';
        
        if (!this.activeWorkers.has(workerId)) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME, `Worker ${workerId} not found in active pool`);
            return;
        }
        
        const workerInfo = this.activeWorkers.get(workerId);
        const duration = (Date.now() - workerInfo.startTime) / 1000;
        
        // Move to appropriate completed list
        const jobRecord = {
            workerId,
            jobName: workerInfo.jobName,
            status,
            duration,
            completedAt: new Date().toISOString(),
            results: results || null,
            error: error || null
        };
        
        if (status === 'completed') {
            this.completedJobs.push(jobRecord);
            AppLogger.debug(MODULE_NAME, METHOD_NAME, 
                `Worker ${workerId} completed in ${duration.toFixed(1)}s`
            );
        } else {
            this.failedJobs.push(jobRecord);
            AppLogger.error(MODULE_NAME, METHOD_NAME, 
                `Worker ${workerId} failed after ${duration.toFixed(1)}s: ${error}`
            );
        }
        
        // Remove from active workers
        this.activeWorkers.delete(workerId);
        
        // Periodic cleanup
        this.cleanup();
        
        // Log updated status
        this.logStatus();
    }

    /**
     * Trim in-memory job history to prevent unbounded growth.
     * Keeps the most recent 10 completed jobs and 5 failed jobs.
     * Called automatically by `handleWorkerCompletion()` after every job.
     */
    cleanup() {
        const METHOD_NAME = 'cleanup';
        
        // Keep only last 10 completed jobs for history
        if (this.completedJobs.length > 10) {
            this.completedJobs = this.completedJobs.slice(-10);
        }
        
        // Keep only last 5 failed jobs for debugging
        if (this.failedJobs.length > 5) {
            this.failedJobs = this.failedJobs.slice(-5);
        }
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Job history cleanup completed');
    }

    /**
     * Terminate all active workers (graceful shutdown)
     */
    async shutdown() {
        const METHOD_NAME = 'shutdown';
        
        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Shutting down pool with ${this.activeWorkers.size} active workers`);
        
        const shutdownPromises = [];
        
        for (const [workerId, workerInfo] of this.activeWorkers) {
            AppLogger.debug(MODULE_NAME, METHOD_NAME, `Terminating worker ${workerId}`);
            
            shutdownPromises.push(
                new Promise((resolve) => {
                    workerInfo.worker.terminate().then(() => {
                        AppLogger.debug(MODULE_NAME, METHOD_NAME, `Worker ${workerId} terminated`);
                        resolve();
                    }).catch((error) => {
                        AppLogger.error(MODULE_NAME, METHOD_NAME, `Error terminating worker ${workerId}: ${error.message}`);
                        resolve(); // Still resolve to not block shutdown
                    });
                })
            );
        }
        
        await Promise.all(shutdownPromises);
        
        this.activeWorkers.clear();
        AppLogger.debug(MODULE_NAME, METHOD_NAME, 'Worker pool shutdown complete');
    }

    /**
     * Get job history
     */
    getJobHistory() {
        return {
            completed: [...this.completedJobs],
            failed: [...this.failedJobs],
            active: Array.from(this.activeWorkers.values()).map(w => ({
                workerId: w.workerId,
                jobName: w.jobName,
                status: w.status,
                runningTime: (Date.now() - w.startTime) / 1000
            }))
        };
    }
}