/**
 * DCTL Semantic Error Codes
 */

/**
 * Semantic error code definitions
 */
export const SEMANTIC_ERROR_CODES = {
    SEM001: {
        code: 'SEM001',
        message: 'Undefined variable',
        severity: 'error',
    },
    SEM002: {
        code: 'SEM002',
        message: 'Undefined function',
        severity: 'error',
    },
    SEM003: {
        code: 'SEM003',
        message: 'Undefined type',
        severity: 'error',
    },
    SEM004: {
        code: 'SEM004',
        message: 'Array size must be positive integer',
        severity: 'error',
    },
    SEM005: {
        code: 'SEM005',
        message: 'Cannot declare variable of type void',
        severity: 'error',
    },
    SEM006: {
        code: 'SEM006',
        message: 'Cannot index non-array type',
        severity: 'error',
    },
    SEM007: {
        code: 'SEM007',
        message: 'Cannot access member of non-struct type',
        severity: 'error',
    },
    SEM008: {
        code: 'SEM008',
        message: 'Cannot call non-function',
        severity: 'error',
    },
    SEM009: {
        code: 'SEM009',
        message: 'Duplicate symbol definition',
        severity: 'error',
    },
    SEM010: {
        code: 'SEM010',
        message: 'Type mismatch',
        severity: 'error',
    },
    SEM011: {
        code: 'SEM011',
        message: 'Invalid array size expression',
        severity: 'error',
    },
    SEM012: {
        code: 'SEM012',
        message: 'Break statement outside loop or switch',
        severity: 'error',
    },
    SEM013: {
        code: 'SEM013',
        message: 'Continue statement outside loop',
        severity: 'error',
    },
    SEM014: {
        code: 'SEM014',
        message: 'Assignment to constant variable',
        severity: 'error',
    },
    SEM015: {
        code: 'SEM015',
        message: 'Wrong number of arguments',
        severity: 'error',
    },
    SEM016: {
        code: 'SEM016',
        message: 'Void function should not return a value',
        severity: 'error',
    },
    SEM017: {
        code: 'SEM017',
        message: 'Non-void function must return a value',
        severity: 'error',
    },
    SEM018: {
        code: 'SEM018',
        message: 'UI parameter used outside transform function',
        severity: 'error',
    },
} as const;

export type SemanticErrorCode = keyof typeof SEMANTIC_ERROR_CODES;

/**
 * Semantic warning code definitions
 */
export const SEMANTIC_WARNING_CODES = {
    SEM_W001: {
        code: 'SEM_W001',
        message: 'Variable shadows outer scope variable',
        severity: 'warning',
    },
    SEM_W002: {
        code: 'SEM_W002',
        message: 'Unused variable',
        severity: 'warning',
    },
    SEM_W003: {
        code: 'SEM_W003',
        message: 'Unused function',
        severity: 'warning',
    },
} as const;

export type SemanticWarningCode = keyof typeof SEMANTIC_WARNING_CODES;
