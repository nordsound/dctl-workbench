/**
 * DCTL Language Support Module
 *
 * Provides syntax checking, validation, and diagnostics for DCTL files.
 */

// Parser (from core + VSCode-specific extensions)
export * from './parser';

// Diagnostics
export { DctlNativeDiagnosticsProvider } from './diagnostics/dctlDiagnostics';
export { DCTL_ERROR_CODES } from './diagnostics/errorCodes';
export type { DctlErrorCode } from './diagnostics/errorCodes';
