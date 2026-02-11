/**
 * DCTL Abstract Syntax Tree Nodes
 *
 * Defines all AST node types for representing DCTL programs.
 */

// =============================================================================
// Base Types
// =============================================================================

export interface SourceLocation {
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
}

export interface ASTNode {
    kind: string;
    loc: SourceLocation;
}

// =============================================================================
// Program Structure
// =============================================================================

export interface ModuleNode extends ASTNode {
    kind: 'Module';
    declarations: DeclarationNode[];
    macros: MacroNode[];
}

export type DeclarationNode =
    | FunctionNode
    | VariableDeclarationNode
    | StructDefinitionNode
    | TypedefNode;

// =============================================================================
// DCTL Macros
// =============================================================================

export interface MacroNode extends ASTNode {
    kind: 'Macro';
    name: string;
    arguments: string[];
    rawText: string;
}

export interface UIParamNode extends ASTNode {
    kind: 'UIParam';
    name: string;
    label: string;
    uiType: string;
    defaultValue?: number | string;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
}

export interface AlphaModeNode extends ASTNode {
    kind: 'AlphaMode';
    mode: 'STRAIGHT' | 'PREMULTIPLIED' | 'OPAQUE' | string;
}

// =============================================================================
// Functions
// =============================================================================

export interface FunctionNode extends ASTNode {
    kind: 'Function';
    name: string;
    returnType: TypeNode;
    parameters: ParameterNode[];
    body: BlockNode | null;  // null for declarations
    modifiers: ModifierNode[];
    isEntryPoint: boolean;
}

export interface ParameterNode extends ASTNode {
    kind: 'Parameter';
    name: string;
    type: TypeNode;
    isConst: boolean;
}

export interface ModifierNode extends ASTNode {
    kind: 'Modifier';
    modifier: '__DEVICE__' | '__CONSTANT__' | '__GLOBAL__' | '__LOCAL__' | '__PRIVATE__' | 'const' | 'static' | 'inline';
}

// =============================================================================
// Types
// =============================================================================

export interface TypeNode extends ASTNode {
    kind: 'Type';
    name: string;
    isPointer: boolean;
    isArray: boolean;
    arraySize?: number | null;  // null for unsized arrays (single dimension)
    arraySizes?: number[];      // Multi-dimensional array sizes, e.g., [3, 3] for float[3][3]
    arraySizeExprs?: ExpressionNode[];  // Original size expressions for const variable evaluation
    isConst: boolean;
}

export interface StructDefinitionNode extends ASTNode {
    kind: 'StructDefinition';
    name: string;
    members: StructMemberNode[];
}

export interface StructMemberNode extends ASTNode {
    kind: 'StructMember';
    name: string;
    type: TypeNode;
}

export interface TypedefNode extends ASTNode {
    kind: 'Typedef';
    name: string;
    type: TypeNode;
}

// =============================================================================
// Statements
// =============================================================================

export type StatementNode =
    | BlockNode
    | VariableDeclarationNode
    | ExpressionStatementNode
    | IfNode
    | WhileNode
    | ForNode
    | DoWhileNode
    | SwitchNode
    | ReturnNode
    | BreakNode
    | ContinueNode
    | EmptyStatementNode
    | TypedefNode          // typedef can appear inside function bodies
    | StructDefinitionNode; // struct definitions can appear inside function bodies

export interface BlockNode extends ASTNode {
    kind: 'Block';
    statements: StatementNode[];
}

export interface VariableDeclarationNode extends ASTNode {
    kind: 'VariableDeclaration';
    name: string;
    type: TypeNode;
    initializer: ExpressionNode | null;
    isConst: boolean;
    isStatic?: boolean;
}

export interface ExpressionStatementNode extends ASTNode {
    kind: 'ExpressionStatement';
    expression: ExpressionNode;
}

export interface IfNode extends ASTNode {
    kind: 'If';
    condition: ExpressionNode;
    thenBranch: StatementNode;
    elseBranch: StatementNode | null;
}

export interface WhileNode extends ASTNode {
    kind: 'While';
    condition: ExpressionNode;
    body: StatementNode;
}

export interface ForNode extends ASTNode {
    kind: 'For';
    init: VariableDeclarationNode | VariableDeclarationNode[] | ExpressionNode | null;
    condition: ExpressionNode | null;
    update: ExpressionNode | null;
    body: StatementNode;
}

export interface DoWhileNode extends ASTNode {
    kind: 'DoWhile';
    body: StatementNode;
    condition: ExpressionNode;
}

export interface SwitchNode extends ASTNode {
    kind: 'Switch';
    expression: ExpressionNode;
    cases: CaseNode[];
}

export interface CaseNode extends ASTNode {
    kind: 'Case';
    value: ExpressionNode | null;  // null for default
    statements: StatementNode[];
}

export interface ReturnNode extends ASTNode {
    kind: 'Return';
    value: ExpressionNode | null;
}

export interface BreakNode extends ASTNode {
    kind: 'Break';
}

export interface ContinueNode extends ASTNode {
    kind: 'Continue';
}

export interface EmptyStatementNode extends ASTNode {
    kind: 'EmptyStatement';
}

// =============================================================================
// Expressions
// =============================================================================

export type ExpressionNode =
    | BinaryExpressionNode
    | UnaryExpressionNode
    | TernaryExpressionNode
    | CallExpressionNode
    | MemberExpressionNode
    | IndexExpressionNode
    | AssignmentExpressionNode
    | IdentifierNode
    | LiteralNode
    | CastExpressionNode
    | SizeofExpressionNode
    | InitializerListNode
    | StatementExpressionNode;

export interface BinaryExpressionNode extends ASTNode {
    kind: 'BinaryExpression';
    operator: string;
    left: ExpressionNode;
    right: ExpressionNode;
}

export interface UnaryExpressionNode extends ASTNode {
    kind: 'UnaryExpression';
    operator: string;
    operand: ExpressionNode;
    prefix: boolean;
}

export interface TernaryExpressionNode extends ASTNode {
    kind: 'TernaryExpression';
    condition: ExpressionNode;
    thenExpr: ExpressionNode;
    elseExpr: ExpressionNode;
}

export interface CallExpressionNode extends ASTNode {
    kind: 'CallExpression';
    callee: ExpressionNode;
    arguments: ExpressionNode[];
}

export interface MemberExpressionNode extends ASTNode {
    kind: 'MemberExpression';
    object: ExpressionNode;
    property: string;
    isArrow: boolean;
}

export interface IndexExpressionNode extends ASTNode {
    kind: 'IndexExpression';
    object: ExpressionNode;
    index: ExpressionNode;
}

export interface AssignmentExpressionNode extends ASTNode {
    kind: 'AssignmentExpression';
    operator: string;
    left: ExpressionNode;
    right: ExpressionNode;
}

export interface IdentifierNode extends ASTNode {
    kind: 'Identifier';
    name: string;
}

export interface LiteralNode extends ASTNode {
    kind: 'Literal';
    value: number | string | boolean;
    literalType: 'int' | 'uint' | 'float' | 'string' | 'bool';
    /** For float literals: whether 'f'/'h' suffix was present */
    hasFloatSuffix?: boolean;
    /** Raw string representation of the literal (e.g., "3.0" vs 3) */
    rawValue?: string;
}

export interface CastExpressionNode extends ASTNode {
    kind: 'CastExpression';
    type: TypeNode;
    expression: ExpressionNode;
}

export interface SizeofExpressionNode extends ASTNode {
    kind: 'SizeofExpression';
    operand: TypeNode | ExpressionNode;
}

export interface InitializerListNode extends ASTNode {
    kind: 'InitializerList';
    elements: ExpressionNode[];
}

/**
 * GCC Statement Expression (GNU C extension)
 * Syntax: ({ statement1; statement2; ...; expression; })
 * The value of the expression is the value of the last expression in the block.
 */
export interface StatementExpressionNode extends ASTNode {
    kind: 'StatementExpression';
    statements: StatementNode[];
    /** The value expression (last statement's expression, or null if no value) */
    value: ExpressionNode | null;
}

// =============================================================================
// Parse Error
// =============================================================================

export interface ParseError {
    message: string;
    line: number;
    column: number;
    expected?: string;
    found?: string;
}

// =============================================================================
// Parse Result
// =============================================================================

export interface ParseResult {
    ast: ModuleNode | null;
    errors: ParseError[];
}

// =============================================================================
// AST Utilities
// =============================================================================

/**
 * Check if a function is a DCTL entry point (transform or transition)
 */
export function isEntryPoint(func: FunctionNode): boolean {
    if (func.name !== 'transform' && func.name !== 'transition') {
        return false;
    }
    // Must have __DEVICE__ modifier
    return func.modifiers.some(m => m.modifier === '__DEVICE__');
}

/**
 * Get the signature type of a transform function
 */
export function getTransformSignature(func: FunctionNode): string | null {
    if (func.name !== 'transform') return null;
    if (!isEntryPoint(func)) return null;

    const returnType = func.returnType.name;
    const hasTexture = func.parameters.some(p =>
        p.type.name === '__TEXTURE__' ||
        p.type.name === '__TEXTURE2D__' ||
        p.type.name === '__TEXTURE3D__'
    );

    if (returnType === 'float4') {
        return hasTexture ? 'rgba_texture' : 'rgba_buffer';
    } else if (returnType === 'float3') {
        return hasTexture ? 'rgb_texture' : 'rgb_buffer';
    }

    return null;
}

/**
 * Visit all nodes in an AST
 */
export function visitAST(
    node: ASTNode,
    visitor: (node: ASTNode, parent: ASTNode | null) => void,
    parent: ASTNode | null = null
): void {
    visitor(node, parent);

    // Visit children based on node type
    switch (node.kind) {
        case 'Module':
            const module = node as ModuleNode;
            module.declarations.forEach(d => visitAST(d, visitor, node));
            module.macros.forEach(m => visitAST(m, visitor, node));
            break;

        case 'Function':
            const func = node as FunctionNode;
            visitAST(func.returnType, visitor, node);
            func.parameters.forEach(p => visitAST(p, visitor, node));
            func.modifiers.forEach(m => visitAST(m, visitor, node));
            if (func.body) visitAST(func.body, visitor, node);
            break;

        case 'Block':
            const block = node as BlockNode;
            block.statements.forEach(s => visitAST(s, visitor, node));
            break;

        case 'If':
            const ifNode = node as IfNode;
            visitAST(ifNode.condition, visitor, node);
            visitAST(ifNode.thenBranch, visitor, node);
            if (ifNode.elseBranch) visitAST(ifNode.elseBranch, visitor, node);
            break;

        case 'While':
            const whileNode = node as WhileNode;
            visitAST(whileNode.condition, visitor, node);
            visitAST(whileNode.body, visitor, node);
            break;

        case 'For':
            const forNode = node as ForNode;
            if (forNode.init) {
                if (Array.isArray(forNode.init)) {
                    forNode.init.forEach(initNode => visitAST(initNode, visitor, node));
                } else {
                    visitAST(forNode.init, visitor, node);
                }
            }
            if (forNode.condition) visitAST(forNode.condition, visitor, node);
            if (forNode.update) visitAST(forNode.update, visitor, node);
            visitAST(forNode.body, visitor, node);
            break;

        case 'Return':
            const returnNode = node as ReturnNode;
            if (returnNode.value) visitAST(returnNode.value, visitor, node);
            break;

        case 'ExpressionStatement':
            const exprStmt = node as ExpressionStatementNode;
            visitAST(exprStmt.expression, visitor, node);
            break;

        case 'DoWhile':
            const doWhileNode = node as DoWhileNode;
            visitAST(doWhileNode.body, visitor, node);
            visitAST(doWhileNode.condition, visitor, node);
            break;

        case 'Switch':
            const switchNode = node as SwitchNode;
            visitAST(switchNode.expression, visitor, node);
            switchNode.cases.forEach(c => visitAST(c, visitor, node));
            break;

        case 'Case':
            const caseNode = node as CaseNode;
            if (caseNode.value) visitAST(caseNode.value, visitor, node);
            caseNode.statements.forEach(s => visitAST(s, visitor, node));
            break;

        case 'BinaryExpression':
            const binExpr = node as BinaryExpressionNode;
            visitAST(binExpr.left, visitor, node);
            visitAST(binExpr.right, visitor, node);
            break;

        case 'UnaryExpression':
            const unaryExpr = node as UnaryExpressionNode;
            visitAST(unaryExpr.operand, visitor, node);
            break;

        case 'TernaryExpression':
            const ternaryExpr = node as TernaryExpressionNode;
            visitAST(ternaryExpr.condition, visitor, node);
            visitAST(ternaryExpr.thenExpr, visitor, node);
            visitAST(ternaryExpr.elseExpr, visitor, node);
            break;

        case 'CallExpression':
            const callExpr = node as CallExpressionNode;
            visitAST(callExpr.callee, visitor, node);
            callExpr.arguments.forEach(a => visitAST(a, visitor, node));
            break;

        case 'MemberExpression':
            const memberExpr = node as MemberExpressionNode;
            visitAST(memberExpr.object, visitor, node);
            break;

        case 'IndexExpression':
            const indexExpr = node as IndexExpressionNode;
            visitAST(indexExpr.object, visitor, node);
            visitAST(indexExpr.index, visitor, node);
            break;

        case 'AssignmentExpression':
            const assignExpr = node as AssignmentExpressionNode;
            visitAST(assignExpr.left, visitor, node);
            visitAST(assignExpr.right, visitor, node);
            break;

        case 'VariableDeclaration':
            const varDecl = node as VariableDeclarationNode;
            visitAST(varDecl.type, visitor, node);
            if (varDecl.initializer) visitAST(varDecl.initializer, visitor, node);
            break;

        case 'CastExpression':
            const castExpr = node as CastExpressionNode;
            visitAST(castExpr.type, visitor, node);
            visitAST(castExpr.expression, visitor, node);
            break;

        case 'SizeofExpression':
            const sizeofExpr = node as SizeofExpressionNode;
            visitAST(sizeofExpr.operand as ASTNode, visitor, node);
            break;

        case 'InitializerList':
            const initList = node as InitializerListNode;
            initList.elements.forEach(e => visitAST(e, visitor, node));
            break;

        case 'StatementExpression':
            const stmtExpr = node as StatementExpressionNode;
            stmtExpr.statements.forEach(s => visitAST(s, visitor, node));
            if (stmtExpr.value) {
                visitAST(stmtExpr.value, visitor, node);
            }
            break;

        case 'StructDefinition':
            const structDef = node as StructDefinitionNode;
            structDef.members.forEach(m => visitAST(m, visitor, node));
            break;

        case 'StructMember':
            const structMember = node as StructMemberNode;
            visitAST(structMember.type, visitor, node);
            break;

        case 'Typedef':
            const typedefNode = node as TypedefNode;
            visitAST(typedefNode.type, visitor, node);
            break;

        // Leaf nodes - no children to visit
        case 'Identifier':
        case 'Literal':
        case 'Type':
        case 'Parameter':
        case 'Modifier':
        case 'Macro':
        case 'UIParam':
        case 'AlphaMode':
        case 'Break':
        case 'Continue':
        case 'EmptyStatement':
            break;
    }
}
