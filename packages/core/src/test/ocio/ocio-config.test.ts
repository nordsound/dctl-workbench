/**
 * OCIO Config Loading Tests
 *
 * Tests for both built-in and custom config file loading.
 * Custom config tests require WASM built with NODEFS support.
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { resolveFixture } from '../../test-paths';
import {
    initOCIO,
    OCIOProcessor,
    isOCIOInitialized,
    validateOcioConfig,
} from '../../ocio/index';

const WASM_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..');

/** Check if OCIO WASM files exist */
function ocioWasmAvailable(): boolean {
    const wasmFile = path.join(WASM_DIR, 'wasm', 'ocio.wasm');
    return fs.existsSync(wasmFile);
}

describe('OCIO Config Loading', function () {
    this.timeout(30000);

    before(async function () {
        if (!ocioWasmAvailable()) {
            this.skip();
            return;
        }
        await initOCIO(WASM_DIR);
    });

    describe('Built-in Config (regression)', () => {
        let processor: OCIOProcessor;

        beforeEach(() => {
            processor = new OCIOProcessor();
        });

        afterEach(() => {
            processor.dispose();
        });

        it('should initialize with default ACES config', () => {
            const result = processor.init();
            assert.equal(result, true);
        });

        it('should list color spaces after init', () => {
            processor.init();
            const spaces = processor.getColorSpaces();
            assert.ok(spaces.length > 0, 'Should have color spaces');
            assert.ok(spaces.includes('ACES2065-1'), 'Should include ACES2065-1');
        });

        it('should list displays after init', () => {
            processor.init();
            const displays = processor.getDisplays();
            assert.ok(displays.length > 0, 'Should have displays');
        });

        it('should list views for a display', () => {
            processor.init();
            const displays = processor.getDisplays();
            assert.ok(displays.length > 0);
            const views = processor.getViews(displays[0]);
            assert.ok(views.length > 0, 'Should have views');
        });

        it('should get config description', () => {
            processor.init();
            const desc = processor.getConfigDescription();
            assert.ok(desc.length > 0, 'Description should not be empty');
        });
    });

    describe('Custom Config from File', () => {
        let processor: OCIOProcessor;
        const configPath = resolveFixture('test-ocio-config', 'config.ocio');

        before(function () {
            if (!configPath) {
                this.skip();
                return;
            }
        });

        beforeEach(() => {
            processor = new OCIOProcessor();
        });

        afterEach(() => {
            processor.dispose();
        });

        it('should load config from file', function () {
            if (!configPath) return this.skip();
            const result = processor.initFromFile(configPath);
            assert.equal(result, true, `Failed to load config: ${processor.getLastError()}`);
        });

        it('should list color spaces from custom config', function () {
            if (!configPath) return this.skip();
            processor.initFromFile(configPath);
            const spaces = processor.getColorSpaces();
            assert.ok(spaces.length > 0, 'Should have color spaces');
            assert.ok(spaces.includes('linear_working'), 'Should include linear_working');
            assert.ok(spaces.includes('log_encoding'), 'Should include log_encoding');
            assert.ok(spaces.includes('raw'), 'Should include raw');
        });

        it('should list displays from custom config', function () {
            if (!configPath) return this.skip();
            processor.initFromFile(configPath);
            const displays = processor.getDisplays();
            assert.ok(displays.includes('sRGB'), 'Should include sRGB display');
        });

        it('should list views from custom config', function () {
            if (!configPath) return this.skip();
            processor.initFromFile(configPath);
            const views = processor.getViews('sRGB');
            assert.ok(views.includes('Raw'), 'Should include Raw view');
            assert.ok(views.includes('Film'), 'Should include Film view');
        });

        it('should get color space family', function () {
            if (!configPath) return this.skip();
            processor.initFromFile(configPath);
            const family = processor.getColorSpaceFamily('linear_working');
            assert.equal(family, 'Scene');
        });

        it('should detect scene-referred color spaces', function () {
            if (!configPath) return this.skip();
            processor.initFromFile(configPath);
            assert.equal(processor.isSceneReferred('linear_working'), true);
            assert.equal(processor.isSceneReferred('log_encoding'), true);
        });

        it('should create chained display transform', function () {
            if (!configPath) return this.skip();
            processor.initFromFile(configPath);
            const result = processor.createChainedDisplayTransform(
                'linear_working', 'reference', 'sRGB', 'Film'
            );
            assert.equal(result, true, `Failed: ${processor.getLastError()}`);
            assert.equal(processor.hasTransform(), true);
        });
    });

    describe('validateOcioConfig', () => {
        const validConfigPath = resolveFixture('test-ocio-config', 'config.ocio');

        it('should return valid for a well-formed config', function () {
            if (!validConfigPath) return this.skip();
            const result = validateOcioConfig(validConfigPath);
            assert.equal(result.valid, true, `Expected valid but got errors: ${result.errors.join(', ')}`);
            assert.equal(result.errors.length, 0);
        });

        it('should return config info (colorSpaces, displays, views)', function () {
            if (!validConfigPath) return this.skip();
            const result = validateOcioConfig(validConfigPath);
            assert.ok(result.colorSpaces.length > 0, 'Should have color spaces');
            assert.ok(result.displays.length > 0, 'Should have displays');
            assert.ok(result.sceneReferredSpaces.length > 0, 'Should have scene-referred spaces');
        });

        it('should fail for non-existent file', () => {
            const result = validateOcioConfig('/nonexistent/config.ocio');
            assert.equal(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('not found') || e.includes('does not exist')));
        });

        it('should fail for non-.ocio extension', function () {
            // Use package.json as a real file with wrong extension
            const packageJson = path.resolve(__dirname, '..', '..', '..', '..', '..', 'package.json');
            if (!fs.existsSync(packageJson)) return this.skip();
            const result = validateOcioConfig(packageJson);
            assert.equal(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('.ocio')));
        });

        it('should fail for config with no displays', () => {
            const yaml = `
ocio_profile_version: 2.1
environment: {}
roles:
  default: raw
displays: {}
colorspaces:
  - !<ColorSpace>
    name: raw
    isdata: true
`;
            const result = validateOcioConfig(yaml, { fromString: true });
            assert.equal(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('display')));
        });

        it('should fail for config with no scene-referred color spaces', () => {
            // All spaces under display_colorspaces are display-referred in OCIO v2
            const yaml = `
ocio_profile_version: 2.1
environment: {}
roles:
  default: display_space
displays:
  sRGB:
    - !<View> {name: Raw, colorspace: display_space}
display_colorspaces:
  - !<ColorSpace>
    name: display_space
    isdata: false
`;
            const result = validateOcioConfig(yaml, { fromString: true });
            assert.equal(result.valid, false);
            assert.ok(result.errors.some(e => e.includes('scene-referred')));
        });

        it('should warn about missing LUT files referenced in config', function () {
            if (!validConfigPath) return this.skip();
            // Create a temp config referencing a non-existent LUT
            const tmpDir = path.join(require('os').tmpdir(), 'dctl-test-ocio-validate');
            fs.mkdirSync(tmpDir, { recursive: true });
            const tmpConfig = path.join(tmpDir, 'bad_lut.ocio');
            fs.writeFileSync(tmpConfig, `
ocio_profile_version: 2.1
environment: {}
search_path: luts
roles:
  default: raw
  scene_linear: working
displays:
  sRGB:
    - !<View> {name: Raw, colorspace: raw}
    - !<View> {name: Film, colorspace: film}
colorspaces:
  - !<ColorSpace>
    name: raw
    isdata: true
  - !<ColorSpace>
    name: working
    family: Scene
    isdata: false
    to_scene_reference: !<MatrixTransform> {matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]}
  - !<ColorSpace>
    name: film
    family: Display
    isdata: false
    from_scene_reference: !<FileTransform> {src: nonexistent_lut.cube, interpolation: linear}
`);
            try {
                const result = validateOcioConfig(tmpConfig);
                assert.ok(result.warnings.length > 0, 'Should have warnings about missing LUTs');
                assert.ok(result.warnings.some(w => w.includes('nonexistent_lut.cube')));
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });

    describe('Config from String', () => {
        let processor: OCIOProcessor;

        beforeEach(() => {
            processor = new OCIOProcessor();
        });

        afterEach(() => {
            processor.dispose();
        });

        it('should load config from YAML string', () => {
            const yaml = `
ocio_profile_version: 2.1
environment: {}
roles:
  default: raw
displays:
  sRGB:
    - !<View> {name: Raw, colorspace: raw}
colorspaces:
  - !<ColorSpace>
    name: raw
    isdata: true
`;
            const result = processor.initFromString(yaml);
            assert.equal(result, true, `Failed: ${processor.getLastError()}`);
            const spaces = processor.getColorSpaces();
            assert.ok(spaces.includes('raw'), 'Should include raw');
        });

        it('should reject invalid YAML', () => {
            const result = processor.initFromString('not valid ocio yaml');
            assert.equal(result, false);
        });
    });
});
