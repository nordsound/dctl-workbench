// SPDX-License-Identifier: BSD-3-Clause
// Copyright Contributors to the OpenEXR Project.
//
// Pre-configured for WASM build

#ifndef INCLUDED_IMATH_CONFIG_H
#define INCLUDED_IMATH_CONFIG_H 1

#pragma once

// Version
#define IMATH_VERSION_MAJOR 3
#define IMATH_VERSION_MINOR 1
#define IMATH_VERSION_PATCH 0
#define IMATH_VERSION_RELEASE_TYPE ""

#define IMATH_VERSION_STRING "3.1.0"
#define IMATH_PACKAGE_STRING "Imath 3.1.0"
#define IMATH_LIB_VERSION_STRING "3.1.0"

// Namespace configuration
#define IMATH_INTERNAL_NAMESPACE_CUSTOM 0
#define IMATH_INTERNAL_NAMESPACE Imath_3_1

#define IMATH_NAMESPACE_CUSTOM 0
#define IMATH_NAMESPACE Imath

// Half type configuration
// Disable lookup table to save memory in WASM
// #define IMATH_HALF_USE_LOOKUP_TABLE
// #define IMATH_HAVE_LARGE_STACK

// Version as hex
#define IMATH_VERSION_HEX \
    ((uint32_t (IMATH_VERSION_MAJOR) << 24) | \
     (uint32_t (IMATH_VERSION_MINOR) << 16) | \
     (uint32_t (IMATH_VERSION_PATCH) << 8))

// noexcept configuration
#define IMATH_USE_NOEXCEPT 1
#if IMATH_USE_NOEXCEPT
#    define IMATH_NOEXCEPT noexcept
#else
#    define IMATH_NOEXCEPT
#endif

// Foreign vector interop
#ifndef IMATH_FOREIGN_VECTOR_INTEROP
#    define IMATH_FOREIGN_VECTOR_INTEROP 1
#endif

// CUDA/HIP decorator
#if defined(__CUDACC__) || defined(__HIP__)
#    define IMATH_HOSTDEVICE __host__ __device__
#else
#    define IMATH_HOSTDEVICE
#endif

// Branch prediction hints
#if defined(__GNUC__) || defined(__clang__) || defined(__INTEL_COMPILER)
#    ifdef __cplusplus
#        define IMATH_LIKELY(x) (__builtin_expect (static_cast<bool> (x), true))
#        define IMATH_UNLIKELY(x) (__builtin_expect (static_cast<bool> (x), false))
#    else
#        define IMATH_LIKELY(x) (__builtin_expect ((x), 1))
#        define IMATH_UNLIKELY(x) (__builtin_expect ((x), 0))
#    endif
#else
#    define IMATH_LIKELY(x) (x)
#    define IMATH_UNLIKELY(x) (x)
#endif

// Attribute support
#ifndef __has_attribute
#    define __has_attribute(x) 0
#endif

// Deprecation
#if defined(_MSC_VER)
#    define IMATH_DEPRECATED(msg) __declspec(deprecated (msg))
#elif defined(__cplusplus) && __cplusplus >= 201402L
#    define IMATH_DEPRECATED(msg) [[deprecated (msg)]]
#elif defined(__GNUC__) || defined(__clang__)
#    define IMATH_DEPRECATED(msg) __attribute__ ((deprecated (msg)))
#else
#    define IMATH_DEPRECATED(msg)
#endif

// API visibility - disabled for static WASM build
// #define IMATH_ENABLE_API_VISIBILITY

// Export macros - empty for static build
// These are intentionally left undefined to let ImathExport.h define them
// based on the absence of IMATH_ENABLE_API_VISIBILITY

#endif // INCLUDED_IMATH_CONFIG_H
