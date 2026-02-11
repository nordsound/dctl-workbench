/**
 * Shared Utilities Module
 *
 * Common utilities used across CLI and VS Code.
 */

export {
    writeLog,
    consoleLog,
    initLog,
    setFileLogger,
    enableConsoleLog,
    disableLog,
} from './logger.js';

export type { LogFunction } from './logger.js';
