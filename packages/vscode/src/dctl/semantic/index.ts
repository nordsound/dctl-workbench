/**
 * DCTL Semantic Analysis Module
 *
 * Re-exports semantic analysis from core.
 */

// Re-export everything from core's semantic module
export {
    SemanticAnalyzer,
    SymbolTable,
    Scope,
    ScopeManager,
    createTypeInfo,
    isPrimitiveType,
    isVectorType,
    isMatrixType,
    getVectorElementType,
    getVectorSize,
    SEMANTIC_ERROR_CODES,
    SEMANTIC_WARNING_CODES,
} from '@dctl-workbench/core';

export type {
    SemanticAnalysisResult,
    Symbol,
    SymbolKind,
    TypeInfo,
    FunctionSignature,
    FunctionParameter,
    StructInfo,
    StructField,
    SemanticError,
    SemanticWarning,
    SemanticErrorCode,
    SemanticWarningCode,
} from '@dctl-workbench/core';
