#!/bin/bash
# Build all WASM modules
# Usage:
#   ./scripts/build-wasm.sh         # Build all
#   ./scripts/build-wasm.sh rust    # Build Rust WASM only
#   ./scripts/build-wasm.sh native  # Build C++ WASM only

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EMSDK_PATH="${EMSDK_PATH:-$PROJECT_ROOT/deps/emsdk}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Source Emscripten if available
source_emscripten() {
    if [ -f "$EMSDK_PATH/emsdk_env.sh" ]; then
        log_info "Sourcing Emscripten from $EMSDK_PATH"
        source "$EMSDK_PATH/emsdk_env.sh"
    fi
}

build_rust_wasm() {
    log_info "=== Building Rust WASM modules ==="

    # Check for wasm-pack
    if ! command -v wasm-pack &> /dev/null; then
        log_error "wasm-pack not found. Install with: cargo install wasm-pack"
        exit 1
    fi

    # dctl-compiler
    log_info "Building dctl-compiler..."
    cd "$PROJECT_ROOT/rust/dctl-compiler"
    wasm-pack build --target nodejs --out-dir ../../wasm/dctl-compiler --release

    # naga-wasm
    log_info "Building naga-wasm..."
    cd "$PROJECT_ROOT/rust/naga-wasm"
    wasm-pack build --target nodejs --out-dir ../../wasm/naga --release

    # Optimize with wasm-opt if available
    if command -v wasm-opt &> /dev/null; then
        log_info "Optimizing WASM with wasm-opt..."
        for wasm in "$PROJECT_ROOT/wasm/dctl-compiler"/*.wasm "$PROJECT_ROOT/wasm/naga"/*.wasm; do
            if [ -f "$wasm" ]; then
                wasm-opt -Oz --enable-bulk-memory -o "$wasm.tmp" "$wasm" 2>/dev/null && mv "$wasm.tmp" "$wasm" || true
            fi
        done
    fi

    log_info "Rust WASM build complete"
}

build_native_wasm() {
    log_info "=== Building Native WASM modules ==="

    source_emscripten

    # Check Emscripten
    if ! command -v emcc &> /dev/null; then
        log_error "Emscripten not found. Please source emsdk_env.sh"
        exit 1
    fi

    log_info "Using emcc: $(emcc --version | head -1)"

    # OpenEXR
    log_info "Building OpenEXR WASM..."
    cd "$PROJECT_ROOT/native/openexr-wasm"
    if [ -f "build.sh" ]; then
        ./build.sh
    else
        mkdir -p build && cd build
        emcmake cmake ..
        emmake make
        cp openexr.js openexr.wasm "$PROJECT_ROOT/wasm/"
    fi

    # OCIO
    log_info "Building OCIO WASM..."
    cd "$PROJECT_ROOT/native/ocio-wasm"
    ./build.sh

    log_info "Native WASM build complete"
}

show_sizes() {
    log_info "=== WASM Module Sizes ==="
    echo ""
    for wasm in "$PROJECT_ROOT/wasm"/*/*.wasm "$PROJECT_ROOT/wasm"/*.wasm; do
        if [ -f "$wasm" ]; then
            size=$(ls -lh "$wasm" | awk '{print $5}')
            name=$(basename "$wasm")
            printf "  %-30s %s\n" "$name" "$size"
        fi
    done
    echo ""
}

# Main
case "${1:-all}" in
    rust)
        build_rust_wasm
        show_sizes
        ;;
    native)
        build_native_wasm
        show_sizes
        ;;
    all)
        build_rust_wasm
        build_native_wasm
        show_sizes
        ;;
    *)
        echo "Usage: $0 [rust|native|all]"
        exit 1
        ;;
esac

log_info "Done!"
