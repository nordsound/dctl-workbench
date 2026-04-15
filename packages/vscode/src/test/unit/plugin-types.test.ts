/**
 * Tests for the plugin API surface in `packages/vscode/src/plugins/types.ts`.
 *
 * - Compile-time: the test file itself acts as a type-check fixture.
 *   If `DecodedImage` accepts (or rejects) the right shapes, this file
 *   compiles. If not, the build breaks.
 *
 * - Runtime: API version constants and the compatibility helper.
 */

import { strict as assert } from 'assert';
import {
    PLUGIN_API_VERSION,
    isCompatibleApiVersion,
} from '../../plugins/types';
import type { DecodedImage } from '../../plugins/types';

// --- Compile-time fixtures (L2.1, L2.2) ---------------------------------------

// L2.1 — DecodedImage WITHOUT preTransformMatrix must compile (backwards compat).
const _withoutPreTransform: DecodedImage = {
    pixels: new Float32Array(4),
    pixelFormat: 'rgba32float',
    width: 1,
    height: 1,
    channels: 4,
    bitsPerSample: 32,
    colorSpace: 'ACES2065-1',
};

// L2.2 — DecodedImage WITH preTransformMatrix must compile (new field is opt-in).
const _withPreTransform: DecodedImage = {
    pixels: new Uint16Array(4),
    pixelFormat: 'rgba16unorm',
    width: 1,
    height: 1,
    channels: 4,
    bitsPerSample: 16,
    colorSpace: 'ACES2065-1',
    preTransformMatrix: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
    ],
};

// Touch the variables so the linter doesn't strip the fixtures.
void _withoutPreTransform;
void _withPreTransform;

// --- Runtime tests ------------------------------------------------------------

describe('plugin API: PLUGIN_API_VERSION', () => {
    // L2.3 — bumped again at T013 for the renderImage + extensionUri additions.
    // Previous history: 0.2.0 (initial), 0.3.0 (preTransformMatrix), 0.4.0 (renderImage).
    it('is bumped to 0.4.0 (DctlWorkbenchApi gained extensionUri + renderImage)', () => {
        assert.equal(PLUGIN_API_VERSION, '0.4.0');
    });

    it('matches semver MAJOR.MINOR.PATCH', () => {
        assert.match(PLUGIN_API_VERSION, /^\d+\.\d+\.\d+$/);
    });
});

describe('plugin API: isCompatibleApiVersion', () => {
    // L2.4 — older required, newer actual: compatible
    it('is forward-compatible within the same major (0.2.0 plugin runs on 0.3.0 host)', () => {
        assert.equal(isCompatibleApiVersion('0.2.0', '0.3.0'), true);
    });

    it('accepts equal versions', () => {
        assert.equal(isCompatibleApiVersion('0.3.0', '0.3.0'), true);
    });

    it('accepts a newer patch within the same minor', () => {
        assert.equal(isCompatibleApiVersion('0.3.0', '0.3.5'), true);
    });

    // L2.5 — newer required, older actual: incompatible
    it('rejects a host older than the plugin requires (0.3.0 plugin on 0.2.0 host)', () => {
        assert.equal(isCompatibleApiVersion('0.3.0', '0.2.0'), false);
    });

    it('rejects a major-version mismatch', () => {
        assert.equal(isCompatibleApiVersion('0.3.0', '1.0.0'), false);
        assert.equal(isCompatibleApiVersion('1.0.0', '0.3.0'), false);
    });
});
