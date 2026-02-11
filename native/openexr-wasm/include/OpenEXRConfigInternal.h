// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) Contributors to the OpenEXR Project.
//
// Pre-configured for WASM build

#ifndef INCLUDED_OPENEXR_INTERNAL_CONFIG_H
#define INCLUDED_OPENEXR_INTERNAL_CONFIG_H 1

#pragma once

// Use internal deflate (libdeflate)
#define OPENEXR_USE_INTERNAL_DEFLATE 1

// No proc filesystem in WASM
// #define OPENEXR_IMF_HAVE_LINUX_PROCFS 1

// Not Darwin
// #define OPENEXR_IMF_HAVE_DARWIN 1

// Complete iomanip
#define OPENEXR_IMF_HAVE_COMPLETE_IOMANIP 1

// No sysconf in WASM
// #define OPENEXR_IMF_HAVE_SYSCONF_NPROCESSORS_ONLN 1

// No AVX in WASM (use WASM SIMD instead if needed)
// #define OPENEXR_IMF_HAVE_GCC_INLINE_ASM_AVX 1

// Not ARM - do NOT define OPENEXR_MISSING_ARM_VLD1
// (the #ifdef check in internal_dwa_simd.h is true if defined at all)

#endif // INCLUDED_OPENEXR_INTERNAL_CONFIG_H
