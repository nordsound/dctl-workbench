/**
 * RGC Shader Builder for CLI
 *
 * Extracts ACES 2.0 Reference Gamut Compression shader from OCIO and converts to WGSL.
 * Uses @dctl-workbench/core for OCIO and shader utilities.
 */

import {
    DctlRuntime,
    initOCIO,
    extractRgcShaderInfo,
    getOCIOVersion,
    isOCIOInitialized,
    fixGlslForNaga,
    processSamplerDeclarations,
    replaceSamplerTextureCalls,
    findOcioMainFunction,
    buildVulkanGlslPreamble,
    type GpuTexture,
    type GpuTexture3D,
} from '@dctl-workbench/core';
import type { RgcTextureInfo } from './subprocess-renderer.js';

export interface RgcShaderResult {
    /** RGC WGSL function code (for embedding in shader) */
    wgslFunctions: string;
    /** Main RGC function name to call */
    mainFunctionName: string;
    /** WGSL texture binding declarations */
    textureBindings: string;
    /** Texture data for GPU upload */
    textures: RgcTextureInfo[];
    /** Success flag */
    success: boolean;
    /** Error message if failed */
    error?: string;
}

/**
 * Extract and convert RGC shader from OCIO
 */
export async function buildRgcShader(
    runtime: DctlRuntime,
    wasmPath: string,
    peakLuminance: number = 100
): Promise<RgcShaderResult> {
    // Initialize OCIO if needed
    if (!isOCIOInitialized()) {
        try {
            await initOCIO(wasmPath);
            console.log(`[RGC] OCIO initialized: ${getOCIOVersion()}`);
        } catch (err) {
            return {
                wgslFunctions: '',
                mainFunctionName: '',
                textureBindings: '',
                textures: [],
                success: false,
                error: `Failed to initialize OCIO: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    // Extract RGC shader from OCIO
    const rgcInfo = extractRgcShaderInfo(peakLuminance);
    if (!rgcInfo.success) {
        return {
            wgslFunctions: '',
            mainFunctionName: '',
            textureBindings: '',
            textures: [],
            success: false,
            error: rgcInfo.error || 'Failed to extract RGC shader',
        };
    }

    console.log(`[RGC] Extracted GLSL: ${rgcInfo.glsl.length} chars, ${rgcInfo.textures.length} 2D textures, ${rgcInfo.textures3D.length} 3D textures`);

    // Build complete Vulkan GLSL for naga
    let glslCode = fixGlslForNaga(rgcInfo.glsl);
    const samplerResult = processSamplerDeclarations(glslCode, 2);
    glslCode = samplerResult.code;

    // Replace texture() calls to use separated texture/sampler
    glslCode = replaceSamplerTextureCalls(glslCode, samplerResult.declarations);

    // Find main function name
    const mainFunctionName = findOcioMainFunction(glslCode);

    // Build complete GLSL for conversion
    const bindingsGlsl = samplerResult.bindings.map(b => {
        if (b.type === 'texture2D') {
            return `layout(set = 0, binding = ${b.binding}) uniform texture2D ${b.name};`;
        } else if (b.type === 'texture3D') {
            return `layout(set = 0, binding = ${b.binding}) uniform texture3D ${b.name};`;
        } else if (b.type === 'sampler') {
            return `layout(set = 0, binding = ${b.binding}) uniform sampler ${b.name};`;
        }
        return '';
    }).join('\n');

    const completeGlsl = `${buildVulkanGlslPreamble()}${bindingsGlsl}
// OCIO RGC Functions
${glslCode}

void main() {
    vec4 color = texture(sampler2D(u_image_tex, u_image_samp), v_texCoord);
    fragColor = ${mainFunctionName}(color);
}
`;

    // Convert to WGSL using naga
    if (!runtime.hasNaga) {
        return {
            wgslFunctions: '',
            mainFunctionName: '',
            textureBindings: '',
            textures: [],
            success: false,
            error: 'Naga module not initialized',
        };
    }

    const conversionResult = runtime.convertGlslToWgsl(completeGlsl);
    if (!conversionResult.success) {
        console.error('[RGC] GLSL to WGSL conversion failed:', conversionResult.error);
        return {
            wgslFunctions: '',
            mainFunctionName: '',
            textureBindings: '',
            textures: [],
            success: false,
            error: `GLSL conversion failed: ${conversionResult.error}`,
        };
    }

    // Extract function definitions from WGSL (skip bindings and main)
    let wgslFunctions = conversionResult.wgsl;

    // Remove binding declarations (we'll add our own with correct groups)
    wgslFunctions = wgslFunctions.replace(/@group\(\d+\)\s*@binding\(\d+\)\s*\nvar\s+[^;]+;/g, '');
    wgslFunctions = wgslFunctions.replace(/@group\(\d+\)\s*@binding\(\d+\)\s*var\s+[^;]+;/g, '');

    // Remove struct declarations for output
    wgslFunctions = wgslFunctions.replace(/struct\s+FragmentOutput\s*\{[^}]*\}/g, '');
    wgslFunctions = wgslFunctions.replace(/struct\s+VertexOutput\s*\{[^}]*\}/g, '');

    // Remove private variables for fragment I/O
    wgslFunctions = wgslFunctions.replace(/var<private>\s+v_texCoord_1:\s*vec2<f32>;/g, '');
    wgslFunctions = wgslFunctions.replace(/var<private>\s+fragColor:\s*vec4<f32>;/g, '');

    // Remove @fragment fn main and everything after
    wgslFunctions = wgslFunctions.replace(/@fragment[\s\S]*$/m, '');
    wgslFunctions = wgslFunctions.replace(/fn\s+main_1\s*\(\s*\)\s*\{[\s\S]*?\n\}\s*\n/gm, '');

    // Replace textureSample with textureSampleLevel for compute shader compatibility
    wgslFunctions = wgslFunctions.replace(/textureSample\s*\(/g, 'textureSampleLevel(');
    wgslFunctions = wgslFunctions.replace(
        /(textureSampleLevel\([^;]+)(\);)/g,
        (match, prefix) => prefix + ', 0.0);'
    );

    // Clean up empty lines
    wgslFunctions = wgslFunctions.replace(/\n\s*\n\s*\n/g, '\n\n').trim();

    // Build texture bindings for CLI shader (Group 1)
    let textureBindings = '';
    let bindingIndex = 0;
    const textures: RgcTextureInfo[] = [];

    for (const tex of rgcInfo.textures) {
        const texData = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
        const channels = tex.channel === 0 ? 1 : 3;

        textures.push({
            name: tex.samplerName,
            type: '2d',
            width: tex.width,
            height: tex.height,
            channels,
            data: texData,
        });

        const texName = `rgc_${tex.samplerName}_tex`;
        const sampName = `rgc_${tex.samplerName}_samp`;
        textureBindings += `@group(1) @binding(${bindingIndex++}) var ${texName}: texture_2d<f32>;\n`;
        textureBindings += `@group(1) @binding(${bindingIndex++}) var ${sampName}: sampler;\n`;
    }

    for (const tex of rgcInfo.textures3D) {
        const texData = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);

        textures.push({
            name: tex.samplerName,
            type: '3d',
            width: tex.edgeLen,
            height: tex.edgeLen,
            depth: tex.edgeLen,
            channels: 3,
            data: texData,
        });

        const texName = `rgc_${tex.samplerName}_tex`;
        const sampName = `rgc_${tex.samplerName}_samp`;
        textureBindings += `@group(1) @binding(${bindingIndex++}) var ${texName}: texture_3d<f32>;\n`;
        textureBindings += `@group(1) @binding(${bindingIndex++}) var ${sampName}: sampler;\n`;
    }

    // Rename texture references in WGSL functions to use rgc_ prefix
    // Note: Naga may add numeric suffixes (_1, _2) to avoid name collisions
    let processedFunctions = wgslFunctions;
    for (const tex of [...rgcInfo.textures, ...rgcInfo.textures3D]) {
        const name = tex.samplerName;
        // Match with optional numeric suffix (e.g., name_tex or name_tex_1)
        processedFunctions = processedFunctions.replace(
            new RegExp(`\\b${name}_tex(_\\d+)?\\b`, 'g'),
            `rgc_${name}_tex`
        );
        processedFunctions = processedFunctions.replace(
            new RegExp(`\\b${name}_samp(_\\d+)?\\b`, 'g'),
            `rgc_${name}_samp`
        );
    }

    console.log(`[RGC] WGSL functions: ${processedFunctions.length} chars, ${textures.length} textures`);

    return {
        wgslFunctions: processedFunctions,
        mainFunctionName,
        textureBindings,
        textures,
        success: true,
    };
}
