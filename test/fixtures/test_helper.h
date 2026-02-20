// Test helper header for #include resolution tests

__DEVICE__ float clamp01(float x) {
    return _clampf(x, 0.0f, 1.0f);
}

__DEVICE__ float3 apply_gain(float3 rgb, float gain) {
    return make_float3(rgb.x * gain, rgb.y * gain, rgb.z * gain);
}
