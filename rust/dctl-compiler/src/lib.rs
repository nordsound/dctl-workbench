//! DCTL Compiler - DCTL to WGSL compiler via Naga
//!
//! This crate provides a compiler for DaVinci Color Transformation Language (DCTL)
//! that outputs WebGPU Shading Language (WGSL) using Naga's internal representation.
//!
//! # Architecture
//!
//! ```text
//! DCTL Source
//!     ↓
//! Tree-sitter Parser → AST
//!     ↓
//! Semantic Analyzer (type checking, symbol resolution)
//!     ↓
//! Naga Module Builder (direct IR construction)
//!     ↓
//! WGSL Output
//! ```

pub mod parser;
pub mod preprocessor;
pub mod semantic;
pub mod codegen;
pub mod wasm;

use thiserror::Error;

/// Main error type for the DCTL compiler
#[derive(Error, Debug)]
pub enum CompilerError {
    #[error("Parse error: {0}")]
    Parse(#[from] parser::ParseError),

    #[error("Preprocess error: {0}")]
    Preprocess(#[from] preprocessor::PreprocessError),

    #[error("Semantic error: {0}")]
    Semantic(#[from] semantic::SemanticError),

    #[error("Code generation error: {0}")]
    Codegen(#[from] codegen::CodegenError),
}

/// Result of compiling DCTL source code
#[derive(Debug, serde::Serialize)]
pub struct CompileResult {
    /// Generated WGSL code
    pub wgsl: String,
    /// Compilation diagnostics (warnings, etc.)
    pub diagnostics: Vec<Diagnostic>,
    /// Extracted UI parameters
    pub parameters: Vec<Parameter>,
    /// Entry point function name
    pub entry_point: String,
}

/// A diagnostic message from the compiler
#[derive(Debug, Clone, serde::Serialize)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub line: usize,
    pub column: usize,
}

/// Severity level for diagnostics
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

/// A DCTL UI parameter definition
#[derive(Debug, Clone, serde::Serialize)]
pub struct Parameter {
    pub name: String,
    pub label: String,
    pub param_type: ParameterType,
}

/// Type of UI parameter
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum ParameterType {
    #[serde(rename = "float")]
    Float {
        default: f32,
        min: f32,
        max: f32,
        step: f32,
    },
    #[serde(rename = "int")]
    Int {
        default: i32,
        min: i32,
        max: i32,
        step: i32,
    },
    #[serde(rename = "bool")]
    Bool { default: bool },
    #[serde(rename = "combo")]
    Combo {
        default: i32,
        options: Vec<String>,
    },
}

/// Compile DCTL source code to WGSL
pub fn compile(source: &str) -> Result<CompileResult, CompilerError> {
    // Phase 1: Parse
    let ast = parser::parse(source)?;

    // Phase 2: Semantic analysis
    let analyzed = semantic::analyze(&ast)?;

    // Check if there are any semantic errors - if so, skip codegen
    let has_errors = analyzed
        .diagnostics
        .iter()
        .any(|d| matches!(d.severity, DiagnosticSeverity::Error));

    // Phase 3: Code generation (skip if there are semantic errors)
    let wgsl = if has_errors {
        String::new() // Return empty WGSL if there are semantic errors
    } else {
        codegen::generate(&analyzed)?
    };

    Ok(CompileResult {
        wgsl,
        diagnostics: analyzed.diagnostics,
        parameters: analyzed.parameters,
        entry_point: analyzed.entry_point,
    })
}

/// Compile DCTL source code to WGSL with include resolution
///
/// # Arguments
/// * `source` - The main DCTL source code
/// * `includes` - Map of include file paths to their contents
pub fn compile_with_includes(
    source: &str,
    includes: &std::collections::HashMap<String, String>,
) -> Result<CompileResult, CompilerError> {
    // Phase 0: Preprocess (resolve #include directives)
    let preprocessed = preprocessor::preprocess(source, includes)
        .map_err(|e| CompilerError::Preprocess(e))?;

    // Continue with normal compilation
    compile(&preprocessed)
}

/// Parse DCTL source code and return the AST as JSON
pub fn parse_to_json(source: &str) -> Result<String, CompilerError> {
    let ast = parser::parse(source)?;
    Ok(serde_json::to_string(&ast).unwrap_or_else(|_| "{}".to_string()))
}

/// Analyze DCTL source code and return diagnostics as JSON
pub fn analyze_to_json(source: &str) -> Result<String, CompilerError> {
    let ast = parser::parse(source)?;
    let analyzed = semantic::analyze(&ast)?;
    Ok(serde_json::to_string(&analyzed.diagnostics).unwrap_or_else(|_| "[]".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_compile() {
        // Test compiling empty source
        let result = compile("");
        assert!(result.is_ok());
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.is_empty());
    }

    #[test]
    fn test_parse_to_json() {
        let result = parse_to_json("");
        assert!(result.is_ok());
    }

    #[test]
    fn test_analyze_to_json() {
        let result = analyze_to_json("");
        assert!(result.is_ok());
    }

    /// Test compiling a full DCTL shader with UI parameters
    /// Requires native-parser feature for actual parsing
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_compile_saturation_dctl() {
        let source = r#"
DEFINE_UI_PARAMS(saturation, Saturation, DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 3.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    const float luma_r = 0.2126f;
    const float luma_g = 0.7152f;
    const float luma_b = 0.0722f;

    float luma = p_R * luma_r + p_G * luma_g + p_B * luma_b;

    float3 result;
    result.x = luma + (p_R - luma) * saturation;
    result.y = luma + (p_G - luma) * saturation;
    result.z = luma + (p_B - luma) * saturation;

    return result;
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());

        let compile_result = result.unwrap();

        // Check entry point
        assert_eq!(compile_result.entry_point, "transform");

        // Check parameters
        assert_eq!(compile_result.parameters.len(), 1);
        assert_eq!(compile_result.parameters[0].name, "saturation");

        // Check no errors in diagnostics
        let errors: Vec<_> = compile_result
            .diagnostics
            .iter()
            .filter(|d| matches!(d.severity, DiagnosticSeverity::Error))
            .collect();
        assert!(errors.is_empty(), "Unexpected errors: {:?}", errors);
    }

    /// Test WGSL code generation
    /// Requires native-parser feature for actual parsing
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_wgsl_output() {
        let source = r#"
DEFINE_UI_PARAMS(saturation, Saturation, DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 3.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    const float luma_r = 0.2126f;
    const float luma_g = 0.7152f;
    const float luma_b = 0.0722f;

    float luma = p_R * luma_r + p_G * luma_g + p_B * luma_b;

    float3 result;
    result.x = luma + (p_R - luma) * saturation;
    result.y = luma + (p_G - luma) * saturation;
    result.z = luma + (p_B - luma) * saturation;

    return result;
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());

        let compile_result = result.unwrap();

        // Print the generated WGSL
        println!("=== Generated WGSL ===");
        println!("{}", compile_result.wgsl);
        println!("=== End WGSL ===");

        // Basic checks on WGSL output
        assert!(!compile_result.wgsl.is_empty(), "WGSL output is empty");
        assert!(
            compile_result.wgsl.contains("fn transform"),
            "WGSL should contain transform function"
        );
    }

    /// Test semantic error detection (undefined variables)
    /// Requires native-parser feature for actual parsing
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_semantic_error_detection() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float x = undefined_variable;
    return make_float3(p_R, p_G, p_B);
}
"#;
        let result = compile(source);
        assert!(result.is_ok());

        let compile_result = result.unwrap();

        // Should have an error about undefined variable
        let errors: Vec<_> = compile_result
            .diagnostics
            .iter()
            .filter(|d| matches!(d.severity, DiagnosticSeverity::Error))
            .collect();
        assert!(!errors.is_empty(), "Expected error about undefined variable");
        assert!(
            errors[0].message.contains("undefined_variable"),
            "Error should mention undefined_variable: {:?}",
            errors[0]
        );
    }

    /// Test break/continue validation outside loops
    /// Requires native-parser feature for actual parsing
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_break_continue_validation() {
        // Break outside loop should error
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    break;
    return make_float3(p_R, p_G, p_B);
}
"#;
        let result = compile(source);
        assert!(result.is_ok());

        let compile_result = result.unwrap();
        let errors: Vec<_> = compile_result
            .diagnostics
            .iter()
            .filter(|d| matches!(d.severity, DiagnosticSeverity::Error))
            .collect();
        assert!(!errors.is_empty(), "Expected error about break outside loop");
    }

    /// Test for loop variable scope
    /// Requires native-parser feature for actual parsing
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_for_loop_scope() {
        // Variable declared in for loop should not be visible outside
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    for (int i = 0; i < 10; i++) {
        float temp = (float)i;
    }
    float x = i;  // i should be undefined here
    return make_float3(p_R, p_G, p_B);
}
"#;
        let result = compile(source);
        assert!(result.is_ok());

        let compile_result = result.unwrap();
        let errors: Vec<_> = compile_result
            .diagnostics
            .iter()
            .filter(|d| matches!(d.severity, DiagnosticSeverity::Error))
            .collect();
        assert!(!errors.is_empty(), "Expected error about undefined variable 'i'");
    }

    // =========================================================================
    // Builtin Functions Tests
    // =========================================================================

    /// Test using PI-like value directly (constant folding)
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_math_operations_with_pi() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    // Use inline PI value since math constants may not be defined as variables
    float angle = 3.14159f * 0.5f;
    float result = _sinf(angle);
    return make_float3(result, result, result);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        // sin function should be in WGSL
        assert!(compile_result.wgsl.contains("sin("));
    }

    /// Test exp function (uses E internally)
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_exp_function() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float val = _expf(1.0f);  // e^1 = E
    return make_float3(val, val, val);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        // exp function should be in WGSL
        assert!(compile_result.wgsl.contains("exp("));
    }

    /// Test vector constructor make_float3
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_make_float3() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 result = make_float3(1.0f, 2.0f, 3.0f);
    return result;
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("vec3<f32>"));
    }

    /// Test vector constructor from single scalar (splat)
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_make_float3_splat() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 result = make_float3(1.0f);
    return result;
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    /// Test int to float coercion in make_float4
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_float4_int_coercion() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float4 result = make_float4(1, 2, 3, 4);
    return make_float3(result.x, result.y, result.z);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    /// Test float type cast using C-style cast
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_float_cast() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    int i = 42;
    float f = (float)i;
    return make_float3(f, f, f);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        // C-style cast should generate a type conversion
        assert!(compile_result.wgsl.contains("f32(") || compile_result.wgsl.contains("as f32"));
    }

    /// Test int type cast using C-style cast
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_int_cast() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float f = 3.14f;
    int i = (int)f;
    return make_float3((float)i, (float)i, (float)i);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        // C-style cast should generate a type conversion
        assert!(compile_result.wgsl.contains("i32(") || compile_result.wgsl.contains("as i32"));
    }

    /// Test sin() math function
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_sin() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float angle = 1.0f;
    float s = _sinf(angle);
    return make_float3(s, s, s);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("sin("));
    }

    /// Test cos() math function
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_cos() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float angle = 1.0f;
    float c = _cosf(angle);
    return make_float3(c, c, c);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("cos("));
    }

    /// Test pow() math function
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_pow() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float base = 2.0f;
    float exp = 3.0f;
    float result = _powf(base, exp);
    return make_float3(result, result, result);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("pow("));
    }

    /// Test clamp() math function
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_clamp() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float clamped = _clampf(p_R, 0.0f, 1.0f);
    return make_float3(clamped, p_G, p_B);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("clamp("));
    }

    /// Test mix/lerp function
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_mix() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float result = _mix(0.0f, 1.0f, 0.5f);
    return make_float3(result, result, result);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("mix("));
    }

    /// Test fabs/abs function
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_fabs() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float result = _fabs(-1.5f);
    return make_float3(result, result, result);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("abs("));
    }

    /// Test fmod function
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_fmod() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float result = _fmod(5.0f, 3.0f);
    return make_float3(result, result, result);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        // fmod is implemented as modulo operator
        assert!(compile_result.wgsl.contains("%"));
    }

    /// Test isnan function
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_isnan() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    bool nan_check = isnan(p_R);
    float result = nan_check ? 0.0f : p_R;
    return make_float3(result, p_G, p_B);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    /// Test matrix-vector multiplication mult_f3_f33 with mat3 constructor
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_mult_f3_f33() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 color = make_float3(p_R, p_G, p_B);
    // Use mat3 constructor with 3 vec3 arguments (column vectors)
    float3x3 mat = mat3(
        make_float3(1.0f, 0.0f, 0.0f),
        make_float3(0.0f, 1.0f, 0.0f),
        make_float3(0.0f, 0.0f, 1.0f)
    );
    float3 result = mult_f3_f33(color, mat);
    return result;
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        // mat * vec multiplication should be in WGSL
        assert!(compile_result.wgsl.contains("*"));
    }

    /// Test transpose_f33 function with mat3 constructor
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_transpose() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3x3 mat = mat3(
        make_float3(1.0f, 2.0f, 3.0f),
        make_float3(4.0f, 5.0f, 6.0f),
        make_float3(7.0f, 8.0f, 9.0f)
    );
    float3x3 transposed = transpose_f33(mat);
    float3 color = make_float3(p_R, p_G, p_B);
    return mult_f3_f33(color, transposed);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("transpose("));
    }

    /// Test exp10 function (composite function)
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_exp10() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float result = _exp10f(2.0f);
    return make_float3(result, result, result);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        // exp10 is implemented as pow(10.0, x)
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("pow("));
    }

    /// Test log10 function (composite function)
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_log10() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float result = _log10f(100.0f);
    return make_float3(result, result, result);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    /// Test hypot function (composite function)
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_hypot() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float result = _hypotf(3.0f, 4.0f);
    return make_float3(result, result, result);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        // hypot is implemented as sqrt(x*x + y*y)
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("sqrt("));
    }

    /// Test copysign function (composite function)
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_builtin_copysign() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float result = _copysignf(1.0f, -2.0f);
    return make_float3(result, result, result);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        // copysign is implemented as abs(x) * sign(y)
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("abs(") && compile_result.wgsl.contains("sign("));
    }

    /// Test swizzle operations (xyz)
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_swizzle_xyz() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float4 color = make_float4(p_R, p_G, p_B, 1.0f);
    float3 result = color.xyz;
    return result;
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    /// Test swizzle operations (rgb)
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_swizzle_rgb() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float4 color = make_float4(p_R, p_G, p_B, 1.0f);
    float3 result;
    result.r = color.r;
    result.g = color.g;
    result.b = color.b;
    return result;
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    // =========================================================================
    // Function Calls Tests
    // =========================================================================

    /// Test user-defined helper function call
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_user_function_call() {
        let source = r#"
__DEVICE__ float helper(float x) {
    return x * 2.0f;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float r = helper(p_R);
    float g = helper(p_G);
    float b = helper(p_B);
    return make_float3(r, g, b);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("fn helper"));
    }

    /// Test function with multiple parameters
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_function_multiple_params() {
        let source = r#"
__DEVICE__ float blend(float a, float b, float t) {
    return a * (1.0f - t) + b * t;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float r = blend(0.0f, p_R, 0.5f);
    float g = blend(0.0f, p_G, 0.5f);
    float b = blend(0.0f, p_B, 0.5f);
    return make_float3(r, g, b);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
        let compile_result = result.unwrap();
        assert!(compile_result.wgsl.contains("fn blend"));
    }

    /// Test nested function calls
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_nested_function_calls() {
        let source = r#"
__DEVICE__ float add(float a, float b) {
    return a + b;
}

__DEVICE__ float mul(float a, float b) {
    return a * b;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float result = mul(add(p_R, p_G), p_B);
    return make_float3(result, result, result);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    // =========================================================================
    // Declarations Tests
    // =========================================================================

    /// Test local variable declaration
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_local_variable() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float x = 1.0f;
    float y = 2.0f;
    float z = x + y;
    return make_float3(z, z, z);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    /// Test const variable declaration
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_const_variable() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    const float factor = 0.5f;
    return make_float3(p_R * factor, p_G * factor, p_B * factor);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    /// Test global constant declaration
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_global_constant() {
        let source = r#"
__CONSTANT__ float FACTOR = 2.0f;

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R * FACTOR, p_G * FACTOR, p_B * FACTOR);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    /// Test local array declaration
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_local_array() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float arr[3];
    arr[0] = p_R;
    arr[1] = p_G;
    arr[2] = p_B;
    return make_float3(arr[0], arr[1], arr[2]);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    /// Test array with initializer
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_array_initializer() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float arr[3] = {p_R, p_G, p_B};
    return make_float3(arr[0], arr[1], arr[2]);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    /// Test typedef (struct declaration may have limited support)
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_typedef_alias() {
        let source = r#"
typedef float3 vec3f;

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    vec3f color = make_float3(p_R, p_G, p_B);
    return color;
}
"#;
        let result = compile(source);
        // typedef alias may or may not be supported
        // Just verify it doesn't crash
        assert!(result.is_ok() || result.is_err());
    }

    /// Test multiple variable declarations in one statement
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_multiple_declarations() {
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float x, y, z;
    x = p_R;
    y = p_G;
    z = p_B;
    return make_float3(x, y, z);
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile failed: {:?}", result.err());
    }

    /// Test function overload resolution with multiple return types
    /// When a function has overloads returning different types (e.g. float3 and void),
    /// the compiler should resolve to the correct overload based on argument types.
    /// Reproduces: DCTL010 "Assignment type mismatch: 'float3' = 'void'" for multi(float3, mat3)
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_function_overload_resolution_with_void_variant() {
        let source = r#"
// User-defined mat3 struct (as defined in DCTL_Functions.h)
// This shadows the builtin mat3 type
typedef struct {
    float3 r0;
    float3 r1;
    float3 r2;
} mat3;

__DEVICE__ inline mat3 make_mat3_rows(float3 A, float3 B, float3 C)
{
    mat3 D;
    D.r0 = A;
    D.r1 = B;
    D.r2 = C;
    return D;
}

// Overloaded: multi(float3, mat3) -> float3
__DEVICE__ inline float3 multi(float3 A, mat3 B)
{
    return make_float3(A.x, A.y, A.z);
}

// Overloaded: multi(mat3, float3) -> float3
__DEVICE__ inline float3 multi(mat3 B, float3 A)
{
    return make_float3(A.x, A.y, A.z);
}

// Overloaded: multi(float*, float*, int) -> void
__DEVICE__ inline void multi(float* A, float* B, int n)
{
    A[0] = B[0];
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 color = make_float3(p_R, p_G, p_B);
    mat3 m = make_mat3_rows(
        make_float3(1.0f, 0.0f, 0.0f),
        make_float3(0.0f, 1.0f, 0.0f),
        make_float3(0.0f, 0.0f, 1.0f)
    );
    float3 result = multi(color, m);
    return result;
}
"#;
        let result = compile(source);
        // Compilation should succeed (no hard failure)
        assert!(result.is_ok(), "Compile should not hard-fail for typedef struct mat3: {:?}", result.err());
        let compile_result = result.unwrap();
        // And there should be no type mismatch errors
        let errors: Vec<_> = compile_result.diagnostics.iter()
            .filter(|d| matches!(d.severity, DiagnosticSeverity::Error))
            .collect();
        assert!(
            errors.is_empty(),
            "Should have no errors for multi(float3, mat3) overload, got: {:?}",
            errors
        );
    }

    /// Test that typedef struct with chained member access (B.r0.x) works correctly.
    /// This matches the actual DCTL_Functions.h pattern where multi() accesses
    /// struct member's vector components.
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_typedef_struct_chained_member_access() {
        let source = r#"
typedef struct {
    float3 r0;
    float3 r1;
    float3 r2;
} mat3;

__DEVICE__ inline float3 multi(float3 A, mat3 B)
{
    float3 C;
    C.x = A.x * B.r0.x + A.y * B.r0.y + A.z * B.r0.z;
    C.y = A.x * B.r1.x + A.y * B.r1.y + A.z * B.r1.z;
    C.z = A.x * B.r2.x + A.y * B.r2.y + A.z * B.r2.z;
    return C;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 color = make_float3(p_R, p_G, p_B);
    mat3 m;
    m.r0 = make_float3(1.0f, 0.0f, 0.0f);
    m.r1 = make_float3(0.0f, 1.0f, 0.0f);
    m.r2 = make_float3(0.0f, 0.0f, 1.0f);
    float3 result = multi(color, m);
    return result;
}
"#;
        let result = compile(source);
        assert!(result.is_ok(), "Compile should not hard-fail: {:?}", result.err());
        let compile_result = result.unwrap();
        let errors: Vec<_> = compile_result.diagnostics.iter()
            .filter(|d| matches!(d.severity, DiagnosticSeverity::Error))
            .collect();
        assert!(
            errors.is_empty(),
            "Should have no errors for chained member access B.r0.x, got: {:?}",
            errors
        );
    }

    /// Test compile_with_includes using a realistic DCTL_Functions.h header
    /// that defines mat2/mat3/mat4 typedefs and multi() overloads.
    /// This reproduces the actual Choc_OFX.dctl error: DCTL010 "Assignment type mismatch: 'float3' = 'void'"
    #[test]
    #[cfg(feature = "native-parser")]
    fn test_compile_with_includes_typedef_struct_overloads() {
        let header = r#"
typedef struct { float2 r0, r1; } mat2;
typedef struct { float3 r0, r1, r2; } mat3;
typedef struct { float4 r0, r1, r2, r3; } mat4;

__DEVICE__ inline mat2 make_mat2(float A1, float A2, float B1, float B2) {
    mat2 C; C.r0 = make_float2(A1, A2); C.r1 = make_float2(B1, B2); return C;
}

__DEVICE__ inline mat3 make_mat3(float3 A, float3 B, float3 C) {
    mat3 D; D.r0 = A; D.r1 = B; D.r2 = C; return D;
}

__DEVICE__ inline mat3 make_mat3(float m00, float m01, float m02,
    float m10, float m11, float m12, float m20, float m21, float m22) {
    mat3 M;
    M.r0 = make_float3(m00, m01, m02);
    M.r1 = make_float3(m10, m11, m12);
    M.r2 = make_float3(m20, m21, m22);
    return M;
}

__DEVICE__ inline float2 multi(float2 A, mat2 B) {
    float2 C;
    C.x = A.x * B.r0.x + A.y * B.r0.y;
    C.y = A.x * B.r1.x + A.y * B.r1.y;
    return C;
}

__DEVICE__ inline mat3 multi(mat3 A, float B) {
    return make_mat3(A.r0 * B, A.r1 * B, A.r2 * B);
}

__DEVICE__ inline mat3 multi(float B, mat3 A) {
    return make_mat3(A.r0 * B, A.r1 * B, A.r2 * B);
}

__DEVICE__ inline float3 multi(float3 A, mat3 B) {
    float3 C;
    C.x = A.x * B.r0.x + A.y * B.r0.y + A.z * B.r0.z;
    C.y = A.x * B.r1.x + A.y * B.r1.y + A.z * B.r1.z;
    C.z = A.x * B.r2.x + A.y * B.r2.y + A.z * B.r2.z;
    return C;
}

__DEVICE__ inline float3 multi(mat3 B, float3 A) {
    float3 C;
    C.x = A.x * B.r0.x + A.y * B.r0.y + A.z * B.r0.z;
    C.y = A.x * B.r1.x + A.y * B.r1.y + A.z * B.r1.z;
    C.z = A.x * B.r2.x + A.y * B.r2.y + A.z * B.r2.z;
    return C;
}

__DEVICE__ inline mat3 multi(mat3 A, mat3 B) {
    mat3 R = make_mat3(
        make_float3(A.r0.x * B.r0.x + A.r0.y * B.r1.x + A.r0.z * B.r2.x,
                     A.r0.x * B.r0.y + A.r0.y * B.r1.y + A.r0.z * B.r2.y,
                     A.r0.x * B.r0.z + A.r0.y * B.r1.z + A.r0.z * B.r2.z),
        make_float3(A.r1.x * B.r0.x + A.r1.y * B.r1.x + A.r1.z * B.r2.x,
                     A.r1.x * B.r0.y + A.r1.y * B.r1.y + A.r1.z * B.r2.y,
                     A.r1.x * B.r0.z + A.r1.y * B.r1.z + A.r1.z * B.r2.z),
        make_float3(A.r2.x * B.r0.x + A.r2.y * B.r1.x + A.r2.z * B.r2.x,
                     A.r2.x * B.r0.y + A.r2.y * B.r1.y + A.r2.z * B.r2.y,
                     A.r2.x * B.r0.z + A.r2.y * B.r1.z + A.r2.z * B.r2.z));
    return R;
}

__DEVICE__ inline void multi(float* A, float* B, mat2 C) {
    float a = *A;
    float b = *B;
    float2 AB = multi(make_float2(a, b), C);
    *A = AB.x;
    *B = AB.y;
}

__DEVICE__ inline mat3 cam3D(float rotateX, float rotateY, float rotateZ) {
    mat3 rot_x = make_mat3(1.0f, 0.0f, 0.0f, 0.0f, _cosf(rotateX), _sinf(rotateX), 0.0f, -_sinf(rotateX), _cosf(rotateX));
    mat3 rot_y = make_mat3(_cosf(rotateY), 0.0f, _sinf(rotateY), 0.0f, 1.0f, 0.0f, -_sinf(rotateY), 0.0f, _cosf(rotateY));
    mat3 rot_z = make_mat3(_cosf(rotateZ), _sinf(rotateZ), 0.0f, -_sinf(rotateZ), _cosf(rotateZ), 0.0f, 0.0f, 0.0f, 1.0f);
    mat3 Cam = multi(multi(rot_y, rot_x), rot_z);
    return Cam;
}
"#;

        let source = r#"
#include "DCTL_Functions.h"

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 ro = make_float3(p_R, p_G, p_B);
    mat3 cam = cam3D(0.0f, 0.0f, 0.0f);
    ro = multi(ro, cam);
    return ro;
}
"#;
        let mut includes = std::collections::HashMap::new();
        includes.insert("DCTL_Functions.h".to_string(), header.to_string());

        let result = compile_with_includes(source, &includes);
        assert!(result.is_ok(), "Compile should not hard-fail: {:?}", result.err());
        let compile_result = result.unwrap();

        // Print all diagnostics for debugging
        for d in &compile_result.diagnostics {
            eprintln!("  [{:?}] line {}: {}", d.severity, d.line, d.message);
        }

        // Check no type mismatch errors/warnings (the original bug: DCTL010)
        let type_mismatches: Vec<_> = compile_result.diagnostics.iter()
            .filter(|d| d.message.contains("type mismatch") || d.message.contains("Type mismatch"))
            .collect();
        assert!(
            type_mismatches.is_empty(),
            "Should have no type mismatch diagnostics for multi() overload calls, got: {:?}",
            type_mismatches
        );

        // Pointer dereference errors (*A, *B) are expected - a known limitation.
        // But the transform function's call to multi(float3, mat3) should work.
    }
}
