/**
 * DCTL Semantic Analyzer
 *
 * Analyzes DCTL AST for semantic errors and builds symbol table.
 */

import { SymbolTable } from './symbolTable.js';
import { Scope } from './scope.js';
import type {
    Symbol,
    TypeInfo,
    FunctionSignature,
    FunctionParameter,
    StructInfo,
    StructField,
    SemanticError,
    SemanticWarning,
} from './types.js';
import { createTypeInfo, isVectorType, isPrimitiveType } from './types.js';
import { SEMANTIC_ERROR_CODES } from './errorCodes.js';
import type {
    ModuleNode,
    FunctionNode,
    VariableDeclarationNode,
    StructDefinitionNode,
    TypedefNode,
    TypeNode,
    StatementNode,
    BlockNode,
    ExpressionNode,
    IfNode,
    WhileNode,
    ForNode,
    DoWhileNode,
    SwitchNode,
    ReturnNode,
    ExpressionStatementNode,
    BinaryExpressionNode,
    UnaryExpressionNode,
    CallExpressionNode,
    MemberExpressionNode,
    IndexExpressionNode,
    AssignmentExpressionNode,
    IdentifierNode,
    LiteralNode,
    TernaryExpressionNode,
    CastExpressionNode,
    InitializerListNode,
    SourceLocation,
    DeclarationNode,
    MacroNode,
} from '../parser/index.js';

/**
 * Result of semantic analysis
 */
export interface SemanticAnalysisResult {
    /** Symbol table with all collected symbols */
    symbolTable: SymbolTable;
    /** Semantic errors found */
    errors: SemanticError[];
    /** Semantic warnings found */
    warnings: SemanticWarning[];
    /** Whether analysis was successful (no errors) */
    success: boolean;
}

/**
 * Semantic Analyzer
 *
 * Performs semantic analysis on a DCTL AST.
 */
/**
 * Element-wise math functions that preserve input type
 * e.g., sin(float3) → float3, floor(float2) → float2
 */
const ELEMENTWISE_MATH_FUNCTIONS = new Set([
    // Trigonometric (lowercase and uppercase DCTL variants)
    'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
    'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN',
    'sinf', 'cosf', 'tanf', 'asinf', 'acosf', 'atanf',
    // Hyperbolic
    'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
    'SINH', 'COSH', 'TANH', 'ASINH', 'ACOSH', 'ATANH',
    // Exponential/power
    'exp', 'exp2', 'log', 'log2', 'log10', 'sqrt', 'rsqrt', 'cbrt',
    'EXP', 'EXP2', 'LOG', 'LOG2', 'LOG10', 'SQRT', 'RSQRT', 'CBRT',
    'expf', 'exp2f', 'logf', 'log2f', 'log10f', 'sqrtf', 'rsqrtf',
    // Rounding
    'floor', 'ceil', 'round', 'trunc', 'fract',
    'FLOOR', 'CEIL', 'ROUND', 'TRUNC', 'FRACT',
    'floorf', 'ceilf', 'roundf', 'truncf',
    '_floor', '_ceil', '_round', '_trunc', '_fract',
    // Absolute/sign
    'abs', 'fabs', 'sign', 'copysign',
    'ABS', 'FABS', 'SIGN',
    'fabsf', 'signf',
    // Clamping/saturation
    'saturate', 'SATURATE',
    // Vector operations that preserve type
    'normalize', 'NORMALIZE',
    'reflect', 'REFLECT',
    // Native functions
    'native_sin', 'native_cos', 'native_sqrt', 'native_exp', 'native_log',
]);

/**
 * Multi-argument element-wise functions (pow, mix, clamp, etc.)
 * Return type is based on the "larger" type (vector > scalar) of the arguments
 */
const ELEMENTWISE_BINARY_FUNCTIONS = new Set([
    'pow', 'POW', 'powf', '_powf',
    'atan2', 'ATAN2', 'atan2f',
    'fmod', 'FMOD', 'fmodf',
    'copysign', 'COPYSIGN',
    'min', 'max', 'fmin', 'fmax', 'fminf', 'fmaxf',
    'MIN', 'MAX', 'FMIN', 'FMAX',
    '_fminf', '_fmaxf',
    // Interpolation/mixing (3-arg: mix(a, b, t) returns type of a/b)
    'mix', 'MIX', '_mix', 'lerp', 'LERP',
    // Clamping (3-arg: clamp(x, min, max) returns type of x)
    'clamp', 'CLAMP', '_clamp', '_clampf',
    // Step functions
    'step', 'STEP',
    'smoothstep', 'SMOOTHSTEP', '_smoothstep',
]);

export class SemanticAnalyzer {
    private symbolTable!: SymbolTable;
    private errors: SemanticError[] = [];
    private warnings: SemanticWarning[] = [];
    private inLoop: number = 0; // Nesting count for loops
    private inSwitch: number = 0; // Nesting count for switch
    // Tracking for warnings
    private usedSymbols: Set<string> = new Set();
    private calledFunctions: Set<string> = new Set();
    private currentFunctionReturnType?: TypeInfo;
    private currentFunctionName?: string;
    private uiParamNames: Set<string> = new Set();
    private headerLineCount: number = 0;

    /**
     * Analyze a DCTL module
     * @param ast - The parsed AST
     * @param options - Optional analysis options
     * @param options.uiParamNames - Names of UI parameters from DEFINE_UI_PARAMS (from preprocessor)
     * @param options.headerLineCount - Number of lines in the prepended type definitions header
     */
    analyze(ast: ModuleNode, options?: { uiParamNames?: string[]; headerLineCount?: number }): SemanticAnalysisResult {
        this.symbolTable = new SymbolTable();
        this.errors = [];
        this.warnings = [];
        this.inLoop = 0;
        this.inSwitch = 0;
        this.usedSymbols = new Set();
        this.calledFunctions = new Set();
        this.currentFunctionReturnType = undefined;
        this.currentFunctionName = undefined;
        this.uiParamNames = new Set(options?.uiParamNames ?? []);
        this.headerLineCount = options?.headerLineCount ?? 0;

        // Pass 0: Collect UI parameters from macros (DEFINE_UI_PARAMS)
        this.collectUIParameters(ast);

        // Pass 1: Collect all type declarations (typedefs, structs)
        this.collectTypeDeclarations(ast);

        // Pass 2: Collect function signatures
        this.collectFunctionSignatures(ast);

        // Pass 3: Analyze all declarations
        this.analyzeDeclarations(ast);

        // Pass 4: Check for unused functions
        this.checkUnusedFunctions();

        return {
            symbolTable: this.symbolTable,
            errors: this.errors,
            warnings: this.warnings,
            success: this.errors.length === 0,
        };
    }

    // =========================================================================
    // Pass 0: UI Parameters
    // =========================================================================

    private collectUIParameters(ast: ModuleNode): void {
        const dummyLoc: SourceLocation = { line: 0, column: 0 };

        for (const macro of ast.macros) {
            // DEFINE_UI_PARAMS(name, label, type, default, ...)
            if (macro.name === 'DEFINE_UI_PARAMS' && macro.arguments.length >= 4) {
                const paramName = macro.arguments[0];
                const paramType = macro.arguments[2]; // DCTLUI_SLIDER_FLOAT, DCTLUI_CHECK_BOX, etc.

                // Determine the type based on the UI param type
                let typeInfo: TypeInfo;
                if (paramType.includes('FLOAT')) {
                    typeInfo = createTypeInfo('float');
                } else if (paramType.includes('INT')) {
                    typeInfo = createTypeInfo('int');
                } else if (paramType.includes('CHECK_BOX')) {
                    typeInfo = createTypeInfo('int'); // Checkbox is boolean as int
                } else if (paramType.includes('COMBO_BOX')) {
                    typeInfo = createTypeInfo('int'); // Combo box selection is int

                    // For COMBO_BOX, also register enum options as integer constants
                    // Format: DEFINE_UI_PARAMS(name, label, COMBO_BOX, default, {opt1, opt2, ...}, {label1, label2, ...})
                    // Arguments are parsed with commas as separators, so {opt1 is at index 4, opt2 at 5, etc.
                    // We need to extract options between the first { and the second {
                    this.registerComboBoxOptions(macro.arguments, macro.loc || dummyLoc);
                } else {
                    typeInfo = createTypeInfo('float'); // Default to float
                }

                const symbol: Symbol = {
                    name: paramName,
                    kind: 'variable',
                    type: typeInfo,
                    loc: macro.loc || dummyLoc,
                    isConst: false,
                    isBuiltin: true, // Mark as builtin to skip unused warnings
                    isUiParam: true,
                };

                this.symbolTable.defineGlobal(symbol);
                this.uiParamNames.add(paramName);
            }
        }
    }

    /**
     * Register COMBO_BOX enum options as integer constants
     *
     * DEFINE_UI_PARAMS arguments are split by comma, so:
     * {ap0, ap1, p3d65} becomes: ["{ap0", "ap1", "p3d65}"]
     * We need to find the first group starting with { and ending before the next {
     */
    private registerComboBoxOptions(args: string[], loc: SourceLocation): void {
        // Find the start of enum options (first argument starting with '{')
        let startIdx = -1;
        for (let i = 4; i < args.length; i++) {
            if (args[i].startsWith('{')) {
                startIdx = i;
                break;
            }
        }

        if (startIdx === -1) return;

        // Collect options until we hit another '{' or end
        const options: string[] = [];
        for (let i = startIdx; i < args.length; i++) {
            const arg = args[i].trim();

            // Check if this is the start of the labels array (second {)
            if (i > startIdx && arg.startsWith('{')) {
                break;
            }

            // Clean the option name (remove { and } and whitespace)
            let optionName = arg.replace(/^\{|\}$/g, '').trim();

            // Skip empty entries
            if (optionName) {
                options.push(optionName);
            }
        }

        // Register each option as an integer constant with its value
        for (let i = 0; i < options.length; i++) {
            const optionName = options[i];

            // Skip if it looks like a label (contains spaces or special chars)
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(optionName)) {
                continue;
            }

            const symbol: Symbol = {
                name: optionName,
                kind: 'constant',
                type: createTypeInfo('int'),
                loc,
                isConst: true,
                isBuiltin: true,
                constValue: i, // Store the enum index as constant value
            };

            // Don't override existing symbols (struct member names might clash)
            if (!this.symbolTable.lookupGlobal(optionName)) {
                this.symbolTable.defineGlobal(symbol);
            }
        }
    }

    // =========================================================================
    // Pass 1: Type Declarations
    // =========================================================================

    private collectTypeDeclarations(ast: ModuleNode): void {
        for (const decl of ast.declarations) {
            if (decl.kind === 'Typedef') {
                this.collectTypedef(decl as TypedefNode);
            } else if (decl.kind === 'StructDefinition') {
                this.collectStruct(decl as StructDefinitionNode);
            }
        }
    }

    private collectTypedef(node: TypedefNode): void {
        const typeInfo = this.typeNodeToTypeInfo(node.type);
        if (!this.symbolTable.defineTypedef(node.name, typeInfo)) {
            this.addError('SEM009', `Typedef '${node.name}' is already defined`, node.loc);
        }
    }

    private collectStruct(node: StructDefinitionNode): void {
        const fields: StructField[] = node.members.map(m => ({
            name: m.name,
            type: this.typeNodeToTypeInfo(m.type),
            loc: m.loc,
        }));

        const structInfo: StructInfo = {
            name: node.name,
            fields,
            loc: node.loc,
        };

        if (!this.symbolTable.defineStruct(structInfo)) {
            // Allow user code to redefine builtin structs from the type definitions header
            const existing = this.symbolTable.lookupStruct(node.name);
            if (existing && this.headerLineCount > 0 && existing.loc.line < this.headerLineCount) {
                this.symbolTable.replaceStruct(structInfo);
            } else {
                this.addError('SEM009', `Struct '${node.name}' is already defined`, node.loc);
            }
        }
    }

    // =========================================================================
    // Pass 2: Function Signatures
    // =========================================================================

    private collectFunctionSignatures(ast: ModuleNode): void {
        for (const decl of ast.declarations) {
            if (decl.kind === 'Function') {
                this.collectFunctionSignature(decl as FunctionNode);
            }
        }
    }

    private collectFunctionSignature(node: FunctionNode): void {
        const returnType = this.typeNodeToTypeInfo(node.returnType);
        const parameters: FunctionParameter[] = node.parameters.map(p => ({
            name: p.name,
            type: this.typeNodeToTypeInfo(p.type),
            isConst: p.isConst,
        }));

        const sig: FunctionSignature = {
            name: node.name,
            returnType,
            parameters,
            loc: node.loc,
            isBuiltin: false,
        };

        // Allow redefinition if it's the same function (forward declaration)
        if (this.symbolTable.hasFunction(node.name)) {
            // For now, allow redefinition (forward declarations + definitions)
            // A more complete implementation would check signature compatibility
        }
        this.symbolTable.defineFunction(sig);
    }

    // =========================================================================
    // Pass 3: Analyze Declarations
    // =========================================================================

    private analyzeDeclarations(ast: ModuleNode): void {
        for (const decl of ast.declarations) {
            this.analyzeDeclaration(decl);
        }
    }

    private analyzeDeclaration(decl: DeclarationNode): void {
        switch (decl.kind) {
            case 'Function':
                this.analyzeFunction(decl as FunctionNode);
                break;
            case 'VariableDeclaration':
                this.analyzeGlobalVariable(decl as VariableDeclarationNode);
                break;
            case 'StructDefinition':
                this.analyzeStructDefinition(decl as StructDefinitionNode);
                break;
            case 'Typedef':
                // Already processed in pass 1
                break;
        }
    }

    // =========================================================================
    // Function Analysis
    // =========================================================================

    private analyzeFunction(node: FunctionNode): void {
        // Track return type for return statement checking
        // Use type-aware lookup to correctly handle function overloading
        // (e.g., CLAMP(float3,...) vs CLAMP(float4,...))
        const paramTypes = node.parameters.map(p => this.typeNodeToTypeInfo(p.type));
        const sig = this.symbolTable.lookupFunctionOverloadByTypes(node.name, paramTypes);
        this.currentFunctionReturnType = sig?.returnType;
        this.currentFunctionName = node.name;

        // Enter function scope
        this.symbolTable.enterScope(`function:${node.name}`);

        // Add parameters to scope
        for (const param of node.parameters) {
            const typeInfo = this.typeNodeToTypeInfo(param.type);
            // Allow unspecified first dimension for array parameters (e.g., arr[] or arr[][10])
            this.checkArraySize(param.type, param.loc, /* allowUnspecified */ true);
            this.checkVoidType(typeInfo, param.loc, param.name);

            const symbol: Symbol = {
                name: param.name,
                kind: 'parameter',
                type: typeInfo,
                loc: param.loc,
                isConst: param.isConst,
            };

            if (!this.symbolTable.define(symbol)) {
                this.addError('SEM009', `Parameter '${param.name}' is already defined`, param.loc);
            }
        }

        // Analyze function body
        if (node.body) {
            this.analyzeBlock(node.body);

            // Check for unused variables before exiting scope
            // Only check for actual function definitions, not forward declarations
            this.checkUnusedSymbols(this.symbolTable.getCurrentScope());
        }
        // Skip unused check for forward declarations (no body) since parameters
        // aren't used in declarations, only in definitions

        // Exit function scope
        this.symbolTable.exitScope();

        // Clear function tracking
        this.currentFunctionReturnType = undefined;
        this.currentFunctionName = undefined;
    }

    // =========================================================================
    // Variable Analysis
    // =========================================================================

    private analyzeGlobalVariable(node: VariableDeclarationNode): void {
        const typeInfo = this.typeNodeToTypeInfo(node.type);

        // Check if type is valid (defined)
        if (!this.symbolTable.isValidType(typeInfo.name)) {
            this.addError('SEM003', `Undefined type '${typeInfo.name}'`, node.loc);
            return;
        }

        // Check array size
        this.checkArraySize(node.type, node.loc);

        // Check void type
        this.checkVoidType(typeInfo, node.loc, node.name);

        // Add to global scope
        const symbol: Symbol = {
            name: node.name,
            kind: 'variable',
            type: typeInfo,
            loc: node.loc,
            isConst: node.isConst,
        };

        if (!this.symbolTable.defineGlobal(symbol)) {
            this.addError('SEM009', `Global variable '${node.name}' is already defined`, node.loc);
        }

        // Analyze initializer
        if (node.initializer) {
            this.analyzeExpression(node.initializer);
        }
    }

    private analyzeLocalVariable(node: VariableDeclarationNode): void {
        const typeInfo = this.typeNodeToTypeInfo(node.type);

        // Check if type is valid (defined)
        if (!this.symbolTable.isValidType(typeInfo.name)) {
            this.addError('SEM003', `Undefined type '${typeInfo.name}'`, node.loc);
            return;
        }

        // Check array size
        // Allow unspecified first dimension if there's an initializer (size inferred from init)
        // e.g., char str[] = "hello"; is valid in C
        const hasInitializer = node.initializer !== null;
        this.checkArraySize(node.type, node.loc, /* allowUnspecified */ hasInitializer);

        // Check void type
        this.checkVoidType(typeInfo, node.loc, node.name);

        // Check for variable shadowing (before defining in current scope)
        const existingSymbol = this.symbolTable.lookup(node.name);
        if (existingSymbol && !existingSymbol.isBuiltin) {
            this.addWarning(
                'SEM_W001',
                `Variable '${node.name}' shadows outer scope variable declared at line ${existingSymbol.loc.line}`,
                node.loc
            );
        }

        // Add to current scope
        const symbol: Symbol = {
            name: node.name,
            kind: 'variable',
            type: typeInfo,
            loc: node.loc,
            isConst: node.isConst,
        };

        if (!this.symbolTable.define(symbol)) {
            this.addError('SEM009', `Variable '${node.name}' is already defined in this scope`, node.loc);
        }

        // Analyze initializer
        if (node.initializer) {
            this.analyzeExpression(node.initializer);
        }
    }

    // =========================================================================
    // Struct Analysis
    // =========================================================================

    private analyzeStructDefinition(node: StructDefinitionNode): void {
        for (const member of node.members) {
            const typeInfo = this.typeNodeToTypeInfo(member.type);
            this.checkArraySize(member.type, member.loc);
            this.checkVoidType(typeInfo, member.loc, member.name);
        }
    }

    // =========================================================================
    // Statement Analysis
    // =========================================================================

    private analyzeStatement(stmt: StatementNode): void {
        switch (stmt.kind) {
            case 'Block':
                this.analyzeBlock(stmt as BlockNode);
                break;
            case 'VariableDeclaration':
                this.analyzeLocalVariable(stmt as VariableDeclarationNode);
                break;
            case 'ExpressionStatement':
                this.analyzeExpressionStatement(stmt as ExpressionStatementNode);
                break;
            case 'If':
                this.analyzeIf(stmt as IfNode);
                break;
            case 'While':
                this.analyzeWhile(stmt as WhileNode);
                break;
            case 'For':
                this.analyzeFor(stmt as ForNode);
                break;
            case 'DoWhile':
                this.analyzeDoWhile(stmt as DoWhileNode);
                break;
            case 'Switch':
                this.analyzeSwitch(stmt as SwitchNode);
                break;
            case 'Return':
                this.analyzeReturn(stmt as ReturnNode);
                break;
            case 'Break':
                if (this.inLoop === 0 && this.inSwitch === 0) {
                    this.addError('SEM012', 'Break statement outside loop or switch', stmt.loc);
                }
                break;
            case 'Continue':
                if (this.inLoop === 0) {
                    this.addError('SEM013', 'Continue statement outside loop', stmt.loc);
                }
                break;
            case 'EmptyStatement':
                // Nothing to analyze
                break;
            // Support typedef and struct definitions inside function bodies
            case 'Typedef':
                // Register the local typedef
                this.collectTypedef(stmt as TypedefNode);
                break;
            case 'StructDefinition':
                // Register the local struct definition
                this.collectStruct(stmt as StructDefinitionNode);
                this.analyzeStructDefinition(stmt as StructDefinitionNode);
                break;
        }
    }

    private analyzeBlock(block: BlockNode): void {
        // Check if this is a "synthetic" block from comma-separated declarations
        // e.g., "float x, y, z;" becomes a Block with multiple VariableDeclarations
        // These should NOT create a new scope - variables should be in the parent scope
        // Note: synthetic blocks always have 2+ declarations (parser only creates them
        // when declarations.length > 1). A real code block like { int x; } has length 1.
        const isSyntheticDeclarationBlock = block.statements.length > 1 &&
            block.statements.every(s => s.kind === 'VariableDeclaration');

        if (isSyntheticDeclarationBlock) {
            // Don't create new scope - just analyze the declarations in current scope
            for (const stmt of block.statements) {
                this.analyzeStatement(stmt);
            }
        } else {
            // Normal block - create new scope
            this.symbolTable.enterScope('block');
            for (const stmt of block.statements) {
                this.analyzeStatement(stmt);
            }
            // Check for unused symbols before exiting scope
            this.checkUnusedSymbols(this.symbolTable.getCurrentScope());
            this.symbolTable.exitScope();
        }
    }

    private analyzeExpressionStatement(stmt: ExpressionStatementNode): void {
        this.analyzeExpression(stmt.expression);
    }

    private analyzeIf(stmt: IfNode): void {
        this.analyzeExpression(stmt.condition);
        this.analyzeStatement(stmt.thenBranch);
        if (stmt.elseBranch) {
            this.analyzeStatement(stmt.elseBranch);
        }
    }

    private analyzeWhile(stmt: WhileNode): void {
        this.analyzeExpression(stmt.condition);
        this.inLoop++;
        this.analyzeStatement(stmt.body);
        this.inLoop--;
    }

    private analyzeFor(stmt: ForNode): void {
        this.symbolTable.enterScope('for');

        if (stmt.init) {
            if (Array.isArray(stmt.init)) {
                for (const init of stmt.init) {
                    this.analyzeLocalVariable(init);
                }
            } else if (stmt.init.kind === 'VariableDeclaration') {
                this.analyzeLocalVariable(stmt.init as VariableDeclarationNode);
            } else {
                this.analyzeExpression(stmt.init as ExpressionNode);
            }
        }

        if (stmt.condition) {
            this.analyzeExpression(stmt.condition);
        }

        if (stmt.update) {
            this.analyzeExpression(stmt.update);
        }

        this.inLoop++;
        this.analyzeStatement(stmt.body);
        this.inLoop--;

        this.symbolTable.exitScope();
    }

    private analyzeDoWhile(stmt: DoWhileNode): void {
        this.inLoop++;
        this.analyzeStatement(stmt.body);
        this.inLoop--;
        this.analyzeExpression(stmt.condition);
    }

    private analyzeSwitch(stmt: SwitchNode): void {
        this.analyzeExpression(stmt.expression);
        this.inSwitch++;
        for (const caseNode of stmt.cases) {
            if (caseNode.value) {
                this.analyzeExpression(caseNode.value);
            }
            for (const caseStmt of caseNode.statements) {
                this.analyzeStatement(caseStmt);
            }
        }
        this.inSwitch--;
    }

    private analyzeReturn(stmt: ReturnNode): void {
        const returnType = stmt.value ? this.analyzeExpression(stmt.value) : undefined;

        // Check return type compatibility
        if (this.currentFunctionReturnType) {
            if (this.currentFunctionReturnType.isVoid) {
                if (returnType) {
                    this.addError(
                        'SEM016',
                        'Void function should not return a value',
                        stmt.loc
                    );
                }
            } else {
                if (!returnType && !stmt.value) {
                    this.addError(
                        'SEM017',
                        `Non-void function must return a value of type '${this.currentFunctionReturnType.name}'`,
                        stmt.loc
                    );
                } else if (returnType && !this.isTypeCompatible(returnType, this.currentFunctionReturnType)) {
                    this.addError(
                        'SEM010',
                        `Return type mismatch: expected '${this.currentFunctionReturnType.name}', got '${returnType.name}'`,
                        stmt.loc
                    );
                }
            }
        }
    }

    // =========================================================================
    // Expression Analysis
    // =========================================================================

    private analyzeExpression(expr: ExpressionNode): TypeInfo | undefined {
        switch (expr.kind) {
            case 'Identifier':
                return this.analyzeIdentifier(expr as IdentifierNode);
            case 'Literal':
                return this.analyzeLiteral(expr as LiteralNode);
            case 'BinaryExpression':
                return this.analyzeBinaryExpression(expr as BinaryExpressionNode);
            case 'UnaryExpression':
                return this.analyzeUnaryExpression(expr as UnaryExpressionNode);
            case 'CallExpression':
                return this.analyzeCallExpression(expr as CallExpressionNode);
            case 'MemberExpression':
                return this.analyzeMemberExpression(expr as MemberExpressionNode);
            case 'IndexExpression':
                return this.analyzeIndexExpression(expr as IndexExpressionNode);
            case 'AssignmentExpression':
                return this.analyzeAssignmentExpression(expr as AssignmentExpressionNode);
            case 'TernaryExpression':
                return this.analyzeTernaryExpression(expr as TernaryExpressionNode);
            case 'CastExpression':
                return this.analyzeCastExpression(expr as CastExpressionNode);
            case 'InitializerList':
                return this.analyzeInitializerList(expr as InitializerListNode);
            default:
                return undefined;
        }
    }

    private analyzeIdentifier(expr: IdentifierNode): TypeInfo | undefined {
        const symbol = this.symbolTable.lookup(expr.name);
        if (!symbol) {
            this.addError('SEM001', `Undefined variable '${expr.name}'`, expr.loc, expr.name);
            return undefined;
        }
        // Mark symbol as used for unused variable detection
        this.usedSymbols.add(expr.name);

        // Check if UI parameter is used outside the transform function
        // DaVinci Resolve expands UI params as local variables inside transform(),
        // so they are not accessible from helper functions.
        // Skip if a local variable shadows the UI param (resolved symbol differs from global).
        const globalSymbol = this.uiParamNames.has(expr.name) ? this.symbolTable.lookupGlobal(expr.name) : undefined;
        if (this.uiParamNames.has(expr.name) && this.currentFunctionName && this.currentFunctionName !== 'transform'
            && symbol === globalSymbol) {
            this.addError(
                'SEM018',
                `UI parameter '${expr.name}' used in helper function '${this.currentFunctionName}'. ` +
                `DaVinci Resolve only makes UI parameters available inside the transform function. ` +
                `Pass it as a function argument instead.`,
                expr.loc,
                expr.name
            );
        }

        return symbol.type;
    }

    private analyzeLiteral(expr: LiteralNode): TypeInfo {
        switch (expr.literalType) {
            case 'int':
                return createTypeInfo('int');
            case 'float':
                return createTypeInfo('float');
            case 'bool':
                return createTypeInfo('bool');
            case 'string':
                return createTypeInfo('char', { isArray: true });
            default:
                return createTypeInfo('int');
        }
    }

    private analyzeBinaryExpression(expr: BinaryExpressionNode): TypeInfo | undefined {
        const leftType = this.analyzeExpression(expr.left);
        const rightType = this.analyzeExpression(expr.right);

        // Comparison operators return bool/int
        const comparisonOps = ['==', '!=', '<', '>', '<=', '>='];
        if (comparisonOps.includes(expr.operator)) {
            return createTypeInfo('int'); // C uses int for boolean
        }

        // Logical operators return bool/int
        const logicalOps = ['&&', '||'];
        if (logicalOps.includes(expr.operator)) {
            return createTypeInfo('int');
        }

        // For arithmetic operators, handle scalar/vector operations
        // If one operand is a vector, the result is that vector type (scalar is broadcast)
        if (leftType && rightType) {
            const leftIsVector = isVectorType(leftType.name);
            const rightIsVector = isVectorType(rightType.name);

            if (leftIsVector && !rightIsVector) {
                return leftType; // vector op scalar -> vector
            }
            if (!leftIsVector && rightIsVector) {
                return rightType; // scalar op vector -> vector
            }
        }

        // For same types or both scalars, return left type
        return leftType;
    }

    private analyzeUnaryExpression(expr: UnaryExpressionNode): TypeInfo | undefined {
        return this.analyzeExpression(expr.operand);
    }

    private analyzeCallExpression(expr: CallExpressionNode): TypeInfo | undefined {
        // Analyze arguments first and collect their types
        const argTypes: (TypeInfo | undefined)[] = [];
        for (const arg of expr.arguments) {
            argTypes.push(this.analyzeExpression(arg));
        }

        // Check if callee is an identifier (function name)
        if (expr.callee.kind === 'Identifier') {
            const funcName = (expr.callee as IdentifierNode).name;

            // Track called function for unused function detection
            this.calledFunctions.add(funcName);

            // Look up function with overloading support - prefer type-based lookup
            const validArgTypes = argTypes.filter((t): t is TypeInfo => t !== undefined);
            let func = validArgTypes.length === expr.arguments.length
                ? this.symbolTable.lookupFunctionOverloadByTypes(funcName, validArgTypes)
                : undefined;

            // Fall back to count-based lookup if type-based lookup failed
            if (!func) {
                func = this.symbolTable.lookupFunctionOverload(funcName, expr.arguments.length);
            }

            // For element-wise functions, prefer the builtin registration (empty params)
            // over type header declarations, so element-wise inference handles return types
            // and type checking is skipped (these functions accept any scalar/vector type).
            if (func && !func.isBuiltin &&
                (ELEMENTWISE_MATH_FUNCTIONS.has(funcName) || ELEMENTWISE_BINARY_FUNCTIONS.has(funcName))) {
                const builtinOverload = this.symbolTable.getFunctionOverloads(funcName)
                    .find(s => s.isBuiltin && s.parameters.length === 0);
                if (builtinOverload) {
                    func = builtinOverload;
                }
            }

            if (!func) {
                // Check if any overload exists
                const anyOverload = this.symbolTable.lookupFunction(funcName);
                if (anyOverload) {
                    // Function exists but wrong argument count
                    const overloads = this.symbolTable.getFunctionOverloads(funcName);
                    const paramCounts = overloads.map(o => o.parameters.length).join(', ');
                    this.addError(
                        'SEM015',
                        `Function '${funcName}' expects ${paramCounts} argument(s), got ${expr.arguments.length}`,
                        expr.loc
                    );
                    // Return first overload's return type for continued analysis
                    return anyOverload.returnType;
                }

                // Check if it's a variable being called (error)
                const symbol = this.symbolTable.lookup(funcName);
                if (symbol) {
                    this.addError('SEM008', `'${funcName}' is not a function`, expr.loc, funcName);
                } else {
                    this.addError('SEM002', `Undefined function '${funcName}'`, expr.loc, funcName);
                }
                return undefined;
            }

            // Validate argument types (skip for builtins with empty params)
            if (!func.isBuiltin && func.parameters.length > 0) {
                // Validate argument types
                for (let i = 0; i < func.parameters.length; i++) {
                    const argType = argTypes[i];
                    const paramType = func.parameters[i].type;
                    if (argType && !this.isTypeCompatible(argType, paramType)) {
                        this.addError(
                            'SEM010',
                            `Argument ${i + 1}: expected '${paramType.name}', got '${argType.name}'`,
                            expr.arguments[i].loc
                        );
                    }
                }
            }

            // For element-wise math functions, infer return type from argument type
            // e.g., sin(float3) → float3, pow(float2, float2) → float2
            if (func.isBuiltin && argTypes.length > 0 && argTypes[0]) {
                const firstArgType = argTypes[0];

                // Single-argument element-wise functions
                if (ELEMENTWISE_MATH_FUNCTIONS.has(funcName)) {
                    // Return type matches the first argument type
                    if (isVectorType(firstArgType.name) || firstArgType.name === 'float' ||
                        firstArgType.name === 'half' || firstArgType.name === 'double') {
                        return firstArgType;
                    }
                }

                // Two-argument element-wise functions (pow, min, max, etc.)
                if (ELEMENTWISE_BINARY_FUNCTIONS.has(funcName) && argTypes.length >= 2) {
                    const secondArgType = argTypes[1];
                    // Return the "larger" type (vector > scalar)
                    if (secondArgType) {
                        if (isVectorType(firstArgType.name)) {
                            return firstArgType;
                        } else if (isVectorType(secondArgType.name)) {
                            return secondArgType;
                        }
                        // Both scalars - return first arg type
                        return firstArgType;
                    }
                }
            }

            return func.returnType;
        }

        // For other callees (e.g., member expressions), analyze the callee
        const calleeType = this.analyzeExpression(expr.callee);
        if (calleeType) {
            this.addError('SEM008', 'Cannot call non-function', expr.loc);
        }
        return undefined;
    }

    private analyzeMemberExpression(expr: MemberExpressionNode): TypeInfo | undefined {
        const objectType = this.analyzeExpression(expr.object);

        if (!objectType) {
            return undefined;
        }

        // Resolve typedef aliases to get the underlying type name
        const resolvedTypeName = this.symbolTable.resolveType(objectType.name);

        // Check if object is a struct (using resolved type name)
        const structInfo = this.symbolTable.lookupStruct(resolvedTypeName);
        if (structInfo) {
            const field = structInfo.fields.find(f => f.name === expr.property);
            if (field) {
                return field.type;
            }
            // Field not found, but don't error - could be swizzle for vectors
        }

        // Check if it's a vector type (swizzle access) - using resolved type name
        if (isVectorType(resolvedTypeName)) {
            // Valid swizzle components
            const validSwizzle = /^[xyzwrgba]+$/;
            if (validSwizzle.test(expr.property)) {
                const elementType = resolvedTypeName.replace(/[234]$/, '');
                if (expr.property.length === 1) {
                    return createTypeInfo(elementType);
                } else {
                    return createTypeInfo(`${elementType}${expr.property.length}`);
                }
            }
        }

        // Not a struct or valid vector swizzle
        if (!structInfo && !isVectorType(resolvedTypeName)) {
            this.addError(
                'SEM007',
                `Cannot access member '${expr.property}' of non-struct type '${objectType.name}'`,
                expr.loc
            );
        }

        return undefined;
    }

    private analyzeIndexExpression(expr: IndexExpressionNode): TypeInfo | undefined {
        const objectType = this.analyzeExpression(expr.object);
        this.analyzeExpression(expr.index);

        if (!objectType) {
            return undefined;
        }

        // Check if object is an array, vector, matrix, or pointer (pointers can be indexed like arrays)
        const isMatrix = objectType.name === 'mat3' || objectType.name === 'mat4' ||
                        objectType.name === 'float3x3' || objectType.name === 'float4x4';

        if (!objectType.isArray && !objectType.isPointer && !isVectorType(objectType.name) && !isMatrix) {
            this.addError(
                'SEM006',
                `Cannot index non-array type '${objectType.name}'`,
                expr.loc
            );
            return undefined;
        }

        // Return element type
        if (objectType.isArray) {
            // Check for multi-dimensional arrays
            if (objectType.arraySizes && objectType.arraySizes.length > 1) {
                // Remove first dimension, keep remaining
                const remainingSizes = objectType.arraySizes.slice(1);
                return {
                    ...objectType,
                    isArray: true,
                    arraySize: remainingSizes.length === 1 ? remainingSizes[0] : null,
                    arraySizes: remainingSizes.length > 1 ? remainingSizes : undefined,
                };
            }
            // Single dimension array - return element type
            return {
                ...objectType,
                isArray: false,
                arraySize: undefined,
                arraySizes: undefined,
            };
        }

        // Pointer indexing (like array) returns element type
        if (objectType.isPointer) {
            return {
                ...objectType,
                isPointer: false,
            };
        }

        // Matrix indexing returns a row vector
        if (isMatrix) {
            const size = objectType.name.includes('3') ? 3 : 4;
            return createTypeInfo(`float${size}`);
        }

        // Vector indexing returns the element type
        const elementType = objectType.name.replace(/[234]$/, '');
        return createTypeInfo(elementType);
    }

    private analyzeAssignmentExpression(expr: AssignmentExpressionNode): TypeInfo | undefined {
        const leftType = this.analyzeExpression(expr.left);
        const rightType = this.analyzeExpression(expr.right);

        // Check if assigning to const
        if (expr.left.kind === 'Identifier') {
            const symbol = this.symbolTable.lookup((expr.left as IdentifierNode).name);
            if (symbol?.isConst) {
                this.addError(
                    'SEM014',
                    `Cannot assign to constant variable '${symbol.name}'`,
                    expr.loc
                );
            }
        }

        return leftType;
    }

    private analyzeTernaryExpression(expr: TernaryExpressionNode): TypeInfo | undefined {
        this.analyzeExpression(expr.condition);
        const thenType = this.analyzeExpression(expr.thenExpr);
        this.analyzeExpression(expr.elseExpr);
        return thenType;
    }

    private analyzeCastExpression(expr: CastExpressionNode): TypeInfo {
        this.analyzeExpression(expr.expression);
        return this.typeNodeToTypeInfo(expr.type);
    }

    private analyzeInitializerList(expr: InitializerListNode): TypeInfo | undefined {
        for (const element of expr.elements) {
            this.analyzeExpression(element);
        }
        // Cannot determine type from initializer list alone
        return undefined;
    }

    // =========================================================================
    // Type Checks
    // =========================================================================

    /**
     * Check array size validity
     * @param type The type node to check
     * @param loc Source location for error reporting
     * @param allowUnspecified If true, -1 is allowed for unspecified dimensions (e.g., function parameters)
     */
    private checkArraySize(type: TypeNode, loc: SourceLocation, allowUnspecified = false): void {
        // -1 means the parser couldn't evaluate the size at parse time.
        // This can happen when:
        // 1. The bracket is empty: arr[] (unspecified dimension)
        // 2. The size is a constant expression: arr[N_KNOTS_LOW] where N_KNOTS_LOW is a const variable
        //
        // For case 1, we check allowUnspecified.
        // For case 2, we check if there's an arraySizeExprs - if so, the expression exists but couldn't be
        // evaluated at parse time (e.g., const variable reference). We defer to codegen evaluation.

        const hasExprsForSize = type.arraySizeExprs && type.arraySizeExprs.some(e => e !== null);

        // Check single dimension array
        if (type.isArray && type.arraySize !== null && type.arraySize !== undefined) {
            // -1 is sentinel for unspecified dimension (e.g., arr[] in function params)
            // or unevaluated expression (e.g., arr[CONST_VAR])
            if (type.arraySize <= 0) {
                const isUnspecifiedAllowed = allowUnspecified && type.arraySize === -1;
                const hasUnevaluatedExpr = hasExprsForSize && type.arraySize === -1;
                if (!isUnspecifiedAllowed && !hasUnevaluatedExpr) {
                    this.addError(
                        'SEM004',
                        `Array size must be positive integer, got ${type.arraySize}`,
                        loc
                    );
                }
            }
        }

        // Check multi-dimensional array
        if (type.arraySizes) {
            for (let i = 0; i < type.arraySizes.length; i++) {
                const size = type.arraySizes[i];
                // In C, only the first dimension can be unspecified for function parameters
                // e.g., void f(int arr[][10]) is valid, void f(int arr[5][]) is NOT valid
                const isFirstDimension = i === 0;
                if (size <= 0) {
                    const isUnspecifiedAllowed = allowUnspecified && isFirstDimension && size === -1;
                    // For multi-dim, check if the corresponding expression exists
                    const hasUnevaluatedExpr =
                        type.arraySizeExprs &&
                        i < type.arraySizeExprs.length &&
                        type.arraySizeExprs[i] !== null &&
                        size === -1;
                    if (!isUnspecifiedAllowed && !hasUnevaluatedExpr) {
                        this.addError(
                            'SEM004',
                            `Array size must be positive integer, got ${size}`,
                            loc
                        );
                    }
                }
            }
        }
    }

    private checkVoidType(type: TypeInfo, loc: SourceLocation, name: string): void {
        if (type.isVoid && !type.isPointer) {
            this.addError(
                'SEM005',
                `Cannot declare variable '${name}' of type void`,
                loc
            );
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private typeNodeToTypeInfo(node: TypeNode): TypeInfo {
        return {
            name: node.name,
            isArray: node.isArray,
            arraySize: node.arraySize,
            arraySizes: node.arraySizes,
            isPointer: node.isPointer,
            isConst: node.isConst,
            isVoid: node.name === 'void',
        };
    }

    private addError(
        code: string,
        message: string,
        loc: SourceLocation,
        identifier?: string
    ): void {
        this.errors.push({
            code,
            message,
            line: loc.line,
            column: loc.column,
            identifier,
        });
    }

    private addWarning(
        code: string,
        message: string,
        loc: SourceLocation
    ): void {
        this.warnings.push({
            code,
            message,
            line: loc.line,
            column: loc.column,
        });
    }

    // =========================================================================
    // Warning Checks
    // =========================================================================

    /**
     * Check for unused symbols in a scope
     */
    private checkUnusedSymbols(scope: Scope): void {
        for (const symbol of scope.getAllSymbols()) {
            if (symbol.isBuiltin) continue;
            if (symbol.kind !== 'variable' && symbol.kind !== 'parameter') continue;

            // Skip parameters with p_ prefix (DCTL convention for transform/transition params)
            if (symbol.kind === 'parameter' && symbol.name.startsWith('p_')) continue;

            if (!this.usedSymbols.has(symbol.name)) {
                const prefix = symbol.kind === 'parameter' ? 'Parameter' : 'Variable';
                this.addWarning(
                    'SEM_W002',
                    `${prefix} '${symbol.name}' is declared but never used`,
                    symbol.loc
                );
            }
        }
    }

    /**
     * Check for unused functions
     */
    private checkUnusedFunctions(): void {
        for (const func of this.symbolTable.getAllFunctions()) {
            if (func.isBuiltin) continue;
            // Entry points are always considered used
            if (func.name === 'transform' || func.name === 'transition') continue;

            if (!this.calledFunctions.has(func.name)) {
                this.addWarning(
                    'SEM_W003',
                    `Function '${func.name}' is defined but never called`,
                    func.loc
                );
            }
        }
    }

    /**
     * Check if two types are compatible (for assignments and arguments)
     */
    private isTypeCompatible(actual: TypeInfo, expected: TypeInfo): boolean {
        // Resolve typedef aliases before comparing
        const actualName = this.symbolTable.resolveType(actual.name);
        const expectedName = this.symbolTable.resolveType(expected.name);

        // Exact match (after resolving typedefs)
        if (actualName === expectedName) {
            // Same base type - check array/pointer compatibility
            if (actual.isArray === expected.isArray) {
                return true;
            }
            // C array-to-pointer decay: arrays can be passed to pointer parameters
            // e.g., float[3] is compatible with float*
            if (actual.isArray && expected.isPointer) {
                return true;
            }
            // Also allow pointer to array (less common but valid in some contexts)
            if (actual.isPointer && expected.isArray) {
                return true;
            }
            return false;
        }

        // bool is compatible with int (C uses int for boolean)
        if ((actualName === 'bool' && expectedName === 'int') ||
            (actualName === 'int' && expectedName === 'bool')) {
            return true;
        }

        // Implicit numeric conversions
        const numericTypes = ['int', 'uint', 'float', 'double', 'half', 'bool'];
        if (numericTypes.includes(actualName) && numericTypes.includes(expectedName)) {
            return true; // Allow implicit conversion between numeric types
        }

        // Vector type compatibility (same size, different base type)
        const vectorMatch = actualName.match(/^(float|int|half|uint)([234])$/);
        const expectedMatch = expectedName.match(/^(float|int|half|uint)([234])$/);
        if (vectorMatch && expectedMatch && vectorMatch[2] === expectedMatch[2]) {
            return true; // Same-size vectors are compatible
        }

        // Note: Scalar to vector implicit conversion (broadcast) is NOT allowed
        // for function arguments and return types. Use explicit constructors like
        // make_float3(scalar, scalar, scalar) instead.
        // Broadcast only applies in binary operations (handled elsewhere).

        return false;
    }
}
