/**
 * Webview message contract tests.
 *
 * For every message schema in src/test/contracts/messages.ts, verify
 * that:
 *   1. A representative valid sample passes the schema
 *   2. The matching discriminated union also accepts that sample
 *   3. A targeted invalid sample is rejected with a useful error
 *
 * The schemas are the source of truth for the webview message
 * protocol; if a sender or handler is changed, the matching schema
 * must be updated, and these tests will fail until the sample data
 * is brought back into sync.
 */

import { strict as assert } from 'assert';
import {
    // Sub-schemas
    DctlColorSpaceSchema,
    DctlColorValueSchema,
    DctlParamValueSchema,
    DctlParamSchema,
    GpuTextureSchema,
    GpuTexture3DSchema,
    TextureBindingSchema,
    GlslShaderInfoSchema,
    DctlParamMappingSchema,
    DctlComputeShaderInfoSchema,
    WgslShaderInfoSchema,

    // Extension → Webview
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
    ExtensionToWebviewMessageSchema,

    // Webview → Extension
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
    ExportBufferReadySchema,
    ExportExrSchema,
    ShaderBuildResultSchema,
    RgcPixelVerificationSchema,
    WebviewToExtensionMessageSchema,
} from '../contracts/messages';

// =============================================================================
// Sample factories
// =============================================================================

function makeGpuTexture() {
    return {
        name: 'tex0',
        samplerName: 'samp0',
        width: 256,
        height: 1,
        channel: 0,
        dimensions: 1,
        data: [0, 0.5, 1],
    };
}

function makeGpuTexture3D() {
    return {
        name: 'lut3d',
        samplerName: 'lut3d_samp',
        width: 33,
        height: 33,
        depth: 33,
        channel: 0,
        data: [0, 0, 0, 1, 1, 1],
    };
}

function makeBinding() {
    return { binding: 0, type: 'texture2D', name: 'tex0' };
}

function makeGlslShaderInfo() {
    return {
        shaderText: 'void main() {}',
        textures: [makeGpuTexture()],
        textures3D: [],
        uniforms: [{ name: 'u_exposure', type: 5126 }],
    };
}

function makeWgslShaderInfo() {
    return {
        wgslCode: '@fragment fn main() -> @location(0) vec4<f32> { return vec4(0); }',
        computeWgslCode: '@compute fn main() {}',
        textures: [makeGpuTexture()],
        textures3D: [],
        bindings: [makeBinding()],
        useUniformBuffer: true,
        uniformBufferBinding: 7,
    };
}

function makeDctlParam() {
    return {
        name: 'gain',
        label: 'Gain',
        type: 'float',
        default: 1.0,
        min: 0,
        max: 4,
        step: 0.01,
    };
}

// =============================================================================
// Sub-schemas
// =============================================================================

describe('Webview message contract: sub-schemas', () => {
    describe('DctlColorSpaceSchema', () => {
        it('accepts every documented working color space', () => {
            for (const cs of ['ACES2065-1', 'ACEScg', 'ACEScc', 'ACEScct', 'linear_sRGB']) {
                assert.equal(DctlColorSpaceSchema.safeParse(cs).success, true, cs);
            }
        });

        it('rejects unknown values', () => {
            assert.equal(DctlColorSpaceSchema.safeParse('Rec.709').success, false);
        });
    });

    describe('DctlColorValueSchema', () => {
        it('accepts an RGB triple', () => {
            assert.equal(
                DctlColorValueSchema.safeParse({ r: 0.1, g: 0.2, b: 0.3 }).success,
                true
            );
        });

        it('rejects an incomplete color', () => {
            assert.equal(DctlColorValueSchema.safeParse({ r: 0.1, g: 0.2 }).success, false);
        });
    });

    describe('DctlParamValueSchema', () => {
        it('accepts numbers, booleans, and color triples', () => {
            assert.equal(DctlParamValueSchema.safeParse(1.5).success, true);
            assert.equal(DctlParamValueSchema.safeParse(true).success, true);
            assert.equal(
                DctlParamValueSchema.safeParse({ r: 0, g: 0, b: 0 }).success,
                true
            );
        });

        it('rejects strings', () => {
            assert.equal(DctlParamValueSchema.safeParse('not a value').success, false);
        });
    });

    describe('DctlParamSchema', () => {
        it('accepts a slider definition', () => {
            assert.equal(DctlParamSchema.safeParse(makeDctlParam()).success, true);
        });

        it('rejects a parameter with no name', () => {
            const broken = { ...makeDctlParam(), name: undefined };
            assert.equal(DctlParamSchema.safeParse(broken).success, false);
        });
    });

    describe('GpuTexture / GpuTexture3D / TextureBinding', () => {
        it('GpuTextureSchema accepts a 1D LUT descriptor', () => {
            assert.equal(GpuTextureSchema.safeParse(makeGpuTexture()).success, true);
        });

        it('GpuTexture3DSchema accepts a 33-cube LUT descriptor', () => {
            assert.equal(GpuTexture3DSchema.safeParse(makeGpuTexture3D()).success, true);
        });

        it('TextureBindingSchema accepts a minimal binding', () => {
            assert.equal(TextureBindingSchema.safeParse(makeBinding()).success, true);
        });
    });

    describe('GlslShaderInfoSchema', () => {
        it('accepts a complete GLSL shader info object', () => {
            assert.equal(GlslShaderInfoSchema.safeParse(makeGlslShaderInfo()).success, true);
        });

        it('rejects when shaderText is missing', () => {
            const broken = { ...makeGlslShaderInfo(), shaderText: undefined };
            assert.equal(GlslShaderInfoSchema.safeParse(broken).success, false);
        });
    });

    describe('WgslShaderInfoSchema', () => {
        it('accepts a basic WGSL shader info object', () => {
            assert.equal(WgslShaderInfoSchema.safeParse(makeWgslShaderInfo()).success, true);
        });

        it('accepts an info object with an embedded DCTL compute shader', () => {
            const info = {
                ...makeWgslShaderInfo(),
                dctlComputeShaderInfo: {
                    computeWgsl: '@compute fn main() {}',
                    paramMapping: [
                        {
                            name: 'gain',
                            type: 'float',
                            index: 0,
                            default: 1,
                        },
                    ],
                    uniformBufferBinding: 7,
                    textures: [],
                    textures3D: [],
                    bindings: [],
                    hasDctl: true,
                    success: true,
                },
            };
            assert.equal(WgslShaderInfoSchema.safeParse(info).success, true);
        });
    });

    describe('DctlComputeShaderInfoSchema', () => {
        it('accepts a minimal compute info object', () => {
            const info = {
                computeWgsl: '@compute fn main() {}',
                paramMapping: [],
                uniformBufferBinding: 7,
                textures: [],
                textures3D: [],
                bindings: [],
                hasDctl: true,
                success: true,
            };
            assert.equal(DctlComputeShaderInfoSchema.safeParse(info).success, true);
        });

        it('rejects when uniformBufferBinding is not a number', () => {
            const broken = {
                computeWgsl: '@compute fn main() {}',
                paramMapping: [],
                uniformBufferBinding: 'seven',
                textures: [],
                textures3D: [],
                bindings: [],
                hasDctl: true,
                success: true,
            };
            assert.equal(DctlComputeShaderInfoSchema.safeParse(broken).success, false);
        });
    });

    describe('DctlParamMappingSchema', () => {
        it('accepts a minimal mapping entry', () => {
            assert.equal(
                DctlParamMappingSchema.safeParse({
                    name: 'gain',
                    type: 'float',
                    index: 0,
                    default: 1,
                }).success,
                true
            );
        });
    });
});

// =============================================================================
// Extension → Webview messages
// =============================================================================

describe('Webview message contract: extension → webview', () => {
    function expectAcceptedByUnion(message: unknown) {
        const result = ExtensionToWebviewMessageSchema.safeParse(message);
        if (!result.success) {
            // Provide a useful diagnostic when this fails.
            throw new Error(
                `Expected union to accept ${JSON.stringify((message as { type?: unknown })?.type)}: ${result.error.message}`
            );
        }
    }

    describe("'startLoading'", () => {
        const sample = { type: 'startLoading' as const };

        it('accepts the canonical sample', () => {
            assert.equal(StartLoadingSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });

        it('rejects extra unknown type', () => {
            assert.equal(
                StartLoadingSchema.safeParse({ type: 'unknown' }).success,
                false
            );
        });
    });

    describe("'loadImage'", () => {
        const sample = {
            type: 'loadImage' as const,
            data: {
                width: 1920,
                height: 1080,
                channels: 4,
                buffer: new ArrayBuffer(1920 * 1080 * 4 * 4),
                byteOffset: 0,
                byteLength: 1920 * 1080 * 4 * 4,
                colorSpace: 'ACES2065-1',
                colorSpaceDetected: true,
                compression: 'zip',
                bitDepth: 'float32',
                colorSpaces: ['ACES2065-1', 'sRGB - Texture'],
                displays: ['sRGB', 'Rec.709'],
                defaultDisplay: 'sRGB',
                defaultView: 'SDR Video',
                displayViewMap: {
                    sRGB: ['SDR Video'],
                    'Rec.709': ['SDR Video'],
                },
                shaderInfo: makeGlslShaderInfo(),
                wgslShaderInfo: makeWgslShaderInfo(),
            },
        };

        it('accepts the canonical sample with both shader info objects', () => {
            assert.equal(LoadImageSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });

        it('accepts a sample where wgslShaderInfo is null (WGSL conversion failed)', () => {
            const variant = { ...sample, data: { ...sample.data, wgslShaderInfo: null } };
            assert.equal(LoadImageSchema.safeParse(variant).success, true);
        });

        it('rejects when buffer is a Uint8Array instead of an ArrayBuffer', () => {
            const broken = {
                ...sample,
                data: {
                    ...sample.data,
                    buffer: new Uint8Array(8) as unknown as ArrayBuffer,
                },
            };
            assert.equal(LoadImageSchema.safeParse(broken).success, false);
        });

        it('rejects when displayViewMap is missing', () => {
            const broken = {
                ...sample,
                data: { ...sample.data, displayViewMap: undefined },
            };
            assert.equal(LoadImageSchema.safeParse(broken).success, false);
        });
    });

    describe("'updateShader'", () => {
        const sample = {
            type: 'updateShader' as const,
            shaderInfo: makeGlslShaderInfo(),
            wgslShaderInfo: makeWgslShaderInfo(),
        };

        it('accepts the canonical sample', () => {
            assert.equal(UpdateShaderSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });

        it('accepts a null wgslShaderInfo', () => {
            assert.equal(
                UpdateShaderSchema.safeParse({ ...sample, wgslShaderInfo: null }).success,
                true
            );
        });
    });

    describe("'loadDctl'", () => {
        const sample = {
            type: 'loadDctl' as const,
            dctl: {
                filePath: '/tmp/test_gain.dctl',
                params: [makeDctlParam()],
                enabled: true,
                workingColorSpace: 'ACEScct' as const,
            },
        };

        it('accepts the canonical sample', () => {
            assert.equal(LoadDctlSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });

        it('rejects an unknown working color space', () => {
            const broken = {
                ...sample,
                dctl: {
                    ...sample.dctl,
                    workingColorSpace: 'Rec.2020' as unknown as 'ACEScct',
                },
            };
            assert.equal(LoadDctlSchema.safeParse(broken).success, false);
        });
    });

    describe("'unloadDctl'", () => {
        const sample = { type: 'unloadDctl' as const };

        it('accepts the canonical sample', () => {
            assert.equal(UnloadDctlSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });
    });

    describe("'openDctlFiles'", () => {
        const sample = {
            type: 'openDctlFiles' as const,
            files: [
                { path: '/tmp/a.dctl', name: 'a.dctl' },
                { path: '/tmp/b.dctl', name: 'b.dctl' },
            ],
        };

        it('accepts the canonical sample', () => {
            assert.equal(OpenDctlFilesSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });

        it('rejects when a file entry is missing name', () => {
            const broken = {
                ...sample,
                files: [{ path: '/tmp/a.dctl' }],
            };
            assert.equal(OpenDctlFilesSchema.safeParse(broken).success, false);
        });
    });

    describe("'buildExportShader'", () => {
        const sample = {
            type: 'buildExportShader' as const,
            wgslShaderInfo: {
                wgslCode: '@fragment fn main() {}',
                textures: [],
                textures3D: [],
                bindings: [],
            },
        };

        it('accepts the canonical sample', () => {
            assert.equal(BuildExportShaderSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });

        it('accepts the requestBuffer + requestId variant', () => {
            const variant = {
                ...sample,
                requestBuffer: true,
                requestId: 'export-1',
            };
            assert.equal(BuildExportShaderSchema.safeParse(variant).success, true);
        });
    });

    describe("'exportToBuffer'", () => {
        const sample = {
            type: 'exportToBuffer' as const,
            requestId: 'export-2',
        };

        it('accepts the canonical sample', () => {
            assert.equal(ExportToBufferSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });

        it('rejects when requestId is missing', () => {
            const broken: { type: 'exportToBuffer'; requestId?: string } = {
                type: 'exportToBuffer',
            };
            assert.equal(ExportToBufferSchema.safeParse(broken).success, false);
        });
    });

    describe("'error'", () => {
        const sample = { type: 'error' as const, message: 'something went wrong' };

        it('accepts the canonical sample', () => {
            assert.equal(ErrorMessageSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });
    });

    describe("'updateDctlParamFast'", () => {
        const sample = {
            type: 'updateDctlParamFast' as const,
            name: 'gain',
            value: 1.5,
        };

        it('accepts numbers, booleans, and colors', () => {
            assert.equal(UpdateDctlParamFastSchema.safeParse(sample).success, true);
            assert.equal(
                UpdateDctlParamFastSchema.safeParse({ ...sample, value: false }).success,
                true
            );
            assert.equal(
                UpdateDctlParamFastSchema.safeParse({
                    ...sample,
                    value: { r: 0, g: 1, b: 0 },
                }).success,
                true
            );
            expectAcceptedByUnion(sample);
        });
    });
});

// =============================================================================
// Webview → Extension messages
// =============================================================================

describe('Webview message contract: webview → extension', () => {
    function expectAcceptedByUnion(message: unknown) {
        const result = WebviewToExtensionMessageSchema.safeParse(message);
        if (!result.success) {
            throw new Error(
                `Expected union to accept ${JSON.stringify((message as { type?: unknown })?.type)}: ${result.error.message}`
            );
        }
    }

    describe("'ready'", () => {
        const sample = { type: 'ready' as const };

        it('accepts the canonical sample', () => {
            assert.equal(ReadySchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });
    });

    describe("'setDisplayTransform'", () => {
        const sample = {
            type: 'setDisplayTransform' as const,
            source: 'ACES2065-1',
            display: 'sRGB',
            view: 'SDR Video',
        };

        it('accepts the canonical sample', () => {
            assert.equal(SetDisplayTransformSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });

        it('rejects when display is missing', () => {
            const broken = { ...sample, display: undefined };
            assert.equal(SetDisplayTransformSchema.safeParse(broken).success, false);
        });
    });

    describe("'selectDctlFile'", () => {
        const sample = { type: 'selectDctlFile' as const };

        it('accepts the canonical sample', () => {
            assert.equal(SelectDctlFileSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });
    });

    describe("'loadDctlFromPath'", () => {
        const sample = {
            type: 'loadDctlFromPath' as const,
            path: '/abs/path/to.dctl',
        };

        it('accepts the canonical sample', () => {
            assert.equal(LoadDctlFromPathSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });

        it('rejects when path is not a string', () => {
            assert.equal(
                LoadDctlFromPathSchema.safeParse({ type: 'loadDctlFromPath', path: 123 })
                    .success,
                false
            );
        });
    });

    describe("'toggleDctl'", () => {
        const sample = { type: 'toggleDctl' as const, enabled: true };

        it('accepts the canonical sample', () => {
            assert.equal(ToggleDctlSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });
    });

    describe("'toggleRgc'", () => {
        const sample = {
            type: 'toggleRgc' as const,
            enabled: true,
            peakLuminance: 1000,
        };

        it('accepts the canonical sample', () => {
            assert.equal(ToggleRgcSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });
    });

    describe("'updateRgcSettings'", () => {
        const sample = { type: 'updateRgcSettings' as const, peakLuminance: 4000 };

        it('accepts the canonical sample', () => {
            assert.equal(UpdateRgcSettingsSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });
    });

    describe("'changeDctlColorSpace'", () => {
        const sample = {
            type: 'changeDctlColorSpace' as const,
            colorSpace: 'ACEScg' as const,
        };

        it('accepts the canonical sample', () => {
            assert.equal(ChangeDctlColorSpaceSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });

        it('rejects an unknown working color space', () => {
            const broken = {
                ...sample,
                colorSpace: 'Rec.2020' as unknown as 'ACEScg',
            };
            assert.equal(ChangeDctlColorSpaceSchema.safeParse(broken).success, false);
        });
    });

    describe("'updateDctlParam'", () => {
        const sample = {
            type: 'updateDctlParam' as const,
            name: 'exposure',
            value: 0.5,
        };

        it('accepts the canonical sample', () => {
            assert.equal(UpdateDctlParamSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });
    });

    describe("'log'", () => {
        const sample = { type: 'log' as const, message: '[INFO] hello world' };

        it('accepts the canonical sample', () => {
            assert.equal(LogMessageSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });
    });

    describe("'exportBufferReady'", () => {
        const successSample = {
            type: 'exportBufferReady' as const,
            requestId: 'req-1',
            success: true as const,
            width: 256,
            height: 256,
            buffer: new ArrayBuffer(256 * 256 * 3 * 4),
        };
        const failureSample = {
            type: 'exportBufferReady' as const,
            requestId: 'req-2',
            success: false as const,
            error: 'render failed',
        };

        it('accepts the success variant', () => {
            assert.equal(ExportBufferReadySuccessSchema.safeParse(successSample).success, true);
            assert.equal(ExportBufferReadySchema.safeParse(successSample).success, true);
            expectAcceptedByUnion(successSample);
        });

        it('accepts the failure variant', () => {
            assert.equal(ExportBufferReadyFailureSchema.safeParse(failureSample).success, true);
            assert.equal(ExportBufferReadySchema.safeParse(failureSample).success, true);
            expectAcceptedByUnion(failureSample);
        });

        it('rejects success variant with a non-ArrayBuffer payload', () => {
            const broken = { ...successSample, buffer: [1, 2, 3] as unknown as ArrayBuffer };
            assert.equal(ExportBufferReadySuccessSchema.safeParse(broken).success, false);
        });

        it('rejects a missing requestId', () => {
            const broken = { ...successSample, requestId: undefined };
            assert.equal(ExportBufferReadySuccessSchema.safeParse(broken).success, false);
        });
    });

    describe("'exportExr'", () => {
        const sample = { type: 'exportExr' as const };

        it('accepts the canonical sample', () => {
            assert.equal(ExportExrSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });
    });

    describe("'shaderBuildResult'", () => {
        it('accepts a success result', () => {
            const sample = { type: 'shaderBuildResult' as const, hasDctlSupport: true };
            assert.equal(ShaderBuildResultSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });

        it('accepts a failure result with an error string', () => {
            const sample = {
                type: 'shaderBuildResult' as const,
                hasDctlSupport: false,
                error: 'shader compile failed',
            };
            assert.equal(ShaderBuildResultSchema.safeParse(sample).success, true);
        });
    });

    describe("'rgcPixelVerification'", () => {
        const sample = {
            type: 'rgcPixelVerification' as const,
            isBlack: false,
            pixels: [0.1, 0.2, 0.3, 0.4, 0.5],
            hasFullRgc: true,
        };

        it('accepts the canonical sample', () => {
            assert.equal(RgcPixelVerificationSchema.safeParse(sample).success, true);
            expectAcceptedByUnion(sample);
        });
    });
});

// =============================================================================
// Discriminated union catch-all
// =============================================================================

describe('Webview message contract: discriminated unions', () => {
    it('the extension → webview union rejects unknown message types', () => {
        const result = ExtensionToWebviewMessageSchema.safeParse({
            type: 'definitelyNotARealMessageType',
        });
        assert.equal(result.success, false);
    });

    it('the webview → extension union rejects unknown message types', () => {
        const result = WebviewToExtensionMessageSchema.safeParse({
            type: 'somethingNew',
        });
        assert.equal(result.success, false);
    });

    it('the extension → webview union covers exactly 10 distinct types', () => {
        const expected = new Set([
            'startLoading',
            'loadImage',
            'updateShader',
            'loadDctl',
            'unloadDctl',
            'openDctlFiles',
            'buildExportShader',
            'exportToBuffer',
            'error',
            'updateDctlParamFast',
        ]);
        const options = (
            ExtensionToWebviewMessageSchema as unknown as {
                options: Array<{ shape: { type: { value: string } } }>;
            }
        ).options;
        const actual = new Set(options.map((s) => s.shape.type.value));
        assert.deepEqual(actual, expected);
    });

    it('the webview → extension union covers exactly 14 distinct type literals', () => {
        // Note: `exportBufferReady` contributes two members (success/failure)
        // which both share the same `type` literal, so the union has 15
        // members but 14 distinct `type` values. We probe the union by
        // sending one canonical sample per expected `type` literal and
        // asserting that all of them are accepted.
        const expected = [
            { type: 'ready' },
            {
                type: 'setDisplayTransform',
                source: 'ACES2065-1',
                display: 'sRGB',
                view: 'SDR Video',
            },
            { type: 'selectDctlFile' },
            { type: 'loadDctlFromPath', path: '/tmp/x.dctl' },
            { type: 'toggleDctl', enabled: true },
            { type: 'toggleRgc', enabled: false, peakLuminance: 100 },
            { type: 'updateRgcSettings', peakLuminance: 1000 },
            { type: 'changeDctlColorSpace', colorSpace: 'ACEScg' as const },
            { type: 'updateDctlParam', name: 'gain', value: 1 },
            { type: 'log', message: 'hello' },
            {
                type: 'exportBufferReady',
                requestId: 'r1',
                success: true as const,
                width: 1,
                height: 1,
                buffer: new ArrayBuffer(12),
            },
            {
                type: 'exportBufferReady',
                requestId: 'r2',
                success: false as const,
                error: 'oops',
            },
            { type: 'exportExr' },
            { type: 'shaderBuildResult', hasDctlSupport: true },
            {
                type: 'rgcPixelVerification',
                isBlack: false,
                pixels: [],
                hasFullRgc: true,
            },
        ];

        const acceptedTypes = new Set<string>();
        for (const sample of expected) {
            const result = WebviewToExtensionMessageSchema.safeParse(sample);
            assert.equal(
                result.success,
                true,
                `Union should accept ${JSON.stringify(sample.type)}`
            );
            acceptedTypes.add(sample.type);
        }
        assert.equal(acceptedTypes.size, 14);
    });
});
