//! DCTL Preprocessor
//!
//! Handles #include directive resolution for DCTL source files.
//! Works with pre-collected include files provided by the TypeScript layer.

use std::collections::HashMap;
use thiserror::Error;

/// Maximum depth of nested includes to prevent infinite loops
const MAX_INCLUDE_DEPTH: usize = 32;

/// Errors that can occur during preprocessing
#[derive(Error, Debug)]
pub enum PreprocessError {
    #[error("Include file not found: {0}")]
    IncludeNotFound(String),

    #[error("Circular include detected: {0}")]
    CircularInclude(String),

    #[error("Maximum include depth ({0}) exceeded")]
    MaxDepthExceeded(usize),

    #[error("Invalid include directive at line {0}")]
    InvalidIncludeDirective(usize),
}

/// Preprocess DCTL source code by resolving #include directives
///
/// # Arguments
/// * `source` - The main DCTL source code
/// * `includes` - Map of include file paths to their contents (pre-collected by TypeScript)
///
/// # Returns
/// The preprocessed source with all #include directives replaced by file contents
pub fn preprocess(
    source: &str,
    includes: &HashMap<String, String>,
) -> Result<String, PreprocessError> {
    preprocess_recursive(source, includes, &mut Vec::new(), 0)
}

/// Recursively process includes
fn preprocess_recursive(
    source: &str,
    includes: &HashMap<String, String>,
    include_stack: &mut Vec<String>,
    depth: usize,
) -> Result<String, PreprocessError> {
    if depth > MAX_INCLUDE_DEPTH {
        return Err(PreprocessError::MaxDepthExceeded(MAX_INCLUDE_DEPTH));
    }

    let mut result = source.to_string();
    let include_regex = regex::Regex::new(r#"#include\s*["<]([^">]+)[">]"#)
        .expect("Invalid regex pattern");

    // Process all #include directives
    // We need to loop because replacing one include might expose more includes
    loop {
        let Some(caps) = include_regex.captures(&result) else {
            break;
        };

        let full_match = caps.get(0).unwrap();
        let include_path = caps.get(1).unwrap().as_str();

        // Check for circular includes
        if include_stack.contains(&include_path.to_string()) {
            return Err(PreprocessError::CircularInclude(include_path.to_string()));
        }

        // Get the include content
        let content = includes
            .get(include_path)
            .ok_or_else(|| PreprocessError::IncludeNotFound(include_path.to_string()))?;

        // Recursively process the included file
        include_stack.push(include_path.to_string());
        let processed_content = preprocess_recursive(content, includes, include_stack, depth + 1)?;
        include_stack.pop();

        // Replace the #include directive with the processed content
        // Add a newline before and after to ensure proper separation
        let replacement = format!("\n/* begin {} */\n{}\n/* end {} */\n",
            include_path, processed_content, include_path);
        result = result.replacen(full_match.as_str(), &replacement, 1);
    }

    Ok(result)
}

/// Check if source contains any #include directives
pub fn has_includes(source: &str) -> bool {
    let include_regex = regex::Regex::new(r#"#include\s*["<]([^">]+)[">]"#)
        .expect("Invalid regex pattern");
    include_regex.is_match(source)
}

/// Extract all include paths from source (without processing)
pub fn extract_include_paths(source: &str) -> Vec<String> {
    let include_regex = regex::Regex::new(r#"#include\s*["<]([^">]+)[">]"#)
        .expect("Invalid regex pattern");

    include_regex
        .captures_iter(source)
        .map(|cap| cap.get(1).unwrap().as_str().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_includes() {
        let source = "float x = 1.0;";
        let includes = HashMap::new();
        let result = preprocess(source, &includes).unwrap();
        assert_eq!(result, source);
    }

    #[test]
    fn test_simple_include() {
        let source = r#"#include "header.h"
float x = helper();"#;
        let mut includes = HashMap::new();
        includes.insert("header.h".to_string(), "float helper() { return 1.0; }".to_string());

        let result = preprocess(source, &includes).unwrap();
        assert!(result.contains("float helper()"));
        assert!(result.contains("float x = helper()"));
        assert!(!result.contains("#include"));
    }

    #[test]
    fn test_nested_includes() {
        let source = r#"#include "a.h""#;
        let mut includes = HashMap::new();
        includes.insert("a.h".to_string(), r#"#include "b.h"
float a() { return b(); }"#.to_string());
        includes.insert("b.h".to_string(), "float b() { return 1.0; }".to_string());

        let result = preprocess(source, &includes).unwrap();
        assert!(result.contains("float a()"));
        assert!(result.contains("float b()"));
        assert!(!result.contains("#include"));
    }

    #[test]
    fn test_circular_include_detection() {
        let source = r#"#include "a.h""#;
        let mut includes = HashMap::new();
        includes.insert("a.h".to_string(), r#"#include "b.h""#.to_string());
        includes.insert("b.h".to_string(), r#"#include "a.h""#.to_string());

        let result = preprocess(source, &includes);
        assert!(matches!(result, Err(PreprocessError::CircularInclude(_))));
    }

    #[test]
    fn test_missing_include() {
        let source = r#"#include "missing.h""#;
        let includes = HashMap::new();

        let result = preprocess(source, &includes);
        assert!(matches!(result, Err(PreprocessError::IncludeNotFound(_))));
    }

    #[test]
    fn test_has_includes() {
        assert!(has_includes(r#"#include "header.h""#));
        assert!(has_includes(r#"#include <system.h>"#));
        assert!(!has_includes("float x = 1.0;"));
    }

    #[test]
    fn test_extract_include_paths() {
        let source = r#"
#include "header1.h"
#include <header2.h>
float x = 1.0;
#include "header3.h"
"#;
        let paths = extract_include_paths(source);
        assert_eq!(paths.len(), 3);
        assert!(paths.contains(&"header1.h".to_string()));
        assert!(paths.contains(&"header2.h".to_string()));
        assert!(paths.contains(&"header3.h".to_string()));
    }
}
