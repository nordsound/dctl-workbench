/**
 * DCTL Lexical Analyzer
 *
 * Splits DCTL source code into tokens.
 */

import { Token, TokenType, KEYWORDS, createToken } from './tokens';

export interface LexerError {
    message: string;
    line: number;
    column: number;
    sourceLine: string;
}

export interface LexResult {
    tokens: Token[];
    errors: LexerError[];
}

export class DctlLexer {
    private source: string;
    private pos: number = 0;
    private line: number = 1;
    private column: number = 1;
    private lineStart: number = 0;
    private errors: LexerError[] = [];

    constructor(source: string) {
        // Strip UTF-8 BOM if present at start of file
        if (source.charCodeAt(0) === 0xFEFF) {
            this.source = source.slice(1);
        } else {
            this.source = source;
        }
    }

    /**
     * Tokenize the entire source code
     */
    tokenize(): LexResult {
        const tokens: Token[] = [];
        this.errors = [];

        while (!this.atEnd()) {
            this.skipWhitespaceAndComments();
            if (this.atEnd()) break;

            try {
                const token = this.nextToken();
                if (token) {
                    tokens.push(token);
                }
            } catch (e) {
                // Error already added to errors array
                // Try to recover by advancing
                this.advance();
            }
        }

        // Add EOF token
        tokens.push(createToken(TokenType.EOF, null, this.line, this.column));
        return { tokens, errors: this.errors };
    }

    // =========================================================================
    // Character Access
    // =========================================================================

    private atEnd(): boolean {
        return this.pos >= this.source.length;
    }

    private current(): string {
        if (this.atEnd()) return '\0';
        return this.source[this.pos];
    }

    private peek(offset: number = 1): string {
        const pos = this.pos + offset;
        if (pos >= this.source.length) return '\0';
        return this.source[pos];
    }

    private advance(): string {
        const ch = this.current();
        this.pos++;
        if (ch === '\n') {
            this.line++;
            this.column = 1;
            this.lineStart = this.pos;
        } else {
            this.column++;
        }
        return ch;
    }

    private getCurrentLine(): string {
        let end = this.source.indexOf('\n', this.lineStart);
        if (end === -1) end = this.source.length;
        return this.source.slice(this.lineStart, end);
    }

    private addError(message: string, line?: number, column?: number): void {
        this.errors.push({
            message,
            line: line ?? this.line,
            column: column ?? this.column,
            sourceLine: this.getCurrentLine(),
        });
    }

    // =========================================================================
    // Whitespace and Comments
    // =========================================================================

    private skipWhitespaceAndComments(): void {
        while (!this.atEnd()) {
            const ch = this.current();

            // Whitespace (including Unicode whitespace like non-breaking space)
            if (this.isWhitespace(ch)) {
                this.advance();
                continue;
            }

            // Single-line comment: //
            if (ch === '/' && this.peek() === '/') {
                this.skipLineComment();
                continue;
            }

            // Multi-line comment: /* */
            if (ch === '/' && this.peek() === '*') {
                this.skipBlockComment();
                continue;
            }

            // Preprocessor directives: #line, #pragma, etc.
            // These are typically handled by the preprocessor, but we skip them here
            // to allow parsing of already-preprocessed code that retains #line directives
            if (ch === '#') {
                this.skipPreprocessorDirective();
                continue;
            }

            break;
        }
    }

    private skipPreprocessorDirective(): void {
        // Capture the directive content to check for #line
        let directiveContent = '';

        // Skip # and any following content until end of line
        // Handle line continuation with backslash
        while (!this.atEnd()) {
            const ch = this.current();
            if (ch === '\n') {
                this.advance();
                break;
            }
            if (ch === '\\' && this.peek() === '\n') {
                // Line continuation
                this.advance(); // skip backslash
                this.advance(); // skip newline
                continue;
            }
            directiveContent += ch;
            this.advance();
        }

        // Check if this is a #line directive and update line number
        const lineMatch = directiveContent.match(/^#\s*line\s+(\d+)/);
        if (lineMatch) {
            const newLineNumber = parseInt(lineMatch[1], 10);
            // #line N means "the next line is line N"
            this.line = newLineNumber;
        }
    }

    private skipLineComment(): void {
        while (!this.atEnd() && this.current() !== '\n') {
            this.advance();
        }
    }

    private skipBlockComment(): void {
        const startLine = this.line;
        const startColumn = this.column;

        this.advance(); // Skip '/'
        this.advance(); // Skip '*'

        while (!this.atEnd()) {
            if (this.current() === '*' && this.peek() === '/') {
                this.advance(); // Skip '*'
                this.advance(); // Skip '/'
                return;
            }
            this.advance();
        }

        this.addError('Unterminated block comment', startLine, startColumn);
    }

    // =========================================================================
    // Token Recognition
    // =========================================================================

    private nextToken(): Token | null {
        const startLine = this.line;
        const startColumn = this.column;
        const ch = this.current();

        // Check for DCTL macros first (DEFINE_*)
        if (ch === 'D' && this.matchMacro()) {
            return this.readMacro(startLine, startColumn);
        }

        // Three-character operators
        const threeChar = ch + this.peek(1) + this.peek(2);
        const threeCharOps: Record<string, TokenType> = {
            '<<=': TokenType.LEFT_SHIFT_ASSIGN,
            '>>=': TokenType.RIGHT_SHIFT_ASSIGN,
        };
        if (threeChar in threeCharOps) {
            this.advance(); this.advance(); this.advance();
            return createToken(threeCharOps[threeChar], threeChar, startLine, startColumn, this.column);
        }

        // Two-character operators
        const twoChar = ch + this.peek();
        const twoCharOps: Record<string, TokenType> = {
            '&&': TokenType.AND,
            '||': TokenType.OR,
            '==': TokenType.EQUAL,
            '!=': TokenType.NOT_EQUAL,
            '<=': TokenType.LESS_EQUAL,
            '>=': TokenType.GREATER_EQUAL,
            '<<': TokenType.LEFT_SHIFT,
            '>>': TokenType.RIGHT_SHIFT,
            '+=': TokenType.PLUS_ASSIGN,
            '-=': TokenType.MINUS_ASSIGN,
            '->': TokenType.ARROW,
            '*=': TokenType.TIMES_ASSIGN,
            '/=': TokenType.DIV_ASSIGN,
            '%=': TokenType.MOD_ASSIGN,
            '&=': TokenType.AND_ASSIGN,
            '|=': TokenType.OR_ASSIGN,
            '^=': TokenType.XOR_ASSIGN,
            '++': TokenType.INCREMENT,
            '--': TokenType.DECREMENT,
        };

        if (twoChar in twoCharOps) {
            this.advance();
            this.advance();
            return createToken(twoCharOps[twoChar], twoChar, startLine, startColumn, this.column);
        }

        // Single-character operators
        const oneCharOps: Record<string, TokenType> = {
            '+': TokenType.PLUS,
            '-': TokenType.MINUS,
            '*': TokenType.TIMES,
            '/': TokenType.DIV,
            '%': TokenType.MOD,
            '=': TokenType.ASSIGN,
            '<': TokenType.LESS,
            '>': TokenType.GREATER,
            '!': TokenType.NOT,
            '&': TokenType.BIT_AND,
            '|': TokenType.BIT_OR,
            '^': TokenType.BIT_XOR,
            '~': TokenType.BIT_NOT,
            '(': TokenType.OPEN_PAREN,
            ')': TokenType.CLOSE_PAREN,
            '{': TokenType.OPEN_BRACE,
            '}': TokenType.CLOSE_BRACE,
            '[': TokenType.OPEN_BRACKET,
            ']': TokenType.CLOSE_BRACKET,
            ',': TokenType.COMMA,
            ';': TokenType.SEMICOLON,
            ':': TokenType.COLON,
            '?': TokenType.QUESTION,
        };

        // Check for number starting with '.'
        if (ch === '.' && this.isDigit(this.peek())) {
            return this.readNumber(startLine, startColumn);
        }

        if (ch === '.') {
            this.advance();
            return createToken(TokenType.DOT, '.', startLine, startColumn, this.column);
        }

        if (ch in oneCharOps) {
            this.advance();
            return createToken(oneCharOps[ch], ch, startLine, startColumn, this.column);
        }

        // Numbers
        if (this.isDigit(ch)) {
            return this.readNumber(startLine, startColumn);
        }

        // Strings (double-quoted)
        if (ch === '"') {
            return this.readString(startLine, startColumn);
        }

        // Character literals (single-quoted): 'a', '\n', '\0'
        if (ch === "'") {
            return this.readCharLiteral(startLine, startColumn);
        }

        // Identifiers and keywords
        if (this.isAlpha(ch) || ch === '_') {
            return this.readIdentifier(startLine, startColumn);
        }

        // Unknown character
        this.addError(`Unexpected character: '${ch}'`, startLine, startColumn);
        this.advance();
        return createToken(TokenType.ERROR, ch, startLine, startColumn, this.column);
    }

    // =========================================================================
    // Number Literals
    // =========================================================================

    private readNumber(startLine: number, startColumn: number): Token {
        let value = '';
        let hasDot = false;
        let hasExp = false;
        let hasFloatSuffix = false;

        // Leading dot
        if (this.current() === '.') {
            value += this.advance();
            hasDot = true;
        }

        // Hex number
        if (this.current() === '0' && (this.peek() === 'x' || this.peek() === 'X')) {
            value += this.advance(); // '0'
            value += this.advance(); // 'x'
            while (!this.atEnd() && this.isHexDigit(this.current())) {
                value += this.advance();
            }
            return createToken(TokenType.INT_LITERAL, parseInt(value, 16), startLine, startColumn, this.column);
        }

        // Integer part
        while (!this.atEnd() && this.isDigit(this.current())) {
            value += this.advance();
        }

        // Decimal part
        if (!hasDot && this.current() === '.' && this.peek() !== '.') {
            value += this.advance();
            hasDot = true;
            while (!this.atEnd() && this.isDigit(this.current())) {
                value += this.advance();
            }
        }

        // Exponent
        if (this.current() === 'e' || this.current() === 'E') {
            value += this.advance();
            hasExp = true;
            if (this.current() === '+' || this.current() === '-') {
                value += this.advance();
            }
            if (!this.isDigit(this.current())) {
                this.addError('Invalid exponent in number literal', startLine, startColumn);
            }
            while (!this.atEnd() && this.isDigit(this.current())) {
                value += this.advance();
            }
        }

        // Float suffix (f or F)
        if (this.current() === 'f' || this.current() === 'F') {
            this.advance();
            hasDot = true; // Treat as float
            hasFloatSuffix = true;
        }

        // Half suffix (h or H)
        if (this.current() === 'h' || this.current() === 'H') {
            this.advance();
            hasDot = true; // Treat as float
            hasFloatSuffix = true;
        }

        // Unsigned suffix (u or U) for integers
        let hasUnsignedSuffix = false;
        if (!hasDot && !hasExp && (this.current() === 'u' || this.current() === 'U')) {
            this.advance();
            hasUnsignedSuffix = true;
            // Also handle long suffix after unsigned (ul, uL, UL, Ul)
            if (this.current() === 'l' || this.current() === 'L') {
                this.advance();
                // Handle long long (ull, ULL, etc.)
                if (this.current() === 'l' || this.current() === 'L') {
                    this.advance();
                }
            }
        }
        // Handle long suffix (l or L) for integers
        else if (!hasDot && !hasExp && (this.current() === 'l' || this.current() === 'L')) {
            this.advance();
            // Handle long long (ll or LL)
            if (this.current() === 'l' || this.current() === 'L') {
                this.advance();
            }
            // Handle unsigned after long (lu, lU, LU, Lu)
            if (this.current() === 'u' || this.current() === 'U') {
                this.advance();
                hasUnsignedSuffix = true;
            }
        }

        if (hasDot || hasExp) {
            return createToken(TokenType.FLOAT_LITERAL, parseFloat(value), startLine, startColumn, this.column, hasFloatSuffix, value);
        } else if (hasUnsignedSuffix) {
            return createToken(TokenType.UINT_LITERAL, parseInt(value, 10), startLine, startColumn, this.column, undefined, value);
        } else {
            return createToken(TokenType.INT_LITERAL, parseInt(value, 10), startLine, startColumn, this.column, undefined, value);
        }
    }

    // =========================================================================
    // String Literals
    // =========================================================================

    private readString(startLine: number, startColumn: number): Token {
        this.advance(); // Skip opening '"'
        let value = '';

        while (!this.atEnd()) {
            const ch = this.current();

            if (ch === '"') {
                this.advance(); // Skip closing '"'
                return createToken(TokenType.STRING_LITERAL, value, startLine, startColumn, this.column);
            }

            if (ch === '\n') {
                this.addError('Unterminated string literal', startLine, startColumn);
                return createToken(TokenType.STRING_LITERAL, value, startLine, startColumn, this.column);
            }

            if (ch === '\\') {
                this.advance();
                const escapeChar = this.current();
                const escapeMap: Record<string, string> = {
                    'n': '\n',
                    't': '\t',
                    'r': '\r',
                    '\\': '\\',
                    '"': '"',
                    '0': '\0',
                };
                if (escapeChar in escapeMap) {
                    value += escapeMap[escapeChar];
                } else {
                    value += escapeChar;
                }
                this.advance();
            } else {
                value += this.advance();
            }
        }

        this.addError('Unterminated string literal', startLine, startColumn);
        return createToken(TokenType.STRING_LITERAL, value, startLine, startColumn, this.column);
    }

    // =========================================================================
    // Character Literals (single-quoted)
    // =========================================================================

    private readCharLiteral(startLine: number, startColumn: number): Token {
        this.advance(); // Skip opening '\''
        let value = '';
        let charCode = 0;

        if (this.atEnd() || this.current() === '\n') {
            this.addError('Unterminated character literal', startLine, startColumn);
            return createToken(TokenType.INT_LITERAL, 0, startLine, startColumn, this.column);
        }

        const ch = this.current();

        if (ch === '\\') {
            // Escape sequence
            this.advance();
            const escapeChar = this.current();
            const escapeMap: Record<string, number> = {
                'n': 10,   // '\n' newline
                't': 9,    // '\t' tab
                'r': 13,   // '\r' carriage return
                '\\': 92,  // '\\' backslash
                "'": 39,   // '\'' single quote
                '"': 34,   // '\"' double quote
                '0': 0,    // '\0' null character
                'a': 7,    // '\a' alert/bell
                'b': 8,    // '\b' backspace
                'f': 12,   // '\f' form feed
                'v': 11,   // '\v' vertical tab
            };
            if (escapeChar in escapeMap) {
                charCode = escapeMap[escapeChar];
                value = '\\' + escapeChar;
            } else if (this.isDigit(escapeChar)) {
                // Octal escape: '\0', '\012', etc.
                let octal = '';
                let count = 0;
                while (!this.atEnd() && this.isOctalDigit(this.current()) && count < 3) {
                    octal += this.current();
                    this.advance();
                    count++;
                }
                charCode = parseInt(octal, 8);
                value = '\\' + octal;
                // Don't advance again after the loop
                if (this.current() === "'") {
                    this.advance(); // Skip closing '\''
                    return createToken(TokenType.INT_LITERAL, charCode, startLine, startColumn, this.column);
                }
                this.addError('Unterminated character literal', startLine, startColumn);
                return createToken(TokenType.INT_LITERAL, charCode, startLine, startColumn, this.column);
            } else if (escapeChar === 'x') {
                // Hexadecimal escape: '\x00', '\xFF'
                this.advance(); // Skip 'x'
                let hex = '';
                while (!this.atEnd() && this.isHexDigit(this.current()) && hex.length < 2) {
                    hex += this.current();
                    this.advance();
                }
                charCode = parseInt(hex, 16) || 0;
                value = '\\x' + hex;
                if (this.current() === "'") {
                    this.advance(); // Skip closing '\''
                    return createToken(TokenType.INT_LITERAL, charCode, startLine, startColumn, this.column);
                }
                this.addError('Unterminated character literal', startLine, startColumn);
                return createToken(TokenType.INT_LITERAL, charCode, startLine, startColumn, this.column);
            } else {
                // Unknown escape sequence - just use the character as-is
                charCode = escapeChar.charCodeAt(0);
                value = escapeChar;
            }
            this.advance();
        } else if (ch === "'") {
            // Empty character literal ''
            this.addError('Empty character literal', startLine, startColumn);
            this.advance(); // Skip closing '\''
            return createToken(TokenType.INT_LITERAL, 0, startLine, startColumn, this.column);
        } else {
            // Regular character
            charCode = ch.charCodeAt(0);
            value = ch;
            this.advance();
        }

        // Expect closing '\''
        if (this.current() === "'") {
            this.advance();
        } else {
            this.addError('Unterminated character literal', startLine, startColumn);
        }

        // Return as INT_LITERAL since char is essentially an integer in C
        return createToken(TokenType.INT_LITERAL, charCode, startLine, startColumn, this.column);
    }

    private isOctalDigit(ch: string): boolean {
        return ch >= '0' && ch <= '7';
    }

    private isWhitespace(ch: string): boolean {
        // Standard ASCII whitespace
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            return true;
        }
        // Unicode whitespace characters
        const code = ch.charCodeAt(0);
        // U+00A0: Non-breaking space
        // U+2000-U+200B: Various Unicode spaces
        // U+FEFF: BOM (can appear in middle of file)
        // U+3000: Ideographic space
        return code === 0x00A0 ||
               (code >= 0x2000 && code <= 0x200B) ||
               code === 0xFEFF ||
               code === 0x3000;
    }

    // =========================================================================
    // Identifiers and Keywords
    // =========================================================================

    private readIdentifier(startLine: number, startColumn: number): Token {
        let value = '';

        while (!this.atEnd()) {
            const ch = this.current();
            if (this.isAlphaNumeric(ch) || ch === '_') {
                value += this.advance();
            } else {
                break;
            }
        }

        // Check if it's a keyword
        const tokenType = KEYWORDS[value] ?? TokenType.IDENTIFIER;
        return createToken(tokenType, value, startLine, startColumn, this.column);
    }

    // =========================================================================
    // DCTL Macros
    // =========================================================================

    private matchMacro(): boolean {
        // Check for exact macro matches (with word boundary)
        const exactMacros = [
            'DEFINE_UI_PARAMS',
            'DEFINE_UI_TOOLTIP',
            'DEFINE_ACES_PARAM',
        ];

        for (const macro of exactMacros) {
            if (this.matchString(macro)) {
                return true;
            }
        }

        // Check for DEFINE_DCTL_ALPHA_MODE prefix (allows _STRAIGHT, _PREMULTIPLIED, etc.)
        if (this.matchPrefix('DEFINE_DCTL_ALPHA_MODE')) {
            return true;
        }

        return false;
    }

    private matchString(str: string): boolean {
        for (let i = 0; i < str.length; i++) {
            if (this.pos + i >= this.source.length) return false;
            if (this.source[this.pos + i] !== str[i]) return false;
        }
        // Make sure it's not part of a longer identifier
        const nextChar = this.source[this.pos + str.length] ?? '\0';
        return !this.isAlphaNumeric(nextChar) && nextChar !== '_';
    }

    private matchPrefix(prefix: string): boolean {
        for (let i = 0; i < prefix.length; i++) {
            if (this.pos + i >= this.source.length) return false;
            if (this.source[this.pos + i] !== prefix[i]) return false;
        }
        return true;
    }

    private readMacro(startLine: number, startColumn: number): Token {
        let value = '';

        // Read the macro name
        while (!this.atEnd() && (this.isAlphaNumeric(this.current()) || this.current() === '_')) {
            value += this.advance();
        }

        // Determine the macro type
        let type = TokenType.IDENTIFIER;
        if (value === 'DEFINE_UI_PARAMS') {
            type = TokenType.DEFINE_UI_PARAMS;
        } else if (value === 'DEFINE_UI_TOOLTIP') {
            type = TokenType.DEFINE_UI_TOOLTIP;
        } else if (value === 'DEFINE_ACES_PARAM') {
            type = TokenType.DEFINE_ACES_PARAM;
        } else if (value.startsWith('DEFINE_DCTL_ALPHA_MODE')) {
            type = TokenType.DEFINE_DCTL_ALPHA_MODE;
        }

        // For DEFINE_DCTL_ALPHA_MODE variants, capture the full name
        if (type === TokenType.DEFINE_DCTL_ALPHA_MODE && value !== 'DEFINE_DCTL_ALPHA_MODE') {
            // Already captured the full variant name (e.g., DEFINE_DCTL_ALPHA_MODE_STRAIGHT)
        }

        return createToken(type, value, startLine, startColumn, this.column);
    }

    // =========================================================================
    // Character Classification
    // =========================================================================

    private isDigit(ch: string): boolean {
        return ch >= '0' && ch <= '9';
    }

    private isHexDigit(ch: string): boolean {
        return this.isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
    }

    private isAlpha(ch: string): boolean {
        return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
    }

    private isAlphaNumeric(ch: string): boolean {
        return this.isAlpha(ch) || this.isDigit(ch);
    }
}

/**
 * Convenience function to tokenize source code
 */
export function tokenize(source: string): LexResult {
    const lexer = new DctlLexer(source);
    return lexer.tokenize();
}
