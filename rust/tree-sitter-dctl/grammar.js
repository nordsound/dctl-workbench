/**
 * @file DCTL grammar for tree-sitter
 *
 * Extends tree-sitter-cuda to support DaVinci Color Transform Language (DCTL).
 * DCTL is based on CUDA/OpenCL/Metal and shares many constructs with CUDA.
 *
 * @author DCTL Workbench
 * @license MIT
 */

const CUDA = require("tree-sitter-cuda/grammar");

module.exports = grammar(CUDA, {
    name: 'dctl',

    // Extend extras to include non-breaking space (NBSP, U+00A0)
    // Some DCTL files contain NBSP characters that should be treated as whitespace
    extras: ($, original) => original.concat([
        /\u00A0/,  // Non-breaking space
    ]),

    conflicts: ($, original) => original.concat([
        [$._declaration_modifiers, $.type_qualifier],
    ]),

    rules: {
        // Extend top level items with DCTL macro calls
        _top_level_item: ($, original) => choice(
            $.dctl_macro,
            $.dctl_macro_statement,
            original
        ),

        // Extend block items to allow DCTL macros inside #if/#ifdef blocks
        _block_item: ($, original) => choice(
            $.dctl_macro,
            $.dctl_macro_statement,
            original
        ),

        // DCTL macro calls with arguments like DEFINE_UI_PARAMS, DEFINE_LUT, etc.
        // These macros can have arguments with spaces (labels) so we capture the whole thing
        // Use high precedence to match before other rules
        dctl_macro: $ => prec.right(100, seq(
            field('name', alias($.dctl_macro_identifier, $.identifier)),
            '(',
            optional(field('arguments', $.dctl_macro_arguments)),
            ')',
            optional(';')
        )),

        // DCTL macro statements without arguments (just the macro name on a line)
        dctl_macro_statement: $ => prec.right(100, seq(
            field('name', alias($.dctl_macro_statement_identifier, $.identifier)),
            optional(';')
        )),

        // DCTL macro identifiers with arguments
        dctl_macro_identifier: _ => token(prec(100, choice(
            'DEFINE_UI_PARAMS',
            'DEFINE_UI_TOOLTIP',
            'DEFINE_LUT',
            'DEFINE_CUBE_LUT',
            'DEFINE_ACES_PARAM',
            'DEFINE_ACES_V2_PARAM',
        ))),

        // DCTL macro identifiers without arguments
        dctl_macro_statement_identifier: _ => token(prec(100, choice(
            'DEFINE_DCTL_ALPHA_MODE_STRAIGHT',
            'DEFINE_DCTL_ALPHA_MODE_PREMULTIPLY',
        ))),

        // Arguments inside DCTL macros - capture everything including spaces
        // This uses a balanced parentheses approach
        dctl_macro_arguments: _ => repeat1(
            choice(
                // Nested parentheses with content
                seq('(', /[^()]*/, ')'),
                // Nested braces with content (for enum lists)
                seq('{', /[^{}]*/, '}'),
                // Any character except closing paren, opening paren, braces
                /[^(){}\r\n]+/,
            )
        ),

        // Extend declaration modifiers with DCTL-specific ones
        _declaration_modifiers: ($, original) =>
            choice(
                // DCTL-specific modifiers
                '__DEVICE__',
                '__GLOBAL__',
                '__CONSTANT__',
                '__PRIVATE__',
                '__TEXTURE__',
                '__TEXTURE2D__',
                '__TEXTURE3D__',
                '__CONSTANTREF__',
                '__RESOLVE__',
                // Include original (which includes CUDA modifiers)
                original
            ),

        // Extend type qualifiers with DCTL-specific ones (needed for cast expressions)
        type_qualifier: (_, original) => choice(
            original,
            '__PRIVATE__',
        ),

        // Extend primitive types with DCTL vector/matrix types
        primitive_type: _ => token(choice(
            // Standard C types
            'bool',
            'char',
            'int',
            'float',
            'double',
            'void',
            'size_t',
            'ssize_t',
            'ptrdiff_t',
            'intptr_t',
            'uintptr_t',
            'charptr_t',
            'nullptr_t',
            'max_align_t',
            // Fixed-width integer types
            'int8_t', 'int16_t', 'int32_t', 'int64_t',
            'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
            'char8_t', 'char16_t', 'char32_t', 'char64_t',
            // DCTL vector types
            'float2', 'float3', 'float4',
            'int2', 'int3', 'int4',
            'half', 'half2', 'half3', 'half4',
            // DCTL matrix types
            'float3x3', 'float4x4',
        )),
    }
});
