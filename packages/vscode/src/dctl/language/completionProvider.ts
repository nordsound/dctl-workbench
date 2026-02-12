import * as vscode from 'vscode';
import { DCTL_FUNCTION_DOCS, DCTL_KEYWORD_DOCS, DCTL_UI_TYPES } from './documentation';
import {
    analyzeDocument,
    getMemberCompletions,
    type DocumentAnalysisResult,
    type DocumentSymbol,
} from '@dctl-workbench/core';

/** Cached analysis result per document */
interface CachedAnalysis {
    version: number;
    result: DocumentAnalysisResult;
}

/** Shared analysis cache (also used by hover provider) */
export const analysisCache = new Map<string, CachedAnalysis>();

/**
 * Get or update the cached analysis for a document
 */
function getAnalysis(document: vscode.TextDocument): DocumentAnalysisResult {
    const uri = document.uri.toString();
    const cached = analysisCache.get(uri);
    if (cached && cached.version === document.version) {
        return cached.result;
    }

    const result = analyzeDocument(document.getText());
    analysisCache.set(uri, { version: document.version, result });
    return result;
}

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

        // Member completion on '.' trigger
        if (context.triggerCharacter === '.' || linePrefix.endsWith('.')) {
            return this.provideMemberCompletions(document, linePrefix);
        }

        // Static completions + dynamic user-defined symbols
        const analysis = getAnalysis(document);
        const dynamicItems = this.createDynamicCompletions(analysis.symbols);

        return [...this.functionCompletions, ...this.keywordCompletions, ...dynamicItems];
    }

    private provideMemberCompletions(
        document: vscode.TextDocument,
        linePrefix: string
    ): vscode.CompletionItem[] {
        // Extract the identifier before the '.'
        const match = linePrefix.match(/([a-zA-Z_][a-zA-Z0-9_]*)\.\s*$/);
        if (!match) return [];

        const identifierName = match[1];
        const analysis = getAnalysis(document);

        // Look up the variable's type:
        // 1. Try symbol table (global scope)
        // 2. Fall back to variableTypes map (includes params + locals)
        let typeName: string | undefined;
        const sym = analysis.symbolTable.lookup(identifierName);
        if (sym) {
            typeName = analysis.symbolTable.resolveType(sym.type.name);
        } else {
            typeName = analysis.variableTypes.get(identifierName);
        }
        if (!typeName) return [];
        const members = getMemberCompletions(typeName, analysis.symbolTable);

        return members.map(m => {
            const item = new vscode.CompletionItem(m.name, vscode.CompletionItemKind.Field);
            item.detail = m.detail;
            item.sortText = `0_${m.name}`;
            return item;
        });
    }

    private createDynamicCompletions(symbols: DocumentSymbol[]): vscode.CompletionItem[] {
        return symbols.map(sym => {
            let kind: vscode.CompletionItemKind;
            switch (sym.kind) {
                case 'function':
                    kind = vscode.CompletionItemKind.Function;
                    break;
                case 'struct':
                    kind = vscode.CompletionItemKind.Struct;
                    break;
                case 'constant':
                    kind = vscode.CompletionItemKind.Constant;
                    break;
                default:
                    kind = vscode.CompletionItemKind.Variable;
                    break;
            }

            const item = new vscode.CompletionItem(sym.name, kind);
            item.detail = sym.detail || sym.type;

            if (sym.kind === 'function' && sym.detail) {
                // Insert function call with snippet placeholders
                const paramMatch = sym.detail.match(/\(([^)]*)\)/);
                if (paramMatch && paramMatch[1].trim()) {
                    const params = paramMatch[1].split(',').map((p, i) => {
                        const paramName = p.trim().split(/\s+/).pop() || `arg${i}`;
                        return `\${${i + 1}:${paramName}}`;
                    });
                    item.insertText = new vscode.SnippetString(`${sym.name}(${params.join(', ')})`);
                } else {
                    item.insertText = new vscode.SnippetString(`${sym.name}($0)`);
                }
            }

            item.sortText = `2_${sym.name}`; // Sort after static completions
            return item;
        });
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
