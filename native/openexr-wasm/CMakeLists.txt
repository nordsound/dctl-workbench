# OpenEXR WASM Build Configuration
#
# Build with Emscripten:
#   mkdir build && cd build
#   emcmake cmake ..
#   emmake make
#
# Or use the Makefile wrapper:
#   make

cmake_minimum_required(VERSION 3.14)
project(openexr_wasm C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

# Paths - relative to dctl-workbench/scripts/openexr-wasm/
set(OPENEXR_DIR "${CMAKE_SOURCE_DIR}/../../deps/openexr")
set(IMATH_DIR "${CMAKE_SOURCE_DIR}/../../deps/Imath")

# Verify dependencies exist
if(NOT EXISTS "${OPENEXR_DIR}/src/lib/OpenEXRCore")
    message(FATAL_ERROR "OpenEXR not found at ${OPENEXR_DIR}. Run: cd deps && git clone https://github.com/AcademySoftwareFoundation/openexr.git")
endif()
if(NOT EXISTS "${IMATH_DIR}/src/Imath")
    message(FATAL_ERROR "Imath not found at ${IMATH_DIR}. Run: cd deps && git clone https://github.com/AcademySoftwareFoundation/Imath.git")
endif()

# OpenEXRCore sources
file(GLOB OPENEXR_CORE_SOURCES
    "${OPENEXR_DIR}/src/lib/OpenEXRCore/*.c"
)

# Our WASM glue code
set(WASM_SOURCES
    "${CMAKE_SOURCE_DIR}/src/openexr_wasm.c"
    "${CMAKE_SOURCE_DIR}/src/ht_stubs.c"
)

# Combine all sources
set(ALL_SOURCES
    ${WASM_SOURCES}
    ${OPENEXR_CORE_SOURCES}
)

# Include directories
set(INCLUDE_DIRS
    "${CMAKE_SOURCE_DIR}/include"
    "${CMAKE_SOURCE_DIR}/src"
    "${OPENEXR_DIR}/src/lib/OpenEXRCore"
    "${OPENEXR_DIR}/src/lib"
    "${IMATH_DIR}/src/Imath"
    "${IMATH_DIR}/src"
)

# Compile definitions
add_compile_definitions(
    OPENEXR_CORE_STATIC_DEFINE
    IMATH_HALF_USE_LOOKUP_TABLE=0
)

if(EMSCRIPTEN)
    message(STATUS "Building for Emscripten/WASM")

    add_executable(openexr ${ALL_SOURCES})
    target_include_directories(openexr PRIVATE ${INCLUDE_DIRS})

    # Compile options
    target_compile_options(openexr PRIVATE
        -O3
        -fno-exceptions
        -fno-rtti
        -DNDEBUG
        -U__ARM_NEON
        -U__ARM_NEON__
        -UIMF_HAVE_NEON
    )

    # Exported functions
    set(EXPORTED_FUNCTIONS
        "_malloc"
        "_free"
        "_exr_wasm_init"
        "_exr_wasm_version"
        "_exr_wasm_create_write_context"
        "_exr_wasm_add_channel"
        "_exr_wasm_set_compression"
        "_exr_wasm_set_chromaticities"
        "_exr_wasm_set_adopt_neutral"
        "_exr_wasm_write_pixels"
        "_exr_wasm_write_interleaved"
        "_exr_wasm_finalize"
        "_exr_wasm_get_output_ptr"
        "_exr_wasm_get_output_size"
        "_exr_wasm_destroy_context"
        "_exr_wasm_create_read_context"
        "_exr_wasm_get_dimensions"
        "_exr_wasm_get_channel_count"
        "_exr_wasm_get_channel_name"
        "_exr_wasm_read_pixels"
        "_exr_wasm_get_chromaticities"
        "_exr_wasm_get_last_error"
        "_exr_wasm_clear_error"
        "_exr_wasm_get_memory_stats"
    )

    string(REPLACE ";" "," EXPORTED_FUNCTIONS_STR "${EXPORTED_FUNCTIONS}")

    target_link_options(openexr PRIVATE
        -sWASM=1
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=OpenEXR
        -sENVIRONMENT=web,worker

        -sALLOW_MEMORY_GROWTH=1
        -sINITIAL_MEMORY=16777216
        -sMAXIMUM_MEMORY=2147483648
        -sSTACK_SIZE=1048576

        "-sEXPORTED_FUNCTIONS=[${EXPORTED_FUNCTIONS_STR}]"
        -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,getValue,setValue,UTF8ToString,stringToUTF8,HEAP8,HEAPU8,HEAP16,HEAPU16,HEAP32,HEAPU32,HEAPF32,HEAPF64

        -O3
        --closure 1

        -sNO_FILESYSTEM=1
        -sUSE_PTHREADS=0

        -o openexr.js
    )

    set_target_properties(openexr PROPERTIES
        SUFFIX ".js"
        OUTPUT_NAME "openexr"
    )

else()
    message(STATUS "Building native library for testing")

    add_library(openexr_static STATIC ${ALL_SOURCES})
    target_include_directories(openexr_static PRIVATE ${INCLUDE_DIRS})
    target_compile_options(openexr_static PRIVATE -O2 -g)

endif()
