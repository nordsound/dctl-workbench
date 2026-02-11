import * as vscode from 'vscode';
import { DCTL_FUNCTION_DOCS, DCTL_KEYWORD_DOCS, DCTL_UI_TYPES } from './documentation';

/**
 * Provides auto-completion for DCTL files
 */
export class DctlCompletionProvider implements vscode.CompletionItemProvider {
    private functionCompletions: vscode.CompletionItem[];
    private keywordCompletions: vscode.CompletionItem[];
    private uiTypeCompletions: vscode.CompletionItem[];

    constructor() {
        this.functionCompletions = this.createFunctionCompletions();
        this.keywordCompletions = this.createKeywordCompletions();
        this.uiTypeCompletions = this.createUITypeCompletions();
    }

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        const linePrefix = document.lineAt(position).text.substring(0, position.character);

        // Check if we're inside DEFINE_UI_PARAMS and need UI type completion
        if (this.isInUIParamsContext(linePrefix)) {
            return this.uiTypeCompletions;
        }

        // Return all completions (functions and keywords)
        return [...this.functionCompletions, ...this.keywordCompletions];
    }

    private isInUIParamsContext(linePrefix: string): boolean {
        // Check if we're after DEFINE_UI_PARAMS( and before the closing )
        const match = linePrefix.match(/DEFINE_UI_PARAMS\s*\([^)]*,\s*[^,]*,\s*$/);
        return match !== null;
    }

    private createFunctionCompletions(): vscode.CompletionItem[] {
        return DCTL_FUNCTION_DOCS.map(doc => {
            const item = new vscode.CompletionItem(doc.name, vscode.CompletionItemKind.Function);

            item.detail = doc.signature;
            item.documentation = new vscode.MarkdownString(doc.description);

            // Create insert text with placeholders for parameters
            if (doc.parameters && doc.parameters.length > 0) {
                const params = doc.parameters
                    .map((p, i) => `\${${i + 1}:${p.name}}`)
                    .join(', ');
                item.insertText = new vscode.SnippetString(`${doc.name}(${params})`);
            } else {
                item.insertText = new vscode.SnippetString(`${doc.name}($0)`);
            }

            item.sortText = `0_${doc.name}`; // Sort functions first

            return item;
        });
    }

    private createKeywordCompletions(): vscode.CompletionItem[] {
        return DCTL_KEYWORD_DOCS.map(doc => {
            const kind = doc.category === 'Type'
                ? vscode.CompletionItemKind.TypeParameter
                : doc.category === 'Variable'
                    ? vscode.CompletionItemKind.Variable
                    : vscode.CompletionItemKind.Keyword;

            const item = new vscode.CompletionItem(doc.name, kind);
            item.detail = doc.category;
            item.documentation = new vscode.MarkdownString(doc.description);
            item.sortText = `1_${doc.name}`; // Sort after functions

            return item;
        });
    }

    private createUITypeCompletions(): vscode.CompletionItem[] {
        return DCTL_UI_TYPES.map(uiType => {
            const item = new vscode.CompletionItem(uiType.name, vscode.CompletionItemKind.EnumMember);
            item.detail = `UI Control: ${uiType.description}`;
            item.documentation = new vscode.MarkdownString(`Parameters: \`${uiType.params}\``);
            return item;
        });
    }
}

/**
 * Trigger characters for completion
 */
export const COMPLETION_TRIGGER_CHARACTERS = ['_', '.'];
