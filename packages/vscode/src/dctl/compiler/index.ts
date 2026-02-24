/**
 * DCTL Compiler WASM Wrapper
 *
 * Provides direct DCTL to WGSL compilation using the Rust-based dctl-compiler.
 * This bypasses the traditional DCTL → GLSL → WGSL pipeline for improved accuracy.
 */

import * as path from 'path';
import * as fs from 'fs';

import { collectIncludes, collectIncludesSync, IncludeMap, PreprocessOptions } from './preprocessor';
import { DctlParser } from '../parser';
import { preprocessDctl } from '../parser';
import { convertAstToRustFormat, formatWgslLimitationMessage } from '@dctl-workbench/core';

// Re-export preprocessor types
export { IncludeMap, PreprocessOptions };

// Re-export compiler types from core
export {
    DiagnosticSeverity,
    CompilerDiagnostic,
    ParameterType,
    CompilerParameter,
    CompileResult,
    CompileError,
    ValidationResult,
    isCompileError,
    convertAstToRustFormat,
} from '@dctl-workbench/core';

// Import types for local use
import type {
    CompileResult,
    CompileError,
    CompilerDiagnostic,
    CompilerParameter,
    ValidationResult,
} from '@dctl-workbench/core';

// Type definitions for the WASM module
interface DctlCompilerModule {
    init(): void;
    parse_dctl(source: string): string;
    analyze_dctl(source: string): string;
    compile_dctl(source: string): string;
    compile_dctl_with_includes(source: string, includes_json: string): string;
    compile_from_ast(ast_json: string): string;
    validate_dctl(source: string): string;
    validate_from_ast(ast_json: string): string;
    get_version(): string;
}

/**
 * DCTL Compiler for direct DCTL to WGSL compilation
 */
export class DctlCompiler {
    private module: DctlCompilerModule | null = null;
    private initPromise: Promise<void> | null = null;

    /**
     * Initialize the dctl-compiler WASM module
     * @param extensionPath Path to the extension directory
     */
    async init(extensionPath: string): Promise<void> {
        if (this.module) {
            return;
        }

        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = this.loadModule(extensionPath);
        return this.initPromise;
    }

    private async loadModule(extensionPath: string): Promise<void> {
        // Try multiple possible locations for wasm files
        const possiblePaths = [
            path.join(extensionPath, 'wasm', 'dctl-compiler'),           // Development
            path.join(extensionPath, 'out', 'wasm', 'dctl-compiler'),    // Compiled output
        ];

        let jsPath = '';
        let wasmPath = '';

        for (const basePath of possiblePaths) {
            const testWasm = path.join(basePath, 'dctl_compiler_bg.wasm');
            const testJs = path.join(basePath, 'dctl_compiler.js');
            if (fs.existsSync(testWasm) && fs.existsSync(testJs)) {
                jsPath = testJs;
                wasmPath = testWasm;
                break;
            }
        }

        if (!jsPath || !wasmPath) {
            throw new Error(`DCTL Compiler WASM files not found in any of: ${possiblePaths.join(', ')}`);
        }

        // For Node.js target, require the module (auto-loads WASM on require)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const dctlCompilerJs = require(jsPath);

        // Initialize panic hook for better error messages
        if (typeof dctlCompilerJs.init === 'function') {
            dctlCompilerJs.init();
        }

        this.module = dctlCompilerJs as DctlCompilerModule;
    }

    /**
     * Check if the module is initialized
     */
    get isInitialized(): boolean {
        return this.module !== null;
    }

    /**
     * Get compiler version
     */
    getVersion(): string {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }
        return this.module.get_version();
    }

    /**
     * Parse DCTL source code and return AST as JSON
     * @param source DCTL source code
     * @returns AST as JSON string
     */
    parse(source: string): string {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }
        return this.module.parse_dctl(source);
    }

    /**
     * Analyze DCTL source code and return diagnostics
     * @param source DCTL source code
     * @returns Diagnostics as JSON string
     */
    analyze(source: string): string {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }
        return this.module.analyze_dctl(source);
    }

    /**
     * Compile DCTL source code to WGSL
     *
     * NOTE: For WASM builds, this uses the TypeScript parser to parse DCTL
     * and then converts the AST to Rust format for compilation.
     *
     * @param source DCTL source code
     * @returns Compilation result with WGSL code and metadata
     */
    compile(source: string): CompileResult | CompileError {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }

        // Use TypeScript parser since WASM build doesn't have native-parser feature
        return this.compileWithTsParser(source);
    }

    /**
     * Compile DCTL using TypeScript parser + Rust codegen
     *
     * This method:
     * 1. Preprocesses the source (macro expansion)
     * 2. Parses with TypeScript DCTL parser
     * 3. Filters out header declarations
     * 4. Converts AST to Rust format
     * 5. Compiles via Rust WASM backend
     *
     * @param source DCTL source code
     * @returns Compilation result with WGSL code and metadata
     */
    compileWithTsParser(source: string): CompileResult | CompileError {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }

        try {
            // Step 1: Preprocess the source (adds type definitions for parsing)
            const preprocessResult = preprocessDctl(source);

            // Step 2: Parse with TypeScript parser
            const parser = new DctlParser();
            const parseResult = parser.parse(preprocessResult.code);

            // Note: We allow some parse errors for the header typedefs
            // but still try to compile if we have an AST

            if (!parseResult.ast) {
                return {
                    error: true,
                    message: parseResult.errors.length > 0
                        ? `Parse errors: ${parseResult.errors.map(e => e.message).join(', ')}`
                        : 'Parse failed: no AST produced'
                };
            }

            // Step 3: Filter out header declarations (those from the auto-generated type defs)
            // Header declarations come before the original source (line < headerLineCount)
            // Note: headerLineCount is split('\n').length which includes trailing empty string,
            // so user code starts at line >= headerLineCount (not > headerLineCount)
            const headerLineCount = preprocessResult.headerLineCount;
            const filteredDeclarations = parseResult.ast.declarations.filter(decl => {
                // Keep declarations that come from after the header
                return decl.loc.line >= headerLineCount;
            });

            // Create a new AST with filtered declarations
            const filteredAst = {
                ...parseResult.ast,
                declarations: filteredDeclarations
            };

            // Step 4: Convert to Rust AST format
            // Note: We don't pass UI params here because preprocessDctl already converted
            // DEFINE_UI_PARAMS macros to variable declarations (e.g., "float g_red;")
            // These are parsed as regular variables, not uniform buffer members
            // This allows the variables to be modified in the transform function
            const conversionResult = convertAstToRustFormat(filteredAst);

            // If there are conversion warnings (unsupported syntax), return them as errors
            // These are features that may work in DaVinci Resolve but cannot compile to WGSL
            if (conversionResult.warnings.length > 0) {
                return {
                    error: true,
                    message: conversionResult.warnings.map(w => w.message).join('\n'),
                };
            }

            // Step 5: Compile via Rust backend
            const resultJson = this.module.compile_from_ast(conversionResult.json);
            const result = JSON.parse(resultJson);

            // Check if the result is an error from the Rust backend
            if (result.error) {
                result.message = formatWgslLimitationMessage(result.message);
                return result as CompileError;
            }

            // Step 6: Adjust diagnostic line numbers to remove DCTL_TYPE_DEFINITIONS header offset
            // The TS parser produces AST nodes with line numbers that include the prepended header.
            // The Rust backend returns diagnostics using those inflated line numbers.
            // We subtract (headerLineCount - 1) so diagnostics map back to the original source.
            if (result.diagnostics) {
                for (const diag of result.diagnostics) {
                    diag.line = Math.max(1, diag.line - (headerLineCount - 1));
                }
            }

            return result;
        } catch (err) {
            return {
                error: true,
                message: `Compilation failed: ${err instanceof Error ? err.message : String(err)}`
            };
        }
    }

    /**
     * Compile DCTL from pre-parsed AST JSON
     * @param astJson Pre-parsed AST as JSON string
     * @returns Compilation result with WGSL code and metadata
     */
    compileFromAst(astJson: string): CompileResult | CompileError {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }

        const resultJson = this.module.compile_from_ast(astJson);
        return JSON.parse(resultJson);
    }

    /**
     * Validate DCTL source code
     * @param source DCTL source code
     * @returns Validation result
     */
    validate(source: string): ValidationResult {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }

        const resultJson = this.module.validate_dctl(source);
        return JSON.parse(resultJson);
    }

    /**
     * Validate DCTL from pre-parsed AST JSON
     * @param astJson Pre-parsed AST as JSON string
     * @returns Validation result
     */
    validateFromAst(astJson: string): ValidationResult {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }

        const resultJson = this.module.validate_from_ast(astJson);
        return JSON.parse(resultJson);
    }

    /**
     * Compile DCTL source code with include resolution
     * @param source DCTL source code
     * @param options Compilation options including include directories
     * @returns Compilation result with WGSL code and metadata
     */
    async compileWithIncludes(
        source: string,
        options: {
            includeDirs?: string[];
            mainFilePath?: string;
        } = {}
    ): Promise<CompileResult | CompileError> {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }

        try {
            // Step 1: Collect all include files
            const { includes } = await collectIncludes(source, {
                includeDirs: options.includeDirs ?? [],
                mainFilePath: options.mainFilePath,
            });

            // Step 2: Resolve includes inline (simple approach)
            let resolvedSource = source;
            for (const [includePath, content] of Object.entries(includes)) {
                // Replace #include "path" with the content
                const includeRegex = new RegExp(`#include\\s*"${includePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
                resolvedSource = resolvedSource.replace(includeRegex, content);
            }

            // Step 3: Compile the resolved source
            return this.compileWithTsParser(resolvedSource);
        } catch (err) {
            return {
                error: true,
                message: `Compilation with includes failed: ${err instanceof Error ? err.message : String(err)}`
            };
        }
    }

    /**
     * Compile DCTL source code with include resolution (synchronous)
     * @param source DCTL source code
     * @param options Compilation options including include directories
     * @returns Compilation result with WGSL code and metadata
     */
    compileWithIncludesSync(
        source: string,
        options: {
            includeDirs?: string[];
            mainFilePath?: string;
        } = {}
    ): CompileResult | CompileError {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }

        try {
            // Step 1: Collect all include files synchronously
            const { includes } = collectIncludesSync(source, {
                includeDirs: options.includeDirs ?? [],
                mainFilePath: options.mainFilePath,
            });

            // Step 2: Resolve includes inline
            let resolvedSource = source;
            for (const [includePath, content] of Object.entries(includes)) {
                const includeRegex = new RegExp(`#include\\s*"${includePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
                resolvedSource = resolvedSource.replace(includeRegex, content);
            }

            // Step 3: Compile the resolved source
            return this.compileWithTsParser(resolvedSource);
        } catch (err) {
            return {
                error: true,
                message: `Compilation with includes failed: ${err instanceof Error ? err.message : String(err)}`
            };
        }
    }
}

// Singleton instance
let compilerInstance: DctlCompiler | null = null;

/**
 * Get the singleton DctlCompiler instance
 */
export function getDctlCompiler(): DctlCompiler {
    if (!compilerInstance) {
        compilerInstance = new DctlCompiler();
    }
    return compilerInstance;
}

/**
 * Convert CompilerParameter to the format used by the TypeScript transpiler
 */
export function convertParameter(param: CompilerParameter): {
    name: string;
    label: string;
    type: string;
    default: number | boolean;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
} {
    const baseParam = {
        name: param.name,
        label: param.label,
    };

    switch (param.param_type.type) {
        case 'float':
            return {
                ...baseParam,
                type: 'DCTLUI_SLIDER_FLOAT',
                default: param.param_type.default,
                min: param.param_type.min,
                max: param.param_type.max,
                step: param.param_type.step,
            };
        case 'int':
            return {
                ...baseParam,
                type: 'DCTLUI_SLIDER_INT',
                default: param.param_type.default,
                min: param.param_type.min,
                max: param.param_type.max,
                step: param.param_type.step,
            };
        case 'bool':
            return {
                ...baseParam,
                type: 'DCTLUI_CHECK_BOX',
                default: param.param_type.default,
            };
        case 'combo':
            return {
                ...baseParam,
                type: 'DCTLUI_COMBO_BOX',
                default: param.param_type.default,
                options: param.param_type.options,
            };
    }
}
