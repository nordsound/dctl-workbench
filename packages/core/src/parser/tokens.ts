/**
 * DCTL Token Definitions
 *
 * Based on CTL's token system, extended for DCTL-specific syntax.
 */

export enum TokenType {
    // ==========================================================================
    // Operators
    // ==========================================================================
    AND = 'AND',                 // "&&"
    OR = 'OR',                   // "||"
    NOT = 'NOT',                 // "!"
    ASSIGN = 'ASSIGN',           // "="
    EQUAL = 'EQUAL',             // "=="
    NOT_EQUAL = 'NOT_EQUAL',     // "!="
    LESS = 'LESS',               // "<"
    LESS_EQUAL = 'LESS_EQUAL',   // "<="
    GREATER = 'GREATER',         // ">"
    GREATER_EQUAL = 'GREATER_EQUAL', // ">="
    PLUS = 'PLUS',               // "+"
    MINUS = 'MINUS',             // "-"
    TIMES = 'TIMES',             // "*"
    DIV = 'DIV',                 // "/"
    MOD = 'MOD',                 // "%"

    // Compound assignment
    PLUS_ASSIGN = 'PLUS_ASSIGN',     // "+="
    MINUS_ASSIGN = 'MINUS_ASSIGN',   // "-="
    TIMES_ASSIGN = 'TIMES_ASSIGN',   // "*="
    DIV_ASSIGN = 'DIV_ASSIGN',       // "/="
    MOD_ASSIGN = 'MOD_ASSIGN',       // "%="
    AND_ASSIGN = 'AND_ASSIGN',       // "&="
    OR_ASSIGN = 'OR_ASSIGN',         // "|="
    XOR_ASSIGN = 'XOR_ASSIGN',       // "^="
    LEFT_SHIFT_ASSIGN = 'LEFT_SHIFT_ASSIGN',   // "<<="
    RIGHT_SHIFT_ASSIGN = 'RIGHT_SHIFT_ASSIGN', // ">>="

    // Increment/Decrement
    INCREMENT = 'INCREMENT',     // "++"
    DECREMENT = 'DECREMENT',     // "--"

    // ==========================================================================
    // Bitwise Operators
    // ==========================================================================
    BIT_AND = 'BIT_AND',         // "&"
    BIT_OR = 'BIT_OR',           // "|"
    BIT_XOR = 'BIT_XOR',         // "^"
    BIT_NOT = 'BIT_NOT',         // "~"
    LEFT_SHIFT = 'LEFT_SHIFT',   // "<<"
    RIGHT_SHIFT = 'RIGHT_SHIFT', // ">>"

    // ==========================================================================
    // Delimiters
    // ==========================================================================
    OPEN_PAREN = 'OPEN_PAREN',       // "("
    CLOSE_PAREN = 'CLOSE_PAREN',     // ")"
    OPEN_BRACE = 'OPEN_BRACE',       // "{"
    CLOSE_BRACE = 'CLOSE_BRACE',     // "}"
    OPEN_BRACKET = 'OPEN_BRACKET',   // "["
    CLOSE_BRACKET = 'CLOSE_BRACKET', // "]"
    COMMA = 'COMMA',                 // ","
    SEMICOLON = 'SEMICOLON',         // ";"
    DOT = 'DOT',                     // "."
    ARROW = 'ARROW',                 // "->"
    COLON = 'COLON',                 // ":"
    QUESTION = 'QUESTION',           // "?"

    // ==========================================================================
    // Keywords - C/DCTL
    // ==========================================================================
    BOOL = 'BOOL',
    BREAK = 'BREAK',
    CHAR = 'CHAR',
    CONST = 'CONST',
    CONTINUE = 'CONTINUE',
    DOUBLE = 'DOUBLE',
    ELSE = 'ELSE',
    FALSE = 'FALSE',
    FLOAT = 'FLOAT',
    FOR = 'FOR',
    IF = 'IF',
    INT = 'INT',
    LONG = 'LONG',
    SHORT = 'SHORT',
    UNSIGNED = 'UNSIGNED',
    SIGNED = 'SIGNED',
    RETURN = 'RETURN',
    STRUCT = 'STRUCT',
    TRUE = 'TRUE',
    VOID = 'VOID',
    WHILE = 'WHILE',
    DO = 'DO',
    SWITCH = 'SWITCH',
    CASE = 'CASE',
    DEFAULT = 'DEFAULT',
    TYPEDEF = 'TYPEDEF',
    SIZEOF = 'SIZEOF',
    STATIC = 'STATIC',
    INLINE = 'INLINE',

    // ==========================================================================
    // DCTL-Specific Keywords
    // ==========================================================================
    // Vector types
    FLOAT2 = 'FLOAT2',
    FLOAT3 = 'FLOAT3',
    FLOAT4 = 'FLOAT4',
    INT2 = 'INT2',
    INT3 = 'INT3',
    INT4 = 'INT4',
    HALF = 'HALF',
    HALF2 = 'HALF2',
    HALF3 = 'HALF3',
    HALF4 = 'HALF4',
    UCHAR = 'UCHAR',
    UCHAR2 = 'UCHAR2',
    UCHAR3 = 'UCHAR3',
    UCHAR4 = 'UCHAR4',
    UINT = 'UINT',
    USHORT = 'USHORT',
    // Note: mat2, mat3, mat4 are NOT enum members.
    // They are defined via typedef in DCTL and should be parsed as identifiers.

    // Modifiers
    __DEVICE__ = '__DEVICE__',
    __CONSTANT__ = '__CONSTANT__',
    __CONSTANTREF__ = '__CONSTANTREF__',
    __GLOBAL__ = '__GLOBAL__',
    __LOCAL__ = '__LOCAL__',
    __PRIVATE__ = '__PRIVATE__',

    // Texture types
    __TEXTURE__ = '__TEXTURE__',
    __TEXTURE2D__ = '__TEXTURE2D__',
    __TEXTURE3D__ = '__TEXTURE3D__',

    // ==========================================================================
    // DCTL Macros (parsed as single tokens)
    // ==========================================================================
    DEFINE_UI_PARAMS = 'DEFINE_UI_PARAMS',
    DEFINE_UI_TOOLTIP = 'DEFINE_UI_TOOLTIP',
    DEFINE_ACES_PARAM = 'DEFINE_ACES_PARAM',
    DEFINE_DCTL_ALPHA_MODE = 'DEFINE_DCTL_ALPHA_MODE',

    // ==========================================================================
    // Literals
    // ==========================================================================
    INT_LITERAL = 'INT_LITERAL',
    UINT_LITERAL = 'UINT_LITERAL',
    FLOAT_LITERAL = 'FLOAT_LITERAL',
    STRING_LITERAL = 'STRING_LITERAL',

    // ==========================================================================
    // Identifiers
    // ==========================================================================
    IDENTIFIER = 'IDENTIFIER',

    // ==========================================================================
    // Special
    // ==========================================================================
    EOF = 'EOF',
    ERROR = 'ERROR',
    NEWLINE = 'NEWLINE',
}

export interface Token {
    type: TokenType;
    value: string | number | null;
    line: number;
    column: number;
    /** End column (exclusive) */
    endColumn: number;
    /** For FLOAT_LITERAL: whether 'f' or 'h' suffix was present */
    hasFloatSuffix?: boolean;
    /** For numeric literals: raw string representation (e.g., "3.0" vs 3) */
    rawValue?: string;
}

export function createToken(
    type: TokenType,
    value: string | number | null,
    line: number,
    column: number,
    endColumn?: number,
    hasFloatSuffix?: boolean,
    rawValue?: string
): Token {
    const token: Token = {
        type,
        value,
        line,
        column,
        endColumn: endColumn ?? column + (typeof value === 'string' ? value.length : 1),
    };
    if (hasFloatSuffix !== undefined) {
        token.hasFloatSuffix = hasFloatSuffix;
    }
    if (rawValue !== undefined) {
        token.rawValue = rawValue;
    }
    return token;
}

// =============================================================================
// Keyword Mapping
// =============================================================================

export const KEYWORDS: Record<string, TokenType> = {
    // C keywords
    bool: TokenType.BOOL,
    break: TokenType.BREAK,
    case: TokenType.CASE,
    char: TokenType.CHAR,
    const: TokenType.CONST,
    continue: TokenType.CONTINUE,
    default: TokenType.DEFAULT,
    do: TokenType.DO,
    double: TokenType.DOUBLE,
    else: TokenType.ELSE,
    false: TokenType.FALSE,
    float: TokenType.FLOAT,
    for: TokenType.FOR,
    if: TokenType.IF,
    inline: TokenType.INLINE,
    int: TokenType.INT,
    long: TokenType.LONG,
    return: TokenType.RETURN,
    short: TokenType.SHORT,
    unsigned: TokenType.UNSIGNED,
    signed: TokenType.SIGNED,
    sizeof: TokenType.SIZEOF,
    static: TokenType.STATIC,
    struct: TokenType.STRUCT,
    switch: TokenType.SWITCH,
    true: TokenType.TRUE,
    typedef: TokenType.TYPEDEF,
    void: TokenType.VOID,
    while: TokenType.WHILE,

    // DCTL vector types
    float2: TokenType.FLOAT2,
    float3: TokenType.FLOAT3,
    float4: TokenType.FLOAT4,
    int2: TokenType.INT2,
    int3: TokenType.INT3,
    int4: TokenType.INT4,
    half: TokenType.HALF,
    half2: TokenType.HALF2,
    half3: TokenType.HALF3,
    half4: TokenType.HALF4,
    uchar: TokenType.UCHAR,
    uchar2: TokenType.UCHAR2,
    uchar3: TokenType.UCHAR3,
    uchar4: TokenType.UCHAR4,
    uint: TokenType.UINT,
    ushort: TokenType.USHORT,
    // Note: mat2, mat3, mat4 are NOT keywords in DCTL.
    // They are defined via typedef in the preprocessor and can be used as identifiers.

    // DCTL modifiers
    __DEVICE__: TokenType.__DEVICE__,
    __CONSTANT__: TokenType.__CONSTANT__,
    __CONSTANTREF__: TokenType.__CONSTANTREF__,
    __GLOBAL__: TokenType.__GLOBAL__,
    __LOCAL__: TokenType.__LOCAL__,
    __PRIVATE__: TokenType.__PRIVATE__,

    // DCTL texture types
    __TEXTURE__: TokenType.__TEXTURE__,
    __TEXTURE2D__: TokenType.__TEXTURE2D__,
    __TEXTURE3D__: TokenType.__TEXTURE3D__,

    // C++ alternate operator tokens (ISO 646)
    // These are standard C++ keywords that can be used instead of symbols
    and: TokenType.AND,           // &&
    or: TokenType.OR,             // ||
    not: TokenType.NOT,           // !
    xor: TokenType.BIT_XOR,       // ^
    bitand: TokenType.BIT_AND,    // &
    bitor: TokenType.BIT_OR,      // |
    compl: TokenType.BIT_NOT,     // ~
    not_eq: TokenType.NOT_EQUAL,  // !=
    and_eq: TokenType.AND_ASSIGN, // &=
    or_eq: TokenType.OR_ASSIGN,   // |=
    xor_eq: TokenType.XOR_ASSIGN, // ^=
};

// =============================================================================
// Token String Representation
// =============================================================================

export const TOKEN_STRINGS: Partial<Record<TokenType, string>> = {
    [TokenType.AND]: '&&',
    [TokenType.OR]: '||',
    [TokenType.NOT]: '!',
    [TokenType.ASSIGN]: '=',
    [TokenType.EQUAL]: '==',
    [TokenType.NOT_EQUAL]: '!=',
    [TokenType.LESS]: '<',
    [TokenType.LESS_EQUAL]: '<=',
    [TokenType.GREATER]: '>',
    [TokenType.GREATER_EQUAL]: '>=',
    [TokenType.PLUS]: '+',
    [TokenType.MINUS]: '-',
    [TokenType.TIMES]: '*',
    [TokenType.DIV]: '/',
    [TokenType.MOD]: '%',
    [TokenType.PLUS_ASSIGN]: '+=',
    [TokenType.MINUS_ASSIGN]: '-=',
    [TokenType.TIMES_ASSIGN]: '*=',
    [TokenType.DIV_ASSIGN]: '/=',
    [TokenType.MOD_ASSIGN]: '%=',
    [TokenType.AND_ASSIGN]: '&=',
    [TokenType.OR_ASSIGN]: '|=',
    [TokenType.XOR_ASSIGN]: '^=',
    [TokenType.LEFT_SHIFT_ASSIGN]: '<<=',
    [TokenType.RIGHT_SHIFT_ASSIGN]: '>>=',
    [TokenType.INCREMENT]: '++',
    [TokenType.DECREMENT]: '--',
    [TokenType.BIT_AND]: '&',
    [TokenType.BIT_OR]: '|',
    [TokenType.BIT_XOR]: '^',
    [TokenType.BIT_NOT]: '~',
    [TokenType.LEFT_SHIFT]: '<<',
    [TokenType.RIGHT_SHIFT]: '>>',
    [TokenType.OPEN_PAREN]: '(',
    [TokenType.CLOSE_PAREN]: ')',
    [TokenType.OPEN_BRACE]: '{',
    [TokenType.CLOSE_BRACE]: '}',
    [TokenType.OPEN_BRACKET]: '[',
    [TokenType.CLOSE_BRACKET]: ']',
    [TokenType.COMMA]: ',',
    [TokenType.SEMICOLON]: ';',
    [TokenType.DOT]: '.',
    [TokenType.COLON]: ':',
    [TokenType.QUESTION]: '?',
};

export function tokenToString(type: TokenType): string {
    return TOKEN_STRINGS[type] ?? type.toLowerCase();
}

/**
 * Check if a token type is a type keyword
 */
export function isTypeKeyword(type: TokenType): boolean {
    return [
        TokenType.VOID, TokenType.BOOL, TokenType.INT, TokenType.FLOAT,
        TokenType.CHAR, TokenType.DOUBLE, TokenType.LONG, TokenType.SHORT,
        TokenType.FLOAT2, TokenType.FLOAT3, TokenType.FLOAT4,
        TokenType.INT2, TokenType.INT3, TokenType.INT4,
        TokenType.HALF, TokenType.HALF2, TokenType.HALF3, TokenType.HALF4,
        TokenType.UCHAR, TokenType.UCHAR2, TokenType.UCHAR3, TokenType.UCHAR4,
        TokenType.UINT, TokenType.USHORT,
        // Note: mat2, mat3, mat4 are NOT type keywords - they are typedef'd identifiers
        TokenType.__TEXTURE__, TokenType.__TEXTURE2D__, TokenType.__TEXTURE3D__,
    ].includes(type);
}

/**
 * Check if a token type is a modifier
 */
export function isModifier(type: TokenType): boolean {
    return [
        TokenType.__DEVICE__, TokenType.__CONSTANT__,
        TokenType.__GLOBAL__, TokenType.__LOCAL__,
        TokenType.__PRIVATE__,
        TokenType.CONST, TokenType.STATIC, TokenType.INLINE,
    ].includes(type);
}
