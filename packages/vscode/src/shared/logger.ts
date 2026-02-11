/**
 * Shared logging module
 *
 * Re-exports from core for backward compatibility.
 */

export {
    writeLog,
    consoleLog,
    initLog,
    setFileLogger,
    enableConsoleLog,
    disableLog,
} from '@dctl-workbench/core';

export type { LogFunction } from '@dctl-workbench/core';
