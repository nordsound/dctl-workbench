#!/usr/bin/env node
/**
 * DCTL CLI - Apply DCTL effects to EXR images using WebGPU
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';

// Import from core package
import {
    DctlRuntime,
    isCompileError,
    initOCIO,
    isOCIOInitialized,
    OCIOProcessor,
    extractCustomOcioExportShaders,
    buildCustomOcioBufferComputeShader,
} from '@dctl-workbench/core';

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
    .option('--ocio-config <path>', 'Custom OCIO config file (.ocio). Overrides built-in ACES pipeline')
    .option('--source-space <name>', 'Source color space name from the OCIO config (required with --ocio-config)')
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

program
    .command('check')
    .description('Check a DCTL file for errors (like VS Code diagnostics)')
    .argument('<dctl>', 'Path to the DCTL file')
    .option('--include <dirs...>', 'Additional include directories for DCTL')
    .action(async (dctl: string, options) => {
        try {
            const exitCode = await checkDctl(dctl, options);
            process.exit(exitCode);
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
        ocioConfig?: string;
        sourceSpace?: string;
        include?: string[];
    }
): Promise<void> {
    // Custom OCIO mode
    if (options.ocioConfig) {
        return applyDctlCustomOcio(dctlPath, inputPath, outputPath, options);
    }

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
 * Apply DCTL with custom OCIO config
 * Pipeline: source → working (OCIO) → DCTL → working → source (OCIO)
 */
async function applyDctlCustomOcio(
    dctlPath: string,
    inputPath: string,
    outputPath: string,
    options: {
        param?: string[];
        workingSpace?: string;
        ocioConfig?: string;
        sourceSpace?: string;
        include?: string[];
    }
): Promise<void> {
    const ocioConfigPath = path.resolve(options.ocioConfig!);
    if (!fs.existsSync(ocioConfigPath)) {
        throw new Error(`OCIO config file not found: ${ocioConfigPath}`);
    }

    const workingSpace = options.workingSpace || '';
    const sourceSpace = options.sourceSpace || '';

    console.log(`Applying DCTL (Custom OCIO mode): ${dctlPath}`);
    console.log(`OCIO config: ${ocioConfigPath}`);
    console.log(`Input: ${inputPath}`);
    console.log(`Output: ${outputPath}`);

    // Initialize runtime (WASM modules)
    const runtime = new DctlRuntime();
    const wasmPath = getWasmPath();
    await runtime.init({ wasmPath });

    // Initialize OCIO
    if (!isOCIOInitialized()) {
        await initOCIO(wasmPath);
    }

    // Determine source and working color spaces from the OCIO config
    const tempProcessor = new OCIOProcessor();
    try {
        if (!tempProcessor.initFromFile(ocioConfigPath)) {
            throw new Error(`Failed to load OCIO config: ${ocioConfigPath}`);
        }

        const colorSpaces = tempProcessor.getColorSpaces();
        const sceneReferred = colorSpaces.filter(cs => tempProcessor.isSceneReferred(cs));

        // Resolve source space
        let resolvedSourceSpace = sourceSpace;
        if (!resolvedSourceSpace) {
            if (sceneReferred.length > 0) {
                resolvedSourceSpace = sceneReferred[0];
            } else if (colorSpaces.length > 0) {
                resolvedSourceSpace = colorSpaces[0];
            } else {
                throw new Error('No color spaces found in OCIO config');
            }
            console.log(`Source space (auto): ${resolvedSourceSpace}`);
        } else {
            if (!colorSpaces.includes(resolvedSourceSpace)) {
                throw new Error(`Source space '${resolvedSourceSpace}' not found in OCIO config. Available: ${colorSpaces.join(', ')}`);
            }
            console.log(`Source space: ${resolvedSourceSpace}`);
        }

        // Resolve working space
        let resolvedWorkingSpace = workingSpace;
        if (!resolvedWorkingSpace) {
            resolvedWorkingSpace = sceneReferred.length > 1 ? sceneReferred[1] : resolvedSourceSpace;
            console.log(`Working space (auto): ${resolvedWorkingSpace}`);
        } else {
            if (!colorSpaces.includes(resolvedWorkingSpace)) {
                throw new Error(`Working space '${resolvedWorkingSpace}' not found in OCIO config. Available: ${colorSpaces.join(', ')}`);
            }
            console.log(`Working space: ${resolvedWorkingSpace}`);
        }

        tempProcessor.dispose();

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

        // Parse parameter values
        const paramValues: Record<string, number> = {};
        for (const param of compileResult.parameters) {
            if (param.param_type.type === 'float' || param.param_type.type === 'int' || param.param_type.type === 'combo') {
                paramValues[param.name] = param.param_type.default;
            } else if (param.param_type.type === 'bool') {
                paramValues[param.name] = param.param_type.default ? 1 : 0;
            }
        }
        if (options.param) {
            for (const p of options.param) {
                const [name, value] = p.split('=');
                if (name && value !== undefined) {
                    paramValues[name] = parseFloat(value);
                }
            }
        }
        console.log('Parameter values:', paramValues);

        // Extract custom OCIO export shaders (source→working + working→source)
        console.log('Extracting custom OCIO shaders...');
        const extractedShaders = extractCustomOcioExportShaders(ocioConfigPath, {
            sourceColorSpace: resolvedSourceSpace,
            workingColorSpace: resolvedWorkingSpace,
        });

        if (!extractedShaders.success) {
            throw new Error(`Failed to extract OCIO shaders: ${extractedShaders.error}`);
        }

        // Build buffer-based compute shader with custom OCIO
        console.log('Building custom OCIO compute shader...');
        const shaderResult = await buildCustomOcioBufferComputeShader(
            wasmPath,
            extractedShaders,
            compileResult,
            {
                width: exrData.width,
                height: exrData.height,
                paramValues,
            }
        );

        if (!shaderResult.success) {
            throw new Error(`Failed to build compute shader: ${shaderResult.error}`);
        }

        console.log(`Compute shader: ${shaderResult.computeWgsl.length} chars`);

        // Prepare OCIO LUT textures for the subprocess renderer
        const ocioTextures: RgcTextureInfo[] = [];

        for (const tex of shaderResult.textures) {
            const texData = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
            const channels = tex.channel === 0 ? 1 : 3;
            ocioTextures.push({
                name: tex.samplerName,
                type: '2d',
                width: tex.width,
                height: tex.height,
                channels,
                data: texData,
            });
        }

        for (const tex of shaderResult.textures3D) {
            const texData = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
            ocioTextures.push({
                name: tex.samplerName,
                type: '3d',
                width: tex.edgeLen,
                height: tex.edgeLen,
                depth: tex.edgeLen,
                channels: 3,
                data: texData,
            });
        }

        console.log(`OCIO LUT textures: ${ocioTextures.length}`);

        // Apply DCTL effect using subprocess renderer
        console.log('Applying DCTL effect (custom OCIO)...');
        const renderer = new SubprocessRenderer();
        const outputData = await renderer.renderWithTextures(
            shaderResult.computeWgsl,
            exrData.data,
            exrData.width,
            exrData.height,
            ocioTextures
        );
        console.log('Render complete, output size:', outputData.length);

        // Write output EXR (not ACES — output is in OCIO source color space)
        console.log('Writing output EXR...');
        await runtime.writeExr(path.resolve(outputPath), {
            width: exrData.width,
            height: exrData.height,
            channels: 3,
            data: outputData,
            compression: 'PIZ',
            aces: false,
        });

        console.log(`Output written: ${outputPath} (color space: ${resolvedSourceSpace})`);
    } catch (err) {
        tempProcessor.dispose();
        throw err;
    }
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

/**
 * Check DCTL file for errors (mimics VS Code diagnostics pipeline)
 * Returns exit code: 0 = no errors, 1 = has errors
 */
async function checkDctl(
    dctlPath: string,
    options: {
        include?: string[];
    }
): Promise<number> {
    const resolvedPath = path.resolve(dctlPath);

    // Initialize runtime
    const runtime = new DctlRuntime();
    const wasmPath = getWasmPath();
    await runtime.init({ wasmPath });

    // Read DCTL source
    const dctlSource = fs.readFileSync(resolvedPath, 'utf-8');

    // Compile DCTL with includes
    const includeDirs = options.include || [];
    includeDirs.unshift(path.dirname(resolvedPath));

    const compileResult = await runtime.compileWithIncludes(dctlSource, {
        includeDirs,
        mainFilePath: resolvedPath,
    });

    let errorCount = 0;
    let warningCount = 0;

    if (isCompileError(compileResult)) {
        console.error(`\x1b[31mERROR\x1b[0m ${compileResult.message}`);
        errorCount++;
    } else {
        // Show diagnostics
        for (const diag of compileResult.diagnostics) {
            const isError = diag.severity === 'error';
            if (isError) {
                errorCount++;
                const loc = diag.line > 0 ? `:${diag.line}:${diag.column}` : '';
                console.error(`\x1b[31mERROR\x1b[0m${loc} ${diag.message}`);
            } else {
                warningCount++;
                const loc = diag.line > 0 ? `:${diag.line}:${diag.column}` : '';
                console.warn(`\x1b[33mWARN\x1b[0m${loc} ${diag.message}`);
            }
        }

        // Summary
        const wgslSize = compileResult.wgsl.length;
        console.log(
            `\n${path.basename(dctlPath)}: ` +
            `${errorCount} error(s), ${warningCount} warning(s), ` +
            `${wgslSize} bytes WGSL`
        );
    }

    return errorCount > 0 ? 1 : 0;
}

program.parse();
