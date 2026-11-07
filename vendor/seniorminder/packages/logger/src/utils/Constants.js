export const LogLevel = {
    TRACE: 0,
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
    FATAL: 5,
    ALWAYS: 6
};

export const LogOutput = {
    CONSOLE: 'console',
    FILE: 'file',
    BOTH: 'both'
};

export const LogFormat = {
    SIMPLE: 'simple',
    DETAILED: 'detailed',
    JSON: 'json'
};

// Level colors for console output
export const LogColors = {
    TRACE: '\x1b[90m',    // Gray
    DEBUG: '\x1b[36m',    // Cyan
    INFO: '\x1b[32m',     // Green
    WARN: '\x1b[33m',     // Yellow
    ERROR: '\x1b[31m',    // Red
    FATAL: '\x1b[35m',    // Magenta
    ALWAYS: '\x1b[97m',   // Bright White
    RESET: '\x1b[0m'      // Reset
};

// Level emoji/icons for better visual distinction
export const LogIcons = {
    TRACE: '🔍',
    DEBUG: '🐛',
    INFO: 'ℹ️',
    WARN: '⚠️',
    ERROR: '❌',
    FATAL: '💀',
    ALWAYS: '📢'
};

export const LogLevelNames = {
    0: 'TRACE',
    1: 'DEBUG',
    2: 'INFO',
    3: 'WARN',
    4: 'ERROR',
    5: 'FATAL',
    6: 'ALWAYS'
};
