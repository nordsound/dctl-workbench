/**
 * Resolve Log Parser
 *
 * Pure functions for parsing DaVinci Resolve debug logs.
 * Extracts DCTL build errors from ResolveDebug.txt format.
 */

import * as os from 'os';
import * as path from 'path';

export interface DctlLogEntry {
    timestamp: string;
    fileName: string;
    errors: string[];
    warnings: string[];
}

/**
 * Parse DCTL build error entries from Resolve debug log text.
 *
 * Log format (fields separated by `||`):
 *   Urgent message: RESIZABLE_ERROR_DLG: DCTL Build Error||[DD.MM.YYYY HH:MM:SS] DCTL/file.dctl compilation failed.||...||Metal Error Message: program_source:LINE:COL: error: MSG||...
 */
export function parseDctlLogEntries(text: string): DctlLogEntry[] {
    if (!text) return [];

    const entries: DctlLogEntry[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
        if (!line.includes('DCTL Build Error')) continue;

        const parts = line.split('||');
        if (parts.length < 2) continue;

        // Extract timestamp and filename from second part:
        // "[20.02.2026 09:19:58] DCTL/sample2.dctl compilation failed."
        const headerMatch = parts[1].match(/\[([^\]]+)\]\s+DCTL\/(\S+)\s+compilation failed/);
        if (!headerMatch) continue;

        const timestamp = headerMatch[1];
        const fileName = headerMatch[2];

        const errors: string[] = [];
        const warnings: string[] = [];

        // Scan remaining parts for Metal/CUDA compiler diagnostics
        for (let i = 2; i < parts.length; i++) {
            const part = parts[i].trim();
            // Match: program_source:LINE:COL: error: MSG  or  program_source:LINE:COL: warning: MSG
            if (/program_source:\d+:\d+:\s*error:/.test(part)) {
                errors.push(part);
            } else if (/program_source:\d+:\d+:\s*warning:/.test(part)) {
                warnings.push(part);
            }
        }

        entries.push({ timestamp, fileName, errors, warnings });
    }

    return entries;
}

/**
 * Format a parsed DCTL log entry for display in an Output Channel.
 */
export function formatDctlLogEntry(entry: DctlLogEntry): string {
    // Extract time portion from "DD.MM.YYYY HH:MM:SS"
    const timePart = entry.timestamp.split(' ').pop() || entry.timestamp;

    const lines: string[] = [];
    lines.push(`[${timePart}] DCTL Build Error: ${entry.fileName}`);

    for (const err of entry.errors) {
        // Simplify: "program_source:1946:22: error: MSG" → "  error: MSG (line 1946)"
        const m = err.match(/program_source:(\d+):\d+:\s*(error:\s*.+)/);
        if (m) {
            lines.push(`  ${m[2]} (line ${m[1]})`);
        } else {
            lines.push(`  ${err}`);
        }
    }

    for (const warn of entry.warnings) {
        const m = warn.match(/program_source:(\d+):\d+:\s*(warning:\s*.+)/);
        if (m) {
            lines.push(`  ${m[2]} (line ${m[1]})`);
        } else {
            lines.push(`  ${warn}`);
        }
    }

    return lines.join('\n');
}

/**
 * Get the default DaVinci Resolve log directory for the current OS.
 */
export function getDefaultResolveLogDirectory(): string {
    const home = os.homedir();
    switch (process.platform) {
        case 'darwin':
            return path.join(home, 'Library', 'Application Support', 'Blackmagic Design', 'DaVinci Resolve', 'logs');
        case 'win32':
            return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'logs');
        case 'linux':
            return path.join(home, '.local', 'share', 'DaVinciResolve', 'logs');
        default:
            return path.join(home, '.local', 'share', 'DaVinciResolve', 'logs');
    }
}
