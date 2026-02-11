/**
 * Shared logging module
 *
 * Provides a configurable logger that can be used by both CLI and VS Code.
 * Supports file logging, console logging, or custom backends.
 */

/**
 * Logger function type
 */
export type LogFunction = (message: string) => void;

/**
 * Logger configuration
 */
interface LoggerConfig {
    fileLogger?: LogFunction;
    consoleEnabled: boolean;
    fileEnabled: boolean;
}

const config: LoggerConfig = {
    fileLogger: undefined,
    consoleEnabled: false,
    fileEnabled: false,
};

/**
 * Set the file logger function.
 * This allows different environments (Node.js, browser) to provide
 * their own file logging implementation.
 */
export function setFileLogger(logger: LogFunction): void {
    config.fileLogger = logger;
    config.fileEnabled = true;
}

/**
 * Enable/disable console logging.
 */
export function enableConsoleLog(enabled: boolean = true): void {
    config.consoleEnabled = enabled;
}

/**
 * Disable all logging.
 */
export function disableLog(): void {
    config.fileEnabled = false;
    config.consoleEnabled = false;
}

/**
 * Write a message to the configured log outputs.
 */
export function writeLog(message: string): void {
    if (config.fileEnabled && config.fileLogger) {
        config.fileLogger(message);
    }
    if (config.consoleEnabled) {
        console.log(message);
    }
}

/**
 * Log to console if console logging is enabled.
 */
export function consoleLog(message: string): void {
    if (config.consoleEnabled) {
        console.log(message);
    }
}

// Node.js specific helpers (for CLI and VS Code)
// These are only used when running in Node.js environment

/**
 * Initialize file logging (Node.js only).
 * This function is for backward compatibility with existing code.
 */
export function initLog(basePath: string): void {
    // Dynamic import to avoid browser bundling issues
    if (typeof require !== 'undefined') {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fs = require('fs');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const path = require('path');
            const logFilePath = path.join(basePath, 'debug.log');

            // Initialize log file
            fs.writeFileSync(logFilePath, `=== Debug Log ===\nStarted: ${new Date().toISOString()}\n\n`);

            // Set up file logger
            setFileLogger((message: string) => {
                const timestamp = new Date().toISOString();
                const logLine = `[${timestamp}] ${message}\n`;
                try {
                    fs.appendFileSync(logFilePath, logLine);
                } catch {
                    // Ignore write errors
                }
            });
        } catch {
            // fs not available (browser environment)
            console.warn('File logging not available in this environment');
        }
    }
}
