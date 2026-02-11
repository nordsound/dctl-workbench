/**
 * DCTL Preprocessor Module
 *
 * Handles #include directive expansion for DCTL files.
 */

// Main preprocessor
export {
    DctlPreprocessor,
    preprocessDctlFile,
    preprocessDctlSource,
} from './preprocessor';

// Types
export {
    IncludeDirective,
    SourceMapEntry,
    SourceMap,
    PreprocessResult,
    PreprocessError,
    PreprocessWarning,
    PreprocessOptions,
    PREPROCESS_ERROR_CODES,
} from './types';

// Directive parser
export {
    parseIncludeDirectives,
    hasIncludeDirective,
    getIncludePath,
    ParseDirectivesResult,
} from './directiveParser';

// Path resolver
export {
    IncludePathResolver,
    FileSystem,
    NodeFileSystem,
    VirtualFileSystem,
    ResolveResult,
} from './pathResolver';

// Circular include detection
export {
    CircularIncludeDetector,
    CircularIncludeError,
} from './circularDetector';

// Source map
export {
    SourceMapBuilder,
    createEmptySourceMap,
    createSingleFileSourceMap,
} from './sourceMap';

// Define processor
export {
    processDefines,
    MacroDefinition,
    DefineProcessResult,
    FunctionMacro,
} from './defineProcessor';

// Conditional compilation
export {
    processConditionals,
    ConditionalProcessResult,
    ConditionalError,
    DEFAULT_PREDEFINED_MACROS,
} from './conditionalEval';
