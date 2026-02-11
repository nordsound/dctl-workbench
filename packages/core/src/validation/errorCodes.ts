/**
 * DCTL Validation Error Codes
 *
 * Error codes for DCTL-specific validation (compiler, preprocessor).
 * These are separate from semantic error codes (SEM*) which are for
 * type checking and symbol resolution.
 */

export interface DctlErrorDefinition {
    code: string;
    message: string;
    severity: 'error' | 'warning' | 'info';
}

export type DctlErrorCode =
    | 'DCTL001'
    | 'DCTL002'
    | 'DCTL003'
    | 'DCTL004'
    | 'DCTL005'
    | 'DCTL006'
    | 'DCTL007'
    | 'DCTL008'
    | 'DCTL009'
    | 'DCTL010'
    | 'DCTL011'
    | 'DCTL012'
    | 'DCTL013'
    | 'DCTL014';

export const DCTL_ERROR_CODES: Record<DctlErrorCode, DctlErrorDefinition> = {
    DCTL001: {
        code: 'DCTL001',
        message: 'Missing transform or transition entry function',
        severity: 'error',
    },
    DCTL002: {
        code: 'DCTL002',
        message: 'Invalid transform function signature',
        severity: 'error',
    },
    DCTL003: {
        code: 'DCTL003',
        message: 'Invalid DEFINE_UI_PARAMS syntax',
        severity: 'error',
    },
    DCTL004: {
        code: 'DCTL004',
        message: 'Unknown UI type',
        severity: 'error',
    },
    DCTL005: {
        code: 'DCTL005',
        message: 'UI parameter limit exceeded (max 64 per type)',
        severity: 'warning',
    },
    DCTL006: {
        code: 'DCTL006',
        message: 'Forbidden C function used',
        severity: 'warning', // Changed from 'error': these functions work but _prefixed versions are recommended
    },
    DCTL007: {
        code: 'DCTL007',
        message: 'Invalid DEFINE_ACES_PARAM syntax',
        severity: 'error',
    },
    DCTL008: {
        code: 'DCTL008',
        message: 'Missing required ACES parameter',
        severity: 'error',
    },
    DCTL009: {
        code: 'DCTL009',
        message: 'GPU compilation error',
        severity: 'error',
    },
    DCTL010: {
        code: 'DCTL010',
        message: 'Shader validation error (Naga)',
        severity: 'error',
    },
    DCTL011: {
        code: 'DCTL011',
        message: 'Syntax error',
        severity: 'error',
    },
    DCTL012: {
        code: 'DCTL012',
        message: 'Float literal without suffix',
        severity: 'warning',
    },
    DCTL013: {
        code: 'DCTL013',
        message: 'Unknown function',
        severity: 'error',
    },
    DCTL014: {
        code: 'DCTL014',
        message: 'Duplicate entry point',
        severity: 'error',
    },
};
