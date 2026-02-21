/**
 * Resolve Log Watcher
 *
 * Monitors DaVinci Resolve's ResolveDebug.txt for DCTL build errors
 * and outputs them to a VS Code Output Channel.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseDctlLogEntries, formatDctlLogEntry, getDefaultResolveLogDirectory } from './resolveLogParser';

const LOG_FILE_NAME = 'ResolveDebug.txt';

export class ResolveLogWatcher implements vscode.Disposable {
    private outputChannel: vscode.OutputChannel;
    private directoryWatcher: fs.FSWatcher | null = null;
    private fileWatcher: fs.FSWatcher | null = null;
    private offset = 0;
    private _isWatching = false;
    private configListener: vscode.Disposable | null = null;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('DaVinci Resolve Log');
    }

    get isWatching(): boolean {
        return this._isWatching;
    }

    /**
     * Start watching the Resolve log directory.
     */
    async start(): Promise<void> {
        if (this._isWatching) return;

        const logDir = this.getLogDirectory();
        if (!logDir) return;

        // Check if the directory exists
        try {
            await fs.promises.access(logDir, fs.constants.R_OK);
        } catch {
            vscode.window.showWarningMessage(
                `DaVinci Resolve log directory not found: ${logDir}. ` +
                'Check the dctlWorkbench.resolve.logDirectory setting.'
            );
            return;
        }

        this._isWatching = true;
        this.outputChannel.show(true); // Show but don't take focus
        this.outputChannel.appendLine(`Monitoring: ${logDir}`);

        // Watch the directory for file creation/deletion
        this.watchDirectory(logDir);

        // If the log file already exists, start tailing
        const logFilePath = path.join(logDir, LOG_FILE_NAME);
        try {
            await fs.promises.access(logFilePath, fs.constants.R_OK);
            this.outputChannel.appendLine('DaVinci Resolve is running. Watching for DCTL errors...');
            await this.startTailing(logFilePath);
        } catch {
            this.outputChannel.appendLine('Waiting for DaVinci Resolve to start...');
        }

        // Listen for configuration changes
        this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('dctlWorkbench.resolve.logDirectory')) {
                this.outputChannel.appendLine('Log directory setting changed. Restarting monitor...');
                this.stop();
                this.start();
            }
        });
    }

    /**
     * Stop watching.
     */
    stop(): void {
        if (!this._isWatching) return;

        this.stopTailing();
        if (this.directoryWatcher) {
            this.directoryWatcher.close();
            this.directoryWatcher = null;
        }
        if (this.configListener) {
            this.configListener.dispose();
            this.configListener = null;
        }

        this._isWatching = false;
        this.outputChannel.appendLine('Log monitor stopped.');
    }

    dispose(): void {
        this.stop();
        this.outputChannel.dispose();
    }

    private getLogDirectory(): string {
        const config = vscode.workspace.getConfiguration('dctlWorkbench.resolve');
        const userDir = config.get<string>('logDirectory', '');
        return userDir || getDefaultResolveLogDirectory();
    }

    private watchDirectory(logDir: string): void {
        try {
            this.directoryWatcher = fs.watch(logDir, (eventType, filename) => {
                if (filename !== LOG_FILE_NAME) return;

                const logFilePath = path.join(logDir, LOG_FILE_NAME);

                if (eventType === 'rename') {
                    // File appeared or disappeared
                    fs.access(logFilePath, fs.constants.R_OK, (err) => {
                        if (!err && !this.fileWatcher) {
                            // File appeared — Resolve started
                            this.outputChannel.appendLine('DaVinci Resolve started. Watching for DCTL errors...');
                            this.startTailing(logFilePath);
                        } else if (err && this.fileWatcher) {
                            // File disappeared — Resolve stopped
                            this.outputChannel.appendLine('DaVinci Resolve stopped.');
                            this.stopTailing();
                        }
                    });
                } else if (eventType === 'change' && this.fileWatcher) {
                    // File was modified — read new content
                    this.readNewContent(logFilePath);
                }
            });
        } catch (err) {
            this.outputChannel.appendLine(`Failed to watch directory: ${err}`);
        }
    }

    private async startTailing(logFilePath: string): Promise<void> {
        try {
            // Read existing content for DCTL errors
            this.offset = 0;
            await this.readNewContent(logFilePath);

            // Watch the file directly for changes (some OSes need this)
            this.fileWatcher = fs.watch(logFilePath, (eventType) => {
                if (eventType === 'change') {
                    this.readNewContent(logFilePath);
                }
            });
        } catch (err) {
            this.outputChannel.appendLine(`Failed to start tailing: ${err}`);
        }
    }

    private stopTailing(): void {
        if (this.fileWatcher) {
            this.fileWatcher.close();
            this.fileWatcher = null;
        }
        this.offset = 0;
    }

    private async readNewContent(logFilePath: string): Promise<void> {
        try {
            const stat = await fs.promises.stat(logFilePath);
            if (stat.size <= this.offset) return;

            const fd = await fs.promises.open(logFilePath, 'r');
            try {
                const buffer = Buffer.alloc(stat.size - this.offset);
                await fd.read(buffer, 0, buffer.length, this.offset);
                this.offset = stat.size;

                const newContent = buffer.toString('utf-8');
                this.processContent(newContent);
            } finally {
                await fd.close();
            }
        } catch {
            // File may have been moved/deleted between stat and read
        }
    }

    private processContent(content: string): void {
        const entries = parseDctlLogEntries(content);
        for (const entry of entries) {
            const formatted = formatDctlLogEntry(entry);
            this.outputChannel.appendLine(formatted);
        }
    }
}
