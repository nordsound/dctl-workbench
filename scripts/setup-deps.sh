#!/bin/bash
# Setup external dependencies for WASM builds
# This script clones all required C++ libraries

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPS_DIR="$PROJECT_ROOT/deps"

# Colors for output
GREEN='\033[0;32m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

clone_if_missing() {
    local name=$1
    local url=$2
    local tag=$3
    local dir="$DEPS_DIR/$name"

    if [ -d "$dir" ]; then
        log_info "$name already exists, skipping"
    else
        log_info "Cloning $name ($tag)..."
        git clone --depth 1 --branch "$tag" "$url" "$dir"
    fi
}

mkdir -p "$DEPS_DIR"
cd "$DEPS_DIR"

log_info "=== Setting up dependencies ==="

# For OpenEXR
clone_if_missing "openexr" "https://github.com/AcademySoftwareFoundation/openexr.git" "v3.4.4"
clone_if_missing "Imath" "https://github.com/AcademySoftwareFoundation/Imath.git" "v3.2.2"

# libdeflate (no tags, use main)
if [ ! -d "$DEPS_DIR/libdeflate" ]; then
    log_info "Cloning libdeflate..."
    git clone --depth 1 "https://github.com/ebiggers/libdeflate.git" "$DEPS_DIR/libdeflate"
else
    log_info "libdeflate already exists, skipping"
fi

# For OCIO
clone_if_missing "OpenColorIO" "https://github.com/AcademySoftwareFoundation/OpenColorIO.git" "v2.5.1"
clone_if_missing "zlib" "https://github.com/madler/zlib.git" "v1.3.1"
clone_if_missing "expat" "https://github.com/libexpat/libexpat.git" "R_2_7_4"
clone_if_missing "yaml-cpp" "https://github.com/jbeder/yaml-cpp.git" "yaml-cpp-0.9.0"
clone_if_missing "pystring" "https://github.com/imageworks/pystring.git" "v1.1.4"
clone_if_missing "minizip-ng" "https://github.com/zlib-ng/minizip-ng.git" "4.1.0"

# Emscripten SDK
EMSDK_DIR="$DEPS_DIR/emsdk"
if [ ! -d "$EMSDK_DIR" ]; then
    log_info "Cloning emsdk..."
    git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
    cd "$EMSDK_DIR"
    log_info "Installing latest emsdk..."
    ./emsdk install latest
    ./emsdk activate latest
    cd "$DEPS_DIR"
else
    log_info "emsdk already exists, skipping clone"
    # Ensure it's activated
    if [ ! -f "$EMSDK_DIR/.emsdk_active" ]; then
        cd "$EMSDK_DIR"
        log_info "Activating emsdk..."
        ./emsdk install latest
        ./emsdk activate latest
        touch "$EMSDK_DIR/.emsdk_active"
        cd "$DEPS_DIR"
    fi
fi

log_info "=== Dependencies setup complete ==="
log_info ""
log_info "To use Emscripten, run:"
log_info "  source $EMSDK_DIR/emsdk_env.sh"
log_info ""
ls -la "$DEPS_DIR"
