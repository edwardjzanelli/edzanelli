// const fs = require('fs-extra');
// const path = require('path');
// const { LogLevel, LogOutput, LogFormat, LogColors, LogIcons, LogLevelNames } = require('./utils/Constants');
import fs from 'fs-extra';
import path from 'path';

import { LogLevel, LogOutput, LogFormat, LogColors, LogIcons, LogLevelNames } from './utils/Constants.js';

export class Logger {
    constructor(name, options = {}) {
        this.name = name;
        this.level = options.level !== undefined ? options.level : LogLevel.INFO;
        this.outputType = options.outputType || LogOutput.CONSOLE;
        this.logFile = options.logFile;
        this.format = options.format || LogFormat.DETAILED;
        this.colorEnabled = options.colorEnabled !== false;
        this.timestampEnabled = options.timestampEnabled !== false;
        this.includeLocation = options.includeLocation || false;
        this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB default
        this.maxFiles = options.maxFiles || 5;
        
        // Internal state
        this._timers = new Map();
        
        // Ensure log directory exists if using file output
        if (this.outputType === LogOutput.FILE || this.outputType === LogOutput.BOTH) {
            if (!this.logFile) {
                throw new Error('logFile must be specified for file output');
            }
            this._ensureLogDirectory();
        }

        // Internal state
        this._timers = new Map();

        // File size tracking (avoids stat-on-every-write)
        this._currentFileSize = 0;
        this._fileSizeInitialized = false;
        this._writeCounter = 0;
        this._sizeCheckInterval = 100;  // re-stat every N writes for reconciliation
    }

    _ensureLogDirectory() {
        const logDir = path.dirname(this.logFile);
        fs.ensureDirSync(logDir);
    }

    shouldLog(level) {
        if (level === 6) return true; // LogLevel.ALWAYS
        return level >= this.level;
    }

    getTimestamp() {
        return new Date().toISOString();
    }

    getLocation() {
        if (!this.includeLocation) return '';
        
        const stack = new Error().stack;
        const lines = stack.split('\n');
        
        for (let i = 3; i < lines.length; i++) {
            const line = lines[i];
            if (!line.includes('Logger.js') && !line.includes('node_modules')) {
                const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
                if (match) {
                    const [, func, file, lineNum] = match;
                    const fileName = path.basename(file);
                    return ` [${fileName}:${lineNum}]`;
                }
                break;
            }
        }
        return '';
    }

    formatMessage(level, message, ...args) {
        const levelName = LogLevelNames[level];
        let logEntry = {};

        if (this.format === LogFormat.JSON) {
            logEntry = {
                timestamp: this.getTimestamp(),
                level: levelName,
                logger: this.name,
                message: this._formatMessageContent(message, ...args)
            };
            
            if (this.includeLocation) {
                logEntry.location = this.getLocation().trim();
            }
            
            return JSON.stringify(logEntry);
        }

        // Text-based formatting
        let formattedMessage = '';
        
        if (this.timestampEnabled) {
            formattedMessage += `[${this.getTimestamp()}] `;
        }
        
        // Logger name
        formattedMessage += `[${this.name}] `;
        
        // Level with icon and color
        const icon = LogIcons[levelName] || '';
        const color = this.colorEnabled ? LogColors[levelName] : '';
        const reset = this.colorEnabled ? LogColors.RESET : '';
        
        formattedMessage += `${color}${levelName.padEnd(5)} ${icon}${reset} `;
        
        // Location (if enabled)
        if (this.includeLocation) {
            formattedMessage += this.getLocation();
        }
        
        // Message content
        formattedMessage += this._formatMessageContent(message, ...args);
        
        return formattedMessage;
    }

    _formatMessageContent(message, ...args) {
        if (typeof message === 'string' && args.length > 0) {
            return message + ' ' + args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
        } else if (typeof message === 'object') {
            return JSON.stringify(message, null, 2);
        } else {
            return String(message);
        }
    }

    // On first use, initialize from disk:
    async _initFileSize() {
        if (this._fileSizeInitialized) return;
        this._fileSizeInitialized = true;
        try {
            if (fs.existsSync(this.logFile)) {
                const stats = await fs.stat(this.logFile);
                this._currentFileSize = stats.size;
            } else {
                this._currentFileSize = 0;
            }
        } catch (e) {
            this._currentFileSize = 0;
        }
    }

    async _writeToFile(formattedMessage) {
        try {
            await this._initFileSize();
            
            // Strip ANSI color codes for file output
            const cleanMessage = formattedMessage.replace(/\x1b\[[0-9;]*m/g, '') + '\n';
            const messageBytes = Buffer.byteLength(cleanMessage, 'utf8');
            
            // In-memory size check (no syscall)
            if (this._currentFileSize + messageBytes > this.maxFileSize) {
                await this._rotateLogFile();
                this._currentFileSize = 0;
            }
            
            await fs.appendFile(this.logFile, cleanMessage);
            this._currentFileSize += messageBytes;
            
            // Periodic reconciliation in case something else touched the file
            this._writeCounter++;
            if (this._writeCounter >= this._sizeCheckInterval) {
                this._writeCounter = 0;
                try {
                    const stats = await fs.stat(this.logFile);
                    this._currentFileSize = stats.size;
                } catch (e) {
                    // ignore — keep using counter value
                }
            }
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }

    async _rotateLogFile() {
        try {
            // Rotate existing files
            for (let i = this.maxFiles - 1; i > 0; i--) {
                const oldFile = `${this.logFile}.${i}`;
                const newFile = `${this.logFile}.${i + 1}`;
                
                if (fs.existsSync(oldFile)) {
                    if (i === this.maxFiles - 1) {
                        await fs.remove(oldFile); // Delete oldest
                    } else {
                        await fs.move(oldFile, newFile);
                    }
                }
            }
            
            // Move current log to .1
            if (fs.existsSync(this.logFile)) {
                await fs.move(this.logFile, `${this.logFile}.1`);
            }
        } catch (error) {
            console.error('Failed to rotate log file:', error);
        }
    }

    async write(formattedMessage) {
        const promises = [];
        
        if (this.outputType === LogOutput.CONSOLE || this.outputType === LogOutput.BOTH) {
            console.log(formattedMessage);
        }
        
        if (this.outputType === LogOutput.FILE || this.outputType === LogOutput.BOTH) {
            promises.push(this._writeToFile(formattedMessage));
        }
        
        if (promises.length > 0) {
            await Promise.all(promises);
        }
    }

    async log(level, message, ...args) {
        if (!this.shouldLog(level)) return;
        
        const formattedMessage = this.formatMessage(level, message, ...args);
        await this.write(formattedMessage);
    }

    // Convenience methods
    async trace(message, ...args) { await this.log(LogLevel.TRACE, message, ...args); }
    async debug(message, ...args) { await this.log(LogLevel.DEBUG, message, ...args); }
    async info(message, ...args) { await this.log(LogLevel.INFO, message, ...args); }
    async warn(message, ...args) { await this.log(LogLevel.WARN, message, ...args); }
    async error(message, ...args) { await this.log(LogLevel.ERROR, message, ...args); }
    async fatal(message, ...args) { await this.log(LogLevel.FATAL, message, ...args); }
    async always(message, ...args) { await this.log(LogLevel.ALWAYS, message, ...args); }

    // Performance timing
    time(label) {
        this._timers.set(label, Date.now());
        this.debug(`⏱️ Started timer: ${label}`);
    }

    timeEnd(label) {
        if (this._timers.has(label)) {
            const duration = ((Date.now() - this._timers.get(label)) / 1000).toFixed(1);
            this.debug(`⏱️ ${label}: ${duration}s`);
            this._timers.delete(label);
            return duration;
        } else {
            this.warn(`Timer '${label}' was not started`);
            return null;
        }
    }

    // Progress indicators
    progress(message) {
        if (!this.shouldLog(LogLevel.DEBUG)) return;
        
        if (this.outputType === LogOutput.CONSOLE || this.outputType === LogOutput.BOTH) {
            process.stdout.write(`\r🔄 [${this.name}] ${message}`);
        }
        
        if (this.outputType === LogOutput.FILE || this.outputType === LogOutput.BOTH) {
            this.debug(`PROGRESS: ${message}`);
        }
    }

    clearProgress() {
        if (this.outputType === LogOutput.CONSOLE || this.outputType === LogOutput.BOTH) {
            process.stdout.write('\r' + ' '.repeat(80) + '\r');
        }
    }

    // Utility methods
    separator(char = '=', length = 60) {
        this.info(char.repeat(length));
    }

    header(title) {
        this.separator();
        this.info(`🎯 ${title.toUpperCase()}`);
        this.separator();
    }

    /**
     * Update output destination at runtime. Called by LogManager.setOutput
     * after the Logger is already constructed.
     */
    setOutput(options = {}) {
        const newType = options.type ?? this.outputType;
        const newLogFile = options.logFile ?? this.logFile;
        
        // If switching to file output (or both), require logFile and ensure dir
        if (newType === 'file' || newType === 'both') {
            if (!newLogFile) {
                console.error(`[Logger:${this.name}] setOutput: file output requested but no logFile provided; staying on previous output.`);
                return;
            }
            
            // If the file path is changing, reset size tracking
            if (newLogFile !== this.logFile) {
                this._fileSizeInitialized = false;
                this._currentFileSize = 0;
                this._writeCounter = 0;
            }
            
            this.logFile = newLogFile;
            if (options.maxFileSize !== undefined) this.maxFileSize = options.maxFileSize;
            if (options.maxFiles !== undefined) this.maxFiles = options.maxFiles;
            
            this._ensureLogDirectory();
        }
        
        this.outputType = newType;
    }

    setLevel(level) {
        if (typeof level === 'string') {
            const levelValue = LogLevel[level.toUpperCase()];
            if (levelValue !== undefined) {
                this.level = levelValue;
                this.info(`Log level changed to ${level.toUpperCase()}`);
            } else {
                this.error(`Invalid log level: ${level}`);
            }
        } else if (typeof level === 'number' && LogLevelNames[level]) {
            this.level = level;
            this.info(`Log level changed to ${LogLevelNames[level]}`);
        } else {
            this.error(`Invalid log level: ${level}`);
        }
    }

    getCurrentLevel() {
        return LogLevelNames[this.level] || 'UNKNOWN';
    }
}
