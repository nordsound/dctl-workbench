import * as vscode from 'vscode';
import { DCTL_FUNCTION_MAP, DCTL_KEYWORD_MAP, DctlFunctionDoc, DctlKeywordDoc } from './documentation';
import { analyzeDocument, type DocumentAnalysisResult } from '@dctl-workbench/core';
import { analysisCache } from './completionProvider';

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
 * Provides hover information for DCTL files
 */
export class DctlHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        // Get the word at the current position
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);

        // Check if it's a builtin function (static docs take priority)
        const funcDoc = DCTL_FUNCTION_MAP.get(word);
        if (funcDoc) {
            return this.createFunctionHover(funcDoc);
        }

        // Check if it's a keyword/type
        const keywordDoc = DCTL_KEYWORD_MAP.get(word);
        if (keywordDoc) {
            return this.createKeywordHover(keywordDoc);
        }

        // Check user-defined symbols from document analysis
        const analysis = getAnalysis(document);
        const userSymbol = analysis.symbols.find(s => s.name === word);
        if (userSymbol) {
            return this.createUserSymbolHover(userSymbol);
        }

        return null;
    }

    private createUserSymbolHover(sym: { name: string; kind: string; type: string; detail?: string; line: number }): vscode.Hover {
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;

        if (sym.kind === 'function' && sym.detail) {
            markdown.appendCodeblock(sym.detail, 'c');
        } else {
            const prefix = sym.kind === 'struct' ? 'struct' : sym.type;
            markdown.appendCodeblock(`${prefix} ${sym.name}`, 'c');
        }

        const kindLabel = sym.kind === 'variable' ? 'variable'
            : sym.kind === 'function' ? 'function'
            : sym.kind === 'parameter' ? 'parameter'
            : sym.kind === 'struct' ? 'struct'
            : sym.kind === 'constant' ? 'constant'
            : sym.kind;

        markdown.appendMarkdown(`\n*(${kindLabel}) — line ${sym.line}*`);

        return new vscode.Hover(markdown);
    }

    private createFunctionHover(doc: DctlFunctionDoc): vscode.Hover {
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;

        // Signature with syntax highlighting
        markdown.appendCodeblock(doc.signature, 'c');

        // Description
        markdown.appendMarkdown(`\n${doc.description}\n`);

        // Parameters
        if (doc.parameters && doc.parameters.length > 0) {
            markdown.appendMarkdown('\n**Parameters:**\n');
            for (const param of doc.parameters) {
                markdown.appendMarkdown(`- \`${param.name}\` *(${param.type})* - ${param.description}\n`);
            }
        }

        // Returns
        if (doc.returns) {
            markdown.appendMarkdown(`\n**Returns:** ${doc.returns}\n`);
        }

        // Example
        if (doc.example) {
            markdown.appendMarkdown('\n**Example:**\n');
            markdown.appendCodeblock(doc.example, 'c');
        }

        // Category
        markdown.appendMarkdown(`\n*Category: ${doc.category}*`);

        return new vscode.Hover(markdown);
    }

    private createKeywordHover(doc: DctlKeywordDoc): vscode.Hover {
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;

        markdown.appendCodeblock(doc.name, 'c');
        markdown.appendMarkdown(`\n${doc.description}\n`);
        markdown.appendMarkdown(`\n*Category: ${doc.category}*`);

        return new vscode.Hover(markdown);
    }
}
