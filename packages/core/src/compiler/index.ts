/**
 * DCTL Compiler Module
 *
 * Provides DCTL to WGSL compilation using the Rust-based dctl-compiler WASM.
 */

import * as path from 'path';
import * as fs from 'fs';
import type {
    CompileResult,
    CompileError,
    ValidationResult,
    CompilerParameter,
} from '../types/index.js';

// Import parser modules directly
import { DctlParser } from '../parser/dctlParser.js';
import { preprocessDctl } from '../parser/dctlPreprocessor.js';
import { convertAstToRustFormat } from './astConverter.js';
import { extractUIParams, convertToCompilerParameter } from '../parser/uiParamExtractor.js';

// Re-export types
export type {
    CompileResult,
    CompileError,
    ValidationResult,
    CompilerParameter,
    CompilerDiagnostic,
    DiagnosticSeverity,
    ParameterType,
} from '../types/index.js';
export { isCompileError } from '../types/index.js';

// Re-export AST converter for external use
export { convertAstToRustFormat } from './astConverter.js';

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
 * Include file map
 */
export type IncludeMap = Record<string, string>;

/**
 * Preprocess options
 */
export interface PreprocessOptions {
    includeDirs?: string[];
    mainFilePath?: string;
}

/**
 * DCTL Compiler for direct DCTL to WGSL compilation
 */
export class DctlCompiler {
    private module: DctlCompilerModule | null = null;
    private initPromise: Promise<void> | null = null;

    /**
     * Initialize the dctl-compiler WASM module
     * @param wasmPath Path to the WASM files directory
     */
    async init(wasmPath: string): Promise<void> {
        if (this.module) {
            return;
        }

        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = this.loadModule(wasmPath);
        return this.initPromise;
    }

    private async loadModule(basePath: string): Promise<void> {
        // Try multiple possible locations for wasm files
        const possiblePaths = [
            path.join(basePath, 'wasm', 'dctl-compiler'),
            path.join(basePath, 'out', 'wasm', 'dctl-compiler'),
            path.join(basePath, 'dctl-compiler'),
        ];

        let jsPath = '';
        let wasmPath = '';

        for (const testPath of possiblePaths) {
            const testWasm = path.join(testPath, 'dctl_compiler_bg.wasm');
            const testJs = path.join(testPath, 'dctl_compiler.js');
            if (fs.existsSync(testWasm) && fs.existsSync(testJs)) {
                jsPath = testJs;
                wasmPath = testWasm;
                break;
            }
        }

        if (!jsPath || !wasmPath) {
            throw new Error(`DCTL Compiler WASM files not found in any of: ${possiblePaths.join(', ')}`);
        }

        // Load the module
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const dctlCompilerJs = require(jsPath);

        // Handle different wasm-pack output formats:
        // - Older builds: require initSync(wasmBuffer) to initialize
        // - Newer builds (nodejs target): auto-load when required
        if (typeof dctlCompilerJs.initSync === 'function') {
            // Older wasm-pack build - needs manual initialization
            const wasmBuffer = fs.readFileSync(wasmPath);
            dctlCompilerJs.initSync(wasmBuffer);
        }
        // else: Module auto-loaded when required (nodejs target)

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
     */
    parse(source: string): string {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }
        return this.module.parse_dctl(source);
    }

    /**
     * Analyze DCTL source code and return diagnostics
     */
    analyze(source: string): string {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }
        return this.module.analyze_dctl(source);
    }

    /**
     * Compile DCTL source code to WGSL
     * @param source DCTL source code
     * @param options Optional compilation options
     * @param options.mainFilePath Path to the main DCTL file (enables #include resolution)
     * @param options.includeDirs Additional directories to search for #include files
     */
    compile(source: string, options?: PreprocessOptions): CompileResult | CompileError {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }

        // Resolve #include directives if file path is provided
        let resolvedSource = source;
        if (options?.mainFilePath || options?.includeDirs) {
            resolvedSource = this.resolveIncludesSync(source, options);
        }

        // Use TypeScript parser + Rust backend
        return this.compileWithTsParser(resolvedSource);
    }

    /**
     * Compile DCTL using TypeScript parser + Rust codegen
     */
    private compileWithTsParser(source: string): CompileResult | CompileError {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }

        try {
            // Step 0: Extract UI parameters BEFORE preprocessing
            // (DEFINE_UI_PARAMS macros are removed during preprocessing)
            const uiParamsResult = extractUIParams(source);
            const extractedParams = uiParamsResult.params.map(convertToCompilerParameter);

            // Step 1: Preprocess the source
            const preprocessResult = preprocessDctl(source);

            // Step 2: Parse with TypeScript parser
            const parser = new DctlParser();
            const parseResult = parser.parse(preprocessResult.code);

            if (!parseResult.ast) {
                return {
                    error: true,
                    message: parseResult.errors.length > 0
                        ? `Parse errors: ${parseResult.errors.map((e: any) => e.message).join(', ')}`
                        : 'Parse failed: no AST produced'
                };
            }

            // Step 3: Filter out header declarations
            const headerLineCount = preprocessResult.headerLineCount;
            const filteredDeclarations = parseResult.ast.declarations.filter((decl: any) => {
                return decl.loc.line >= headerLineCount;
            });

            const filteredAst = {
                ...parseResult.ast,
                declarations: filteredDeclarations
            };

            // Step 4: Convert to Rust AST format
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

            const compileResult = result as CompileResult;

            // Step 6: Merge extracted UI parameters into the result
            // Use extracted params if Rust backend didn't return any
            if (compileResult.parameters.length === 0 && extractedParams.length > 0) {
                compileResult.parameters = extractedParams as CompilerParameter[];
            }

            return compileResult;
        } catch (err) {
            return {
                error: true,
                message: `Compilation failed: ${err instanceof Error ? err.message : String(err)}`
            };
        }
    }

    /**
     * Compile DCTL from pre-parsed AST JSON
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
     */
    async compileWithIncludes(
        source: string,
        options: PreprocessOptions = {}
    ): Promise<CompileResult | CompileError> {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }

        try {
            // Collect and resolve includes
            const resolvedSource = await this.resolveIncludes(source, options);

            // Compile the resolved source
            return this.compile(resolvedSource);
        } catch (err) {
            return {
                error: true,
                message: `Compilation with includes failed: ${err instanceof Error ? err.message : String(err)}`
            };
        }
    }

    /**
     * Compile DCTL source code with include resolution (synchronous)
     */
    compileWithIncludesSync(
        source: string,
        options: PreprocessOptions = {}
    ): CompileResult | CompileError {
        if (!this.module) {
            throw new Error('DCTL Compiler module not initialized');
        }

        try {
            // Collect and resolve includes synchronously
            const resolvedSource = this.resolveIncludesSync(source, options);

            // Compile the resolved source
            return this.compile(resolvedSource);
        } catch (err) {
            return {
                error: true,
                message: `Compilation with includes failed: ${err instanceof Error ? err.message : String(err)}`
            };
        }
    }

    /**
     * Resolve include directives in source
     */
    private async resolveIncludes(source: string, options: PreprocessOptions): Promise<string> {
        const includeRegex = /#include\s*"([^"]+)"/g;
        let resolvedSource = source;
        let match;

        while ((match = includeRegex.exec(source)) !== null) {
            const includePath = match[1];
            const content = await this.findIncludeFile(includePath, options);
            if (content) {
                resolvedSource = resolvedSource.replace(match[0], content);
            }
        }

        return resolvedSource;
    }

    /**
     * Resolve include directives synchronously
     */
    private resolveIncludesSync(source: string, options: PreprocessOptions): string {
        const includeRegex = /#include\s*"([^"]+)"/g;
        let resolvedSource = source;
        let match;

        while ((match = includeRegex.exec(source)) !== null) {
            const includePath = match[1];
            const content = this.findIncludeFileSync(includePath, options);
            if (content) {
                resolvedSource = resolvedSource.replace(match[0], content);
            }
        }

        return resolvedSource;
    }

    /**
     * Find and read an include file
     */
    private async findIncludeFile(includePath: string, options: PreprocessOptions): Promise<string | null> {
        const searchDirs = options.includeDirs || [];
        if (options.mainFilePath) {
            searchDirs.unshift(path.dirname(options.mainFilePath));
        }

        for (const dir of searchDirs) {
            const fullPath = path.join(dir, includePath);
            try {
                return await fs.promises.readFile(fullPath, 'utf-8');
            } catch {
                // File not found, try next directory
            }
        }

        return null;
    }

    /**
     * Find and read an include file synchronously
     */
    private findIncludeFileSync(includePath: string, options: PreprocessOptions): string | null {
        const searchDirs = options.includeDirs || [];
        if (options.mainFilePath) {
            searchDirs.unshift(path.dirname(options.mainFilePath));
        }

        for (const dir of searchDirs) {
            const fullPath = path.join(dir, includePath);
            try {
                return fs.readFileSync(fullPath, 'utf-8');
            } catch {
                // File not found, try next directory
            }
        }

        return null;
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
 * Convert CompilerParameter to legacy format
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

// =============================================================================
// WGSL Limitation Error Message Formatting
// =============================================================================

const WGSL_SUFFIX = 'The code may work in DaVinci Resolve (CUDA/Metal).';

interface ErrorRule {
    pattern: RegExp;
    format: (match: RegExpMatchArray) => string;
}

const WGSL_ERROR_RULES: ErrorRule[] = [
    // Cast to struct type
    {
        pattern: /Unsupported.*cast target type:.*Struct\("([^"]+)"\)/,
        format: (m) => `Cast to struct type '${m[1]}' is not supported in WGSL. ${WGSL_SUFFIX}`,
    },
    // Cast to pointer type
    {
        pattern: /Unsupported.*cast target type:.*Pointer/,
        format: () => `Cast to pointer type is not supported in WGSL. ${WGSL_SUFFIX}`,
    },
    // Cast to other unsupported types (array, etc.)
    {
        pattern: /Unsupported.*cast target type:\s*(.+)/,
        format: (m) => `Cast to type '${m[1].trim()}' is not supported in WGSL. ${WGSL_SUFFIX}`,
    },
    // Double pointer / InvalidSubAccess (Naga validation)
    {
        pattern: /WGSL generation failed:.*InvalidSubAccess/,
        format: () => `Double pointer (pointer-to-pointer) access is not supported in WGSL. ${WGSL_SUFFIX}`,
    },
    // Pointer local variable without initializer
    {
        pattern: /Pointer local variable.*not supported/i,
        format: () => `Pointer local variables without initializer are not supported in WGSL. ${WGSL_SUFFIX}`,
    },
    // Function pointer calls
    {
        pattern: /Complex callee expressions not supported/,
        format: () => `Function pointer calls are not supported in WGSL. Use direct function calls instead. ${WGSL_SUFFIX}`,
    },
    // Arrow access to multi-component swizzle
    {
        pattern: /Arrow access to multi-component swizzle:\s*(.+)/,
        format: (m) => `Arrow access to multi-component swizzle (${m[1].trim()}) is not supported in WGSL. ${WGSL_SUFFIX}`,
    },
    // Arrow access on non-pointer type
    {
        pattern: /Arrow access on non-pointer type:\s*(.+)/,
        format: (m) => `Arrow operator on non-pointer type (${m[1].trim()}) is not supported. Use dot (.) access instead.`,
    },
    // Swizzle assignment
    {
        pattern: /Cannot assign to swizzle/,
        format: () => `Direct assignment to multi-component swizzle is not supported in WGSL. Assign to individual components instead. ${WGSL_SUFFIX}`,
    },
    // Generic "Unsupported feature:" — append WGSL suffix
    {
        pattern: /^Unsupported feature:\s*(.+)/,
        format: (m) => `${m[1].trim()}. ${WGSL_SUFFIX}`,
    },
    // Generic "WGSL generation failed:" — strip Naga internals
    {
        pattern: /^WGSL generation failed:\s*(.+)/,
        format: (m) => {
            // Try to extract a readable error from Naga's debug output
            const inner = m[1];
            const fnMatch = inner.match(/name:\s*"([^"]+)"/);
            const fnName = fnMatch ? ` in function '${fnMatch[1]}'` : '';
            return `WGSL validation error${fnName}. ${WGSL_SUFFIX}`;
        },
    },
];

/**
 * Format Rust compiler error messages to be more user-friendly.
 * Replaces technical Naga/WGSL error details with clear descriptions
 * of WGSL limitations and suggestions.
 */
export function formatWgslLimitationMessage(message: string): string {
    for (const rule of WGSL_ERROR_RULES) {
        const match = message.match(rule.pattern);
        if (match) {
            return rule.format(match);
        }
    }
    return message;
}
