//! WASM bindings for naga shader translator
//!
//! Provides GLSL to WGSL conversion for WebGPU rendering pipeline.

use naga::{back::wgsl, front::glsl, valid};
use wasm_bindgen::prelude::*;

/// Initialize panic hook for better error messages in browser console
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Result of shader conversion
#[wasm_bindgen]
pub struct ConversionResult {
    success: bool,
    wgsl: String,
    error: String,
}

#[wasm_bindgen]
impl ConversionResult {
    #[wasm_bindgen(getter)]
    pub fn success(&self) -> bool {
        self.success
    }

    #[wasm_bindgen(getter)]
    pub fn wgsl(&self) -> String {
        self.wgsl.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn error(&self) -> String {
        self.error.clone()
    }
}

/// Convert GLSL shader to WGSL
///
/// # Arguments
/// * `glsl_source` - GLSL source code
/// * `stage` - Shader stage: "vertex", "fragment", or "compute"
/// * `entry_point` - Entry point function name (e.g., "main", "OCIODisplay")
///
/// # Returns
/// ConversionResult with success status, WGSL code, and error message
#[wasm_bindgen]
pub fn glsl_to_wgsl(glsl_source: &str, stage: &str, entry_point: &str) -> ConversionResult {
    match convert_glsl_to_wgsl(glsl_source, stage, entry_point) {
        Ok(wgsl) => ConversionResult {
            success: true,
            wgsl,
            error: String::new(),
        },
        Err(e) => ConversionResult {
            success: false,
            wgsl: String::new(),
            error: e,
        },
    }
}

/// Convert GLSL fragment shader to WGSL (convenience function)
#[wasm_bindgen]
pub fn glsl_fragment_to_wgsl(glsl_source: &str) -> ConversionResult {
    glsl_to_wgsl(glsl_source, "fragment", "main")
}

/// Convert GLSL vertex shader to WGSL (convenience function)
#[wasm_bindgen]
pub fn glsl_vertex_to_wgsl(glsl_source: &str) -> ConversionResult {
    glsl_to_wgsl(glsl_source, "vertex", "main")
}

/// Convert GLSL compute shader to WGSL (convenience function)
#[wasm_bindgen]
pub fn glsl_compute_to_wgsl(glsl_source: &str) -> ConversionResult {
    glsl_to_wgsl(glsl_source, "compute", "main")
}

/// Internal conversion function
fn convert_glsl_to_wgsl(glsl_source: &str, stage: &str, _entry_point: &str) -> Result<String, String> {
    // Parse shader stage
    let shader_stage = match stage {
        "vertex" => naga::ShaderStage::Vertex,
        "fragment" => naga::ShaderStage::Fragment,
        "compute" => naga::ShaderStage::Compute,
        _ => return Err(format!("Invalid shader stage: '{}'. Use 'vertex', 'fragment', or 'compute'", stage)),
    };

    // Configure GLSL parser options
    let mut options = glsl::Options::from(shader_stage);
    options.defines.insert(String::from("GL_ES"), String::from("1"));

    // Parse GLSL
    let module = glsl::Frontend::default()
        .parse(&options, glsl_source)
        .map_err(|errors| {
            let error_msgs: Vec<String> = errors.errors.iter().map(|e| format!("{:?}", e)).collect();
            format!("GLSL parse error:\n{}", error_msgs.join("\n"))
        })?;

    // Validate the module
    let info = valid::Validator::new(
        valid::ValidationFlags::all(),
        valid::Capabilities::all(),
    )
    .validate(&module)
    .map_err(|e| format!("Validation error: {:?}", e))?;

    // Generate WGSL
    let wgsl = wgsl::write_string(&module, &info, wgsl::WriterFlags::empty())
        .map_err(|e| format!("WGSL generation error: {:?}", e))?;

    Ok(wgsl)
}

/// Get naga version
#[wasm_bindgen]
pub fn get_naga_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Validate GLSL shader without converting
#[wasm_bindgen]
pub fn validate_glsl(glsl_source: &str, stage: &str) -> ConversionResult {
    let shader_stage = match stage {
        "vertex" => naga::ShaderStage::Vertex,
        "fragment" => naga::ShaderStage::Fragment,
        "compute" => naga::ShaderStage::Compute,
        _ => {
            return ConversionResult {
                success: false,
                wgsl: String::new(),
                error: format!("Invalid shader stage: '{}'", stage),
            }
        }
    };

    let options = glsl::Options::from(shader_stage);

    match glsl::Frontend::default().parse(&options, glsl_source) {
        Ok(module) => {
            match valid::Validator::new(valid::ValidationFlags::all(), valid::Capabilities::all())
                .validate(&module)
            {
                Ok(_) => ConversionResult {
                    success: true,
                    wgsl: String::new(),
                    error: String::new(),
                },
                Err(e) => ConversionResult {
                    success: false,
                    wgsl: String::new(),
                    error: format!("Validation error: {:?}", e),
                },
            }
        }
        Err(errors) => {
            let error_msgs: Vec<String> = errors.errors.iter().map(|e| format!("{:?}", e)).collect();
            ConversionResult {
                success: false,
                wgsl: String::new(),
                error: format!("Parse error:\n{}", error_msgs.join("\n")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test simple fragment shader conversion
    /// Note: Combined image-sampler (sampler2D) is not supported by naga GLSL frontend
    /// In production, we use separate texture/sampler bindings
    #[test]
    fn test_simple_fragment_shader() {
        // Use a simpler shader without combined image-sampler
        let glsl = r#"
            #version 450
            layout(location = 0) in vec2 v_texCoord;
            layout(location = 0) out vec4 fragColor;

            void main() {
                fragColor = vec4(v_texCoord, 0.0, 1.0);
            }
        "#;

        let result = glsl_fragment_to_wgsl(glsl);
        assert!(result.success, "Conversion failed: {}", result.error);
        assert!(result.wgsl.contains("fn main"));
    }

    #[test]
    fn test_simple_vertex_shader() {
        let glsl = r#"
            #version 450
            layout(location = 0) in vec2 a_position;
            layout(location = 1) in vec2 a_texCoord;
            layout(location = 0) out vec2 v_texCoord;

            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
                v_texCoord = a_texCoord;
            }
        "#;

        let result = glsl_vertex_to_wgsl(glsl);
        assert!(result.success, "Conversion failed: {}", result.error);
        assert!(result.wgsl.contains("fn main"));
    }

    #[test]
    fn test_invalid_glsl() {
        let glsl = "invalid shader code";
        let result = glsl_fragment_to_wgsl(glsl);
        assert!(!result.success);
        assert!(!result.error.is_empty());
    }
}
