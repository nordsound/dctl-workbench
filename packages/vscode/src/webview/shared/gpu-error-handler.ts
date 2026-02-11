/**
 * GPU Error Handler
 *
 * Provides unified error handling for WebGPU operations.
 * Handles device lost, out-of-memory, validation errors, and uncaptured errors.
 */

// ============================================
// Types
// ============================================

export type GPUErrorType = 'device-lost' | 'out-of-memory' | 'validation' | 'internal' | 'shader-compilation';

export type GPUCompilationMessageType = 'error' | 'warning' | 'info';

export interface ShaderCompilationResult {
    module: GPUShaderModule;
    hasErrors: boolean;
    hasWarnings: boolean;
    errors: GPUCompilationMessage[];
    warnings: GPUCompilationMessage[];
    infos: GPUCompilationMessage[];
}

export interface GPUErrorEvent {
    type: GPUErrorType;
    message: string;
    recoverable: boolean;
}

export interface GPUErrorHandlerOptions {
    /** Logging function */
    log: (message: string) => void;
    /** Callback when any GPU error occurs */
    onError?: (event: GPUErrorEvent) => void;
    /** Callback specifically for device lost (for UI notification) */
    onDeviceLost?: (reason: string, message: string) => void;
    /** Callback specifically for out-of-memory (for UI notification) */
    onOutOfMemory?: (message: string) => void;
}

export interface GPUErrorHandler {
    /** Attach error handlers to a device */
    attachToDevice(device: GPUDevice): void;
    /** Detach error handlers (call before device destruction) */
    detach(): void;
    /** Check if currently attached to a device */
    isAttached(): boolean;

    /** Safely create a texture with OOM detection */
    safeCreateTexture(
        device: GPUDevice,
        descriptor: GPUTextureDescriptor
    ): Promise<GPUTexture | null>;

    /** Safely create a buffer with OOM detection */
    safeCreateBuffer(
        device: GPUDevice,
        descriptor: GPUBufferDescriptor
    ): Promise<GPUBuffer | null>;

    /** Wrap an operation with error scope for validation errors */
    withValidationScope<T>(
        device: GPUDevice,
        operation: () => T,
        context?: string
    ): Promise<{ result: T; error: GPUError | null }>;
}

// ============================================
// Implementation
// ============================================

export function createGPUErrorHandler(options: GPUErrorHandlerOptions): GPUErrorHandler {
    const { log, onError, onDeviceLost, onOutOfMemory } = options;

    let attachedDevice: GPUDevice | null = null;
    let uncapturedErrorHandler: ((event: GPUUncapturedErrorEvent) => void) | null = null;

    function handleError(event: GPUErrorEvent): void {
        log(`[GPU Error] ${event.type}: ${event.message} (recoverable: ${event.recoverable})`);
        onError?.(event);
    }

    function handleDeviceLost(info: GPUDeviceLostInfo): void {
        const reason = info.reason || 'unknown';
        const message = info.message || 'Device was lost';

        log(`[GPU] Device lost - reason: ${reason}, message: ${message}`);

        handleError({
            type: 'device-lost',
            message: `${reason}: ${message}`,
            recoverable: reason !== 'destroyed', // Can recover if not intentionally destroyed
        });

        onDeviceLost?.(reason, message);
        attachedDevice = null;
    }

    function handleUncapturedError(event: GPUUncapturedErrorEvent): void {
        const error = event.error;
        let errorType: GPUErrorType = 'validation';
        let recoverable = true;

        if (error instanceof GPUOutOfMemoryError) {
            errorType = 'out-of-memory';
            recoverable = false;
            onOutOfMemory?.(error.message);
        } else if (error instanceof GPUValidationError) {
            errorType = 'validation';
            recoverable = true;
        } else if (error instanceof GPUInternalError) {
            errorType = 'internal';
            recoverable = false;
        }

        handleError({
            type: errorType,
            message: error.message,
            recoverable,
        });
    }

    return {
        attachToDevice(device: GPUDevice): void {
            if (attachedDevice) {
                log('[GPU Error Handler] Already attached to a device, detaching first');
                this.detach();
            }

            attachedDevice = device;

            // Monitor device lost
            device.lost.then(handleDeviceLost);

            // Monitor uncaptured errors
            uncapturedErrorHandler = handleUncapturedError;
            device.addEventListener('uncapturederror', uncapturedErrorHandler);

            log('[GPU Error Handler] Attached to device');
        },

        detach(): void {
            if (attachedDevice && uncapturedErrorHandler) {
                attachedDevice.removeEventListener('uncapturederror', uncapturedErrorHandler);
                uncapturedErrorHandler = null;
            }
            attachedDevice = null;
            log('[GPU Error Handler] Detached from device');
        },

        isAttached(): boolean {
            return attachedDevice !== null;
        },

        async safeCreateTexture(
            device: GPUDevice,
            descriptor: GPUTextureDescriptor
        ): Promise<GPUTexture | null> {
            device.pushErrorScope('out-of-memory');

            const texture = device.createTexture(descriptor);

            const error = await device.popErrorScope();
            if (error) {
                const msg = `Failed to create texture (${descriptor.size}): ${error.message}`;
                log(`[GPU] ${msg}`);
                handleError({
                    type: 'out-of-memory',
                    message: msg,
                    recoverable: false,
                });
                onOutOfMemory?.(msg);
                return null;
            }

            return texture;
        },

        async safeCreateBuffer(
            device: GPUDevice,
            descriptor: GPUBufferDescriptor
        ): Promise<GPUBuffer | null> {
            device.pushErrorScope('out-of-memory');

            const buffer = device.createBuffer(descriptor);

            const error = await device.popErrorScope();
            if (error) {
                const msg = `Failed to create buffer (${descriptor.size} bytes): ${error.message}`;
                log(`[GPU] ${msg}`);
                handleError({
                    type: 'out-of-memory',
                    message: msg,
                    recoverable: false,
                });
                onOutOfMemory?.(msg);
                return null;
            }

            return buffer;
        },

        async withValidationScope<T>(
            device: GPUDevice,
            operation: () => T,
            context?: string
        ): Promise<{ result: T; error: GPUError | null }> {
            device.pushErrorScope('validation');

            const result = operation();

            const error = await device.popErrorScope();
            if (error) {
                const msg = context
                    ? `Validation error in ${context}: ${error.message}`
                    : `Validation error: ${error.message}`;
                log(`[GPU] ${msg}`);
                handleError({
                    type: 'validation',
                    message: msg,
                    recoverable: true,
                });
            }

            return { result, error };
        },
    };
}

// ============================================
// Shader Compilation Utilities
// ============================================

export interface CompileShaderOptions {
    /** Device to create shader module on */
    device: GPUDevice;
    /** WGSL shader code */
    code: string;
    /** Label for the shader module (for debugging) */
    label?: string;
    /** Logging function */
    log?: (message: string) => void;
    /** Whether to throw on compilation errors (default: true) */
    throwOnError?: boolean;
}

/**
 * Compile a shader with detailed compilation info
 *
 * Uses GPUShaderModule.getCompilationInfo() to provide detailed
 * error and warning messages with line numbers.
 */
export async function compileShader(options: CompileShaderOptions): Promise<ShaderCompilationResult> {
    const { device, code, label, log, throwOnError = true } = options;

    const module = device.createShaderModule({
        code,
        label,
    });

    const compilationInfo = await module.getCompilationInfo();

    const errors: GPUCompilationMessage[] = [];
    const warnings: GPUCompilationMessage[] = [];
    const infos: GPUCompilationMessage[] = [];

    for (const message of compilationInfo.messages) {
        switch (message.type) {
            case 'error':
                errors.push(message);
                break;
            case 'warning':
                warnings.push(message);
                break;
            case 'info':
                infos.push(message);
                break;
        }
    }

    // Log compilation messages
    if (log) {
        const shaderName = label || 'Shader';

        if (errors.length > 0) {
            log(`[Shader] ${shaderName} compilation errors:`);
            for (const err of errors) {
                log(`  [ERROR] Line ${err.lineNum}:${err.linePos}: ${err.message}`);
            }
        }

        if (warnings.length > 0) {
            log(`[Shader] ${shaderName} compilation warnings:`);
            for (const warn of warnings) {
                log(`  [WARN] Line ${warn.lineNum}:${warn.linePos}: ${warn.message}`);
            }
        }

        if (errors.length === 0 && warnings.length === 0) {
            log(`[Shader] ${shaderName} compiled successfully`);
        }
    }

    // Throw if there are errors
    if (throwOnError && errors.length > 0) {
        const errorMessages = errors
            .map((e) => `Line ${e.lineNum}: ${e.message}`)
            .join('\n');
        throw new Error(`Shader compilation failed:\n${errorMessages}`);
    }

    return {
        module,
        hasErrors: errors.length > 0,
        hasWarnings: warnings.length > 0,
        errors,
        warnings,
        infos,
    };
}

/**
 * Format a compilation message for display
 */
export function formatCompilationMessage(message: GPUCompilationMessage): string {
    const prefix = message.type.toUpperCase();
    const location = message.lineNum > 0 ? ` at line ${message.lineNum}:${message.linePos}` : '';
    return `[${prefix}]${location} ${message.message}`;
}

/**
 * Extract the relevant code context around an error
 */
export function getCodeContext(code: string, lineNum: number, contextLines: number = 2): string {
    const lines = code.split('\n');
    const startLine = Math.max(0, lineNum - contextLines - 1);
    const endLine = Math.min(lines.length, lineNum + contextLines);

    const contextParts: string[] = [];
    for (let i = startLine; i < endLine; i++) {
        const lineNumber = i + 1;
        const prefix = lineNumber === lineNum ? '> ' : '  ';
        contextParts.push(`${prefix}${lineNumber.toString().padStart(4)}: ${lines[i]}`);
    }

    return contextParts.join('\n');
}
