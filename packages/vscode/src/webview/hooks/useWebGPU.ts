/**
 * WebGPU hook for EXR image rendering with OCIO color transform
 *
 * Requires WGSL shaders (converted from OCIO GLSL via naga on the host side)
 */

import { useRef, useCallback, useEffect } from 'react';
import type { ImageData } from '../types';

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

interface WebGPUShaderInfo {
    // WGSL shader code (converted from GLSL via naga)
    wgslCode: string;
    // Original GLSL for fallback
    glslCode?: string;
    textures: GpuTexture[];
    textures3D: GpuTexture3D[];
    uniforms: { name: string; type: number }[];
}

interface UseWebGPUReturn {
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    loadImage: (data: ImageData & { wgslShaderInfo?: WebGPUShaderInfo }) => Promise<void>;
    updateShader: (shaderInfo: WebGPUShaderInfo) => Promise<void>;
    getPixelValue: (x: number, y: number) => { r: number; g: number; b: number } | null;
    isSupported: boolean;
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
@group(0) @binding(0) var u_image: texture_2d<f32>;
@group(0) @binding(1) var u_sampler: sampler;

@fragment
fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let color = textureSample(u_image, u_sampler, texCoord);
    return clamp(color, vec4<f32>(0.0), vec4<f32>(1.0));
}
`;

export function useWebGPU(): UseWebGPUReturn {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const deviceRef = useRef<GPUDevice | null>(null);
    const contextRef = useRef<GPUCanvasContext | null>(null);
    const pipelineRef = useRef<GPURenderPipeline | null>(null);
    const vertexBufferRef = useRef<GPUBuffer | null>(null);
    const imageTextureRef = useRef<GPUTexture | null>(null);
    const samplerRef = useRef<GPUSampler | null>(null);
    const bindGroupRef = useRef<GPUBindGroup | null>(null);
    const ocioTexturesRef = useRef<GPUTexture[]>([]);
    const ocio3DTexturesRef = useRef<GPUTexture[]>([]);
    const pixelDataRef = useRef<Float32Array | null>(null);
    const imageDataRef = useRef<ImageData | null>(null);
    const isSupportedRef = useRef<boolean>(false);

    // Check WebGPU support
    const checkSupport = useCallback(async (): Promise<boolean> => {
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
            return true;
        } catch (e) {
            console.warn('WebGPU check failed:', e);
            return false;
        }
    }, []);

    // Initialize WebGPU
    const initWebGPU = useCallback(async (): Promise<boolean> => {
        const canvas = canvasRef.current;
        if (!canvas || deviceRef.current) return !!deviceRef.current;

        if (!navigator.gpu) {
            console.error('WebGPU is not supported');
            return false;
        }

        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                console.error('No WebGPU adapter found');
                return false;
            }

            const device = await adapter.requestDevice({
                requiredFeatures: ['float32-filterable'] as GPUFeatureName[],
            });

            device.lost.then((info) => {
                console.error('WebGPU device lost:', info.message);
                deviceRef.current = null;
            });

            const context = canvas.getContext('webgpu');
            if (!context) {
                console.error('Failed to get WebGPU context');
                return false;
            }

            // Use preferred format but avoid sRGB variants to prevent double gamma
            // OCIO shader already outputs sRGB-encoded values, so we don't want
            // the canvas to apply additional sRGB conversion
            const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
            const format = preferredFormat.includes('srgb')
                ? (preferredFormat.replace('-srgb', '') as GPUTextureFormat)
                : preferredFormat;

            context.configure({
                device,
                format,
                alphaMode: 'opaque',
            });

            deviceRef.current = device;
            contextRef.current = context;
            isSupportedRef.current = true;

            // Create sampler
            samplerRef.current = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
            });

            // Create vertex buffer (fullscreen quad)
            const vertices = new Float32Array([
                // position (xy), texCoord (uv)
                -1, -1, 0, 1,
                 1, -1, 1, 1,
                -1,  1, 0, 0,
                 1,  1, 1, 0,
            ]);

            vertexBufferRef.current = device.createBuffer({
                size: vertices.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(vertexBufferRef.current, 0, vertices);

            return true;
        } catch (e) {
            console.error('WebGPU initialization failed:', e);
            return false;
        }
    }, []);

    // Cleanup OCIO textures
    const cleanupOCIOTextures = useCallback(() => {
        for (const tex of ocioTexturesRef.current) {
            tex.destroy();
        }
        ocioTexturesRef.current = [];

        for (const tex of ocio3DTexturesRef.current) {
            tex.destroy();
        }
        ocio3DTexturesRef.current = [];
    }, []);

    // Create render pipeline with shader
    const createPipeline = useCallback(async (wgslFragment: string): Promise<GPURenderPipeline | null> => {
        const device = deviceRef.current;
        const context = contextRef.current;
        if (!device || !context) return null;

        try {
            const vertexModule = device.createShaderModule({
                code: VERTEX_SHADER,
            });

            const fragmentModule = device.createShaderModule({
                code: wgslFragment,
            });

            const format = navigator.gpu.getPreferredCanvasFormat();

            const pipeline = device.createRenderPipeline({
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
                    targets: [{ format }],
                },
                primitive: {
                    topology: 'triangle-strip',
                },
            });

            return pipeline;
        } catch (e) {
            console.error('Pipeline creation failed:', e);
            return null;
        }
    }, []);

    // Create image texture
    const createImageTexture = useCallback((data: ImageData) => {
        const device = deviceRef.current;
        if (!device) return;

        if (imageTextureRef.current) {
            imageTextureRef.current.destroy();
        }

        const srcPixels = data.pixels;
        pixelDataRef.current = srcPixels;

        // Convert to RGBA (BGR -> RGB swap, add alpha)
        const numPixels = data.width * data.height;
        const rgbaPixels = new Float32Array(numPixels * 4);

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
        const texture = device.createTexture({
            size: [data.width, data.height],
            format: 'rgba32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        device.queue.writeTexture(
            { texture },
            rgbaPixels,
            { bytesPerRow: data.width * 16 },
            [data.width, data.height]
        );

        imageTextureRef.current = texture;
    }, []);

    // Create OCIO LUT textures
    const createOCIOTextures = useCallback((shaderInfo: WebGPUShaderInfo): GPUTexture[] => {
        const device = deviceRef.current;
        if (!device) return [];

        const textures: GPUTexture[] = [];

        // 2D textures
        for (const tex of shaderInfo.textures) {
            const data = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);

            // Determine format based on channel count
            const format: GPUTextureFormat = tex.channel === 0 ? 'r32float' : 'rgba32float';
            const bytesPerPixel = tex.channel === 0 ? 4 : 16;

            // For single channel, data is already R format
            // For RGB, we need to convert to RGBA
            let uploadData: Float32Array;
            if (tex.channel === 0) {
                uploadData = data;
            } else {
                // RGB -> RGBA
                const numPixels = tex.width * tex.height;
                uploadData = new Float32Array(numPixels * 4);
                let srcIdx = 0;
                let dstIdx = 0;
                for (let i = 0; i < numPixels; i++) {
                    uploadData[dstIdx++] = data[srcIdx++];
                    uploadData[dstIdx++] = data[srcIdx++];
                    uploadData[dstIdx++] = data[srcIdx++];
                    uploadData[dstIdx++] = 1.0;
                }
            }

            const texture = device.createTexture({
                size: [tex.width, tex.height],
                format,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });

            device.queue.writeTexture(
                { texture },
                uploadData,
                { bytesPerRow: tex.width * bytesPerPixel },
                [tex.width, tex.height]
            );

            textures.push(texture);
            ocioTexturesRef.current.push(texture);
        }

        return textures;
    }, []);

    // Create OCIO 3D LUT textures
    const createOCIO3DTextures = useCallback((shaderInfo: WebGPUShaderInfo): GPUTexture[] => {
        const device = deviceRef.current;
        if (!device) return [];

        const textures: GPUTexture[] = [];

        for (const tex of shaderInfo.textures3D) {
            const data = new Float32Array(tex.data);
            const size = tex.edgeLen;

            // Convert RGB to RGBA for 3D texture
            const numVoxels = size * size * size;
            const rgbaData = new Float32Array(numVoxels * 4);
            let srcIdx = 0;
            let dstIdx = 0;
            for (let i = 0; i < numVoxels; i++) {
                rgbaData[dstIdx++] = data[srcIdx++];
                rgbaData[dstIdx++] = data[srcIdx++];
                rgbaData[dstIdx++] = data[srcIdx++];
                rgbaData[dstIdx++] = 1.0;
            }

            const texture = device.createTexture({
                size: [size, size, size],
                dimension: '3d',
                format: 'rgba32float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });

            device.queue.writeTexture(
                { texture },
                rgbaData,
                { bytesPerRow: size * 16, rowsPerImage: size },
                [size, size, size]
            );

            textures.push(texture);
            ocio3DTexturesRef.current.push(texture);
        }

        return textures;
    }, []);

    // Create bind group with all textures
    const createBindGroup = useCallback((
        pipeline: GPURenderPipeline,
        imageTexture: GPUTexture,
        ocioTextures: GPUTexture[],
        ocio3DTextures: GPUTexture[]
    ): GPUBindGroup | null => {
        const device = deviceRef.current;
        const sampler = samplerRef.current;
        if (!device || !sampler) return null;

        // Build bind group entries
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: imageTexture.createView() },
            { binding: 1, resource: sampler },
        ];

        // Add OCIO 2D textures and samplers
        let bindingIndex = 2;
        for (const tex of ocioTextures) {
            entries.push({ binding: bindingIndex++, resource: tex.createView() });
            entries.push({ binding: bindingIndex++, resource: sampler });
        }

        // Add OCIO 3D textures and samplers
        for (const tex of ocio3DTextures) {
            entries.push({
                binding: bindingIndex++,
                resource: tex.createView({ dimension: '3d' })
            });
            entries.push({ binding: bindingIndex++, resource: sampler });
        }

        try {
            return device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries,
            });
        } catch (e) {
            console.error('Bind group creation failed:', e);
            return null;
        }
    }, []);

    // Render
    const render = useCallback(() => {
        const device = deviceRef.current;
        const context = contextRef.current;
        const pipeline = pipelineRef.current;
        const vertexBuffer = vertexBufferRef.current;
        const bindGroup = bindGroupRef.current;

        if (!device || !context || !pipeline || !vertexBuffer || !bindGroup) {
            return;
        }

        const commandEncoder = device.createCommandEncoder();
        const textureView = context.getCurrentTexture().createView();

        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
            }],
        });

        renderPass.setPipeline(pipeline);
        renderPass.setVertexBuffer(0, vertexBuffer);
        renderPass.setBindGroup(0, bindGroup);
        renderPass.draw(4);
        renderPass.end();

        device.queue.submit([commandEncoder.finish()]);
    }, []);

    // Build shader and setup pipeline
    const buildShader = useCallback(async (shaderInfo: WebGPUShaderInfo) => {
        cleanupOCIOTextures();

        // Create fragment shader with OCIO integration
        const fragmentShader = buildFragmentShader(shaderInfo);
        const isUsingFallback = fragmentShader === FALLBACK_FRAGMENT_SHADER;

        const pipeline = await createPipeline(fragmentShader);
        if (!pipeline) {
            console.error('Failed to create pipeline, using fallback');
            const fallbackPipeline = await createPipeline(FALLBACK_FRAGMENT_SHADER);
            if (fallbackPipeline) {
                pipelineRef.current = fallbackPipeline;
            }
            return;
        }

        pipelineRef.current = pipeline;

        // Create OCIO textures only if NOT using fallback shader
        // (fallback shader only has 2 bindings: texture + sampler)
        const ocioTextures = isUsingFallback ? [] : createOCIOTextures(shaderInfo);
        const ocio3DTextures = isUsingFallback ? [] : createOCIO3DTextures(shaderInfo);

        // Create bind group
        const imageTexture = imageTextureRef.current;
        if (imageTexture) {
            const bindGroup = createBindGroup(pipeline, imageTexture, ocioTextures, ocio3DTextures);
            if (bindGroup) {
                bindGroupRef.current = bindGroup;
            }
        }
    }, [cleanupOCIOTextures, createPipeline, createOCIOTextures, createOCIO3DTextures, createBindGroup]);

    // Load image
    const loadImage = useCallback(async (data: ImageData & { wgslShaderInfo?: WebGPUShaderInfo }) => {
        const initialized = await initWebGPU();
        if (!initialized) {
            console.error('WebGPU not initialized');
            return;
        }

        const canvas = canvasRef.current;
        if (!canvas) return;

        imageDataRef.current = data;
        canvas.width = data.width;
        canvas.height = data.height;

        createImageTexture(data);

        // Use WGSL shader info if available, otherwise create default
        if (data.wgslShaderInfo) {
            await buildShader(data.wgslShaderInfo);
        } else {
            // Fallback: no color transform
            const pipeline = await createPipeline(FALLBACK_FRAGMENT_SHADER);
            if (pipeline) {
                pipelineRef.current = pipeline;
                const imageTexture = imageTextureRef.current;
                if (imageTexture) {
                    const bindGroup = createBindGroup(pipeline, imageTexture, [], []);
                    if (bindGroup) {
                        bindGroupRef.current = bindGroup;
                    }
                }
            }
        }

        render();
    }, [initWebGPU, createImageTexture, buildShader, createPipeline, createBindGroup, render]);

    // Update shader
    const updateShader = useCallback(async (shaderInfo: WebGPUShaderInfo) => {
        if (!imageDataRef.current) return;
        await buildShader(shaderInfo);
        render();
    }, [buildShader, render]);

    // Get pixel value (from original data, not rendered)
    const getPixelValue = useCallback((x: number, y: number): { r: number; g: number; b: number } | null => {
        const imageData = imageDataRef.current;
        const pixelData = pixelDataRef.current;
        if (!imageData || !pixelData) return null;

        if (x < 0 || x >= imageData.width || y < 0 || y >= imageData.height) return null;

        const idx = (y * imageData.width + x) * imageData.channels;
        return {
            r: pixelData[idx] || 0,
            g: pixelData[idx + 1] || 0,
            b: pixelData[idx + 2] || 0,
        };
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        // Check support on mount
        checkSupport().then(supported => {
            isSupportedRef.current = supported;
        });

        return () => {
            cleanupOCIOTextures();
            if (imageTextureRef.current) {
                imageTextureRef.current.destroy();
            }
            if (vertexBufferRef.current) {
                vertexBufferRef.current.destroy();
            }
        };
    }, [checkSupport, cleanupOCIOTextures]);

    return {
        canvasRef,
        loadImage,
        updateShader,
        getPixelValue,
        isSupported: isSupportedRef.current,
    };
}

/**
 * Build fragment shader with OCIO WGSL code
 */
function buildFragmentShader(shaderInfo: WebGPUShaderInfo): string {
    // If we have pre-converted WGSL, use it directly
    if (shaderInfo.wgslCode) {
        return shaderInfo.wgslCode;
    }

    // Otherwise use fallback
    return FALLBACK_FRAGMENT_SHADER;
}
