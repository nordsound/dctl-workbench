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
