// ==================================================
// src/logger/AppLogger.js
// ==================================================

import { logManager } from './LogManager.js';

export const AppLogger = {
    debug: (module, method, message, ...args) => {
        return logManager.debug(`[${module}:${method}] ${message}`, ...args);
    },
    
    info: (module, method, message, ...args) => {
        return logManager.info(`[${module}:${method}] ${message}`, ...args);
    },
    
    warn: (module, method, message, ...args) => {
        return logManager.warn(`[${module}:${method}] ${message}`, ...args);
    },
    
    error: (module, method, message, ...args) => {
        return logManager.error(`[${module}:${method}] ${message}`, ...args);
    },
 
    always: (module, method, message, ...args) => {
        return logManager.always(`[${module}:${method}] ${message}`, ...args);
    },

    setOutput: (...args) => logManager.setOutput?.(...args),
    setLevel:  (...args) => logManager.setLevel?.(...args),
    setFormat: (...args) => logManager.setFormat?.(...args),
    raw: logManager
};
