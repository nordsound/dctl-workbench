//! Semantic analysis module
//!
//! Provides type checking, symbol resolution, and semantic validation.

mod analyzer;
mod types;

pub use analyzer::*;
pub use types::*;

use crate::parser::DctlModule;
use crate::{Diagnostic, Parameter};
use thiserror::Error;

/// Semantic analysis error
#[derive(Error, Debug)]
pub enum SemanticError {
    #[error("Undefined symbol '{name}' at line {line}")]
    UndefinedSymbol { name: String, line: usize },

    #[error("Type mismatch: expected {expected}, found {found} at line {line}")]
    TypeMismatch {
        expected: String,
        found: String,
        line: usize,
    },

    #[error("Duplicate definition of '{name}' at line {line}")]
    DuplicateDefinition { name: String, line: usize },

    #[error("Invalid operation: {message} at line {line}")]
    InvalidOperation { message: String, line: usize },

    #[error("Internal semantic error: {0}")]
    Internal(String),
}

/// Result of semantic analysis
#[derive(Debug)]
pub struct AnalysisResult {
    /// The analyzed module with resolved types
    pub module: DctlModule,
    /// Collected diagnostics (warnings, etc.)
    pub diagnostics: Vec<Diagnostic>,
    /// Extracted UI parameters
    pub parameters: Vec<Parameter>,
    /// Entry point function name
    pub entry_point: String,
}

/// Perform semantic analysis on a parsed DCTL module
pub fn analyze(module: &DctlModule) -> Result<AnalysisResult, SemanticError> {
    let mut analyzer = SemanticAnalyzer::new();
    analyzer.analyze(module)
}
