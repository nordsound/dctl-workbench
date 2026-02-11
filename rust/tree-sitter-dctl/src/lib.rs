//! DCTL language support for tree-sitter.
//!
//! This crate provides DCTL (DaVinci Color Transform Language) parsing
//! using tree-sitter. DCTL extends CUDA syntax with color processing constructs.

use tree_sitter_language::LanguageFn;

extern "C" {
    fn tree_sitter_dctl() -> *const ();
}

/// Returns the tree-sitter [`LanguageFn`] for DCTL.
///
/// This can be converted to a `tree_sitter::Language` using `.into()` for
/// tree-sitter 0.23+.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_dctl) };

/// Returns the node-types.json contents for this grammar.
pub const NODE_TYPES: &str = include_str!("node-types.json");

/// Returns the grammar.json contents for this grammar.
pub const GRAMMAR: &str = include_str!("grammar.json");

#[cfg(test)]
mod tests {
    use super::*;

    fn get_language() -> tree_sitter::Language {
        LANGUAGE.into()
    }

    #[test]
    fn test_can_load_grammar() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&get_language())
            .expect("Failed to load DCTL grammar");
    }

    #[test]
    fn test_parse_simple_function() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&get_language())
            .expect("Failed to load DCTL grammar");

        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R, p_G, p_B);
}
"#;

        let tree = parser.parse(source, None).expect("Failed to parse");
        assert!(!tree.root_node().has_error());
    }

    #[test]
    fn test_parse_dctl_macro() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&get_language())
            .expect("Failed to load DCTL grammar");

        let source = r#"
DEFINE_UI_PARAMS(gain, Gain, DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)
"#;

        let tree = parser.parse(source, None).expect("Failed to parse");
        let root = tree.root_node();

        // Find the dctl_macro node
        let mut found_macro = false;
        let mut cursor = root.walk();
        for child in root.children(&mut cursor) {
            if child.kind() == "dctl_macro" {
                found_macro = true;
                break;
            }
        }
        assert!(found_macro, "Should find dctl_macro node");
    }

    #[test]
    fn test_parse_full_dctl() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&get_language())
            .expect("Failed to load DCTL grammar");

        let source = r#"
DEFINE_UI_PARAMS(gain, Gain, DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 rgb = make_float3(p_R, p_G, p_B);
    rgb *= gain;
    return rgb;
}
"#;

        let tree = parser.parse(source, None).expect("Failed to parse");
        assert!(!tree.root_node().has_error());
    }
}
