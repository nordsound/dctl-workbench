/**
 * WebGPU Mock Layer for Testing
 *
 * Provides mock implementations of WebGPU interfaces for unit testing
 * compute pipeline logic without actual GPU access.
 */

// Type definitions for mock objects
export interface MockGPUBufferDescriptor {
    size: number;
    usage: number;
    label?: string;
}

export interface MockGPUTextureDescriptor {
    size: { width: number; height: number; depthOrArrayLayers?: number };
    format: string;
    usage: number;
    label?: string;
    dimension?: '1d' | '2d' | '3d';
}

export interface MockGPUShaderModuleDescriptor {
    code: string;
    label?: string;
}

export interface MockGPUBindGroupLayoutEntry {
    binding: number;
    visibility: number;
    buffer?: { type?: string };
    texture?: { sampleType?: string; viewDimension?: string };
    sampler?: { type?: string };
    storageTexture?: { access?: string; format?: string; viewDimension?: string };
}

export interface MockGPUBindGroupEntry {
    binding: number;
    resource: any;
}

/**
 * Mock GPU Buffer
 */
export class MockGPUBuffer {
    readonly size: number;
    readonly usage: number;
    readonly label: string;
    private data: ArrayBuffer;
    private mapped: boolean = false;

    constructor(descriptor: MockGPUBufferDescriptor) {
        this.size = descriptor.size;
        this.usage = descriptor.usage;
        this.label = descriptor.label ?? '';
        this.data = new ArrayBuffer(descriptor.size);
    }

    async mapAsync(mode: number): Promise<void> {
        this.mapped = true;
    }

    getMappedRange(offset?: number, size?: number): ArrayBuffer {
        if (!this.mapped) throw new Error('Buffer not mapped');
        return this.data.slice(offset ?? 0, (offset ?? 0) + (size ?? this.size));
    }

    unmap(): void {
        this.mapped = false;
    }

    destroy(): void {
        // No-op for mock
    }

    // Test helper: set buffer data
    _setData(data: ArrayBuffer): void {
        this.data = data;
    }
}

/**
 * Mock GPU Texture
 */
export class MockGPUTexture {
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers: number;
    readonly format: string;
    readonly usage: number;
    readonly label: string;
    readonly dimension: string;

    constructor(descriptor: MockGPUTextureDescriptor) {
        this.width = descriptor.size.width;
        this.height = descriptor.size.height;
        this.depthOrArrayLayers = descriptor.size.depthOrArrayLayers ?? 1;
        this.format = descriptor.format;
        this.usage = descriptor.usage;
        this.label = descriptor.label ?? '';
        this.dimension = descriptor.dimension ?? '2d';
    }

    createView(descriptor?: any): MockGPUTextureView {
        return new MockGPUTextureView(this, descriptor);
    }

    destroy(): void {
        // No-op for mock
    }
}

/**
 * Mock GPU Texture View
 */
export class MockGPUTextureView {
    readonly texture: MockGPUTexture;
    readonly label: string;

    constructor(texture: MockGPUTexture, descriptor?: any) {
        this.texture = texture;
        this.label = descriptor?.label ?? '';
    }
}

/**
 * Mock GPU Sampler
 */
export class MockGPUSampler {
    readonly label: string;

    constructor(descriptor?: any) {
        this.label = descriptor?.label ?? '';
    }
}

/**
 * Mock GPU Shader Module
 */
export class MockGPUShaderModule {
    readonly code: string;
    readonly label: string;
    private compilationMessages: Array<{ type: string; message: string; lineNum: number; linePos: number }> = [];

    constructor(descriptor: MockGPUShaderModuleDescriptor) {
        this.code = descriptor.code;
        this.label = descriptor.label ?? '';
        this._validateShader();
    }

    private _validateShader(): void {
        // Basic validation
        if (!this.code.includes('@compute') && !this.code.includes('@fragment') && !this.code.includes('@vertex')) {
            this.compilationMessages.push({
                type: 'error',
                message: 'Shader must have at least one entry point',
                lineNum: 1,
                linePos: 1,
            });
        }
    }

    async getCompilationInfo(): Promise<{ messages: Array<{ type: string; message: string; lineNum: number; linePos: number }> }> {
        return { messages: this.compilationMessages };
    }

    // Test helper: add compilation error
    _addError(message: string, lineNum: number = 1): void {
        this.compilationMessages.push({ type: 'error', message, lineNum, linePos: 1 });
    }
}

/**
 * Mock GPU Bind Group Layout
 */
export class MockGPUBindGroupLayout {
    readonly entries: MockGPUBindGroupLayoutEntry[];
    readonly label: string;

    constructor(descriptor: { entries: MockGPUBindGroupLayoutEntry[]; label?: string }) {
        this.entries = descriptor.entries;
        this.label = descriptor.label ?? '';
    }
}

/**
 * Mock GPU Bind Group
 */
export class MockGPUBindGroup {
    readonly layout: MockGPUBindGroupLayout;
    readonly entries: MockGPUBindGroupEntry[];
    readonly label: string;

    constructor(descriptor: { layout: MockGPUBindGroupLayout; entries: MockGPUBindGroupEntry[]; label?: string }) {
        this.layout = descriptor.layout;
        this.entries = descriptor.entries;
        this.label = descriptor.label ?? '';
    }
}

/**
 * Mock GPU Pipeline Layout
 */
export class MockGPUPipelineLayout {
    readonly bindGroupLayouts: MockGPUBindGroupLayout[];
    readonly label: string;

    constructor(descriptor: { bindGroupLayouts: MockGPUBindGroupLayout[]; label?: string }) {
        this.bindGroupLayouts = descriptor.bindGroupLayouts;
        this.label = descriptor.label ?? '';
    }
}

/**
 * Mock GPU Compute Pipeline
 */
export class MockGPUComputePipeline {
    readonly layout: MockGPUPipelineLayout | 'auto';
    readonly compute: { module: MockGPUShaderModule; entryPoint: string };
    readonly label: string;

    constructor(descriptor: {
        layout: MockGPUPipelineLayout | 'auto';
        compute: { module: MockGPUShaderModule; entryPoint: string };
        label?: string;
    }) {
        this.layout = descriptor.layout;
        this.compute = descriptor.compute;
        this.label = descriptor.label ?? '';
    }

    getBindGroupLayout(index: number): MockGPUBindGroupLayout {
        if (this.layout === 'auto') {
            // Return empty layout for auto
            return new MockGPUBindGroupLayout({ entries: [] });
        }
        return this.layout.bindGroupLayouts[index];
    }
}

/**
 * Mock GPU Render Pipeline
 */
export class MockGPURenderPipeline {
    readonly layout: MockGPUPipelineLayout | 'auto';
    readonly label: string;

    constructor(descriptor: any) {
        this.layout = descriptor.layout;
        this.label = descriptor.label ?? '';
    }

    getBindGroupLayout(index: number): MockGPUBindGroupLayout {
        if (this.layout === 'auto') {
            return new MockGPUBindGroupLayout({ entries: [] });
        }
        return this.layout.bindGroupLayouts[index];
    }
}

/**
 * Mock GPU Compute Pass Encoder
 */
export class MockGPUComputePassEncoder {
    private pipeline: MockGPUComputePipeline | null = null;
    private bindGroups: Map<number, MockGPUBindGroup> = new Map();
    public dispatchCalls: Array<{ x: number; y: number; z: number }> = [];

    setPipeline(pipeline: MockGPUComputePipeline): void {
        this.pipeline = pipeline;
    }

    setBindGroup(index: number, bindGroup: MockGPUBindGroup): void {
        this.bindGroups.set(index, bindGroup);
    }

    dispatchWorkgroups(x: number, y: number = 1, z: number = 1): void {
        this.dispatchCalls.push({ x, y, z });
    }

    end(): void {
        // Validate bind groups match pipeline layout
        if (this.pipeline && this.pipeline.layout !== 'auto') {
            const layout = this.pipeline.layout as MockGPUPipelineLayout;
            for (let i = 0; i < layout.bindGroupLayouts.length; i++) {
                if (!this.bindGroups.has(i)) {
                    console.warn(`[Mock] Missing bind group at index ${i}`);
                }
            }
        }
    }

    // Test helpers
    getBindGroup(index: number): MockGPUBindGroup | undefined {
        return this.bindGroups.get(index);
    }

    getPipeline(): MockGPUComputePipeline | null {
        return this.pipeline;
    }
}

/**
 * Mock GPU Render Pass Encoder
 */
export class MockGPURenderPassEncoder {
    private pipeline: MockGPURenderPipeline | null = null;
    private bindGroups: Map<number, MockGPUBindGroup> = new Map();
    public drawCalls: Array<{ vertexCount: number }> = [];

    setPipeline(pipeline: MockGPURenderPipeline): void {
        this.pipeline = pipeline;
    }

    setBindGroup(index: number, bindGroup: MockGPUBindGroup): void {
        this.bindGroups.set(index, bindGroup);
    }

    setVertexBuffer(slot: number, buffer: MockGPUBuffer): void {
        // No-op for mock
    }

    draw(vertexCount: number): void {
        this.drawCalls.push({ vertexCount });
    }

    end(): void {
        // No-op for mock
    }
}

/**
 * Mock GPU Command Buffer
 */
export class MockGPUCommandBuffer {
    readonly label: string;

    constructor(label?: string) {
        this.label = label ?? '';
    }
}

/**
 * Mock GPU Command Encoder
 */
export class MockGPUCommandEncoder {
    public computePasses: MockGPUComputePassEncoder[] = [];
    public renderPasses: MockGPURenderPassEncoder[] = [];
    public copyOperations: Array<{ type: string; src: any; dst: any }> = [];

    beginComputePass(descriptor?: any): MockGPUComputePassEncoder {
        const pass = new MockGPUComputePassEncoder();
        this.computePasses.push(pass);
        return pass;
    }

    beginRenderPass(descriptor?: any): MockGPURenderPassEncoder {
        const pass = new MockGPURenderPassEncoder();
        this.renderPasses.push(pass);
        return pass;
    }

    copyTextureToBuffer(source: any, destination: any, copySize: any): void {
        this.copyOperations.push({ type: 'textureToBuffer', src: source, dst: destination });
    }

    copyBufferToTexture(source: any, destination: any, copySize: any): void {
        this.copyOperations.push({ type: 'bufferToTexture', src: source, dst: destination });
    }

    finish(): MockGPUCommandBuffer {
        return new MockGPUCommandBuffer();
    }
}

/**
 * Mock GPU Queue
 */
export class MockGPUQueue {
    public submittedBuffers: MockGPUCommandBuffer[] = [];
    public writtenBuffers: Array<{ buffer: MockGPUBuffer; offset: number; data: ArrayBuffer }> = [];
    public writtenTextures: Array<{ texture: MockGPUTexture; data: ArrayBuffer }> = [];

    submit(commandBuffers: MockGPUCommandBuffer[]): void {
        this.submittedBuffers.push(...commandBuffers);
    }

    writeBuffer(buffer: MockGPUBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void {
        const arrayBuffer = data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer);
        this.writtenBuffers.push({ buffer, offset, data: arrayBuffer });
    }

    writeTexture(
        destination: { texture: MockGPUTexture },
        data: ArrayBuffer | ArrayBufferView,
        dataLayout: any,
        size: any
    ): void {
        const arrayBuffer = data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer);
        this.writtenTextures.push({ texture: destination.texture, data: arrayBuffer });
    }
}

/**
 * Mock GPU Device
 */
export class MockGPUDevice {
    public readonly queue: MockGPUQueue;
    public readonly limits: Record<string, number>;
    public readonly features: Set<string>;
    public createdBuffers: MockGPUBuffer[] = [];
    public createdTextures: MockGPUTexture[] = [];
    public createdShaderModules: MockGPUShaderModule[] = [];
    public createdBindGroupLayouts: MockGPUBindGroupLayout[] = [];
    public createdBindGroups: MockGPUBindGroup[] = [];
    public createdPipelineLayouts: MockGPUPipelineLayout[] = [];
    public createdComputePipelines: MockGPUComputePipeline[] = [];
    public createdRenderPipelines: MockGPURenderPipeline[] = [];

    // Error scope tracking
    private errorScopeStack: string[] = [];
    public pushedErrorScopes: string[] = [];
    public poppedErrorScopes: string[] = [];

    constructor(options?: { features?: string[] }) {
        this.queue = new MockGPUQueue();
        this.features = new Set(options?.features ?? []);
        this.limits = {
            maxTextureDimension2D: 8192,
            maxTextureDimension3D: 2048,
            maxBufferSize: 268435456, // 256 MB
            maxStorageBufferBindingSize: 134217728, // 128 MB
            maxBindGroups: 4,
            maxComputeWorkgroupSizeX: 256,
            maxComputeWorkgroupSizeY: 256,
            maxComputeWorkgroupSizeZ: 64,
        };
    }

    pushErrorScope(filter: string): void {
        this.errorScopeStack.push(filter);
        this.pushedErrorScopes.push(filter);
    }

    async popErrorScope(): Promise<any> {
        const scope = this.errorScopeStack.pop();
        if (scope) {
            this.poppedErrorScopes.push(scope);
        }
        return null; // No error by default
    }

    createBuffer(descriptor: MockGPUBufferDescriptor): MockGPUBuffer {
        const buffer = new MockGPUBuffer(descriptor);
        this.createdBuffers.push(buffer);
        return buffer;
    }

    createTexture(descriptor: MockGPUTextureDescriptor): MockGPUTexture {
        const texture = new MockGPUTexture(descriptor);
        this.createdTextures.push(texture);
        return texture;
    }

    createSampler(descriptor?: any): MockGPUSampler {
        return new MockGPUSampler(descriptor);
    }

    createShaderModule(descriptor: MockGPUShaderModuleDescriptor): MockGPUShaderModule {
        const module = new MockGPUShaderModule(descriptor);
        this.createdShaderModules.push(module);
        return module;
    }

    createBindGroupLayout(descriptor: { entries: MockGPUBindGroupLayoutEntry[]; label?: string }): MockGPUBindGroupLayout {
        const layout = new MockGPUBindGroupLayout(descriptor);
        this.createdBindGroupLayouts.push(layout);
        return layout;
    }

    createBindGroup(descriptor: { layout: MockGPUBindGroupLayout; entries: MockGPUBindGroupEntry[]; label?: string }): MockGPUBindGroup {
        const group = new MockGPUBindGroup(descriptor);
        this.createdBindGroups.push(group);
        return group;
    }

    createPipelineLayout(descriptor: { bindGroupLayouts: MockGPUBindGroupLayout[]; label?: string }): MockGPUPipelineLayout {
        const layout = new MockGPUPipelineLayout(descriptor);
        this.createdPipelineLayouts.push(layout);
        return layout;
    }

    createComputePipeline(descriptor: any): MockGPUComputePipeline {
        const pipeline = new MockGPUComputePipeline(descriptor);
        this.createdComputePipelines.push(pipeline);
        return pipeline;
    }

    createRenderPipeline(descriptor: any): MockGPURenderPipeline {
        const pipeline = new MockGPURenderPipeline(descriptor);
        this.createdRenderPipelines.push(pipeline);
        return pipeline;
    }

    createCommandEncoder(): MockGPUCommandEncoder {
        return new MockGPUCommandEncoder();
    }

    destroy(): void {
        // Clear all created resources
        this.createdBuffers = [];
        this.createdTextures = [];
        this.createdShaderModules = [];
        this.createdBindGroupLayouts = [];
        this.createdBindGroups = [];
        this.createdPipelineLayouts = [];
        this.createdComputePipelines = [];
        this.createdRenderPipelines = [];
    }
}

/**
 * Mock GPU Adapter
 */
export class MockGPUAdapter {
    public readonly limits: Record<string, number>;
    public readonly features: Set<string>;

    constructor(options?: { features?: string[] }) {
        this.features = new Set(options?.features ?? []);
        this.limits = {
            maxTextureDimension2D: 8192,
            maxTextureDimension3D: 2048,
        };
    }

    async requestDevice(descriptor?: { requiredFeatures?: string[] }): Promise<MockGPUDevice> {
        return new MockGPUDevice({ features: descriptor?.requiredFeatures });
    }
}

/**
 * Mock GPU (entry point)
 */
export class MockGPU {
    async requestAdapter(): Promise<MockGPUAdapter> {
        return new MockGPUAdapter();
    }
}

// GPU Buffer Usage flags
export const GPUBufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
};

// GPU Texture Usage flags
export const GPUTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
};

// GPU Shader Stage flags
export const GPUShaderStage = {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
};

// GPU Map Mode
export const GPUMapMode = {
    READ: 0x0001,
    WRITE: 0x0002,
};
