/**
 * Test: Export Working Space Selection
 *
 * Verifies that buildExportShader and buildComputeShader use the correct
 * working color space. Default is ACEScct to match DaVinci Resolve behavior.
 * ACEScg (linear) can be explicitly requested when needed.
 */

import * as assert from 'assert';
import {
    buildExportShader,
    buildComputeShader,
} from '../../shader/index.js';
import type { CompileResult } from '../../types/index.js';

describe('Export Working Space Selection', () => {
    // Mock CompileResult for testing
    const mockCompileResult: CompileResult = {
        wgsl: `
var<private> gain: f32 = 1.0;

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R * gain, p_G * gain, p_B * gain);
}
`,
        diagnostics: [],
        parameters: [{
            name: 'gain',
            label: 'Gain',
            param_type: {
                type: 'float',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            },
        }],
        entry_point: 'transform',
    };

    describe('buildExportShader', () => {
        it('should use ACEScct as default working space (matching DaVinci Resolve)', () => {
            const result = buildExportShader(mockCompileResult, {
                width: 1920,
                height: 1080,
            });

            // Default matches DaVinci Resolve behavior: DCTL operates in ACEScct
            assert.ok(
                result.wgsl.includes('Working space: ACEScct'),
                'Default working space should be ACEScct'
            );

            // ACEScct encoding/decoding functions should be present
            assert.ok(
                result.wgsl.includes('dctl_lin_to_ACEScct'),
                'Should contain ACEScct encoding'
            );
            assert.ok(
                result.wgsl.includes('dctl_ACEScct_to_lin'),
                'Should contain ACEScct decoding'
            );
        });

        it('should support explicit ACEScg (linear) if requested', () => {
            const result = buildExportShader(mockCompileResult, {
                width: 1920,
                height: 1080,
                workingColorSpace: 'ACEScg',
            });

            assert.ok(
                result.wgsl.includes('Working space: ACEScg'),
                'Explicit ACEScg should be respected'
            );

            // No ACEScct encoding/decoding for linear working space
            assert.ok(
                !result.wgsl.includes('dctl_lin_to_ACEScct'),
                'Should not contain ACEScct encoding for linear working space'
            );
        });
    });

    describe('buildComputeShader', () => {
        it('should use ACEScct as default working space (matching DaVinci Resolve)', () => {
            const result = buildComputeShader(mockCompileResult, {
                width: 1920,
                height: 1080,
            });

            // Default matches DaVinci Resolve behavior
            assert.ok(
                result.wgsl.includes('Working: ACEScct'),
                'Default working space should be ACEScct'
            );

            // ACEScct encoding should be present in main processing
            assert.ok(
                result.wgsl.includes('lin_to_ACEScct_vec(rgb)'),
                'Should encode to ACEScct for default working space'
            );
        });

        it('should support explicit ACEScg (linear) if requested', () => {
            const result = buildComputeShader(mockCompileResult, {
                width: 1920,
                height: 1080,
                workingColorSpace: 'ACEScg',
            });

            assert.ok(
                result.wgsl.includes('Working: ACEScg'),
                'Explicit ACEScg should be respected'
            );

            // No ACEScct encoding for linear working space
            assert.ok(
                !result.wgsl.includes('lin_to_ACEScct_vec(rgb)'),
                'Should not encode to ACEScct for linear working space'
            );
        });
    });

    describe('Gain parameter injection', () => {
        it('should inject gain parameter value into export shader', () => {
            const result = buildExportShader(mockCompileResult, {
                width: 1920,
                height: 1080,
                paramValues: { gain: 1.05 },
            });

            // Verify parameter injection
            assert.ok(
                result.wgsl.includes('gain: f32 = 1.05f'),
                'Gain parameter should be injected with value 1.05'
            );
        });
    });
});
