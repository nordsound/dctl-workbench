/**
 * DCTL Types for VSCode Extension
 *
 * Re-exports core types and provides backwards-compatible DctlShaderInfo type.
 */

// Re-export all types from core
export {
    DctlColorSpace,
    DctlParamType,
    DctlParamBase,
    DctlSliderFloat,
    DctlSliderInt,
    DctlCheckBox,
    DctlValueBox,
    DctlComboBox,
    DctlColorPicker,
    DctlParam,
    DctlColorValue,
    DctlParamValues,
    DctlInfo,
} from '@dctl-workbench/core';

import type { DctlInfo, DctlColorSpace, DctlParam, DctlColorValue } from '@dctl-workbench/core';

/**
 * Source mapping entry for error reporting
 */
export interface SourceMapping {
    /** Line number in generated code (1-based) */
    glslLine: number;
    /** Original DCTL line number (1-based) */
    dctlLine: number;
    /** Original DCTL column (1-based, optional) */
    dctlColumn?: number;
}

/**
 * DCTL shader information (backwards-compatible)
 *
 * This extends DctlInfo to provide backwards compatibility with code
 * that expects the legacy DctlShaderInfo type with GLSL code.
 *
 * When using the Rust compiler path (recommended), only the DctlInfo
 * fields (source, workingColorSpace, filePath, params) are used.
 */
export interface DctlShaderInfo extends DctlInfo {
    /** Generated GLSL code (deprecated, not used in Rust compiler path) */
    glslCode?: string;
    /** Main transform function name */
    mainFunction?: string;
    /** Source mappings for error reporting */
    sourceMap?: SourceMapping[];
}

/**
 * Create a DctlShaderInfo from preprocessor result (without transpilation)
 *
 * This creates a minimal DctlShaderInfo for the Rust compiler path.
 * The glslCode field is left empty since it's not needed.
 */
export function createDctlInfo(
    source: string,
    workingColorSpace: DctlColorSpace,
    params: DctlParam[],
    filePath?: string
): DctlShaderInfo {
    return {
        source,
        workingColorSpace,
        filePath,
        params,
        returnType: 'float3',
        // These fields are optional and not needed for Rust compiler path
        glslCode: '',
        mainFunction: 'transform',
    };
}
