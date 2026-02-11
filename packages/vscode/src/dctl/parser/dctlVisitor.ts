/**
 * DCTL AST Visitor
 *
 * Traverses the tree-sitter AST and extracts DCTL-specific information.
 */

import { Node, Tree } from 'web-tree-sitter';
import {
    DctlEntryPoint,
    DctlUIParam,
    DctlUIType,
    TransformSignature,
    DCTL_BUILTIN_FUNCTIONS,
    FORBIDDEN_C_FUNCTIONS,
    DCTL_MODIFIERS,
} from './types';

/**
 * Result of visiting a DCTL file
 */
export interface DctlVisitResult {
    entryPoints: DctlEntryPoint[];
    uiParams: DctlUIParam[];
    forbiddenFunctions: ForbiddenFunctionUsage[];
    functionCalls: FunctionCall[];
    errors: VisitError[];
}

export interface ForbiddenFunctionUsage {
    name: string;
    replacement: string;
    line: number;
    column: number;
}

export interface FunctionCall {
    name: string;
    line: number;
    column: number;
    isBuiltin: boolean;
}

export interface VisitError {
    message: string;
    line: number;
    column: number;
}

/**
 * Visit a DCTL AST and extract relevant information
 */
export function visitDctl(tree: Tree): DctlVisitResult {
    const result: DctlVisitResult = {
        entryPoints: [],
        uiParams: [],
        forbiddenFunctions: [],
        functionCalls: [],
        errors: [],
    };

    visitNode(tree.rootNode, result);
    return result;
}

function visitNode(node: Node, result: DctlVisitResult): void {
    switch (node.type) {
        case 'function_definition':
            visitFunctionDefinition(node, result);
            break;

        case 'call_expression':
            visitCallExpression(node, result);
            break;

        case 'preproc_call':
            // Handle macro calls like DEFINE_UI_PARAMS
            visitPreprocCall(node, result);
            break;
    }

    // Recurse into children
    for (const child of node.children) {
        visitNode(child, result);
    }
}

/**
 * Visit a function definition to check for transform/transition entry points
 */
function visitFunctionDefinition(
    node: Node,
    result: DctlVisitResult
): void {
    // Get function declarator
    const declarator = node.childForFieldName('declarator');
    if (!declarator) return;

    // Get function name
    const functionDeclarator = findNodeOfType(declarator, 'function_declarator');
    if (!functionDeclarator) return;

    const nameNode = functionDeclarator.childForFieldName('declarator');
    if (!nameNode) return;

    const functionName = nameNode.text;

    // Check if this is an entry point
    if (functionName !== 'transform' && functionName !== 'transition') {
        return;
    }

    // Check for __DEVICE__ modifier
    const hasDeviceModifier = checkForDeviceModifier(node);
    if (!hasDeviceModifier) {
        return;
    }

    // Get return type
    const returnType = getReturnType(node);

    // Get parameters to determine signature
    const params = functionDeclarator.childForFieldName('parameters');
    const signature = determineSignature(functionName, params, returnType);

    if (signature) {
        result.entryPoints.push({
            type: functionName as 'transform' | 'transition',
            signature,
            returnType: returnType as 'float3' | 'float4',
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
        });
    }
}

/**
 * Check if function has __DEVICE__ modifier
 * With tree-sitter-dctl, __DEVICE__ is recognized as a storage_class_specifier
 */
function checkForDeviceModifier(node: Node): boolean {
    // First try structural check: look for storage_class_specifier with __DEVICE__
    for (const child of node.children) {
        if (child.type === 'storage_class_specifier') {
            const text = child.text;
            if (DCTL_MODIFIERS.some(mod => text === mod)) {
                return true;
            }
        }
    }

    // Fallback: text-based check for compatibility with tree-sitter-c
    const text = node.text;
    return DCTL_MODIFIERS.some(mod => text.includes(mod));
}

/**
 * Get the return type of a function
 */
function getReturnType(node: Node): string {
    const typeNode = node.childForFieldName('type');
    if (!typeNode) return '';

    // Look for float3 or float4 in the type
    const text = typeNode.text;
    if (text.includes('float4')) return 'float4';
    if (text.includes('float3')) return 'float3';

    return text;
}

/**
 * Determine the transform signature based on parameters
 */
function determineSignature(
    functionName: string,
    params: Node | null,
    returnType: string
): TransformSignature | 'transition' | null {
    if (functionName === 'transition') {
        return 'transition';
    }

    if (!params) return null;

    const paramText = params.text;
    const isRGBA = returnType === 'float4';
    const hasTexture = paramText.includes('__TEXTURE__');

    if (isRGBA) {
        return hasTexture ? 'rgba_texture' : 'rgba_buffer';
    } else {
        return hasTexture ? 'rgb_texture' : 'rgb_buffer';
    }
}

/**
 * Visit a call expression to check for built-in or forbidden functions
 */
function visitCallExpression(
    node: Node,
    result: DctlVisitResult
): void {
    const functionNode = node.childForFieldName('function');
    if (!functionNode) return;

    const functionName = functionNode.text;
    const line = node.startPosition.row + 1;
    const column = node.startPosition.column + 1;

    // Check for forbidden C functions
    if (functionName in FORBIDDEN_C_FUNCTIONS) {
        result.forbiddenFunctions.push({
            name: functionName,
            replacement: FORBIDDEN_C_FUNCTIONS[functionName],
            line,
            column,
        });
    }

    // Track function calls
    const isBuiltin = DCTL_BUILTIN_FUNCTIONS.includes(
        functionName as typeof DCTL_BUILTIN_FUNCTIONS[number]
    );

    result.functionCalls.push({
        name: functionName,
        line,
        column,
        isBuiltin,
    });
}

/**
 * Visit preprocessor calls (macros like DEFINE_UI_PARAMS)
 */
function visitPreprocCall(
    node: Node,
    result: DctlVisitResult
): void {
    const directiveNode = node.childForFieldName('directive');
    if (!directiveNode) return;

    const directive = directiveNode.text;

    // DEFINE_UI_PARAMS is often parsed as a call_expression, not preproc_call
    // This handles the case where it's treated as a preprocessor directive
    if (directive === 'DEFINE_UI_PARAMS') {
        parseUIParams(node, result);
    }
}

/**
 * Parse DEFINE_UI_PARAMS macro
 */
function parseUIParams(node: Node, result: DctlVisitResult): void {
    const line = node.startPosition.row + 1;
    const column = node.startPosition.column + 1;

    // Extract the argument text
    const text = node.text;
    const match = text.match(/DEFINE_UI_PARAMS\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*(\w+)/);

    if (match) {
        const [, name, label, type] = match;
        result.uiParams.push({
            name: name.trim(),
            label: label.trim(),
            type: type.trim() as DctlUIType,
            defaultValue: 0,
            line,
            column,
        });
    }
}

/**
 * Find a node of specific type in the subtree
 */
function findNodeOfType(
    node: Node,
    type: string
): Node | null {
    if (node.type === type) {
        return node;
    }

    for (const child of node.children) {
        const found = findNodeOfType(child, type);
        if (found) return found;
    }

    return null;
}

/**
 * Parse DEFINE_UI_PARAMS from source text (fallback regex-based parsing)
 */
export function parseUIParamsFromSource(source: string): DctlUIParam[] {
    const params: DctlUIParam[] = [];

    // Regex to match DEFINE_UI_PARAMS calls
    const regex = /DEFINE_UI_PARAMS\s*\(\s*(\w+)\s*,\s*([^,]+)\s*,\s*(\w+)\s*(?:,\s*([^)]+))?\)/g;

    let match;
    let lineNumber = 1;
    let lastIndex = 0;

    while ((match = regex.exec(source)) !== null) {
        // Calculate line number
        const textBefore = source.substring(lastIndex, match.index);
        lineNumber += (textBefore.match(/\n/g) || []).length;

        const [, name, label, type, rest] = match;

        const param: DctlUIParam = {
            name: name.trim(),
            label: label.trim(),
            type: type.trim() as DctlUIType,
            defaultValue: 0,
            line: lineNumber,
            column: match.index - source.lastIndexOf('\n', match.index),
        };

        // Parse additional parameters based on type
        if (rest) {
            parseUIParamValues(param, rest.trim());
        }

        params.push(param);
        lastIndex = match.index;
    }

    return params;
}

/**
 * Parse UI parameter values from the rest of the macro arguments
 */
function parseUIParamValues(param: DctlUIParam, rest: string): void {
    const values = rest.split(',').map(s => s.trim());

    switch (param.type) {
        case 'DCTLUI_SLIDER_FLOAT':
        case 'DCTLUI_SLIDER_INT':
            // default, min, max, step
            if (values.length >= 1) param.defaultValue = parseFloat(values[0]) || 0;
            if (values.length >= 2) param.min = parseFloat(values[1]);
            if (values.length >= 3) param.max = parseFloat(values[2]);
            if (values.length >= 4) param.step = parseFloat(values[3]);
            break;

        case 'DCTLUI_VALUE_BOX':
        case 'DCTLUI_CHECK_BOX':
            if (values.length >= 1) param.defaultValue = parseFloat(values[0]) || 0;
            break;

        case 'DCTLUI_COMBO_BOX':
            // default, {enums}, {labels}
            if (values.length >= 1) param.defaultValue = parseInt(values[0]) || 0;
            // Parse enum list and labels (complex parsing needed)
            break;

        case 'DCTLUI_COLOR_PICKER':
            // r, g, b
            if (values.length >= 1) param.defaultValue = parseFloat(values[0]) || 0;
            break;
    }
}

/**
 * Parse entry points (transform/transition functions) from source text
 * Uses regex to reliably detect __DEVICE__ functions even after preprocessing
 */
export function parseEntryPointsFromSource(source: string): DctlEntryPoint[] {
    const entryPoints: DctlEntryPoint[] = [];

    // Regex to match __DEVICE__ function definitions for transform/transition
    // Matches: __DEVICE__ float3/float4 transform/transition(...)
    const regex = /__DEVICE__\s+(float[34])\s+(transform|transition)\s*\([^)]*\)/g;

    let match;
    let lineNumber = 1;
    let lastIndex = 0;

    while ((match = regex.exec(source)) !== null) {
        // Calculate line number
        const textBefore = source.substring(lastIndex, match.index);
        lineNumber += (textBefore.match(/\n/g) || []).length;

        const [fullMatch, returnType, functionName] = match;

        // Determine signature
        const isRGBA = returnType === 'float4';
        const hasTexture = fullMatch.includes('__TEXTURE__');

        let signature: TransformSignature | 'transition';
        if (functionName === 'transition') {
            signature = 'transition';
        } else if (isRGBA) {
            signature = hasTexture ? 'rgba_texture' : 'rgba_buffer';
        } else {
            signature = hasTexture ? 'rgb_texture' : 'rgb_buffer';
        }

        entryPoints.push({
            type: functionName as 'transform' | 'transition',
            signature,
            returnType: returnType as 'float3' | 'float4',
            line: lineNumber,
            column: match.index - source.lastIndexOf('\n', match.index),
        });

        lastIndex = match.index;
    }

    return entryPoints;
}
