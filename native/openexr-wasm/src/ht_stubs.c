/*
 * HT (JPEG 2000 HT) codec stubs for WASM build
 *
 * The HT codec requires OpenJPH library which is not included
 * in this WASM build. These stubs return an error for HT
 * compression/decompression requests.
 */

#include <openexr.h>

exr_result_t
internal_exr_apply_ht (exr_encode_pipeline_t* encode)
{
    return EXR_ERR_FEATURE_NOT_IMPLEMENTED;
}

exr_result_t
internal_exr_undo_ht (
    exr_decode_pipeline_t* decode,
    const void*            compressed_data,
    uint64_t               comp_buf_size,
    void*                  uncompressed_data,
    uint64_t               uncomp_buf_size)
{
    return EXR_ERR_FEATURE_NOT_IMPLEMENTED;
}
