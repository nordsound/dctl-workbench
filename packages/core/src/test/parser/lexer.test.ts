/**
 * Lexer Unit Tests
 */

import { strict as assert } from 'assert';
import { DctlLexer, tokenize } from '../../parser/lexer';
import { TokenType } from '../../parser/tokens';

describe('DctlLexer', () => {
    describe('Token Recognition', () => {
        it('should tokenize identifiers', () => {
            const result = tokenize('myVar foo_bar _underscore');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens.length, 3);
            assert.equal(tokens[0].type, TokenType.IDENTIFIER);
            assert.equal(tokens[0].value, 'myVar');
            assert.equal(tokens[1].value, 'foo_bar');
            assert.equal(tokens[2].value, '_underscore');
        });

        it('should tokenize keywords', () => {
            const result = tokenize('float int void return if else while for');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.FLOAT);
            assert.equal(tokens[1].type, TokenType.INT);
            assert.equal(tokens[2].type, TokenType.VOID);
            assert.equal(tokens[3].type, TokenType.RETURN);
            assert.equal(tokens[4].type, TokenType.IF);
            assert.equal(tokens[5].type, TokenType.ELSE);
            assert.equal(tokens[6].type, TokenType.WHILE);
            assert.equal(tokens[7].type, TokenType.FOR);
        });

        it('should tokenize type keywords (float2, float3, float4, etc.)', () => {
            const result = tokenize('float2 float3 float4 int2 int3 int4 half half2');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.FLOAT2);
            assert.equal(tokens[1].type, TokenType.FLOAT3);
            assert.equal(tokens[2].type, TokenType.FLOAT4);
            assert.equal(tokens[3].type, TokenType.INT2);
            assert.equal(tokens[4].type, TokenType.INT3);
            assert.equal(tokens[5].type, TokenType.INT4);
            assert.equal(tokens[6].type, TokenType.HALF);
            assert.equal(tokens[7].type, TokenType.HALF2);
        });

        it('should tokenize integer literals', () => {
            const result = tokenize('42 0 123456');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.INT_LITERAL);
            assert.equal(tokens[0].value, 42);
            assert.equal(tokens[1].value, 0);
            assert.equal(tokens[2].value, 123456);
        });

        it('should tokenize float literals', () => {
            const result = tokenize('3.14 0.5 .25 1e10 2.5e-3');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.FLOAT_LITERAL);
            assert.equal(tokens[0].value, 3.14);
            assert.equal(tokens[1].value, 0.5);
            assert.equal(tokens[2].value, 0.25);
            assert.equal(tokens[3].value, 1e10);
            assert.equal(tokens[4].value, 2.5e-3);
        });

        it('should tokenize float literals with suffix', () => {
            const result = tokenize('1.0f 2.5F 0.5h');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.FLOAT_LITERAL);
            assert.equal(tokens[0].hasFloatSuffix, true);
            assert.equal(tokens[1].hasFloatSuffix, true);
            assert.equal(tokens[2].hasFloatSuffix, true);
        });

        it('should tokenize hex literals', () => {
            const result = tokenize('0x1A 0xFF 0x0');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.INT_LITERAL);
            assert.equal(tokens[0].value, 0x1A);
            assert.equal(tokens[1].value, 0xFF);
            assert.equal(tokens[2].value, 0x0);
        });

        it('should tokenize string literals', () => {
            const result = tokenize('"hello" "world"');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.STRING_LITERAL);
            assert.equal(tokens[0].value, 'hello');
            assert.equal(tokens[1].value, 'world');
        });

        it('should tokenize operators', () => {
            const result = tokenize('+ - * / % = < > !');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.PLUS);
            assert.equal(tokens[1].type, TokenType.MINUS);
            assert.equal(tokens[2].type, TokenType.TIMES);
            assert.equal(tokens[3].type, TokenType.DIV);
            assert.equal(tokens[4].type, TokenType.MOD);
            assert.equal(tokens[5].type, TokenType.ASSIGN);
            assert.equal(tokens[6].type, TokenType.LESS);
            assert.equal(tokens[7].type, TokenType.GREATER);
            assert.equal(tokens[8].type, TokenType.NOT);
        });

        it('should tokenize compound operators', () => {
            const result = tokenize('+= -= *= /= %= &= |= ^=');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.PLUS_ASSIGN);
            assert.equal(tokens[1].type, TokenType.MINUS_ASSIGN);
            assert.equal(tokens[2].type, TokenType.TIMES_ASSIGN);
            assert.equal(tokens[3].type, TokenType.DIV_ASSIGN);
            assert.equal(tokens[4].type, TokenType.MOD_ASSIGN);
            assert.equal(tokens[5].type, TokenType.AND_ASSIGN);
            assert.equal(tokens[6].type, TokenType.OR_ASSIGN);
            assert.equal(tokens[7].type, TokenType.XOR_ASSIGN);
        });

        it('should tokenize comparison operators', () => {
            const result = tokenize('== != <= >= && ||');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.EQUAL);
            assert.equal(tokens[1].type, TokenType.NOT_EQUAL);
            assert.equal(tokens[2].type, TokenType.LESS_EQUAL);
            assert.equal(tokens[3].type, TokenType.GREATER_EQUAL);
            assert.equal(tokens[4].type, TokenType.AND);
            assert.equal(tokens[5].type, TokenType.OR);
        });

        it('should tokenize increment/decrement', () => {
            const result = tokenize('++ --');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.INCREMENT);
            assert.equal(tokens[1].type, TokenType.DECREMENT);
        });

        it('should tokenize shift operators', () => {
            const result = tokenize('<< >> <<= >>=');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.LEFT_SHIFT);
            assert.equal(tokens[1].type, TokenType.RIGHT_SHIFT);
            assert.equal(tokens[2].type, TokenType.LEFT_SHIFT_ASSIGN);
            assert.equal(tokens[3].type, TokenType.RIGHT_SHIFT_ASSIGN);
        });

        it('should tokenize bitwise operators', () => {
            const result = tokenize('& | ^ ~');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.BIT_AND);
            assert.equal(tokens[1].type, TokenType.BIT_OR);
            assert.equal(tokens[2].type, TokenType.BIT_XOR);
            assert.equal(tokens[3].type, TokenType.BIT_NOT);
        });

        it('should tokenize delimiters', () => {
            const result = tokenize('( ) { } [ ] , ; . : ?');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.OPEN_PAREN);
            assert.equal(tokens[1].type, TokenType.CLOSE_PAREN);
            assert.equal(tokens[2].type, TokenType.OPEN_BRACE);
            assert.equal(tokens[3].type, TokenType.CLOSE_BRACE);
            assert.equal(tokens[4].type, TokenType.OPEN_BRACKET);
            assert.equal(tokens[5].type, TokenType.CLOSE_BRACKET);
            assert.equal(tokens[6].type, TokenType.COMMA);
            assert.equal(tokens[7].type, TokenType.SEMICOLON);
            assert.equal(tokens[8].type, TokenType.DOT);
            assert.equal(tokens[9].type, TokenType.COLON);
            assert.equal(tokens[10].type, TokenType.QUESTION);
        });

        it('should tokenize arrow operator', () => {
            const result = tokenize('->');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.ARROW);
        });
    });

    describe('Comments', () => {
        it('should handle single-line comments', () => {
            const result = tokenize('a // this is a comment\nb');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens.length, 2);
            assert.equal(tokens[0].value, 'a');
            assert.equal(tokens[1].value, 'b');
        });

        it('should handle multi-line comments', () => {
            const result = tokenize('a /* comment */ b');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens.length, 2);
            assert.equal(tokens[0].value, 'a');
            assert.equal(tokens[1].value, 'b');
        });

        it('should handle multi-line comments spanning lines', () => {
            const result = tokenize('a /* comment\nspanning\nlines */ b');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens.length, 2);
        });

        it('should report unterminated block comment', () => {
            const result = tokenize('a /* unterminated');
            assert.equal(result.errors.length, 1);
            assert.ok(result.errors[0].message.includes('Unterminated'));
        });
    });

    describe('DCTL-specific Tokens', () => {
        it('should tokenize DEFINE_UI_PARAMS', () => {
            const result = tokenize('DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.DEFINE_UI_PARAMS);
            assert.equal(tokens[0].value, 'DEFINE_UI_PARAMS');
        });

        it('should tokenize DEFINE_UI_TOOLTIP', () => {
            const result = tokenize('DEFINE_UI_TOOLTIP(gain, "Adjust gain")');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.DEFINE_UI_TOOLTIP);
        });

        it('should tokenize DEFINE_DCTL_ALPHA_MODE variants', () => {
            const result = tokenize('DEFINE_DCTL_ALPHA_MODE_STRAIGHT DEFINE_DCTL_ALPHA_MODE_PREMULTIPLIED');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.DEFINE_DCTL_ALPHA_MODE);
            assert.equal(tokens[0].value, 'DEFINE_DCTL_ALPHA_MODE_STRAIGHT');
            assert.equal(tokens[1].type, TokenType.DEFINE_DCTL_ALPHA_MODE);
            assert.equal(tokens[1].value, 'DEFINE_DCTL_ALPHA_MODE_PREMULTIPLIED');
        });

        it('should tokenize __DEVICE__, __TEXTURE__, etc.', () => {
            const result = tokenize('__DEVICE__ __TEXTURE__ __CONSTANT__ __GLOBAL__');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.__DEVICE__);
            assert.equal(tokens[1].type, TokenType.__TEXTURE__);
            assert.equal(tokens[2].type, TokenType.__CONSTANT__);
            assert.equal(tokens[3].type, TokenType.__GLOBAL__);
        });
    });

    describe('String Escape Sequences', () => {
        it('should handle escape sequences in strings', () => {
            const result = tokenize('"line1\\nline2"');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].value, 'line1\nline2');
        });

        it('should handle tab escape', () => {
            const result = tokenize('"col1\\tcol2"');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].value, 'col1\tcol2');
        });

        it('should handle escaped quotes', () => {
            const result = tokenize('"say \\"hello\\""');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].value, 'say "hello"');
        });

        it('should handle escaped backslash', () => {
            const result = tokenize('"path\\\\file"');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].value, 'path\\file');
        });
    });

    describe('Character Literals', () => {
        it('should tokenize simple character', () => {
            const result = tokenize("'a'");
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.INT_LITERAL);
            assert.equal(tokens[0].value, 97); // ASCII 'a'
        });

        it('should tokenize escaped characters', () => {
            const result = tokenize("'\\n' '\\t' '\\0'");
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].value, 10); // newline
            assert.equal(tokens[1].value, 9);  // tab
            assert.equal(tokens[2].value, 0);  // null
        });

        it('should report error for empty character literal', () => {
            const result = tokenize("''");
            assert.equal(result.errors.length, 1);
            assert.ok(result.errors[0].message.includes('Empty'));
        });
    });

    describe('Edge Cases', () => {
        it('should handle UTF-8 BOM', () => {
            const result = tokenize('\uFEFFint x');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.INT);
            assert.equal(tokens[1].value, 'x');
        });

        it('should handle Unicode whitespace', () => {
            const result = tokenize('a\u00A0b'); // non-breaking space
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens.length, 2);
        });

        it('should skip preprocessor directives', () => {
            const result = tokenize('#include "file.h"\nint x');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.INT);
            assert.equal(tokens[1].value, 'x');
        });

        it('should handle empty input', () => {
            const result = tokenize('');
            assert.equal(result.tokens.length, 1); // Just EOF
            assert.equal(result.tokens[0].type, TokenType.EOF);
        });

        it('should track line and column numbers', () => {
            const result = tokenize('a\nb\nc');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].line, 1);
            assert.equal(tokens[1].line, 2);
            assert.equal(tokens[2].line, 3);
        });

        it('should report unknown characters', () => {
            const result = tokenize('a @ b');
            assert.equal(result.errors.length, 1);
            assert.ok(result.errors[0].message.includes('Unexpected'));
        });
    });

    describe('C++ Alternate Keywords (ISO 646)', () => {
        it('should tokenize alternate operator keywords', () => {
            const result = tokenize('and or not xor bitand bitor');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.AND);      // &&
            assert.equal(tokens[1].type, TokenType.OR);       // ||
            assert.equal(tokens[2].type, TokenType.NOT);      // !
            assert.equal(tokens[3].type, TokenType.BIT_XOR);  // ^
            assert.equal(tokens[4].type, TokenType.BIT_AND);  // &
            assert.equal(tokens[5].type, TokenType.BIT_OR);   // |
        });
    });

    describe('Unsigned Integer Literals', () => {
        it('should tokenize unsigned suffix', () => {
            const result = tokenize('42u 100U');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.UINT_LITERAL);
            assert.equal(tokens[0].value, 42);
            assert.equal(tokens[1].type, TokenType.UINT_LITERAL);
            assert.equal(tokens[1].value, 100);
        });

        it('should tokenize long suffix', () => {
            const result = tokenize('42L 100l 50LL');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.INT_LITERAL);
            assert.equal(tokens[1].type, TokenType.INT_LITERAL);
            assert.equal(tokens[2].type, TokenType.INT_LITERAL);
        });

        it('should tokenize unsigned long suffix', () => {
            const result = tokenize('42ul 100UL 50LU');
            const tokens = result.tokens.filter(t => t.type !== TokenType.EOF);
            assert.equal(tokens[0].type, TokenType.UINT_LITERAL);
            assert.equal(tokens[1].type, TokenType.UINT_LITERAL);
            assert.equal(tokens[2].type, TokenType.UINT_LITERAL);
        });
    });
});
