#!/bin/bash
#
# OpenColorIO WASM Build Script
#
# Prerequisites:
#   - Emscripten SDK installed and sourced
#   - CMake 3.16+
#   - Git
#
# Usage:
#   ./build.sh           # Build all
#   ./build.sh deps      # Build dependencies only
#   ./build.sh ocio      # Build OCIO only
#   ./build.sh wrapper   # Build wrapper only
#   ./build.sh clean     # Clean build

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Add Homebrew to PATH for cmake etc.
export PATH="/opt/homebrew/bin:$PATH"

# Source Emscripten if not already in PATH
if ! command -v emcc &> /dev/null; then
    # emsdk is installed by setup-deps.sh into deps/emsdk/
    EMSDK_PATH="$SCRIPT_DIR/../../deps/emsdk"
    if [ -f "$EMSDK_PATH/emsdk_env.sh" ]; then
        source "$EMSDK_PATH/emsdk_env.sh"
    fi
fi
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPS_DIR="$PROJECT_ROOT/deps"
BUILD_DIR="$SCRIPT_DIR/build"
INSTALL_DIR="$BUILD_DIR/install"
OUT_DIR="$PROJECT_ROOT/wasm"

# Number of parallel jobs
JOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_emscripten() {
    if ! command -v emcc &> /dev/null; then
        log_error "Emscripten not found. Please source emsdk_env.sh first."
        exit 1
    fi
    log_info "Emscripten: $(emcc --version | head -1)"
}

clone_dependency() {
    local name=$1
    local url=$2
    local tag=$3
    local dir="$DEPS_DIR/$name"

    if [ -d "$dir" ]; then
        log_info "$name already cloned"
    else
        log_info "Cloning $name..."
        git clone --depth 1 --branch "$tag" "$url" "$dir"
    fi
}

build_zlib() {
    log_info "Building zlib..."
    local src="$DEPS_DIR/zlib"
    local build="$BUILD_DIR/zlib"

    clone_dependency "zlib" "https://github.com/madler/zlib.git" "v1.3.1"

    mkdir -p "$build"
    cd "$build"

    emcmake cmake "$src" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DBUILD_SHARED_LIBS=OFF \
        -DZLIB_BUILD_EXAMPLES=OFF

    # Build only the static library target
    emmake make zlibstatic -j$JOBS

    # Manually install
    mkdir -p "$INSTALL_DIR/lib"
    mkdir -p "$INSTALL_DIR/include"
    cp libz.a "$INSTALL_DIR/lib/"
    cp zconf.h "$INSTALL_DIR/include/"
    cp "$src/zlib.h" "$INSTALL_DIR/include/"
}

build_expat() {
    log_info "Building expat..."
    local src="$DEPS_DIR/expat/expat"
    local build="$BUILD_DIR/expat"

    clone_dependency "expat" "https://github.com/libexpat/libexpat.git" "R_2_6_4"

    mkdir -p "$build"
    cd "$build"

    emcmake cmake "$src" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DEXPAT_BUILD_DOCS=OFF \
        -DEXPAT_BUILD_EXAMPLES=OFF \
        -DEXPAT_BUILD_TESTS=OFF \
        -DEXPAT_BUILD_TOOLS=OFF \
        -DEXPAT_SHARED_LIBS=OFF

    emmake make -j$JOBS
    emmake make install
}

build_yaml_cpp() {
    log_info "Building yaml-cpp..."
    local src="$DEPS_DIR/yaml-cpp"
    local build="$BUILD_DIR/yaml-cpp"

    clone_dependency "yaml-cpp" "https://github.com/jbeder/yaml-cpp.git" "0.8.0"

    mkdir -p "$build"
    cd "$build"

    emcmake cmake "$src" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
        -DYAML_CPP_BUILD_TESTS=OFF \
        -DYAML_CPP_BUILD_TOOLS=OFF \
        -DYAML_BUILD_SHARED_LIBS=OFF

    emmake make -j$JOBS
    emmake make install
}

build_pystring() {
    log_info "Building pystring..."
    local src="$DEPS_DIR/pystring"
    local build="$BUILD_DIR/pystring"

    clone_dependency "pystring" "https://github.com/imageworks/pystring.git" "v1.1.4"

    # pystring doesn't have CMake, build manually
    mkdir -p "$build"
    cd "$build"

    em++ -c -O3 -std=c++11 "$src/pystring.cpp" -o pystring.o
    emar rcs libpystring.a pystring.o

    mkdir -p "$INSTALL_DIR/lib"
    mkdir -p "$INSTALL_DIR/include"
    cp libpystring.a "$INSTALL_DIR/lib/"
    cp "$src/pystring.h" "$INSTALL_DIR/include/"
}

build_imath() {
    log_info "Building Imath..."
    local src="$DEPS_DIR/Imath"
    local build="$BUILD_DIR/Imath"

    if [ ! -d "$src" ]; then
        # Imath should already be in deps from OpenEXR build, but clone if not
        clone_dependency "Imath" "https://github.com/AcademySoftwareFoundation/Imath.git" "v3.2.0"
    fi

    mkdir -p "$build"
    cd "$build"

    emcmake cmake "$src" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DBUILD_SHARED_LIBS=OFF \
        -DBUILD_TESTING=OFF

    emmake make -j$JOBS
    emmake make install
}

build_minizip_ng() {
    log_info "Building minizip-ng..."
    local src="$DEPS_DIR/minizip-ng"
    local build="$BUILD_DIR/minizip-ng"

    clone_dependency "minizip-ng" "https://github.com/zlib-ng/minizip-ng.git" "4.0.7"

    mkdir -p "$build"
    cd "$build"

    emcmake cmake "$src" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DBUILD_SHARED_LIBS=OFF \
        -DMZ_COMPAT=OFF \
        -DMZ_ZLIB=ON \
        -DMZ_BZIP2=OFF \
        -DMZ_LZMA=OFF \
        -DMZ_ZSTD=OFF \
        -DMZ_OPENSSL=OFF \
        -DMZ_LIBBSD=OFF \
        -DMZ_PKCRYPT=OFF \
        -DMZ_WZAES=OFF \
        -DMZ_SIGNING=OFF \
        -DZLIB_LIBRARY="$INSTALL_DIR/lib/libz.a" \
        -DZLIB_INCLUDE_DIR="$INSTALL_DIR/include"

    emmake make -j$JOBS
    emmake make install
}

build_ocio() {
    log_info "Building OpenColorIO..."
    local src="$DEPS_DIR/OpenColorIO"
    local build="$BUILD_DIR/OpenColorIO"

    if [ ! -d "$src" ]; then
        log_error "OpenColorIO not found in $src"
        log_error "Please clone: git clone https://github.com/AcademySoftwareFoundation/OpenColorIO.git $src"
        exit 1
    fi

    mkdir -p "$build"
    cd "$build"

    # Clean previous build if exists
    rm -f CMakeCache.txt

    # OCIO needs specific flags for WASM
    # Set explicit paths for all dependencies since Emscripten's CMake may not find them automatically
    emcmake cmake "$src" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
        -DCMAKE_PREFIX_PATH="$INSTALL_DIR" \
        -DCMAKE_FIND_ROOT_PATH="$INSTALL_DIR" \
        -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
        -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH \
        -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH \
        -DBUILD_SHARED_LIBS=OFF \
        -DOCIO_BUILD_APPS=OFF \
        -DOCIO_BUILD_TESTS=OFF \
        -DOCIO_BUILD_GPU_TESTS=OFF \
        -DOCIO_BUILD_DOCS=OFF \
        -DOCIO_BUILD_PYTHON=OFF \
        -DOCIO_INSTALL_EXT_PACKAGES=NONE \
        -DOCIO_USE_SSE=OFF \
        -Dexpat_LIBRARY="$INSTALL_DIR/lib/libexpat.a" \
        -Dexpat_INCLUDE_DIR="$INSTALL_DIR/include" \
        -Dyaml-cpp_DIR="$INSTALL_DIR/lib/cmake/yaml-cpp" \
        -Dpystring_LIBRARY="$INSTALL_DIR/lib/libpystring.a" \
        -Dpystring_INCLUDE_DIR="$INSTALL_DIR/include" \
        -DImath_DIR="$INSTALL_DIR/lib/cmake/Imath" \
        -Dminizip-ng_DIR="$INSTALL_DIR/lib/cmake/minizip-ng" \
        -DZLIB_LIBRARY="$INSTALL_DIR/lib/libz.a" \
        -DZLIB_INCLUDE_DIR="$INSTALL_DIR/include"

    emmake make -j$JOBS
    emmake make install
}

build_wrapper() {
    log_info "Building OCIO WASM wrapper..."

    local wrapper_src="$SCRIPT_DIR/src/ocio_wrapper.cpp"
    if [ ! -f "$wrapper_src" ]; then
        log_error "Wrapper source not found: $wrapper_src"
        exit 1
    fi

    mkdir -p "$OUT_DIR"

    # Libraries
    LIBS=(
        "$INSTALL_DIR/lib/libOpenColorIO.a"
        "$INSTALL_DIR/lib/libyaml-cpp.a"
        "$INSTALL_DIR/lib/libexpat.a"
        "$INSTALL_DIR/lib/libpystring.a"
        "$INSTALL_DIR/lib/libImath-3_2.a"
        "$INSTALL_DIR/lib/libminizip-ng.a"
        "$INSTALL_DIR/lib/libz.a"
    )

    # Check all libraries exist
    for lib in "${LIBS[@]}"; do
        if [ ! -f "$lib" ]; then
            log_error "Missing library: $lib"
            exit 1
        fi
    done

    # Compile
    em++ \
        -std=c++17 \
        -O3 \
        -flto \
        -DNDEBUG \
        -I"$INSTALL_DIR/include" \
        -I"$INSTALL_DIR/include/OpenColorIO" \
        -I"$INSTALL_DIR/include/Imath" \
        -sWASM=1 \
        -sALLOW_MEMORY_GROWTH=1 \
        -sINITIAL_MEMORY=67108864 \
        -sMAXIMUM_MEMORY=536870912 \
        -sEXPORTED_FUNCTIONS="['_malloc','_free']" \
        -sEXPORTED_RUNTIME_METHODS="['HEAPU8','HEAPF32','setValue','getValue','FS','NODEFS']" \
        -sMODULARIZE=1 \
        -sEXPORT_NAME='createOCIO' \
        -sFORCE_FILESYSTEM=1 \
        -lnodefs.js \
        -sDISABLE_EXCEPTION_CATCHING=0 \
        --bind \
        "$wrapper_src" \
        "${LIBS[@]}" \
        -o "$OUT_DIR/ocio.js"

    log_info "Built: $OUT_DIR/ocio.js"
    log_info "Built: $OUT_DIR/ocio.wasm"
    ls -lh "$OUT_DIR"/ocio.*
}

build_deps() {
    mkdir -p "$BUILD_DIR"
    mkdir -p "$INSTALL_DIR"
    mkdir -p "$DEPS_DIR"

    build_zlib
    build_expat
    build_yaml_cpp
    build_pystring
    build_imath
    build_minizip_ng
}

build_all() {
    check_emscripten
    build_deps
    build_ocio
    build_wrapper
}

clean() {
    log_info "Cleaning build..."
    rm -rf "$BUILD_DIR"
    rm -f "$OUT_DIR/ocio.js" "$OUT_DIR/ocio.wasm"
}

# Main
case "${1:-all}" in
    deps)
        check_emscripten
        build_deps
        ;;
    ocio)
        check_emscripten
        build_ocio
        ;;
    wrapper)
        check_emscripten
        build_wrapper
        ;;
    clean)
        clean
        ;;
    all|*)
        build_all
        ;;
esac

log_info "Done!"
