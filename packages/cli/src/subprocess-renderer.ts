/**
 * Subprocess WebGPU Renderer
 *
 * Runs WebGPU in a separate process to avoid conflicts with WASM modules.
 * Supports both buffer-based and texture-based pipelines (for RGC LUTs).
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface RgcTextureInfo {
    name: string;
    type: '2d' | '3d';
    width: number;
    height: number;
    depth?: number;
    /** Number of channels: 1 for single-channel (R), 3 for RGB */
    channels: number;
    data: Float32Array;
}

interface TextureFileInfo {
    name: string;
    type: '2d' | '3d';
    width: number;
    height: number;
    depth?: number;
    /** Number of channels: 1 for single-channel (R), 3 for RGB */
    channels: number;
    dataPath: string;
}

export class SubprocessRenderer {
    private workerPath: string;
    /** Stderr output from the last worker invocation (for diagnostics) */
    public lastStderr: string = '';

    constructor() {
        this.workerPath = path.join(__dirname, 'gpu-worker.js');
    }

    /**
     * Render using a compute shader via subprocess
     */
    async render(
        wgsl: string,
        inputData: Float32Array,
        width: number,
        height: number
    ): Promise<Float32Array> {
        return this.renderWithTextures(wgsl, inputData, width, height, []);
    }

    /**
     * Render using a compute shader with RGC textures via subprocess
     */
    async renderWithTextures(
        wgsl: string,
        inputData: Float32Array,
        width: number,
        height: number,
        rgcTextures: RgcTextureInfo[]
    ): Promise<Float32Array> {
        // Create temp files for data transfer
        const tmpDir = os.tmpdir();
        const timestamp = Date.now();
        const shaderPath = path.join(tmpDir, `dctl_shader_${timestamp}.wgsl`);
        const inputPath = path.join(tmpDir, `dctl_input_${timestamp}.raw`);
        const outputPath = path.join(tmpDir, `dctl_output_${timestamp}.raw`);

        // Track temp files for cleanup
        const tempFiles: string[] = [shaderPath, inputPath, outputPath];

        try {
            // Write shader and input data to temp files
            fs.writeFileSync(shaderPath, wgsl);
            fs.writeFileSync(inputPath, Buffer.from(inputData.buffer, inputData.byteOffset, inputData.byteLength));

            // Write texture data to temp files
            const textureInfos: TextureFileInfo[] = [];
            for (let i = 0; i < rgcTextures.length; i++) {
                const tex = rgcTextures[i];
                const texPath = path.join(tmpDir, `dctl_tex_${timestamp}_${i}.raw`);
                fs.writeFileSync(texPath, Buffer.from(tex.data.buffer, tex.data.byteOffset, tex.data.byteLength));
                tempFiles.push(texPath);

                textureInfos.push({
                    name: tex.name,
                    type: tex.type,
                    width: tex.width,
                    height: tex.height,
                    depth: tex.depth,
                    channels: tex.channels,
                    dataPath: texPath,
                });
            }

            // Prepare request
            const request = {
                shaderPath,
                inputPath,
                outputPath,
                width,
                height,
                rgcTextures: textureInfos.length > 0 ? textureInfos : undefined,
                useTextures: textureInfos.length > 0,
            };

            // Spawn worker process
            const result = await this.runWorker(request);
            this.lastStderr = result.stderr || '';

            if (!result.success) {
                throw new Error(result.error || 'GPU worker failed');
            }

            // Read output
            const outputBuffer = fs.readFileSync(outputPath);
            const outputData = new Float32Array(
                outputBuffer.buffer,
                outputBuffer.byteOffset,
                outputBuffer.length / 4
            );

            return new Float32Array(outputData);
        } finally {
            // Cleanup temp files
            for (const filePath of tempFiles) {
                try {
                    fs.unlinkSync(filePath);
                } catch {
                    // Ignore cleanup errors
                }
            }
        }
    }

    private runWorker(request: {
        shaderPath: string;
        inputPath: string;
        outputPath: string;
        width: number;
        height: number;
        rgcTextures?: TextureFileInfo[];
        useTextures?: boolean;
    }): Promise<{ success: boolean; error?: string; size?: number; stderr?: string }> {
        return new Promise((resolve, reject) => {
            const child = spawn('node', [this.workerPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`GPU worker exited with code ${code}: ${stderr}`));
                    return;
                }

                try {
                    const result = JSON.parse(stdout.trim());
                    if (stderr) {
                        result.stderr = stderr;
                    }
                    resolve(result);
                } catch {
                    reject(new Error(`Failed to parse GPU worker output: ${stdout}`));
                }
            });

            child.on('error', (err) => {
                reject(err);
            });

            // Send request via stdin
            child.stdin.write(JSON.stringify(request));
            child.stdin.end();
        });
    }
}
