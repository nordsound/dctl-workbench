# Development Guide

Detailed guide for developing DCTL Workbench.

## Architecture Overview

```text
┌──────────────────────────┐  ┌──────────────────────────┐
│    VS Code Extension     │  │        CLI Tool          │
│    (packages/vscode)     │  │      (packages/cli)      │
└────────────┬─────────────┘  └─────────────┬────────────┘
             │                              │
             └──────────────┬───────────────┘
                            │ uses
                            ▼
┌───────────────────────────────────────────────────────────┐
│                      Core Library                         │
│                     (packages/core)                       │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────┐  │
│  │  Compiler   │  │ Color Math  │  │   Shared Types    │  │
│  └─────────────┘  └─────────────┘  └───────────────────┘  │
├───────────────────────────────────────────────────────────┤
│                      WASM Modules                         │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────┐  │
│  │  Rust DCTL  │  │   OpenEXR   │  │       OCIO        │  │
│  │  Compiler   │  │   (C/C++)   │  │      (C/C++)      │  │
│  └─────────────┘  └─────────────┘  └───────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

### Package Responsibilities

| Package                  | Purpose                                           |
|--------------------------|---------------------------------------------------|
| `@dctl-workbench/core`   | Business logic, compiler, color science           |
| `@dctl-workbench/cli`    | Command-line interface, thin wrapper around core  |
| `dctl-workbench` (vscode)| VS Code extension, UI layer                       |

### Design Principles

- **Core-centric**: All business logic lives in `packages/core`
- **Thin wrappers**: CLI and VS Code are thin wrappers around core
- **Testability**: Core logic can be tested without VS Code dependencies

## Environment Setup

### External Dependencies

All external dependencies including Emscripten are stored in `deps/` (git-ignored).

```bash
# Setup all dependencies (including emsdk)
npm run setup:deps

# Check for updates
./scripts/check-deps-updates.sh
```

### Emscripten

Emscripten is installed automatically via `npm run setup:deps`. To use it:

```bash
# Source the environment (required before building native WASM)
source deps/emsdk/emsdk_env.sh

# Verify installation
emcc --version
```

Note: The build script `scripts/build-wasm.sh` automatically sources emsdk if available.

### Dependency Versions

| Library     | Version | Purpose                          |
|-------------|---------|----------------------------------|
| emsdk       | latest  | Emscripten SDK for C/C++ to WASM |
| OpenEXR     | v3.4.4  | EXR file I/O                     |
| Imath       | v3.2.2  | Math types (half, vec, matrix)   |
| OpenColorIO | v2.5.1  | Color management                 |
| zlib        | v1.3.1  | Compression                      |
| expat       | R_2_7_4 | XML parsing (OCIO config)        |
| yaml-cpp    | 0.9.0   | YAML parsing (OCIO config)       |
| pystring    | v1.1.4  | String utilities (OCIO)          |
| minizip-ng  | 4.1.0   | ZIP support                      |
| libdeflate  | latest  | Fast compression                 |

## Building

### Full Build

```bash
npm run build
```

### WASM Modules

```bash
# Build all WASM modules
npm run build:wasm

# Build Rust WASM only
npm run build:wasm:rust

# Build C/C++ WASM only
npm run build:wasm:native

# Build specific modules manually
cd native/openexr-wasm && make
cd native/ocio-wasm && ./build.sh
cd rust && cargo build --target wasm32-unknown-unknown --release
```

### TypeScript Packages

```bash
npm run build:core    # Core library
npm run build:cli     # CLI tool
npm run build:vscode  # VS Code extension
```

## Testing

### Test Strategy

1. **Unit tests in core**: Test business logic without VS Code
2. **Integration tests in CLI**: Test end-to-end workflows
3. **UI tests in VS Code**: Test VS Code-specific functionality

### Running Tests

```bash
# All tests
npm test

# Core tests (fast, no VS Code)
cd packages/core && npm test

# CLI tests
cd packages/cli && npm test

# VS Code extension tests (unit, no VS Code)
cd packages/vscode && npm test

# VS Code integration tests (launches VS Code)
cd packages/vscode && npm run test:integration

# Rust tests
npm run test:rust
```

### Test Coverage

Maintain **80% or higher** test coverage. Check coverage with:

```bash
npm run test:coverage
```

## Debugging

### VS Code Extension

1. Open the project in VS Code
2. Set breakpoints in TypeScript files
3. Press `F5` to launch Extension Development Host
4. Debug in the original VS Code window

### CLI

```bash
# Run CLI with Node debugger
node --inspect-brk packages/cli/out/index.js <args>
```

### WASM Module Debugging

For native debugging, build with debug symbols:

```bash
cd native/openexr-wasm
make clean && make DEBUG=1
```

## Common Tasks

### Adding a New Feature

1. Implement logic in `packages/core`
2. Add unit tests for the new logic
3. Expose through CLI if applicable
4. Add VS Code UI if needed

### Updating Dependencies

1. Run `./scripts/check-deps-updates.sh` to check for updates
2. Update version in `scripts/setup-deps.sh`
3. Remove old dependency: `rm -rf deps/<name>`
4. Re-run setup: `npm run setup:deps`
5. Rebuild WASM: `npm run build:wasm`
6. Run tests to verify compatibility

### Adding a New WASM Module

1. Create build directory in `native/<module-name>/`
2. Add CMakeLists.txt or Makefile with Emscripten support
3. Output WASM to `wasm/<module-name>/`
4. Add TypeScript bindings in `packages/core`
5. Update `npm run build:wasm` script

## Troubleshooting

### WASM Build Fails

- Ensure Emscripten is activated: `source .../emsdk_env.sh`
- Check dependencies exist: `ls deps/`
- Clean and rebuild: `make clean && make`

### VS Code Extension Not Loading

- Check Output panel for errors
- Ensure `npm run build:vscode` completed
- Try reloading the Extension Development Host

### Tests Failing

- Ensure WASM modules are built: `npm run build:wasm`
- Check Node version: `node --version` (v18+)
- Clean build: `npm run clean && npm run build`
