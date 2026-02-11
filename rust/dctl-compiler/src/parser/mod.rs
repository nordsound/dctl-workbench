//! DCTL Parser module
//!
//! Provides parsing functionality.
//! - Native builds: uses tree-sitter-dctl grammar
//! - WASM builds: accepts pre-parsed AST as JSON

mod ast;

#[cfg(feature = "native-parser")]
mod tree_sitter_parser;

pub use ast::*;

use thiserror::Error;

/// Parse error type
#[derive(Error, Debug)]
pub enum ParseError {
    #[error("Syntax error at line {line}, column {column}: {message}")]
    SyntaxError {
        message: String,
        line: usize,
        column: usize,
    },

    #[error("Unexpected token: expected {expected}, found {found}")]
    UnexpectedToken {
        expected: String,
        found: String,
        line: usize,
        column: usize,
    },

    #[error("Parser initialization failed: {0}")]
    InitializationError(String),

    #[error("JSON parse error: {0}")]
    JsonError(String),

    #[error("Internal parser error: {0}")]
    Internal(String),
}

/// DCTL Parser
///
/// For WASM builds, this uses JSON AST input.
/// For native builds with `native-parser` feature, this uses tree-sitter.
pub struct DctlParser {
    #[cfg(feature = "native-parser")]
    inner: tree_sitter_parser::TreeSitterParser,
}

impl DctlParser {
    /// Create a new DCTL parser
    pub fn new() -> Result<Self, ParseError> {
        #[cfg(feature = "native-parser")]
        {
            Ok(Self {
                inner: tree_sitter_parser::TreeSitterParser::new()?,
            })
        }
        #[cfg(not(feature = "native-parser"))]
        {
            Ok(Self {})
        }
    }

    /// Parse DCTL source code into an AST
    ///
    /// For WASM builds without native-parser feature, this is a placeholder
    /// that returns an empty module. Use `parse_json` instead.
    pub fn parse(&mut self, source: &str) -> Result<DctlModule, ParseError> {
        #[cfg(feature = "native-parser")]
        {
            self.inner.parse(source)
        }
        #[cfg(not(feature = "native-parser"))]
        {
            // For WASM builds, return empty module or use parse_json
            if source.trim().is_empty() {
                return Ok(DctlModule::default());
            }
            // Placeholder implementation
            Ok(DctlModule::default())
        }
    }

    /// Parse pre-parsed AST from JSON
    ///
    /// This is the primary parsing method for WASM builds where tree-sitter
    /// parsing is done in JavaScript and the AST is passed as JSON.
    pub fn parse_json(&self, json: &str) -> Result<DctlModule, ParseError> {
        serde_json::from_str(json)
            .map_err(|e| ParseError::JsonError(e.to_string()))
    }
}

impl Default for DctlParser {
    fn default() -> Self {
        Self::new().expect("Failed to create parser")
    }
}

/// Parse DCTL source code into an AST
///
/// For native builds, parses the source code directly.
/// For WASM builds, returns empty module (use `parse_json` instead).
pub fn parse(source: &str) -> Result<DctlModule, ParseError> {
    let mut parser = DctlParser::new()?;
    parser.parse(source)
}

/// Parse pre-parsed AST from JSON
///
/// Used for WASM builds where tree-sitter parsing is done in JavaScript.
pub fn parse_json(json: &str) -> Result<DctlModule, ParseError> {
    let parser = DctlParser::new()?;
    parser.parse_json(json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parser_creation() {
        let parser = DctlParser::new();
        assert!(parser.is_ok());
    }

    #[test]
    fn test_empty_source() {
        let mut parser = DctlParser::new().unwrap();
        let result = parser.parse("");
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_json_empty() {
        let parser = DctlParser::new().unwrap();
        let result = parser.parse_json(r#"{"declarations":[],"ui_params":[]}"#);
        assert!(result.is_ok());
    }
}
