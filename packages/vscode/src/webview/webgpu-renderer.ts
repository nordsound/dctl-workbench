/**
 * WebGPU Renderer for EXR Viewer
 *
 * Provides WebGPU-based rendering with OCIO color transform support.
 * Supports both Fragment Shader and Compute Shader pipelines.
 * Falls back to WebGL2 if WebGPU is not available.
 */

import { ComputePipelineManager, type OcioComputeShaderInfo } from './compute-pipeline';
import {
    create2DTexture,
    create3DTexture,
    createFilteringSampler,
    createNearestSampler,
    selectSamplerForFormat,
} from './texture-utils';
import {
    createGPUErrorHandler,
    createGPULimitsChecker,
    compileShader,
    type GPUErrorHandler,
    type GPULimitsChecker,
} from './shared';
import { DctlParamBuffer, buildParamMapping, type DctlParamMapping } from './dctl-param-buffer';
import type { DctlColorValue } from './shared/dctl-controls';
import type { DctlComputeShaderInfo } from '../shader';

interface GpuTexture {
    name: string;
    samplerName: string;
    width: number;
    height: number;
    channel: number;
    dimensions: number;
    data: number[];
}

interface GpuTexture3D {
    name: string;
    samplerName: string;
    edgeLen: number;
    data: number[];
}

interface TextureBinding {
    binding: number;
    type: 'texture2D' | 'texture3D' | 'sampler';
    name: string;
    originalName?: string;
}

interface WgslShaderInfo {
    wgslCode: string;
    computeWgslCode?: string;
    textures: GpuTexture[];
    textures3D: GpuTexture3D[];
    bindings?: TextureBinding[];
    // RGC textures (from ACES 2.0 RGC shader)
    rgcTextures?: GpuTexture[];
    rgcTextures3D?: GpuTexture3D[];
    // Uniform buffer support for fast DCTL parameter updates
    paramMapping?: DctlParamMapping[];
    useUniformBuffer?: boolean;
    uniformBufferBinding?: number;
    // DCTL + OCIO compute shader info (for compute pipeline with DCTL support)
    dctlComputeShaderInfo?: DctlComputeShaderInfo;
}

interface ImageData {
    width: number;
    height: number;
    channels: number;
    pixels: Float32Array;
}

// Default vertex shader (WGSL)
const VERTEX_SHADER = `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

@vertex
fn main(@location(0) position: vec2<f32>, @location(1) texCoord: vec2<f32>) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(position, 0.0, 1.0);
    output.texCoord = texCoord;
    return output;
}
`;

// Fallback fragment shader (no color transform)
const FALLBACK_FRAGMENT_SHADER = `
@group(0) @binding(0) var u_image_tex: texture_2d<f32>;
@group(0) @binding(1) var u_image_samp: sampler;

@fragment
fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let color = textureSample(u_image_tex, u_image_samp, texCoord);
    return clamp(color, vec4<f32>(0.0), vec4<f32>(1.0));
}
`;

export class WebGPURenderer {
    private device: GPUDevice | null = null;
    private context: GPUCanvasContext | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private exportPipeline: GPURenderPipeline | null = null;
    private vertexBuffer: GPUBuffer | null = null;
    private imageTexture: GPUTexture | null = null;
    private sampler: GPUSampler | null = null;
    private bindGroup: GPUBindGroup | null = null;
    private exportBindGroup: GPUBindGroup | null = null;
    private rgcTextures: GPUTexture[] = [];
    private rgc3DTextures: GPUTexture[] = [];
    private ocioTextures: GPUTexture[] = [];
    private ocio3DTextures: GPUTexture[] = [];
    private canvas: HTMLCanvasElement | null = null;
    private format: GPUTextureFormat = 'rgba8unorm';
    private currentFragmentShader: string = FALLBACK_FRAGMENT_SHADER;
    private currentShaderInfo: WgslShaderInfo | null = null;

    // Compute pipeline support
    private computePipelineManager: ComputePipelineManager | null = null;
    // Note: DCTL is only supported in Fragment Pipeline (not Compute Pipeline yet)
    // Default to Fragment Pipeline until DCTL is integrated into Compute Pipeline
    private useComputePipeline: boolean = false;

    // HDR mode support
    private hdrMode: boolean = false;
    private sdkFormat: GPUTextureFormat = 'rgba8unorm'; // Format when HDR is off

    // Error handling and limits
    private errorHandler: GPUErrorHandler | null = null;
    private limitsChecker: GPULimitsChecker | null = null;

    // DCTL Uniform Buffer support (fast parameter updates)
    private dctlParamBuffer: DctlParamBuffer | null = null;
    private useUniformBuffer: boolean = false;
    private uniformBufferBinding: number = -1;

    /**
     * Check if WebGPU is supported
     */
    static async isSupported(): Promise<boolean> {
        if (!navigator.gpu) {
            return false;
        }
        try {
            const adapter = await navigator.gpu.requestAdapter();
            return adapter !== null;
        } catch {
            return false;
        }
    }

    /**
     * Initialize WebGPU with the given canvas
     */
    async init(canvas: HTMLCanvasElement): Promise<boolean> {
        if (!navigator.gpu) {
            console.warn('WebGPU is not supported');
            return false;
        }

        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                console.warn('No WebGPU adapter found');
                return false;
            }

            // Request float32-filterable feature if available
            const features: GPUFeatureName[] = [];
            if (adapter.features.has('float32-filterable')) {
                features.push('float32-filterable');
            }

            this.device = await adapter.requestDevice({
                requiredFeatures: features,
            });

            // Initialize error handler
            this.errorHandler = createGPUErrorHandler({
                log: (msg) => console.log(`[WebGPU] ${msg}`),
                onDeviceLost: (reason, message) => {
                    console.error(`[WebGPU] Device lost - ${reason}: ${message}`);
                    this.device = null;
                },
                onOutOfMemory: (message) => {
                    console.error(`[WebGPU] Out of memory: ${message}`);
                },
            });
            this.errorHandler.attachToDevice(this.device);

            // Initialize limits checker
            this.limitsChecker = createGPULimitsChecker({
                device: this.device,
                adapter,
                log: (msg) => console.log(msg),
            });
            this.limitsChecker.logAdapterInfo();

            const context = canvas.getContext('webgpu');
            if (!context) {
                console.error('Failed to get WebGPU context');
                return false;
            }

            // Use preferred format but avoid sRGB variants to prevent double gamma
            // OCIO shader already outputs sRGB-encoded values, so we don't want
            // the canvas to apply additional sRGB conversion
            const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
            // Force non-sRGB format to avoid double gamma application
            // The shader outputs display-referred sRGB values directly
            this.sdkFormat = preferredFormat.includes('srgb')
                ? (preferredFormat.replace('-srgb', '') as GPUTextureFormat)
                : preferredFormat;
            this.format = this.sdkFormat;

            console.log(`[WebGPU] Preferred format: ${preferredFormat}, Using format: ${this.format}`);

            context.configure({
                device: this.device,
                format: this.format,
                alphaMode: 'opaque',
            });

            this.context = context;
            this.canvas = canvas;

            // Create sampler using shared utility
            this.sampler = createFilteringSampler(this.device, 'Image Sampler');

            // Create vertex buffer (fullscreen quad)
            const vertices = new Float32Array([
                // position (xy), texCoord (uv)
                -1, -1, 0, 1,
                 1, -1, 1, 1,
                -1,  1, 0, 0,
                 1,  1, 1, 0,
            ]);

            this.vertexBuffer = this.device.createBuffer({
                size: vertices.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);

            // Initialize compute pipeline manager
            this.computePipelineManager = new ComputePipelineManager();
            await this.computePipelineManager.init(this.device);
            console.log('[WebGPU] Compute pipeline manager initialized');

            return true;
        } catch (e) {
            console.error('WebGPU initialization failed:', e);
            return false;
        }
    }

    /**
     * Check if initialized
     */
    get isInitialized(): boolean {
        return this.device !== null && this.context !== null;
    }

    /**
     * Check if compute pipeline is enabled
     */
    get isComputePipelineEnabled(): boolean {
        return this.useComputePipeline;
    }

    /**
     * Enable or disable compute pipeline
     * When enabled, rendering uses compute shader instead of fragment shader
     */
    setUseComputePipeline(enabled: boolean): void {
        this.useComputePipeline = enabled;
        console.log(`[WebGPU] Compute pipeline ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Check if HDR mode is enabled
     */
    get isHDREnabled(): boolean {
        return this.hdrMode;
    }

    /**
     * Enable or disable HDR mode
     * When enabled, uses rgba16float format and extended tone mapping
     * Requires HDR-capable display for visible effect
     */
    setHDRMode(enabled: boolean): void {
        if (this.hdrMode === enabled) return;

        this.hdrMode = enabled;

        if (!this.context || !this.device) {
            console.warn('[WebGPU] Cannot set HDR mode: context not initialized');
            return;
        }

        // Update format and reconfigure context
        if (enabled) {
            this.format = 'rgba16float';
            this.context.configure({
                device: this.device,
                format: this.format,
                alphaMode: 'opaque',
                toneMapping: { mode: 'extended' },
            });
        } else {
            this.format = this.sdkFormat;
            this.context.configure({
                device: this.device,
                format: this.format,
                alphaMode: 'opaque',
                toneMapping: { mode: 'standard' },
            });
        }

        console.log(`[WebGPU] HDR mode ${enabled ? 'enabled' : 'disabled'}, format: ${this.format}`);
        console.log(`[WebGPU] currentShaderInfo: ${this.currentShaderInfo ? 'exists' : 'null'}`);

        // Update compute pipeline display format and rebuild pipelines
        const rebuildAll = async () => {
            // Update compute pipeline display format
            if (this.computePipelineManager) {
                console.log('[WebGPU] Updating compute pipeline display format...');
                await this.computePipelineManager.setDisplayFormat(this.format);
            }

            // Rebuild pipeline with new format
            if (this.currentShaderInfo) {
                console.log('[WebGPU] Rebuilding shader pipeline...');
                await this.buildShader(this.currentShaderInfo);
                console.log('[WebGPU] Shader pipeline rebuilt, rendering...');
            } else {
                // Rebuild fallback pipeline if no shader is loaded
                console.log('[WebGPU] Rebuilding fallback pipeline...');
                await this.buildFallbackPipeline();
                console.log('[WebGPU] Fallback pipeline rebuilt, rendering...');
            }
            this.render();
        };

        rebuildAll().catch((e) => {
            console.error('[WebGPU] Failed to rebuild pipelines:', e);
        });
    }

    /**
     * Build compute pipeline with custom WGSL code
     * @param wgslCode Custom compute shader code
     * @returns true if successful
     */
    async buildComputeShader(wgslCode: string): Promise<boolean> {
        if (!this.computePipelineManager) {
            console.error('Compute pipeline manager not initialized');
            return false;
        }
        return this.computePipelineManager.buildComputePipeline(wgslCode);
    }

    /**
     * Build OCIO compute pipeline with LUT textures
     * @param shaderInfo OCIO compute shader info with WGSL code and textures
     * @returns true if successful
     */
    async buildOcioComputeShader(shaderInfo: OcioComputeShaderInfo): Promise<boolean> {
        if (!this.computePipelineManager) {
            console.error('Compute pipeline manager not initialized');
            return false;
        }
        return this.computePipelineManager.buildOcioComputePipeline(shaderInfo);
    }

    /**
     * Build OCIO compute shader from shader info (convenience method)
     * Converts WgslShaderInfo to OcioComputeShaderInfo format
     */
    async buildOcioComputeFromShaderInfo(
        computeWgsl: string,
        shaderInfo: WgslShaderInfo
    ): Promise<boolean> {
        if (!this.computePipelineManager) {
            console.error('Compute pipeline manager not initialized');
            return false;
        }

        // Convert to OcioComputeShaderInfo format
        const textures2D: OcioComputeShaderInfo['textures2D'] = [];
        const textures3D: OcioComputeShaderInfo['textures3D'] = [];

        // Add OCIO 2D textures
        for (const tex of shaderInfo.textures) {
            textures2D.push({
                name: tex.samplerName,
                width: tex.width,
                height: tex.height,
                channel: tex.channel,
                data: new Float32Array(tex.data),
            });
        }

        // Add RGC 2D textures if present
        if (shaderInfo.rgcTextures) {
            for (const tex of shaderInfo.rgcTextures) {
                textures2D.push({
                    name: `rgc_${tex.samplerName}`,
                    width: tex.width,
                    height: tex.height,
                    channel: tex.channel,
                    data: new Float32Array(tex.data),
                });
            }
        }

        // Add OCIO 3D textures
        for (const tex of shaderInfo.textures3D) {
            textures3D.push({
                name: tex.samplerName,
                edgeLen: tex.edgeLen,
                data: new Float32Array(tex.data),
            });
        }

        // Add RGC 3D textures if present
        if (shaderInfo.rgcTextures3D) {
            for (const tex of shaderInfo.rgcTextures3D) {
                textures3D.push({
                    name: `rgc_${tex.samplerName}`,
                    edgeLen: tex.edgeLen,
                    data: new Float32Array(tex.data),
                });
            }
        }

        const ocioShaderInfo: OcioComputeShaderInfo = {
            wgslCode: computeWgsl,
            textures2D,
            textures3D,
        };

        console.log(`[WebGPU] Building OCIO compute shader with ${textures2D.length} 2D and ${textures3D.length} 3D textures`);
        return this.computePipelineManager.buildOcioComputePipeline(ocioShaderInfo);
    }

    /**
     * Build DCTL + OCIO compute pipeline with uniform buffer support
     * @param shaderInfo DCTL compute shader info from dctl-compute-wgsl-builder
     * @returns true if successful
     */
    async buildDctlOcioComputeShader(shaderInfo: DctlComputeShaderInfo): Promise<boolean> {
        if (!this.computePipelineManager) {
            console.error('Compute pipeline manager not initialized');
            return false;
        }

        const result = await this.computePipelineManager.buildDctlOcioComputePipeline(shaderInfo);

        if (result && shaderInfo.hasDctl) {
            // Enable compute pipeline with DCTL support
            this.useComputePipeline = true;
            console.log('[WebGPU] DCTL+OCIO compute pipeline enabled');
        }

        return result;
    }

    /**
     * Build Zone System compute pipeline
     * @returns true if successful
     */
    async buildZoneSystemPipeline(): Promise<boolean> {
        if (!this.computePipelineManager) {
            console.error('Compute pipeline manager not initialized');
            return false;
        }
        return this.computePipelineManager.buildZoneSystemPipeline();
    }

    /**
     * Enable or disable Zone System in compute pipeline
     */
    setZoneSystemEnabled(enabled: boolean): void {
        if (!this.computePipelineManager) {
            console.error('Compute pipeline manager not initialized');
            return;
        }
        this.computePipelineManager.setZoneSystemEnabled(enabled);
    }

    /**
     * Check if Zone System is enabled
     */
    get isZoneSystemEnabled(): boolean {
        return this.computePipelineManager?.isZoneSystemEnabled ?? false;
    }

    /**
     * Create image texture from pixel data
     */
    createImageTexture(data: ImageData): void {
        if (!this.device) return;

        // Validate image size against GPU limits
        if (this.limitsChecker) {
            const validation = this.limitsChecker.validateImageSize(data.width, data.height);
            if (!validation.valid) {
                console.error(`[WebGPU] ${validation.error}`);
                if (validation.suggestion) {
                    console.info(`[WebGPU] Suggestion: ${validation.suggestion}`);
                }
                return;
            }
        }

        if (this.imageTexture) {
            this.imageTexture.destroy();
        }

        // Convert to RGBA (BGR -> RGB swap, add alpha)
        const numPixels = data.width * data.height;
        const rgbaPixels = new Float32Array(numPixels * 4);
        const srcPixels = data.pixels;

        if (data.channels === 3) {
            let srcIdx = 0;
            let dstIdx = 0;
            for (let i = 0; i < numPixels; i++) {
                const b = srcPixels[srcIdx++];
                const g = srcPixels[srcIdx++];
                const r = srcPixels[srcIdx++];
                rgbaPixels[dstIdx++] = r;
                rgbaPixels[dstIdx++] = g;
                rgbaPixels[dstIdx++] = b;
                rgbaPixels[dstIdx++] = 1.0;
            }
        } else if (data.channels === 4) {
            let srcIdx = 0;
            let dstIdx = 0;
            for (let i = 0; i < numPixels; i++) {
                const b = srcPixels[srcIdx++];
                const g = srcPixels[srcIdx++];
                const r = srcPixels[srcIdx++];
                const a = srcPixels[srcIdx++];
                rgbaPixels[dstIdx++] = r;
                rgbaPixels[dstIdx++] = g;
                rgbaPixels[dstIdx++] = b;
                rgbaPixels[dstIdx++] = a;
            }
        } else {
            let srcIdx = 0;
            let dstIdx = 0;
            for (let i = 0; i < numPixels; i++) {
                const v = srcPixels[srcIdx++];
                rgbaPixels[dstIdx++] = v;
                rgbaPixels[dstIdx++] = v;
                rgbaPixels[dstIdx++] = v;
                rgbaPixels[dstIdx++] = 1.0;
            }
        }

        // Create texture
        this.imageTexture = this.device.createTexture({
            size: [data.width, data.height],
            format: 'rgba32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        this.device.queue.writeTexture(
            { texture: this.imageTexture },
            rgbaPixels,
            { bytesPerRow: data.width * 16 },
            [data.width, data.height]
        );
    }

    /**
     * Build shader pipeline with WGSL shader info
     */
    async buildShader(shaderInfo: WgslShaderInfo | null): Promise<void> {
        if (!this.device) return;

        this.cleanupShaderTextures();

        // Use provided WGSL or fallback
        const fragmentShader = shaderInfo?.wgslCode || FALLBACK_FRAGMENT_SHADER;

        // Store for export rendering
        this.currentFragmentShader = fragmentShader;
        this.currentShaderInfo = shaderInfo;

        try {
            const vertexModule = this.device.createShaderModule({
                code: VERTEX_SHADER,
            });

            const fragmentModule = this.device.createShaderModule({
                code: fragmentShader,
            });

            this.pipeline = this.device.createRenderPipeline({
                layout: 'auto',
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
                    targets: [{ format: this.format }],
                },
                primitive: {
                    topology: 'triangle-strip',
                },
            });

            // Create RGC and OCIO textures if provided
            if (shaderInfo) {
                this.createShaderTextures(shaderInfo);

                // Initialize DCTL Uniform Buffer if enabled
                if (shaderInfo.useUniformBuffer && shaderInfo.paramMapping && shaderInfo.uniformBufferBinding !== undefined) {
                    this.initUniformBuffer(shaderInfo.paramMapping, shaderInfo.uniformBufferBinding);
                    console.log(`[WebGPU] DCTL Uniform Buffer initialized at binding ${shaderInfo.uniformBufferBinding}`);
                } else {
                    // Clear uniform buffer state if not using it
                    this.useUniformBuffer = false;
                    this.uniformBufferBinding = -1;
                }

                // Build compute pipeline with appropriate shader
                // DCTL Compute Pipeline is now supported - use it when DCTL is enabled
                // When DCTL is disabled, use OCIO-only Compute Pipeline (faster)
                if (this.computePipelineManager) {
                    // Debug log for dctlComputeShaderInfo
                    const dctlComputeInfo = shaderInfo.dctlComputeShaderInfo;
                    console.log(`[WebGPU] dctlComputeShaderInfo: exists=${!!dctlComputeInfo}, success=${dctlComputeInfo?.success}, hasDctl=${dctlComputeInfo?.hasDctl}, hasFullRgc=${dctlComputeInfo?.hasFullRgc}`);

                    // Check if DCTL or RGC is enabled
                    // - hasDctl=true means DCTL functions were successfully generated
                    // - hasFullRgc=true means OCIO-based RGC is enabled
                    // Either one requires the full DCTL+OCIO compute pipeline
                    const needsFullPipeline = dctlComputeInfo?.success === true &&
                        (dctlComputeInfo?.hasDctl === true || dctlComputeInfo?.hasFullRgc === true);

                    if (needsFullPipeline && dctlComputeInfo) {
                        // DCTL or RGC is enabled - use DCTL+OCIO Compute Pipeline
                        const success = await this.computePipelineManager.buildDctlOcioComputePipeline(dctlComputeInfo);
                        if (success) {
                            this.useComputePipeline = true;
                            const pipelineType = dctlComputeInfo.hasDctl
                                ? (dctlComputeInfo.hasFullRgc ? 'DCTL+OCIO+RGC' : 'DCTL+OCIO')
                                : 'OCIO+RGC';
                            console.log(`[WebGPU] ${pipelineType} compute pipeline built, compute mode enabled`);

                            // Enable debug pixel readback when RGC is used (to diagnose black output)
                            if (dctlComputeInfo.hasFullRgc) {
                                this.enableDebugPixelReadback();
                                console.log('[WebGPU] Debug pixel readback enabled for RGC pipeline verification');
                            }
                        } else {
                            // Fallback to Fragment Pipeline if compute build fails
                            console.warn('[WebGPU] Compute pipeline build failed, falling back to Fragment Pipeline');
                            this.useComputePipeline = false;
                        }
                    } else if (shaderInfo.computeWgslCode &&
                               (shaderInfo.textures.length > 0 || shaderInfo.textures3D.length > 0)) {
                        // No DCTL, No RGC - use OCIO-only Compute Pipeline (faster)
                        await this.buildOcioComputeFromShaderInfo(shaderInfo.computeWgslCode, shaderInfo);
                        this.useComputePipeline = true;
                        console.log('[WebGPU] OCIO-only compute pipeline built, compute mode enabled');
                    }
                }
            }

            // Create bind group
            this.createBindGroup();
        } catch (e) {
            console.error('Shader pipeline creation failed:', e);
            // Fallback to simple shader
            await this.buildFallbackPipeline();
        }
    }

    private async buildFallbackPipeline(): Promise<void> {
        if (!this.device) return;

        // Clean up any existing shader textures
        this.cleanupShaderTextures();

        // Set current shader to fallback
        this.currentFragmentShader = FALLBACK_FRAGMENT_SHADER;
        this.currentShaderInfo = null;

        const vertexModule = this.device.createShaderModule({
            code: VERTEX_SHADER,
        });

        const fragmentModule = this.device.createShaderModule({
            code: FALLBACK_FRAGMENT_SHADER,
        });

        this.pipeline = this.device.createRenderPipeline({
            layout: 'auto',
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
                targets: [{ format: this.format }],
            },
            primitive: {
                topology: 'triangle-strip',
            },
        });

        this.createBindGroup();
    }

    /**
     * Create GPU textures from shader info
     * Uses shared texture utilities from texture-utils.ts
     * Order: RGC textures first, then OCIO display textures (to match shader bindings)
     */
    private createShaderTextures(shaderInfo: WgslShaderInfo): void {
        if (!this.device) return;

        // Create RGC textures FIRST (to match shader binding order)
        if (shaderInfo.rgcTextures) {
            for (const tex of shaderInfo.rgcTextures) {
                const result = create2DTexture(this.device, tex as any, {
                    label: `RGC LUT 2D: ${tex.samplerName}`,
                });
                if (result) {
                    this.rgcTextures.push(result.texture);
                }
            }
        }

        if (shaderInfo.rgcTextures3D) {
            for (const tex of shaderInfo.rgcTextures3D) {
                const result = create3DTexture(this.device, tex as any, {
                    label: `RGC LUT 3D: ${tex.samplerName}`,
                });
                if (result) {
                    this.rgc3DTextures.push(result.texture);
                }
            }
        }

        // Create OCIO display textures
        for (const tex of shaderInfo.textures) {
            const result = create2DTexture(this.device, tex as any);
            if (result) {
                this.ocioTextures.push(result.texture);
            }
        }

        for (const tex of shaderInfo.textures3D) {
            const result = create3DTexture(this.device, tex as any);
            if (result) {
                this.ocio3DTextures.push(result.texture);
            }
        }
    }

    private createBindGroup(): void {
        if (!this.device || !this.pipeline || !this.imageTexture || !this.sampler) {
            return;
        }

        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: this.imageTexture.createView() },
            { binding: 1, resource: this.sampler },
        ];

        // Only add OCIO/RGC textures if we're NOT using the fallback shader
        // (fallback shader only has 2 bindings: texture + sampler)
        const isUsingFallback = this.currentFragmentShader === FALLBACK_FRAGMENT_SHADER;

        if (!isUsingFallback) {
            // Add RGC textures FIRST (to match shader binding order)
            let bindingIndex = 2;
            for (const tex of this.rgcTextures) {
                entries.push({ binding: bindingIndex++, resource: tex.createView() });
                entries.push({ binding: bindingIndex++, resource: this.sampler });
            }

            for (const tex of this.rgc3DTextures) {
                entries.push({
                    binding: bindingIndex++,
                    resource: tex.createView({ dimension: '3d' })
                });
                entries.push({ binding: bindingIndex++, resource: this.sampler });
            }

            // Add OCIO display textures
            for (const tex of this.ocioTextures) {
                entries.push({ binding: bindingIndex++, resource: tex.createView() });
                entries.push({ binding: bindingIndex++, resource: this.sampler });
            }

            for (const tex of this.ocio3DTextures) {
                entries.push({
                    binding: bindingIndex++,
                    resource: tex.createView({ dimension: '3d' })
                });
                entries.push({ binding: bindingIndex++, resource: this.sampler });
            }

            // Add DCTL Uniform Buffer if enabled
            if (this.useUniformBuffer && this.dctlParamBuffer && this.uniformBufferBinding >= 0) {
                const buffer = this.dctlParamBuffer.getBuffer();
                if (buffer) {
                    entries.push({
                        binding: this.uniformBufferBinding,
                        resource: { buffer },
                    });
                }
            }
        }

        try {
            this.bindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries,
            });
        } catch (e) {
            console.error('Bind group creation failed:', e);
        }
    }

    private cleanupShaderTextures(): void {
        // Cleanup RGC textures
        for (const tex of this.rgcTextures) {
            tex.destroy();
        }
        this.rgcTextures = [];

        for (const tex of this.rgc3DTextures) {
            tex.destroy();
        }
        this.rgc3DTextures = [];

        // Cleanup OCIO display textures
        for (const tex of this.ocioTextures) {
            tex.destroy();
        }
        this.ocioTextures = [];

        for (const tex of this.ocio3DTextures) {
            tex.destroy();
        }
        this.ocio3DTextures = [];
    }

    // ========================================
    // DCTL Uniform Buffer Methods (Fast Parameter Updates)
    // ========================================

    /**
     * Initialize DCTL Uniform Buffer for fast parameter updates
     */
    private initUniformBuffer(mapping: DctlParamMapping[], bindingIndex: number): void {
        if (!this.device) return;

        // Dispose existing buffer
        if (this.dctlParamBuffer) {
            this.dctlParamBuffer.dispose();
        }

        // Create new buffer
        this.dctlParamBuffer = new DctlParamBuffer(this.device);
        this.dctlParamBuffer.initialize(mapping);

        this.useUniformBuffer = true;
        this.uniformBufferBinding = bindingIndex;
    }

    /**
     * Check if uniform buffer mode is enabled
     * Returns true for both Fragment Pipeline (uniform buffer) and Compute Pipeline (DCTL buffer)
     */
    get isUniformBufferEnabled(): boolean {
        // Check Compute Pipeline DCTL support first
        if (this.useComputePipeline && this.computePipelineManager?.hasDctlSupport) {
            return true;
        }

        // Check Fragment Pipeline uniform buffer
        return this.useUniformBuffer && this.dctlParamBuffer?.isInitialized() === true;
    }

    /**
     * Update a single DCTL parameter (fast path - no shader recompilation)
     * Supports both Fragment Pipeline (uniform buffer) and Compute Pipeline (DCTL param buffer)
     * @param name Parameter name
     * @param value New value
     */
    updateDctlParam(name: string, value: number | boolean | DctlColorValue): void {
        // Update Compute Pipeline DCTL params (if using compute pipeline with DCTL)
        if (this.useComputePipeline && this.computePipelineManager?.hasDctlSupport) {
            this.computePipelineManager.updateDctlParam(name, value);
            return;
        }

        // Update Fragment Pipeline uniform buffer (legacy path)
        if (!this.dctlParamBuffer || !this.useUniformBuffer) {
            console.warn('[WebGPU] Uniform buffer not enabled, cannot update param fast');
            return;
        }

        this.dctlParamBuffer.updateParam(name, value);
    }

    /**
     * Update multiple DCTL parameters at once (fast path)
     * Supports both Fragment Pipeline and Compute Pipeline
     * @param values Parameter name-value pairs
     */
    updateDctlParams(values: Record<string, number | boolean | DctlColorValue>): void {
        // Update Compute Pipeline DCTL params (if using compute pipeline with DCTL)
        if (this.useComputePipeline && this.computePipelineManager?.hasDctlSupport) {
            this.computePipelineManager.updateDctlParams(values);
            return;
        }

        // Update Fragment Pipeline uniform buffer (legacy path)
        if (!this.dctlParamBuffer || !this.useUniformBuffer) {
            console.warn('[WebGPU] Uniform buffer not enabled, cannot update params fast');
            return;
        }

        this.dctlParamBuffer.updateParams(values);
    }

    /**
     * Set DCTL enabled/disabled state
     * Works with both Fragment Pipeline and Compute Pipeline
     * @param enabled Whether DCTL processing is enabled
     */
    setDctlEnabled(enabled: boolean): void {
        // Update Compute Pipeline
        if (this.useComputePipeline && this.computePipelineManager?.hasDctlSupport) {
            this.computePipelineManager.setDctlEnabled(enabled);
            return;
        }

        // Update Fragment Pipeline
        if (this.dctlParamBuffer && this.useUniformBuffer) {
            this.dctlParamBuffer.setEnabled(enabled);
        }
    }

    /**
     * Reset all DCTL parameters to default values
     */
    resetDctlParams(): void {
        // Reset Compute Pipeline
        if (this.useComputePipeline && this.computePipelineManager?.hasDctlSupport) {
            // Compute pipeline uses its own DctlParamBuffer internally
            // TODO: Add resetToDefaults method to ComputePipelineManager
            return;
        }

        // Reset Fragment Pipeline
        if (!this.dctlParamBuffer || !this.useUniformBuffer) return;
        this.dctlParamBuffer.resetToDefaults();
    }

    /**
     * Check if DCTL is supported in the current pipeline
     */
    get hasDctlSupport(): boolean {
        if (this.useComputePipeline) {
            return this.computePipelineManager?.hasDctlSupport ?? false;
        }
        return this.useUniformBuffer && this.dctlParamBuffer?.isInitialized() === true;
    }

    /**
     * Render the image
     * Uses compute pipeline if enabled, otherwise uses fragment shader
     */
    render(): void {
        if (this.useComputePipeline) {
            this.renderWithCompute();
        } else {
            this.renderWithFragment();
        }
    }

    /**
     * Render using fragment shader pipeline (traditional path)
     */
    private renderWithFragment(): void {
        if (!this.device || !this.context || !this.pipeline || !this.vertexBuffer || !this.bindGroup) {
            return;
        }

        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();

        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
            }],
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setVertexBuffer(0, this.vertexBuffer);
        renderPass.setBindGroup(0, this.bindGroup);
        renderPass.draw(4);
        renderPass.end();

        this.device.queue.submit([commandEncoder.finish()]);
    }

    // Debug flag to read output pixels once after RGC pipeline change
    private debugReadAfterRgc: boolean = false;
    private onPixelReadbackCallback: ((result: { isBlack: boolean; pixels: number[] }) => void) | null = null;

    /**
     * Enable debug pixel readback on next render (for diagnosing black output issues)
     * @param callback Optional callback to receive pixel data for external verification
     */
    enableDebugPixelReadback(callback?: (result: { isBlack: boolean; pixels: number[] }) => void): void {
        this.debugReadAfterRgc = true;
        this.onPixelReadbackCallback = callback ?? null;
    }

    /**
     * Render using compute shader pipeline
     * Processes image through compute shader, then displays result
     */
    private renderWithCompute(): void {
        if (!this.device || !this.context || !this.imageTexture || !this.computePipelineManager) {
            console.warn('Compute pipeline not ready for rendering');
            return;
        }

        if (!this.computePipelineManager.isInitialized) {
            console.warn('Compute pipeline manager not initialized');
            return;
        }

        // Set source texture for compute
        this.computePipelineManager.setSourceTexture(this.imageTexture);

        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();

        // Dispatch compute shader to process image
        this.computePipelineManager.dispatchCompute(
            commandEncoder,
            this.imageTexture.width,
            this.imageTexture.height
        );

        // Render compute output to canvas
        this.computePipelineManager.renderToCanvas(commandEncoder, textureView);

        this.device.queue.submit([commandEncoder.finish()]);

        // Debug: Read output pixels if enabled (to diagnose black output)
        if (this.debugReadAfterRgc) {
            this.debugReadAfterRgc = false;
            const callback = this.onPixelReadbackCallback;
            this.onPixelReadbackCallback = null;

            this.computePipelineManager.debugReadOutputPixels(4, 4).then(pixels => {
                if (pixels) {
                    const allZero = pixels.every(p => p === 0);
                    const pixelArray = Array.from(pixels.slice(0, 16));
                    console.log(`[WebGPU Debug] Output pixels: ${allZero ? 'ALL ZERO (black)' : 'non-zero'}`);
                    console.log(`[WebGPU Debug] First 16 values:`, pixelArray);

                    // Call callback if provided (for external verification)
                    if (callback) {
                        callback({ isBlack: allZero, pixels: pixelArray });
                    }
                }
            });
        }
    }

    /**
     * Get the compute pipeline's output texture (for further processing)
     */
    getComputeOutputTexture(): GPUTexture | null {
        return this.computePipelineManager?.getOutputTexture() ?? null;
    }

    // Export-specific RGC textures (created during buildExportShader)
    private exportRgcTextures: GPUTexture[] = [];
    private exportRgc3DTextures: GPUTexture[] = [];

    /**
     * Build an export pipeline with a different shader (for DCTL-only export)
     */
    async buildExportShader(shaderInfo: WgslShaderInfo): Promise<boolean> {
        if (!this.device || !this.imageTexture || !this.sampler) {
            console.error('WebGPU renderer not ready for export shader');
            return false;
        }

        try {
            // Cleanup previous export RGC textures
            for (const tex of this.exportRgcTextures) {
                tex.destroy();
            }
            this.exportRgcTextures = [];
            for (const tex of this.exportRgc3DTextures) {
                tex.destroy();
            }
            this.exportRgc3DTextures = [];

            // Use compileShader for detailed error reporting
            const vertexCompilation = await compileShader({
                device: this.device,
                code: VERTEX_SHADER,
                label: 'Export Vertex Shader',
                log: (msg) => console.log(`[Export] ${msg}`),
                throwOnError: true,
            });

            const fragmentCompilation = await compileShader({
                device: this.device,
                code: shaderInfo.wgslCode,
                label: 'Export Fragment Shader',
                log: (msg) => console.log(`[Export] ${msg}`),
                throwOnError: true,
            });

            // Create pipeline with validation scope to catch silent errors
            const { result: exportPipeline, error: pipelineError } =
                await this.errorHandler!.withValidationScope(
                    this.device,
                    () => this.device!.createRenderPipeline({
                        layout: 'auto',
                        vertex: {
                            module: vertexCompilation.module,
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
                            module: fragmentCompilation.module,
                            entryPoint: 'main',
                            targets: [{ format: 'rgba32float' }],
                        },
                        primitive: {
                            topology: 'triangle-strip',
                        },
                    }),
                    'export pipeline creation',
                );

            if (pipelineError) {
                console.error('[Export] Pipeline creation validation error:', pipelineError.message);
                this.exportPipeline = null;
                this.exportBindGroup = null;
                return false;
            }

            this.exportPipeline = exportPipeline;

            // Check float32-filterable support for r32float textures
            const hasFloat32Filterable = this.device.features.has('float32-filterable');
            if (!hasFloat32Filterable) {
                console.warn('[Export] float32-filterable not available - using nearest sampler for r32float RGC textures');
            }
            const nearestSampler = !hasFloat32Filterable
                ? createNearestSampler(this.device, 'Export RGC Nearest Sampler')
                : this.sampler; // unused fallback, selectSamplerForFormat will pick filtering

            // Create RGC textures if provided, tracking formats for sampler selection
            const exportRgcFormats: GPUTextureFormat[] = [];
            if (shaderInfo.rgcTextures) {
                for (const tex of shaderInfo.rgcTextures) {
                    const result = create2DTexture(this.device, tex as any, {
                        label: `Export RGC LUT 2D: ${tex.samplerName}`,
                    });
                    if (result) {
                        this.exportRgcTextures.push(result.texture);
                        exportRgcFormats.push(result.format);
                    }
                }
            }

            if (shaderInfo.rgcTextures3D) {
                for (const tex of shaderInfo.rgcTextures3D) {
                    const result = create3DTexture(this.device, tex as any, {
                        label: `Export RGC LUT 3D: ${tex.samplerName}`,
                    });
                    if (result) {
                        this.exportRgc3DTextures.push(result.texture);
                    }
                }
            }

            // Create bind group for export (image texture + sampler + RGC textures)
            const entries: GPUBindGroupEntry[] = [
                { binding: 0, resource: this.imageTexture.createView() },
                { binding: 1, resource: this.sampler },
            ];

            // Add RGC 2D textures with appropriate sampler based on format
            let bindingIndex = 2;
            for (let i = 0; i < this.exportRgcTextures.length; i++) {
                const tex = this.exportRgcTextures[i];
                const format = exportRgcFormats[i];
                const sampler = selectSamplerForFormat(format, hasFloat32Filterable, this.sampler, nearestSampler);
                entries.push({ binding: bindingIndex++, resource: tex.createView() });
                entries.push({ binding: bindingIndex++, resource: sampler });
                if (format === 'r32float' && !hasFloat32Filterable) {
                    console.log(`[Export] Using nearest sampler for r32float texture at binding ${bindingIndex - 2}`);
                }
            }
            for (const tex of this.exportRgc3DTextures) {
                entries.push({ binding: bindingIndex++, resource: tex.createView() });
                entries.push({ binding: bindingIndex++, resource: this.sampler });
            }

            console.log(`[Export] Created bind group with ${entries.length} entries (${this.exportRgcTextures.length} 2D + ${this.exportRgc3DTextures.length} 3D RGC textures, float32-filterable: ${hasFloat32Filterable})`);

            // Create bind group with validation scope
            const { result: bindGroup, error: bindGroupError } =
                await this.errorHandler!.withValidationScope(
                    this.device,
                    () => this.device!.createBindGroup({
                        layout: this.exportPipeline!.getBindGroupLayout(0),
                        entries,
                    }),
                    'export bind group creation',
                );

            if (bindGroupError) {
                console.error('[Export] Bind group creation validation error:', bindGroupError.message);
                this.exportPipeline = null;
                this.exportBindGroup = null;
                return false;
            }

            this.exportBindGroup = bindGroup;

            return true;
        } catch (e) {
            console.error('Export shader build failed:', e);
            this.exportPipeline = null;
            this.exportBindGroup = null;
            return false;
        }
    }

    /**
     * Render to an offscreen buffer for export (returns float RGBA data)
     * Uses the export pipeline if built, otherwise uses current pipeline
     *
     * @param width Output width
     * @param height Output height
     * @param useExportPipeline Whether to use the export pipeline (default: true)
     * @returns Float32Array of RGBA pixel data, or null on failure
     */
    async renderToBuffer(width: number, height: number, useExportPipeline: boolean = true): Promise<Float32Array | null> {
        const pipeline = useExportPipeline && this.exportPipeline ? this.exportPipeline : this.pipeline;
        const bindGroup = useExportPipeline && this.exportBindGroup ? this.exportBindGroup : this.bindGroup;

        if (!this.device || !pipeline || !this.vertexBuffer || !bindGroup) {
            console.error('WebGPU renderer not ready for buffer rendering');
            return null;
        }

        // Create offscreen render target (rgba32float for HDR data)
        const renderTexture = this.device.createTexture({
            size: [width, height],
            format: 'rgba32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });

        try {
            // Create buffer to read back the data
            const bytesPerPixel = 16; // 4 floats * 4 bytes
            const bytesPerRow = Math.ceil(width * bytesPerPixel / 256) * 256; // Align to 256 bytes
            const bufferSize = bytesPerRow * height;

            const readbackBuffer = this.device.createBuffer({
                size: bufferSize,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });

            // Render to offscreen texture with validation error detection
            this.device.pushErrorScope('validation');

            const commandEncoder = this.device.createCommandEncoder();

            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: renderTexture.createView(),
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                }],
            });

            renderPass.setPipeline(pipeline);
            renderPass.setVertexBuffer(0, this.vertexBuffer);
            renderPass.setBindGroup(0, bindGroup);
            renderPass.draw(4);
            renderPass.end();

            // Copy texture to buffer
            commandEncoder.copyTextureToBuffer(
                { texture: renderTexture },
                { buffer: readbackBuffer, bytesPerRow },
                [width, height]
            );

            this.device.queue.submit([commandEncoder.finish()]);

            const renderError = await this.device.popErrorScope();
            if (renderError) {
                console.error('[Export] Render validation error:', renderError.message);
            }

            // Map buffer and read data
            await readbackBuffer.mapAsync(GPUMapMode.READ);
            const mappedRange = readbackBuffer.getMappedRange();

            if (!mappedRange) {
                console.error('[Export] getMappedRange returned null/undefined');
                readbackBuffer.destroy();
                renderTexture.destroy();
                return null;
            }

            // Extract the actual pixel data (accounting for row padding)
            const resultSize = width * height * 4;
            if (isNaN(resultSize) || resultSize <= 0) {
                console.error(`[Export] Invalid result size: ${resultSize} (width=${width}, height=${height})`);
                readbackBuffer.unmap();
                readbackBuffer.destroy();
                renderTexture.destroy();
                return null;
            }

            const result = new Float32Array(resultSize);
            const tempView = new Float32Array(mappedRange);

            console.log(`[Export] renderToBuffer: result.length=${result.length}, tempView.length=${tempView.length}`);

            const srcFloatsPerRow = bytesPerRow / 4;
            const dstFloatsPerRow = width * 4;

            for (let y = 0; y < height; y++) {
                const srcOffset = y * srcFloatsPerRow;
                const dstOffset = y * dstFloatsPerRow;
                result.set(tempView.subarray(srcOffset, srcOffset + dstFloatsPerRow), dstOffset);
            }

            readbackBuffer.unmap();
            readbackBuffer.destroy();
            renderTexture.destroy();

            return result;
        } catch (e) {
            console.error('Failed to render to buffer:', e);
            renderTexture.destroy();
            return null;
        }
    }

    /**
     * Render to an offscreen buffer using compute pipeline
     * @returns Float32Array of RGBA pixel data, or null on failure
     */
    async renderToBufferWithCompute(): Promise<Float32Array | null> {
        if (!this.device || !this.imageTexture || !this.computePipelineManager) {
            console.error('Compute pipeline not ready for buffer rendering');
            return null;
        }

        if (!this.computePipelineManager.isInitialized) {
            console.error('Compute pipeline manager not initialized');
            return null;
        }

        const width = this.imageTexture.width;
        const height = this.imageTexture.height;

        // Set source texture for compute
        this.computePipelineManager.setSourceTexture(this.imageTexture);

        try {
            // Dispatch compute shader
            const commandEncoder = this.device.createCommandEncoder();
            this.computePipelineManager.dispatchCompute(commandEncoder, width, height);

            // Get output texture from compute pipeline
            const outputTexture = this.computePipelineManager.getOutputTexture();
            if (!outputTexture) {
                console.error('No output texture from compute pipeline');
                return null;
            }

            // Create buffer to read back the data
            const bytesPerPixel = 16; // 4 floats * 4 bytes
            const bytesPerRow = Math.ceil(width * bytesPerPixel / 256) * 256;
            const bufferSize = bytesPerRow * height;

            const readbackBuffer = this.device.createBuffer({
                size: bufferSize,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });

            // Copy output texture to buffer
            commandEncoder.copyTextureToBuffer(
                { texture: outputTexture },
                { buffer: readbackBuffer, bytesPerRow },
                [width, height]
            );

            this.device.queue.submit([commandEncoder.finish()]);

            // Map buffer and read data
            await readbackBuffer.mapAsync(GPUMapMode.READ);
            const mappedRange = readbackBuffer.getMappedRange();

            // Extract the actual pixel data (accounting for row padding)
            const result = new Float32Array(width * height * 4);
            const tempView = new Float32Array(mappedRange);

            const srcFloatsPerRow = bytesPerRow / 4;
            const dstFloatsPerRow = width * 4;

            for (let y = 0; y < height; y++) {
                const srcOffset = y * srcFloatsPerRow;
                const dstOffset = y * dstFloatsPerRow;
                result.set(tempView.subarray(srcOffset, srcOffset + dstFloatsPerRow), dstOffset);
            }

            readbackBuffer.unmap();
            readbackBuffer.destroy();

            return result;
        } catch (e) {
            console.error('Failed to render to buffer with compute:', e);
            return null;
        }
    }

    /**
     * Compare Fragment vs Compute pipeline output
     * Returns comparison statistics including max error, average error, and PSNR
     */
    async compareFragmentVsCompute(): Promise<{
        maxError: number;
        avgError: number;
        psnr: number;
        matchingPixels: number;
        totalPixels: number;
        passed: boolean;
    } | null> {
        const size = this.getImageSize();
        if (!size) {
            console.error('No image loaded for comparison');
            return null;
        }

        console.log('[Test] Starting Fragment vs Compute comparison...');
        const startTime = performance.now();

        // Render with Fragment pipeline
        const fragmentData = await this.renderToBuffer(size.width, size.height, false);
        if (!fragmentData) {
            console.error('Failed to render with Fragment pipeline');
            return null;
        }
        const fragmentTime = performance.now();
        console.log(`[Test] Fragment render: ${(fragmentTime - startTime).toFixed(2)}ms`);

        // Render with Compute pipeline
        const computeData = await this.renderToBufferWithCompute();
        if (!computeData) {
            console.error('Failed to render with Compute pipeline');
            return null;
        }
        const computeTime = performance.now();
        console.log(`[Test] Compute render: ${(computeTime - fragmentTime).toFixed(2)}ms`);

        // Compare pixel values
        const totalPixels = size.width * size.height;
        let maxError = 0;
        let sumError = 0;
        let sumSquaredError = 0;
        let matchingPixels = 0;
        const errorThreshold = 0.0001;

        for (let i = 0; i < fragmentData.length; i += 4) {
            // Compare RGB channels (skip alpha)
            for (let c = 0; c < 3; c++) {
                const fragVal = fragmentData[i + c];
                const compVal = computeData[i + c];
                const error = Math.abs(fragVal - compVal);

                maxError = Math.max(maxError, error);
                sumError += error;
                sumSquaredError += error * error;
            }

            // Check if this pixel matches within threshold
            const pixelError = Math.max(
                Math.abs(fragmentData[i] - computeData[i]),
                Math.abs(fragmentData[i + 1] - computeData[i + 1]),
                Math.abs(fragmentData[i + 2] - computeData[i + 2])
            );
            if (pixelError < errorThreshold) {
                matchingPixels++;
            }
        }

        const totalChannels = totalPixels * 3;
        const avgError = sumError / totalChannels;
        const mse = sumSquaredError / totalChannels;
        const psnr = mse > 0 ? 10 * Math.log10(1.0 / mse) : Infinity;

        const passed = maxError < errorThreshold;
        const endTime = performance.now();

        console.log(`[Test] Comparison complete in ${(endTime - startTime).toFixed(2)}ms`);
        console.log(`[Test] Max Error: ${maxError.toExponential(4)}`);
        console.log(`[Test] Avg Error: ${avgError.toExponential(4)}`);
        console.log(`[Test] PSNR: ${psnr.toFixed(2)} dB`);
        console.log(`[Test] Matching Pixels: ${matchingPixels}/${totalPixels} (${(matchingPixels/totalPixels*100).toFixed(2)}%)`);
        console.log(`[Test] Result: ${passed ? 'PASSED' : 'FAILED'} (threshold: ${errorThreshold})`);

        return {
            maxError,
            avgError,
            psnr,
            matchingPixels,
            totalPixels,
            passed,
        };
    }

    /**
     * Run performance benchmark comparing Fragment vs Compute pipelines
     * @param iterations Number of iterations to run (default: 10)
     * @returns Benchmark results including average times
     */
    async runPerformanceBenchmark(iterations: number = 10): Promise<{
        fragmentAvgMs: number;
        computeAvgMs: number;
        speedup: number;
        fragmentTimes: number[];
        computeTimes: number[];
    } | null> {
        if (!this.device || !this.imageTexture || !this.computePipelineManager) {
            console.error('Not ready for benchmark');
            return null;
        }

        const size = this.getImageSize();
        if (!size) {
            console.error('No image loaded for benchmark');
            return null;
        }

        console.log(`[Benchmark] Starting performance benchmark (${iterations} iterations)...`);
        console.log(`[Benchmark] Image size: ${size.width} x ${size.height}`);

        const fragmentTimes: number[] = [];
        const computeTimes: number[] = [];

        // Warmup
        console.log('[Benchmark] Warming up...');
        for (let i = 0; i < 3; i++) {
            this.renderWithFragment();
            this.renderWithCompute();
            await this.device.queue.onSubmittedWorkDone();
        }

        // Fragment pipeline benchmark
        console.log('[Benchmark] Running Fragment pipeline...');
        for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            this.renderWithFragment();
            await this.device.queue.onSubmittedWorkDone();
            const end = performance.now();
            fragmentTimes.push(end - start);
        }

        // Compute pipeline benchmark
        console.log('[Benchmark] Running Compute pipeline...');
        for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            this.renderWithCompute();
            await this.device.queue.onSubmittedWorkDone();
            const end = performance.now();
            computeTimes.push(end - start);
        }

        // Calculate statistics
        const fragmentAvgMs = fragmentTimes.reduce((a, b) => a + b, 0) / iterations;
        const computeAvgMs = computeTimes.reduce((a, b) => a + b, 0) / iterations;
        const speedup = fragmentAvgMs / computeAvgMs;

        const fragmentMin = Math.min(...fragmentTimes);
        const fragmentMax = Math.max(...fragmentTimes);
        const computeMin = Math.min(...computeTimes);
        const computeMax = Math.max(...computeTimes);

        console.log('[Benchmark] Results:');
        console.log(`  Fragment: avg=${fragmentAvgMs.toFixed(3)}ms, min=${fragmentMin.toFixed(3)}ms, max=${fragmentMax.toFixed(3)}ms`);
        console.log(`  Compute:  avg=${computeAvgMs.toFixed(3)}ms, min=${computeMin.toFixed(3)}ms, max=${computeMax.toFixed(3)}ms`);
        console.log(`  Speedup: ${speedup.toFixed(2)}x ${speedup > 1 ? '(Compute faster)' : '(Fragment faster)'}`);

        return {
            fragmentAvgMs,
            computeAvgMs,
            speedup,
            fragmentTimes,
            computeTimes,
        };
    }

    /**
     * Clean up export pipeline resources
     */
    cleanupExportPipeline(): void {
        this.exportPipeline = null;
        this.exportBindGroup = null;
    }

    /**
     * Get image texture dimensions
     */
    getImageSize(): { width: number; height: number } | null {
        if (!this.imageTexture) return null;
        return {
            width: this.imageTexture.width,
            height: this.imageTexture.height,
        };
    }

    // ========================================
    // GPU Histogram and Statistics
    // ========================================

    /**
     * Build GPU histogram pipeline
     */
    async buildHistogramPipeline(): Promise<boolean> {
        if (!this.computePipelineManager) {
            console.error('Compute pipeline manager not initialized');
            return false;
        }
        return this.computePipelineManager.buildHistogramPipeline();
    }

    /**
     * Calculate histogram using GPU
     * @returns Histogram data for R, G, B, and Luma channels
     */
    async calculateHistogramGPU(): Promise<{
        red: Uint32Array;
        green: Uint32Array;
        blue: Uint32Array;
        luminance: Uint32Array;
        bins: number;
    } | null> {
        if (!this.computePipelineManager || !this.imageTexture) {
            console.error('Not ready for GPU histogram calculation');
            return null;
        }

        const result = await this.computePipelineManager.calculateHistogramGPU(
            this.imageTexture,
            this.imageTexture.width,
            this.imageTexture.height
        );

        if (!result) return null;

        return {
            ...result,
            bins: 256,
        };
    }

    /**
     * Build GPU statistics pipeline
     */
    async buildStatisticsPipeline(): Promise<boolean> {
        if (!this.computePipelineManager) {
            console.error('Compute pipeline manager not initialized');
            return false;
        }
        return this.computePipelineManager.buildStatisticsPipeline();
    }

    /**
     * Calculate statistics (min, max, average) using GPU
     * @returns Statistics for R, G, B, and Luma channels
     */
    async calculateStatisticsGPU(): Promise<{
        min: { r: number; g: number; b: number; luma: number };
        max: { r: number; g: number; b: number; luma: number };
        avg: { r: number; g: number; b: number; luma: number };
    } | null> {
        if (!this.computePipelineManager || !this.imageTexture) {
            console.error('Not ready for GPU statistics calculation');
            return null;
        }

        return this.computePipelineManager.calculateStatisticsGPU(
            this.imageTexture,
            this.imageTexture.width,
            this.imageTexture.height
        );
    }

    /**
     * Cleanup resources
     */
    dispose(): void {
        // Detach error handler before destroying resources
        if (this.errorHandler) {
            this.errorHandler.detach();
            this.errorHandler = null;
        }
        this.limitsChecker = null;

        this.cleanupShaderTextures();
        // Cleanup DCTL param buffer
        if (this.dctlParamBuffer) {
            this.dctlParamBuffer.dispose();
            this.dctlParamBuffer = null;
        }
        this.useUniformBuffer = false;
        this.uniformBufferBinding = -1;

        if (this.computePipelineManager) {
            this.computePipelineManager.dispose();
            this.computePipelineManager = null;
        }
        if (this.imageTexture) {
            this.imageTexture.destroy();
            this.imageTexture = null;
        }
        if (this.vertexBuffer) {
            this.vertexBuffer.destroy();
            this.vertexBuffer = null;
        }
        this.pipeline = null;
        this.bindGroup = null;
        this.context = null;
        this.device = null;
    }
}
