import * as assert from 'assert';
import { parseDctlLogEntries, formatDctlLogEntry, getDefaultResolveLogDirectory } from '../../resolve/resolveLogParser';

describe('Resolve Log Parser', () => {
    describe('parseDctlLogEntries', () => {
        it('should parse a DCTL Build Error entry', () => {
            const logText = 'Urgent message: RESIZABLE_ERROR_DLG: DCTL Build Error||[20.02.2026 09:19:58] DCTL/sample2.dctl compilation failed.||Failed to load metal library.||Metal Error Code: 3 Domain: MTLLibraryErrorDomain||Metal Error Message: program_source:1946:22: error: use of undeclared identifier \'Center\'||    float x = 0.5f + Center * centerGain + s * SampleSpacing;||                     ^||program_source:1946:48: error: use of undeclared identifier \'SampleSpacing\'||    float x = 0.5f + Center * centerGain + s * SampleSpacing;||                                               ^';

            const entries = parseDctlLogEntries(logText);
            assert.strictEqual(entries.length, 1);

            const entry = entries[0];
            assert.strictEqual(entry.timestamp, '20.02.2026 09:19:58');
            assert.strictEqual(entry.fileName, 'sample2.dctl');
            assert.strictEqual(entry.errors.length, 2);
            assert.ok(entry.errors[0].includes('use of undeclared identifier \'Center\''));
            assert.ok(entry.errors[1].includes('use of undeclared identifier \'SampleSpacing\''));
        });

        it('should extract warnings separately from errors', () => {
            const logText = 'Urgent message: RESIZABLE_ERROR_DLG: DCTL Build Error||[20.02.2026 09:19:58] DCTL/sample2.dctl compilation failed.||Failed to load metal library.||Metal Error Code: 3 Domain: MTLLibraryErrorDomain||Metal Error Message: program_source:1946:22: error: use of undeclared identifier \'Center\'||    float x = 0.5f + Center;||                     ^||program_source:1989:185: warning: unused variable \'LeftPosition\' [-Wunused-variable]||some code here';

            const entries = parseDctlLogEntries(logText);
            assert.strictEqual(entries.length, 1);
            assert.strictEqual(entries[0].errors.length, 1);
            assert.strictEqual(entries[0].warnings.length, 1);
            assert.ok(entries[0].warnings[0].includes('unused variable \'LeftPosition\''));
        });

        it('should ignore non-DCTL log lines', () => {
            const logText = [
                '0x2057f7080    | SyManager            | WARN  | 2026-02-20 09:19:56,925 | No reply received from file system',
                '0x2057f7080    | UI.GLDispShader      | INFO  | 2026-02-20 09:20:03,876 | Created 1D LUT texture for LUT size 16384',
                '0x2057f7080    | Main                 | INFO  | 2026-02-20 09:20:07,983 | Application state changed to Inactive',
            ].join('\n');

            const entries = parseDctlLogEntries(logText);
            assert.strictEqual(entries.length, 0);
        });

        it('should handle multiple DCTL entries in one text block', () => {
            const logText = [
                'Urgent message: RESIZABLE_ERROR_DLG: DCTL Build Error||[20.02.2026 09:19:58] DCTL/first.dctl compilation failed.||Failed to load metal library.||Metal Error Code: 3 Domain: MTLLibraryErrorDomain||Metal Error Message: program_source:10:5: error: unknown type \'foo\'',
                '0x2057f7080    | SyManager            | INFO  | 2026-02-20 09:20:00,000 | Some info',
                'Urgent message: RESIZABLE_ERROR_DLG: DCTL Build Error||[20.02.2026 09:20:01] DCTL/second.dctl compilation failed.||Failed to load metal library.||Metal Error Code: 3 Domain: MTLLibraryErrorDomain||Metal Error Message: program_source:20:10: error: redefinition of \'bar\'',
            ].join('\n');

            const entries = parseDctlLogEntries(logText);
            assert.strictEqual(entries.length, 2);
            assert.strictEqual(entries[0].fileName, 'first.dctl');
            assert.strictEqual(entries[1].fileName, 'second.dctl');
        });

        it('should handle empty input', () => {
            const entries = parseDctlLogEntries('');
            assert.strictEqual(entries.length, 0);
        });
    });

    describe('formatDctlLogEntry', () => {
        it('should format entry with errors and warnings', () => {
            const entry = {
                timestamp: '20.02.2026 09:19:58',
                fileName: 'sample2.dctl',
                errors: [
                    'program_source:1946:22: error: use of undeclared identifier \'Center\'',
                    'program_source:1948:24: error: use of undeclared identifier \'LeftPosition\'',
                ],
                warnings: [
                    'program_source:1989:185: warning: unused variable \'LeftPosition\' [-Wunused-variable]',
                ],
            };

            const formatted = formatDctlLogEntry(entry);
            assert.ok(formatted.includes('[09:19:58]'));
            assert.ok(formatted.includes('sample2.dctl'));
            assert.ok(formatted.includes('error:'));
            assert.ok(formatted.includes('warning:'));
        });

        it('should format entry with only errors', () => {
            const entry = {
                timestamp: '20.02.2026 09:19:58',
                fileName: 'test.dctl',
                errors: ['program_source:10:5: error: unknown type \'foo\''],
                warnings: [],
            };

            const formatted = formatDctlLogEntry(entry);
            assert.ok(formatted.includes('test.dctl'));
            assert.ok(formatted.includes('error:'));
            assert.ok(!formatted.includes('warning:'));
        });
    });

    describe('getDefaultResolveLogDirectory', () => {
        it('should return a non-empty string', () => {
            const dir = getDefaultResolveLogDirectory();
            assert.ok(dir.length > 0);
        });

        it('should contain platform-appropriate path', () => {
            const dir = getDefaultResolveLogDirectory();
            // On macOS, should contain Library/Application Support
            if (process.platform === 'darwin') {
                assert.ok(dir.includes('Library/Application Support/Blackmagic Design/DaVinci Resolve/logs'));
            }
        });
    });
});
