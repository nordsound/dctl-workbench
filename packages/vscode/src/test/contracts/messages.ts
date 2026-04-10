/**
 * Webview message contract schemas (zod).
 *
 * Defines the precise shape of every message exchanged between the
 * dctl-workbench host extension and its webview. The schemas are used
 * by unit tests to detect any contract drift the moment it happens —
 * if a sender adds, renames, or drops a field, the matching schema
 * must be updated, and the test that exercises that schema will fail
 * loudly.
 *
 * IMPORTANT — production code MUST NOT import this file. zod is a
 * devDependency of packages/vscode and is not bundled into the VSIX.
 * Importing these schemas from src/* would pull zod into the runtime
 * bundle. Only files under src/test/ may import them.
 *
 * Source of truth for field names and shapes:
 *   - docs/tasks/results/T003/exr_editor_provider_anatomy.md
 *   - the message catalog produced during T003 §A0.3
 *
 * Catalog summary (24 distinct message types as of 2026-04-10):
 *   Extension → Webview (10):
 *     startLoading, loadImage, updateShader, loadDctl, unloadDctl,
 *     openDctlFiles, buildExportShader, exportToBuffer, error,
 *     updateDctlParamFast
 *   Webview → Extension (14):
 *     ready, setDisplayTransform, selectDctlFile, loadDctlFromPath,
 *     toggleDctl, toggleRgc, updateRgcSettings, changeDctlColorSpace,
 *     updateDctlParam, log, exportBufferReady, exportExr,
 *     shaderBuildResult, rgcPixelVerification
 */

import { z } from 'zod';

// =============================================================================
// Shared sub-schemas
// =============================================================================

/** DCTL working color space (mirrors src/dctl/types.ts DctlColorSpace) */
export const DctlColorSpaceSchema = z.enum([
    'ACES2065-1',
    'ACEScg',
    'ACEScc',
    'ACEScct',
    'linear_sRGB',
]);

/** Color triple used by DCTL color parameters */
export const DctlColorValueSchema = z.object({
    r: z.number(),
    g: z.number(),
    b: z.number(),
});

/** A scalar DCTL parameter value (number, boolean, or color) */
export const DctlParamValueSchema = z.union([
    z.number(),
    z.boolean(),
    DctlColorValueSchema,
]);

/** Single DCTL parameter definition that travels in `loadDctl` */
export const DctlParamSchema = z.object({
    name: z.string(),
    label: z.string().optional(),
    type: z.string(),
    default: DctlParamValueSchema,
    hint: z.string().optional(),
    // Sliders carry min/max/step in the existing extractor; keep optional.
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    // Combo boxes carry an enumerated values array
    values: z.array(z.string()).optional(),
});

/** GPU texture descriptor used by GLSL/WGSL shader info objects */
export const GpuTextureSchema = z.object({
    name: z.string(),
    samplerName: z.string().optional(),
    width: z.number(),
    height: z.number().optional(),
    channel: z.number().optional(),
    dimensions: z.number().optional(),
    data: z.union([z.array(z.number()), z.instanceof(Float32Array)]),
});

/** GPU 3D texture descriptor */
export const GpuTexture3DSchema = z.object({
    name: z.string(),
    samplerName: z.string().optional(),
    width: z.number(),
    height: z.number(),
    depth: z.number(),
    channel: z.number().optional(),
    data: z.union([z.array(z.number()), z.instanceof(Float32Array)]),
});

/** WGSL binding descriptor */
export const TextureBindingSchema = z.object({
    binding: z.number(),
    type: z.string(),
    name: z.string(),
    originalName: z.string().optional(),
});

/** GLSL shader info delivered alongside loadImage and updateShader */
export const GlslShaderInfoSchema = z.object({
    shaderText: z.string(),
    textures: z.array(GpuTextureSchema),
    textures3D: z.array(GpuTexture3DSchema),
    uniforms: z.array(
        z.object({
            name: z.string(),
            type: z.number(),
        })
    ).optional(),
});

/** DCTL parameter mapping carried inside the WGSL compute shader info */
export const DctlParamMappingSchema = z.object({
    name: z.string(),
    glslName: z.string().optional(),
    type: z.string(),
    index: z.number(),
    default: DctlParamValueSchema,
});

/** DCTL compute shader bundle (only present when DCTL is active) */
export const DctlComputeShaderInfoSchema = z.object({
    computeWgsl: z.string(),
    dctlFunctionWgsl: z.string().optional(),
    ocioFunctionWgsl: z.string().optional(),
    rgcFunctionWgsl: z.string().optional(),
    paramMapping: z.array(DctlParamMappingSchema),
    uniformBufferBinding: z.number(),
    textures: z.array(GpuTextureSchema),
    textures3D: z.array(GpuTexture3DSchema),
    rgcTextures: z.array(GpuTextureSchema).optional(),
    rgcTextures3D: z.array(GpuTexture3DSchema).optional(),
    bindings: z.array(TextureBindingSchema),
    rgcBindings: z.array(TextureBindingSchema).optional(),
    hasDctl: z.boolean(),
    hasFullRgc: z.boolean().optional(),
    success: z.boolean(),
    error: z.string().optional(),
});

/** WGSL shader info delivered alongside loadImage and updateShader */
export const WgslShaderInfoSchema = z.object({
    wgslCode: z.string(),
    computeWgslCode: z.string().optional(),
    textures: z.array(GpuTextureSchema),
    textures3D: z.array(GpuTexture3DSchema),
    bindings: z.array(TextureBindingSchema).optional(),
    dctlBindings: z.array(TextureBindingSchema).optional(),
    dctlDefaults: z.array(DctlParamMappingSchema).optional(),
    paramMapping: z.array(DctlParamMappingSchema).optional(),
    useUniformBuffer: z.boolean().optional(),
    uniformBufferBinding: z.number().optional(),
    dctlComputeShaderInfo: DctlComputeShaderInfoSchema.optional(),
    rgcTextures: z.array(GpuTextureSchema).optional(),
    rgcTextures3D: z.array(GpuTexture3DSchema).optional(),
});

// =============================================================================
// Extension → Webview messages
// =============================================================================

/** `'startLoading'` — sent before EXR decode begins */
export const StartLoadingSchema = z.object({
    type: z.literal('startLoading'),
});

/** `'loadImage'` — sent after EXR decode + OCIO setup */
export const LoadImageSchema = z.object({
    type: z.literal('loadImage'),
    data: z.object({
        width: z.number(),
        height: z.number(),
        channels: z.number(),
        buffer: z.instanceof(ArrayBuffer),
        byteOffset: z.number(),
        byteLength: z.number(),
        colorSpace: z.string(),
        colorSpaceDetected: z.boolean(),
        compression: z.string().optional(),
        bitDepth: z.string().optional(),
        colorSpaces: z.array(z.string()),
        displays: z.array(z.string()),
        defaultDisplay: z.string(),
        defaultView: z.string(),
        displayViewMap: z.record(z.string(), z.array(z.string())),
        shaderInfo: GlslShaderInfoSchema,
        wgslShaderInfo: WgslShaderInfoSchema.nullable(),
    }),
});

/** `'updateShader'` — sent after OCIO display change or DCTL rebuild */
export const UpdateShaderSchema = z.object({
    type: z.literal('updateShader'),
    shaderInfo: GlslShaderInfoSchema,
    wgslShaderInfo: WgslShaderInfoSchema.nullable(),
});

/** `'loadDctl'` — sent after a DCTL file has been loaded and parsed */
export const LoadDctlSchema = z.object({
    type: z.literal('loadDctl'),
    dctl: z.object({
        filePath: z.string(),
        params: z.array(DctlParamSchema),
        enabled: z.boolean(),
        workingColorSpace: DctlColorSpaceSchema,
    }),
});

/**
 * `'unloadDctl'` — clears any active DCTL.
 *
 * Note: as of 2026-04-10 this message type has a handler in the webview
 * but no sender in the host extension. The schema is defined so that the
 * contract is documented; sending the message from the host is tracked as
 * a follow-up cleanup task.
 */
export const UnloadDctlSchema = z.object({
    type: z.literal('unloadDctl'),
});

/** `'openDctlFiles'` — list of DCTL files currently open in the editor */
export const OpenDctlFilesSchema = z.object({
    type: z.literal('openDctlFiles'),
    files: z.array(
        z.object({
            path: z.string(),
            name: z.string(),
        })
    ),
});

/** `'buildExportShader'` — request the webview to build an export-only shader */
export const BuildExportShaderSchema = z.object({
    type: z.literal('buildExportShader'),
    wgslShaderInfo: z.object({
        wgslCode: z.string(),
        textures: z.array(GpuTextureSchema),
        textures3D: z.array(GpuTexture3DSchema),
        bindings: z.array(TextureBindingSchema).optional(),
        rgcTextures: z.array(GpuTextureSchema).optional(),
        rgcTextures3D: z.array(GpuTexture3DSchema).optional(),
    }),
    requestBuffer: z.boolean().optional(),
    requestId: z.string().optional(),
});

/** `'exportToBuffer'` — request the webview to render and read back pixels */
export const ExportToBufferSchema = z.object({
    type: z.literal('exportToBuffer'),
    requestId: z.string(),
});

/** `'error'` — generic error notification (host → webview UI) */
export const ErrorMessageSchema = z.object({
    type: z.literal('error'),
    message: z.string(),
});

/** `'updateDctlParamFast'` — fast path: update a uniform without rebuilding */
export const UpdateDctlParamFastSchema = z.object({
    type: z.literal('updateDctlParamFast'),
    name: z.string(),
    value: DctlParamValueSchema,
});

/** Discriminated union of all extension → webview messages */
export const ExtensionToWebviewMessageSchema = z.discriminatedUnion('type', [
    StartLoadingSchema,
    LoadImageSchema,
    UpdateShaderSchema,
    LoadDctlSchema,
    UnloadDctlSchema,
    OpenDctlFilesSchema,
    BuildExportShaderSchema,
    ExportToBufferSchema,
    ErrorMessageSchema,
    UpdateDctlParamFastSchema,
]);

// =============================================================================
// Webview → Extension messages
// =============================================================================

/** `'ready'` — sent once when the webview finishes initializing */
export const ReadySchema = z.object({
    type: z.literal('ready'),
});

/** `'setDisplayTransform'` — OCIO source/display/view selection */
export const SetDisplayTransformSchema = z.object({
    type: z.literal('setDisplayTransform'),
    source: z.string(),
    display: z.string(),
    view: z.string(),
});

/** `'selectDctlFile'` — open the DCTL file picker */
export const SelectDctlFileSchema = z.object({
    type: z.literal('selectDctlFile'),
});

/** `'loadDctlFromPath'` — load a DCTL file by path */
export const LoadDctlFromPathSchema = z.object({
    type: z.literal('loadDctlFromPath'),
    path: z.string(),
});

/** `'toggleDctl'` — enable/disable the loaded DCTL */
export const ToggleDctlSchema = z.object({
    type: z.literal('toggleDctl'),
    enabled: z.boolean(),
});

/** `'toggleRgc'` — enable/disable ACES 2.0 reference gamut compression */
export const ToggleRgcSchema = z.object({
    type: z.literal('toggleRgc'),
    enabled: z.boolean(),
    peakLuminance: z.number(),
});

/** `'updateRgcSettings'` — change RGC peak luminance without toggling */
export const UpdateRgcSettingsSchema = z.object({
    type: z.literal('updateRgcSettings'),
    peakLuminance: z.number(),
});

/** `'changeDctlColorSpace'` — change the DCTL working color space */
export const ChangeDctlColorSpaceSchema = z.object({
    type: z.literal('changeDctlColorSpace'),
    colorSpace: DctlColorSpaceSchema,
});

/** `'updateDctlParam'` — slider/checkbox/color update from the parameter UI */
export const UpdateDctlParamSchema = z.object({
    type: z.literal('updateDctlParam'),
    name: z.string(),
    value: DctlParamValueSchema,
});

/** `'log'` — relay a webview-side console message back to the extension log */
export const LogMessageSchema = z.object({
    type: z.literal('log'),
    message: z.string(),
});

/**
 * `'exportBufferReady'` — webview reports the result of an export render.
 *
 * The payload has two shapes:
 *   - success: { requestId, success: true, width, height, buffer }
 *   - failure: { requestId, success: false, error }
 *
 * Both shapes share the same `type` literal, so we cannot model them
 * as two members of a discriminated union (zod 4 forbids duplicate
 * discriminator values). Instead we model them as two object schemas
 * narrowed by the inner `success: true | false` literal, plus a
 * `z.union` for "either variant".
 */
export const ExportBufferReadySuccessSchema = z.object({
    type: z.literal('exportBufferReady'),
    requestId: z.string(),
    success: z.literal(true),
    width: z.number(),
    height: z.number(),
    buffer: z.instanceof(ArrayBuffer),
});

export const ExportBufferReadyFailureSchema = z.object({
    type: z.literal('exportBufferReady'),
    requestId: z.string(),
    success: z.literal(false),
    error: z.string(),
});

export const ExportBufferReadySchema = z.union([
    ExportBufferReadySuccessSchema,
    ExportBufferReadyFailureSchema,
]);

/** `'exportExr'` — user clicked the export button */
export const ExportExrSchema = z.object({
    type: z.literal('exportExr'),
});

/** `'shaderBuildResult'` — webview reports shader build outcome */
export const ShaderBuildResultSchema = z.object({
    type: z.literal('shaderBuildResult'),
    hasDctlSupport: z.boolean(),
    error: z.string().optional(),
});

/** `'rgcPixelVerification'` — debug pixel readback for RGC verification */
export const RgcPixelVerificationSchema = z.object({
    type: z.literal('rgcPixelVerification'),
    isBlack: z.boolean(),
    pixels: z.array(z.number()),
    hasFullRgc: z.boolean(),
});

/**
 * Union of all webview → extension messages.
 *
 * We use a plain `z.union` rather than `z.discriminatedUnion` so we can
 * include both success and failure variants of `exportBufferReady`,
 * which share the same `type` literal. The two shapes are themselves
 * narrowed by the inner `success: true | false` literal.
 */
export const WebviewToExtensionMessageSchema = z.union([
    ReadySchema,
    SetDisplayTransformSchema,
    SelectDctlFileSchema,
    LoadDctlFromPathSchema,
    ToggleDctlSchema,
    ToggleRgcSchema,
    UpdateRgcSettingsSchema,
    ChangeDctlColorSpaceSchema,
    UpdateDctlParamSchema,
    LogMessageSchema,
    ExportBufferReadySuccessSchema,
    ExportBufferReadyFailureSchema,
    ExportExrSchema,
    ShaderBuildResultSchema,
    RgcPixelVerificationSchema,
]);

// =============================================================================
// Inferred TypeScript types (handy for tests and future use)
// =============================================================================

export type ExtensionToWebviewMessage = z.infer<typeof ExtensionToWebviewMessageSchema>;
export type WebviewToExtensionMessage = z.infer<typeof WebviewToExtensionMessageSchema>;
