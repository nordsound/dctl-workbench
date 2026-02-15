/**
 * OpenColorIO WASM Type Definitions
 */

export interface GpuTexture {
    name: string;
    samplerName: string;
    width: number;
    height: number;
    channel: number;  // 0 = TEXTURE_RED_CHANNEL, 1 = TEXTURE_RGB_CHANNEL
    dimensions: number; // 0 = TEXTURE_1D, 1 = TEXTURE_2D
    data: number[];
}

export interface GpuTexture3D {
    name: string;
    samplerName: string;
    edgeLen: number;
    data: number[];
}

export interface GpuUniform {
    name: string;
    type: number;
}

export interface GpuShaderInfo {
    shaderText: string;
    textures: GpuTexture[];
    textures3D: GpuTexture3D[];
    uniforms: GpuUniform[];
}

export interface BuiltinConfigInfo {
    name: string;
    uiName: string;
    isRecommended: boolean;
}

export interface OCIOProcessorClass {
    new(): OCIOProcessorInstance;
}

export interface OCIOProcessorInstance {
    initBuiltinConfig(configName: string): boolean;
    getColorSpaces(): string[];
    getDisplays(): string[];
    getViews(display: string): string[];
    createTransform(src: string, dst: string): boolean;
    createDisplayTransform(src: string, display: string, view: string): boolean;
    applyRGBPtr(ptr: number, numPixels: number): boolean;
    applyRGBAPtr(ptr: number, numPixels: number): boolean;
    setupSrgbToAces(): boolean;
    setupAcesToSrgbDisplay(): boolean;
    setupAcesToSrgbLinear(): boolean;
    setupAcesToRec709Display(): boolean;
    setupAcesToP3Display(): boolean;
    setupAcesToRec2100PQ(peakLuminance: number, limitingPrimaries: number): boolean;
    setupAcesToRec2100HLG(): boolean;
    setupAcesToST2084P3(peakLuminance: number): boolean;
    createInverseDisplayTransform(src: string, display: string, view: string): boolean;
    setupSrgbDisplayToAces(): boolean;
    setupRec709DisplayToAces(): boolean;
    setupP3DisplayToAces(): boolean;
    setupRec2100PQToAces(peakLuminance: number, limitingPrimaries: number): boolean;
    setupRec2100HLGToAces(): boolean;
    setupACES2GamutCompress(peakLuminance: number, inverse: boolean): boolean;
    applyACES2GamutCompressRGB(ptr: number, numPixels: number, peakLuminance: number, inverse: boolean): boolean;
    getLastError(): string;
    hasTransform(): boolean;
    getConfigDescription(): string;
    initConfigFromFile(configPath: string): boolean;
    initConfigFromString(configContent: string): boolean;
    createChainedDisplayTransform(workingCS: string, sourceCS: string, display: string, view: string): boolean;
    getColorSpaceFamily(name: string): string;
    isSceneReferred(name: string): boolean;
    setupGpuProcessor(): boolean;
    extractGpuShaderInfo(): GpuShaderInfo;
    delete(): void;
}

export interface EmscriptenFS {
    mkdir(path: string): void;
    mount(type: EmscriptenFSType, opts: { root: string }, mountpoint: string): void;
    unmount(mountpoint: string): void;
    stat(path: string): { mode: number };
    isDir(mode: number): boolean;
}

export interface EmscriptenFSType {
    // Opaque type representing NODEFS, MEMFS, etc.
}

export interface OCIOModule {
    OCIOProcessor: OCIOProcessorClass;
    getBuiltinConfigs(): BuiltinConfigInfo[];
    getOCIOVersion(): string;
    _malloc(size: number): number;
    _free(ptr: number): void;
    HEAPU8: Uint8Array;
    HEAPF32: Float32Array;
    setValue(ptr: number, value: number, type: string): void;
    getValue(ptr: number, type: string): number;
    FS: EmscriptenFS;
    NODEFS: EmscriptenFSType;
}

export type CreateOCIO = (options?: { wasmBinary?: ArrayBuffer }) => Promise<OCIOModule>;

/**
 * RGC shader extraction result
 */
export interface RgcShaderInfo {
    glsl: string;
    textures: GpuTexture[];
    textures3D: GpuTexture3D[];
    success: boolean;
    error?: string;
}
