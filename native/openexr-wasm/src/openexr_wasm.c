/*
 * OpenEXR WASM Glue Code Implementation
 *
 * SPDX-License-Identifier: BSD-3-Clause
 * Copyright 2026 rawdev project
 */

#include "openexr_wasm.h"
#include <openexr.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>

/* =====================================================
 * Constants and Configuration
 * ===================================================== */

#define MAX_CONTEXTS 16
#define MAX_CHANNELS 32
#define INITIAL_BUFFER_SIZE (4 * 1024 * 1024)  /* 4MB initial buffer */
#define ERROR_BUFFER_SIZE 1024

/* =====================================================
 * Memory Stream Implementation
 * ===================================================== */

typedef struct {
    uint8_t* buffer;
    size_t   size;       /* Current data size */
    size_t   capacity;   /* Allocated capacity */
    size_t   position;   /* Current read position */
    int      owns_buffer; /* 1 if we own the buffer */
} memory_stream_t;

static memory_stream_t* memory_stream_create(size_t initial_capacity) {
    memory_stream_t* stream = (memory_stream_t*)calloc(1, sizeof(memory_stream_t));
    if (!stream) return NULL;

    stream->buffer = (uint8_t*)malloc(initial_capacity);
    if (!stream->buffer) {
        free(stream);
        return NULL;
    }

    stream->capacity = initial_capacity;
    stream->size = 0;
    stream->position = 0;
    stream->owns_buffer = 1;

    return stream;
}

static memory_stream_t* memory_stream_create_from_data(const uint8_t* data, size_t size) {
    memory_stream_t* stream = (memory_stream_t*)calloc(1, sizeof(memory_stream_t));
    if (!stream) return NULL;

    /* Copy data to our own buffer */
    stream->buffer = (uint8_t*)malloc(size);
    if (!stream->buffer) {
        free(stream);
        return NULL;
    }

    memcpy(stream->buffer, data, size);
    stream->capacity = size;
    stream->size = size;
    stream->position = 0;
    stream->owns_buffer = 1;

    return stream;
}

static void memory_stream_destroy(memory_stream_t* stream) {
    if (!stream) return;
    if (stream->owns_buffer && stream->buffer) {
        free(stream->buffer);
    }
    free(stream);
}

static int memory_stream_ensure_capacity(memory_stream_t* stream, size_t required) {
    if (required <= stream->capacity) return 0;

    size_t new_capacity = stream->capacity * 2;
    while (new_capacity < required) {
        new_capacity *= 2;
    }

    uint8_t* new_buffer = (uint8_t*)realloc(stream->buffer, new_capacity);
    if (!new_buffer) return -1;

    stream->buffer = new_buffer;
    stream->capacity = new_capacity;
    return 0;
}

/* =====================================================
 * OpenEXR Stream Callbacks
 * ===================================================== */

static int64_t memory_stream_write_cb(
    exr_const_context_t ctxt,
    void* userdata,
    const void* buffer,
    uint64_t sz,
    uint64_t offset,
    exr_stream_error_func_ptr_t error_cb)
{
    (void)ctxt;
    (void)error_cb;

    memory_stream_t* stream = (memory_stream_t*)userdata;
    if (!stream) return -1;

    uint64_t end_pos = offset + sz;
    if (memory_stream_ensure_capacity(stream, (size_t)end_pos) != 0) {
        return -1;
    }

    memcpy(stream->buffer + offset, buffer, (size_t)sz);

    if (end_pos > stream->size) {
        stream->size = (size_t)end_pos;
    }

    return (int64_t)sz;
}

static int64_t memory_stream_read_cb(
    exr_const_context_t ctxt,
    void* userdata,
    void* buffer,
    uint64_t sz,
    uint64_t offset,
    exr_stream_error_func_ptr_t error_cb)
{
    (void)ctxt;
    (void)error_cb;

    memory_stream_t* stream = (memory_stream_t*)userdata;
    if (!stream) return -1;

    if (offset >= stream->size) return 0;

    uint64_t available = stream->size - offset;
    uint64_t to_read = (sz < available) ? sz : available;

    memcpy(buffer, stream->buffer + offset, (size_t)to_read);

    return (int64_t)to_read;
}

static int64_t memory_stream_size_cb(
    exr_const_context_t ctxt,
    void* userdata)
{
    (void)ctxt;

    memory_stream_t* stream = (memory_stream_t*)userdata;
    if (!stream) return -1;

    return (int64_t)stream->size;
}

static void memory_stream_destroy_cb(
    exr_const_context_t ctxt,
    void* userdata,
    int failed)
{
    (void)ctxt;
    (void)failed;
    /* We don't destroy the stream here - we do it in exr_wasm_destroy_context */
    (void)userdata;
}

/* =====================================================
 * Context Management
 * ===================================================== */

typedef struct {
    char name[64];
    exr_pixel_type_t pixel_type;
    int x_sampling;
    int y_sampling;
} channel_info_t;

typedef struct exr_wasm_context_s {
    int in_use;
    int is_write;           /* 1 for write context, 0 for read */
    int finalized;

    int width;
    int height;

    exr_context_t exr_ctx;
    memory_stream_t* stream;

    /* Channel info */
    channel_info_t channels[MAX_CHANNELS];
    int num_channels;

    /* Compression */
    exr_compression_t compression;

    /* Chromaticities */
    int has_chromaticities;
    exr_attr_chromaticities_t chromaticities;

    /* Adopt neutral */
    int adopt_neutral;

    /* Pixel data buffer (interleaved to planar conversion) */
    float* pixel_buffer;
    size_t pixel_buffer_size;

} exr_wasm_context_impl_t;

static exr_wasm_context_impl_t g_contexts[MAX_CONTEXTS];
static char g_error_buffer[ERROR_BUFFER_SIZE];
static size_t g_memory_allocated = 0;
static size_t g_memory_peak = 0;

/* =====================================================
 * Error Handling
 * ===================================================== */

static void set_error(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vsnprintf(g_error_buffer, ERROR_BUFFER_SIZE, fmt, args);
    va_end(args);
}

static void exr_error_handler(
    exr_const_context_t ctxt,
    exr_result_t code,
    const char* msg)
{
    (void)ctxt;
    snprintf(g_error_buffer, ERROR_BUFFER_SIZE, "OpenEXR error %d: %s", code, msg);
}

/* =====================================================
 * Public API Implementation
 * ===================================================== */

EXR_WASM_EXPORT
int exr_wasm_init(void) {
    memset(g_contexts, 0, sizeof(g_contexts));
    memset(g_error_buffer, 0, sizeof(g_error_buffer));
    g_memory_allocated = 0;
    g_memory_peak = 0;
    return 0;
}

EXR_WASM_EXPORT
const char* exr_wasm_version(void) {
    return "OpenEXR WASM 1.0.0";
}

EXR_WASM_EXPORT
int exr_wasm_create_write_context(int width, int height) {
    if (width <= 0 || height <= 0) {
        set_error("Invalid dimensions: %dx%d", width, height);
        return EXR_WASM_ERR_INVALID_ARGUMENT;
    }

    /* Find free context slot */
    int ctx_id = -1;
    for (int i = 0; i < MAX_CONTEXTS; i++) {
        if (!g_contexts[i].in_use) {
            ctx_id = i;
            break;
        }
    }

    if (ctx_id < 0) {
        set_error("No free context slots");
        return EXR_WASM_ERR_OUT_OF_MEMORY;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];
    memset(ctx, 0, sizeof(*ctx));

    ctx->in_use = 1;
    ctx->is_write = 1;
    ctx->width = width;
    ctx->height = height;
    ctx->compression = EXR_COMPRESSION_ZIP;  /* Default compression */

    /* Create memory stream */
    ctx->stream = memory_stream_create(INITIAL_BUFFER_SIZE);
    if (!ctx->stream) {
        ctx->in_use = 0;
        set_error("Failed to create memory stream");
        return EXR_WASM_ERR_OUT_OF_MEMORY;
    }

    return ctx_id;
}

EXR_WASM_EXPORT
int exr_wasm_add_channel(
    int ctx_id,
    const char* name,
    int pixel_type,
    int x_sampling,
    int y_sampling)
{
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        set_error("Invalid context ID: %d", ctx_id);
        return EXR_WASM_ERR_INVALID_CONTEXT;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (ctx->finalized) {
        set_error("Context already finalized");
        return EXR_WASM_ERR_ALREADY_FINALIZED;
    }

    if (ctx->num_channels >= MAX_CHANNELS) {
        set_error("Too many channels (max %d)", MAX_CHANNELS);
        return EXR_WASM_ERR_CHANNEL_LIMIT;
    }

    if (!name || strlen(name) == 0) {
        set_error("Invalid channel name");
        return EXR_WASM_ERR_INVALID_ARGUMENT;
    }

    channel_info_t* ch = &ctx->channels[ctx->num_channels];
    strncpy(ch->name, name, sizeof(ch->name) - 1);
    ch->name[sizeof(ch->name) - 1] = '\0';
    ch->pixel_type = (exr_pixel_type_t)pixel_type;
    ch->x_sampling = x_sampling > 0 ? x_sampling : 1;
    ch->y_sampling = y_sampling > 0 ? y_sampling : 1;

    ctx->num_channels++;

    return 0;
}

EXR_WASM_EXPORT
int exr_wasm_set_compression(int ctx_id, int compression) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return EXR_WASM_ERR_INVALID_CONTEXT;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (ctx->finalized) {
        return EXR_WASM_ERR_ALREADY_FINALIZED;
    }

    if (compression < 0 || compression >= EXR_COMPRESSION_LAST_TYPE) {
        set_error("Invalid compression type: %d", compression);
        return EXR_WASM_ERR_INVALID_ARGUMENT;
    }

    ctx->compression = (exr_compression_t)compression;
    return 0;
}

EXR_WASM_EXPORT
int exr_wasm_set_chromaticities(
    int ctx_id,
    float red_x, float red_y,
    float green_x, float green_y,
    float blue_x, float blue_y,
    float white_x, float white_y)
{
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return EXR_WASM_ERR_INVALID_CONTEXT;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (ctx->finalized) {
        return EXR_WASM_ERR_ALREADY_FINALIZED;
    }

    ctx->has_chromaticities = 1;
    ctx->chromaticities.red_x = red_x;
    ctx->chromaticities.red_y = red_y;
    ctx->chromaticities.green_x = green_x;
    ctx->chromaticities.green_y = green_y;
    ctx->chromaticities.blue_x = blue_x;
    ctx->chromaticities.blue_y = blue_y;
    ctx->chromaticities.white_x = white_x;
    ctx->chromaticities.white_y = white_y;

    return 0;
}

EXR_WASM_EXPORT
int exr_wasm_set_adopt_neutral(int ctx_id, int value) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return EXR_WASM_ERR_INVALID_CONTEXT;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (ctx->finalized) {
        return EXR_WASM_ERR_ALREADY_FINALIZED;
    }

    ctx->adopt_neutral = value ? 1 : 0;
    return 0;
}

/* Internal helper to write EXR using OpenEXRCore */
static int write_exr_internal(exr_wasm_context_impl_t* ctx, const float* pixel_data) {
    exr_result_t rv;

    /* Set up context initializer with custom stream callbacks */
    exr_context_initializer_t init = EXR_DEFAULT_CONTEXT_INITIALIZER;
    init.error_handler_fn = exr_error_handler;
    init.user_data = ctx->stream;
    init.write_fn = memory_stream_write_cb;
    init.destroy_fn = memory_stream_destroy_cb;

    /* Create write context */
    rv = exr_start_write(&ctx->exr_ctx, "memory", EXR_WRITE_FILE_DIRECTLY, &init);
    if (rv != EXR_ERR_SUCCESS) {
        set_error("Failed to create EXR write context: %d", rv);
        return EXR_WASM_ERR_WRITE_FAILED;
    }

    /* Add a part (required before initializing attributes) */
    int part_index = 0;
    rv = exr_add_part(ctx->exr_ctx, "default", EXR_STORAGE_SCANLINE, &part_index);
    if (rv != EXR_ERR_SUCCESS) {
        set_error("Failed to add part: %d", rv);
        exr_finish(&ctx->exr_ctx);
        return EXR_WASM_ERR_WRITE_FAILED;
    }

    /* Initialize required attributes with simple helper */
    rv = exr_initialize_required_attr_simple(
        ctx->exr_ctx, part_index,
        ctx->width, ctx->height,
        ctx->compression
    );
    if (rv != EXR_ERR_SUCCESS) {
        set_error("Failed to initialize attributes: %d", rv);
        exr_finish(&ctx->exr_ctx);
        return EXR_WASM_ERR_WRITE_FAILED;
    }

    /* Add channels (must be in alphabetical order for EXR) */
    /* First, we need to sort channels alphabetically */
    int channel_order[MAX_CHANNELS];
    for (int i = 0; i < ctx->num_channels; i++) {
        channel_order[i] = i;
    }

    /* Simple bubble sort by name */
    for (int i = 0; i < ctx->num_channels - 1; i++) {
        for (int j = 0; j < ctx->num_channels - i - 1; j++) {
            if (strcmp(ctx->channels[channel_order[j]].name,
                       ctx->channels[channel_order[j + 1]].name) > 0) {
                int tmp = channel_order[j];
                channel_order[j] = channel_order[j + 1];
                channel_order[j + 1] = tmp;
            }
        }
    }

    /* Add channels in sorted order */
    for (int i = 0; i < ctx->num_channels; i++) {
        int idx = channel_order[i];
        channel_info_t* ch = &ctx->channels[idx];

        rv = exr_add_channel(
            ctx->exr_ctx, 0,
            ch->name,
            ch->pixel_type,
            EXR_PERCEPTUALLY_LOGARITHMIC,
            ch->x_sampling,
            ch->y_sampling
        );
        if (rv != EXR_ERR_SUCCESS) {
            set_error("Failed to add channel %s: %d", ch->name, rv);
            exr_finish(&ctx->exr_ctx);
            return EXR_WASM_ERR_WRITE_FAILED;
        }
    }

    /* Set chromaticities if specified */
    if (ctx->has_chromaticities) {
        rv = exr_attr_set_chromaticities(
            ctx->exr_ctx, 0,
            "chromaticities",
            &ctx->chromaticities
        );
        if (rv != EXR_ERR_SUCCESS) {
            set_error("Failed to set chromaticities: %d", rv);
            exr_finish(&ctx->exr_ctx);
            return EXR_WASM_ERR_WRITE_FAILED;
        }
    }

    /* Set adoptedNeutral if specified (ACES) */
    if (ctx->adopt_neutral) {
        exr_attr_v2f_t neutral = { 0.0f, 0.0f };
        rv = exr_attr_set_v2f(ctx->exr_ctx, 0, "adoptedNeutral", &neutral);
        if (rv != EXR_ERR_SUCCESS) {
            /* Non-fatal - just continue */
        }
    }

    /* Write header */
    rv = exr_write_header(ctx->exr_ctx);
    if (rv != EXR_ERR_SUCCESS) {
        set_error("Failed to write header: %d", rv);
        exr_finish(&ctx->exr_ctx);
        return EXR_WASM_ERR_WRITE_FAILED;
    }

    /* Get encoding info */
    int32_t scanlines_per_chunk;
    rv = exr_get_scanlines_per_chunk(ctx->exr_ctx, 0, &scanlines_per_chunk);
    if (rv != EXR_ERR_SUCCESS) {
        scanlines_per_chunk = 1;
    }

    /* Get chunk count */
    int32_t chunk_count;
    rv = exr_get_chunk_count(ctx->exr_ctx, 0, &chunk_count);
    if (rv != EXR_ERR_SUCCESS) {
        set_error("Failed to get chunk count: %d", rv);
        exr_finish(&ctx->exr_ctx);
        return EXR_WASM_ERR_WRITE_FAILED;
    }

    /* Encode and write each chunk */
    exr_encode_pipeline_t encoder = EXR_ENCODE_PIPELINE_INITIALIZER;

    for (int32_t chunk_idx = 0; chunk_idx < chunk_count; chunk_idx++) {
        exr_chunk_info_t cinfo;
        rv = exr_write_scanline_chunk_info(ctx->exr_ctx, 0, chunk_idx * scanlines_per_chunk, &cinfo);
        if (rv != EXR_ERR_SUCCESS) {
            set_error("Failed to get chunk info for chunk %d: %d", chunk_idx, rv);
            exr_finish(&ctx->exr_ctx);
            return EXR_WASM_ERR_ENCODE_FAILED;
        }

        rv = exr_encoding_initialize(ctx->exr_ctx, 0, &cinfo, &encoder);
        if (rv != EXR_ERR_SUCCESS) {
            set_error("Failed to initialize encoder: %d", rv);
            exr_finish(&ctx->exr_ctx);
            return EXR_WASM_ERR_ENCODE_FAILED;
        }

        /* Set up channel pointers */
        /* Pixel data is assumed to be planar: all R, all G, all B, [all A] */
        size_t pixels_per_channel = (size_t)ctx->width * ctx->height;

        for (int16_t ch_idx = 0; ch_idx < encoder.channel_count; ch_idx++) {
            /* Find which input channel this corresponds to (by name) */
            const char* ch_name = encoder.channels[ch_idx].channel_name;
            int input_ch = -1;

            for (int i = 0; i < ctx->num_channels; i++) {
                if (strcmp(ctx->channels[i].name, ch_name) == 0) {
                    input_ch = i;
                    break;
                }
            }

            if (input_ch < 0) {
                set_error("Channel %s not found in input", ch_name);
                exr_encoding_destroy(ctx->exr_ctx, &encoder);
                exr_finish(&ctx->exr_ctx);
                return EXR_WASM_ERR_ENCODE_FAILED;
            }

            /* Calculate offset into planar data */
            const float* ch_data = pixel_data + (input_ch * pixels_per_channel);

            /* Point to the correct scanline */
            int start_y = cinfo.start_y;
            const float* scanline_data = ch_data + (start_y * ctx->width);

            encoder.channels[ch_idx].encode_from_ptr = (const uint8_t*)scanline_data;
            encoder.channels[ch_idx].user_pixel_stride = sizeof(float);
            encoder.channels[ch_idx].user_line_stride = ctx->width * sizeof(float);
            encoder.channels[ch_idx].user_bytes_per_element = sizeof(float);
            encoder.channels[ch_idx].user_data_type = EXR_PIXEL_FLOAT;
        }

        rv = exr_encoding_choose_default_routines(ctx->exr_ctx, 0, &encoder);
        if (rv != EXR_ERR_SUCCESS) {
            set_error("Failed to choose encoding routines: %d", rv);
            exr_encoding_destroy(ctx->exr_ctx, &encoder);
            exr_finish(&ctx->exr_ctx);
            return EXR_WASM_ERR_ENCODE_FAILED;
        }

        rv = exr_encoding_run(ctx->exr_ctx, 0, &encoder);
        if (rv != EXR_ERR_SUCCESS) {
            set_error("Failed to encode chunk %d: %d", chunk_idx, rv);
            exr_encoding_destroy(ctx->exr_ctx, &encoder);
            exr_finish(&ctx->exr_ctx);
            return EXR_WASM_ERR_ENCODE_FAILED;
        }

        exr_encoding_destroy(ctx->exr_ctx, &encoder);
        encoder = (exr_encode_pipeline_t)EXR_ENCODE_PIPELINE_INITIALIZER;
    }

    /* Finish and close */
    rv = exr_finish(&ctx->exr_ctx);
    ctx->exr_ctx = NULL;

    if (rv != EXR_ERR_SUCCESS) {
        set_error("Failed to finish EXR: %d", rv);
        return EXR_WASM_ERR_WRITE_FAILED;
    }

    return 0;
}

EXR_WASM_EXPORT
int exr_wasm_write_pixels(
    int ctx_id,
    const float* data,
    int start_y,
    int num_lines)
{
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return EXR_WASM_ERR_INVALID_CONTEXT;
    }

    (void)start_y;
    (void)num_lines;

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (ctx->finalized) {
        return EXR_WASM_ERR_ALREADY_FINALIZED;
    }

    if (ctx->num_channels == 0) {
        set_error("No channels defined");
        return EXR_WASM_ERR_INVALID_ARGUMENT;
    }

    if (!data) {
        set_error("NULL pixel data");
        return EXR_WASM_ERR_INVALID_ARGUMENT;
    }

    /* Store reference to pixel data for finalize */
    /* For now, we copy the data to our buffer */
    size_t total_pixels = (size_t)ctx->width * ctx->height * ctx->num_channels;
    size_t data_size = total_pixels * sizeof(float);

    if (ctx->pixel_buffer_size < data_size) {
        free(ctx->pixel_buffer);
        ctx->pixel_buffer = (float*)malloc(data_size);
        if (!ctx->pixel_buffer) {
            return EXR_WASM_ERR_OUT_OF_MEMORY;
        }
        ctx->pixel_buffer_size = data_size;
    }

    memcpy(ctx->pixel_buffer, data, data_size);

    return 0;
}

EXR_WASM_EXPORT
int exr_wasm_write_interleaved(
    int ctx_id,
    const float* data,
    int num_channels)
{
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return EXR_WASM_ERR_INVALID_CONTEXT;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (ctx->finalized) {
        return EXR_WASM_ERR_ALREADY_FINALIZED;
    }

    if (num_channels != ctx->num_channels) {
        set_error("Channel count mismatch: got %d, expected %d", num_channels, ctx->num_channels);
        return EXR_WASM_ERR_INVALID_ARGUMENT;
    }

    /* Convert interleaved to planar */
    size_t pixels = (size_t)ctx->width * ctx->height;
    size_t total_floats = pixels * num_channels;
    size_t data_size = total_floats * sizeof(float);

    if (ctx->pixel_buffer_size < data_size) {
        free(ctx->pixel_buffer);
        ctx->pixel_buffer = (float*)malloc(data_size);
        if (!ctx->pixel_buffer) {
            return EXR_WASM_ERR_OUT_OF_MEMORY;
        }
        ctx->pixel_buffer_size = data_size;
    }

    /* De-interleave: RGBRGB... -> RRR...GGG...BBB... */
    for (int ch = 0; ch < num_channels; ch++) {
        float* dst = ctx->pixel_buffer + (ch * pixels);
        const float* src = data + ch;
        for (size_t i = 0; i < pixels; i++) {
            dst[i] = src[i * num_channels];
        }
    }

    return 0;
}

EXR_WASM_EXPORT
int exr_wasm_finalize(int ctx_id) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return EXR_WASM_ERR_INVALID_CONTEXT;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (ctx->finalized) {
        return EXR_WASM_ERR_ALREADY_FINALIZED;
    }

    if (!ctx->pixel_buffer) {
        set_error("No pixel data written");
        return EXR_WASM_ERR_INVALID_ARGUMENT;
    }

    int result = write_exr_internal(ctx, ctx->pixel_buffer);
    if (result == 0) {
        ctx->finalized = 1;
    }

    return result;
}

EXR_WASM_EXPORT
uint8_t* exr_wasm_get_output_ptr(int ctx_id) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return NULL;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (!ctx->finalized) {
        return NULL;
    }

    return ctx->stream->buffer;
}

EXR_WASM_EXPORT
size_t exr_wasm_get_output_size(int ctx_id) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return 0;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (!ctx->finalized) {
        return 0;
    }

    return ctx->stream->size;
}

EXR_WASM_EXPORT
void exr_wasm_destroy_context(int ctx_id) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (ctx->exr_ctx) {
        exr_finish(&ctx->exr_ctx);
        ctx->exr_ctx = NULL;
    }

    if (ctx->stream) {
        memory_stream_destroy(ctx->stream);
        ctx->stream = NULL;
    }

    if (ctx->pixel_buffer) {
        free(ctx->pixel_buffer);
        ctx->pixel_buffer = NULL;
    }

    ctx->in_use = 0;
}

/* =====================================================
 * Read API (Phase 2 - Basic Implementation)
 * ===================================================== */

EXR_WASM_EXPORT
int exr_wasm_create_read_context(const uint8_t* data, size_t size) {
    if (!data || size == 0) {
        set_error("Invalid input data");
        return EXR_WASM_ERR_INVALID_ARGUMENT;
    }

    /* Find free context slot */
    int ctx_id = -1;
    for (int i = 0; i < MAX_CONTEXTS; i++) {
        if (!g_contexts[i].in_use) {
            ctx_id = i;
            break;
        }
    }

    if (ctx_id < 0) {
        set_error("No free context slots");
        return EXR_WASM_ERR_OUT_OF_MEMORY;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];
    memset(ctx, 0, sizeof(*ctx));

    ctx->in_use = 1;
    ctx->is_write = 0;

    /* Create memory stream from input data */
    ctx->stream = memory_stream_create_from_data(data, size);
    if (!ctx->stream) {
        ctx->in_use = 0;
        set_error("Failed to create memory stream");
        return EXR_WASM_ERR_OUT_OF_MEMORY;
    }

    /* Set up context initializer */
    exr_context_initializer_t init = EXR_DEFAULT_CONTEXT_INITIALIZER;
    init.error_handler_fn = exr_error_handler;
    init.user_data = ctx->stream;
    init.read_fn = memory_stream_read_cb;
    init.size_fn = memory_stream_size_cb;
    init.destroy_fn = memory_stream_destroy_cb;

    /* Open for reading */
    exr_result_t rv = exr_start_read(&ctx->exr_ctx, "memory", &init);
    if (rv != EXR_ERR_SUCCESS) {
        memory_stream_destroy(ctx->stream);
        ctx->stream = NULL;
        ctx->in_use = 0;
        set_error("Failed to open EXR: %d", rv);
        return EXR_WASM_ERR_READ_FAILED;
    }

    /* Get dimensions */
    exr_attr_box2i_t data_window;
    rv = exr_get_data_window(ctx->exr_ctx, 0, &data_window);
    if (rv != EXR_ERR_SUCCESS) {
        exr_finish(&ctx->exr_ctx);
        memory_stream_destroy(ctx->stream);
        ctx->stream = NULL;
        ctx->in_use = 0;
        return EXR_WASM_ERR_READ_FAILED;
    }

    ctx->width = data_window.max.x - data_window.min.x + 1;
    ctx->height = data_window.max.y - data_window.min.y + 1;

    /* Get channel info */
    const exr_attr_chlist_t* chlist;
    rv = exr_get_channels(ctx->exr_ctx, 0, &chlist);
    if (rv == EXR_ERR_SUCCESS && chlist) {
        ctx->num_channels = chlist->num_channels;
        for (int i = 0; i < chlist->num_channels && i < MAX_CHANNELS; i++) {
            strncpy(ctx->channels[i].name, chlist->entries[i].name.str, 63);
            ctx->channels[i].pixel_type = chlist->entries[i].pixel_type;
        }
    }

    /* Get compression */
    rv = exr_get_compression(ctx->exr_ctx, 0, &ctx->compression);
    if (rv != EXR_ERR_SUCCESS) {
        ctx->compression = EXR_COMPRESSION_NONE;  /* Default if not found */
    }

    return ctx_id;
}

EXR_WASM_EXPORT
int exr_wasm_get_dimensions(int ctx_id, int* width, int* height) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return EXR_WASM_ERR_INVALID_CONTEXT;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (width) *width = ctx->width;
    if (height) *height = ctx->height;

    return 0;
}

EXR_WASM_EXPORT
int exr_wasm_get_channel_count(int ctx_id) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return EXR_WASM_ERR_INVALID_CONTEXT;
    }

    return g_contexts[ctx_id].num_channels;
}

EXR_WASM_EXPORT
const char* exr_wasm_get_channel_name(int ctx_id, int index) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return NULL;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (index < 0 || index >= ctx->num_channels) {
        return NULL;
    }

    return ctx->channels[index].name;
}

EXR_WASM_EXPORT
int exr_wasm_get_channel_pixel_type(int ctx_id, int index) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return -1;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (index < 0 || index >= ctx->num_channels) {
        return -1;
    }

    return (int)ctx->channels[index].pixel_type;
}

EXR_WASM_EXPORT
int exr_wasm_get_compression(int ctx_id) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return -1;  /* Invalid context */
    }

    return (int)g_contexts[ctx_id].compression;
}

/* Helper: Convert half float to float */
static float half_to_float(uint16_t h) {
    uint32_t sign = (h >> 15) & 0x1;
    uint32_t exp = (h >> 10) & 0x1f;
    uint32_t mant = h & 0x3ff;

    if (exp == 0) {
        if (mant == 0) {
            /* Zero */
            uint32_t result = sign << 31;
            return *(float*)&result;
        } else {
            /* Denormalized */
            while (!(mant & 0x400)) {
                mant <<= 1;
                exp--;
            }
            exp++;
            mant &= ~0x400;
            exp += (127 - 15);
            uint32_t result = (sign << 31) | (exp << 23) | (mant << 13);
            return *(float*)&result;
        }
    } else if (exp == 31) {
        /* Inf or NaN */
        uint32_t result = (sign << 31) | 0x7f800000 | (mant << 13);
        return *(float*)&result;
    } else {
        /* Normalized */
        exp += (127 - 15);
        uint32_t result = (sign << 31) | (exp << 23) | (mant << 13);
        return *(float*)&result;
    }
}

EXR_WASM_EXPORT
int exr_wasm_read_pixels(int ctx_id, float* output) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return EXR_WASM_ERR_INVALID_CONTEXT;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (!output) {
        return EXR_WASM_ERR_INVALID_ARGUMENT;
    }

    exr_result_t rv;
    int width = ctx->width;
    int height = ctx->height;
    int num_channels = ctx->num_channels;

    /* Get data window */
    exr_attr_box2i_t datawin;
    rv = exr_get_data_window(ctx->exr_ctx, 0, &datawin);
    if (rv != EXR_ERR_SUCCESS) {
        set_error("Failed to get data window");
        return EXR_WASM_ERR_READ_FAILED;
    }

    /* Get scanlines per chunk */
    int32_t lines_per_chunk;
    rv = exr_get_scanlines_per_chunk(ctx->exr_ctx, 0, &lines_per_chunk);
    if (rv != EXR_ERR_SUCCESS) {
        set_error("Failed to get scanlines per chunk");
        return EXR_WASM_ERR_READ_FAILED;
    }

    /* Allocate per-channel buffers for one chunk */
    size_t bytes_per_channel = (size_t)width * (size_t)lines_per_chunk * sizeof(float);
    uint8_t** channel_buffers = (uint8_t**)calloc(num_channels, sizeof(uint8_t*));
    if (!channel_buffers) {
        set_error("Failed to allocate channel buffer pointers");
        return EXR_WASM_ERR_OUT_OF_MEMORY;
    }

    for (int c = 0; c < num_channels; c++) {
        channel_buffers[c] = (uint8_t*)malloc(bytes_per_channel);
        if (!channel_buffers[c]) {
            for (int j = 0; j < c; j++) free(channel_buffers[j]);
            free(channel_buffers);
            set_error("Failed to allocate channel buffer");
            return EXR_WASM_ERR_OUT_OF_MEMORY;
        }
    }

    /* Initialize decode pipeline */
    exr_decode_pipeline_t decoder = EXR_DECODE_PIPELINE_INITIALIZER;
    int first_chunk = 1;

    /* Process all chunks */
    for (int chunk_y = 0; chunk_y < height; chunk_y += lines_per_chunk) {
        int y = chunk_y + datawin.min.y;
        int chunk_height = (chunk_y + lines_per_chunk > height) ?
                           (height - chunk_y) : lines_per_chunk;

        /* Get chunk info */
        exr_chunk_info_t cinfo = {0};
        rv = exr_read_scanline_chunk_info(ctx->exr_ctx, 0, y, &cinfo);
        if (rv != EXR_ERR_SUCCESS) {
            set_error("Failed to read chunk info at y=%d", y);
            goto cleanup;
        }

        if (first_chunk) {
            /* Initialize pipeline on first chunk */
            rv = exr_decoding_initialize(ctx->exr_ctx, 0, &cinfo, &decoder);
            if (rv != EXR_ERR_SUCCESS) {
                set_error("Failed to initialize decoder");
                goto cleanup;
            }
            first_chunk = 0;
        } else {
            /* Update pipeline for subsequent chunks */
            rv = exr_decoding_update(ctx->exr_ctx, 0, &cinfo, &decoder);
            if (rv != EXR_ERR_SUCCESS) {
                set_error("Failed to update decoder");
                goto cleanup;
            }
        }

        /* Configure channel output pointers - request float output */
        for (int c = 0; c < decoder.channel_count; c++) {
            exr_coding_channel_info_t* ch = &decoder.channels[c];
            ch->decode_to_ptr = channel_buffers[c];
            ch->user_bytes_per_element = 4;  /* sizeof(float) */
            ch->user_data_type = EXR_PIXEL_FLOAT;
            ch->user_pixel_stride = 4;  /* sizeof(float) */
            ch->user_line_stride = width * 4;  /* width * sizeof(float) */
        }

        /* Choose default routines after setting up channels */
        rv = exr_decoding_choose_default_routines(ctx->exr_ctx, 0, &decoder);
        if (rv != EXR_ERR_SUCCESS) {
            set_error("Failed to choose decode routines");
            goto cleanup;
        }

        /* Run decode */
        rv = exr_decoding_run(ctx->exr_ctx, 0, &decoder);
        if (rv != EXR_ERR_SUCCESS) {
            set_error("Failed to decode chunk at y=%d", y);
            goto cleanup;
        }

        /* Interleave channel data to output buffer */
        /* EXR channels are typically in alphabetical order (A, B, G, R) */
        /* We need to output in the order they appear */
        for (int line = 0; line < chunk_height; line++) {
            int out_y = chunk_y + line;
            for (int x = 0; x < width; x++) {
                int pixel_idx = out_y * width + x;
                int out_base = pixel_idx * num_channels;
                int src_idx = line * width + x;

                for (int c = 0; c < num_channels; c++) {
                    float* src = (float*)channel_buffers[c];
                    output[out_base + c] = src[src_idx];
                }
            }
        }
    }

    rv = EXR_ERR_SUCCESS;

cleanup:
    exr_decoding_destroy(ctx->exr_ctx, &decoder);
    for (int c = 0; c < num_channels; c++) {
        if (channel_buffers[c]) free(channel_buffers[c]);
    }
    free(channel_buffers);

    return (rv == EXR_ERR_SUCCESS) ? 0 : EXR_WASM_ERR_READ_FAILED;
}

EXR_WASM_EXPORT
int exr_wasm_get_chromaticities(int ctx_id, exr_wasm_chromaticities_t* chroma) {
    if (ctx_id < 0 || ctx_id >= MAX_CONTEXTS || !g_contexts[ctx_id].in_use) {
        return EXR_WASM_ERR_INVALID_CONTEXT;
    }

    exr_wasm_context_impl_t* ctx = &g_contexts[ctx_id];

    if (!chroma) {
        return EXR_WASM_ERR_INVALID_ARGUMENT;
    }

    /* Try to read chromaticities from the file */
    exr_attr_chromaticities_t exr_chroma;
    exr_result_t rv = exr_attr_get_chromaticities(ctx->exr_ctx, 0, "chromaticities", &exr_chroma);

    if (rv != EXR_ERR_SUCCESS) {
        return -1;  /* No chromaticities found */
    }

    chroma->red_x = exr_chroma.red_x;
    chroma->red_y = exr_chroma.red_y;
    chroma->green_x = exr_chroma.green_x;
    chroma->green_y = exr_chroma.green_y;
    chroma->blue_x = exr_chroma.blue_x;
    chroma->blue_y = exr_chroma.blue_y;
    chroma->white_x = exr_chroma.white_x;
    chroma->white_y = exr_chroma.white_y;

    return 0;
}

/* =====================================================
 * Utility Functions
 * ===================================================== */

EXR_WASM_EXPORT
const char* exr_wasm_get_last_error(void) {
    if (g_error_buffer[0] == '\0') {
        return NULL;
    }
    return g_error_buffer;
}

EXR_WASM_EXPORT
void exr_wasm_clear_error(void) {
    g_error_buffer[0] = '\0';
}

EXR_WASM_EXPORT
void exr_wasm_get_memory_stats(size_t* allocated, size_t* peak) {
    if (allocated) *allocated = g_memory_allocated;
    if (peak) *peak = g_memory_peak;
}
