import { Logger } from './Logger.js';
import { LogLevel, LogOutput } from './utils/Constants.js';

export class LogManager {
    constructor() {
        this.loggers = new Map();
        this.defaultLoggerName = 'SeniorMinder';
        this.output = { type: LogOutput.CONSOLE };

        // Get log level from environment variable or default to INFO
        const envLogLevel = process.env.LOG_LEVEL?.toUpperCase();
        const defaultLevel = LogLevel[envLogLevel] !== undefined ? LogLevel[envLogLevel] : LogLevel.INFO;

        this.defaultOptions = {
            level: defaultLevel,
            outputType: LogOutput.CONSOLE,
            colorEnabled: true,
            timestampEnabled: true,
            includeLocation: false
        };
    }

    setDefaults(options) {
        this.defaultOptions = { ...this.defaultOptions, ...options };
    }

    // getLogger(name, options = {}) {
    getLogger(name = this.defaultLoggerName, options = {}) {
        if (this.loggers.has(name)) {
            return this.loggers.get(name);
        }

        const loggerOptions = { ...this.defaultOptions, ...options };
        
        const logger = new Logger(name, loggerOptions);
        this.loggers.set(name, logger);
        
        return logger;
    }

    removeLogger(name) {
        return this.loggers.delete(name);
    }

    getAllLoggers() {
        return Array.from(this.loggers.values());
    }

    setGlobalLevel(level) {
        for (const logger of this.loggers.values()) {
            logger.setLevel(level);
        }
    }

    setOutput(options = {}) {
        const type = options.type ?? LogOutput.CONSOLE;
        
        // If file output requested without logFile, fall back to console
        if ((type === LogOutput.FILE || type === LogOutput.BOTH) && !options.logFile) {
            console.warn('[LogManager] File output requested without logFile; falling back to console.');
            this.output = { type: LogOutput.CONSOLE };
        } else {
            this.output = { ...options, type };
        }
        
        // Update defaults so any LATER-created loggers inherit file output
        this.defaultOptions = {
            ...this.defaultOptions,
            outputType: this.output.type,
            logFile: this.output.logFile,
            maxFileSize: this.output.maxFileSize ?? this.defaultOptions.maxFileSize,
            maxFiles: this.output.maxFiles ?? this.defaultOptions.maxFiles
        };
        
        // Propagate to existing logger instances
        for (const l of this.loggers.values()) {
            l.setOutput?.(this.output);
        }
    }

    async shutdown() {
        // Perform any cleanup needed for all loggers
        this.loggers.clear();
    }

    debug(...args)  { return this.getLogger().debug(...args); }
    info(...args)   { return this.getLogger().info(...args); }
    warn(...args)   { return this.getLogger().warn(...args); }
    error(...args)  { return this.getLogger().error(...args); }
    always(...args) {
        const l = this.getLogger();
        return typeof l.always === 'function' ? l.always(...args) : l.info(...args);
    }
}

// Singleton instance
export const logManager = new LogManager();
