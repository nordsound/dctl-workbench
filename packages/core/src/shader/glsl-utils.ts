/**
 * GLSL Utility Functions
 *
 * Shared utilities for GLSL preprocessing and conversion to WGSL.
 * Used by ocio-wgsl-builder, ocio-compute-wgsl-builder, integrated-shader-builder,
 * and dctl-export-shader-builder.
 */

import type { TextureBinding } from '../types/index.js';

/**
 * Sampler declaration info extracted from GLSL code
 */
export interface SamplerDeclaration {
    /** Original sampler name in GLSL */
    name: string;
    /** Sampler type: sampler2D or sampler3D */
    type: 'sampler2D' | 'sampler3D';
    /** Generated texture variable name (e.g., "name_tex") */
    texName: string;
    /** Generated sampler variable name (e.g., "name_samp") */
    samplerName: string;
}

/**
 * Result of processing sampler declarations
 */
export interface SamplerProcessingResult {
    /** Modified GLSL code with separated texture/sampler declarations */
    code: string;
    /** List of sampler declarations found */
    declarations: SamplerDeclaration[];
    /** Texture bindings generated */
    bindings: TextureBinding[];
    /** Next available binding index */
    nextBindingIndex: number;
}

/**
 * Options for sampler processing
 */
export interface SamplerProcessingOptions {
    /** How to handle duplicate sampler declarations */
    duplicateStrategy?: 'skip' | 'remove';
    /** Prefix to add to generated variable names */
    prefix?: string;
}

/**
 * Fix GLSL code for naga compatibility
 *
 * Applies several transformations to make OCIO-generated GLSL compatible with naga:
 * - Removes C-style float suffixes (1.0f -> 1.0)
 * - Removes 'const' from array declarations
 * - Fixes integer literals in float context
 * - Fixes texture coordinate calculations
 */
export function fixGlslForNaga(glslCode: string): string {
    let fixed = glslCode;

    // Remove C-style float suffixes (1.0f -> 1.0)
    fixed = fixed.replace(/(\d+\.?\d*)f\b/g, '$1');

    // Remove 'const' from array declarations - naga doesn't support this qualifier
    // e.g., "const float arr[N] = float[N](...)" -> "float arr[N] = float[N](...)"
    fixed = fixed.replace(
        /const\s+(float|int|vec\d|mat\d)\s+(\w+)\s*\[/g,
        '$1 $2['
    );

    // Fix integer literals in float context
    fixed = fixed.replace(/(\w+_(?:base|lo|hi)) \+ (\d+);/g, '$1 + $2.0;');
    fixed = fixed.replace(/(\w+_(?:base|lo|hi)) - (\d+);/g, '$1 - $2.0;');

    // Fix texture coordinate calculations
    fixed = fixed.replace(
        /\((\w+) \+ 0\.5\) \/ (\d+)(?!\.)/g,
        '(float($1) + 0.5) / $2.0'
    );
    fixed = fixed.replace(
        /\((\w+) - (\d+) \+ 0\.5\) \/ (\d+)(?!\.)/g,
        '(float($1) - $2.0 + 0.5) / $3.0'
    );

    return fixed;
}

/**
 * Process sampler declarations in GLSL code
 *
 * Converts combined sampler declarations (uniform sampler2D xxx) to
 * separated texture/sampler declarations required by Vulkan GLSL 4.50
 * for naga conversion.
 *
 * @param code - GLSL code containing sampler declarations
 * @param startBindingIndex - Starting binding index for new declarations
 * @param options - Processing options
 * @returns Processing result with modified code and binding info
 */
export function processSamplerDeclarations(
    code: string,
    startBindingIndex: number,
    options: SamplerProcessingOptions = {}
): SamplerProcessingResult {
    const { duplicateStrategy = 'skip', prefix = '' } = options;

    const declarations: SamplerDeclaration[] = [];
    const bindings: TextureBinding[] = [];
    const samplerNames = new Set<string>();
    let bindingIndex = startBindingIndex;

    // Find all sampler declarations and convert to separated texture/sampler
    const processedCode = code.replace(
        /uniform\s+sampler(2D|3D)\s+(\w+)\s*;/g,
        (match, type, name) => {
            if (samplerNames.has(name)) {
                return duplicateStrategy === 'skip' ? match : '';
            }
            samplerNames.add(name);

            const texBinding = bindingIndex++;
            const samplerBinding = bindingIndex++;
            const texName = `${prefix}${name}_tex`;
            const samplerName = `${prefix}${name}_samp`;

            declarations.push({
                name,
                type: `sampler${type}` as 'sampler2D' | 'sampler3D',
                texName,
                samplerName,
            });

            bindings.push({
                binding: texBinding,
                type: type === '2D' ? 'texture2D' : 'texture3D',
                name: texName,
                originalName: name,
            });
            bindings.push({
                binding: samplerBinding,
                type: 'sampler',
                name: samplerName,
                originalName: name,
            });

            // Return separated texture and sampler declarations
            return `layout(set = 0, binding = ${texBinding}) uniform texture${type} ${texName};
layout(set = 0, binding = ${samplerBinding}) uniform sampler ${samplerName};`;
        }
    );

    return {
        code: processedCode,
        declarations,
        bindings,
        nextBindingIndex: bindingIndex,
    };
}

/**
 * Replace texture() calls to use separated sampler constructors
 *
 * Transforms texture(samplerName, coord) to texture(sampler2D(texName, sampName), coord)
 *
 * @param code - GLSL code with texture() calls
 * @param declarations - Sampler declarations from processSamplerDeclarations
 * @returns Modified code with updated texture() calls
 */
export function replaceSamplerTextureCalls(
    code: string,
    declarations: SamplerDeclaration[]
): string {
    let result = code;

    for (const decl of declarations) {
        const dimSuffix = decl.type.replace('sampler', '');
        const regex = new RegExp(`texture\\(\\s*${decl.name}\\s*,`, 'g');
        result = result.replace(
            regex,
            `texture(sampler${dimSuffix}(${decl.texName}, ${decl.samplerName}),`
        );
    }

    return result;
}

/**
 * Find the main OCIO function name in GLSL code
 *
 * Searches for common OCIO main function patterns:
 * - OCIODisplay
 * - ocio_main
 * - OCIOMain
 *
 * @param code - GLSL code to search
 * @returns Function name or 'OCIOMain' as default
 */
export function findOcioMainFunction(code: string): string {
    const mainFuncMatch = code.match(
        /vec4\s+(OCIODisplay|ocio_main|OCIOMain)\s*\(/
    );
    return mainFuncMatch ? mainFuncMatch[1] : 'OCIOMain';
}

/**
 * Build Vulkan GLSL 4.50 shader preamble
 *
 * Creates the standard header for Vulkan GLSL shaders including:
 * - Version declaration
 * - Input/output declarations
 * - Image texture bindings (optional)
 *
 * @param options - Preamble configuration
 * @returns GLSL preamble string
 */
export interface ShaderPreambleOptions {
    /** Include vertex input (v_texCoord) */
    hasVertexInput?: boolean;
    /** Include fragment output (fragColor) */
    hasFragmentOutput?: boolean;
    /** Include image texture bindings */
    hasImageTexture?: boolean;
    /** Binding index for image texture (default: 0) */
    imageTextureBinding?: number;
    /** Binding index for image sampler (default: 1) */
    imageSamplerBinding?: number;
}

export function buildVulkanGlslPreamble(options: ShaderPreambleOptions = {}): string {
    const {
        hasVertexInput = true,
        hasFragmentOutput = true,
        hasImageTexture = true,
        imageTextureBinding = 0,
        imageSamplerBinding = 1,
    } = options;

    let preamble = '#version 450\n\n';

    if (hasVertexInput || hasFragmentOutput) {
        preamble += '// Input/Output\n';
        if (hasVertexInput) {
            preamble += 'layout(location = 0) in vec2 v_texCoord;\n';
        }
        if (hasFragmentOutput) {
            preamble += 'layout(location = 0) out vec4 fragColor;\n';
        }
        preamble += '\n';
    }

    if (hasImageTexture) {
        preamble += '// Image texture (source EXR)\n';
        preamble += `layout(set = 0, binding = ${imageTextureBinding}) uniform texture2D u_image_tex;\n`;
        preamble += `layout(set = 0, binding = ${imageSamplerBinding}) uniform sampler u_image_samp;\n`;
        preamble += '\n';
    }

    return preamble;
}

/**
 * Build a main() function that calls OCIO transform
 *
 * @param ocioMainFunc - Name of the OCIO main function to call
 * @returns GLSL main function string
 */
export function buildOcioMainFunction(ocioMainFunc: string): string {
    return `
void main() {
    vec4 color = texture(sampler2D(u_image_tex, u_image_samp), v_texCoord);
    vec4 result = ${ocioMainFunc}(color);
    // Only clamp negative values, allow HDR values > 1.0
    fragColor = max(result, vec4(0.0));
}
`;
}
