/**
 * DCTL Language Support Module
 * Exports hover provider, completion provider, and documentation
 */

export { DctlHoverProvider } from './hoverProvider';
export { DctlCompletionProvider, COMPLETION_TRIGGER_CHARACTERS } from './completionProvider';
export {
    DCTL_FUNCTION_DOCS,
    DCTL_FUNCTION_MAP,
    DCTL_KEYWORD_DOCS,
    DCTL_KEYWORD_MAP,
    DCTL_UI_TYPES,
    type DctlFunctionDoc,
    type DctlKeywordDoc
} from './documentation';
