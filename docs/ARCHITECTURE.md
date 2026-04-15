# DCTL-Workbench Architecture

## Overview

DCTL-Workbench is a development environment for DaVinci Color Transform Language (DCTL). It is organized as a monorepo with three main packages:

| Package           | Purpose              | Entry Point                    |
| ----------------- | -------------------- | ------------------------------ |
| `packages/core`   | Core runtime library | `src/index.ts` → `DctlRuntime` |
| `packages/cli`    | Command-line tool    | `src/index.ts`                 |
| `packages/vscode` | VS Code extension    | `src/extension.ts`             |

The system uses WASM modules for performance-critical tasks and WebGPU for GPU-accelerated rendering.

---

## 1. Package Structure

### 1.1 packages/core - Core Runtime

Shared library used by both CLI and VS Code extension.

```text
packages/core/src/
├── index.ts              # DctlRuntime class (main export)
├── compiler/             # DCTL to WGSL compilation
│   ├── index.ts          # DctlCompiler class
│   └── astConverter.ts   # AST format conversion
├── parser/               # DCTL source code parsing
│   ├── index.ts          # Exports
│   ├── dctlParser.ts     # TypeScript-based parser
│   ├── lexer.ts          # Tokenization
│   ├── tokens.ts         # Token definitions
│   ├── ast.ts            # AST node types
│   ├── dctlTypes.ts      # DCTL type definitions
│   ├── dctlPreprocessor.ts # #define, #if handling
│   └── uiParamExtractor.ts # DEFINE_UI_PARAMS extraction
├── semantic/             # Semantic analysis
│   ├── index.ts          # Exports
│   ├── analyzer.ts       # Semantic analyzer
│   ├── symbolTable.ts    # Symbol table
│   ├── scope.ts          # Scope management
│   ├── types.ts          # Type definitions
│   └── errorCodes.ts     # Error codes
├── shader/               # WGSL shader generation
│   ├── index.ts          # Shader builders & utilities
│   ├── glsl-utils.ts     # GLSL helper functions
│   ├── dctl-shader-builder.ts         # DCTL to WGSL (fragment)
│   ├── dctl-compute-wgsl-builder.ts   # Compute shader builder
│   ├── dctl-export-shader-builder.ts  # Export shader builder
│   ├── integrated-shader-builder.ts   # DCTL + OCIO combined
│   ├── aces-rgc-shader-builder.ts     # RGC extraction & GLSL→WGSL
│   ├── ocio-wgsl-builder.ts           # OCIO fragment shader
│   └── ocio-compute-wgsl-builder.ts   # OCIO compute shader
├── shared/               # Shared utilities
│   ├── index.ts
│   └── logger.ts
├── validation/           # Validation utilities
│   ├── index.ts
│   └── errorCodes.ts
├── color-space/          # Color science utilities
│   └── index.ts          # AP0 ↔ AP1, ACEScct encoding
├── exr/                  # OpenEXR I/O (WASM wrapper)
│   └── index.ts          # EXRModule class
├── naga/                 # GLSL→WGSL conversion (WASM wrapper)
│   └── index.ts          # NagaProcessor class
├── ocio/                 # OpenColorIO support
│   ├── index.ts          # OCIO exports
│   └── types.ts          # OCIO type definitions
└── types/                # Shared type definitions
    └── index.ts
```

**Main Class - DctlRuntime:**

```typescript
class DctlRuntime {
  private compiler: DctlCompiler;
  private exr: EXRModule;
  private naga: NagaProcessor;

  async init(options: RuntimeInitOptions): Promise<void>;
  get isInitialized(): boolean;

  // Compilation
  compile(source: string): CompileResult | CompileError;
  compileWithIncludes(
    source: string,
    options?: IncludeOptions,
  ): Promise<CompileResult | CompileError>;
  getCompilerVersion(): string;

  // Shader Building
  buildShader(
    compileResult: CompileResult,
    options: ShaderBuildOptions,
  ): ShaderBuildResult;
  buildComputeShader(
    compileResult: CompileResult,
    options: ShaderBuildOptions,
  ): ShaderBuildResult;
  compileAndBuildShader(
    source: string,
    options: ShaderBuildOptions,
  ): ShaderBuildResult | CompileError;

  // EXR I/O
  readExr(filePath: string): Promise<{ width; height; channels; data }>;
  readExrSync(filePath: string): { width; height; channels; data };
  writeExr(filePath: string, options: WriteExrOptions): Promise<void>;
  writeExrSync(filePath: string, options: WriteExrOptions): void;

  // Naga (GLSL → WGSL)
  get hasNaga(): boolean;
  convertGlslToWgsl(glsl: string): ConversionResult;
}
```

### 1.2 packages/cli - Command-Line Tool

Batch processing of DCTL effects on EXR images.

```text
packages/cli/src/
├── index.ts                  # CLI entry point (commander)
├── shader-builder.ts         # Buffer-based compute shaders
├── rgc-shader-builder.ts     # ACES 2.0 RGC extraction
├── subprocess-renderer.ts    # WebGPU in isolated process
├── gpu-worker.ts             # WebGPU compute execution
└── test/                     # Test files
```

**Commands:**

```bash
dctlw apply <dctl> <input.exr> <output.exr>  # Apply DCTL effect
dctlw compile <dctl>                          # Compile to WGSL (debug)
dctlw info <dctl>                             # Show DCTL metadata
```

**CLI Options (apply command):**

| Option                        | Description                                         | Default   |
| ----------------------------- | --------------------------------------------------- | --------- |
| `-p, --param <params...>`     | Set parameter values (e.g., `-p gain=1.5`)          | -         |
| `-i, --input-space <space>`   | Input color space                                   | `AP0`     |
| `-o, --output-space <space>`  | Output color space                                  | `AP0`     |
| `-w, --working-space <space>` | Working color space for DCTL                        | `ACEScct` |
| `--rgc`                       | Apply ACES 2.0 Reference Gamut Compression          | `false`   |
| `--peak-luminance <nits>`     | Peak luminance for RGC (100, 500, 1000, 2000, 4000) | `100`     |
| `--include <dirs...>`         | Additional include directories                      | -         |

**Supported Color Spaces:** `AP0`, `AP1`, `ACEScct`, `ACEScc`, `sRGB`, `Rec709`

### 1.3 packages/vscode - VS Code Extension

Interactive development environment with real-time preview.

```text
packages/vscode/src/
├── extension.ts              # Extension entry point
├── dctl/                     # DCTL Language Support
│   ├── parser/               # Tree-sitter based parsing
│   │   ├── index.ts
│   │   ├── treeSitter.ts
│   │   ├── dctlVisitor.ts
│   │   └── types.ts
│   ├── preprocessor/         # C preprocessor emulation
│   │   ├── index.ts
│   │   ├── preprocessor.ts
│   │   ├── directiveParser.ts
│   │   ├── defineProcessor.ts
│   │   ├── conditionalEval.ts
│   │   ├── pathResolver.ts
│   │   ├── circularDetector.ts
│   │   ├── sourceMap.ts
│   │   └── types.ts
│   ├── compiler/             # AST compilation
│   │   ├── index.ts
│   │   └── preprocessor.ts
│   ├── semantic/             # Type analysis
│   │   └── index.ts
│   ├── validation/           # Syntax validation
│   │   ├── index.ts
│   │   └── dctlValidator.ts
│   ├── diagnostics/          # Error reporting
│   │   ├── dctlDiagnostics.ts
│   │   └── errorCodes.ts
│   ├── language/             # IntelliSense
│   │   ├── index.ts
│   │   ├── hoverProvider.ts
│   │   ├── completionProvider.ts
│   │   └── documentation.ts
│   ├── index.ts
│   └── types.ts
├── editor/
│   └── ExrEditorProvider.ts  # Custom EXR editor
├── shader/                   # Re-exports from @dctl-workbench/core
│   └── index.ts              # Re-export wrapper
├── exr/                      # EXR I/O
│   ├── index.ts
│   ├── reader.ts
│   ├── writer.ts
│   ├── metadata.ts
│   └── module.ts
├── test/                     # Tests
│   ├── unit/                 # Unit tests (no VS Code required)
│   ├── integration/          # Integration tests (requires VS Code)
│   └── mocks/                # Test mocks
├── webview/                  # WebGPU Preview
│   ├── exr-viewer.ts
│   ├── webgpu-renderer.ts
│   ├── compute-pipeline.ts
│   ├── texture-utils.ts
│   ├── zone-buffer-manager.ts
│   ├── dctl-param-buffer.ts
│   ├── hooks/
│   │   └── useWebGPU.ts
│   └── shared/               # Shared UI components
│       ├── index.ts
│       ├── gpu-features.ts
│       ├── gpu-limits.ts
│       ├── gpu-profiler.ts
│       ├── gpu-error-handler.ts
│       ├── gpu-subgroups.ts
│       ├── hdr-manager.ts
│       ├── dctl-controls.ts
│       ├── metadata-display.ts
│       └── ui-helpers.ts
├── shared/
│   └── logger.ts             # Shared logging (no vscode dependency)
└── plugins/
    └── types.ts              # Plugin type definitions
```

---

## 2. WASM Modules

```text
wasm/
├── dctl-compiler/          # Rust DCTL → WGSL compiler
│   ├── dctl_compiler.js
│   ├── dctl_compiler_bg.wasm
│   └── dctl_compiler.d.ts
├── naga/                   # GLSL → WGSL translator
│   ├── naga_wasm.js
│   ├── naga_wasm_bg.wasm
│   └── naga_wasm.d.ts
├── ocio.js / ocio.wasm     # ACES color operations & RGC
├── ocio.d.ts
├── openexr.js / openexr.wasm  # EXR I/O
└── openexr.d.ts
```

### 2.1 DCTL Compiler (Rust)

**Source:** `rust/dctl-compiler/src/`

**Architecture:**

```text
DCTL Source
    ↓
Tree-sitter Parser → AST
    ↓
Semantic Analyzer (type checking, symbol resolution)
    ↓
Naga Module Builder (direct IR construction)
    ↓
WGSL Output
```

**Rust Modules:**

```text
rust/dctl-compiler/src/
├── lib.rs              # Main entry point
├── parser/             # Tree-sitter based parsing
│   ├── mod.rs
│   ├── ast.rs
│   └── tree_sitter_parser.rs
├── preprocessor.rs     # #include, #define handling
├── semantic/           # Semantic analysis
│   ├── mod.rs
│   ├── analyzer.rs
│   └── types.rs
├── codegen/            # WGSL code generation
│   ├── mod.rs
│   ├── wgsl.rs
│   ├── naga_module.rs
│   ├── declarations.rs
│   ├── statements.rs
│   ├── expressions.rs
│   ├── functions.rs
│   ├── function_calls.rs
│   ├── builtins.rs
│   ├── types.rs
│   ├── inference.rs
│   ├── coercion.rs
│   ├── initializers.rs
│   └── pointer_analysis.rs
└── wasm/               # WASM bindings
    ├── mod.rs
    └── bindings.rs
```

**WASM Functions:**

| Function                                            | Description               |
| --------------------------------------------------- | ------------------------- |
| `init()`                                            | Initialize the compiler   |
| `parse_dctl(source)`                                | Parse DCTL to AST         |
| `analyze_dctl(source)`                              | Semantic analysis         |
| `compile_dctl(source)`                              | Full compilation pipeline |
| `compile_dctl_with_includes(source, includes_json)` | With #include             |
| `compile_from_ast(ast_json)`                        | Code generation from AST  |
| `validate_dctl(source)`                             | Validation only           |
| `validate_from_ast(ast_json)`                       | Validate AST              |
| `get_version()`                                     | Get compiler version      |

### 2.2 Naga (Rust)

**Purpose:** GLSL ↔ WGSL shader conversion (for OCIO RGC)

**Functions:**

| Function                                 | Description        |
| ---------------------------------------- | ------------------ |
| `glsl_to_wgsl(glsl, stage, entry_point)` | General conversion |
| `glsl_fragment_to_wgsl(glsl)`            | Fragment shader    |
| `glsl_vertex_to_wgsl(glsl)`              | Vertex shader      |
| `glsl_compute_to_wgsl(glsl)`             | Compute shader     |

### 2.3 OCIO (C++ via Emscripten)

**Purpose:** ACES color operations, Reference Gamut Compression

**Key Functions:**

| Function                                          | Description                    |
| ------------------------------------------------- | ------------------------------ |
| `initBuiltinConfig(name)`                         | Load ACES config               |
| `setupACES2GamutCompress(peakLuminance, inverse)` | RGC setup                      |
| `extractGpuShaderInfo()`                          | Get GLSL shader + LUT textures |

### 2.4 OpenEXR (C++ via Emscripten)

**Purpose:** EXR file I/O

**Compression Support:** PIZ, ZIP, ZIPS, RLE, PXR24, DWAA, DWAB, B44, B44A, NONE

---

## 3. Data Flow Diagrams

### 3.1 DCTL Compilation

```text
        ┌─────────────────────────────┐
        │ DCTL Source (.dctl file)    │
        └──────────────┬──────────────┘
                       │
            ┌──────────▼──────────┐
            │ Extract UI Params   │  ← DEFINE_UI_PARAMS
            │ (before preprocess) │
            └──────────┬──────────┘
                       │
            ┌──────────▼──────────┐
            │ Preprocess          │  ← #include, #define, #if
            └──────────┬──────────┘
                       │
            ┌──────────▼──────────┐
            │ Parse to AST        │  ← TypeScript Parser
            └──────────┬──────────┘
                       │
            ┌──────────▼──────────┐
            │ Semantic Analysis   │  ← Type checking
            └──────────┬──────────┘
                       │
            ┌──────────▼──────────┐
            │ Compile via Rust    │  ← WASM Backend
            └──────────┬──────────┘
                       │
            ┌──────────▼──────────┐
            │ WGSL Output         │
            └─────────────────────┘
```

### 3.2 CLI Processing Pipeline

```text
   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
   │  DCTL File   │    │  Input EXR   │    │  RGC Config  │
   └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
          │                   │                   │
          ▼                   ▼                   ▼
   ┌──────────────────────────────────────────────────────┐
   │                   CLI: applyDctl()                   │
   ├──────────────────────────────────────────────────────┤
   │ 1. Compile DCTL → WGSL                               │
   │ 2. Read EXR → Float32Array                           │
   │ 3. Extract RGC (if enabled) → GLSL → WGSL            │
   │ 4. Build compute shader                              │
   │ 5. Spawn gpu-worker subprocess                       │
   │ 6. Execute WebGPU compute                            │
   │ 7. Write output EXR                                  │
   └──────────────────────────────────────────────────────┘
                              │
                              ▼
                      ┌──────────────┐
                      │  Output EXR  │
                      └──────────────┘
```

### 3.3 RGC Integration Flow

```text
         ┌──────────────────────────────────────────────┐
         │ OCIO: setupACES2GamutCompress(peakLuminance) │
         └──────────────────────┬───────────────────────┘
                                │
                  ┌─────────────▼─────────────┐
                  │ extractGpuShaderInfo()    │
                  │ Returns:                  │
                  │   - GLSL shader code      │
                  │   - 2D LUT textures       │
                  │   - 3D LUT textures       │
                  └─────────────┬─────────────┘
                                │
                  ┌─────────────▼─────────────┐
                  │ Fix GLSL for Naga         │
                  │ (sampler2D → texture2D)   │
                  └─────────────┬─────────────┘
                                │
                  ┌─────────────▼─────────────┐
                  │ Naga: glsl_to_wgsl()      │
                  └─────────────┬─────────────┘
                                │
                  ┌─────────────▼─────────────┐
                  │ Post-process WGSL         │
                  │ - Remove @fragment        │
                  │ - textureSample → Level   │
                  └─────────────┬─────────────┘
                                │
                  ┌─────────────▼─────────────┐
                  │ Integrate into shader     │
                  │ - Group 1: RGC textures   │
                  │ - applyACES2RGC() func    │
                  └───────────────────────────┘
```

### 3.4 VS Code Preview Pipeline

```text
┌────────────────────────────────────────────────────────┐
│                   VS Code Extension                    │
├────────────────────────────────────────────────────────┤
│                                                        │
│  ┌────────────┐   ┌────────────────────────────────┐   │
│  │ DCTL File  │──▶│ Language Support               │   │
│  └────────────┘   │ - Diagnostics                  │   │
│                   │ - Hover / Completion           │   │
│                   └────────────────────────────────┘   │
│                                                        │
│  ┌────────────┐   ┌────────────────────────────────┐   │
│  │ EXR File   │──▶│ ExrEditorProvider              │   │
│  └────────────┘   │ - Custom Editor                │   │
│                   │ - Webview (WebGPU Renderer)    │   │
│                   └────────────────────────────────┘   │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │             Webview: exr-viewer.ts               │  │
│  ├──────────────────────────────────────────────────┤  │
│  │ 1. Load image data (EXR / plugin-decoded RAW)    │  │
│  │ 2. If preTransformMatrix present:                │  │
│  │      WebGPU: compute pass → rgba32float interm.  │  │
│  │      WebGL2: FBO fragment pass → rgba32float     │  │
│  │ 3. Build integrated shader (DCTL + OCIO)         │  │
│  │ 4. Create WebGPU pipeline / WebGL2 program       │  │
│  │ 5. Render to canvas                              │  │
│  │ 6. Update on parameter change                    │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
└────────────────────────────────────────────────────────┘
```

Plugin-supplied `DecodedImage.preTransformMatrix` (plugin API 0.3.0+) is
applied in step 2 as a one-shot GPU pass *before* the OCIO / DCTL chain,
so downstream shaders are unchanged regardless of whether the input
arrived in the plugin's own color space or already in `colorSpace`.
See `docs/PLUGIN_DEVELOPMENT.md §3.8` for the contract.

---

## 4. Key Interfaces

### 4.1 Compilation

```typescript
interface CompileResult {
  wgsl: string;
  parameters: CompilerParameter[];
  diagnostics: CompilerDiagnostic[];
  entry_point: string;
}

interface CompileError {
  error: true;
  message: string;
}

interface CompilerParameter {
  name: string;
  label: string;
  param_type: ParameterType;
}

type ParameterType =
  | { type: "float"; default: number; min: number; max: number; step: number }
  | { type: "int"; default: number; min: number; max: number; step: number }
  | { type: "bool"; default: boolean }
  | { type: "combo"; default: number; options: string[] };
```

### 4.2 Shader Building

```typescript
interface ShaderBuildOptions {
  width: number;
  height: number;
  paramValues?: Record<string, number | boolean>;
  workingColorSpace?: DctlColorSpace;
  applyRGC?: boolean;
}

interface ShaderBuildResult {
  wgsl: string;
  bindings: TextureBinding[];
  rgcTextures?: GpuTexture[];
  rgcTextures3D?: GpuTexture3D[];
}

interface TextureBinding {
  binding: number;
  type: "texture2D" | "texture3D" | "sampler";
  name: string;
}

type DctlColorSpace =
  | "ACES2065-1"
  | "ACEScg"
  | "ACEScc"
  | "ACEScct"
  | "linear_sRGB";

// Transform signature types
type TransformSignatureType = "texture" | "float";
```

### 4.3 EXR I/O

```typescript
interface WriteExrOptions {
  width: number;
  height: number;
  channels?: 3 | 4;
  data: Float32Array;
  compression?: EXRCompressionType;
  chromaticities?: Chromaticities;
  aces?: boolean; // Use ACES AP0 chromaticities
}

type EXRCompressionType =
  | "NONE"
  | "RLE"
  | "ZIPS"
  | "ZIP"
  | "PIZ"
  | "PXR24"
  | "B44"
  | "B44A"
  | "DWAA"
  | "DWAB";

interface Chromaticities {
  redX: number;
  redY: number;
  greenX: number;
  greenY: number;
  blueX: number;
  blueY: number;
  whiteX: number;
  whiteY: number;
}
```

---

## 5. Dependency Graph

```text
┌───────────────────────────┐   ┌───────────────────────────┐
│     packages/vscode       │   │      packages/cli         │
│   (VS Code Extension)     │   │   (Command-Line Tool)     │
├───────────────────────────┤   ├───────────────────────────┤
│ npm:                      │   │ npm:                      │
│   - @dctl-workbench/core  │   │   - @dctl-workbench/core  │
│   - tree-sitter-wasms     │   │   - commander             │
│   - web-tree-sitter       │   │   - webgpu (Dawn)         │
└─────────────┬─────────────┘   └─────────────┬─────────────┘
              │                               │
              │ uses                     uses │
              │                               │
              └───────────────┬───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────┐
│                      packages/core                      │
│                  (Core Runtime Library)                 │
├─────────────────────────────────────────────────────────┤
│ npm: (none - pure library)                              │
│                                                         │
│ WASM: dctl-compiler, naga, ocio, openexr                │
└─────────────────────────────────────────────────────────┘
```

---

## 6. Shader Types & Code Paths

### 6.1 Preview vs Export

| Aspect      | Preview (VS Code)     | Export (VS Code/CLI)               |
| ----------- | --------------------- | ---------------------------------- |
| Shader Type | Fragment              | Fragment (VS Code) / Compute (CLI) |
| Input       | Texture2D             | Texture2D / Buffer                 |
| Output      | Canvas                | EXR File                           |
| Color Space | Display (sRGB/Rec709) | AP0 Linear                         |
| RGC         | Optional              | Optional                           |

### 6.2 Shader Builder Functions

| Function                            | Package | Purpose                                          |
| ----------------------------------- | ------- | ------------------------------------------------ |
| `buildShader()`                     | core    | Fragment shader (deprecated → buildExportShader) |
| `buildExportShader()`               | core    | Fragment shader for EXR export                   |
| `buildComputeShader()`              | core    | Compute shader for CLI                           |
| `buildBufferComputeShader()`        | cli     | Buffer I/O compute shader                        |
| `buildBufferComputeShaderWithRgc()` | cli     | With RGC integration                             |
| `buildRgcShader()`                  | cli     | RGC extraction & conversion                      |
| `buildIntegratedShader()`           | vscode  | DCTL + OCIO combined                             |

### 6.3 Transform Signature Handling

DCTL functions have two signature types:

| Type      | Parameters                                              | Usage                                |
| --------- | ------------------------------------------------------- | ------------------------------------ |
| `texture` | `(p_Width, p_Height, p_X, p_Y, p_TexR, p_TexG, p_TexB)` | Uses `dctl_sampleTexture` internally |
| `float`   | `(p_Width, p_Height, p_X, p_Y, p_R, p_G, p_B)`          | Receives RGB values as arguments     |

**Utility Functions (core/shader):**

| Function                              | Description                           |
| ------------------------------------- | ------------------------------------- |
| `detectTransformSignature()`          | Detect signature type from WGSL       |
| `rewriteTextureTransformSignature()`  | Remove texture_2d params for fragment |
| `rewriteTextureTransformForCompute()` | Use i32 dummy params for compute      |
| `injectParameters()`                  | Inject parameter values into WGSL     |
| `removeSampleTextureStub()`           | Remove stub function                  |
| `generateColorSpaceCode()`            | Generate AP0↔AP1, ACEScct code        |
| `generateFragmentTextureSampler()`    | Generate dctl_sampleTexture           |
| `generateFragmentEntryPoint()`        | Generate @fragment main               |

---

## 7. Build System

### 7.1 Root package.json

```json
{
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build:wasm && npm run build --workspaces",
    "build:wasm": "./scripts/build-wasm.sh all",
    "build:wasm:rust": "./scripts/build-wasm.sh rust",
    "build:wasm:native": "./scripts/build-wasm.sh native",
    "build:core": "npm run build -w packages/core",
    "build:cli": "npm run build -w packages/cli",
    "build:vscode": "npm run build -w packages/vscode",
    "test": "npm run test --workspaces --if-present",
    "test:rust": "cd rust && cargo test",
    "coverage:rust": "./scripts/rust-coverage.sh",
    "setup:deps": "./scripts/setup-deps.sh",
    "clean": "npm run clean --workspaces --if-present",
    "clean:wasm": "rm -rf wasm/*"
  }
}
```

### 7.2 WASM Build

```bash
# Rust modules (wasm-pack)
cd rust/dctl-compiler
wasm-pack build --target nodejs --out-dir ../../wasm/dctl-compiler

cd rust/naga-wasm
wasm-pack build --target nodejs --out-dir ../../wasm/naga

# C++ modules (Emscripten)
cd native/openexr-wasm && make
cd native/ocio-wasm && ./build.sh
```

### 7.3 External Dependencies

Setup with `npm run setup:deps` or `./scripts/setup-deps.sh`:

| Library     | Version | Purpose                        |
| ----------- | ------- | ------------------------------ |
| emsdk       | latest  | Emscripten SDK (C/C++ to WASM) |
| OpenEXR     | v3.4.4  | EXR file I/O                   |
| Imath       | v3.2.2  | Math types (half, vec, matrix) |
| libdeflate  | latest  | Fast compression               |
| OpenColorIO | v2.5.1  | Color management               |
| zlib        | v1.3.1  | Compression                    |
| expat       | R_2_7_4 | XML parsing (OCIO config)      |
| yaml-cpp    | 0.9.0   | YAML parsing (OCIO config)     |
| pystring    | v1.1.4  | String utilities (OCIO)        |
| minizip-ng  | 4.1.0   | ZIP support                    |

Check for updates: `./scripts/check-deps-updates.sh`

---

## 8. File Summary

```text
dctl-workbench/
├── packages/
│   ├── core/           # Shared runtime library
│   ├── cli/            # Command-line tool
│   └── vscode/         # VS Code extension
├── rust/
│   ├── dctl-compiler/  # Rust DCTL compiler
│   └── naga-wasm/      # Naga WASM wrapper
├── native/
│   ├── openexr-wasm/   # OpenEXR WASM build
│   └── ocio-wasm/      # OCIO WASM build
├── wasm/               # Built WASM modules
├── deps/               # External C/C++ dependencies (git-ignored)
├── docs/               # Documentation
└── scripts/            # Build and utility scripts
```

Last Updated: 2026-02-11
