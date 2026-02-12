/**
 * Document Analyzer for IDE Integration
 *
 * Lightweight wrapper around parseDctl + SemanticAnalyzer that provides
 * symbol information suitable for auto-completion and hover.
 */

import { preprocessDctl } from '../parser/dctlPreprocessor.js';
import { parseDctl } from '../parser/dctlParser.js';
import { SemanticAnalyzer } from './analyzer.js';
import { SymbolTable } from './symbolTable.js';
import type { SymbolKind, SemanticError } from './types.js';
import { isVectorType, getVectorSize, getVectorElementType } from './types.js';
import type {
    ModuleNode,
    FunctionNode,
    StatementNode,
    DeclarationNode,
} from '../parser/index.js';

/**
 * A symbol extracted from the document for IDE use
 */
export interface DocumentSymbol {
    name: string;
    kind: SymbolKind;
    /** Type name (e.g. "float3", "int") */
    type: string;
    /** Extra detail (e.g. function signature) */
    detail?: string;
    /** 1-based line number in the original source */
    line: number;
}

/**
 * Result of document analysis
 */
export interface DocumentAnalysisResult {
    symbolTable: SymbolTable;
    ast: ModuleNode | null;
    errors: SemanticError[];
    /** All user-defined symbols (variables, functions, params, structs, constants) */
    symbols: DocumentSymbol[];
    /** Flat map of all variable names → type names (globals, params, locals) for type resolution */
    variableTypes: Map<string, string>;
    /** Line offset from preprocessor (for mapping back to original) */
    lineOffset: number;
}

/**
 * Analyze a DCTL source document and extract symbols for IDE features.
 *
 * Pipeline: preprocessDctl → parseDctl → SemanticAnalyzer.analyze
 *
 * @param source - Raw DCTL source code
 * @returns Analysis result with symbol table and extracted symbols
 */
export function analyzeDocument(source: string): DocumentAnalysisResult {
    const emptyResult: DocumentAnalysisResult = {
        symbolTable: new SymbolTable(),
        ast: null,
        errors: [],
        symbols: [],
        variableTypes: new Map(),
        lineOffset: 0,
    };

    try {
        // Step 1: Preprocess
        const preprocessed = preprocessDctl(source);
        const lineOffset = preprocessed.headerLineCount;

        // Step 2: Parse
        const parseResult = parseDctl(preprocessed.code);
        if (!parseResult.ast) {
            return { ...emptyResult, lineOffset };
        }

        // Step 3: Semantic analysis
        const analyzer = new SemanticAnalyzer();
        const analysisResult = analyzer.analyze(parseResult.ast);
        const { symbolTable } = analysisResult;

        // Step 4: Extract user-defined symbols
        const symbols = extractUserSymbols(parseResult.ast, symbolTable, lineOffset);

        // Step 5: Build variable type map from AST (params + locals + globals)
        const variableTypes = collectVariableTypes(parseResult.ast, symbolTable, lineOffset);

        return {
            symbolTable,
            ast: parseResult.ast,
            errors: analysisResult.errors,
            symbols,
            variableTypes,
            lineOffset,
        };
    } catch {
        return emptyResult;
    }
}

/**
 * Extract user-defined symbols from the symbol table and AST.
 * Includes global vars, functions, structs, function parameters, and local variables.
 * Filters out builtins and preprocessor header declarations.
 */
function extractUserSymbols(
    ast: ModuleNode,
    symbolTable: SymbolTable,
    lineOffset: number
): DocumentSymbol[] {
    const symbols: DocumentSymbol[] = [];
    const seen = new Set<string>();

    // Global scope variables (includes UI params and global vars)
    for (const sym of symbolTable.getGlobalScope().getAllSymbols()) {
        if (sym.loc.line <= lineOffset) continue;

        symbols.push({
            name: sym.name,
            kind: sym.kind,
            type: sym.type.name,
            detail: sym.constValue !== undefined ? `= ${sym.constValue}` : undefined,
            line: Math.max(1, sym.loc.line - lineOffset),
        });
        seen.add(sym.name);
    }

    // User-defined functions + their parameters and local variables
    for (const fn of symbolTable.getAllFunctions()) {
        if (fn.isBuiltin || fn.loc.line <= lineOffset) continue;

        const paramList = fn.parameters
            .map(p => `${p.type.name} ${p.name}`)
            .join(', ');
        const signature = `${fn.returnType.name} ${fn.name}(${paramList})`;

        symbols.push({
            name: fn.name,
            kind: 'function',
            type: fn.returnType.name,
            detail: signature,
            line: Math.max(1, fn.loc.line - lineOffset),
        });
        seen.add(fn.name);
    }

    // Function parameters and local variables from AST
    for (const decl of ast.declarations) {
        if (decl.kind !== 'Function') continue;
        const fn = decl as FunctionNode;
        if (fn.loc && fn.loc.line <= lineOffset) continue;

        // Parameters
        for (const param of fn.parameters) {
            if (seen.has(param.name)) continue;
            symbols.push({
                name: param.name,
                kind: 'parameter',
                type: param.type.name,
                detail: `${param.type.name} ${param.name}`,
                line: Math.max(1, (param.loc?.line ?? fn.loc.line) - lineOffset),
            });
            seen.add(param.name);
        }

        // Local variables
        if (fn.body) {
            collectBlockSymbols(fn.body.statements, symbols, seen, lineOffset);
        }
    }

    // Struct definitions (skip header-defined types like float2/3/4)
    for (const struct of symbolTable.getAllStructs()) {
        if (struct.loc.line <= lineOffset) continue;

        symbols.push({
            name: struct.name,
            kind: 'struct',
            type: struct.name,
            detail: `struct ${struct.name} { ${struct.fields.map(f => f.type.name + ' ' + f.name).join('; ')} }`,
            line: Math.max(1, struct.loc.line - lineOffset),
        });
    }

    return symbols;
}

/**
 * Recursively collect local variable declarations as DocumentSymbols
 */
function collectBlockSymbols(
    statements: StatementNode[],
    symbols: DocumentSymbol[],
    seen: Set<string>,
    lineOffset: number
): void {
    for (const stmt of statements) {
        if (stmt.kind === 'VariableDeclaration') {
            if (!seen.has(stmt.name)) {
                symbols.push({
                    name: stmt.name,
                    kind: 'variable',
                    type: stmt.type.name,
                    detail: `${stmt.type.name} ${stmt.name}`,
                    line: Math.max(1, (stmt.loc?.line ?? 1) - lineOffset),
                });
                seen.add(stmt.name);
            }
        } else if (stmt.kind === 'Block') {
            collectBlockSymbols(stmt.statements, symbols, seen, lineOffset);
        } else if (stmt.kind === 'If') {
            collectBlockSymbols([stmt.thenBranch], symbols, seen, lineOffset);
            if (stmt.elseBranch) collectBlockSymbols([stmt.elseBranch], symbols, seen, lineOffset);
        } else if (stmt.kind === 'While' || stmt.kind === 'DoWhile') {
            collectBlockSymbols([stmt.body], symbols, seen, lineOffset);
        } else if (stmt.kind === 'For') {
            if (stmt.init) {
                if (Array.isArray(stmt.init)) {
                    for (const v of stmt.init) {
                        if (v.kind === 'VariableDeclaration' && !seen.has(v.name)) {
                            symbols.push({
                                name: v.name,
                                kind: 'variable',
                                type: v.type.name,
                                detail: `${v.type.name} ${v.name}`,
                                line: Math.max(1, (v.loc?.line ?? 1) - lineOffset),
                            });
                            seen.add(v.name);
                        }
                    }
                } else if (stmt.init.kind === 'VariableDeclaration' && !seen.has(stmt.init.name)) {
                    symbols.push({
                        name: stmt.init.name,
                        kind: 'variable',
                        type: stmt.init.type.name,
                        detail: `${stmt.init.type.name} ${stmt.init.name}`,
                        line: Math.max(1, (stmt.init.loc?.line ?? 1) - lineOffset),
                    });
                    seen.add(stmt.init.name);
                }
            }
            collectBlockSymbols([stmt.body], symbols, seen, lineOffset);
        } else if (stmt.kind === 'Switch') {
            for (const c of stmt.cases) {
                collectBlockSymbols(c.statements, symbols, seen, lineOffset);
            }
        }
    }
}

/**
 * Collect all variable→type mappings by walking the AST.
 * Includes function parameters, local variables, and global variables.
 * Also includes global scope symbols from semantic analysis (UI params etc.)
 */
function collectVariableTypes(
    ast: ModuleNode,
    symbolTable: SymbolTable,
    lineOffset: number
): Map<string, string> {
    const types = new Map<string, string>();

    // Global scope symbols (UI params, global vars from semantic analysis)
    for (const sym of symbolTable.getGlobalScope().getAllSymbols()) {
        if (sym.loc.line <= lineOffset) continue;
        types.set(sym.name, sym.type.name);
    }

    // Walk AST declarations
    for (const decl of ast.declarations) {
        if (decl.kind === 'Function') {
            const fn = decl as FunctionNode;
            // Skip header-generated functions
            if (fn.loc && fn.loc.line <= lineOffset) continue;

            // Function parameters
            for (const param of fn.parameters) {
                types.set(param.name, param.type.name);
            }

            // Local variables in function body
            if (fn.body) {
                collectBlockVariables(fn.body.statements, types);
            }
        } else if (decl.kind === 'VariableDeclaration') {
            // Global variable declarations
            if (decl.loc && decl.loc.line <= lineOffset) continue;
            types.set(decl.name, decl.type.name);
        }
    }

    return types;
}

/**
 * Recursively collect variable declarations from statements
 */
function collectBlockVariables(
    statements: StatementNode[],
    types: Map<string, string>
): void {
    for (const stmt of statements) {
        if (stmt.kind === 'VariableDeclaration') {
            types.set(stmt.name, stmt.type.name);
        } else if (stmt.kind === 'Block') {
            collectBlockVariables(stmt.statements, types);
        } else if (stmt.kind === 'If') {
            collectBlockVariables([stmt.thenBranch], types);
            if (stmt.elseBranch) collectBlockVariables([stmt.elseBranch], types);
        } else if (stmt.kind === 'While' || stmt.kind === 'DoWhile') {
            collectBlockVariables([stmt.body], types);
        } else if (stmt.kind === 'For') {
            if (stmt.init) {
                if (Array.isArray(stmt.init)) {
                    for (const v of stmt.init) {
                        if (v.kind === 'VariableDeclaration') {
                            types.set(v.name, v.type.name);
                        }
                    }
                } else if (stmt.init.kind === 'VariableDeclaration') {
                    types.set(stmt.init.name, stmt.init.type.name);
                }
            }
            collectBlockVariables([stmt.body], types);
        } else if (stmt.kind === 'Switch') {
            for (const c of stmt.cases) {
                collectBlockVariables(c.statements, types);
            }
        }
    }
}

/**
 * Get member completions for a given type.
 *
 * - Vector types (float2/3/4, int2/3/4, half2/3/4) → swizzle components
 * - Struct types → struct fields
 *
 * @param typeName - The type to resolve members for
 * @param symbolTable - Symbol table for struct lookup
 * @returns Array of { name, type } for each member
 */
export function getMemberCompletions(
    typeName: string,
    symbolTable: SymbolTable
): Array<{ name: string; type: string; detail?: string }> {
    // Vector swizzle components
    if (isVectorType(typeName)) {
        const size = getVectorSize(typeName);
        const elementType = getVectorElementType(typeName) || 'float';
        if (!size) return [];

        const components = ['x', 'y', 'z', 'w'].slice(0, size);
        const colorComponents = ['r', 'g', 'b', 'a'].slice(0, size);

        const result: Array<{ name: string; type: string; detail?: string }> = [];

        for (const c of components) {
            result.push({ name: c, type: elementType, detail: `${typeName}.${c}` });
        }
        for (const c of colorComponents) {
            result.push({ name: c, type: elementType, detail: `${typeName}.${c}` });
        }

        return result;
    }

    // Struct fields
    const structInfo = symbolTable.lookupStruct(typeName);
    if (structInfo) {
        return structInfo.fields.map(f => ({
            name: f.name,
            type: f.type.name,
            detail: `${typeName}.${f.name}: ${f.type.name}`,
        }));
    }

    return [];
}
