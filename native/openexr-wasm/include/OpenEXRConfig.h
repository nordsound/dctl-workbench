// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) Contributors to the OpenEXR Project.
//
// Pre-configured for WASM build

#ifndef INCLUDED_OPENEXR_CONFIG_H
#define INCLUDED_OPENEXR_CONFIG_H 1

#pragma once

// Version info - must match OpenEXR source version
// Note: OPENEXR_VERSION_MAJOR etc. are also defined in openexr_version.h
// We skip defining them here to avoid redefinition warnings

#define OPENEXR_IMATH_SOVERSION 29
#define OPENEXR_IMATH_VERSION_MAJOR 3
#define OPENEXR_IMATH_VERSION_MINOR 1
#define OPENEXR_IMATH_VERSION_PATCH 0

#define OPENEXR_OPENJPH_VERSION_MAJOR 0
#define OPENEXR_OPENJPH_VERSION_MINOR 0
#define OPENEXR_OPENJPH_VERSION_PATCH 0

// No large stack support in WASM
// #define OPENEXR_HAVE_LARGE_STACK 1

// Namespace configuration
#define OPENEXR_IMF_INTERNAL_NAMESPACE_CUSTOM 0
#define OPENEXR_IMF_INTERNAL_NAMESPACE Imf_3_3

#define OPENEXR_IMF_NAMESPACE_CUSTOM 0
#define OPENEXR_IMF_NAMESPACE Imf

// Version strings
#define OPENEXR_VERSION_STRING "3.3.0"
#define OPENEXR_PACKAGE_STRING "OpenEXR 3.3.0"
#define OPENEXR_VERSION_RELEASE_TYPE ""
#define OPENEXR_VERSION_EXTRA ""
#define OPENEXR_LIB_VERSION_STRING "3.3.0"

// Version as hex
#define OPENEXR_VERSION_HEX \
    (((OPENEXR_VERSION_MAJOR) << 24) | \
     ((OPENEXR_VERSION_MINOR) << 16) | \
     ((OPENEXR_VERSION_PATCH) << 8))

// Attribute support
#ifndef __has_attribute
#    define __has_attribute(x) 0
#endif

// API visibility - disabled for static WASM build
// #define OPENEXR_ENABLE_API_VISIBILITY

// Embedded core functions
// #define OPENEXR_CORE_FUNCTIONS_EMBEDDED

// Export macros - all empty for static build
#define OPENEXR_EXPORT
#define OPENEXR_HIDDEN
#define OPENEXR_EXPORT_TYPE
#define OPENEXR_EXPORT_EXTERN_TEMPLATE
#define OPENEXR_EXPORT_ENUM
#define OPENEXR_EXPORT_TEMPLATE_TYPE
#define OPENEXR_EXPORT_TEMPLATE_INSTANCE

// Deprecation
#if defined(__cplusplus) && (__cplusplus >= 201402L)
#    define OPENEXR_DEPRECATED(msg) [[deprecated (msg)]]
#endif

#ifndef OPENEXR_DEPRECATED
#    ifdef _MSC_VER
#        define OPENEXR_DEPRECATED(msg) __declspec(deprecated (msg))
#    else
#        define OPENEXR_DEPRECATED(msg) __attribute__ ((deprecated (msg)))
#    endif
#endif

#endif // INCLUDED_OPENEXR_CONFIG_H
