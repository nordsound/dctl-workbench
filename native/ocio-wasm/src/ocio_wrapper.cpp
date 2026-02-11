/**
 * OpenColorIO WASM Wrapper
 *
 * Provides JavaScript bindings for OCIO color space transformations.
 * Uses built-in ACES v2.0 configs for professional color management.
 */

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <OpenColorIO/OpenColorIO.h>
#include <vector>
#include <string>
#include <memory>

namespace OCIO = OCIO_NAMESPACE;
using namespace emscripten;

/**
 * OCIOProcessor: Main class for color space transformations
 */
class OCIOProcessor {
public:
    OCIOProcessor() : config_(nullptr), cpuProc_(nullptr), gpuProc_(nullptr) {}

    /**
     * Initialize with built-in ACES studio config
     * Default: studio-config-v4.0.0_aces-v2.0_ocio-v2.5
     */
    bool initBuiltinConfig(const std::string& configName) {
        try {
            if (configName.empty()) {
                config_ = OCIO::Config::CreateFromBuiltinConfig(
                    "studio-config-v4.0.0_aces-v2.0_ocio-v2.5"
                );
            } else {
                config_ = OCIO::Config::CreateFromBuiltinConfig(configName.c_str());
            }
            return config_ != nullptr;
        } catch (const OCIO::Exception& e) {
            lastError_ = e.what();
            return false;
        }
    }

    /**
     * Get list of available color spaces
     */
    val getColorSpaces() const {
        val result = val::array();
        if (!config_) return result;

        try {
            for (int i = 0; i < config_->getNumColorSpaces(); ++i) {
                const char* name = config_->getColorSpaceNameByIndex(i);
                if (name) {
                    result.call<void>("push", std::string(name));
                }
            }
        } catch (const OCIO::Exception&) {
            // Return empty array on error
        }
        return result;
    }

    /**
     * Get list of available displays
     */
    val getDisplays() const {
        val result = val::array();
        if (!config_) return result;

        try {
            for (int i = 0; i < config_->getNumDisplays(); ++i) {
                const char* name = config_->getDisplay(i);
                if (name) {
                    result.call<void>("push", std::string(name));
                }
            }
        } catch (const OCIO::Exception&) {
            // Return empty array on error
        }
        return result;
    }

    /**
     * Get views for a specific display
     */
    val getViews(const std::string& display) const {
        val result = val::array();
        if (!config_) return result;

        try {
            for (int i = 0; i < config_->getNumViews(display.c_str()); ++i) {
                const char* name = config_->getView(display.c_str(), i);
                if (name) {
                    result.call<void>("push", std::string(name));
                }
            }
        } catch (const OCIO::Exception&) {
            // Return empty array on error
        }
        return result;
    }

    /**
     * Create a color space to color space transform
     */
    bool createTransform(const std::string& src, const std::string& dst) {
        if (!config_) {
            lastError_ = "Config not initialized";
            return false;
        }

        try {
            auto transform = OCIO::ColorSpaceTransform::Create();
            transform->setSrc(src.c_str());
            transform->setDst(dst.c_str());

            auto processor = config_->getProcessor(transform);
            cpuProc_ = processor->getDefaultCPUProcessor();

            // Store for GPU processor
            currentTransformType_ = TransformType::ColorSpace;
            currentSrc_ = src;
            currentDst_ = dst;

            return true;
        } catch (const OCIO::Exception& e) {
            lastError_ = e.what();
            return false;
        }
    }

    /**
     * Create a display view transform
     */
    bool createDisplayTransform(const std::string& src,
                                const std::string& display,
                                const std::string& view) {
        if (!config_) {
            lastError_ = "Config not initialized";
            return false;
        }

        try {
            auto transform = OCIO::DisplayViewTransform::Create();
            transform->setSrc(src.c_str());
            transform->setDisplay(display.c_str());
            transform->setView(view.c_str());

            auto processor = config_->getProcessor(transform);
            cpuProc_ = processor->getDefaultCPUProcessor();

            // Store for GPU processor
            currentTransformType_ = TransformType::DisplayView;
            currentSrc_ = src;
            currentDisplay_ = display;
            currentView_ = view;

            return true;
        } catch (const OCIO::Exception& e) {
            lastError_ = e.what();
            return false;
        }
    }

    /**
     * Apply transform to RGB data via pointer
     */
    bool applyRGBPtr(uintptr_t ptr, size_t numPixels) {
        if (!cpuProc_) {
            lastError_ = "No transform configured";
            return false;
        }

        try {
            float* data = reinterpret_cast<float*>(ptr);
            const long xStride = sizeof(float) * 3;
            const long yStride = numPixels * xStride;

            OCIO::PackedImageDesc img(
                data, numPixels, 1, 3,
                OCIO::BIT_DEPTH_F32,
                sizeof(float), xStride, yStride
            );

            cpuProc_->apply(img);
            return true;
        } catch (const OCIO::Exception& e) {
            lastError_ = e.what();
            return false;
        }
    }

    /**
     * Apply transform to RGBA data via pointer
     */
    bool applyRGBAPtr(uintptr_t ptr, size_t numPixels) {
        if (!cpuProc_) {
            lastError_ = "No transform configured";
            return false;
        }

        try {
            float* data = reinterpret_cast<float*>(ptr);
            const long xStride = sizeof(float) * 4;
            const long yStride = numPixels * xStride;

            OCIO::PackedImageDesc img(
                data, numPixels, 1, 4,
                OCIO::BIT_DEPTH_F32,
                sizeof(float), xStride, yStride
            );

            cpuProc_->apply(img);
            return true;
        } catch (const OCIO::Exception& e) {
            lastError_ = e.what();
            return false;
        }
    }

    // Preset transforms
    bool setupSrgbToAces() {
        return createTransform("Linear Rec.709 (sRGB)", "ACES2065-1");
    }

    bool setupAcesToSrgbDisplay() {
        return createDisplayTransform("ACES2065-1", "sRGB - Display",
                                       "ACES 2.0 - SDR 100 nits (Rec.709)");
    }

    bool setupAcesToSrgbLinear() {
        return createDisplayTransform("ACES2065-1", "sRGB - Display", "Un-tone-mapped");
    }

    bool setupAcesToRec709Display() {
        return createDisplayTransform("ACES2065-1", "Rec.1886 Rec.709 - Display",
                                       "ACES 2.0 - SDR 100 nits (Rec.709)");
    }

    /**
     * Create an inverse display view transform (display → ACES)
     */
    bool createInverseDisplayTransform(const std::string& src,
                                       const std::string& display,
                                       const std::string& view) {
        if (!config_) {
            lastError_ = "Config not initialized";
            return false;
        }

        try {
            auto transform = OCIO::DisplayViewTransform::Create();
            transform->setSrc(src.c_str());
            transform->setDisplay(display.c_str());
            transform->setView(view.c_str());

            auto processor = config_->getProcessor(transform, OCIO::TRANSFORM_DIR_INVERSE);
            cpuProc_ = processor->getDefaultCPUProcessor();

            // Store for GPU processor
            currentTransformType_ = TransformType::InverseDisplayView;
            currentSrc_ = src;
            currentDisplay_ = display;
            currentView_ = view;

            return true;
        } catch (const OCIO::Exception& e) {
            lastError_ = e.what();
            return false;
        }
    }

    /**
     * Setup sRGB display to ACES inverse transform
     * Converts sRGB display output back to ACES2065-1
     */
    bool setupSrgbDisplayToAces() {
        return createInverseDisplayTransform("ACES2065-1", "sRGB - Display",
                                              "ACES 2.0 - SDR 100 nits (Rec.709)");
    }

    /**
     * Setup Rec.709 display to ACES inverse transform
     * Converts Rec.709 display output back to ACES2065-1
     */
    bool setupRec709DisplayToAces() {
        return createInverseDisplayTransform("ACES2065-1", "Rec.1886 Rec.709 - Display",
                                              "ACES 2.0 - SDR 100 nits (Rec.709)");
    }

    /**
     * Setup P3 D65 display to ACES inverse transform
     * Converts P3 D65 display output back to ACES2065-1
     */
    bool setupP3DisplayToAces() {
        return createInverseDisplayTransform("ACES2065-1", "Display P3 - Display",
                                              "ACES 2.0 - SDR 100 nits (P3 D65)");
    }

    /**
     * Setup Rec.2100 PQ HDR to ACES inverse transform
     * @param peakLuminance Peak luminance (500, 1000, 2000, or 4000 nits)
     * @param limitingPrimaries Limiting primaries: 0 = P3 D65, 1 = Rec.2020
     */
    bool setupRec2100PQToAces(int peakLuminance, int limitingPrimaries) {
        std::string viewName;
        if (limitingPrimaries == 0) {
            switch (peakLuminance) {
                case 500:  viewName = "ACES 2.0 - HDR 500 nits (P3 D65)"; break;
                case 1000: viewName = "ACES 2.0 - HDR 1000 nits (P3 D65)"; break;
                case 2000: viewName = "ACES 2.0 - HDR 2000 nits (P3 D65)"; break;
                case 4000: viewName = "ACES 2.0 - HDR 4000 nits (P3 D65)"; break;
                default:
                    lastError_ = "Invalid peak luminance for P3. Use 500, 1000, 2000, or 4000.";
                    return false;
            }
        } else {
            switch (peakLuminance) {
                case 500:  viewName = "ACES 2.0 - HDR 500 nits (Rec.2020)"; break;
                case 1000: viewName = "ACES 2.0 - HDR 1000 nits (Rec.2020)"; break;
                case 2000: viewName = "ACES 2.0 - HDR 2000 nits (Rec.2020)"; break;
                case 4000: viewName = "ACES 2.0 - HDR 4000 nits (Rec.2020)"; break;
                default:
                    lastError_ = "Invalid peak luminance for Rec.2020. Use 500, 1000, 2000, or 4000.";
                    return false;
            }
        }
        return createInverseDisplayTransform("ACES2065-1", "Rec.2100-PQ - Display", viewName);
    }

    /**
     * Setup Rec.2100 HLG to ACES inverse transform
     */
    bool setupRec2100HLGToAces() {
        return createInverseDisplayTransform("ACES2065-1", "Rec.2100-HLG - Display",
                                              "ACES 2.0 - HDR 1000 nits (P3 D65)");
    }

    /**
     * Setup ACES to P3 D65 display transform (SDR 100 nits)
     */
    bool setupAcesToP3Display() {
        return createDisplayTransform("ACES2065-1", "Display P3 - Display",
                                       "ACES 2.0 - SDR 100 nits (P3 D65)");
    }

    /**
     * Setup ACES to Rec.2100 PQ HDR display transform
     * @param peakLuminance Peak luminance (500, 1000, 2000, or 4000 nits)
     * @param limitingPrimaries Limiting primaries: 0 = P3 D65, 1 = Rec.2020
     */
    bool setupAcesToRec2100PQ(int peakLuminance, int limitingPrimaries) {
        std::string viewName;
        if (limitingPrimaries == 0) {
            // P3 D65 limiting primaries
            switch (peakLuminance) {
                case 500:  viewName = "ACES 2.0 - HDR 500 nits (P3 D65)"; break;
                case 1000: viewName = "ACES 2.0 - HDR 1000 nits (P3 D65)"; break;
                case 2000: viewName = "ACES 2.0 - HDR 2000 nits (P3 D65)"; break;
                case 4000: viewName = "ACES 2.0 - HDR 4000 nits (P3 D65)"; break;
                default:
                    lastError_ = "Invalid peak luminance for P3. Use 500, 1000, 2000, or 4000.";
                    return false;
            }
        } else {
            // Rec.2020 limiting primaries
            switch (peakLuminance) {
                case 500:  viewName = "ACES 2.0 - HDR 500 nits (Rec.2020)"; break;
                case 1000: viewName = "ACES 2.0 - HDR 1000 nits (Rec.2020)"; break;
                case 2000: viewName = "ACES 2.0 - HDR 2000 nits (Rec.2020)"; break;
                case 4000: viewName = "ACES 2.0 - HDR 4000 nits (Rec.2020)"; break;
                default:
                    lastError_ = "Invalid peak luminance for Rec.2020. Use 500, 1000, 2000, or 4000.";
                    return false;
            }
        }
        return createDisplayTransform("ACES2065-1", "Rec.2100-PQ - Display", viewName);
    }

    /**
     * Setup ACES to Rec.2100 HLG HDR display transform (1000 nits, P3 D65 limiting)
     */
    bool setupAcesToRec2100HLG() {
        return createDisplayTransform("ACES2065-1", "Rec.2100-HLG - Display",
                                       "ACES 2.0 - HDR 1000 nits (P3 D65)");
    }

    /**
     * Setup ACES to ST2084 P3 D65 display transform
     * @param peakLuminance Peak luminance (108, 500, 1000, 2000, or 4000 nits)
     */
    bool setupAcesToST2084P3(int peakLuminance) {
        std::string viewName;
        switch (peakLuminance) {
            case 108:  viewName = "ACES 2.0 - HDR 108 nits (P3 D65)"; break;
            case 500:  viewName = "ACES 2.0 - HDR 500 nits (P3 D65)"; break;
            case 1000: viewName = "ACES 2.0 - HDR 1000 nits (P3 D65)"; break;
            case 2000: viewName = "ACES 2.0 - HDR 2000 nits (P3 D65)"; break;
            case 4000: viewName = "ACES 2.0 - HDR 4000 nits (P3 D65)"; break;
            default:
                lastError_ = "Invalid peak luminance. Use 108, 500, 1000, 2000, or 4000.";
                return false;
        }
        return createDisplayTransform("ACES2065-1", "ST2084-P3-D65 - Display", viewName);
    }

    /**
     * Setup ACES 2.0 Reference Gamut Compression (RGC) transform
     * This compresses out-of-gamut colors into the target gamut.
     *
     * The full RGC pipeline is:
     * 1. RGB (AP1) → JMh conversion
     * 2. Gamut compression in JMh space
     * 3. JMh → RGB (AP1) conversion
     *
     * @param peakLuminance Peak luminance in nits (e.g., 100 for SDR, 1000 for HDR)
     * @param inverse If true, apply inverse (decompress) instead of forward (compress)
     * @return true if setup succeeded
     */
    bool setupACES2GamutCompress(double peakLuminance, bool inverse) {
        try {
            // AP1 (ACEScg) chromaticities for RGB↔JMh conversion
            const double ap1Params[8] = {
                0.713, 0.293,   // Red xy
                0.165, 0.830,   // Green xy
                0.128, 0.044,   // Blue xy
                0.32168, 0.33767  // White xy (D60)
            };

            // Gamut compress params: peakLuminance + limiting primaries (AP1)
            const double compressParams[9] = {
                peakLuminance,
                0.713, 0.293,   // Red xy
                0.165, 0.830,   // Green xy
                0.128, 0.044,   // Blue xy
                0.32168, 0.33767  // White xy (D60)
            };

            // Create a group transform to chain the operations
            auto groupTransform = OCIO::GroupTransform::Create();

            if (!inverse) {
                // Forward: RGB → JMh → Compress → JMh → RGB
                // 1. RGB to JMh
                auto rgbToJmh = OCIO::FixedFunctionTransform::Create(
                    OCIO::FIXED_FUNCTION_ACES_RGB_TO_JMH_20,
                    ap1Params, 8
                );
                rgbToJmh->setDirection(OCIO::TRANSFORM_DIR_FORWARD);
                groupTransform->appendTransform(rgbToJmh);

                // 2. Gamut compress in JMh space
                auto gamutCompress = OCIO::FixedFunctionTransform::Create(
                    OCIO::FIXED_FUNCTION_ACES_GAMUT_COMPRESS_20,
                    compressParams, 9
                );
                gamutCompress->setDirection(OCIO::TRANSFORM_DIR_FORWARD);
                groupTransform->appendTransform(gamutCompress);

                // 3. JMh to RGB
                auto jmhToRgb = OCIO::FixedFunctionTransform::Create(
                    OCIO::FIXED_FUNCTION_ACES_RGB_TO_JMH_20,
                    ap1Params, 8
                );
                jmhToRgb->setDirection(OCIO::TRANSFORM_DIR_INVERSE);
                groupTransform->appendTransform(jmhToRgb);
            } else {
                // Inverse: RGB → JMh → Decompress → JMh → RGB
                // 1. RGB to JMh
                auto rgbToJmh = OCIO::FixedFunctionTransform::Create(
                    OCIO::FIXED_FUNCTION_ACES_RGB_TO_JMH_20,
                    ap1Params, 8
                );
                rgbToJmh->setDirection(OCIO::TRANSFORM_DIR_FORWARD);
                groupTransform->appendTransform(rgbToJmh);

                // 2. Gamut decompress in JMh space
                auto gamutCompress = OCIO::FixedFunctionTransform::Create(
                    OCIO::FIXED_FUNCTION_ACES_GAMUT_COMPRESS_20,
                    compressParams, 9
                );
                gamutCompress->setDirection(OCIO::TRANSFORM_DIR_INVERSE);
                groupTransform->appendTransform(gamutCompress);

                // 3. JMh to RGB
                auto jmhToRgb = OCIO::FixedFunctionTransform::Create(
                    OCIO::FIXED_FUNCTION_ACES_RGB_TO_JMH_20,
                    ap1Params, 8
                );
                jmhToRgb->setDirection(OCIO::TRANSFORM_DIR_INVERSE);
                groupTransform->appendTransform(jmhToRgb);
            }

            // Need a config for the processor - use default ACES config
            if (!config_) {
                config_ = OCIO::Config::CreateFromBuiltinConfig(
                    "studio-config-v4.0.0_aces-v2.0_ocio-v2.5"
                );
            }

            auto processor = config_->getProcessor(groupTransform);
            cpuProc_ = processor->getDefaultCPUProcessor();

            // Store for GPU processor
            currentTransformType_ = TransformType::FixedFunction;
            rgcPeakLuminance_ = peakLuminance;
            rgcInverse_ = inverse;

            return true;
        } catch (const OCIO::Exception& e) {
            lastError_ = e.what();
            return false;
        }
    }

    /**
     * Apply ACES 2.0 RGC to RGB data (AP1 linear input/output)
     * This is a convenience wrapper that sets up RGC and applies it in one call.
     *
     * @param ptr Pointer to float RGB data (AP1 linear)
     * @param numPixels Number of pixels
     * @param peakLuminance Peak luminance in nits
     * @param inverse If true, decompress instead of compress
     * @return true if succeeded
     */
    bool applyACES2GamutCompressRGB(uintptr_t ptr, size_t numPixels,
                                     double peakLuminance, bool inverse) {
        if (!setupACES2GamutCompress(peakLuminance, inverse)) {
            return false;
        }
        return applyRGBPtr(ptr, numPixels);
    }

    std::string getLastError() const { return lastError_; }
    bool hasTransform() const { return cpuProc_ != nullptr; }

    std::string getConfigDescription() const {
        if (!config_) return "";
        const char* desc = config_->getDescription();
        return desc ? std::string(desc) : "";
    }

    /**
     * Setup GPU processor for shader extraction
     */
    bool setupGpuProcessor() {
        if (!config_) {
            lastError_ = "Config not initialized";
            return false;
        }

        try {
            OCIO::ConstProcessorRcPtr processor;
            if (currentTransformType_ == TransformType::ColorSpace) {
                auto transform = OCIO::ColorSpaceTransform::Create();
                transform->setSrc(currentSrc_.c_str());
                transform->setDst(currentDst_.c_str());
                processor = config_->getProcessor(transform);
            } else if (currentTransformType_ == TransformType::DisplayView) {
                auto transform = OCIO::DisplayViewTransform::Create();
                transform->setSrc(currentSrc_.c_str());
                transform->setDisplay(currentDisplay_.c_str());
                transform->setView(currentView_.c_str());
                processor = config_->getProcessor(transform);
            } else if (currentTransformType_ == TransformType::InverseDisplayView) {
                auto transform = OCIO::DisplayViewTransform::Create();
                transform->setSrc(currentSrc_.c_str());
                transform->setDisplay(currentDisplay_.c_str());
                transform->setView(currentView_.c_str());
                processor = config_->getProcessor(transform, OCIO::TRANSFORM_DIR_INVERSE);
            } else if (currentTransformType_ == TransformType::FixedFunction) {
                // Recreate the RGC transform group for GPU
                const double ap1Params[8] = {
                    0.713, 0.293,   // Red xy
                    0.165, 0.830,   // Green xy
                    0.128, 0.044,   // Blue xy
                    0.32168, 0.33767  // White xy (D60)
                };
                const double compressParams[9] = {
                    rgcPeakLuminance_,
                    0.713, 0.293,   // Red xy
                    0.165, 0.830,   // Green xy
                    0.128, 0.044,   // Blue xy
                    0.32168, 0.33767  // White xy (D60)
                };

                auto groupTransform = OCIO::GroupTransform::Create();

                // RGB to JMh
                auto rgbToJmh = OCIO::FixedFunctionTransform::Create(
                    OCIO::FIXED_FUNCTION_ACES_RGB_TO_JMH_20,
                    ap1Params, 8
                );
                rgbToJmh->setDirection(OCIO::TRANSFORM_DIR_FORWARD);
                groupTransform->appendTransform(rgbToJmh);

                // Gamut compress in JMh space
                auto gamutCompress = OCIO::FixedFunctionTransform::Create(
                    OCIO::FIXED_FUNCTION_ACES_GAMUT_COMPRESS_20,
                    compressParams, 9
                );
                gamutCompress->setDirection(rgcInverse_ ?
                    OCIO::TRANSFORM_DIR_INVERSE : OCIO::TRANSFORM_DIR_FORWARD);
                groupTransform->appendTransform(gamutCompress);

                // JMh to RGB
                auto jmhToRgb = OCIO::FixedFunctionTransform::Create(
                    OCIO::FIXED_FUNCTION_ACES_RGB_TO_JMH_20,
                    ap1Params, 8
                );
                jmhToRgb->setDirection(OCIO::TRANSFORM_DIR_INVERSE);
                groupTransform->appendTransform(jmhToRgb);

                processor = config_->getProcessor(groupTransform);
            } else {
                lastError_ = "No transform configured";
                return false;
            }
            gpuProc_ = processor->getDefaultGPUProcessor();
            return gpuProc_ != nullptr;
        } catch (const OCIO::Exception& e) {
            lastError_ = e.what();
            return false;
        }
    }

    /**
     * Extract GPU shader info for WebGL rendering
     */
    val extractGpuShaderInfo() {
        val result = val::object();

        if (!gpuProc_) {
            lastError_ = "No GPU processor configured";
            return result;
        }

        try {
            auto shaderDesc = OCIO::GpuShaderDesc::CreateShaderDesc();
            shaderDesc->setLanguage(OCIO::GPU_LANGUAGE_GLSL_ES_3_0);
            shaderDesc->setFunctionName("OCIODisplay");
            shaderDesc->setResourcePrefix("ocio_");

            gpuProc_->extractGpuShaderInfo(shaderDesc);

            // Shader text
            const char* shaderText = shaderDesc->getShaderText();
            result.set("shaderText", std::string(shaderText ? shaderText : ""));

            // 1D/2D textures
            val textures = val::array();
            unsigned numTextures = shaderDesc->getNumTextures();
            for (unsigned i = 0; i < numTextures; ++i) {
                const char* textureName = nullptr;
                const char* samplerName = nullptr;
                unsigned width = 0, height = 0;
                OCIO::GpuShaderCreator::TextureType channel;
                OCIO::GpuShaderDesc::TextureDimensions dims;
                OCIO::Interpolation interp;

                shaderDesc->getTexture(i, textureName, samplerName, width, height,
                                        channel, dims, interp);

                const float* values = nullptr;
                shaderDesc->getTextureValues(i, values);

                val tex = val::object();
                tex.set("name", std::string(textureName ? textureName : ""));
                tex.set("samplerName", std::string(samplerName ? samplerName : ""));
                tex.set("width", width);
                tex.set("height", height);
                tex.set("channel", static_cast<int>(channel));
                tex.set("dimensions", static_cast<int>(dims));

                size_t numChannels = (channel == OCIO::GpuShaderCreator::TEXTURE_RED_CHANNEL) ? 1 : 3;
                size_t dataSize = width * height * numChannels;
                val data = val::array();
                if (values) {
                    for (size_t j = 0; j < dataSize; ++j) {
                        data.call<void>("push", values[j]);
                    }
                }
                tex.set("data", data);
                textures.call<void>("push", tex);
            }
            result.set("textures", textures);

            // 3D textures
            val textures3D = val::array();
            unsigned num3DTextures = shaderDesc->getNum3DTextures();
            for (unsigned i = 0; i < num3DTextures; ++i) {
                const char* textureName = nullptr;
                const char* samplerName = nullptr;
                unsigned edgelen = 0;
                OCIO::Interpolation interp;

                shaderDesc->get3DTexture(i, textureName, samplerName, edgelen, interp);

                const float* values = nullptr;
                shaderDesc->get3DTextureValues(i, values);

                val tex = val::object();
                tex.set("name", std::string(textureName ? textureName : ""));
                tex.set("samplerName", std::string(samplerName ? samplerName : ""));
                tex.set("edgeLen", edgelen);

                size_t dataSize = edgelen * edgelen * edgelen * 3;
                val data = val::array();
                if (values) {
                    for (size_t j = 0; j < dataSize; ++j) {
                        data.call<void>("push", values[j]);
                    }
                }
                tex.set("data", data);
                textures3D.call<void>("push", tex);
            }
            result.set("textures3D", textures3D);

            // Uniforms
            val uniforms = val::array();
            unsigned numUniforms = shaderDesc->getNumUniforms();
            for (unsigned i = 0; i < numUniforms; ++i) {
                OCIO::GpuShaderDesc::UniformData udata;
                const char* name = shaderDesc->getUniform(i, udata);

                val uniform = val::object();
                uniform.set("name", std::string(name ? name : ""));
                uniform.set("type", static_cast<int>(udata.m_type));
                uniforms.call<void>("push", uniform);
            }
            result.set("uniforms", uniforms);

            return result;
        } catch (const OCIO::Exception& e) {
            lastError_ = e.what();
            return result;
        }
    }

private:
    enum class TransformType { None, ColorSpace, DisplayView, InverseDisplayView, FixedFunction };

    OCIO::ConstConfigRcPtr config_;
    OCIO::ConstCPUProcessorRcPtr cpuProc_;
    OCIO::ConstGPUProcessorRcPtr gpuProc_;
    std::string lastError_;

    TransformType currentTransformType_ = TransformType::None;
    std::string currentSrc_;
    std::string currentDst_;
    std::string currentDisplay_;
    std::string currentView_;

    // RGC parameters
    double rgcPeakLuminance_ = 100.0;
    bool rgcInverse_ = false;
};

/**
 * Get list of available built-in configs
 */
val getBuiltinConfigs() {
    val result = val::array();
    try {
        const auto& registry = OCIO::BuiltinConfigRegistry::Get();
        for (size_t i = 0; i < registry.getNumBuiltinConfigs(); ++i) {
            val item = val::object();
            item.set("name", std::string(registry.getBuiltinConfigName(i)));
            item.set("uiName", std::string(registry.getBuiltinConfigUIName(i)));
            item.set("isRecommended", registry.isBuiltinConfigRecommended(i));
            result.call<void>("push", item);
        }
    } catch (const OCIO::Exception&) {
        // Return empty array on error
    }
    return result;
}

/**
 * Get OCIO version string
 */
std::string getOCIOVersion() {
    return OCIO::GetVersion();
}

// Embind bindings
EMSCRIPTEN_BINDINGS(ocio_module) {
    class_<OCIOProcessor>("OCIOProcessor")
        .constructor<>()
        .function("initBuiltinConfig", &OCIOProcessor::initBuiltinConfig)
        .function("getColorSpaces", &OCIOProcessor::getColorSpaces)
        .function("getDisplays", &OCIOProcessor::getDisplays)
        .function("getViews", &OCIOProcessor::getViews)
        .function("createTransform", &OCIOProcessor::createTransform)
        .function("createDisplayTransform", &OCIOProcessor::createDisplayTransform)
        .function("applyRGBPtr", &OCIOProcessor::applyRGBPtr)
        .function("applyRGBAPtr", &OCIOProcessor::applyRGBAPtr)
        .function("setupSrgbToAces", &OCIOProcessor::setupSrgbToAces)
        .function("setupAcesToSrgbDisplay", &OCIOProcessor::setupAcesToSrgbDisplay)
        .function("setupAcesToSrgbLinear", &OCIOProcessor::setupAcesToSrgbLinear)
        .function("setupAcesToRec709Display", &OCIOProcessor::setupAcesToRec709Display)
        .function("setupAcesToP3Display", &OCIOProcessor::setupAcesToP3Display)
        .function("setupAcesToRec2100PQ", &OCIOProcessor::setupAcesToRec2100PQ)
        .function("setupAcesToRec2100HLG", &OCIOProcessor::setupAcesToRec2100HLG)
        .function("setupAcesToST2084P3", &OCIOProcessor::setupAcesToST2084P3)
        .function("createInverseDisplayTransform", &OCIOProcessor::createInverseDisplayTransform)
        .function("setupSrgbDisplayToAces", &OCIOProcessor::setupSrgbDisplayToAces)
        .function("setupRec709DisplayToAces", &OCIOProcessor::setupRec709DisplayToAces)
        .function("setupP3DisplayToAces", &OCIOProcessor::setupP3DisplayToAces)
        .function("setupRec2100PQToAces", &OCIOProcessor::setupRec2100PQToAces)
        .function("setupRec2100HLGToAces", &OCIOProcessor::setupRec2100HLGToAces)
        .function("setupACES2GamutCompress", &OCIOProcessor::setupACES2GamutCompress)
        .function("applyACES2GamutCompressRGB", &OCIOProcessor::applyACES2GamutCompressRGB)
        .function("getLastError", &OCIOProcessor::getLastError)
        .function("hasTransform", &OCIOProcessor::hasTransform)
        .function("getConfigDescription", &OCIOProcessor::getConfigDescription)
        .function("setupGpuProcessor", &OCIOProcessor::setupGpuProcessor)
        .function("extractGpuShaderInfo", &OCIOProcessor::extractGpuShaderInfo);

    function("getBuiltinConfigs", &getBuiltinConfigs);
    function("getOCIOVersion", &getOCIOVersion);
}
