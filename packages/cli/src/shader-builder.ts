/**
 * CLI Shader Builder
 *
 * Re-exports from @dctl-workbench/core for CLI usage.
 * All shader building logic is now in the core package.
 */

import {
    buildComputeShader as coreComputeShader,
    type CompileResult,
} from '@dctl-workbench/core';

// Re-export everything from core shader module
export {
    buildComputeShader,
    buildExportShader,
    detectTransformSignature,
    injectParameters,
    removeSampleTextureStub,
    rewriteTextureTransformSignature,
    rewriteTextureTransformForCompute,
    generateColorSpaceCode,
    generateFragmentTextureSampler,
    generateFragmentEntryPoint,
    type TransformSignatureType,
    type ComputeShaderOptions,
    type ExportShaderOptions,
    type ShaderBuildOptions,
    type ShaderBuildResult,
} from '@dctl-workbench/core';

/**
 * Legacy function that returns string (for backward compatibility with tests)
 */
export function buildBufferComputeShader(
    compileResult: CompileResult,
    options: {
        width: number;
        height: number;
        paramValues?: Record<string, number>;
        inputColorSpace?: string;
        outputColorSpace?: string;
        workingColorSpace?: string;
    }
): string {
    const result = coreComputeShader(compileResult, {
        width: options.width,
        height: options.height,
        paramValues: options.paramValues,
        workingColorSpace: options.workingColorSpace as any,
        inputColorSpace: options.inputColorSpace,
        outputColorSpace: options.outputColorSpace,
    });
    return result.wgsl;
}

/**
 * Legacy function with RGC - now just uses buildComputeShader with options
 */
export function buildBufferComputeShaderWithRgc(
    compileResult: CompileResult,
    options: {
        width: number;
        height: number;
        paramValues?: Record<string, number>;
        inputColorSpace?: string;
        outputColorSpace?: string;
        workingColorSpace?: string;
        rgcWgslFunctions: string;
        rgcMainFunctionName: string;
        rgcTextureBindings: string;
    }
): string {
    const result = coreComputeShader(compileResult, {
        width: options.width,
        height: options.height,
        paramValues: options.paramValues,
        workingColorSpace: options.workingColorSpace as any,
        inputColorSpace: options.inputColorSpace,
        outputColorSpace: options.outputColorSpace,
        applyRGC: true,
        rgcWgslFunctions: options.rgcWgslFunctions,
        rgcMainFunctionName: options.rgcMainFunctionName,
        rgcTextureBindings: options.rgcTextureBindings,
    });
    return result.wgsl;
}
