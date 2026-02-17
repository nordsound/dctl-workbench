/**
 * DCTL Symbol Table
 *
 * Central repository for all symbols in a DCTL program.
 */

import { Scope, ScopeManager } from './scope.js';
import type {
    Symbol,
    SymbolKind,
    TypeInfo,
    FunctionSignature,
    FunctionParameter,
    StructInfo,
    StructField,
} from './types.js';
import type { SourceLocation } from '../parser/index.js';
import {
    DCTL_BUILTIN_FUNCTIONS,
    DCTL_GLOBAL_CONSTANTS,
    DCTL_VECTOR_TYPES,
} from '../parser/dctlTypes.js';

/**
 * Symbol table for semantic analysis
 */
export class SymbolTable {
    private scopeManager: ScopeManager;
    /** Map from function name to array of overloaded signatures */
    private functions: Map<string, FunctionSignature[]> = new Map();
    private structs: Map<string, StructInfo> = new Map();
    private typedefs: Map<string, TypeInfo> = new Map();

    constructor() {
        this.scopeManager = new ScopeManager();
        this.registerBuiltins();
    }

    // =========================================================================
    // Scope Management
    // =========================================================================

    /**
     * Enter a new scope
     */
    enterScope(name: string): Scope {
        return this.scopeManager.enterScope(name);
    }

    /**
     * Exit the current scope
     */
    exitScope(): Scope | null {
        return this.scopeManager.exitScope();
    }

    /**
     * Get the current scope
     */
    getCurrentScope(): Scope {
        return this.scopeManager.getCurrentScope();
    }

    /**
     * Get the global scope
     */
    getGlobalScope(): Scope {
        return this.scopeManager.getGlobalScope();
    }

    /**
     * Check if currently at global scope
     */
    isAtGlobalScope(): boolean {
        return this.scopeManager.isAtGlobalScope();
    }

    // =========================================================================
    // Symbol Management
    // =========================================================================

    /**
     * Define a symbol in the current scope
     */
    define(symbol: Symbol): boolean {
        return this.scopeManager.define(symbol);
    }

    /**
     * Define a symbol in the global scope
     */
    defineGlobal(symbol: Symbol): boolean {
        return this.scopeManager.defineGlobal(symbol);
    }

    /**
     * Look up a symbol starting from current scope
     */
    lookup(name: string): Symbol | undefined {
        return this.scopeManager.lookup(name);
    }

    /**
     * Look up a symbol in current scope only
     */
    lookupLocal(name: string): Symbol | undefined {
        return this.scopeManager.lookupLocal(name);
    }

    /**
     * Look up a symbol in global scope only
     */
    lookupGlobal(name: string): Symbol | undefined {
        return this.scopeManager.lookupGlobal(name);
    }

    // =========================================================================
    // Function Management (with overloading support)
    // =========================================================================

    /**
     * Define a function (supports overloading)
     *
     * Allows multiple function signatures with the same name but different
     * parameter types (true function overloading). Returns true if the signature
     * was added, false if an identical overload already exists.
     */
    defineFunction(sig: FunctionSignature): boolean {
        const existing = this.functions.get(sig.name);
        if (existing) {
            // Check if this exact overload already exists (same param types)
            const sameSignature = existing.find(
                s => this.areParameterTypesEqual(s.parameters, sig.parameters)
            );
            if (sameSignature) {
                // Allow redefinition (for forward declarations)
                // Replace the existing signature with the new one
                const idx = existing.indexOf(sameSignature);
                existing[idx] = sig;
                return true;
            }
            // Add as a new overload (different parameter types)
            existing.push(sig);
            return true;
        }
        this.functions.set(sig.name, [sig]);
        return true;
    }

    /**
     * Compare two parameter lists for type equality
     */
    private areParameterTypesEqual(params1: FunctionParameter[], params2: FunctionParameter[]): boolean {
        if (params1.length !== params2.length) return false;
        for (let i = 0; i < params1.length; i++) {
            if (params1[i].type.name !== params2[i].type.name) return false;
            if (params1[i].type.isArray !== params2[i].type.isArray) return false;
            if (params1[i].type.isPointer !== params2[i].type.isPointer) return false;
        }
        return true;
    }

    /**
     * Look up a function by name (returns first signature for backward compatibility)
     */
    lookupFunction(name: string): FunctionSignature | undefined {
        const sigs = this.functions.get(name);
        return sigs ? sigs[0] : undefined;
    }

    /**
     * Look up a function overload by name and argument count
     *
     * Returns the signature that matches the given argument count, or undefined
     * if no matching overload exists.
     *
     * Note: This method only matches by count, not types. For type-aware lookup,
     * use lookupFunctionOverloadByTypes.
     */
    lookupFunctionOverload(name: string, argCount: number): FunctionSignature | undefined {
        const sigs = this.functions.get(name);
        if (!sigs) return undefined;

        // Find exact match by parameter count
        const match = sigs.find(s => s.parameters.length === argCount);
        if (match) return match;

        // For builtins with empty params, return the first one
        const builtin = sigs.find(s => s.isBuiltin && s.parameters.length === 0);
        if (builtin) return builtin;

        return undefined;
    }

    /**
     * Look up a function overload by name and parameter types
     *
     * Returns the signature that matches the given parameter types exactly,
     * or falls back to count-based matching if no exact type match exists.
     */
    lookupFunctionOverloadByTypes(name: string, paramTypes: TypeInfo[]): FunctionSignature | undefined {
        const sigs = this.functions.get(name);
        if (!sigs) return undefined;

        // Find exact match by parameter types
        const exactMatch = sigs.find(s => {
            if (s.parameters.length !== paramTypes.length) return false;
            for (let i = 0; i < s.parameters.length; i++) {
                if (s.parameters[i].type.name !== paramTypes[i].name) return false;
                if (s.parameters[i].type.isArray !== paramTypes[i].isArray) return false;
                if (s.parameters[i].type.isPointer !== paramTypes[i].isPointer) return false;
            }
            return true;
        });
        if (exactMatch) return exactMatch;

        // Compatible match: find overloads where types are compatible (e.g. int→float)
        // Pick the one with the most exact argument type matches
        const numericTypes = new Set(['int', 'uint', 'float', 'double', 'half', 'bool']);
        let bestMatch: FunctionSignature | undefined;
        let bestExactCount = -1;

        for (const sig of sigs) {
            if (sig.parameters.length !== paramTypes.length) continue;
            let compatible = true;
            let exactCount = 0;
            for (let i = 0; i < sig.parameters.length; i++) {
                const paramName = sig.parameters[i].type.name;
                const argName = paramTypes[i].name;
                if (paramName === argName) {
                    exactCount++;
                } else if (numericTypes.has(paramName) && numericTypes.has(argName)) {
                    // Numeric types are compatible (int↔float, etc.)
                } else {
                    compatible = false;
                    break;
                }
            }
            if (compatible && exactCount > bestExactCount) {
                bestExactCount = exactCount;
                bestMatch = sig;
            }
        }
        if (bestMatch) return bestMatch;

        // Fall back to count-based matching
        return this.lookupFunctionOverload(name, paramTypes.length);
    }

    /**
     * Get all overloads for a function
     */
    getFunctionOverloads(name: string): FunctionSignature[] {
        return this.functions.get(name) || [];
    }

    /**
     * Check if a function is defined
     */
    hasFunction(name: string): boolean {
        return this.functions.has(name);
    }

    /**
     * Get all defined functions (flattened)
     */
    getAllFunctions(): FunctionSignature[] {
        const result: FunctionSignature[] = [];
        for (const sigs of this.functions.values()) {
            result.push(...sigs);
        }
        return result;
    }

    // =========================================================================
    // Struct Management
    // =========================================================================

    /**
     * Define a struct
     */
    defineStruct(info: StructInfo): boolean {
        if (this.structs.has(info.name)) {
            return false;
        }
        this.structs.set(info.name, info);
        return true;
    }

    /**
     * Look up a struct by name
     */
    lookupStruct(name: string): StructInfo | undefined {
        // Handle 'struct TypeName' syntax (C-style struct reference)
        const actualName = name.startsWith('struct ') ? name.slice(7) : name;
        return this.structs.get(actualName);
    }

    /**
     * Check if a struct is defined
     */
    hasStruct(name: string): boolean {
        // Handle 'struct TypeName' syntax (C-style struct reference)
        const actualName = name.startsWith('struct ') ? name.slice(7) : name;
        return this.structs.has(actualName);
    }

    /**
     * Get all defined structs
     */
    getAllStructs(): StructInfo[] {
        return Array.from(this.structs.values());
    }

    // =========================================================================
    // Typedef Management
    // =========================================================================

    /**
     * Define a typedef
     */
    defineTypedef(name: string, type: TypeInfo): boolean {
        if (this.typedefs.has(name)) {
            return false;
        }
        this.typedefs.set(name, type);
        return true;
    }

    /**
     * Look up a typedef by name
     */
    lookupTypedef(name: string): TypeInfo | undefined {
        return this.typedefs.get(name);
    }

    /**
     * Resolve a type name (following typedef chain)
     */
    resolveType(name: string): string {
        const typedef = this.typedefs.get(name);
        if (typedef) {
            return this.resolveType(typedef.name);
        }
        return name;
    }

    /**
     * Check if a type name is valid (primitive, vector, struct, or typedef)
     */
    isValidType(name: string): boolean {
        // Primitive types
        const primitives = [
            'void', 'int', 'uint', 'float', 'double', 'half', 'bool',
            'char', 'short', 'long', 'unsigned', 'signed',
            'ushort', 'uchar', 'ulong', 'size_t', 'ptrdiff_t',
            // Compound integer types (C-style)
            'unsigned int', 'unsigned long', 'unsigned long long',
            'unsigned short', 'unsigned char',
            'signed int', 'signed long', 'signed long long',
            'signed short', 'signed char',
            'long long',
        ];
        if (primitives.includes(name)) {
            return true;
        }

        // Vector types
        if (DCTL_VECTOR_TYPES.includes(name as any)) {
            return true;
        }

        // Additional vector types not in DCTL_VECTOR_TYPES
        const additionalVectorTypes = [
            'half2', 'half3', 'half4',
            'uint2', 'uint3', 'uint4',
            'short2', 'short3', 'short4',
            'ushort2', 'ushort3', 'ushort4',
            'char2', 'char3', 'char4',
            'uchar2', 'uchar3', 'uchar4',
        ];
        if (additionalVectorTypes.includes(name)) {
            return true;
        }

        // Matrix types
        const matrixTypes = [
            'mat2', 'mat3', 'mat4',
            'float2x2', 'float3x3', 'float4x4',
        ];
        if (matrixTypes.includes(name)) {
            return true;
        }

        // Struct types
        if (this.structs.has(name)) {
            return true;
        }

        // Handle 'struct TypeName' syntax (C-style struct reference)
        if (name.startsWith('struct ')) {
            const structName = name.slice(7); // Remove 'struct ' prefix
            if (this.structs.has(structName)) {
                return true;
            }
        }

        // Typedef types
        if (this.typedefs.has(name)) {
            return true;
        }

        // DCTL special types
        const dctlTypes = ['__TEXTURE__', '__TEXTURE2D__', '__TEXTURE3D__', '__CONSTANTREF__'];
        if (dctlTypes.includes(name)) {
            return true;
        }

        return false;
    }

    // =========================================================================
    // Builtin Registration
    // =========================================================================

    /**
     * Register all builtin functions and constants
     */
    private registerBuiltins(): void {
        this.registerBuiltinFunctions();
        this.registerBuiltinConstants();
        this.registerBuiltinTypes();
    }

    /**
     * Register builtin functions
     */
    private registerBuiltinFunctions(): void {
        const dummyLoc: SourceLocation = { line: 0, column: 0 };

        // Generic return type for most functions
        const floatType: TypeInfo = {
            name: 'float',
            isArray: false,
            isPointer: false,
            isConst: false,
            isVoid: false,
        };

        const float3Type: TypeInfo = {
            name: 'float3',
            isArray: false,
            isPointer: false,
            isConst: false,
            isVoid: false,
        };

        const float2Type: TypeInfo = {
            name: 'float2',
            isArray: false,
            isPointer: false,
            isConst: false,
            isVoid: false,
        };

        const float4Type: TypeInfo = {
            name: 'float4',
            isArray: false,
            isPointer: false,
            isConst: false,
            isVoid: false,
        };

        const intType: TypeInfo = {
            name: 'int',
            isArray: false,
            isPointer: false,
            isConst: false,
            isVoid: false,
        };

        const int2Type: TypeInfo = {
            name: 'int2',
            isArray: false,
            isPointer: false,
            isConst: false,
            isVoid: false,
        };

        const int3Type: TypeInfo = {
            name: 'int3',
            isArray: false,
            isPointer: false,
            isConst: false,
            isVoid: false,
        };

        const int4Type: TypeInfo = {
            name: 'int4',
            isArray: false,
            isPointer: false,
            isConst: false,
            isVoid: false,
        };

        // Matrix types
        const mat3Type: TypeInfo = {
            name: 'mat3',
            isArray: false,
            isPointer: false,
            isConst: false,
            isVoid: false,
        };

        const mat4Type: TypeInfo = {
            name: 'mat4',
            isArray: false,
            isPointer: false,
            isConst: false,
            isVoid: false,
        };

        // Register all builtin functions from the list
        for (const name of DCTL_BUILTIN_FUNCTIONS) {
            // Determine return type based on function name
            let returnType = floatType;
            if (name.startsWith('make_float3') || name === 'cross') {
                returnType = float3Type;
            } else if (name.startsWith('make_float4')) {
                returnType = float4Type;
            } else if (name.startsWith('make_float2')) {
                returnType = float2Type;
            } else if (name.startsWith('make_int2')) {
                returnType = int2Type;
            } else if (name.startsWith('make_int3')) {
                returnType = int3Type;
            } else if (name.startsWith('make_int4')) {
                returnType = int4Type;
            } else if (name.startsWith('make_int') || name === '__clz' || name === '__popc') {
                returnType = intType;
            } else if (name === 'isinf' || name === 'isnan' || name === 'signbit') {
                returnType = intType; // Returns bool as int
            // Matrix multiplication and operations - proper return types
            } else if (name === 'mult_f3_f33') {
                returnType = float3Type; // float3 * mat3 -> float3
            } else if (name === 'mult_f3_f44') {
                returnType = float4Type; // float3/4 * mat4 -> float4
            } else if (name === 'mult_f33_f33' || name === 'invert_f33' || name === 'transpose_f33' || name === 'identity_f33') {
                returnType = mat3Type;
            } else if (name === 'mult_f44_f44' || name === 'invert_f44' || name === 'transpose_f44' || name === 'identity_f44') {
                returnType = mat4Type;
            }

            this.functions.set(name, [{
                name,
                returnType,
                parameters: [],
                loc: dummyLoc,
                isBuiltin: true,
            }]);
        }

        // Additional builtin functions not in the list
        const additionalBuiltins: Array<{ name: string; returnType: TypeInfo }> = [
            // Matrix constructors
            { name: 'mat3', returnType: mat3Type },
            { name: 'mat4', returnType: mat4Type },
            { name: 'float3x3', returnType: mat3Type },
            { name: 'float4x4', returnType: mat4Type },

            // Additional GLSL-style functions
            { name: 'smoothstep', returnType: floatType },
            { name: '_smoothstep', returnType: floatType },

            // Vector length/distance
            { name: 'length', returnType: floatType },
            { name: 'distance', returnType: floatType },
            { name: 'normalize', returnType: float3Type },
            { name: 'reflect', returnType: float3Type },
            { name: 'refract', returnType: float3Type },

            // Additional math functions
            { name: 'pow', returnType: floatType },
            { name: 'sin', returnType: floatType },
            { name: 'cos', returnType: floatType },
            { name: 'tan', returnType: floatType },
            { name: 'asin', returnType: floatType },
            { name: 'acos', returnType: floatType },
            { name: 'atan', returnType: floatType },
            { name: 'sqrt', returnType: floatType },
            { name: 'log', returnType: floatType },
            { name: 'log2', returnType: floatType },
            { name: 'exp', returnType: floatType },
            { name: 'exp2', returnType: floatType },
            { name: 'floor', returnType: floatType },
            { name: 'ceil', returnType: floatType },
            { name: 'round', returnType: floatType },
            { name: '_floor', returnType: floatType },
            { name: '_ceil', returnType: floatType },
            { name: '_round', returnType: floatType },
            { name: 'trunc', returnType: floatType },
            { name: 'truncf', returnType: floatType },
            { name: '_trunc', returnType: floatType },
            { name: 'fmod', returnType: floatType },
            { name: 'fmax', returnType: floatType },
            { name: 'fmin', returnType: floatType },
            { name: 'fabs', returnType: floatType },

            // CUDA-style functions (f suffix) - compatibility extensions
            { name: 'powf', returnType: floatType },
            { name: 'expf', returnType: floatType },
            { name: 'logf', returnType: floatType },
            { name: 'sqrtf', returnType: floatType },
            { name: 'fabsf', returnType: floatType },
            { name: 'floorf', returnType: floatType },
            { name: 'ceilf', returnType: floatType },
            { name: 'sinf', returnType: floatType },
            { name: 'cosf', returnType: floatType },
            { name: 'tanf', returnType: floatType },
            { name: 'asinf', returnType: floatType },
            { name: 'acosf', returnType: floatType },
            { name: 'atanf', returnType: floatType },
            { name: 'atan2f', returnType: floatType },
            { name: 'roundf', returnType: floatType },
            { name: 'signf', returnType: floatType },
            { name: 'fminf', returnType: floatType },
            { name: 'fmaxf', returnType: floatType },

            // Hyperbolic functions (without prefix) - compatibility extensions
            { name: 'sinh', returnType: floatType },
            { name: 'cosh', returnType: floatType },
            { name: 'tanh', returnType: floatType },
            { name: 'asinh', returnType: floatType },
            { name: 'acosh', returnType: floatType },
            { name: 'atanh', returnType: floatType },

            // Other compatibility extensions
            { name: '_signf', returnType: floatType },
            { name: '_mixf', returnType: floatType },
            { name: 'atan2', returnType: floatType },
            { name: 'fract', returnType: floatType },
            { name: '_fract', returnType: floatType },
            { name: 'sign', returnType: floatType },
            { name: 'abs', returnType: floatType },
            { name: 'saturate', returnType: floatType },
            { name: 'rsqrt', returnType: floatType },
            { name: 'cbrt', returnType: floatType },
            { name: 'log10', returnType: floatType },

            // DCTL uppercase macros (element-wise, type inferred from argument)
            { name: 'SIN', returnType: floatType },
            { name: 'COS', returnType: floatType },
            { name: 'TAN', returnType: floatType },
            { name: 'ASIN', returnType: floatType },
            { name: 'ACOS', returnType: floatType },
            { name: 'ATAN', returnType: floatType },
            { name: 'ATAN2', returnType: floatType },
            { name: 'SINH', returnType: floatType },
            { name: 'COSH', returnType: floatType },
            { name: 'TANH', returnType: floatType },
            { name: 'ASINH', returnType: floatType },
            { name: 'ACOSH', returnType: floatType },
            { name: 'ATANH', returnType: floatType },
            { name: 'POW', returnType: floatType },
            { name: 'SQRT', returnType: floatType },
            { name: 'RSQRT', returnType: floatType },
            { name: 'CBRT', returnType: floatType },
            { name: 'EXP', returnType: floatType },
            { name: 'EXP2', returnType: floatType },
            { name: 'LOG', returnType: floatType },
            { name: 'LOG2', returnType: floatType },
            { name: 'LOG10', returnType: floatType },
            { name: 'FLOOR', returnType: floatType },
            { name: 'CEIL', returnType: floatType },
            { name: 'ROUND', returnType: floatType },
            { name: 'TRUNC', returnType: floatType },
            { name: 'FRACT', returnType: floatType },
            { name: 'ABS', returnType: floatType },
            { name: 'FABS', returnType: floatType },
            { name: 'SIGN', returnType: floatType },
            { name: 'SATURATE', returnType: floatType },
            { name: 'MIN', returnType: floatType },
            { name: 'MAX', returnType: floatType },
            { name: 'FMIN', returnType: floatType },
            { name: 'FMAX', returnType: floatType },
            { name: 'FMOD', returnType: floatType },
            { name: 'COPYSIGN', returnType: floatType },

            // Vector conversion helpers
            { name: 'to_float2', returnType: { name: 'float2', isArray: false, isPointer: false, isConst: false, isVoid: false } },
            { name: 'to_float3', returnType: float3Type },
            { name: 'to_float4', returnType: float4Type },
        ];

        for (const { name, returnType } of additionalBuiltins) {
            if (!this.functions.has(name)) {
                this.functions.set(name, [{
                    name,
                    returnType,
                    parameters: [],
                    loc: dummyLoc,
                    isBuiltin: true,
                }]);
            }
        }
    }

    /**
     * Register builtin constants
     */
    private registerBuiltinConstants(): void {
        const dummyLoc: SourceLocation = { line: 0, column: 0 };

        const intType: TypeInfo = {
            name: 'int',
            isArray: false,
            isPointer: false,
            isConst: true,
            isVoid: false,
        };

        const floatType: TypeInfo = {
            name: 'float',
            isArray: false,
            isPointer: false,
            isConst: true,
            isVoid: false,
        };

        for (const name of DCTL_GLOBAL_CONSTANTS) {
            // TRANSITION_PROGRESS is float, others are int
            const type = name === 'TRANSITION_PROGRESS' ? floatType : intType;

            const symbol: Symbol = {
                name,
                kind: 'constant',
                type,
                loc: dummyLoc,
                isConst: true,
                isBuiltin: true,
            };

            this.scopeManager.defineGlobal(symbol);
        }
    }

    /**
     * Register builtin types (vector types as available)
     */
    private registerBuiltinTypes(): void {
        // Vector types are already handled in isValidType
        // No additional registration needed
    }

    // =========================================================================
    // Reset
    // =========================================================================

    /**
     * Reset the symbol table to initial state
     */
    reset(): void {
        this.scopeManager.reset();
        this.functions.clear();
        this.structs.clear();
        this.typedefs.clear();
        this.registerBuiltins();
    }
}
