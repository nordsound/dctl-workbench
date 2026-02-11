/*
 * OpenEXR WASM Glue Code
 *
 * SPDX-License-Identifier: BSD-3-Clause
 * Copyright 2026 rawdev project
 *
 * This provides a simplified C API for use with Emscripten WASM builds.
 * It wraps OpenEXRCore to enable memory-based I/O for browser environments.
 */

#ifndef OPENEXR_WASM_H
#define OPENEXR_WASM_H

#include <stdint.h>
#include <stddef.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define EXR_WASM_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXR_WASM_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* Compression types (matching OpenEXR values) */
typedef enum {
    EXR_WASM_COMPRESSION_NONE  = 0,
    EXR_WASM_COMPRESSION_RLE   = 1,
    EXR_WASM_COMPRESSION_ZIPS  = 2,
    EXR_WASM_COMPRESSION_ZIP   = 3,
    EXR_WASM_COMPRESSION_PIZ   = 4,
    EXR_WASM_COMPRESSION_PXR24 = 5,
    EXR_WASM_COMPRESSION_B44   = 6,
    EXR_WASM_COMPRESSION_B44A  = 7,
    EXR_WASM_COMPRESSION_DWAA  = 8,
    EXR_WASM_COMPRESSION_DWAB  = 9
} exr_wasm_compression_t;

/* Pixel types */
typedef enum {
    EXR_WASM_PIXEL_UINT  = 0,
    EXR_WASM_PIXEL_HALF  = 1,
    EXR_WASM_PIXEL_FLOAT = 2
} exr_wasm_pixel_type_t;

/* Result codes */
typedef enum {
    EXR_WASM_OK = 0,
    EXR_WASM_ERR_INVALID_CONTEXT = -1,
    EXR_WASM_ERR_INVALID_ARGUMENT = -2,
    EXR_WASM_ERR_OUT_OF_MEMORY = -3,
    EXR_WASM_ERR_WRITE_FAILED = -4,
    EXR_WASM_ERR_ENCODE_FAILED = -5,
    EXR_WASM_ERR_NOT_FINALIZED = -6,
    EXR_WASM_ERR_ALREADY_FINALIZED = -7,
    EXR_WASM_ERR_CHANNEL_LIMIT = -8,
    EXR_WASM_ERR_READ_FAILED = -9
} exr_wasm_result_t;

/* Chromaticities structure */
typedef struct {
    float red_x, red_y;
    float green_x, green_y;
    float blue_x, blue_y;
    float white_x, white_y;
} exr_wasm_chromaticities_t;

/* Forward declaration */
typedef struct exr_wasm_context_s exr_wasm_context_t;

/*
 * Initialize the WASM module
 * Returns: 0 on success
 */
EXR_WASM_EXPORT
int exr_wasm_init(void);

/*
 * Get version string
 */
EXR_WASM_EXPORT
const char* exr_wasm_version(void);

/* =====================================================
 * Write API
 * ===================================================== */

/*
 * Create a new write context for memory-based output
 *
 * @param width     Image width in pixels
 * @param height    Image height in pixels
 * @return          Context ID (>= 0) on success, negative error code on failure
 */
EXR_WASM_EXPORT
int exr_wasm_create_write_context(int width, int height);

/*
 * Add a channel to the write context
 *
 * @param ctx_id      Context ID from exr_wasm_create_write_context
 * @param name        Channel name (e.g., "R", "G", "B", "A")
 * @param pixel_type  Pixel data type (EXR_WASM_PIXEL_*)
 * @param x_sampling  Horizontal subsampling (usually 1)
 * @param y_sampling  Vertical subsampling (usually 1)
 * @return            0 on success, negative error code on failure
 */
EXR_WASM_EXPORT
int exr_wasm_add_channel(
    int ctx_id,
    const char* name,
    int pixel_type,
    int x_sampling,
    int y_sampling
);

/*
 * Set compression method
 *
 * @param ctx_id      Context ID
 * @param compression Compression type (EXR_WASM_COMPRESSION_*)
 * @return            0 on success
 */
EXR_WASM_EXPORT
int exr_wasm_set_compression(int ctx_id, int compression);

/*
 * Set chromaticities attribute (for ACES color space support)
 *
 * @param ctx_id  Context ID
 * @param red_x   Red primary X
 * @param red_y   Red primary Y
 * @param green_x Green primary X
 * @param green_y Green primary Y
 * @param blue_x  Blue primary X
 * @param blue_y  Blue primary Y
 * @param white_x White point X
 * @param white_y White point Y
 * @return        0 on success
 */
EXR_WASM_EXPORT
int exr_wasm_set_chromaticities(
    int ctx_id,
    float red_x, float red_y,
    float green_x, float green_y,
    float blue_x, float blue_y,
    float white_x, float white_y
);

/*
 * Set adopt illuminant white attribute
 * This is used for ACES2065-1 color space identification
 *
 * @param ctx_id  Context ID
 * @param value   1 for adopted neutral, 0 otherwise
 * @return        0 on success
 */
EXR_WASM_EXPORT
int exr_wasm_set_adopt_neutral(int ctx_id, int value);

/*
 * Write pixel data for all channels
 * Data layout: interleaved RGBARGBA... or planar depending on channel order
 *
 * For simple RGB/RGBA, data should be planar: all R, then all G, then all B, then all A
 * Each channel block is width * height * sizeof(pixel_type) bytes
 *
 * @param ctx_id    Context ID
 * @param data      Pointer to pixel data (Float32Array from JS)
 * @param start_y   Starting scanline (usually 0)
 * @param num_lines Number of scanlines to write (usually height)
 * @return          0 on success
 */
EXR_WASM_EXPORT
int exr_wasm_write_pixels(
    int ctx_id,
    const float* data,
    int start_y,
    int num_lines
);

/*
 * Write pixel data as interleaved RGB or RGBA
 * This is a convenience function that handles the common case of
 * interleaved pixel data.
 *
 * @param ctx_id       Context ID
 * @param data         Pointer to interleaved pixel data (RGBRGB... or RGBARGBA...)
 * @param num_channels Number of channels in the interleaved data (3 or 4)
 * @return             0 on success
 */
EXR_WASM_EXPORT
int exr_wasm_write_interleaved(
    int ctx_id,
    const float* data,
    int num_channels
);

/*
 * Finalize the EXR file and prepare output buffer
 * Must be called after all pixels are written
 *
 * @param ctx_id  Context ID
 * @return        0 on success
 */
EXR_WASM_EXPORT
int exr_wasm_finalize(int ctx_id);

/*
 * Get pointer to output buffer
 * Only valid after exr_wasm_finalize() is called
 *
 * @param ctx_id  Context ID
 * @return        Pointer to output buffer, or NULL on error
 */
EXR_WASM_EXPORT
uint8_t* exr_wasm_get_output_ptr(int ctx_id);

/*
 * Get size of output buffer
 * Only valid after exr_wasm_finalize() is called
 *
 * @param ctx_id  Context ID
 * @return        Size in bytes, or 0 on error
 */
EXR_WASM_EXPORT
size_t exr_wasm_get_output_size(int ctx_id);

/*
 * Destroy a write context and free all resources
 *
 * @param ctx_id  Context ID
 */
EXR_WASM_EXPORT
void exr_wasm_destroy_context(int ctx_id);

/* =====================================================
 * Read API (Phase 2)
 * ===================================================== */

/*
 * Create a read context from memory buffer
 *
 * @param data  Pointer to EXR data
 * @param size  Size of data in bytes
 * @return      Context ID (>= 0) on success, negative error code on failure
 */
EXR_WASM_EXPORT
int exr_wasm_create_read_context(const uint8_t* data, size_t size);

/*
 * Get image dimensions from read context
 *
 * @param ctx_id  Context ID
 * @param width   Output: image width
 * @param height  Output: image height
 * @return        0 on success
 */
EXR_WASM_EXPORT
int exr_wasm_get_dimensions(int ctx_id, int* width, int* height);

/*
 * Get number of channels
 *
 * @param ctx_id  Context ID
 * @return        Number of channels, or negative error code
 */
EXR_WASM_EXPORT
int exr_wasm_get_channel_count(int ctx_id);

/*
 * Get channel name by index
 *
 * @param ctx_id  Context ID
 * @param index   Channel index
 * @return        Channel name string, or NULL
 */
EXR_WASM_EXPORT
const char* exr_wasm_get_channel_name(int ctx_id, int index);

/*
 * Get channel pixel type by index
 *
 * @param ctx_id  Context ID
 * @param index   Channel index
 * @return        Pixel type (0=UINT, 1=HALF, 2=FLOAT), or -1 on error
 */
EXR_WASM_EXPORT
int exr_wasm_get_channel_pixel_type(int ctx_id, int index);

/*
 * Read all pixel data as float
 * Output buffer must be pre-allocated: width * height * num_channels * sizeof(float)
 *
 * @param ctx_id  Context ID
 * @param output  Output buffer for pixel data
 * @return        0 on success
 */
EXR_WASM_EXPORT
int exr_wasm_read_pixels(int ctx_id, float* output);

/*
 * Get chromaticities if present
 *
 * @param ctx_id  Context ID
 * @param chroma  Output: chromaticities
 * @return        0 if chromaticities present, non-zero otherwise
 */
EXR_WASM_EXPORT
int exr_wasm_get_chromaticities(int ctx_id, exr_wasm_chromaticities_t* chroma);

/* =====================================================
 * Utility Functions
 * ===================================================== */

/*
 * Get last error message
 *
 * @return  Error message string, or NULL if no error
 */
EXR_WASM_EXPORT
const char* exr_wasm_get_last_error(void);

/*
 * Clear last error
 */
EXR_WASM_EXPORT
void exr_wasm_clear_error(void);

/*
 * Get memory statistics
 *
 * @param allocated  Output: total bytes allocated
 * @param peak       Output: peak allocation
 */
EXR_WASM_EXPORT
void exr_wasm_get_memory_stats(size_t* allocated, size_t* peak);

#ifdef __cplusplus
}
#endif

#endif /* OPENEXR_WASM_H */
