#!/usr/bin/env node
/**
 * DCTL CLI - Apply DCTL effects to EXR images using WebGPU
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';

// Import from core package
import { DctlRuntime, isCompileError } from '@dctl-workbench/core';

// Import local modules
import { SubprocessRenderer, type RgcTextureInfo } from './subprocess-renderer.js';
import { buildBufferComputeShader, buildBufferComputeShaderWithRgc } from './shader-builder.js';
import { buildRgcShader } from './rgc-shader-builder.js';

const program = new Command();

program
    .name('dctlw')
    .description('CLI tool for applying DCTL effects to EXR images')
    .version('0.1.0');

// Supported color spaces
const COLOR_SPACES = ['AP0', 'AP1', 'ACEScct', 'ACEScc', 'sRGB', 'Rec709'] as const;
type ColorSpace = typeof COLOR_SPACES[number];

program
    .command('apply')
    .description('Apply a DCTL effect to an EXR image')
    .argument('<dctl>', 'Path to the DCTL file')
    .argument('<input>', 'Path to the input EXR file')
    .argument('<output>', 'Path to the output EXR file')
    .option('-p, --param <params...>', 'Set parameter values (e.g., -p gain=1.5 -p mode=1)')
    .option('-i, --input-space <space>', 'Input color space (AP0, AP1, ACEScct, ACEScc, sRGB, Rec709)', 'AP0')
    .option('-o, --output-space <space>', 'Output color space (AP0, AP1, ACEScct, ACEScc, sRGB, Rec709)', 'AP0')
    .option('-w, --working-space <space>', 'Working color space for DCTL (ACEScct, ACEScc, AP1)', 'ACEScct')
    .option('--rgc', 'Apply ACES 2.0 Reference Gamut Compression (RGC) using OCIO')
    .option('--peak-luminance <nits>', 'Peak luminance for RGC in nits (100, 500, 1000, 2000, 4000)', '100')
    .option('--include <dirs...>', 'Additional include directories for DCTL')
    .action(async (dctl: string, input: string, output: string, options) => {
        try {
            await applyDctl(dctl, input, output, options);
        } catch (err) {
            console.error('Error:', err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

program
    .command('compile')
    .description('Compile a DCTL file to WGSL (for debugging)')
    .argument('<dctl>', 'Path to the DCTL file')
    .option('-o, --output <file>', 'Output WGSL file (default: stdout)')
    .option('--include <dirs...>', 'Additional include directories for DCTL')
    .action(async (dctl: string, options) => {
        try {
            await compileDctl(dctl, options);
        } catch (err) {
            console.error('Error:', err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

program
    .command('info')
    .description('Show information about a DCTL file')
    .argument('<dctl>', 'Path to the DCTL file')
    .action(async (dctl: string) => {
        try {
            await showInfo(dctl);
        } catch (err) {
            console.error('Error:', err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    });

/**
 * Get the WASM path for the runtime
 */
function getWasmPath(): string {
    // Look for WASM files relative to this package
    const possiblePaths = [
        path.join(__dirname, '../../wasm'),
        path.join(__dirname, '../../../wasm'),
        path.join(__dirname, '../../../../wasm'),
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(path.join(p, 'dctl-compiler'))) {
            return path.dirname(p);
        }
    }

    // Fallback to parent directory
    return path.join(__dirname, '../../..');
}

/**
 * Apply DCTL to an EXR image
 */
async function applyDctl(
    dctlPath: string,
    inputPath: string,
    outputPath: string,
    options: {
        param?: string[];
        inputSpace?: string;
        outputSpace?: string;
        workingSpace?: string;
        rgc?: boolean;
        peakLuminance?: string;
        include?: string[];
    }
): Promise<void> {
    const inputSpace = options.inputSpace || 'AP0';
    const outputSpace = options.outputSpace || 'AP0';
    const workingSpace = options.workingSpace || 'ACEScct';
    const applyRgc = options.rgc || false;
    const peakLuminance = parseInt(options.peakLuminance || '100', 10);

    console.log(`Applying DCTL: ${dctlPath}`);
    console.log(`Input: ${inputPath} (${inputSpace})`);
    console.log(`Output: ${outputPath} (${outputSpace})`);
    console.log(`Working space: ${workingSpace}`);
    if (applyRgc) {
        console.log(`RGC: enabled (peak luminance: ${peakLuminance} nits)`);
    } else {
        console.log(`RGC: disabled`);
    }

    // Initialize runtime (WASM modules)
    const runtime = new DctlRuntime();
    const wasmPath = getWasmPath();
    await runtime.init({ wasmPath });

    // Read DCTL source
    const dctlSource = fs.readFileSync(path.resolve(dctlPath), 'utf-8');

    // Compile DCTL with includes
    const includeDirs = options.include || [];
    includeDirs.unshift(path.dirname(path.resolve(dctlPath)));

    const compileResult = await runtime.compileWithIncludes(dctlSource, {
        includeDirs,
        mainFilePath: path.resolve(dctlPath),
    });

    if (isCompileError(compileResult)) {
        throw new Error(`DCTL compilation failed: ${compileResult.message}`);
    }

    console.log(`DCTL compiled: ${compileResult.wgsl.length} chars WGSL`);
    console.log(`Parameters: ${compileResult.parameters.length}`);

    // Read input EXR
    const exrData = await runtime.readExr(path.resolve(inputPath));
    console.log(`Input image: ${exrData.width}x${exrData.height}, channels: ${exrData.channels.join(', ')}`);

    // Parse parameter values - start with defaults from compile result
    const paramValues: Record<string, number> = {};

    // Initialize with default values from DCTL parameters
    for (const param of compileResult.parameters) {
        if (param.param_type.type === 'float' || param.param_type.type === 'int' || param.param_type.type === 'combo') {
            paramValues[param.name] = param.param_type.default;
        } else if (param.param_type.type === 'bool') {
            paramValues[param.name] = param.param_type.default ? 1 : 0;
        }
    }

    // Override with user-provided values
    if (options.param) {
        for (const p of options.param) {
            const [name, value] = p.split('=');
            if (name && value !== undefined) {
                paramValues[name] = parseFloat(value);
            }
        }
    }

    console.log('Parameter values:', paramValues);

    // Build compute shader
    let computeShader: string;
    let rgcTextures: RgcTextureInfo[] = [];

    if (applyRgc) {
        // Full RGC mode: extract shader from OCIO
        console.log('Building OCIO RGC shader...');
        const rgcResult = await buildRgcShader(runtime, wasmPath, peakLuminance);

        if (!rgcResult.success) {
            throw new Error(`RGC initialization failed: ${rgcResult.error}`);
        }

        console.log(`RGC shader: ${rgcResult.wgslFunctions.length} chars, ${rgcResult.textures.length} textures`);

        // Build shader with RGC
        computeShader = buildBufferComputeShaderWithRgc(compileResult, {
            width: exrData.width,
            height: exrData.height,
            paramValues,
            inputColorSpace: inputSpace,
            outputColorSpace: outputSpace,
            workingColorSpace: workingSpace,
            rgcWgslFunctions: rgcResult.wgslFunctions,
            rgcMainFunctionName: rgcResult.mainFunctionName,
            rgcTextureBindings: rgcResult.textureBindings,
        });

        rgcTextures = rgcResult.textures;
    } else {
        // No RGC
        computeShader = buildBufferComputeShader(compileResult, {
            width: exrData.width,
            height: exrData.height,
            paramValues,
            inputColorSpace: inputSpace,
            outputColorSpace: outputSpace,
            workingColorSpace: workingSpace,
        });
    }

    console.log(`Compute shader: ${computeShader.length} chars`);

    // Apply DCTL effect using subprocess renderer
    // (Subprocess isolates WebGPU from WASM to avoid crashes)
    console.log('Applying DCTL effect...');
    const renderer = new SubprocessRenderer();
    const outputData = await renderer.renderWithTextures(
        computeShader,
        exrData.data,
        exrData.width,
        exrData.height,
        rgcTextures
    );
    console.log('Render complete, output size:', outputData.length);

    // Write output EXR
    console.log('Writing output EXR...');
    const isAcesOutput = outputSpace === 'AP0' || outputSpace === 'AP1';
    await runtime.writeExr(path.resolve(outputPath), {
        width: exrData.width,
        height: exrData.height,
        channels: 3,
        data: outputData,
        compression: 'PIZ',
        aces: isAcesOutput,
    });

    console.log(`Output written: ${outputPath}`);
}

/**
 * Compile DCTL to WGSL
 */
async function compileDctl(
    dctlPath: string,
    options: {
        output?: string;
        include?: string[];
    }
): Promise<void> {
    // Initialize runtime
    const runtime = new DctlRuntime();
    const wasmPath = getWasmPath();
    await runtime.init({ wasmPath });

    // Read DCTL source
    const dctlSource = fs.readFileSync(path.resolve(dctlPath), 'utf-8');

    // Compile DCTL with includes
    const includeDirs = options.include || [];
    includeDirs.unshift(path.dirname(path.resolve(dctlPath)));

    const compileResult = await runtime.compileWithIncludes(dctlSource, {
        includeDirs,
        mainFilePath: path.resolve(dctlPath),
    });

    if (isCompileError(compileResult)) {
        throw new Error(`DCTL compilation failed: ${compileResult.message}`);
    }

    // Output WGSL
    if (options.output) {
        fs.writeFileSync(path.resolve(options.output), compileResult.wgsl);
        console.log(`WGSL written to: ${options.output}`);
    } else {
        console.log(compileResult.wgsl);
    }
}

/**
 * Show DCTL file information
 */
async function showInfo(dctlPath: string): Promise<void> {
    // Initialize runtime
    const runtime = new DctlRuntime();
    const wasmPath = getWasmPath();
    await runtime.init({ wasmPath });

    // Read DCTL source
    const dctlSource = fs.readFileSync(path.resolve(dctlPath), 'utf-8');

    // Compile DCTL
    const compileResult = await runtime.compileWithIncludes(dctlSource, {
        includeDirs: [path.dirname(path.resolve(dctlPath))],
        mainFilePath: path.resolve(dctlPath),
    });

    if (isCompileError(compileResult)) {
        throw new Error(`DCTL compilation failed: ${compileResult.message}`);
    }

    console.log(`File: ${dctlPath}`);
    console.log(`WGSL size: ${compileResult.wgsl.length} chars`);
    console.log(`Parameters: ${compileResult.parameters.length}`);

    if (compileResult.parameters.length > 0) {
        console.log('\nUI Parameters:');
        for (const param of compileResult.parameters) {
            console.log(`  ${param.name}: ${param.label}`);
            console.log(`    Type: ${param.param_type.type}`);
            if ('default' in param.param_type) {
                console.log(`    Default: ${param.param_type.default}`);
            }
            if ('min' in param.param_type && 'max' in param.param_type) {
                console.log(`    Range: ${param.param_type.min} - ${param.param_type.max}`);
            }
        }
    }
}

program.parse();
