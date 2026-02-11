/**
 * Shader Builders
 *
 * Re-exports from core package for backward compatibility.
 * All shader building logic is now in @dctl-workbench/core.
 */

// OCIO builders
export {
    buildWgslShader,
    createFallbackWgslShader,
    buildOcioComputeShader,
    createPassthroughComputeShader,
    createZoneSystemComputeShader,
    type WgslShaderInfo,
    type ComputeShaderInfo,
} from '@dctl-workbench/core';

// DCTL builders
export {
    buildDctlShaderCode,
    getDctlDefaultUniforms,
    buildDctlShaderCodeWithUniformBuffer,
    buildIntegratedGlslShader,
    buildShaderParamMapping,
    buildDctlComputeShader,
    buildDctlExportShader,
    type DctlShaderBuildOptions,
    type DctlShaderBuildResult,
    type ShaderParamMapping,
    type DctlComputeShaderInfo,
    type DctlComputeOptions,
    type DctlExportShaderOptions,
    type DctlExportShaderResult,
} from '@dctl-workbench/core';

// Integrated shader builder
export {
    buildIntegratedShader,
    buildDctlOnlyGlslShader,
    type IntegratedShaderInfo,
    type DctlUniformBinding,
    type DctlBuildOptions,
} from '@dctl-workbench/core';

// ACES RGC builder
export {
    buildACES2RgcShader,
    extractRgcGlslFunction,
    isACES2RgcAvailable,
    type ACES2RgcShaderResult,
} from '@dctl-workbench/core';

// Re-export TextureBinding for backward compatibility
export type { TextureBinding } from '@dctl-workbench/core';
