/**
 * UI Parameter Extractor Unit Tests
 */

import { strict as assert } from 'assert';
import { extractUIParams, convertToCompilerParameter } from '../../parser/uiParamExtractor';

describe('extractUIParams', () => {
    describe('Slider Float', () => {
        it('should extract DCTL_SLIDER_FLOAT with all arguments', () => {
            const source = 'DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)';
            const result = extractUIParams(source);

            assert.equal(result.params.length, 1);
            assert.equal(result.errors.length, 0);

            const param = result.params[0];
            assert.equal(param.name, 'gain');
            assert.equal(param.label, 'Gain');
            assert.equal(param.type, 'DCTL_SLIDER_FLOAT');
            if (param.type === 'DCTL_SLIDER_FLOAT') {
                assert.equal(param.default, 1.0);
                assert.equal(param.min, 0.0);
                assert.equal(param.max, 4.0);
                assert.equal(param.step, 0.01);
            }
        });

        it('should extract DCTLUI_SLIDER_FLOAT (normalized to DCTL_SLIDER_FLOAT)', () => {
            const source = 'DEFINE_UI_PARAMS(exposure, Exposure, DCTLUI_SLIDER_FLOAT, 0.0, -5.0, 5.0, 0.1)';
            const result = extractUIParams(source);

            assert.equal(result.params.length, 1);
            assert.equal(result.params[0].type, 'DCTL_SLIDER_FLOAT');
        });

        it('should handle float suffix f', () => {
            const source = 'DEFINE_UI_PARAMS(val, Value, DCTL_SLIDER_FLOAT, 1.0f, 0.0f, 2.0f, 0.1f)';
            const result = extractUIParams(source);

            assert.equal(result.params.length, 1);
            if (result.params[0].type === 'DCTL_SLIDER_FLOAT') {
                assert.equal(result.params[0].default, 1.0);
            }
        });
    });

    describe('Slider Int', () => {
        it('should extract DCTL_SLIDER_INT', () => {
            const source = 'DEFINE_UI_PARAMS(iterations, Iterations, DCTL_SLIDER_INT, 5, 1, 20, 1)';
            const result = extractUIParams(source);

            assert.equal(result.params.length, 1);
            const param = result.params[0];
            assert.equal(param.type, 'DCTL_SLIDER_INT');
            if (param.type === 'DCTL_SLIDER_INT') {
                assert.equal(param.default, 5);
                assert.equal(param.min, 1);
                assert.equal(param.max, 20);
                assert.equal(param.step, 1);
            }
        });

        it('should handle DCTL_SLIDER_INTER typo (normalized to DCTL_SLIDER_INT)', () => {
            const source = 'DEFINE_UI_PARAMS(count, Count, DCTL_SLIDER_INTER, 3, 0, 10, 1)';
            const result = extractUIParams(source);

            assert.equal(result.params.length, 1);
            assert.equal(result.params[0].type, 'DCTL_SLIDER_INT');
        });

        it('should round float values to integers', () => {
            const source = 'DEFINE_UI_PARAMS(n, N, DCTL_SLIDER_INT, 5.7, 1.2, 10.9, 1.5)';
            const result = extractUIParams(source);

            if (result.params[0].type === 'DCTL_SLIDER_INT') {
                assert.equal(result.params[0].default, 6);
                assert.equal(result.params[0].min, 1);
                assert.equal(result.params[0].max, 11);
                assert.equal(result.params[0].step, 2);
            }
        });
    });

    describe('Check Box', () => {
        it('should extract DCTL_CHECK_BOX with boolean 1', () => {
            const source = 'DEFINE_UI_PARAMS(enable, Enable, DCTL_CHECK_BOX, 1)';
            const result = extractUIParams(source);

            assert.equal(result.params.length, 1);
            const param = result.params[0];
            assert.equal(param.type, 'DCTL_CHECK_BOX');
            if (param.type === 'DCTL_CHECK_BOX') {
                assert.equal(param.default, true);
            }
        });

        it('should extract DCTL_CHECK_BOX with boolean 0', () => {
            const source = 'DEFINE_UI_PARAMS(disable, Disable, DCTL_CHECK_BOX, 0)';
            const result = extractUIParams(source);

            if (result.params[0].type === 'DCTL_CHECK_BOX') {
                assert.equal(result.params[0].default, false);
            }
        });

        it('should default to false when no value given', () => {
            const source = 'DEFINE_UI_PARAMS(flag, Flag, DCTL_CHECK_BOX)';
            const result = extractUIParams(source);

            if (result.params[0].type === 'DCTL_CHECK_BOX') {
                assert.equal(result.params[0].default, false);
            }
        });
    });

    describe('Combo Box', () => {
        it('should extract DCTL_COMBO_BOX with options', () => {
            const source = 'DEFINE_UI_PARAMS(mode, Mode, DCTL_COMBO_BOX, 0, {Linear, Cubic, Smooth})';
            const result = extractUIParams(source);

            assert.equal(result.params.length, 1);
            const param = result.params[0];
            assert.equal(param.type, 'DCTL_COMBO_BOX');
            if (param.type === 'DCTL_COMBO_BOX') {
                assert.equal(param.default, 0);
                assert.deepEqual(param.options, ['Linear', 'Cubic', 'Smooth']);
            }
        });

        it('should extract enum values from braces', () => {
            const source = 'DEFINE_UI_PARAMS(space, Color Space, DCTL_COMBO_BOX, 1, {sRGB, Rec709, ACES})';
            const result = extractUIParams(source);

            if (result.params[0].type === 'DCTL_COMBO_BOX') {
                assert.equal(result.params[0].default, 1);
                assert.deepEqual(result.params[0].options, ['sRGB', 'Rec709', 'ACES']);
            }
        });
    });

    describe('Value Box', () => {
        it('should extract DCTL_VALUE_BOX', () => {
            const source = 'DEFINE_UI_PARAMS(amount, Amount, DCTL_VALUE_BOX, 1.5)';
            const result = extractUIParams(source);

            assert.equal(result.params.length, 1);
            const param = result.params[0];
            assert.equal(param.type, 'DCTL_VALUE_BOX');
            if (param.type === 'DCTL_VALUE_BOX') {
                assert.equal(param.default, 1.5);
            }
        });

        it('should default to 0 when no value given', () => {
            const source = 'DEFINE_UI_PARAMS(val, Value, DCTL_VALUE_BOX)';
            const result = extractUIParams(source);

            if (result.params[0].type === 'DCTL_VALUE_BOX') {
                assert.equal(result.params[0].default, 0);
            }
        });
    });

    describe('Color Picker', () => {
        it('should extract DCTL_COLOR_PICKER with RGB values', () => {
            const source = 'DEFINE_UI_PARAMS(tint, Tint, DCTL_COLOR_PICKER, 1.0, 0.5, 0.25)';
            const result = extractUIParams(source);

            assert.equal(result.params.length, 1);
            const param = result.params[0];
            assert.equal(param.type, 'DCTL_COLOR_PICKER');
            if (param.type === 'DCTL_COLOR_PICKER') {
                assert.equal(param.default.r, 1.0);
                assert.equal(param.default.g, 0.5);
                assert.equal(param.default.b, 0.25);
            }
        });

        it('should default to white when no values given', () => {
            const source = 'DEFINE_UI_PARAMS(color, Color, DCTL_COLOR_PICKER)';
            const result = extractUIParams(source);

            if (result.params[0].type === 'DCTL_COLOR_PICKER') {
                assert.equal(result.params[0].default.r, 1.0);
                assert.equal(result.params[0].default.g, 1.0);
                assert.equal(result.params[0].default.b, 1.0);
            }
        });
    });

    describe('Edge Cases', () => {
        it('should ignore parameters in single-line comments', () => {
            const source = `
                // DEFINE_UI_PARAMS(commented, Commented, DCTL_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.1)
                DEFINE_UI_PARAMS(active, Active, DCTL_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.1)
            `;
            const result = extractUIParams(source);

            assert.equal(result.params.length, 1);
            assert.equal(result.params[0].name, 'active');
        });

        it('should ignore parameters in block comments', () => {
            const source = `
                /* DEFINE_UI_PARAMS(commented, Commented, DCTL_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.1) */
                DEFINE_UI_PARAMS(active, Active, DCTL_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.1)
            `;
            const result = extractUIParams(source);

            assert.equal(result.params.length, 1);
            assert.equal(result.params[0].name, 'active');
        });

        it('should handle multiple parameters', () => {
            const source = `
                DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)
                DEFINE_UI_PARAMS(enable, Enable, DCTL_CHECK_BOX, 1)
                DEFINE_UI_PARAMS(mode, Mode, DCTL_COMBO_BOX, 0, {A, B, C})
            `;
            const result = extractUIParams(source);

            assert.equal(result.params.length, 3);
            assert.equal(result.params[0].name, 'gain');
            assert.equal(result.params[1].name, 'enable');
            assert.equal(result.params[2].name, 'mode');
        });

        it('should report errors for invalid syntax', () => {
            const source = 'DEFINE_UI_PARAMS(bad, Bad, DCTL_SLIDER_FLOAT, invalid)';
            const result = extractUIParams(source);

            assert.equal(result.errors.length, 1);
            assert.ok(result.errors[0].includes('bad'));
        });

        it('should report errors for unknown param type', () => {
            const source = 'DEFINE_UI_PARAMS(unknown, Unknown, DCTL_UNKNOWN_TYPE, 1.0)';
            const result = extractUIParams(source);

            assert.equal(result.errors.length, 1);
            assert.ok(result.errors[0].includes('Unknown'));
        });
    });
});

describe('convertToCompilerParameter', () => {
    it('should convert DCTL_SLIDER_FLOAT', () => {
        const param = {
            name: 'gain',
            label: 'Gain',
            type: 'DCTL_SLIDER_FLOAT' as const,
            default: 1.0,
            min: 0.0,
            max: 4.0,
            step: 0.01,
        };

        const result = convertToCompilerParameter(param);
        assert.equal(result.name, 'gain');
        assert.equal(result.param_type.type, 'float');
        assert.equal(result.param_type.default, 1.0);
    });

    it('should convert DCTL_CHECK_BOX', () => {
        const param = {
            name: 'enable',
            label: 'Enable',
            type: 'DCTL_CHECK_BOX' as const,
            default: true,
        };

        const result = convertToCompilerParameter(param);
        assert.equal(result.param_type.type, 'bool');
        assert.equal(result.param_type.default, true);
    });

    it('should convert DCTL_COMBO_BOX', () => {
        const param = {
            name: 'mode',
            label: 'Mode',
            type: 'DCTL_COMBO_BOX' as const,
            default: 0,
            options: ['A', 'B', 'C'],
        };

        const result = convertToCompilerParameter(param);
        assert.equal(result.param_type.type, 'combo');
        assert.deepEqual(result.param_type.options, ['A', 'B', 'C']);
    });
});
