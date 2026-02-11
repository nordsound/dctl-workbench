/**
 * DCTL UI Parameter Extractor
 *
 * Extracts DEFINE_UI_PARAMS macros from DCTL source code
 * and converts them to structured parameter definitions.
 */

import type {
    DctlParam,
    DctlSliderFloat,
    DctlSliderInt,
    DctlValueBox,
    DctlCheckBox,
    DctlComboBox,
    DctlColorPicker,
    DctlColorValue,
} from '../types/index.js';

/**
 * DEFINE_UI_PARAMS macro pattern
 *
 * Examples:
 * DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)
 * DEFINE_UI_PARAMS(enable, Enable Effect, DCTL_CHECK_BOX, 1)
 * DEFINE_UI_PARAMS(mode, Mode, DCTL_COMBO_BOX, 0, {Option1, Option2, Option3})
 */
const UI_PARAMS_PATTERN = /DEFINE_UI_PARAMS\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,\s]+)\s*,?\s*([^)]*)\)/g;

/**
 * Strip C-style comments from source code
 */
function stripComments(source: string): string {
    let result = '';
    let i = 0;

    while (i < source.length) {
        // Handle string literals
        if (source[i] === '"') {
            result += source[i];
            i++;
            while (i < source.length && source[i] !== '"') {
                if (source[i] === '\\' && i + 1 < source.length) {
                    result += source[i];
                    i++;
                    result += source[i];
                    i++;
                } else {
                    result += source[i];
                    i++;
                }
            }
            if (i < source.length) {
                result += source[i];
                i++;
            }
            continue;
        }

        // Handle character literals
        if (source[i] === "'") {
            result += source[i];
            i++;
            while (i < source.length && source[i] !== "'") {
                if (source[i] === '\\' && i + 1 < source.length) {
                    result += source[i];
                    i++;
                    result += source[i];
                    i++;
                } else {
                    result += source[i];
                    i++;
                }
            }
            if (i < source.length) {
                result += source[i];
                i++;
            }
            continue;
        }

        // Check for single-line comment
        if (source[i] === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') {
                result += ' ';
                i++;
            }
            continue;
        }

        // Check for multi-line comment
        if (source[i] === '/' && source[i + 1] === '*') {
            result += ' ';
            i++;
            result += ' ';
            i++;
            while (i < source.length) {
                if (source[i] === '*' && source[i + 1] === '/') {
                    result += ' ';
                    i++;
                    result += ' ';
                    i++;
                    break;
                }
                result += source[i] === '\n' ? '\n' : ' ';
                i++;
            }
            continue;
        }

        result += source[i];
        i++;
    }

    return result;
}

/**
 * Result of UI parameter extraction
 */
export interface UIParamExtractionResult {
    params: DctlParam[];
    warnings: string[];
    errors: string[];
}

/**
 * Extract UI parameters from DCTL source code
 */
export function extractUIParams(source: string): UIParamExtractionResult {
    const params: DctlParam[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    // Strip comments to avoid extracting DEFINE_UI_PARAMS from commented code
    const sourceWithoutComments = stripComments(source);

    // Reset the regex lastIndex
    UI_PARAMS_PATTERN.lastIndex = 0;

    let match;
    while ((match = UI_PARAMS_PATTERN.exec(sourceWithoutComments)) !== null) {
        const [, name, label, type, argsStr] = match;

        try {
            const param = parseUIParam(
                name.trim(),
                label.trim(),
                type.trim(),
                argsStr?.trim() || ''
            );

            if (param) {
                params.push(param);
            }
        } catch (e) {
            errors.push(
                `Failed to parse UI param "${name.trim()}": ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }

    return { params, warnings, errors };
}

/**
 * Normalize UI param type
 */
function normalizeParamType(type: string): string {
    if (type === 'DCTLUI_SLIDER_INTER' || type === 'DCTL_SLIDER_INTER') {
        return 'DCTL_SLIDER_INT';
    }
    if (type.startsWith('DCTLUI_')) {
        return 'DCTL_' + type.substring(7);
    }
    return type;
}

/**
 * Parse a single UI parameter definition
 */
function parseUIParam(
    name: string,
    label: string,
    type: string,
    argsStr: string
): DctlParam | null {
    const normalizedType = normalizeParamType(type);

    switch (normalizedType) {
        case 'DCTL_SLIDER_FLOAT':
            return parseSliderFloat(name, label, argsStr);
        case 'DCTL_SLIDER_INT':
            return parseSliderInt(name, label, argsStr);
        case 'DCTL_VALUE_BOX':
            return parseValueBox(name, label, argsStr);
        case 'DCTL_CHECK_BOX':
            return parseCheckBox(name, label, argsStr);
        case 'DCTL_COMBO_BOX':
            return parseComboBox(name, label, argsStr);
        case 'DCTL_COLOR_PICKER':
            return parseColorPicker(name, label, argsStr);
        default:
            throw new Error(`Unknown UI param type: ${type}`);
    }
}

function parseSliderFloat(name: string, label: string, argsStr: string): DctlSliderFloat {
    const args = parseNumericArgs(argsStr);

    if (args.length < 4) {
        throw new Error(
            `DCTL_SLIDER_FLOAT requires 4 arguments (default, min, max, step), got ${args.length}`
        );
    }

    return {
        name,
        label,
        type: 'DCTL_SLIDER_FLOAT',
        default: args[0],
        min: args[1],
        max: args[2],
        step: args[3],
    };
}

function parseSliderInt(name: string, label: string, argsStr: string): DctlSliderInt {
    const args = parseNumericArgs(argsStr);

    if (args.length < 4) {
        throw new Error(
            `DCTL_SLIDER_INT requires 4 arguments (default, min, max, step), got ${args.length}`
        );
    }

    return {
        name,
        label,
        type: 'DCTL_SLIDER_INT',
        default: Math.round(args[0]),
        min: Math.round(args[1]),
        max: Math.round(args[2]),
        step: Math.round(args[3]),
    };
}

function parseCheckBox(name: string, label: string, argsStr: string): DctlCheckBox {
    const args = parseNumericArgs(argsStr);
    const defaultValue = args.length > 0 ? args[0] !== 0 : false;

    return {
        name,
        label,
        type: 'DCTL_CHECK_BOX',
        default: defaultValue,
    };
}

function parseValueBox(name: string, label: string, argsStr: string): DctlValueBox {
    const args = parseNumericArgs(argsStr);
    const defaultValue = args.length > 0 ? args[0] : 0;

    return {
        name,
        label,
        type: 'DCTL_VALUE_BOX',
        default: defaultValue,
    };
}

function parseColorPicker(name: string, label: string, argsStr: string): DctlColorPicker {
    const args = parseNumericArgs(argsStr);

    return {
        name,
        label,
        type: 'DCTL_COLOR_PICKER',
        default: {
            r: args.length > 0 ? args[0] : 1.0,
            g: args.length > 1 ? args[1] : 1.0,
            b: args.length > 2 ? args[2] : 1.0,
        },
    };
}

function parseComboBox(name: string, label: string, argsStr: string): DctlComboBox {
    const braceMatch = argsStr.match(/\{([^}]+)\}/);
    const optionsStr = braceMatch ? braceMatch[1] : '';

    const options = optionsStr
        .split(',')
        .map(opt => opt.trim())
        .filter(opt => opt.length > 0);

    const beforeBrace = argsStr.split('{')[0];
    const numericArgs = parseNumericArgs(beforeBrace);
    const defaultIndex = numericArgs.length > 0 ? Math.round(numericArgs[0]) : 0;

    return {
        name,
        label,
        type: 'DCTL_COMBO_BOX',
        default: defaultIndex,
        options,
    };
}

function parseNumericArgs(argsStr: string): number[] {
    if (!argsStr || argsStr.trim().length === 0) {
        return [];
    }

    return argsStr
        .split(',')
        .map(arg => arg.trim())
        .filter(arg => arg.length > 0 && !arg.startsWith('{'))
        .map(arg => {
            const cleanArg = arg.replace(/f$/i, '');
            const num = parseFloat(cleanArg);
            if (isNaN(num)) {
                throw new Error(`Invalid numeric argument: ${arg}`);
            }
            return num;
        });
}

/**
 * Convert DctlParam to CompilerParameter format
 */
export function convertToCompilerParameter(param: DctlParam): {
    name: string;
    label: string;
    param_type: {
        type: string;
        default?: number | boolean;
        min?: number;
        max?: number;
        step?: number;
        options?: string[];
    };
} {
    switch (param.type) {
        case 'DCTL_SLIDER_FLOAT':
            return {
                name: param.name,
                label: param.label,
                param_type: {
                    type: 'float',
                    default: param.default,
                    min: param.min,
                    max: param.max,
                    step: param.step,
                },
            };
        case 'DCTL_SLIDER_INT':
            return {
                name: param.name,
                label: param.label,
                param_type: {
                    type: 'int',
                    default: param.default,
                    min: param.min,
                    max: param.max,
                    step: param.step,
                },
            };
        case 'DCTL_CHECK_BOX':
            return {
                name: param.name,
                label: param.label,
                param_type: {
                    type: 'bool',
                    default: param.default,
                },
            };
        case 'DCTL_COMBO_BOX':
            return {
                name: param.name,
                label: param.label,
                param_type: {
                    type: 'combo',
                    default: param.default,
                    options: param.options,
                },
            };
        case 'DCTL_VALUE_BOX':
            return {
                name: param.name,
                label: param.label,
                param_type: {
                    type: 'float',
                    default: param.default,
                    min: -Infinity,
                    max: Infinity,
                    step: 0.01,
                },
            };
        case 'DCTL_COLOR_PICKER':
            // Color picker is not directly supported, return as three floats
            return {
                name: param.name,
                label: param.label,
                param_type: {
                    type: 'float',
                    default: param.default.r,
                    min: 0,
                    max: 1,
                    step: 0.01,
                },
            };
    }
}
