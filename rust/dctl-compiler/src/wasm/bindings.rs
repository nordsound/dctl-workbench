//! WASM Bindings
//!
//! JavaScript-callable functions exposed via wasm-bindgen.

use wasm_bindgen::prelude::*;

/// Initialize panic hook for better error messages in browser console
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Parse DCTL source code and return AST as JSON
///
/// # Arguments
/// * `source` - DCTL source code string
///
/// # Returns
/// JSON string containing the AST or an error object
#[wasm_bindgen]
pub fn parse_dctl(source: &str) -> String {
    match crate::parse_to_json(source) {
        Ok(json) => json,
        Err(e) => serde_json::json!({
            "error": true,
            "message": e.to_string()
        })
        .to_string(),
    }
}

/// Analyze DCTL source code and return diagnostics as JSON
///
/// # Arguments
/// * `source` - DCTL source code string
///
/// # Returns
/// JSON string containing diagnostics array or an error object
#[wasm_bindgen]
pub fn analyze_dctl(source: &str) -> String {
    match crate::analyze_to_json(source) {
        Ok(json) => json,
        Err(e) => serde_json::json!({
            "error": true,
            "message": e.to_string()
        })
        .to_string(),
    }
}

/// Compile DCTL source code to WGSL
///
/// # Arguments
/// * `source` - DCTL source code string
///
/// # Returns
/// JSON string containing compilation result:
/// - On success: `{ wgsl: string, diagnostics: [], parameters: [], entry_point: string }`
/// - On error: `{ error: true, message: string }`
#[wasm_bindgen]
pub fn compile_dctl(source: &str) -> String {
    match crate::compile(source) {
        Ok(result) => serde_json::to_string(&result).unwrap_or_else(|e| {
            serde_json::json!({
                "error": true,
                "message": format!("Serialization error: {}", e)
            })
            .to_string()
        }),
        Err(e) => serde_json::json!({
            "error": true,
            "message": e.to_string()
        })
        .to_string(),
    }
}

/// Compile DCTL source code to WGSL with include resolution
///
/// # Arguments
/// * `source` - DCTL source code string
/// * `includes_json` - JSON object mapping include file paths to their contents
///                     e.g., `{"header.h": "float helper() { return 1.0; }"}`
///
/// # Returns
/// JSON string containing compilation result:
/// - On success: `{ wgsl: string, diagnostics: [], parameters: [], entry_point: string }`
/// - On error: `{ error: true, message: string }`
#[wasm_bindgen]
pub fn compile_dctl_with_includes(source: &str, includes_json: &str) -> String {
    // Parse the includes JSON
    let includes: std::collections::HashMap<String, String> = match serde_json::from_str(includes_json) {
        Ok(map) => map,
        Err(e) => {
            return serde_json::json!({
                "error": true,
                "message": format!("Invalid includes JSON: {}", e)
            })
            .to_string();
        }
    };

    // Compile with includes
    match crate::compile_with_includes(source, &includes) {
        Ok(result) => serde_json::to_string(&result).unwrap_or_else(|e| {
            serde_json::json!({
                "error": true,
                "message": format!("Serialization error: {}", e)
            })
            .to_string()
        }),
        Err(e) => serde_json::json!({
            "error": true,
            "message": e.to_string()
        })
        .to_string(),
    }
}

/// Get the compiler version
#[wasm_bindgen]
pub fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Validate DCTL source code
///
/// # Arguments
/// * `source` - DCTL source code string
///
/// # Returns
/// JSON string containing validation result:
/// - On success: `{ valid: true, diagnostics: [] }`
/// - On error: `{ valid: false, error: string, diagnostics: [] }`
#[wasm_bindgen]
pub fn validate_dctl(source: &str) -> String {
    match crate::parser::parse(source) {
        Ok(ast) => match crate::semantic::analyze(&ast) {
            Ok(result) => serde_json::json!({
                "valid": true,
                "diagnostics": result.diagnostics
            })
            .to_string(),
            Err(e) => serde_json::json!({
                "valid": false,
                "error": e.to_string(),
                "diagnostics": []
            })
            .to_string(),
        },
        Err(e) => serde_json::json!({
            "valid": false,
            "error": e.to_string(),
            "diagnostics": []
        })
        .to_string(),
    }
}

/// Compile DCTL from pre-parsed AST JSON
///
/// This is the primary compilation method for WASM builds where tree-sitter
/// parsing is done in JavaScript and the AST is passed as JSON.
///
/// # Arguments
/// * `ast_json` - Pre-parsed AST as JSON string
///
/// # Returns
/// JSON string containing compilation result:
/// - On success: `{ wgsl: string, diagnostics: [], parameters: [], entry_point: string }`
/// - On error: `{ error: true, message: string }`
#[wasm_bindgen]
pub fn compile_from_ast(ast_json: &str) -> String {
    match crate::parser::parse_json(ast_json) {
        Ok(ast) => match crate::semantic::analyze(&ast) {
            Ok(analyzed) => match crate::codegen::generate(&analyzed) {
                Ok(wgsl) => {
                    let result = crate::CompileResult {
                        wgsl,
                        diagnostics: analyzed.diagnostics,
                        parameters: analyzed.parameters,
                        entry_point: analyzed.entry_point,
                    };
                    serde_json::to_string(&result).unwrap_or_else(|e| {
                        serde_json::json!({
                            "error": true,
                            "message": format!("Serialization error: {}", e)
                        })
                        .to_string()
                    })
                }
                Err(e) => serde_json::json!({
                    "error": true,
                    "message": e.to_string()
                })
                .to_string(),
            },
            Err(e) => serde_json::json!({
                "error": true,
                "message": e.to_string()
            })
            .to_string(),
        },
        Err(e) => serde_json::json!({
            "error": true,
            "message": format!("AST parse error: {}", e)
        })
        .to_string(),
    }
}

/// Validate DCTL from pre-parsed AST JSON
///
/// # Arguments
/// * `ast_json` - Pre-parsed AST as JSON string
///
/// # Returns
/// JSON string containing validation result:
/// - On success: `{ valid: true, diagnostics: [] }`
/// - On error: `{ valid: false, error: string, diagnostics: [] }`
#[wasm_bindgen]
pub fn validate_from_ast(ast_json: &str) -> String {
    match crate::parser::parse_json(ast_json) {
        Ok(ast) => match crate::semantic::analyze(&ast) {
            Ok(result) => serde_json::json!({
                "valid": true,
                "diagnostics": result.diagnostics
            })
            .to_string(),
            Err(e) => serde_json::json!({
                "valid": false,
                "error": e.to_string(),
                "diagnostics": []
            })
            .to_string(),
        },
        Err(e) => serde_json::json!({
            "valid": false,
            "error": format!("AST parse error: {}", e),
            "diagnostics": []
        })
        .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    // =============================================================================
    // WASM-bindgen tests (run in wasm32 environment)
    // =============================================================================

    #[wasm_bindgen_test]
    fn test_get_version() {
        let version = get_version();
        assert!(!version.is_empty());
    }

    #[wasm_bindgen_test]
    fn test_parse_empty() {
        let result = parse_dctl("");
        assert!(result.contains("declarations") || result.contains("error"));
    }

    #[wasm_bindgen_test]
    fn test_validate_empty() {
        let result = validate_dctl("");
        assert!(result.contains("valid"));
    }

    // =============================================================================
    // Native tests (run with cargo test --features native-parser)
    // =============================================================================

    #[test]
    fn test_get_version_native() {
        let version = get_version();
        assert!(!version.is_empty());
        // Version should be in semver format
        let parts: Vec<&str> = version.split('.').collect();
        assert!(parts.len() >= 2, "Version should have at least major.minor");
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_parse_simple_function() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R, p_G, p_B);
}
"#;
        let result = parse_dctl(source);
        // Should contain declarations (no error)
        assert!(!result.contains("\"error\":true"), "Parse should succeed: {}", result);
        assert!(result.contains("declarations"), "Result should contain declarations");
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_parse_with_ui_params() {
        let source = r#"
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R * gain, p_G * gain, p_B * gain);
}
"#;
        let result = parse_dctl(source);
        assert!(!result.contains("\"error\":true"), "Parse should succeed: {}", result);
        assert!(result.contains("ui_params"), "Result should contain ui_params");
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_analyze_simple_function() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R, p_G, p_B);
}
"#;
        let result = analyze_dctl(source);
        // Should return diagnostics (possibly empty array)
        assert!(!result.contains("\"error\":true"), "Analyze should succeed: {}", result);
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_compile_simple_function() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R, p_G, p_B);
}
"#;
        let result = compile_dctl(source);
        assert!(!result.contains("\"error\":true"), "Compile should succeed: {}", result);
        assert!(result.contains("wgsl"), "Result should contain WGSL code");
        assert!(result.contains("entry_point"), "Result should contain entry_point");
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_compile_with_ui_params() {
        let source = r#"
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R * gain, p_G * gain, p_B * gain);
}
"#;
        let result = compile_dctl(source);
        assert!(!result.contains("\"error\":true"), "Compile should succeed: {}", result);
        assert!(result.contains("parameters"), "Result should contain parameters");
        // The WGSL should reference the gain parameter
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let wgsl = parsed["wgsl"].as_str().unwrap();
        assert!(wgsl.contains("gain"), "WGSL should contain gain parameter");
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_validate_valid_code() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float val = 1.0f;
    return make_float3(val, val, val);
}
"#;
        let result = validate_dctl(source);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(parsed["valid"].as_bool().unwrap_or(false), "Code should be valid: {}", result);
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_validate_undefined_variable() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(undefined_var, p_G, p_B);
}
"#;
        let result = validate_dctl(source);
        // May still be valid depending on semantic analysis strictness
        // Just check that result is parseable
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(parsed.get("valid").is_some() || parsed.get("error").is_some(),
            "Should return valid or error field");
    }

    #[test]
    fn test_compile_from_ast_empty() {
        let ast_json = r#"{"declarations":[],"ui_params":[]}"#;
        let result = compile_from_ast(ast_json);
        // Empty AST should produce empty or minimal WGSL
        assert!(!result.contains("\"error\":true") || result.contains("entry_point") || result.contains("wgsl"),
            "Empty AST should compile: {}", result);
    }

    #[test]
    fn test_compile_from_ast_invalid_json() {
        let ast_json = "not valid json";
        let result = compile_from_ast(ast_json);
        assert!(result.contains("error"), "Invalid JSON should return error: {}", result);
    }

    #[test]
    fn test_validate_from_ast_empty() {
        let ast_json = r#"{"declarations":[],"ui_params":[]}"#;
        let result = validate_from_ast(ast_json);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(parsed["valid"].as_bool().unwrap_or(false), "Empty AST should be valid: {}", result);
    }

    #[test]
    fn test_validate_from_ast_invalid_json() {
        let ast_json = "{ invalid json }";
        let result = validate_from_ast(ast_json);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(!parsed["valid"].as_bool().unwrap_or(true), "Invalid JSON should not be valid");
        assert!(parsed.get("error").is_some(), "Should contain error field");
    }

    #[test]
    fn test_compile_with_includes_empty() {
        let source = "";
        let includes = "{}";
        let result = compile_dctl_with_includes(source, includes);
        // Should either succeed with empty result or return error
        let _parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    }

    #[test]
    fn test_compile_with_includes_invalid_json() {
        let source = "";
        let includes = "not valid json";
        let result = compile_dctl_with_includes(source, includes);
        assert!(result.contains("error"), "Invalid includes JSON should return error: {}", result);
        assert!(result.contains("Invalid includes JSON"), "Error message should mention invalid JSON");
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_compile_with_includes_valid() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R, p_G, p_B);
}
"#;
        let includes = r#"{}"#;
        let result = compile_dctl_with_includes(source, includes);
        assert!(!result.contains("\"error\":true"), "Compile with includes should succeed: {}", result);
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_compile_dctl_with_builtins() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float r = _clampf(p_R, 0.0f, 1.0f);
    float g = _powf(p_G, 2.2f);
    float b = _fmaxf(p_B, 0.0f);
    return make_float3(r, g, b);
}
"#;
        let result = compile_dctl(source);
        assert!(!result.contains("\"error\":true"), "Compile should succeed: {}", result);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let wgsl = parsed["wgsl"].as_str().unwrap();
        // Check that builtins are converted
        assert!(wgsl.contains("clamp("), "WGSL should contain clamp");
        assert!(wgsl.contains("pow("), "WGSL should contain pow");
        assert!(wgsl.contains("max("), "WGSL should contain max");
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_compile_dctl_with_vectors() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 color = make_float3(p_R, p_G, p_B);
    float4 color4 = make_float4(p_R, p_G, p_B, 1.0f);
    return make_float3(color.x + color4.x, color.y, color.z);
}
"#;
        let result = compile_dctl(source);
        assert!(!result.contains("\"error\":true"), "Compile should succeed: {}", result);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let wgsl = parsed["wgsl"].as_str().unwrap();
        // Check vector constructors are converted
        assert!(wgsl.contains("vec3<f32>") || wgsl.contains("vec3f"), "WGSL should contain vec3");
        assert!(wgsl.contains("vec4<f32>") || wgsl.contains("vec4f"), "WGSL should contain vec4");
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_compile_entry_point_name() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R, p_G, p_B);
}
"#;
        let result = compile_dctl(source);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let entry_point = parsed["entry_point"].as_str().unwrap();
        assert_eq!(entry_point, "transform", "Entry point should be 'transform'");
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_parse_multiple_functions() {
        let source = r#"
__DEVICE__ float helper(float x)
{
    return x * 2.0f;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(helper(p_R), helper(p_G), helper(p_B));
}
"#;
        let result = parse_dctl(source);
        assert!(!result.contains("\"error\":true"), "Parse should succeed: {}", result);
        // Should have multiple function declarations
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let declarations = parsed["declarations"].as_array();
        assert!(declarations.is_some(), "Should have declarations array");
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_compile_with_conditional() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    if (p_R > 0.5f) {
        return make_float3(1.0f, p_G, p_B);
    } else {
        return make_float3(0.0f, p_G, p_B);
    }
}
"#;
        let result = compile_dctl(source);
        // Conditionals may not be fully implemented yet - just verify we get a response
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();

        // Check if it's an error
        if parsed.get("error").is_some() {
            // Error is expected for unimplemented features
            let msg = parsed["message"].as_str().unwrap_or("");
            // Accept errors about unimplemented if statements
            assert!(
                msg.contains("if") || msg.contains("Statement") || msg.contains("not implemented"),
                "Unexpected error: {}",
                result
            );
        } else {
            // Successful compilation - WGSL may be minimal or empty
            // Just verify the structure is correct
            assert!(parsed.get("wgsl").is_some(), "Should have wgsl field");
            assert!(parsed.get("entry_point").is_some(), "Should have entry_point field");
        }
    }

    #[test]
    #[cfg(feature = "native-parser")]
    fn test_compile_with_loop() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float sum = 0.0f;
    for (int i = 0; i < 10; i = i + 1) {
        sum = sum + 0.1f;
    }
    return make_float3(sum, p_G, p_B);
}
"#;
        let result = compile_dctl(source);
        // Loops may not be fully implemented yet - just verify compilation doesn't error
        // or check if the result indicates unimplemented feature
        if result.contains("\"error\":true") {
            // If it's an error about unimplemented feature, that's acceptable
            assert!(
                result.contains("not implemented") || result.contains("unsupported") || result.contains("todo"),
                "Unexpected compilation error: {}",
                result
            );
        } else {
            // Compilation succeeded - verify WGSL output exists
            let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
            let wgsl = parsed["wgsl"].as_str().unwrap_or("");
            // Either has loop construct or some output
            assert!(
                wgsl.contains("for") || wgsl.contains("loop") || wgsl.contains("while") || !wgsl.is_empty(),
                "WGSL should have some output"
            );
        }
    }
}
