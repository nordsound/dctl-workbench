//! Code generation module
//!
//! Generates WGSL output from analyzed DCTL code via Naga Module.

mod builtins;
mod coercion;
mod declarations;
mod expressions;
mod function_calls;
mod functions;
mod inference;
mod initializers;
mod naga_module;
mod pointer_analysis;
mod statements;
mod types;
mod wgsl;

pub use naga_module::*;
pub use wgsl::*;

use crate::semantic::AnalysisResult;
use thiserror::Error;

/// Code generation error
#[derive(Error, Debug)]
pub enum CodegenError {
    #[error("Failed to generate Naga module: {0}")]
    NagaModuleError(String),

    #[error("WGSL generation failed: {0}")]
    WgslError(String),

    #[error("Unsupported feature: {0}")]
    UnsupportedFeature(String),

    #[error("Type conversion error: {0}")]
    TypeConversion(String),

    #[error("Internal codegen error: {0}")]
    Internal(String),
}

/// Generate WGSL from analyzed DCTL module
pub fn generate(analyzed: &AnalysisResult) -> Result<String, CodegenError> {
    // Step 1: Build Naga Module from analyzed AST
    let mut generator = NagaModuleGenerator::new();
    let module = generator.generate(&analyzed.module)?;

    // Step 2: Convert Naga Module to WGSL
    let wgsl = module_to_wgsl(&module)?;

    Ok(wgsl)
}
