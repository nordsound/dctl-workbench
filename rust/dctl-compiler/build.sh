#!/bin/bash
# Build script for dctl-compiler WASM
# Compiles Rust DCTL compiler to WebAssembly

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Building dctl-compiler WASM ==="

# Check for wasm-pack
if ! command -v wasm-pack &> /dev/null; then
    echo "Error: wasm-pack is not installed"
    echo "Install with: cargo install wasm-pack"
    exit 1
fi

# Build for nodejs target (CommonJS compatible)
echo "Building WASM for Node.js..."
wasm-pack build --target nodejs --out-dir ../wasm/dctl-compiler --release

# Optimize WASM with wasm-opt if available
if command -v wasm-opt &> /dev/null; then
    echo "Optimizing WASM with wasm-opt..."
    WASM_FILE="../wasm/dctl-compiler/dctl_compiler_bg.wasm"
    if [ -f "$WASM_FILE" ]; then
        # Enable bulk-memory for modern WASM features used by Rust
        wasm-opt -Oz --enable-bulk-memory -o "$WASM_FILE.tmp" "$WASM_FILE" 2>/dev/null || {
            echo "Note: wasm-opt optimization skipped (bulk-memory not supported)"
        }
        if [ -f "$WASM_FILE.tmp" ]; then
            mv "$WASM_FILE.tmp" "$WASM_FILE"
        fi
    fi
else
    echo "Note: wasm-opt not found, skipping optimization"
    echo "Install with: brew install binaryen"
fi

# Show output size
echo ""
echo "=== Build complete ==="
ls -lh ../wasm/dctl-compiler/*.wasm 2>/dev/null || echo "WASM file not found"
ls -lh ../wasm/dctl-compiler/*.js 2>/dev/null || echo "JS file not found"

echo ""
echo "Output directory: wasm/dctl-compiler/"
