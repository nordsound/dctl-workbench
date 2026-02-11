#!/bin/bash
# Build script for naga-wasm
# Converts Rust naga library to WebAssembly

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Building naga-wasm ==="

# Check for wasm-pack
if ! command -v wasm-pack &> /dev/null; then
    echo "Error: wasm-pack is not installed"
    echo "Install with: cargo install wasm-pack"
    exit 1
fi

# Build for nodejs target (CommonJS compatible)
echo "Building WASM for Node.js..."
wasm-pack build --target nodejs --out-dir ../../wasm/naga --release

# Optimize WASM with wasm-opt if available
if command -v wasm-opt &> /dev/null; then
    echo "Optimizing WASM with wasm-opt..."
    WASM_FILE="../../wasm/naga/naga_wasm_bg.wasm"
    if [ -f "$WASM_FILE" ]; then
        wasm-opt -Oz -o "$WASM_FILE.tmp" "$WASM_FILE"
        mv "$WASM_FILE.tmp" "$WASM_FILE"
    fi
else
    echo "Note: wasm-opt not found, skipping optimization"
    echo "Install with: brew install binaryen"
fi

# Show output size
echo ""
echo "=== Build complete ==="
ls -lh ../../wasm/naga/*.wasm 2>/dev/null || echo "WASM file not found"
ls -lh ../../wasm/naga/*.js 2>/dev/null || echo "JS file not found"

echo ""
echo "Output directory: wasm/naga/"
