//! DCTL Type System
//!
//! Defines the type system used for semantic analysis and type checking.

use std::collections::HashMap;

/// DCTL type representation for semantic analysis
#[derive(Debug, Clone, PartialEq)]
pub enum DctlType {
    // Scalar types
    Void,
    Bool,
    Char,
    Int,
    UInt,
    Float,
    Double,
    Half,

    // Vector types
    Vec2(ScalarType),
    Vec3(ScalarType),
    Vec4(ScalarType),

    // Matrix types
    Mat2,
    Mat3,
    Mat4,

    // Compound types
    Array(Box<DctlType>, Option<usize>),
    Struct(String),
    Pointer(Box<DctlType>),

    // Function type
    Function {
        params: Vec<DctlType>,
        ret: Box<DctlType>,
    },

    // Texture types
    Texture2D,
    Texture3D,
    Sampler,

    // Unknown/unresolved type
    Unknown,
}

/// Scalar types for vector elements
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalarType {
    Float,
    Int,
    UInt,
    Half,
    Bool,
}

impl DctlType {
    /// Check if this type is a scalar type
    pub fn is_scalar(&self) -> bool {
        matches!(
            self,
            DctlType::Bool
                | DctlType::Char
                | DctlType::Int
                | DctlType::UInt
                | DctlType::Float
                | DctlType::Double
                | DctlType::Half
        )
    }

    /// Check if this type is a vector type
    pub fn is_vector(&self) -> bool {
        matches!(
            self,
            DctlType::Vec2(_) | DctlType::Vec3(_) | DctlType::Vec4(_)
        )
    }

    /// Check if this type is a matrix type
    pub fn is_matrix(&self) -> bool {
        matches!(self, DctlType::Mat2 | DctlType::Mat3 | DctlType::Mat4)
    }

    /// Check if this type is numeric (scalar or vector of numeric)
    pub fn is_numeric(&self) -> bool {
        match self {
            DctlType::Int
            | DctlType::UInt
            | DctlType::Float
            | DctlType::Double
            | DctlType::Half => true,
            DctlType::Vec2(s) | DctlType::Vec3(s) | DctlType::Vec4(s) => {
                matches!(
                    s,
                    ScalarType::Float | ScalarType::Int | ScalarType::UInt | ScalarType::Half
                )
            }
            _ => false,
        }
    }

    /// Get the vector size (1 for scalars, 2-4 for vectors)
    pub fn vector_size(&self) -> usize {
        match self {
            DctlType::Vec2(_) => 2,
            DctlType::Vec3(_) => 3,
            DctlType::Vec4(_) => 4,
            _ if self.is_scalar() => 1,
            _ => 0,
        }
    }

    /// Get the scalar type of a vector, or the type itself if scalar
    pub fn scalar_type(&self) -> Option<ScalarType> {
        match self {
            DctlType::Bool => Some(ScalarType::Bool),
            DctlType::Int | DctlType::Char => Some(ScalarType::Int),
            DctlType::UInt => Some(ScalarType::UInt),
            DctlType::Float | DctlType::Double => Some(ScalarType::Float),
            DctlType::Half => Some(ScalarType::Half),
            DctlType::Vec2(s) | DctlType::Vec3(s) | DctlType::Vec4(s) => Some(*s),
            _ => None,
        }
    }

    /// Convert to a display string
    pub fn display_name(&self) -> String {
        match self {
            DctlType::Void => "void".to_string(),
            DctlType::Bool => "bool".to_string(),
            DctlType::Char => "char".to_string(),
            DctlType::Int => "int".to_string(),
            DctlType::UInt => "uint".to_string(),
            DctlType::Float => "float".to_string(),
            DctlType::Double => "double".to_string(),
            DctlType::Half => "half".to_string(),
            DctlType::Vec2(ScalarType::Float) => "float2".to_string(),
            DctlType::Vec3(ScalarType::Float) => "float3".to_string(),
            DctlType::Vec4(ScalarType::Float) => "float4".to_string(),
            DctlType::Vec2(ScalarType::Int) => "int2".to_string(),
            DctlType::Vec3(ScalarType::Int) => "int3".to_string(),
            DctlType::Vec4(ScalarType::Int) => "int4".to_string(),
            DctlType::Vec2(ScalarType::Half) => "half2".to_string(),
            DctlType::Vec3(ScalarType::Half) => "half3".to_string(),
            DctlType::Vec4(ScalarType::Half) => "half4".to_string(),
            DctlType::Vec2(_) => "vec2".to_string(),
            DctlType::Vec3(_) => "vec3".to_string(),
            DctlType::Vec4(_) => "vec4".to_string(),
            DctlType::Mat2 => "float2x2".to_string(),
            DctlType::Mat3 => "float3x3".to_string(),
            DctlType::Mat4 => "float4x4".to_string(),
            DctlType::Array(inner, Some(size)) => format!("{}[{}]", inner.display_name(), size),
            DctlType::Array(inner, None) => format!("{}[]", inner.display_name()),
            DctlType::Struct(name) => name.clone(),
            DctlType::Pointer(inner) => format!("{}*", inner.display_name()),
            DctlType::Function { params, ret } => {
                let params_str: Vec<_> = params.iter().map(|p| p.display_name()).collect();
                format!("({}) -> {}", params_str.join(", "), ret.display_name())
            }
            DctlType::Texture2D => "__TEXTURE2D__".to_string(),
            DctlType::Texture3D => "__TEXTURE3D__".to_string(),
            DctlType::Sampler => "sampler".to_string(),
            DctlType::Unknown => "<unknown>".to_string(),
        }
    }
}

/// Symbol information for the symbol table
#[derive(Debug, Clone)]
pub struct Symbol {
    pub name: String,
    pub symbol_type: DctlType,
    pub kind: SymbolKind,
    pub line: usize,
}

/// Kind of symbol
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Variable,
    Parameter,
    Function,
    Struct,
    Typedef,
    Field,
}

/// Structure definition
#[derive(Debug, Clone)]
pub struct StructDef {
    pub name: String,
    pub fields: Vec<(String, DctlType)>,
}

/// Function definition
#[derive(Debug, Clone)]
pub struct FunctionDef {
    pub name: String,
    pub params: Vec<(String, DctlType)>,
    pub return_type: DctlType,
    pub is_device: bool,
}

/// Symbol table for tracking declarations
#[derive(Debug, Default)]
pub struct SymbolTable {
    /// Stack of scopes (innermost scope is last)
    scopes: Vec<HashMap<String, Symbol>>,
    /// Struct definitions
    pub structs: HashMap<String, StructDef>,
    /// Function definitions (last registered overload for each name)
    pub functions: HashMap<String, FunctionDef>,
    /// All function overloads (for overload resolution)
    pub function_overloads: HashMap<String, Vec<FunctionDef>>,
    /// Typedef aliases
    pub typedefs: HashMap<String, DctlType>,
}

impl SymbolTable {
    pub fn new() -> Self {
        let mut table = Self {
            scopes: vec![HashMap::new()],
            structs: HashMap::new(),
            functions: HashMap::new(),
            function_overloads: HashMap::new(),
            typedefs: HashMap::new(),
        };
        table.register_builtins();
        table
    }

    /// Register built-in functions and types
    fn register_builtins(&mut self) {
        // Register common DCTL built-in functions
        let math_funcs = [
            ("_sinf", DctlType::Float),
            ("_cosf", DctlType::Float),
            ("_tanf", DctlType::Float),
            ("_asinf", DctlType::Float),
            ("_acosf", DctlType::Float),
            ("_atanf", DctlType::Float),
            ("_atan2f", DctlType::Float),
            ("_sqrtf", DctlType::Float),
            ("_powf", DctlType::Float),
            ("_expf", DctlType::Float),
            ("_logf", DctlType::Float),
            ("_log2f", DctlType::Float),
            ("_log10f", DctlType::Float),
            ("_fabsf", DctlType::Float),
            ("_floorf", DctlType::Float),
            ("_ceilf", DctlType::Float),
            ("_roundf", DctlType::Float),
            ("_fminf", DctlType::Float),
            ("_fmaxf", DctlType::Float),
            ("_fmodf", DctlType::Float),
            ("_saturatef", DctlType::Float),
            ("_clampf", DctlType::Float),
            ("_mix", DctlType::Float),
            ("_hypotf", DctlType::Float),
            ("_copysignf", DctlType::Float),
        ];

        for (name, _ret_type) in math_funcs {
            self.functions.insert(
                name.to_string(),
                FunctionDef {
                    name: name.to_string(),
                    params: vec![("x".to_string(), DctlType::Float)],
                    return_type: DctlType::Float,
                    is_device: true,
                },
            );
        }

        // Vector constructors
        let vec_constructors = [
            ("make_float2", DctlType::Vec2(ScalarType::Float)),
            ("make_float3", DctlType::Vec3(ScalarType::Float)),
            ("make_float4", DctlType::Vec4(ScalarType::Float)),
            ("make_int2", DctlType::Vec2(ScalarType::Int)),
            ("make_int3", DctlType::Vec3(ScalarType::Int)),
            ("make_int4", DctlType::Vec4(ScalarType::Int)),
        ];

        for (name, ret_type) in vec_constructors {
            self.functions.insert(
                name.to_string(),
                FunctionDef {
                    name: name.to_string(),
                    params: vec![],
                    return_type: ret_type,
                    is_device: true,
                },
            );
        }
    }

    /// Push a new scope
    pub fn push_scope(&mut self) {
        self.scopes.push(HashMap::new());
    }

    /// Pop the current scope
    pub fn pop_scope(&mut self) {
        if self.scopes.len() > 1 {
            self.scopes.pop();
        }
    }

    /// Define a symbol in the current scope
    pub fn define(&mut self, symbol: Symbol) -> Result<(), String> {
        if let Some(scope) = self.scopes.last_mut() {
            if scope.contains_key(&symbol.name) {
                return Err(format!("Symbol '{}' already defined in this scope", symbol.name));
            }
            scope.insert(symbol.name.clone(), symbol);
            Ok(())
        } else {
            Err("No scope available".to_string())
        }
    }

    /// Look up a symbol by name
    pub fn lookup(&self, name: &str) -> Option<&Symbol> {
        for scope in self.scopes.iter().rev() {
            if let Some(symbol) = scope.get(name) {
                return Some(symbol);
            }
        }
        None
    }

    /// Check if a symbol exists in any scope
    pub fn exists(&self, name: &str) -> bool {
        self.lookup(name).is_some()
    }

    /// Get a function definition
    pub fn get_function(&self, name: &str) -> Option<&FunctionDef> {
        self.functions.get(name)
    }

    /// Get a struct definition
    pub fn get_struct(&self, name: &str) -> Option<&StructDef> {
        self.structs.get(name)
    }

    /// Resolve a typedef
    pub fn resolve_typedef(&self, name: &str) -> Option<&DctlType> {
        self.typedefs.get(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_type_display() {
        assert_eq!(DctlType::Float.display_name(), "float");
        assert_eq!(DctlType::Vec3(ScalarType::Float).display_name(), "float3");
        assert_eq!(DctlType::Mat4.display_name(), "float4x4");
    }

    #[test]
    fn test_symbol_table_scoping() {
        let mut table = SymbolTable::new();

        table
            .define(Symbol {
                name: "x".to_string(),
                symbol_type: DctlType::Float,
                kind: SymbolKind::Variable,
                line: 1,
            })
            .unwrap();

        assert!(table.exists("x"));

        table.push_scope();
        table
            .define(Symbol {
                name: "y".to_string(),
                symbol_type: DctlType::Int,
                kind: SymbolKind::Variable,
                line: 2,
            })
            .unwrap();

        assert!(table.exists("x"));
        assert!(table.exists("y"));

        table.pop_scope();
        assert!(table.exists("x"));
        assert!(!table.exists("y"));
    }
}
