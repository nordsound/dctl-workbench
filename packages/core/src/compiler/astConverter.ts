/**
 * AST Converter
 *
 * Converts TypeScript DCTL AST to Rust AST format for use with the Naga backend.
 * The Rust compiler expects a specific JSON format for its AST.
 */

import {
    type ModuleNode,
    type DeclarationNode,
    type FunctionNode,
    type VariableDeclarationNode,
    type StructDefinitionNode,
    type TypedefNode,
    type MacroNode,
    type TypeNode,
    type ParameterNode,
    type ModifierNode,
    type BlockNode,
    type StatementNode,
    type ExpressionNode,
    type BinaryExpressionNode,
    type UnaryExpressionNode,
    type TernaryExpressionNode,
    type CallExpressionNode,
    type MemberExpressionNode,
    type IndexExpressionNode,
    type AssignmentExpressionNode,
    type IdentifierNode,
    type LiteralNode,
    type CastExpressionNode,
    type SizeofExpressionNode,
    type InitializerListNode,
    type IfNode,
    type WhileNode,
    type ForNode,
    type DoWhileNode,
    type SwitchNode,
    type CaseNode,
    type ReturnNode,
    type ExpressionStatementNode,
    type StructMemberNode,
    type SourceLocation,
} from '../parser/ast.js';

/**
 * DCTL UI Parameter type (simplified local definition)
 */
export interface DctlParam {
    name: string;
    label: string;
    type: string;
    default?: number | boolean;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
}

// =============================================================================
// Rust AST Types (for JSON output)
// =============================================================================

interface RustLocation {
    line: number;
    column: number;
    end_line: number;
    end_column: number;
}

interface RustDctlModule {
    declarations: RustDeclaration[];
    ui_params: RustUiParamDecl[];
}

type RustDeclaration =
    | { kind: 'Function'; name: string; return_type: RustType; params: RustParameter[]; body: RustBlock | null; modifiers: RustModifier[]; loc: RustLocation }
    | { kind: 'Struct'; name: string; fields: RustStructField[]; loc: RustLocation }
    | { kind: 'Variable'; name: string; var_type: RustType; initializer: RustExpression | null; is_const: boolean; modifiers: RustModifier[]; loc: RustLocation }
    | { kind: 'Typedef'; name: string; target_type: RustType; loc: RustLocation }
    | { kind: 'Macro'; macro_type: RustMacroType; args: RustExpression[]; loc: RustLocation };

interface RustParameter {
    name: string;
    param_type: RustType;
    is_const: boolean;
    is_pointer: boolean;
    modifiers: RustModifier[];
    loc: RustLocation;
}

interface RustStructField {
    name: string;
    field_type: RustType;
    loc: RustLocation;
}

interface RustType {
    base: RustBaseType;
    is_pointer: boolean;
    is_const: boolean;
    array_dims: RustArrayDim[];
}

type RustBaseType =
    | 'Void' | 'Bool' | 'Char' | 'Int' | 'UInt' | 'Float' | 'Double' | 'Half'
    | 'Float2' | 'Float3' | 'Float4'
    | 'Int2' | 'Int3' | 'Int4'
    | 'Half2' | 'Half3' | 'Half4'
    | 'Float2x2' | 'Float3x3' | 'Float4x4'
    | 'Texture2D' | 'Texture3D' | 'Sampler'
    | { Struct: string }
    | { Typedef: string };

type RustArrayDim =
    | { Fixed: number }
    | 'Unspecified'
    | { Expression: RustExpression };

type RustModifier = 'Device' | 'Global' | 'Constant' | 'Private' | 'Texture' | 'Texture2D' | 'Texture3D' | 'ConstantRef' | 'Resolve';

type RustMacroType = 'DefineUiParams' | 'DefineLut' | 'DefineCubeLut' | 'DefineAcesParam' | { Other: string };

interface RustUiParamDecl {
    name: string;
    label: string;
    ui_type: RustUiParamType;
    loc: RustLocation;
}

type RustUiParamType =
    | { SliderFloat: { default: number; min: number; max: number; step: number } }
    | { SliderInt: { default: number; min: number; max: number; step: number } }
    | { CheckBox: { default: boolean } }
    | { ComboBox: { default: number; options: string[] } };

interface RustBlock {
    statements: RustStatement[];
    loc: RustLocation;
}

type RustStatement =
    | { kind: 'Block'; statements: RustStatement[]; loc: RustLocation }
    | { kind: 'Variable'; name: string; var_type: RustType; initializer: RustExpression | null; is_const: boolean; modifiers: RustModifier[]; loc: RustLocation }
    | { kind: 'Expression'; expression: RustExpression; loc: RustLocation }
    | { kind: 'If'; condition: RustExpression; then_branch: RustStatement; else_branch: RustStatement | null; loc: RustLocation }
    | { kind: 'While'; condition: RustExpression; body: RustStatement; loc: RustLocation }
    | { kind: 'DoWhile'; body: RustStatement; condition: RustExpression; loc: RustLocation }
    | { kind: 'For'; init: RustForInit | null; condition: RustExpression | null; update: RustExpression | null; body: RustStatement; loc: RustLocation }
    | { kind: 'Switch'; expression: RustExpression; cases: RustSwitchCase[]; loc: RustLocation }
    | { kind: 'Return'; value: RustExpression | null; loc: RustLocation }
    | { kind: 'Break'; loc: RustLocation }
    | { kind: 'Continue'; loc: RustLocation }
    | { kind: 'Empty'; loc: RustLocation };

type RustVariableDecl = { name: string; var_type: RustType; initializer: RustExpression | null; is_const: boolean; modifiers: RustModifier[]; loc: RustLocation };

type RustForInit =
    | { Variables: RustVariableDecl[] }
    | { Expression: RustExpression };

interface RustSwitchCase {
    value: RustExpression | null;
    statements: RustStatement[];
    loc: RustLocation;
}

type RustExpression =
    | { kind: 'Literal'; value: RustLiteralValue; loc: RustLocation }
    | { kind: 'Identifier'; name: string; loc: RustLocation }
    | { kind: 'Binary'; op: RustBinaryOp; left: RustExpression; right: RustExpression; loc: RustLocation }
    | { kind: 'Unary'; op: RustUnaryOp; operand: RustExpression; is_prefix: boolean; loc: RustLocation }
    | { kind: 'Ternary'; condition: RustExpression; then_expr: RustExpression; else_expr: RustExpression; loc: RustLocation }
    | { kind: 'Call'; callee: RustExpression; args: RustExpression[]; loc: RustLocation }
    | { kind: 'Index'; object: RustExpression; index: RustExpression; loc: RustLocation }
    | { kind: 'Member'; object: RustExpression; member: string; is_arrow: boolean; loc: RustLocation }
    | { kind: 'Cast'; target_type: RustType; operand: RustExpression; loc: RustLocation }
    | { kind: 'Sizeof'; operand: RustSizeofOperand; loc: RustLocation }
    | { kind: 'Assignment'; op: RustAssignmentOp; left: RustExpression; right: RustExpression; loc: RustLocation }
    | { kind: 'InitializerList'; elements: RustExpression[]; loc: RustLocation }
    | { kind: 'Comma'; expressions: RustExpression[]; loc: RustLocation };

type RustLiteralValue =
    | { Int: number }
    | { UInt: number }
    | { Float: number }
    | { Bool: boolean }
    | { Char: string }
    | { String: string };

type RustBinaryOp = 'Add' | 'Sub' | 'Mul' | 'Div' | 'Mod' | 'Eq' | 'Ne' | 'Lt' | 'Le' | 'Gt' | 'Ge' | 'And' | 'Or' | 'BitAnd' | 'BitOr' | 'BitXor' | 'Shl' | 'Shr';

type RustUnaryOp = 'Neg' | 'Not' | 'BitNot' | 'Deref' | 'AddrOf' | 'PreInc' | 'PreDec' | 'PostInc' | 'PostDec';

type RustAssignmentOp = 'Assign' | 'AddAssign' | 'SubAssign' | 'MulAssign' | 'DivAssign' | 'ModAssign' | 'BitAndAssign' | 'BitOrAssign' | 'BitXorAssign' | 'ShlAssign' | 'ShrAssign';

type RustSizeofOperand =
    | { Type: RustType }
    | { Expression: RustExpression };

// =============================================================================
// Converter Implementation
// =============================================================================

// Module-level array to collect hoisted declarations (e.g., local struct definitions)
// These are cleared and processed for each function
let hoistedDeclarations: RustDeclaration[] = [];

/**
 * Convert TypeScript DCTL AST to Rust AST format JSON
 */
export function convertAstToRustFormat(module: ModuleNode, params?: DctlParam[]): string {
    hoistedDeclarations = []; // Reset hoisted declarations
    const rustModule = convertModule(module, params);
    return JSON.stringify(rustModule);
}

function convertLocation(loc: SourceLocation): RustLocation {
    return {
        line: loc.line,
        column: loc.column,
        end_line: loc.endLine ?? loc.line,
        end_column: loc.endColumn ?? loc.column,
    };
}

function convertModule(module: ModuleNode, params?: DctlParam[]): RustDctlModule {
    const declarations: RustDeclaration[] = [];

    for (const decl of module.declarations) {
        // Before converting each declaration, clear hoisted declarations
        const prevHoisted = hoistedDeclarations;
        hoistedDeclarations = [];

        const converted = convertDeclaration(decl);

        // Add any hoisted declarations (local struct defs) before this declaration
        declarations.push(...hoistedDeclarations);
        declarations.push(converted);

        hoistedDeclarations = prevHoisted;
    }

    // Convert UI params from DctlParam array if provided
    const ui_params: RustUiParamDecl[] = params?.map(convertDctlParam) ?? [];

    return { declarations, ui_params };
}

function convertDctlParam(param: DctlParam): RustUiParamDecl {
    const loc: RustLocation = { line: 1, column: 1, end_line: 1, end_column: 1 };

    let ui_type: RustUiParamType;

    switch (param.type) {
        case 'DCTL_SLIDER_FLOAT':
            ui_type = {
                SliderFloat: {
                    default: (param as any).default ?? 0,
                    min: (param as any).min ?? 0,
                    max: (param as any).max ?? 1,
                    step: (param as any).step ?? 0.01,
                },
            };
            break;
        case 'DCTL_SLIDER_INT':
            ui_type = {
                SliderInt: {
                    default: (param as any).default ?? 0,
                    min: (param as any).min ?? 0,
                    max: (param as any).max ?? 100,
                    step: (param as any).step ?? 1,
                },
            };
            break;
        case 'DCTL_CHECK_BOX':
            ui_type = {
                CheckBox: {
                    default: (param as any).default ?? false,
                },
            };
            break;
        case 'DCTL_COMBO_BOX':
            ui_type = {
                ComboBox: {
                    default: (param as any).default ?? 0,
                    options: (param as any).options ?? [],
                },
            };
            break;
        default:
            // Default to float slider
            ui_type = {
                SliderFloat: { default: 0, min: 0, max: 1, step: 0.01 },
            };
    }

    return {
        name: param.name,
        label: param.label,
        ui_type,
        loc,
    };
}

function convertDeclaration(decl: DeclarationNode): RustDeclaration {
    switch (decl.kind) {
        case 'Function':
            return convertFunction(decl);
        case 'VariableDeclaration':
            return convertVariableDecl(decl);
        case 'StructDefinition':
            return convertStructDef(decl);
        case 'Typedef':
            return convertTypedef(decl);
        default:
            throw new Error(`Unknown declaration kind: ${(decl as any).kind}`);
    }
}

function convertFunction(func: FunctionNode): RustDeclaration {
    return {
        kind: 'Function',
        name: func.name,
        return_type: convertType(func.returnType),
        params: func.parameters.map(convertParameter),
        body: func.body ? convertBlock(func.body) : null,
        modifiers: func.modifiers.map(convertModifier),
        loc: convertLocation(func.loc),
    };
}

function convertParameter(param: ParameterNode): RustParameter {
    return {
        name: param.name,
        param_type: convertType(param.type),
        is_const: param.isConst,
        is_pointer: param.type.isPointer,
        modifiers: [],  // Parameters don't have modifiers in TypeScript AST
        loc: convertLocation(param.loc),
    };
}

function convertVariableDecl(decl: VariableDeclarationNode): RustDeclaration {
    return {
        kind: 'Variable',
        name: decl.name,
        var_type: convertType(decl.type),
        initializer: decl.initializer ? convertExpression(decl.initializer) : null,
        is_const: decl.isConst,
        modifiers: [],
        loc: convertLocation(decl.loc),
    };
}

function convertStructDef(struct: StructDefinitionNode): RustDeclaration {
    return {
        kind: 'Struct',
        name: struct.name,
        fields: struct.members.map(convertStructMember),
        loc: convertLocation(struct.loc),
    };
}

function convertStructMember(member: StructMemberNode): RustStructField {
    return {
        name: member.name,
        field_type: convertType(member.type),
        loc: convertLocation(member.loc),
    };
}

function convertTypedef(typedef: TypedefNode): RustDeclaration {
    return {
        kind: 'Typedef',
        name: typedef.name,
        target_type: convertType(typedef.type),
        loc: convertLocation(typedef.loc),
    };
}

function convertModifier(mod: ModifierNode): RustModifier {
    switch (mod.modifier) {
        case '__DEVICE__': return 'Device';
        case '__CONSTANT__': return 'Constant';
        case '__GLOBAL__': return 'Global';
        case '__LOCAL__':
        case '__PRIVATE__': return 'Private';
        default: return 'Device';
    }
}

function convertType(type: TypeNode): RustType {
    let base: RustBaseType;

    // Map TypeScript type names to Rust base types
    const typeName = type.name.toLowerCase();
    switch (typeName) {
        case 'void': base = 'Void'; break;
        case 'bool': base = 'Bool'; break;
        case 'char': base = 'Char'; break;
        case 'int': base = 'Int'; break;
        case 'uint':
        case 'unsigned int':
        case 'unsigned':
        case 'unsigned long':
        case 'unsigned long long': base = 'UInt'; break;
        case 'long':
        case 'signed long':
        case 'long long':
        case 'signed long long': base = 'Int'; break;
        case 'float': base = 'Float'; break;
        case 'double': base = 'Double'; break;
        case 'half': base = 'Half'; break;
        case 'float2': base = 'Float2'; break;
        case 'float3': base = 'Float3'; break;
        case 'float4': base = 'Float4'; break;
        case 'int2': base = 'Int2'; break;
        case 'int3': base = 'Int3'; break;
        case 'int4': base = 'Int4'; break;
        case 'half2': base = 'Half2'; break;
        case 'half3': base = 'Half3'; break;
        case 'half4': base = 'Half4'; break;
        case 'float2x2': base = 'Float2x2'; break;
        case 'float3x3': base = 'Float3x3'; break;
        case 'float4x4': base = 'Float4x4'; break;
        // Note: mat2/mat3/mat4 are user-defined structs in DCTL (with c0, c1, c2, c3 members)
        // They should NOT be mapped to built-in matrix types, so fall through to typedef handling
        case '__texture__':
        case '__texture2d__':
        case 'sampler2d': base = 'Texture2D'; break;
        case '__texture3d__':
        case 'sampler3d': base = 'Texture3D'; break;
        default:
            // Check if it's a struct or typedef
            if (type.name.startsWith('struct ')) {
                base = { Struct: type.name.substring(7) };
            } else {
                base = { Typedef: type.name };
            }
    }

    // Convert array dimensions
    const array_dims: RustArrayDim[] = [];
    if (type.isArray) {
        if (type.arraySizes && type.arraySizes.length > 0) {
            for (let i = 0; i < type.arraySizes.length; i++) {
                const size = type.arraySizes[i];
                // -1 or undefined means unspecified size, but check if we have an expression
                if (size < 0) {
                    // Check if there's an expression for this dimension
                    const sizeExpr = type.arraySizeExprs?.[i];
                    if (sizeExpr) {
                        array_dims.push({ Expression: convertExpression(sizeExpr) });
                    } else {
                        array_dims.push('Unspecified');
                    }
                } else {
                    array_dims.push({ Fixed: size });
                }
            }
        } else if (type.arraySize != null && type.arraySize >= 0) {
            array_dims.push({ Fixed: type.arraySize });
        } else if (type.arraySizeExprs && type.arraySizeExprs.length > 0) {
            // VLA with expression size
            for (const sizeExpr of type.arraySizeExprs) {
                if (sizeExpr) {
                    array_dims.push({ Expression: convertExpression(sizeExpr) });
                } else {
                    array_dims.push('Unspecified');
                }
            }
        } else {
            array_dims.push('Unspecified');
        }
    }

    return {
        base,
        is_pointer: type.isPointer,
        is_const: type.isConst,
        array_dims,
    };
}

function convertBlock(block: BlockNode): RustBlock {
    return {
        statements: block.statements.map(convertStatement),
        loc: convertLocation(block.loc),
    };
}

function convertStatement(stmt: StatementNode): RustStatement {
    const loc = convertLocation(stmt.loc);

    switch (stmt.kind) {
        case 'Block':
            return {
                kind: 'Block',
                statements: (stmt as BlockNode).statements.map(convertStatement),
                loc,
            };

        case 'VariableDeclaration': {
            const varDecl = stmt as VariableDeclarationNode;
            return {
                kind: 'Variable',
                name: varDecl.name,
                var_type: convertType(varDecl.type),
                initializer: varDecl.initializer ? convertExpression(varDecl.initializer) : null,
                is_const: varDecl.isConst,
                modifiers: [],
                loc,
            };
        }

        case 'ExpressionStatement':
            return {
                kind: 'Expression',
                expression: convertExpression((stmt as ExpressionStatementNode).expression),
                loc,
            };

        case 'If': {
            const ifStmt = stmt as IfNode;
            return {
                kind: 'If',
                condition: convertExpression(ifStmt.condition),
                then_branch: convertStatement(ifStmt.thenBranch),
                else_branch: ifStmt.elseBranch ? convertStatement(ifStmt.elseBranch) : null,
                loc,
            };
        }

        case 'While': {
            const whileStmt = stmt as WhileNode;
            return {
                kind: 'While',
                condition: convertExpression(whileStmt.condition),
                body: convertStatement(whileStmt.body),
                loc,
            };
        }

        case 'DoWhile': {
            const doWhileStmt = stmt as DoWhileNode;
            return {
                kind: 'DoWhile',
                body: convertStatement(doWhileStmt.body),
                condition: convertExpression(doWhileStmt.condition),
                loc,
            };
        }

        case 'For': {
            const forStmt = stmt as ForNode;
            let init: RustForInit | null = null;

            if (forStmt.init) {
                if (Array.isArray(forStmt.init)) {
                    init = {
                        Variables: forStmt.init.map(decl => ({
                            name: decl.name,
                            var_type: convertType(decl.type),
                            initializer: decl.initializer ? convertExpression(decl.initializer) : null,
                            is_const: decl.isConst,
                            modifiers: [],
                            loc: convertLocation(decl.loc),
                        })),
                    };
                } else if (forStmt.init.kind === 'VariableDeclaration') {
                    const varDecl = forStmt.init as VariableDeclarationNode;
                    init = {
                        Variables: [{
                            name: varDecl.name,
                            var_type: convertType(varDecl.type),
                            initializer: varDecl.initializer ? convertExpression(varDecl.initializer) : null,
                            is_const: varDecl.isConst,
                            modifiers: [],
                            loc: convertLocation(varDecl.loc),
                        }],
                    };
                } else {
                    init = { Expression: convertExpression(forStmt.init as ExpressionNode) };
                }
            }

            return {
                kind: 'For',
                init,
                condition: forStmt.condition ? convertExpression(forStmt.condition) : null,
                update: forStmt.update ? convertExpression(forStmt.update) : null,
                body: convertStatement(forStmt.body),
                loc,
            };
        }

        case 'Switch': {
            const switchStmt = stmt as SwitchNode;
            return {
                kind: 'Switch',
                expression: convertExpression(switchStmt.expression),
                cases: switchStmt.cases.map(convertCase),
                loc,
            };
        }

        case 'Return': {
            const returnStmt = stmt as ReturnNode;
            return {
                kind: 'Return',
                value: returnStmt.value ? convertExpression(returnStmt.value) : null,
                loc,
            };
        }

        case 'Break':
            return { kind: 'Break', loc };

        case 'Continue':
            return { kind: 'Continue', loc };

        case 'EmptyStatement':
            return { kind: 'Empty', loc };

        case 'StructDefinition': {
            // Local struct definition inside a function - hoist to module scope
            const structDef = stmt as StructDefinitionNode;
            hoistedDeclarations.push(convertStructDef(structDef));
            // Return empty statement since the struct is hoisted
            return { kind: 'Empty', loc };
        }

        case 'Typedef': {
            // Local typedef inside a function - hoist to module scope
            const typedefStmt = stmt as TypedefNode;
            hoistedDeclarations.push(convertTypedef(typedefStmt));
            return { kind: 'Empty', loc };
        }

        default:
            // For unhandled cases, return an empty statement
            return { kind: 'Empty', loc };
    }
}

function convertCase(caseNode: CaseNode): RustSwitchCase {
    return {
        value: caseNode.value ? convertExpression(caseNode.value) : null,
        statements: caseNode.statements.map(convertStatement),
        loc: convertLocation(caseNode.loc),
    };
}

function convertExpression(expr: ExpressionNode): RustExpression {
    const loc = convertLocation(expr.loc);

    switch (expr.kind) {
        case 'Literal': {
            const literal = expr as LiteralNode;
            let value: RustLiteralValue;

            switch (literal.literalType) {
                case 'int':
                    value = { Int: literal.value as number };
                    break;
                case 'uint':
                    value = { UInt: literal.value as number };
                    break;
                case 'float':
                    value = { Float: literal.value as number };
                    break;
                case 'bool':
                    value = { Bool: literal.value as boolean };
                    break;
                case 'string':
                    value = { String: literal.value as string };
                    break;
                default:
                    value = { Float: Number(literal.value) };
            }

            return { kind: 'Literal', value, loc };
        }

        case 'Identifier':
            return {
                kind: 'Identifier',
                name: (expr as IdentifierNode).name,
                loc,
            };

        case 'BinaryExpression': {
            const binExpr = expr as BinaryExpressionNode;

            // Handle comma operator specially - it's a Comma expression, not Binary
            if (binExpr.operator === ',') {
                // Flatten left-recursive comma expressions into a list
                const expressions: RustExpression[] = [];
                flattenCommaExpression(binExpr, expressions);
                return {
                    kind: 'Comma',
                    expressions,
                    loc,
                };
            }

            return {
                kind: 'Binary',
                op: convertBinaryOp(binExpr.operator),
                left: convertExpression(binExpr.left),
                right: convertExpression(binExpr.right),
                loc,
            };
        }

        case 'UnaryExpression': {
            const unaryExpr = expr as UnaryExpressionNode;
            return {
                kind: 'Unary',
                op: convertUnaryOp(unaryExpr.operator, unaryExpr.prefix),
                operand: convertExpression(unaryExpr.operand),
                is_prefix: unaryExpr.prefix,
                loc,
            };
        }

        case 'TernaryExpression': {
            const ternary = expr as TernaryExpressionNode;
            return {
                kind: 'Ternary',
                condition: convertExpression(ternary.condition),
                then_expr: convertExpression(ternary.thenExpr),
                else_expr: convertExpression(ternary.elseExpr),
                loc,
            };
        }

        case 'CallExpression': {
            const callExpr = expr as CallExpressionNode;
            return {
                kind: 'Call',
                callee: convertExpression(callExpr.callee),
                args: callExpr.arguments.map(convertExpression),
                loc,
            };
        }

        case 'MemberExpression': {
            const memberExpr = expr as MemberExpressionNode;
            return {
                kind: 'Member',
                object: convertExpression(memberExpr.object),
                member: memberExpr.property,
                is_arrow: memberExpr.isArrow || false,
                loc,
            };
        }

        case 'IndexExpression': {
            const indexExpr = expr as IndexExpressionNode;
            return {
                kind: 'Index',
                object: convertExpression(indexExpr.object),
                index: convertExpression(indexExpr.index),
                loc,
            };
        }

        case 'AssignmentExpression': {
            const assignExpr = expr as AssignmentExpressionNode;
            return {
                kind: 'Assignment',
                op: convertAssignmentOp(assignExpr.operator),
                left: convertExpression(assignExpr.left),
                right: convertExpression(assignExpr.right),
                loc,
            };
        }

        case 'CastExpression': {
            const castExpr = expr as CastExpressionNode;
            return {
                kind: 'Cast',
                target_type: convertType(castExpr.type),
                operand: convertExpression(castExpr.expression),
                loc,
            };
        }

        case 'SizeofExpression': {
            const sizeofExpr = expr as SizeofExpressionNode;
            let operand: RustSizeofOperand;

            if ('kind' in sizeofExpr.operand && sizeofExpr.operand.kind === 'Type') {
                operand = { Type: convertType(sizeofExpr.operand as TypeNode) };
            } else {
                operand = { Expression: convertExpression(sizeofExpr.operand as ExpressionNode) };
            }

            return { kind: 'Sizeof', operand, loc };
        }

        case 'InitializerList': {
            const initList = expr as InitializerListNode;
            return {
                kind: 'InitializerList',
                elements: initList.elements.map(convertExpression),
                loc,
            };
        }

        default:
            // For unhandled expression types, return a placeholder identifier
            return { kind: 'Identifier', name: '_unknown_', loc };
    }
}

/**
 * Flatten a left-recursive comma binary expression into a list of expressions.
 * Example: (a, b, c) is parsed as ((a, b), c) - we flatten to [a, b, c]
 */
function flattenCommaExpression(expr: BinaryExpressionNode, result: RustExpression[]): void {
    if (expr.left.kind === 'BinaryExpression' && (expr.left as BinaryExpressionNode).operator === ',') {
        flattenCommaExpression(expr.left as BinaryExpressionNode, result);
    } else {
        result.push(convertExpression(expr.left));
    }
    result.push(convertExpression(expr.right));
}

function convertBinaryOp(op: string): RustBinaryOp {
    switch (op) {
        case '+': return 'Add';
        case '-': return 'Sub';
        case '*': return 'Mul';
        case '/': return 'Div';
        case '%': return 'Mod';
        case '==': return 'Eq';
        case '!=': return 'Ne';
        case '<': return 'Lt';
        case '<=': return 'Le';
        case '>': return 'Gt';
        case '>=': return 'Ge';
        case '&&': return 'And';
        case '||': return 'Or';
        case '&': return 'BitAnd';
        case '|': return 'BitOr';
        case '^': return 'BitXor';
        case '<<': return 'Shl';
        case '>>': return 'Shr';
        default: return 'Add';
    }
}

function convertUnaryOp(op: string, isPrefix: boolean): RustUnaryOp {
    switch (op) {
        case '-': return 'Neg';
        case '!': return 'Not';
        case '~': return 'BitNot';
        case '*': return 'Deref';
        case '&': return 'AddrOf';
        case '++': return isPrefix ? 'PreInc' : 'PostInc';
        case '--': return isPrefix ? 'PreDec' : 'PostDec';
        default: return 'Neg';
    }
}

function convertAssignmentOp(op: string): RustAssignmentOp {
    switch (op) {
        case '=': return 'Assign';
        case '+=': return 'AddAssign';
        case '-=': return 'SubAssign';
        case '*=': return 'MulAssign';
        case '/=': return 'DivAssign';
        case '%=': return 'ModAssign';
        case '&=': return 'BitAndAssign';
        case '|=': return 'BitOrAssign';
        case '^=': return 'BitXorAssign';
        case '<<=': return 'ShlAssign';
        case '>>=': return 'ShrAssign';
        default: return 'Assign';
    }
}
