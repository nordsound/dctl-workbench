/**
 * Compute Pipeline Manager
 *
 * Manages WebGPU compute pipelines for image processing.
 * Handles color transforms, analysis, and other GPU compute operations.
 *
 * Bind Group Layout:
 * - Group 0: Source texture
 * - Group 1: Output storage texture
 * - Group 2: OCIO LUT textures + RGC textures (merged, dynamic)
 * - Group 3: Parameters + DCTL uniform buffer
 * - Group 4: Zone System (params + zones) - optional, not used with DCTL
 *
 * Note: RGC textures are merged into Group 2 to stay within WebGPU's
 * maximum of 4 bind groups limit.
 */

import { ZoneBufferManager } from './zone-buffer-manager';
import {
    createFilteringSampler,
    convertRgbToRgba,
} from './texture-utils';
import {
    GPUProfiler,
    GPUTimingResult,
} from './shared/gpu-profiler';
import { DctlParamBuffer, type DctlParamMapping } from './dctl-param-buffer';
import type { DctlColorValue } from './shared/dctl-controls';
import type { DctlComputeShaderInfo } from '../shader';

// Workgroup size for compute shaders (16x16 = 256 threads per workgroup)
const WORKGROUP_SIZE_X = 16;
const WORKGROUP_SIZE_Y = 16;

export interface ComputeTextureInfo {
    texture: GPUTexture;
    view: GPUTextureView;
    sampler: GPUSampler;
}

export interface ComputePipelineConfig {
    width: number;
    height: number;
}

export interface OcioTextureInfo {
    name: string;
    texture: GPUTexture;
    type: '2d' | '3d';
}

export interface OcioComputeShaderInfo {
    wgslCode: string;
    textures2D: Array<{
        name: string;
        width: number;
        height: number;
        /** Channel type: 0 = single channel (r32float), 1 = RGB (rgba32float) */
        channel: number;
        data: Float32Array | number[];
    }>;
    textures3D: Array<{
        name: string;
        edgeLen: number;
        data: Float32Array | number[];
    }>;
}

// Default passthrough compute shader for testing
const PASSTHROUGH_COMPUTE_SHADER = /* wgsl */`
// Source texture (input)
@group(0) @binding(0) var source_texture: texture_2d<f32>;

// Output texture (storage)
@group(1) @binding(0) var output_texture: texture_storage_2d<rgba32float, write>;

// Parameters
struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}
@group(2) @binding(0) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    // Bounds check
    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    // Load source pixel
    let color = textureLoad(source_texture, coords, 0);

    // Passthrough: store as-is
    textureStore(output_texture, coords, color);
}
`;

// Zone System compute shader
// Uses 5-group layout: Source, Output, (empty OCIO), Params, Zone
const ZONE_SYSTEM_COMPUTE_SHADER = /* wgsl */`
// Source texture (input)
@group(0) @binding(0) var source_texture: texture_2d<f32>;

// Output texture (storage)
@group(1) @binding(0) var output_texture: texture_storage_2d<rgba32float, write>;

// Group 2 is reserved for OCIO textures (empty in this shader)

// Parameters
struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}
@group(3) @binding(0) var<uniform> params: Params;

// Zone System parameters
struct ZoneParams {
    enabled: u32,
    style: u32,
    opacity: f32,
    zone_count: u32,
    middle_gray: f32,
    _padding: vec3<f32>,
}

// Zone definition
struct ZoneDefinition {
    color: vec3<f32>,
    min_stop: f32,
    max_stop: f32,
    _padding: vec3<f32>,
}

@group(4) @binding(0) var<uniform> zone_params: ZoneParams;
@group(4) @binding(1) var<storage, read> zones: array<ZoneDefinition>;

// Calculate luminance using Rec. 709 coefficients
fn zone_calculate_luminance(color: vec3<f32>) -> f32 {
    return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Calculate stops from middle gray
fn zone_calculate_stops(luminance: f32, middle_gray: f32) -> f32 {
    if (luminance <= 0.0) {
        return -100.0;
    }
    return log2(luminance / middle_gray);
}

// Get zone color based on stops
fn zone_get_color(stops: f32) -> vec3<f32> {
    for (var i = 0u; i < zone_params.zone_count; i++) {
        let zone = zones[i];
        if (stops >= zone.min_stop && stops < zone.max_stop) {
            return zone.color;
        }
    }
    if (zone_params.zone_count > 0u) {
        return zones[zone_params.zone_count - 1u].color;
    }
    return vec3<f32>(1.0, 0.0, 1.0); // Magenta fallback
}

// Apply zone blend
fn zone_apply_blend(original: vec3<f32>, zone_color: vec3<f32>) -> vec3<f32> {
    switch (zone_params.style) {
        case 0u, 1u: {
            // False color / Bars: mix blend
            return mix(original, zone_color, zone_params.opacity);
        }
        case 2u: {
            // Overlay: additive blend
            return original + zone_color * zone_params.opacity;
        }
        default: {
            return original;
        }
    }
}

@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    // Bounds check
    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    // Load source pixel
    let source_color = textureLoad(source_texture, coords, 0);
    var color = source_color.rgb;

    // Apply Zone System if enabled
    if (zone_params.enabled == 1u) {
        let luminance = zone_calculate_luminance(source_color.rgb);
        let stops = zone_calculate_stops(luminance, zone_params.middle_gray);
        let zone_color = zone_get_color(stops);
        color = zone_apply_blend(color, zone_color);
    }

    // Store result
    textureStore(output_texture, coords, vec4<f32>(color, 1.0));
}
`;

// Display shader for rendering compute output to canvas
const DISPLAY_VERTEX_SHADER = /* wgsl */`
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) tex_coord: vec2<f32>,
}

@vertex
fn main(@location(0) position: vec2<f32>, @location(1) tex_coord: vec2<f32>) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(position, 0.0, 1.0);
    output.tex_coord = tex_coord;
    return output;
}
`;

const DISPLAY_FRAGMENT_SHADER = /* wgsl */`
@group(0) @binding(0) var display_texture: texture_2d<f32>;
@group(0) @binding(1) var display_sampler: sampler;

@fragment
fn main(@location(0) tex_coord: vec2<f32>) -> @location(0) vec4<f32> {
    let color = textureSample(display_texture, display_sampler, tex_coord);
    // Only clamp negative values, allow HDR values > 1.0 for extended tone mapping
    return max(color, vec4<f32>(0.0));
}
`;

export class ComputePipelineManager {
    private device: GPUDevice | null = null;

    // Compute pipeline
    private computePipeline: GPUComputePipeline | null = null;
    private sourceBindGroupLayout: GPUBindGroupLayout | null = null;
    private outputBindGroupLayout: GPUBindGroupLayout | null = null;
    private ocioBindGroupLayout: GPUBindGroupLayout | null = null;
    private paramsBindGroupLayout: GPUBindGroupLayout | null = null;

    // Bind groups
    private sourceBindGroup: GPUBindGroup | null = null;
    private outputBindGroup: GPUBindGroup | null = null;
    private ocioBindGroup: GPUBindGroup | null = null;
    private paramsBindGroup: GPUBindGroup | null = null;

    // Buffers
    private paramsBuffer: GPUBuffer | null = null;

    // Textures
    private outputTexture: GPUTexture | null = null;
    private outputTextureView: GPUTextureView | null = null;

    // OCIO textures
    private ocioTextures: GPUTexture[] = [];
    private ocioSampler: GPUSampler | null = null;
    private hasOcioTextures: boolean = false;

    // Zone System
    private zoneBufferManager: ZoneBufferManager | null = null;
    private zoneBindGroup: GPUBindGroup | null = null;
    private hasZoneSystem: boolean = false;

    // DCTL Support
    private dctlParamBuffer: DctlParamBuffer | null = null;
    private dctlParamsBindGroupLayout: GPUBindGroupLayout | null = null;
    private dctlParamsBindGroup: GPUBindGroup | null = null;
    private hasDctl: boolean = false;
    private dctlParamMapping: DctlParamMapping[] = [];

    // RGC (Reference Gamut Compression) Support
    private rgcTextures: GPUTexture[] = [];
    private rgcBindGroupLayout: GPUBindGroupLayout | null = null;
    private rgcBindGroup: GPUBindGroup | null = null;
    private hasFullRgc: boolean = false;

    // Display pipeline
    private displayPipeline: GPURenderPipeline | null = null;
    private displayBindGroupLayout: GPUBindGroupLayout | null = null;
    private displayBindGroup: GPUBindGroup | null = null;
    private displaySampler: GPUSampler | null = null;
    private vertexBuffer: GPUBuffer | null = null;
    private displayFormat: GPUTextureFormat = 'bgra8unorm';  // Current display format

    // Current config
    private currentWidth: number = 0;
    private currentHeight: number = 0;

    // GPU Profiler (optional)
    private profiler: GPUProfiler | null = null;
    private lastTimingResults: GPUTimingResult[] = [];

    /**
     * Initialize the compute pipeline manager
     */
    async init(device: GPUDevice): Promise<void> {
        this.device = device;

        // Initialize display format from preferred canvas format
        const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
        this.displayFormat = preferredFormat.includes('srgb')
            ? (preferredFormat.replace('-srgb', '') as GPUTextureFormat)
            : preferredFormat;

        // Create bind group layouts
        this.createBindGroupLayouts();

        // Create params buffer
        this.paramsBuffer = device.createBuffer({
            size: 16, // 4 x u32 (width, height, padding x2)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Create samplers using shared utility
        this.displaySampler = createFilteringSampler(device, 'Display Sampler');
        this.ocioSampler = createFilteringSampler(device, 'OCIO LUT Sampler');

        // Initialize Zone System buffer manager
        this.zoneBufferManager = new ZoneBufferManager();
        this.zoneBufferManager.init(device);

        // Create vertex buffer for fullscreen quad
        const vertices = new Float32Array([
            // position (xy), texCoord (uv)
            -1, -1, 0, 1,
             1, -1, 1, 1,
            -1,  1, 0, 0,
             1,  1, 1, 0,
        ]);
        this.vertexBuffer = device.createBuffer({
            size: vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.vertexBuffer, 0, vertices);

        // Build default passthrough pipeline
        await this.buildComputePipeline(PASSTHROUGH_COMPUTE_SHADER);

        // Build display pipeline
        await this.buildDisplayPipeline();
    }

    /**
     * Check if initialized
     */
    get isInitialized(): boolean {
        return this.device !== null && this.computePipeline !== null;
    }

    /**
     * Set GPU profiler for timing measurements
     */
    setProfiler(profiler: GPUProfiler | null): void {
        this.profiler = profiler;
        if (profiler) {
            console.log('[Compute] GPU profiler attached');
        }
    }

    /**
     * Get last timing results from profiler
     */
    getTimingResults(): GPUTimingResult[] {
        return this.lastTimingResults;
    }

    /**
     * Clear timing results and reset profiler for next frame
     */
    resetProfiler(): void {
        if (this.profiler) {
            this.profiler.reset();
            this.lastTimingResults = [];
        }
    }

    /**
     * Create bind group layouts
     */
    private createBindGroupLayouts(): void {
        if (!this.device) return;

        // Group 0: Source texture
        this.sourceBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Compute Source',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'unfilterable-float' },
                },
            ],
        });

        // Group 1: Output storage texture
        this.outputBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Compute Output',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba32float',
                    },
                },
            ],
        });

        // Group 2: Parameters
        this.paramsBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Compute Params',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' },
                },
            ],
        });

        // Display bind group layout
        this.displayBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Display',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' },
                },
            ],
        });
    }

    /**
     * Build compute pipeline with custom shader (simple 3-group layout)
     * Use this for passthrough or simple compute shaders without OCIO
     */
    async buildComputePipeline(wgslCode: string): Promise<boolean> {
        if (!this.device || !this.sourceBindGroupLayout ||
            !this.outputBindGroupLayout || !this.paramsBindGroupLayout) {
            return false;
        }

        try {
            const shaderModule = this.device.createShaderModule({
                label: 'Color Transform Compute',
                code: wgslCode,
            });

            const pipelineLayout = this.device.createPipelineLayout({
                label: 'Compute Pipeline Layout',
                bindGroupLayouts: [
                    this.sourceBindGroupLayout,
                    this.outputBindGroupLayout,
                    this.paramsBindGroupLayout,
                ],
            });

            this.computePipeline = this.device.createComputePipeline({
                label: 'Color Transform Pipeline',
                layout: pipelineLayout,
                compute: {
                    module: shaderModule,
                    entryPoint: 'main',
                },
            });

            // Clear OCIO state for simple pipeline
            this.hasOcioTextures = false;
            this.ocioBindGroup = null;

            return true;
        } catch (e) {
            console.error('Failed to build compute pipeline:', e);
            return false;
        }
    }

    /**
     * Build compute pipeline with OCIO textures (4-group layout)
     * Group 0: Source texture
     * Group 1: Output storage texture
     * Group 2: OCIO LUT textures and samplers
     * Group 3: Parameters
     */
    async buildOcioComputePipeline(shaderInfo: OcioComputeShaderInfo): Promise<boolean> {
        if (!this.device || !this.sourceBindGroupLayout ||
            !this.outputBindGroupLayout || !this.paramsBindGroupLayout ||
            !this.ocioSampler) {
            console.error('Device or bind group layouts not initialized');
            return false;
        }

        try {
            // Cleanup old OCIO textures
            this.cleanupOcioTextures();

            // Create OCIO textures
            const ocioBindGroupEntries: GPUBindGroupEntry[] = [];
            const ocioLayoutEntries: GPUBindGroupLayoutEntry[] = [];
            let bindingIndex = 0;

            // Create 2D LUT textures
            for (const tex of shaderInfo.textures2D) {
                const data = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
                const numPixels = tex.width * tex.height;

                // Handle channel type: 0 = single channel, 1 = RGB
                let uploadData: Float32Array;
                let format: GPUTextureFormat;
                let bytesPerPixel: number;

                if (tex.channel === 0) {
                    // Single channel - use r32float format
                    format = 'r32float';
                    uploadData = data;
                    bytesPerPixel = 4;
                } else {
                    // RGB - convert to RGBA using shared utility
                    format = 'rgba32float';
                    uploadData = convertRgbToRgba(data, numPixels);
                    bytesPerPixel = 16;
                }

                const texture = this.device.createTexture({
                    label: `OCIO LUT 2D: ${tex.name}`,
                    size: [tex.width, tex.height],
                    format,
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                });

                this.device.queue.writeTexture(
                    { texture },
                    uploadData,
                    { bytesPerRow: tex.width * bytesPerPixel },
                    [tex.width, tex.height]
                );

                this.ocioTextures.push(texture);

                // Add texture binding
                ocioLayoutEntries.push({
                    binding: bindingIndex,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float' },
                });
                ocioBindGroupEntries.push({
                    binding: bindingIndex++,
                    resource: texture.createView(),
                });

                // Add sampler binding
                ocioLayoutEntries.push({
                    binding: bindingIndex,
                    visibility: GPUShaderStage.COMPUTE,
                    sampler: { type: 'filtering' },
                });
                ocioBindGroupEntries.push({
                    binding: bindingIndex++,
                    resource: this.ocioSampler,
                });
            }

            // Create 3D LUT textures
            for (const tex of shaderInfo.textures3D) {
                const data = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
                const size = tex.edgeLen;

                // Convert RGB to RGBA using shared utility
                const numVoxels = size * size * size;
                const rgbaData = convertRgbToRgba(data, numVoxels);

                const texture = this.device.createTexture({
                    label: `OCIO LUT 3D: ${tex.name}`,
                    size: [size, size, size],
                    dimension: '3d',
                    format: 'rgba32float',
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                });

                this.device.queue.writeTexture(
                    { texture },
                    rgbaData,
                    { bytesPerRow: size * 16, rowsPerImage: size },
                    [size, size, size]
                );

                this.ocioTextures.push(texture);

                // Add texture binding
                ocioLayoutEntries.push({
                    binding: bindingIndex,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float', viewDimension: '3d' },
                });
                ocioBindGroupEntries.push({
                    binding: bindingIndex++,
                    resource: texture.createView({ dimension: '3d' }),
                });

                // Add sampler binding
                ocioLayoutEntries.push({
                    binding: bindingIndex,
                    visibility: GPUShaderStage.COMPUTE,
                    sampler: { type: 'filtering' },
                });
                ocioBindGroupEntries.push({
                    binding: bindingIndex++,
                    resource: this.ocioSampler,
                });
            }

            // Create OCIO bind group layout
            this.ocioBindGroupLayout = this.device.createBindGroupLayout({
                label: 'OCIO Textures',
                entries: ocioLayoutEntries,
            });

            // Create OCIO bind group
            if (ocioBindGroupEntries.length > 0) {
                this.ocioBindGroup = this.device.createBindGroup({
                    label: 'OCIO Bind Group',
                    layout: this.ocioBindGroupLayout,
                    entries: ocioBindGroupEntries,
                });
                this.hasOcioTextures = true;
            } else {
                // Create empty bind group for shaders that expect group 2
                this.ocioBindGroup = this.device.createBindGroup({
                    label: 'OCIO Bind Group (Empty)',
                    layout: this.ocioBindGroupLayout,
                    entries: [],
                });
                this.hasOcioTextures = false;
            }

            // Create shader module
            const shaderModule = this.device.createShaderModule({
                label: 'OCIO Color Transform Compute',
                code: shaderInfo.wgslCode,
            });

            // Create pipeline layout with 4 groups
            const pipelineLayout = this.device.createPipelineLayout({
                label: 'OCIO Compute Pipeline Layout',
                bindGroupLayouts: [
                    this.sourceBindGroupLayout,
                    this.outputBindGroupLayout,
                    this.ocioBindGroupLayout,
                    this.paramsBindGroupLayout,
                ],
            });

            // Create compute pipeline
            this.computePipeline = this.device.createComputePipeline({
                label: 'OCIO Color Transform Pipeline',
                layout: pipelineLayout,
                compute: {
                    module: shaderModule,
                    entryPoint: 'main',
                },
            });

            // Reset DCTL state when switching to OCIO-only pipeline
            this.hasDctl = false;
            this.dctlParamMapping = [];
            this.dctlParamsBindGroup = null;
            this.dctlParamsBindGroupLayout = null;

            // Log texture details for debugging
            const texDetails = shaderInfo.textures2D.map(t => `${t.name}(ch=${t.channel})`).join(', ');
            console.log(`[Compute] Built OCIO pipeline with ${shaderInfo.textures2D.length} 2D LUTs [${texDetails}] and ${shaderInfo.textures3D.length} 3D LUTs`);
            return true;
        } catch (e) {
            console.error('Failed to build OCIO compute pipeline:', e);
            return false;
        }
    }

    /**
     * Build Zone System compute pipeline
     * Uses 5-group layout: Source, Output, (empty OCIO), Params, Zone
     */
    async buildZoneSystemPipeline(): Promise<boolean> {
        if (!this.device || !this.sourceBindGroupLayout ||
            !this.outputBindGroupLayout || !this.paramsBindGroupLayout ||
            !this.zoneBufferManager) {
            console.error('Device or bind group layouts not initialized');
            return false;
        }

        try {
            // Zone System compute shader (inlined to avoid Node.js module issues)
            const shaderCode = ZONE_SYSTEM_COMPUTE_SHADER;

            // Create empty OCIO bind group layout (Group 2)
            const emptyOcioLayout = this.device.createBindGroupLayout({
                label: 'Empty OCIO',
                entries: [],
            });

            // Create empty OCIO bind group
            const emptyOcioBindGroup = this.device.createBindGroup({
                label: 'Empty OCIO Bind Group',
                layout: emptyOcioLayout,
                entries: [],
            });

            // Get Zone bind group layout from manager
            const zoneBindGroupLayout = this.zoneBufferManager.getBindGroupLayout();
            if (!zoneBindGroupLayout) {
                console.error('Zone bind group layout not available');
                return false;
            }

            // Create shader module
            const shaderModule = this.device.createShaderModule({
                label: 'Zone System Compute',
                code: shaderCode,
            });

            // Create pipeline layout with 5 groups
            const pipelineLayout = this.device.createPipelineLayout({
                label: 'Zone System Compute Pipeline Layout',
                bindGroupLayouts: [
                    this.sourceBindGroupLayout,   // Group 0: Source
                    this.outputBindGroupLayout,   // Group 1: Output
                    emptyOcioLayout,              // Group 2: Empty OCIO
                    this.paramsBindGroupLayout,   // Group 3: Params
                    zoneBindGroupLayout,          // Group 4: Zone
                ],
            });

            // Create compute pipeline
            this.computePipeline = this.device.createComputePipeline({
                label: 'Zone System Compute Pipeline',
                layout: pipelineLayout,
                compute: {
                    module: shaderModule,
                    entryPoint: 'main',
                },
            });

            // Store OCIO state for dispatch
            this.ocioBindGroupLayout = emptyOcioLayout;
            this.ocioBindGroup = emptyOcioBindGroup;
            this.hasOcioTextures = false;
            this.hasZoneSystem = true;
            this.zoneBindGroup = this.zoneBufferManager.getBindGroup();

            console.log('[Compute] Built Zone System pipeline');
            return true;
        } catch (e) {
            console.error('Failed to build Zone System pipeline:', e);
            return false;
        }
    }

    /**
     * Build compute pipeline with DCTL + OCIO (5-group layout with DCTL Uniform Buffer)
     * Group 0: Source texture
     * Group 1: Output storage texture
     * Group 2: OCIO LUT textures and samplers
     * Group 3: Parameters + DCTL Uniform Buffer
     * Group 4: Zone System (optional, not used in DCTL pipeline)
     *
     * @param shaderInfo DCTL compute shader info from buildDctlComputeShader()
     */
    async buildDctlOcioComputePipeline(shaderInfo: DctlComputeShaderInfo): Promise<boolean> {
        if (!this.device || !this.sourceBindGroupLayout ||
            !this.outputBindGroupLayout || !this.ocioSampler) {
            console.error('Device or bind group layouts not initialized');
            return false;
        }

        try {
            // Cleanup old OCIO textures
            this.cleanupOcioTextures();

            // Create OCIO textures (Group 2)
            const ocioBindGroupEntries: GPUBindGroupEntry[] = [];
            const ocioLayoutEntries: GPUBindGroupLayoutEntry[] = [];
            let bindingIndex = 0;

            // Create 2D LUT textures
            for (const tex of shaderInfo.textures) {
                const texData = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
                const width = tex.width;
                const height = tex.height;
                const numPixels = width * height;

                // Handle channel type
                let uploadData: Float32Array;
                let format: GPUTextureFormat;
                let bytesPerPixel: number;

                if (tex.channel === 0) {
                    // Single channel - use r32float format
                    format = 'r32float';
                    uploadData = texData;
                    bytesPerPixel = 4;
                } else {
                    // RGB - convert to RGBA
                    format = 'rgba32float';
                    uploadData = convertRgbToRgba(texData, numPixels);
                    bytesPerPixel = 16;
                }

                const texture = this.device.createTexture({
                    label: `OCIO LUT 2D: ${tex.samplerName}`,
                    size: [width, height],
                    format,
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                });

                this.device.queue.writeTexture(
                    { texture },
                    uploadData,
                    { bytesPerRow: width * bytesPerPixel },
                    [width, height]
                );

                this.ocioTextures.push(texture);

                // Add texture binding
                ocioLayoutEntries.push({
                    binding: bindingIndex,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float' },
                });
                ocioBindGroupEntries.push({
                    binding: bindingIndex++,
                    resource: texture.createView(),
                });

                // Add sampler binding
                ocioLayoutEntries.push({
                    binding: bindingIndex,
                    visibility: GPUShaderStage.COMPUTE,
                    sampler: { type: 'filtering' },
                });
                ocioBindGroupEntries.push({
                    binding: bindingIndex++,
                    resource: this.ocioSampler,
                });
            }

            // Create 3D LUT textures
            for (const tex of shaderInfo.textures3D) {
                const tex3dData = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
                const size = tex.edgeLen;

                // Convert RGB to RGBA
                const numVoxels = size * size * size;
                const rgbaData = convertRgbToRgba(tex3dData, numVoxels);

                const texture = this.device.createTexture({
                    label: `OCIO LUT 3D: ${tex.samplerName}`,
                    size: [size, size, size],
                    dimension: '3d',
                    format: 'rgba32float',
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                });

                this.device.queue.writeTexture(
                    { texture },
                    rgbaData,
                    { bytesPerRow: size * 16, rowsPerImage: size },
                    [size, size, size]
                );

                this.ocioTextures.push(texture);

                // Add texture binding
                ocioLayoutEntries.push({
                    binding: bindingIndex,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float', viewDimension: '3d' },
                });
                ocioBindGroupEntries.push({
                    binding: bindingIndex++,
                    resource: texture.createView({ dimension: '3d' }),
                });

                // Add sampler binding
                ocioLayoutEntries.push({
                    binding: bindingIndex,
                    visibility: GPUShaderStage.COMPUTE,
                    sampler: { type: 'filtering' },
                });
                ocioBindGroupEntries.push({
                    binding: bindingIndex++,
                    resource: this.ocioSampler,
                });
            }

            // Handle RGC textures (merged into Group 2 with OCIO)
            // Note: RGC textures are added to the same bind group as OCIO textures
            this.cleanupRgcTextures();
            this.hasFullRgc = false;

            if (shaderInfo.hasFullRgc && (shaderInfo.rgcTextures || shaderInfo.rgcTextures3D)) {
                // Create RGC 2D textures (continue bindingIndex from OCIO)
                if (shaderInfo.rgcTextures) {
                    for (const tex of shaderInfo.rgcTextures) {
                        const texData = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
                        const width = tex.width;
                        const height = tex.height;
                        const numPixels = width * height;

                        // Handle channel type
                        let uploadData: Float32Array;
                        let format: GPUTextureFormat;
                        let bytesPerPixel: number;

                        if (tex.channel === 0) {
                            format = 'r32float';
                            uploadData = texData;
                            bytesPerPixel = 4;
                        } else {
                            format = 'rgba32float';
                            uploadData = convertRgbToRgba(texData, numPixels);
                            bytesPerPixel = 16;
                        }

                        const texture = this.device.createTexture({
                            label: `RGC LUT 2D: ${tex.samplerName}`,
                            size: [width, height],
                            format,
                            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                        });

                        this.device.queue.writeTexture(
                            { texture },
                            uploadData,
                            { bytesPerRow: width * bytesPerPixel },
                            [width, height]
                        );

                        this.rgcTextures.push(texture);

                        // Add to OCIO bind group (merged)
                        ocioLayoutEntries.push({
                            binding: bindingIndex,
                            visibility: GPUShaderStage.COMPUTE,
                            texture: { sampleType: 'float' },
                        });
                        ocioBindGroupEntries.push({
                            binding: bindingIndex++,
                            resource: texture.createView(),
                        });

                        ocioLayoutEntries.push({
                            binding: bindingIndex,
                            visibility: GPUShaderStage.COMPUTE,
                            sampler: { type: 'filtering' },
                        });
                        ocioBindGroupEntries.push({
                            binding: bindingIndex++,
                            resource: this.ocioSampler!,
                        });
                    }
                }

                // Create RGC 3D textures (continue bindingIndex)
                if (shaderInfo.rgcTextures3D) {
                    for (const tex of shaderInfo.rgcTextures3D) {
                        const tex3dData = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
                        const size = tex.edgeLen;

                        const numVoxels = size * size * size;
                        const rgbaData = convertRgbToRgba(tex3dData, numVoxels);

                        const texture = this.device.createTexture({
                            label: `RGC LUT 3D: ${tex.samplerName}`,
                            size: [size, size, size],
                            dimension: '3d',
                            format: 'rgba32float',
                            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                        });

                        this.device.queue.writeTexture(
                            { texture },
                            rgbaData,
                            { bytesPerRow: size * 16, rowsPerImage: size },
                            [size, size, size]
                        );

                        this.rgcTextures.push(texture);

                        // Add to OCIO bind group (merged)
                        ocioLayoutEntries.push({
                            binding: bindingIndex,
                            visibility: GPUShaderStage.COMPUTE,
                            texture: { sampleType: 'float', viewDimension: '3d' },
                        });
                        ocioBindGroupEntries.push({
                            binding: bindingIndex++,
                            resource: texture.createView({ dimension: '3d' }),
                        });

                        ocioLayoutEntries.push({
                            binding: bindingIndex,
                            visibility: GPUShaderStage.COMPUTE,
                            sampler: { type: 'filtering' },
                        });
                        ocioBindGroupEntries.push({
                            binding: bindingIndex++,
                            resource: this.ocioSampler!,
                        });
                    }
                }

                if (this.rgcTextures.length > 0) {
                    this.hasFullRgc = true;
                    console.log(`[Compute] RGC textures merged into OCIO bind group: ${this.rgcTextures.length} textures`);
                }
            }

            // Debug: Log OCIO+RGC bind group entries
            console.log(`[Compute] OCIO+RGC bind group: ${ocioLayoutEntries.length} layout entries, ${ocioBindGroupEntries.length} bind entries`);
            for (let i = 0; i < Math.min(ocioLayoutEntries.length, 10); i++) {
                console.log(`[Compute] Layout entry ${i}: binding=${ocioLayoutEntries[i].binding}`);
            }
            for (let i = 0; i < Math.min(ocioBindGroupEntries.length, 10); i++) {
                console.log(`[Compute] Bind entry ${i}: binding=${ocioBindGroupEntries[i].binding}`);
            }

            // Create OCIO+RGC bind group layout (Group 2)
            this.ocioBindGroupLayout = this.device.createBindGroupLayout({
                label: 'OCIO+RGC Textures (DCTL Pipeline)',
                entries: ocioLayoutEntries,
            });

            console.log(`[Compute] Created OCIO+RGC bind group layout: ${this.ocioBindGroupLayout ? 'valid' : 'null'}`);

            // Create OCIO+RGC bind group
            if (ocioBindGroupEntries.length > 0) {
                console.log(`[Compute] Creating OCIO+RGC bind group with ${ocioBindGroupEntries.length} entries`);
                this.ocioBindGroup = this.device.createBindGroup({
                    label: 'OCIO+RGC Bind Group (DCTL Pipeline)',
                    layout: this.ocioBindGroupLayout,
                    entries: ocioBindGroupEntries,
                });
                console.log(`[Compute] OCIO+RGC bind group created successfully`);
                this.hasOcioTextures = true;
            } else {
                this.ocioBindGroup = this.device.createBindGroup({
                    label: 'OCIO+RGC Bind Group (Empty)',
                    layout: this.ocioBindGroupLayout,
                    entries: [],
                });
                this.hasOcioTextures = false;
            }

            // Create DCTL Params bind group layout (Group 3)
            // binding 0: Params (width, height)
            // binding 1: DCTL Uniform Buffer (if DCTL is enabled)
            const paramsLayoutEntries: GPUBindGroupLayoutEntry[] = [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' },
                },
            ];

            if (shaderInfo.hasDctl) {
                paramsLayoutEntries.push({
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' },
                });
            }

            this.dctlParamsBindGroupLayout = this.device.createBindGroupLayout({
                label: 'Params + DCTL Uniform Buffer',
                entries: paramsLayoutEntries,
            });

            // Initialize DCTL Param Buffer
            if (shaderInfo.hasDctl) {
                // Convert ShaderParamMapping to DctlParamMapping
                this.dctlParamMapping = shaderInfo.paramMapping.map(p => ({
                    name: p.name,
                    type: p.type as 'float' | 'int' | 'bool' | 'color',
                    bufferType: p.type === 'float' ? 'float_params' as const :
                                p.type === 'color' ? 'color_params' as const :
                                'int_params' as const,
                    index: p.index,
                    default: p.default,
                }));

                console.log(`[Compute] DCTL param mapping: ${this.dctlParamMapping.length} params`);

                if (!this.dctlParamBuffer) {
                    this.dctlParamBuffer = new DctlParamBuffer(this.device);
                }
                this.dctlParamBuffer.initialize(this.dctlParamMapping);
                console.log(`[Compute] DCTL param buffer initialized, buffer=${this.dctlParamBuffer.getBuffer() ? 'valid' : 'null'}`);
                this.hasDctl = true;
            } else {
                this.hasDctl = false;
                this.dctlParamMapping = [];
            }

            // Create shader module
            const shaderModule = this.device.createShaderModule({
                label: this.hasFullRgc ? 'DCTL + OCIO + RGC Compute Shader' : 'DCTL + OCIO Compute Shader',
                code: shaderInfo.computeWgsl,
            });

            // Check for shader compilation errors
            shaderModule.getCompilationInfo().then(info => {
                if (info.messages.length > 0) {
                    for (const msg of info.messages) {
                        const msgType = msg.type === 'error' ? 'ERROR' : msg.type === 'warning' ? 'WARN' : 'INFO';
                        console.log(`[Compute] Shader ${msgType} at line ${msg.lineNum}:${msg.linePos}: ${msg.message}`);
                    }
                }
            });

            // Build bind group layouts array (always 4 groups - RGC merged into OCIO)
            // Debug: Check for null bind group layouts
            console.log(`[Compute] Bind group layout check: source=${!!this.sourceBindGroupLayout}, output=${!!this.outputBindGroupLayout}, ocio=${!!this.ocioBindGroupLayout}, dctlParams=${!!this.dctlParamsBindGroupLayout}`);

            // Validate all required layouts exist
            if (!this.sourceBindGroupLayout || !this.outputBindGroupLayout || !this.ocioBindGroupLayout || !this.dctlParamsBindGroupLayout) {
                console.error('[Compute] Missing required bind group layout!');
                console.error(`  sourceBindGroupLayout: ${!!this.sourceBindGroupLayout}`);
                console.error(`  outputBindGroupLayout: ${!!this.outputBindGroupLayout}`);
                console.error(`  ocioBindGroupLayout: ${!!this.ocioBindGroupLayout}`);
                console.error(`  dctlParamsBindGroupLayout: ${!!this.dctlParamsBindGroupLayout}`);
                return false;
            }

            // RGC textures are now merged into OCIO bind group (Group 2)
            // Always use 4 bind groups to stay within WebGPU limits
            const bindGroupLayouts: GPUBindGroupLayout[] = [
                this.sourceBindGroupLayout,       // Group 0: Source
                this.outputBindGroupLayout,       // Group 1: Output
                this.ocioBindGroupLayout,         // Group 2: OCIO + RGC (merged)
                this.dctlParamsBindGroupLayout,   // Group 3: Params + DCTL
            ];

            console.log(`[Compute] Creating pipeline layout with ${bindGroupLayouts.length} bind groups (RGC=${this.hasFullRgc})`);

            // Create pipeline layout
            const pipelineLayout = this.device.createPipelineLayout({
                label: this.hasFullRgc ? 'DCTL + OCIO + RGC Compute Pipeline Layout' : 'DCTL + OCIO Compute Pipeline Layout',
                bindGroupLayouts,
            });

            // Create compute pipeline
            this.computePipeline = this.device.createComputePipeline({
                label: this.hasFullRgc ? 'DCTL + OCIO + RGC Compute Pipeline' : 'DCTL + OCIO Compute Pipeline',
                layout: pipelineLayout,
                compute: {
                    module: shaderModule,
                    entryPoint: 'main',
                },
            });

            // Update params bind group
            this.updateDctlParamsBindGroup();

            // Reset Zone System flag (not used with DCTL pipeline)
            this.hasZoneSystem = false;
            this.zoneBindGroup = null;

            const texDetails = shaderInfo.textures.map(t => `${t.samplerName}(ch=${t.channel})`).join(', ');
            const rgcInfo = this.hasFullRgc ? `, RGC (${this.rgcTextures.length} textures)` : '';
            console.log(`[Compute] Built DCTL+OCIO pipeline: DCTL=${shaderInfo.hasDctl}, ${shaderInfo.textures.length} 2D LUTs [${texDetails}], ${shaderInfo.textures3D.length} 3D LUTs${rgcInfo}`);
            return true;
        } catch (e) {
            console.error('Failed to build DCTL+OCIO compute pipeline:', e);
            return false;
        }
    }

    /**
     * Update DCTL params bind group (Group 3)
     */
    private updateDctlParamsBindGroup(): void {
        if (!this.device || !this.dctlParamsBindGroupLayout || !this.paramsBuffer) return;

        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: this.paramsBuffer } },
        ];

        if (this.hasDctl && this.dctlParamBuffer) {
            const dctlBuffer = this.dctlParamBuffer.getBuffer();
            if (dctlBuffer) {
                entries.push({ binding: 1, resource: { buffer: dctlBuffer } });
                console.log(`[Compute] DCTL buffer added to bind group at binding 1`);
            } else {
                console.warn(`[Compute] DCTL buffer is null, not added to bind group`);
            }
        } else {
            console.log(`[Compute] No DCTL buffer (hasDctl=${this.hasDctl}, buffer=${!!this.dctlParamBuffer})`);
        }

        this.dctlParamsBindGroup = this.device.createBindGroup({
            label: 'Params + DCTL Bind Group',
            layout: this.dctlParamsBindGroupLayout,
            entries,
        });
    }

    /**
     * Update a single DCTL parameter (fast path - no shader recompilation)
     */
    updateDctlParam(name: string, value: number | boolean | DctlColorValue): void {
        if (this.dctlParamBuffer) {
            this.dctlParamBuffer.updateParam(name, value);
        }
    }

    /**
     * Update multiple DCTL parameters at once (fast path - no shader recompilation)
     */
    updateDctlParams(values: Record<string, number | boolean | DctlColorValue>): void {
        if (this.dctlParamBuffer) {
            this.dctlParamBuffer.updateParams(values);
        }
    }

    /**
     * Set DCTL enabled/disabled state
     */
    setDctlEnabled(enabled: boolean): void {
        if (this.dctlParamBuffer) {
            this.dctlParamBuffer.setEnabled(enabled);
        }
    }

    /**
     * Check if DCTL is supported in current pipeline
     */
    get hasDctlSupport(): boolean {
        return this.hasDctl && this.dctlParamBuffer !== null;
    }

    /**
     * Get current DCTL parameter mapping
     */
    getDctlParamMapping(): DctlParamMapping[] {
        return this.dctlParamMapping;
    }

    /**
     * Cleanup OCIO textures
     */
    private cleanupOcioTextures(): void {
        for (const tex of this.ocioTextures) {
            tex.destroy();
        }
        this.ocioTextures = [];
        this.ocioBindGroup = null;
        this.ocioBindGroupLayout = null;
        this.hasOcioTextures = false;
    }

    /**
     * Cleanup RGC textures
     */
    private cleanupRgcTextures(): void {
        for (const tex of this.rgcTextures) {
            tex.destroy();
        }
        this.rgcTextures = [];
        this.rgcBindGroup = null;
        this.rgcBindGroupLayout = null;
        this.hasFullRgc = false;
    }

    /**
     * Build display pipeline
     */
    private async buildDisplayPipeline(): Promise<void> {
        if (!this.device || !this.displayBindGroupLayout) return;

        const vertexModule = this.device.createShaderModule({
            label: 'Display Vertex',
            code: DISPLAY_VERTEX_SHADER,
        });

        const fragmentModule = this.device.createShaderModule({
            label: 'Display Fragment',
            code: DISPLAY_FRAGMENT_SHADER,
        });

        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.displayBindGroupLayout],
        });

        // Use stored display format (may be HDR rgba16float or SDR format)
        console.log(`[Compute] Building display pipeline with format: ${this.displayFormat}`);

        this.displayPipeline = this.device.createRenderPipeline({
            label: 'Display Pipeline',
            layout: pipelineLayout,
            vertex: {
                module: vertexModule,
                entryPoint: 'main',
                buffers: [{
                    arrayStride: 16,
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x2' },
                        { shaderLocation: 1, offset: 8, format: 'float32x2' },
                    ],
                }],
            },
            fragment: {
                module: fragmentModule,
                entryPoint: 'main',
                targets: [{ format: this.displayFormat }],
            },
            primitive: {
                topology: 'triangle-strip',
            },
        });
    }

    /**
     * Update display format and rebuild display pipeline
     * Call this when switching between SDR and HDR modes
     */
    async setDisplayFormat(format: GPUTextureFormat): Promise<void> {
        if (this.displayFormat === format) return;

        console.log(`[Compute] Updating display format: ${this.displayFormat} -> ${format}`);
        this.displayFormat = format;
        await this.buildDisplayPipeline();
    }

    /**
     * Set source texture for compute
     */
    setSourceTexture(texture: GPUTexture): void {
        if (!this.device || !this.sourceBindGroupLayout) return;

        this.sourceBindGroup = this.device.createBindGroup({
            label: 'Source Bind Group',
            layout: this.sourceBindGroupLayout,
            entries: [
                { binding: 0, resource: texture.createView() },
            ],
        });
    }

    /**
     * Ensure output texture matches dimensions
     */
    private ensureOutputTexture(width: number, height: number): void {
        if (!this.device) return;

        // Check if we need to recreate
        if (this.outputTexture &&
            this.currentWidth === width &&
            this.currentHeight === height) {
            return;
        }

        // Destroy old texture
        if (this.outputTexture) {
            this.outputTexture.destroy();
        }

        // Create new output texture
        this.outputTexture = this.device.createTexture({
            label: 'Compute Output',
            size: [width, height],
            format: 'rgba32float',
            usage: GPUTextureUsage.STORAGE_BINDING |
                   GPUTextureUsage.TEXTURE_BINDING |
                   GPUTextureUsage.COPY_SRC,
        });

        this.outputTextureView = this.outputTexture.createView();
        this.currentWidth = width;
        this.currentHeight = height;

        // Update output bind group
        if (this.outputBindGroupLayout) {
            this.outputBindGroup = this.device.createBindGroup({
                label: 'Output Bind Group',
                layout: this.outputBindGroupLayout,
                entries: [
                    { binding: 0, resource: this.outputTextureView },
                ],
            });
        }

        // Update display bind group
        if (this.displayBindGroupLayout && this.displaySampler) {
            this.displayBindGroup = this.device.createBindGroup({
                label: 'Display Bind Group',
                layout: this.displayBindGroupLayout,
                entries: [
                    { binding: 0, resource: this.outputTextureView },
                    { binding: 1, resource: this.displaySampler },
                ],
            });
        }

        // Update params buffer
        this.updateParams(width, height);
    }

    /**
     * Update params buffer
     */
    private updateParams(width: number, height: number): void {
        if (!this.device || !this.paramsBuffer) return;

        const data = new Uint32Array([width, height, 0, 0]);
        this.device.queue.writeBuffer(this.paramsBuffer, 0, data);

        // Update params bind group
        if (this.paramsBindGroupLayout) {
            this.paramsBindGroup = this.device.createBindGroup({
                label: 'Params Bind Group',
                layout: this.paramsBindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.paramsBuffer } },
                ],
            });
        }
    }

    /**
     * Dispatch compute shader
     * Automatically handles various layouts:
     * - 3-group (simple): Source, Output, Params
     * - 4-group (OCIO): Source, Output, OCIO, Params
     * - 4-group (DCTL+OCIO): Source, Output, OCIO, Params+DCTL
     * - 5-group (Zone): Source, Output, OCIO, Params, Zone
     */
    dispatchCompute(
        commandEncoder: GPUCommandEncoder,
        width: number,
        height: number
    ): void {
        if (!this.computePipeline || !this.sourceBindGroup) {
            console.warn('Compute pipeline not ready');
            return;
        }

        // Debug log for pipeline state
        console.log(`[Compute] dispatchCompute: hasDctl=${this.hasDctl}, hasOcioTextures=${this.hasOcioTextures}, hasZoneSystem=${this.hasZoneSystem}, hasFullRgc=${this.hasFullRgc}`);

        // Ensure output texture
        this.ensureOutputTexture(width, height);

        if (!this.outputBindGroup) {
            console.warn('Output bind group not ready');
            return;
        }

        // Start profiling if profiler is attached
        let measurementId = -1;
        if (this.profiler) {
            measurementId = this.profiler.beginMeasurement('Compute Pass');
            this.profiler.writeTimestamps(commandEncoder, measurementId, true);
        }

        const computePass = commandEncoder.beginComputePass({
            label: 'Color Transform Compute Pass',
        });

        computePass.setPipeline(this.computePipeline);
        computePass.setBindGroup(0, this.sourceBindGroup);
        computePass.setBindGroup(1, this.outputBindGroup);

        // Determine layout based on features enabled
        // Note: When hasFullRgc=true, we need dctlParamsBindGroup even if hasDctl=false
        // because the pipeline was built with the DCTL+OCIO layout
        if ((this.hasDctl || this.hasFullRgc) && this.dctlParamsBindGroup && this.ocioBindGroup) {
            // 4-group layout with DCTL + OCIO (RGC merged into OCIO bind group)
            computePass.setBindGroup(2, this.ocioBindGroup);  // OCIO + RGC merged
            computePass.setBindGroup(3, this.dctlParamsBindGroup);
        } else if (this.hasZoneSystem && this.zoneBindGroup) {
            // 5-group layout with Zone System
            computePass.setBindGroup(2, this.ocioBindGroup!);  // May be empty
            computePass.setBindGroup(3, this.paramsBindGroup!);
            computePass.setBindGroup(4, this.zoneBindGroup);
        } else if (this.hasOcioTextures && this.ocioBindGroup) {
            // 4-group layout with OCIO only
            computePass.setBindGroup(2, this.ocioBindGroup);
            computePass.setBindGroup(3, this.paramsBindGroup!);
        } else if (this.paramsBindGroup) {
            // 3-group layout for simple shaders
            computePass.setBindGroup(2, this.paramsBindGroup);
        } else {
            console.warn('No params bind group available');
            computePass.end();
            return;
        }

        // Calculate workgroup counts
        const workgroupsX = Math.ceil(width / WORKGROUP_SIZE_X);
        const workgroupsY = Math.ceil(height / WORKGROUP_SIZE_Y);

        computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
        computePass.end();

        // End profiling timestamp
        if (this.profiler && measurementId >= 0) {
            this.profiler.writeTimestamps(commandEncoder, measurementId, false);
        }
    }

    /**
     * Check if OCIO textures are loaded
     */
    get hasOcio(): boolean {
        return this.hasOcioTextures;
    }

    /**
     * Get Zone Buffer Manager for external control
     */
    getZoneBufferManager(): ZoneBufferManager | null {
        return this.zoneBufferManager;
    }

    /**
     * Enable Zone System in compute pipeline
     */
    setZoneSystemEnabled(enabled: boolean): void {
        if (this.zoneBufferManager) {
            this.zoneBufferManager.updateParams({ enabled });
            this.hasZoneSystem = enabled;
            console.log(`[Compute] Zone System ${enabled ? 'enabled' : 'disabled'}`);
        }
    }

    /**
     * Check if Zone System is enabled
     */
    get isZoneSystemEnabled(): boolean {
        return this.hasZoneSystem && this.zoneBufferManager?.isEnabled() === true;
    }

    /**
     * Render compute output to canvas
     */
    renderToCanvas(
        commandEncoder: GPUCommandEncoder,
        targetView: GPUTextureView
    ): void {
        if (!this.displayPipeline || !this.displayBindGroup || !this.vertexBuffer) {
            console.warn('Display pipeline not ready');
            return;
        }

        // Start profiling if profiler is attached
        let measurementId = -1;
        if (this.profiler) {
            measurementId = this.profiler.beginMeasurement('Render Pass');
            this.profiler.writeTimestamps(commandEncoder, measurementId, true);
        }

        const renderPass = commandEncoder.beginRenderPass({
            label: 'Display Render Pass',
            colorAttachments: [{
                view: targetView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
            }],
        });

        renderPass.setPipeline(this.displayPipeline);
        renderPass.setBindGroup(0, this.displayBindGroup);
        renderPass.setVertexBuffer(0, this.vertexBuffer);
        renderPass.draw(4);
        renderPass.end();

        // End profiling timestamp
        if (this.profiler && measurementId >= 0) {
            this.profiler.writeTimestamps(commandEncoder, measurementId, false);
        }
    }

    /**
     * Resolve timing queries and read results
     * Call this after queue.submit() and before next frame
     */
    async resolveAndReadTiming(commandEncoder: GPUCommandEncoder): Promise<GPUTimingResult[]> {
        if (!this.profiler) {
            return [];
        }

        this.profiler.resolve(commandEncoder);

        // Submit and wait for results
        if (this.device) {
            this.device.queue.submit([commandEncoder.finish()]);
        }

        this.lastTimingResults = await this.profiler.readResults();
        return this.lastTimingResults;
    }

    /**
     * Get output texture
     */
    getOutputTexture(): GPUTexture | null {
        return this.outputTexture;
    }

    /**
     * Get output texture view
     */
    getOutputTextureView(): GPUTextureView | null {
        return this.outputTextureView;
    }

    /**
     * Debug: Read first few pixels from output texture
     * Useful for verifying compute shader output
     */
    async debugReadOutputPixels(width: number = 8, height: number = 8): Promise<Float32Array | null> {
        if (!this.device || !this.outputTexture) {
            console.warn('[Compute] Cannot read pixels: device or output texture not ready');
            return null;
        }

        const readWidth = Math.min(width, this.currentWidth);
        const readHeight = Math.min(height, this.currentHeight);
        const bytesPerRow = Math.ceil((readWidth * 16) / 256) * 256; // 16 bytes per pixel (rgba32float), aligned to 256

        // Create read buffer
        const bufferSize = bytesPerRow * readHeight;
        const readBuffer = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        // Copy texture to buffer
        const commandEncoder = this.device.createCommandEncoder();
        commandEncoder.copyTextureToBuffer(
            { texture: this.outputTexture },
            { buffer: readBuffer, bytesPerRow },
            { width: readWidth, height: readHeight }
        );
        this.device.queue.submit([commandEncoder.finish()]);

        // Read buffer
        await readBuffer.mapAsync(GPUMapMode.READ);
        const arrayBuffer = readBuffer.getMappedRange();
        const result = new Float32Array(arrayBuffer.slice(0));
        readBuffer.unmap();
        readBuffer.destroy();

        console.log(`[Compute Debug] Read ${readWidth}x${readHeight} pixels from output texture`);
        console.log(`[Compute Debug] First 4 pixels (RGBA):`, Array.from(result.slice(0, 16)));

        return result;
    }

    // ========================================
    // GPU Histogram and Statistics
    // ========================================

    private histogramPipeline: GPUComputePipeline | null = null;
    private histogramBuffer: GPUBuffer | null = null;
    private histogramReadBuffer: GPUBuffer | null = null;
    private histogramBindGroup: GPUBindGroup | null = null;

    private statisticsPipeline: GPUComputePipeline | null = null;
    private statisticsBuffer: GPUBuffer | null = null;
    private statisticsReadBuffer: GPUBuffer | null = null;
    private statisticsBindGroup: GPUBindGroup | null = null;
    private statisticsAtomicBuffer: GPUBuffer | null = null;

    /**
     * Build GPU histogram pipeline
     * Uses atomic operations to count pixel values in parallel
     */
    async buildHistogramPipeline(): Promise<boolean> {
        if (!this.device) return false;

        const HISTOGRAM_SHADER = /* wgsl */`
// Source texture (input)
@group(0) @binding(0) var source_texture: texture_2d<f32>;

// Histogram output buffer (256 bins x 4 channels: R, G, B, Luma)
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>, 1024>;

// Parameters
struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    // Bounds check
    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    // Load source pixel
    let color = textureLoad(source_texture, coords, 0);

    // Clamp and map to bin (0-255)
    let r = clamp(color.r, 0.0, 1.0);
    let g = clamp(color.g, 0.0, 1.0);
    let b = clamp(color.b, 0.0, 1.0);

    let rBin = u32(r * 255.0);
    let gBin = u32(g * 255.0);
    let bBin = u32(b * 255.0);

    // Calculate luminance (Rec.709)
    let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let lumaBin = u32(clamp(luma, 0.0, 1.0) * 255.0);

    // Atomically increment histogram bins
    // Layout: [R: 0-255, G: 256-511, B: 512-767, Luma: 768-1023]
    atomicAdd(&histogram[rBin], 1u);
    atomicAdd(&histogram[256u + gBin], 1u);
    atomicAdd(&histogram[512u + bBin], 1u);
    atomicAdd(&histogram[768u + lumaBin], 1u);
}
`;

        try {
            const shaderModule = this.device.createShaderModule({
                label: 'Histogram Compute',
                code: HISTOGRAM_SHADER,
            });

            // Create histogram buffer (256 bins x 4 channels x 4 bytes)
            this.histogramBuffer = this.device.createBuffer({
                label: 'Histogram Buffer',
                size: 1024 * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            });

            // Create read buffer
            this.histogramReadBuffer = this.device.createBuffer({
                label: 'Histogram Read Buffer',
                size: 1024 * 4,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });

            // Create bind group layout
            const bindGroupLayout = this.device.createBindGroupLayout({
                label: 'Histogram Bind Group Layout',
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.COMPUTE,
                        texture: { sampleType: 'unfilterable-float' },
                    },
                    {
                        binding: 1,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'storage' },
                    },
                    {
                        binding: 2,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'uniform' },
                    },
                ],
            });

            const pipelineLayout = this.device.createPipelineLayout({
                label: 'Histogram Pipeline Layout',
                bindGroupLayouts: [bindGroupLayout],
            });

            this.histogramPipeline = this.device.createComputePipeline({
                label: 'Histogram Pipeline',
                layout: pipelineLayout,
                compute: {
                    module: shaderModule,
                    entryPoint: 'main',
                },
            });

            console.log('[Compute] Histogram pipeline built');
            return true;
        } catch (e) {
            console.error('Failed to build histogram pipeline:', e);
            return false;
        }
    }

    /**
     * Calculate histogram using GPU
     * @param sourceTexture Input texture
     * @param width Image width
     * @param height Image height
     * @returns Histogram data for R, G, B, and Luma channels
     */
    async calculateHistogramGPU(
        sourceTexture: GPUTexture,
        width: number,
        height: number
    ): Promise<{ red: Uint32Array; green: Uint32Array; blue: Uint32Array; luminance: Uint32Array } | null> {
        if (!this.device || !this.histogramPipeline || !this.histogramBuffer ||
            !this.histogramReadBuffer || !this.paramsBuffer) {
            console.error('Histogram pipeline not ready');
            return null;
        }

        try {
            // Clear histogram buffer
            const clearBuffer = this.device.createBuffer({
                size: 1024 * 4,
                usage: GPUBufferUsage.COPY_SRC,
                mappedAtCreation: true,
            });
            new Uint32Array(clearBuffer.getMappedRange()).fill(0);
            clearBuffer.unmap();

            const commandEncoder = this.device.createCommandEncoder();
            commandEncoder.copyBufferToBuffer(clearBuffer, 0, this.histogramBuffer, 0, 1024 * 4);

            // Update params
            const paramsData = new Uint32Array([width, height, 0, 0]);
            this.device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

            // Create bind group
            this.histogramBindGroup = this.device.createBindGroup({
                label: 'Histogram Bind Group',
                layout: this.histogramPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: sourceTexture.createView() },
                    { binding: 1, resource: { buffer: this.histogramBuffer } },
                    { binding: 2, resource: { buffer: this.paramsBuffer } },
                ],
            });

            // Dispatch compute
            const computePass = commandEncoder.beginComputePass({
                label: 'Histogram Compute Pass',
            });
            computePass.setPipeline(this.histogramPipeline);
            computePass.setBindGroup(0, this.histogramBindGroup);
            computePass.dispatchWorkgroups(
                Math.ceil(width / 16),
                Math.ceil(height / 16)
            );
            computePass.end();

            // Copy results to read buffer
            commandEncoder.copyBufferToBuffer(
                this.histogramBuffer, 0,
                this.histogramReadBuffer, 0,
                1024 * 4
            );

            this.device.queue.submit([commandEncoder.finish()]);
            clearBuffer.destroy();

            // Read back results
            await this.histogramReadBuffer.mapAsync(GPUMapMode.READ);
            const data = new Uint32Array(this.histogramReadBuffer.getMappedRange().slice(0));
            this.histogramReadBuffer.unmap();

            // Split into channels
            const red = data.slice(0, 256);
            const green = data.slice(256, 512);
            const blue = data.slice(512, 768);
            const luminance = data.slice(768, 1024);

            return { red, green, blue, luminance };
        } catch (e) {
            console.error('Failed to calculate histogram:', e);
            return null;
        }
    }

    /**
     * Build GPU statistics pipeline
     * Calculates min, max, average for each channel using parallel reduction
     */
    async buildStatisticsPipeline(): Promise<boolean> {
        if (!this.device) return false;

        // Statistics shader using atomics for min/max and reduction for sum
        const STATISTICS_SHADER = /* wgsl */`
// Source texture (input)
@group(0) @binding(0) var source_texture: texture_2d<f32>;

// Statistics output buffer
// Layout: [minR, minG, minB, minLuma, maxR, maxG, maxB, maxLuma, sumR, sumG, sumB, sumLuma, count, _pad, _pad, _pad]
// Using fixed-point for atomics (scale by 1e6)
@group(0) @binding(1) var<storage, read_write> stats: array<atomic<u32>, 16>;

// Parameters
struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}
@group(0) @binding(2) var<uniform> params: Params;

// Helper to convert float to fixed-point u32 (range 0-1 -> 0-1000000)
fn float_to_fixed(v: f32) -> u32 {
    return u32(clamp(v, 0.0, 1.0) * 1000000.0);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    // Bounds check
    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    // Load source pixel
    let color = textureLoad(source_texture, coords, 0);

    let r = clamp(color.r, 0.0, 1.0);
    let g = clamp(color.g, 0.0, 1.0);
    let b = clamp(color.b, 0.0, 1.0);
    let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // Convert to fixed point
    let rFixed = float_to_fixed(r);
    let gFixed = float_to_fixed(g);
    let bFixed = float_to_fixed(b);
    let lumaFixed = float_to_fixed(luma);

    // Atomic min (indices 0-3)
    atomicMin(&stats[0], rFixed);
    atomicMin(&stats[1], gFixed);
    atomicMin(&stats[2], bFixed);
    atomicMin(&stats[3], lumaFixed);

    // Atomic max (indices 4-7)
    atomicMax(&stats[4], rFixed);
    atomicMax(&stats[5], gFixed);
    atomicMax(&stats[6], bFixed);
    atomicMax(&stats[7], lumaFixed);

    // Atomic add for sum (indices 8-11) - using smaller scale to avoid overflow
    // Scale by 1000 instead of 1e6 to allow larger images
    atomicAdd(&stats[8], u32(r * 1000.0));
    atomicAdd(&stats[9], u32(g * 1000.0));
    atomicAdd(&stats[10], u32(b * 1000.0));
    atomicAdd(&stats[11], u32(luma * 1000.0));

    // Count pixels
    atomicAdd(&stats[12], 1u);
}
`;

        try {
            const shaderModule = this.device.createShaderModule({
                label: 'Statistics Compute',
                code: STATISTICS_SHADER,
            });

            // Create statistics buffer (16 x u32)
            this.statisticsBuffer = this.device.createBuffer({
                label: 'Statistics Buffer',
                size: 16 * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            });

            // Create read buffer
            this.statisticsReadBuffer = this.device.createBuffer({
                label: 'Statistics Read Buffer',
                size: 16 * 4,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });

            // Create bind group layout
            const bindGroupLayout = this.device.createBindGroupLayout({
                label: 'Statistics Bind Group Layout',
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.COMPUTE,
                        texture: { sampleType: 'unfilterable-float' },
                    },
                    {
                        binding: 1,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'storage' },
                    },
                    {
                        binding: 2,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'uniform' },
                    },
                ],
            });

            const pipelineLayout = this.device.createPipelineLayout({
                label: 'Statistics Pipeline Layout',
                bindGroupLayouts: [bindGroupLayout],
            });

            this.statisticsPipeline = this.device.createComputePipeline({
                label: 'Statistics Pipeline',
                layout: pipelineLayout,
                compute: {
                    module: shaderModule,
                    entryPoint: 'main',
                },
            });

            console.log('[Compute] Statistics pipeline built');
            return true;
        } catch (e) {
            console.error('Failed to build statistics pipeline:', e);
            return false;
        }
    }

    /**
     * Calculate statistics using GPU
     * @param sourceTexture Input texture
     * @param width Image width
     * @param height Image height
     * @returns Min, max, average for R, G, B, and Luma channels
     */
    async calculateStatisticsGPU(
        sourceTexture: GPUTexture,
        width: number,
        height: number
    ): Promise<{
        min: { r: number; g: number; b: number; luma: number };
        max: { r: number; g: number; b: number; luma: number };
        avg: { r: number; g: number; b: number; luma: number };
    } | null> {
        if (!this.device || !this.statisticsPipeline || !this.statisticsBuffer ||
            !this.statisticsReadBuffer || !this.paramsBuffer) {
            console.error('Statistics pipeline not ready');
            return null;
        }

        try {
            // Initialize stats buffer
            // Min values start at max (1000000), max values start at 0
            const initData = new Uint32Array([
                1000000, 1000000, 1000000, 1000000,  // min R, G, B, Luma (start at max)
                0, 0, 0, 0,                          // max R, G, B, Luma (start at 0)
                0, 0, 0, 0,                          // sum R, G, B, Luma
                0, 0, 0, 0,                          // count, padding
            ]);

            this.device.queue.writeBuffer(this.statisticsBuffer, 0, initData);

            // Update params
            const paramsData = new Uint32Array([width, height, 0, 0]);
            this.device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

            // Create bind group
            this.statisticsBindGroup = this.device.createBindGroup({
                label: 'Statistics Bind Group',
                layout: this.statisticsPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: sourceTexture.createView() },
                    { binding: 1, resource: { buffer: this.statisticsBuffer } },
                    { binding: 2, resource: { buffer: this.paramsBuffer } },
                ],
            });

            const commandEncoder = this.device.createCommandEncoder();

            // Dispatch compute
            const computePass = commandEncoder.beginComputePass({
                label: 'Statistics Compute Pass',
            });
            computePass.setPipeline(this.statisticsPipeline);
            computePass.setBindGroup(0, this.statisticsBindGroup);
            computePass.dispatchWorkgroups(
                Math.ceil(width / 16),
                Math.ceil(height / 16)
            );
            computePass.end();

            // Copy results to read buffer
            commandEncoder.copyBufferToBuffer(
                this.statisticsBuffer, 0,
                this.statisticsReadBuffer, 0,
                16 * 4
            );

            this.device.queue.submit([commandEncoder.finish()]);

            // Read back results
            await this.statisticsReadBuffer.mapAsync(GPUMapMode.READ);
            const data = new Uint32Array(this.statisticsReadBuffer.getMappedRange().slice(0));
            this.statisticsReadBuffer.unmap();

            // Convert from fixed-point back to float
            const toFloat = (v: number) => v / 1000000;
            const count = data[12];

            if (count === 0) {
                return null;
            }

            // Sum was scaled by 1000, so divide by count * 1000
            const avgScale = count * 1000;

            return {
                min: {
                    r: toFloat(data[0]),
                    g: toFloat(data[1]),
                    b: toFloat(data[2]),
                    luma: toFloat(data[3]),
                },
                max: {
                    r: toFloat(data[4]),
                    g: toFloat(data[5]),
                    b: toFloat(data[6]),
                    luma: toFloat(data[7]),
                },
                avg: {
                    r: data[8] / avgScale,
                    g: data[9] / avgScale,
                    b: data[10] / avgScale,
                    luma: data[11] / avgScale,
                },
            };
        } catch (e) {
            console.error('Failed to calculate statistics:', e);
            return null;
        }
    }

    /**
     * Cleanup resources
     */
    dispose(): void {
        // Cleanup profiler
        if (this.profiler) {
            this.profiler.dispose();
            this.profiler = null;
        }

        // Cleanup OCIO textures first
        this.cleanupOcioTextures();

        // Cleanup RGC textures
        this.cleanupRgcTextures();

        // Cleanup Zone System
        if (this.zoneBufferManager) {
            this.zoneBufferManager.dispose();
            this.zoneBufferManager = null;
        }

        // Cleanup DCTL
        if (this.dctlParamBuffer) {
            this.dctlParamBuffer.dispose();
            this.dctlParamBuffer = null;
        }
        this.dctlParamsBindGroup = null;
        this.dctlParamsBindGroupLayout = null;
        this.hasDctl = false;
        this.dctlParamMapping = [];

        // Cleanup Histogram
        if (this.histogramBuffer) {
            this.histogramBuffer.destroy();
            this.histogramBuffer = null;
        }
        if (this.histogramReadBuffer) {
            this.histogramReadBuffer.destroy();
            this.histogramReadBuffer = null;
        }
        this.histogramPipeline = null;
        this.histogramBindGroup = null;

        // Cleanup Statistics
        if (this.statisticsBuffer) {
            this.statisticsBuffer.destroy();
            this.statisticsBuffer = null;
        }
        if (this.statisticsReadBuffer) {
            this.statisticsReadBuffer.destroy();
            this.statisticsReadBuffer = null;
        }
        if (this.statisticsAtomicBuffer) {
            this.statisticsAtomicBuffer.destroy();
            this.statisticsAtomicBuffer = null;
        }
        this.statisticsPipeline = null;
        this.statisticsBindGroup = null;

        if (this.outputTexture) {
            this.outputTexture.destroy();
            this.outputTexture = null;
        }
        if (this.paramsBuffer) {
            this.paramsBuffer.destroy();
            this.paramsBuffer = null;
        }
        if (this.vertexBuffer) {
            this.vertexBuffer.destroy();
            this.vertexBuffer = null;
        }

        this.computePipeline = null;
        this.displayPipeline = null;
        this.sourceBindGroup = null;
        this.outputBindGroup = null;
        this.ocioBindGroup = null;
        this.zoneBindGroup = null;
        this.paramsBindGroup = null;
        this.displayBindGroup = null;
        this.device = null;
    }
}
