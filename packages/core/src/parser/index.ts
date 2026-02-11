/**
 * DCTL Parser Module
 *
 * Provides lexer, parser, and AST types for DCTL source code.
 */

// AST types (includes ParseResult, ParseError, SourceLocation, all node types)
export * from './ast.js';

// Token types and utilities
export {
    TokenType,
    KEYWORDS,
    TOKEN_STRINGS,
    createToken,
    tokenToString,
    isTypeKeyword,
    isModifier,
} from './tokens.js';
export type { Token } from './tokens.js';

// Lexer
export { DctlLexer, tokenize } from './lexer.js';
export type { LexerError, LexResult } from './lexer.js';

// Parser
export { DctlParser, parseDctl } from './dctlParser.js';

// Preprocessor
export {
    preprocessDctl,
    mapPositionToOriginal,
    isHeaderLine,
} from './dctlPreprocessor.js';
export type { PositionMapping, PreprocessResult } from './dctlPreprocessor.js';

// UI Parameter extraction
export { extractUIParams, convertToCompilerParameter } from './uiParamExtractor.js';
export type { UIParamExtractionResult } from './uiParamExtractor.js';

// DCTL-specific types and constants
export * from './dctlTypes.js';

// DCTL function documentation
export * from './documentation.js';
