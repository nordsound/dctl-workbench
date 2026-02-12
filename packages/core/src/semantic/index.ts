/**
 * DCTL Semantic Analysis Module
 *
 * Provides semantic analysis for DCTL programs including:
 * - Symbol table management
 * - Type checking
 * - Undefined symbol detection
 * - Array size validation
 */

export { SemanticAnalyzer } from './analyzer.js';
export type { SemanticAnalysisResult } from './analyzer.js';

export { SymbolTable } from './symbolTable.js';
export { Scope, ScopeManager } from './scope.js';

export type {
    Symbol,
    SymbolKind,
    TypeInfo,
    FunctionSignature,
    FunctionParameter,
    StructInfo,
    StructField,
    SemanticError,
    SemanticWarning,
} from './types.js';

export {
    createTypeInfo,
    isPrimitiveType,
    isVectorType,
    isMatrixType,
    getVectorElementType,
    getVectorSize,
} from './types.js';

export { SEMANTIC_ERROR_CODES, SEMANTIC_WARNING_CODES } from './errorCodes.js';
export type { SemanticErrorCode, SemanticWarningCode } from './errorCodes.js';

export { analyzeDocument, getMemberCompletions } from './documentAnalyzer.js';
export type { DocumentSymbol, DocumentAnalysisResult } from './documentAnalyzer.js';
