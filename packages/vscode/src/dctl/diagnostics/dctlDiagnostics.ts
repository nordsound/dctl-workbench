/**
 * DCTL Diagnostics Provider (using native DCTL parser)
 *
 * Provides real-time syntax checking and error reporting for DCTL files.
 * Uses the custom DCTL parser instead of tree-sitter.
 */

import * as vscode from 'vscode';
import { parseDctl, FunctionNode, LiteralNode, VariableDeclarationNode, visitAST, isEntryPoint } from '../parser';
import { DCTL_ERROR_CODES } from './errorCodes';
import { FORBIDDEN_C_FUNCTIONS, UI_PARAM_LIMIT, DctlUIType, DCTL_BUILTIN_FUNCTIONS } from '../parser/types';
import { DctlValidator, getDctlValidator } from '../validation';
import { DctlPreprocessor } from '../preprocessor';
import { analyzeDocument } from '@dctl-workbench/core';

export class DctlNativeDiagnosticsProvider implements vscode.Disposable {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private disposables: vscode.Disposable[] = [];
    private debounceTimer: NodeJS.Timeout | null = null;
    private debounceMs: number;
    private enabled: boolean;
    private nagaValidationEnabled: boolean;
    private validator: DctlValidator;
    private initialized: boolean = false;
    private extensionPath: string;

    constructor(extensionPath?: string) {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('dctl');
        this.debounceMs = vscode.workspace.getConfiguration('dctlWorkbench').get('editor.diagnosticsDebounceMs', 500);
        this.enabled = vscode.workspace.getConfiguration('dctlWorkbench').get('editor.diagnostics', true);
        this.nagaValidationEnabled = vscode.workspace.getConfiguration('dctlWorkbench').get('editor.nagaValidation', true);
        this.validator = getDctlValidator();

        // Use provided extension path or try to find it
        if (extensionPath) {
            this.extensionPath = extensionPath;
        } else {
            // Try to find extension by name pattern
            const extension = vscode.extensions.all.find(ext =>
                ext.id.endsWith('.dctl-workbench') || ext.id === 'dctl-workbench'
            );
            this.extensionPath = extension?.extensionPath || '';
        }

        // Register event handlers
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(this.onDocumentChange, this),
            vscode.workspace.onDidOpenTextDocument(this.onDocumentOpen, this),
            vscode.workspace.onDidCloseTextDocument(this.onDocumentClose, this),
            vscode.workspace.onDidChangeConfiguration(this.onConfigChange, this)
        );

        // Initialize validator and check documents
        this.init();
    }

    private async init(): Promise<void> {
        try {
            // Initialize Naga validator
            if (this.nagaValidationEnabled && this.extensionPath) {
                console.log('[DCTL] Initializing Naga validator...');
                await this.validator.init(this.extensionPath);
                console.log('[DCTL] Naga validator initialized');
            }
        } catch (error) {
            console.error('[DCTL] Failed to initialize Naga validator:', error);
        } finally {
            this.initialized = true;

            // Check all open DCTL documents (must run even if Naga init failed)
            for (const document of vscode.workspace.textDocuments) {
                if (document.languageId === 'dctl') {
                    this.checkDocument(document);
                }
            }
        }
    }

    private onDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        if (!this.enabled) return;
        if (event.document.languageId !== 'dctl') return;

        // Debounce
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.checkDocument(event.document);
        }, this.debounceMs);
    }

    private onDocumentOpen(document: vscode.TextDocument): void {
        if (!this.enabled) return;
        if (document.languageId !== 'dctl') return;

        this.checkDocument(document);
    }

    private onDocumentClose(document: vscode.TextDocument): void {
        if (document.languageId !== 'dctl') return;
        this.diagnosticCollection.delete(document.uri);
    }

    private onConfigChange(event: vscode.ConfigurationChangeEvent): void {
        if (event.affectsConfiguration('dctlWorkbench.editor')) {
            this.enabled = vscode.workspace.getConfiguration('dctlWorkbench').get('editor.diagnostics', true);
            this.debounceMs = vscode.workspace.getConfiguration('dctlWorkbench').get('editor.diagnosticsDebounceMs', 500);
            this.nagaValidationEnabled = vscode.workspace.getConfiguration('dctlWorkbench').get('editor.nagaValidation', true);

            if (!this.enabled) {
                this.diagnosticCollection.clear();
            }

            // Initialize validator if enabled and not yet initialized
            if (this.nagaValidationEnabled && !this.validator.isInitialized && this.extensionPath) {
                this.validator.init(this.extensionPath).catch(err => {
                    console.error('[DCTL] Failed to initialize Naga validator:', err);
                });
            }
        }
    }

    /**
     * Check a DCTL document for errors and warnings
     */
    public checkDocument(document: vscode.TextDocument): void {
        // Run async check
        this.checkDocumentAsync(document).catch(err => {
            console.error('[DCTL] Error checking DCTL document:', err);
        });
    }

    /**
     * Check a DCTL document for errors and warnings (async)
     */
    private async checkDocumentAsync(document: vscode.TextDocument): Promise<void> {
        const diagnostics: vscode.Diagnostic[] = [];
        // Diagnostics for included files, keyed by file path
        const includedFileDiagnostics = new Map<string, vscode.Diagnostic[]>();
        const source = document.getText();
        const filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;

        try {
            // Preprocess to expand #include directives first
            let processedSource = source;
            let includeExpandedSource = source; // Source with includes expanded but defines NOT processed
            let preprocessorSourceMap: any = undefined;
            let lineOffset = 0;
            let functionMacroNames: string[] = [];

            if (filePath) {
                const preprocessor = new DctlPreprocessor();
                const preprocessResult = await preprocessor.preprocessSource(source, filePath);

                if (preprocessResult.success) {
                    processedSource = preprocessResult.expandedSource;
                    includeExpandedSource = preprocessResult.includeExpandedSource;
                    preprocessorSourceMap = preprocessResult.sourceMap;
                    lineOffset = preprocessResult.lineOffset;
                }
                // Always collect function macro names (even on failure, some may have been parsed)
                functionMacroNames = preprocessResult.functionMacros.map(m => m.name);
            }

            // Parse with native DCTL parser (use expanded source if available)
            const result = parseDctl(processedSource);

            // Add parse errors (map back to original locations if source map available)
            for (const error of result.errors) {
                let mappedLine = error.line;
                let mappedFile = filePath;

                // Adjust for lines prepended by processDefines (UI param declarations, LUT stubs)
                // The processed source has lineOffset extra lines at the beginning,
                // but the source map was built before those lines were added.
                let adjustedLine = error.line;
                if (lineOffset > 0) {
                    adjustedLine = Math.max(1, adjustedLine - lineOffset);
                }

                // Map line back to original file if we have a source map
                if (preprocessorSourceMap && preprocessorSourceMap.getOriginalPosition) {
                    const original = preprocessorSourceMap.getOriginalPosition(adjustedLine);
                    if (original) {
                        mappedLine = original.line;
                        mappedFile = original.file;
                    } else {
                        mappedLine = adjustedLine;
                    }
                } else {
                    mappedLine = adjustedLine;
                }

                const range = new vscode.Range(
                    mappedLine - 1, error.column - 1,
                    mappedLine - 1, error.column + 10
                );

                const diagnostic = new vscode.Diagnostic(
                    range,
                    error.message,
                    vscode.DiagnosticSeverity.Error
                );
                diagnostic.code = 'DCTL011';
                diagnostic.source = 'DCTL';

                // Route diagnostics to the correct file
                if (mappedFile && filePath && mappedFile !== filePath) {
                    const arr = includedFileDiagnostics.get(mappedFile) || [];
                    arr.push(diagnostic);
                    includedFileDiagnostics.set(mappedFile, arr);
                } else {
                    diagnostics.push(diagnostic);
                }
            }

            // Track parse errors (syntax errors from native parser)
            const hasSyntaxErrors = result.errors.length > 0;

            if (result.ast) {
                // Check for entry point (returns true if duplicates found)
                const hasDuplicateEntryPoints = this.checkEntryPoint(result.ast.declarations, diagnostics);

                // Check for forbidden functions (use original source AST for line mapping)
                // Re-parse original source for checks that need original line numbers
                const originalResult = parseDctl(source);
                if (originalResult.ast) {
                    this.checkForbiddenFunctions(originalResult.ast, diagnostics);
                    this.checkUIParamLimits(originalResult.ast.macros, diagnostics);
                    this.checkFloatLiteralSuffix(originalResult.ast, diagnostics);
                }

                // Check for unknown functions using expanded AST (knows about #include functions)
                // but with original AST for line numbers
                if (originalResult.ast) {
                    this.checkUnknownFunctionsWithIncludes(originalResult.ast, result.ast, functionMacroNames, diagnostics);
                }

                // Run Naga semantic validation only if no syntax errors and no duplicate entry points
                // (Naga would report similar errors, causing duplicates)
                if (!hasSyntaxErrors && !hasDuplicateEntryPoints && this.nagaValidationEnabled && this.validator.isInitialized) {
                    await this.checkNagaValidationAsync(source, filePath, diagnostics, includedFileDiagnostics);
                }

                // Semantic analysis (errors and warnings)
                // Use includeExpandedSource so the analyzer sees functions from #include headers.
                // Error line numbers are relative to includeExpandedSource and must be mapped
                // back through the preprocessor source map to original file positions.
                if (!hasSyntaxErrors) {
                    const analysis = analyzeDocument(includeExpandedSource);
                    for (const item of [...analysis.errors.map(e => ({ ...e, severity: 'error' as const })), ...analysis.warnings.map(w => ({ ...w, severity: 'warning' as const }))]) {
                        let mappedLine = item.line;
                        let mappedFile = filePath;

                        // Map line back through preprocessor source map
                        if (preprocessorSourceMap && preprocessorSourceMap.getOriginalPosition) {
                            const original = preprocessorSourceMap.getOriginalPosition(item.line);
                            if (original) {
                                mappedLine = original.line;
                                mappedFile = original.file;
                            }
                        }

                        // Skip diagnostics from included files (not the user's main file)
                        if (mappedFile && filePath && mappedFile !== filePath) {
                            continue;
                        }

                        const diagLine = Math.max(0, mappedLine - 1);
                        const range = new vscode.Range(
                            diagLine, item.column - 1,
                            diagLine, item.column + 10
                        );
                        const diagnostic = new vscode.Diagnostic(
                            range,
                            item.message,
                            item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
                        );
                        diagnostic.code = item.code;
                        diagnostic.source = 'DCTL';
                        diagnostics.push(diagnostic);
                    }
                }
            }
        } catch (error) {
            console.error('[DCTL] Error checking DCTL document:', error);
        }

        this.diagnosticCollection.set(document.uri, diagnostics);

        // Set diagnostics for included files
        for (const [file, diags] of includedFileDiagnostics) {
            this.diagnosticCollection.set(vscode.Uri.file(file), diags);
        }
    }

    /**
     * Check for transform/transition entry point
     * @returns true if duplicate entry points were found (severe error)
     */
    private checkEntryPoint(
        declarations: any[],
        diagnostics: vscode.Diagnostic[]
    ): boolean {
        const entryPoints = declarations.filter(d =>
            d.kind === 'Function' && isEntryPoint(d as FunctionNode)
        );

        if (entryPoints.length === 0) {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, 0),
                DCTL_ERROR_CODES.DCTL001.message,
                vscode.DiagnosticSeverity.Error
            );
            diagnostic.code = 'DCTL001';
            diagnostic.source = 'DCTL';
            diagnostics.push(diagnostic);
        }

        // Check for duplicate entry points (same function name defined multiple times)
        const entryPointsByName = new Map<string, FunctionNode[]>();
        for (const ep of entryPoints) {
            const fn = ep as FunctionNode;
            const existing = entryPointsByName.get(fn.name) || [];
            existing.push(fn);
            entryPointsByName.set(fn.name, existing);
        }

        let hasDuplicates = false;
        for (const [name, functions] of entryPointsByName) {
            if (functions.length > 1) {
                hasDuplicates = true;
                // Report error on each duplicate (skip the first one)
                for (let i = 1; i < functions.length; i++) {
                    const fn = functions[i];
                    const range = new vscode.Range(
                        fn.loc.line - 1, fn.loc.column - 1,
                        fn.loc.line - 1, fn.loc.column + name.length + 10
                    );

                    const message = `Duplicate entry point '${name}' (first defined at line ${functions[0].loc.line})`;
                    const diagnostic = new vscode.Diagnostic(
                        range,
                        message,
                        vscode.DiagnosticSeverity.Error
                    );
                    diagnostic.code = 'DCTL014';
                    diagnostic.source = 'DCTL';
                    diagnostics.push(diagnostic);
                }
            }
        }

        return hasDuplicates;
    }

    /**
     * Check for forbidden C functions
     */
    private checkForbiddenFunctions(ast: any, diagnostics: vscode.Diagnostic[]): void {
        visitAST(ast, (node) => {
            if (node.kind === 'CallExpression') {
                const callee = (node as any).callee;
                if (callee.kind === 'Identifier') {
                    const name = callee.name;
                    if (name in FORBIDDEN_C_FUNCTIONS) {
                        const range = new vscode.Range(
                            node.loc.line - 1, node.loc.column - 1,
                            node.loc.line - 1, node.loc.column + name.length
                        );

                        const replacement = FORBIDDEN_C_FUNCTIONS[name];
                        const message = `${DCTL_ERROR_CODES.DCTL006.message}: '${name}' should be '${replacement}'`;
                        const diagnostic = new vscode.Diagnostic(
                            range,
                            message,
                            vscode.DiagnosticSeverity.Warning // Changed from Error: functions work but _prefixed versions recommended
                        );
                        diagnostic.code = 'DCTL006';
                        diagnostic.source = 'DCTL';
                        diagnostics.push(diagnostic);
                    }
                }
            }
        });
    }

    /**
     * Check UI parameter count limits
     */
    private checkUIParamLimits(macros: any[], diagnostics: vscode.Diagnostic[]): void {
        // Count DEFINE_UI_PARAMS macros
        const uiParams = macros.filter(m => m.name === 'DEFINE_UI_PARAMS' || m.name.startsWith('DEFINE_UI_PARAMS'));

        // Group by UI type
        const counts = new Map<string, number>();

        for (const macro of uiParams) {
            if (macro.arguments.length >= 3) {
                const uiType = macro.arguments[2];
                const count = (counts.get(uiType) || 0) + 1;
                counts.set(uiType, count);

                if (count > UI_PARAM_LIMIT) {
                    const range = new vscode.Range(
                        macro.loc.line - 1, macro.loc.column - 1,
                        macro.loc.line - 1, macro.loc.column + 20
                    );

                    const message = `${DCTL_ERROR_CODES.DCTL005.message}: ${uiType} (${count}/${UI_PARAM_LIMIT})`;
                    const diagnostic = new vscode.Diagnostic(
                        range,
                        message,
                        vscode.DiagnosticSeverity.Warning
                    );
                    diagnostic.code = 'DCTL005';
                    diagnostic.source = 'DCTL';
                    diagnostics.push(diagnostic);
                }
            }
        }
    }

    /**
     * Check for float literals without 'f' suffix assigned to float variables
     */
    private checkFloatLiteralSuffix(ast: any, diagnostics: vscode.Diagnostic[]): void {
        const floatTypes = ['float', 'float2', 'float3', 'float4'];

        visitAST(ast, (node) => {
            // Check variable declarations with float type and literal initializer
            if (node.kind === 'VariableDeclaration') {
                const varDecl = node as VariableDeclarationNode;
                if (floatTypes.includes(varDecl.type.name) && varDecl.initializer) {
                    this.checkLiteralForSuffix(varDecl.initializer, diagnostics);
                }
            }

            // Check assignment expressions where right side is a literal
            if (node.kind === 'AssignmentExpression') {
                const assignExpr = node as any;
                this.checkLiteralForSuffix(assignExpr.right, diagnostics);
            }

            // Check function call arguments
            if (node.kind === 'CallExpression') {
                const callExpr = node as any;
                for (const arg of callExpr.arguments) {
                    this.checkLiteralForSuffix(arg, diagnostics);
                }
            }

            // Check binary expressions (e.g., 0.5 * x)
            if (node.kind === 'BinaryExpression') {
                const binExpr = node as any;
                this.checkLiteralForSuffix(binExpr.left, diagnostics);
                this.checkLiteralForSuffix(binExpr.right, diagnostics);
            }
        });
    }

    /**
     * Check a single expression for unsuffixed float literal
     */
    private checkLiteralForSuffix(expr: any, diagnostics: vscode.Diagnostic[]): void {
        if (expr.kind === 'Literal' && expr.literalType === 'float' && !expr.hasFloatSuffix) {
            const literal = expr as LiteralNode;
            // Use rawValue if available, otherwise convert value to string
            const displayValue = literal.rawValue ?? String(literal.value);
            const range = new vscode.Range(
                literal.loc.line - 1, literal.loc.column - 1,
                literal.loc.line - 1, literal.loc.column + displayValue.length
            );

            const message = `${DCTL_ERROR_CODES.DCTL012.message}: Consider using '${displayValue}f' instead of '${displayValue}'`;
            const diagnostic = new vscode.Diagnostic(
                range,
                message,
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.code = 'DCTL012';
            diagnostic.source = 'DCTL';
            diagnostics.push(diagnostic);
        }
    }

    /**
     * Check for calls to unknown/undefined functions with #include support.
     * Uses the expanded AST to collect all defined functions (including from #include files),
     * but uses the original AST to report errors with correct line numbers.
     *
     * @param originalAst - AST from the original source (for line numbers)
     * @param expandedAst - AST from the #include-expanded source (for function definitions)
     * @param functionMacroNames - Names of function-like macros from preprocessor (e.g., DMINQ)
     * @param diagnostics - Array to add diagnostics to
     */
    private checkUnknownFunctionsWithIncludes(
        originalAst: any,
        expandedAst: any,
        functionMacroNames: string[],
        diagnostics: vscode.Diagnostic[]
    ): void {
        // Collect all defined function names from the EXPANDED source (includes #include files)
        const definedFunctions = new Set<string>();
        for (const decl of expandedAst.declarations) {
            if (decl.kind === 'Function') {
                definedFunctions.add((decl as FunctionNode).name);
            }
        }

        // Add function-like macro names (e.g., #define DMINQ(id) ...)
        // These are called like functions but are preprocessor macros
        for (const macroName of functionMacroNames) {
            definedFunctions.add(macroName);
        }

        // Create a set of built-in functions for fast lookup
        const builtinSet = new Set<string>(DCTL_BUILTIN_FUNCTIONS);

        // Also add forbidden C functions (they're valid calls, just not recommended)
        const forbiddenSet = new Set<string>(Object.keys(FORBIDDEN_C_FUNCTIONS));

        // Visit all call expressions in the ORIGINAL AST (for correct line numbers)
        visitAST(originalAst, (node) => {
            if (node.kind === 'CallExpression') {
                const callExpr = node as any;
                const callee = callExpr.callee;

                // Only check simple function calls (not method calls or computed calls)
                if (callee.kind === 'Identifier') {
                    const funcName = callee.name;

                    // Skip if already defined, built-in, or forbidden (will be caught by other check)
                    if (definedFunctions.has(funcName) ||
                        builtinSet.has(funcName) ||
                        forbiddenSet.has(funcName)) {
                        return;
                    }

                    const range = new vscode.Range(
                        callee.loc.line - 1, callee.loc.column - 1,
                        callee.loc.line - 1, callee.loc.column + funcName.length - 1
                    );

                    const message = `${DCTL_ERROR_CODES.DCTL013.message}: '${funcName}' is not defined`;
                    const diagnostic = new vscode.Diagnostic(
                        range,
                        message,
                        vscode.DiagnosticSeverity.Error
                    );
                    diagnostic.code = 'DCTL013';
                    diagnostic.source = 'DCTL';
                    diagnostics.push(diagnostic);
                }
            }
        });
    }

    /**
     * Run Rust compiler validation on DCTL code
     * Uses the Rust compiler's built-in validation
     */
    private async checkNagaValidationAsync(source: string, filePath: string | undefined, diagnostics: vscode.Diagnostic[], includedFileDiagnostics?: Map<string, vscode.Diagnostic[]>): Promise<void> {
        try {
            console.log('[DCTL] Running Rust compiler validation...');

            // Preprocess to handle #include and get source map
            let processedSource = source;
            let preprocessorSourceMap;
            let lineOffset = 0;

            if (filePath) {
                const preprocessor = new DctlPreprocessor();
                const preprocessResult = await preprocessor.preprocessSource(source, filePath);

                if (preprocessResult.success) {
                    processedSource = preprocessResult.expandedSource;
                    preprocessorSourceMap = preprocessResult.sourceMap;
                    lineOffset = preprocessResult.lineOffset;
                } else {
                    // Preprocessor errors are handled elsewhere, skip validation
                    return;
                }
            }

            // Skip define processing since preprocessor already did it, but pass lineOffset for adjustment
            const result = this.validator.validate(processedSource, preprocessorSourceMap, true, lineOffset);

            // Add errors (line numbers already adjusted by validator)
            for (const error of result.errors) {
                const range = new vscode.Range(
                    Math.max(0, error.line - 1), Math.max(0, (error.column ?? 1) - 1),
                    Math.max(0, error.line - 1), Math.max(0, (error.column ?? 1) - 1) + 20
                );

                const diagnostic = new vscode.Diagnostic(
                    range,
                    error.message,
                    vscode.DiagnosticSeverity.Error
                );
                diagnostic.code = 'DCTL010';
                diagnostic.source = 'DCTL (Compiler)';

                if (error.file && filePath && error.file !== filePath) {
                    if (includedFileDiagnostics) {
                        const arr = includedFileDiagnostics.get(error.file) || [];
                        arr.push(diagnostic);
                        includedFileDiagnostics.set(error.file, arr);
                    }
                } else {
                    diagnostics.push(diagnostic);
                }
            }

            // Add warnings (line numbers already adjusted by validator)
            for (const warning of result.warnings) {
                const range = new vscode.Range(
                    Math.max(0, warning.line - 1), Math.max(0, (warning.column ?? 1) - 1),
                    Math.max(0, warning.line - 1), Math.max(0, (warning.column ?? 1) - 1) + 20
                );

                const diagnostic = new vscode.Diagnostic(
                    range,
                    warning.message,
                    vscode.DiagnosticSeverity.Warning
                );
                diagnostic.code = 'DCTL010';
                diagnostic.source = 'DCTL (Compiler)';

                if (warning.file && filePath && warning.file !== filePath) {
                    if (includedFileDiagnostics) {
                        const arr = includedFileDiagnostics.get(warning.file) || [];
                        arr.push(diagnostic);
                        includedFileDiagnostics.set(warning.file, arr);
                    }
                } else {
                    diagnostics.push(diagnostic);
                }
            }

            console.log('[DCTL] Compiler validation complete:', result.success ? 'success' : `${result.errors.length} errors`);
        } catch (error) {
            console.error('[DCTL] Compiler validation error:', error);
        }
    }

    /**
     * Run compiler validation on DCTL code (sync wrapper for backward compatibility)
     */
    private checkNagaValidation(source: string, diagnostics: vscode.Diagnostic[], filePath?: string): void {
        // Run async validation - errors will be added to diagnostics array
        this.checkNagaValidationAsync(source, filePath, diagnostics).catch(err => {
            console.error('[DCTL] Compiler validation async error:', err);
        });
    }

    /**
     * Mark a runtime error from Resolve log
     */
    public markRuntimeError(uri: vscode.Uri, line: number, message: string): void {
        const existing = this.diagnosticCollection.get(uri) || [];
        const diagnostics = [...existing];

        const range = new vscode.Range(line - 1, 0, line - 1, 1000);
        const diagnostic = new vscode.Diagnostic(
            range,
            `Runtime error: ${message}`,
            vscode.DiagnosticSeverity.Error
        );
        diagnostic.code = 'DCTL009';
        diagnostic.source = 'DCTL (Resolve)';
        diagnostics.push(diagnostic);

        this.diagnosticCollection.set(uri, diagnostics);
    }

    /**
     * Clear runtime errors
     */
    public clearRuntimeErrors(uri: vscode.Uri): void {
        const existing = this.diagnosticCollection.get(uri) || [];
        const filtered = existing.filter(d => d.source !== 'DCTL (Resolve)');
        this.diagnosticCollection.set(uri, filtered);
    }

    public dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.diagnosticCollection.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
