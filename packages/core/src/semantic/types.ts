/**
 * DCTL Semantic Analysis Type Definitions
 */

import type { SourceLocation } from '../parser/index.js';

// =============================================================================
// Symbol Types
// =============================================================================

/**
 * Kind of symbol
 */
export type SymbolKind =
    | 'variable'
    | 'function'
    | 'parameter'
    | 'struct'
    | 'typedef'
    | 'field'
    | 'constant';

/**
 * Type information for semantic analysis
 */
export interface TypeInfo {
    /** Type name (e.g., "float3", "int", custom struct name) */
    name: string;
    /** Whether this is an array type */
    isArray: boolean;
    /** Single dimension array size (null for unsized) */
    arraySize?: number | null;
    /** Multi-dimensional array sizes */
    arraySizes?: number[];
    /** Whether this is a pointer type */
    isPointer: boolean;
    /** Whether this is const-qualified */
    isConst: boolean;
    /** Whether this is void type */
    isVoid: boolean;
}

/**
 * Symbol in the symbol table
 */
export interface Symbol {
    /** Symbol name */
    name: string;
    /** Kind of symbol */
    kind: SymbolKind;
    /** Type information */
    type: TypeInfo;
    /** Source location of definition */
    loc: SourceLocation;
    /** Whether this is a const variable */
    isConst?: boolean;
    /** Whether this is a pointer */
    isPointer?: boolean;
    /** Whether this is a builtin symbol */
    isBuiltin?: boolean;
    /** Constant value for compile-time constants (e.g., enum values from COMBO_BOX) */
    constValue?: number | string;
}

// =============================================================================
// Function Types
// =============================================================================

/**
 * Function parameter information
 */
export interface FunctionParameter {
    /** Parameter name */
    name: string;
    /** Parameter type */
    type: TypeInfo;
    /** Whether parameter is const-qualified */
    isConst?: boolean;
}

/**
 * Function signature information
 */
export interface FunctionSignature {
    /** Function name */
    name: string;
    /** Return type */
    returnType: TypeInfo;
    /** Parameters */
    parameters: FunctionParameter[];
    /** Source location of definition */
    loc: SourceLocation;
    /** Whether this is a builtin function */
    isBuiltin: boolean;
}

// =============================================================================
// Struct Types
// =============================================================================

/**
 * Struct field information
 */
export interface StructField {
    /** Field name */
    name: string;
    /** Field type */
    type: TypeInfo;
    /** Source location */
    loc: SourceLocation;
}

/**
 * Struct information
 */
export interface StructInfo {
    /** Struct name */
    name: string;
    /** Fields */
    fields: StructField[];
    /** Source location of definition */
    loc: SourceLocation;
}

// =============================================================================
// Semantic Analysis Results
// =============================================================================

/**
 * Semantic error
 */
export interface SemanticError {
    /** Error code (e.g., SEM001) */
    code: string;
    /** Error message */
    message: string;
    /** Line number (1-based) */
    line: number;
    /** Column number (1-based) */
    column: number;
    /** Identifier that caused the error (if applicable) */
    identifier?: string;
}

/**
 * Semantic warning
 */
export interface SemanticWarning {
    /** Warning code */
    code: string;
    /** Warning message */
    message: string;
    /** Line number (1-based) */
    line: number;
    /** Column number (1-based) */
    column: number;
}

// =============================================================================
// Type Utilities
// =============================================================================

/**
 * Create a simple type info
 */
export function createTypeInfo(name: string, options?: Partial<TypeInfo>): TypeInfo {
    return {
        name,
        isArray: options?.isArray ?? false,
        arraySize: options?.arraySize,
        arraySizes: options?.arraySizes,
        isPointer: options?.isPointer ?? false,
        isConst: options?.isConst ?? false,
        isVoid: name === 'void',
    };
}

/**
 * Check if a type is a primitive type
 */
export function isPrimitiveType(typeName: string): boolean {
    const primitives = [
        'void', 'int', 'uint', 'float', 'double', 'half', 'bool', 'char',
        'short', 'long', 'unsigned',
    ];
    return primitives.includes(typeName);
}

/**
 * Check if a type is a vector type
 */
export function isVectorType(typeName: string): boolean {
    const vectors = [
        'float2', 'float3', 'float4',
        'int2', 'int3', 'int4',
        'half2', 'half3', 'half4',
    ];
    return vectors.includes(typeName);
}

/**
 * Check if a type is a matrix type
 */
export function isMatrixType(typeName: string): boolean {
    const matrices = [
        'float3x3', 'float4x4', 'mat3', 'mat4',
    ];
    return matrices.includes(typeName);
}

/**
 * Get the element type of a vector type
 */
export function getVectorElementType(typeName: string): string | null {
    if (typeName.startsWith('float')) return 'float';
    if (typeName.startsWith('int')) return 'int';
    if (typeName.startsWith('half')) return 'half';
    return null;
}

/**
 * Get the size of a vector type
 */
export function getVectorSize(typeName: string): number | null {
    const match = typeName.match(/[a-z]+(\d)$/);
    if (match) {
        return parseInt(match[1], 10);
    }
    return null;
}
