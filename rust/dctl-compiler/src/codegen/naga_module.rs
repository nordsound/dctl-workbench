//! Naga Module Generator
//!
//! Directly constructs Naga IR from DCTL AST, bypassing GLSL/SPIR-V.

use super::CodegenError;
use crate::parser::{DctlModule, Declaration};
use crate::semantic::DctlType;
use indexmap::IndexMap;
use naga::{
    Arena, Constant, Expression as NagaExpr, Function, GlobalVariable, Handle, LocalVariable,
    Module, Span, Statement as NagaStmt, Type as NagaType, TypeInner,
};
use rustc_hash::FxHasher;
use std::collections::{HashMap, HashSet};
use std::hash::BuildHasherDefault;

/// Type alias for Naga's named expressions map
pub(super) type NamedExpressionsMap = IndexMap<Handle<NagaExpr>, String, BuildHasherDefault<FxHasher>>;

/// Context for generating a single function
pub(super) struct FunctionContext {
    /// Local variable name to handle mapping
    pub(super) local_vars: HashMap<String, Handle<LocalVariable>>,
    /// Local variables arena (transferred to function at end)
    pub(super) local_variables: Arena<LocalVariable>,
    /// Parameter indices
    pub(super) param_indices: HashMap<String, u32>,
    /// Pointer parameters (names of params that are pointer types)
    pub(super) pointer_params: HashSet<String>,
    /// Unsized array parameters (names of params that are unsized arrays)
    pub(super) unsized_array_params: HashSet<String>,
    /// Pointer aliases: local pointer variables that alias to another pointer expression
    /// WGSL doesn't allow ptr<function, T> as local variable type, so we track these separately
    /// and substitute the aliased expression when the variable is referenced
    pub(super) pointer_aliases: HashMap<String, Handle<NagaExpr>>,
    /// Multi-dimensional array pointer aliases: (base_array_name, base_offset_expr)
    /// For patterns like `int* ptr = &arr[i][j]` where arr is a flattened 2D array
    /// Stores the base array name and the computed base offset expression
    pub(super) multidim_ptr_aliases: HashMap<String, (String, Handle<NagaExpr>)>,
    /// Variable types (name -> struct type name, if struct)
    pub(super) var_types: HashMap<String, String>,
    /// Full variable type tracking for overload resolution
    pub(super) variable_types: HashMap<String, DctlType>,
    /// Local integer constants (for VLA size resolution)
    pub(super) local_int_constants: HashMap<String, i32>,
    /// Expression arena for the function
    pub(super) expressions: Arena<NagaExpr>,
    /// Named expressions (for debugging)
    pub(super) named_expressions: NamedExpressionsMap,
    /// Pending statements to be emitted (e.g., function calls)
    pub(super) pending_stmts: Vec<(NagaStmt, Span)>,
    /// Return type of the current function (for return coercion)
    pub(super) result_type: Option<DctlType>,
    /// Cache for _tex2D calls: (x_ast_str, y_ast_str) -> call_result
    /// Prevents duplicate dctl_sampleTexture calls with same coordinates
    /// Uses AST-level keys (stringified expressions) to avoid Naga Handle duplication issues
    pub(super) tex2d_cache: HashMap<(String, String), Handle<NagaExpr>>,
}

impl FunctionContext {
    pub(super) fn new() -> Self {
        Self {
            local_vars: HashMap::new(),
            local_variables: Arena::new(),
            param_indices: HashMap::new(),
            pointer_params: HashSet::new(),
            unsized_array_params: HashSet::new(),
            pointer_aliases: HashMap::new(),
            multidim_ptr_aliases: HashMap::new(),
            var_types: HashMap::new(),
            variable_types: HashMap::new(),
            local_int_constants: HashMap::new(),
            expressions: Arena::new(),
            named_expressions: IndexMap::default(),
            pending_stmts: Vec::new(),
            result_type: None,
            tex2d_cache: HashMap::new(),
        }
    }
}

/// Function overload information
#[derive(Debug, Clone)]
pub(super) struct FunctionOverload {
    /// Parameter types for this overload
    pub(super) param_types: Vec<DctlType>,
    /// Return type of this overload
    pub(super) return_type: Option<DctlType>,
    /// The mangled name used in WGSL
    pub(super) mangled_name: String,
    /// Handle to the Naga function
    pub(super) handle: Handle<Function>,
}

/// Naga Module generator
pub struct NagaModuleGenerator {
    /// The Naga module being built
    pub(super) module: Module,
    /// Mapping from DCTL type to Naga type handle
    pub(super) type_handles: HashMap<String, Handle<NagaType>>,
    /// Mapping from global variable names to handles
    pub(super) global_handles: HashMap<String, Handle<GlobalVariable>>,
    /// Mapping from constant names to handles (reserved for future use)
    #[allow(dead_code)]
    pub(super) constant_handles: HashMap<String, Handle<Constant>>,
    /// Mapping from function names to handles (uses mangled names)
    pub(super) function_handles: HashMap<String, Handle<Function>>,
    /// Mapping from struct name to member info (member_name -> index)
    pub(super) struct_members: HashMap<String, HashMap<String, u32>>,
    /// Mapping from struct name to member types (member_name -> type)
    pub(super) struct_member_types: HashMap<String, HashMap<String, DctlType>>,
    /// Function overload registry: original_name -> list of overloads
    pub(super) function_overloads: HashMap<String, Vec<FunctionOverload>>,
    /// Uniform parameter types (from DEFINE_UI_PARAMS)
    pub(super) uniform_param_types: HashMap<String, DctlType>,
    /// Global variable types (for type inference)
    pub(super) global_variable_types: HashMap<String, DctlType>,
    /// Integer constant values for switch case resolution (name -> value)
    pub(super) integer_constants: HashMap<String, i32>,
    /// Struct sizes and alignments (struct_name -> (size, alignment))
    pub(super) struct_sizes: HashMap<String, (u32, u32)>,
    /// Typedef mappings (typedef_name -> underlying type)
    pub(super) typedefs: HashMap<String, DctlType>,
    /// Functions with unsized array parameters: function_handle -> Vec<(param_index, element_type_handle, target_size)>
    /// This is used at call sites to expand smaller arrays to the expected size
    pub(super) unsized_array_param_functions: HashMap<Handle<Function>, Vec<(usize, Handle<NagaType>, u32)>>,
    /// Global array sizes: array_name -> (total_bytes, element_type)
    /// Used for sizeof(array) expressions
    pub(super) global_array_sizes: HashMap<String, (usize, DctlType)>,
    /// Pointer parameter array sizes inferred from call sites: (function_name, param_index) -> array_size
    /// Used to resolve scalar pointer parameters (float*) to ptr<function, array<f32, N>>
    pub(super) pointer_param_array_sizes: HashMap<(String, usize), usize>,
    /// Local array sizes collected during analysis: (function_name, var_name) -> array_size
    pub(super) local_array_sizes: HashMap<(String, String), usize>,
    /// Pointer parameters that use array indexing: (function_name, param_name) -> true
    /// If true, the pointer should be converted to array pointer; if false, keep as scalar pointer
    pub(super) pointer_uses_indexing: HashMap<(String, String), bool>,
    /// Functions that originally returned pointers but were converted to void
    /// Maps function name to the parameter index that was returned (for call-site transformation)
    pub(super) pointer_returning_functions: HashMap<String, Option<usize>>,
    /// Multi-dimensional array dimensions tracking
    /// Maps variable name to original dimensions [outer, inner, ...]
    /// e.g., int arr[M][N] -> arr -> [M, N]
    /// Used to transform arr[i][j] -> arr[i * N + j]
    pub(super) multidim_array_dims: HashMap<String, Vec<usize>>,
}

impl NagaModuleGenerator {
    /// Create a new Naga module generator
    pub fn new() -> Self {
        Self {
            module: Module::default(),
            type_handles: HashMap::new(),
            global_handles: HashMap::new(),
            constant_handles: HashMap::new(),
            function_handles: HashMap::new(),
            struct_members: HashMap::new(),
            struct_member_types: HashMap::new(),
            function_overloads: HashMap::new(),
            uniform_param_types: HashMap::new(),
            global_variable_types: HashMap::new(),
            integer_constants: HashMap::new(),
            struct_sizes: HashMap::new(),
            typedefs: HashMap::new(),
            unsized_array_param_functions: HashMap::new(),
            global_array_sizes: HashMap::new(),
            pointer_param_array_sizes: HashMap::new(),
            local_array_sizes: HashMap::new(),
            pointer_uses_indexing: HashMap::new(),
            pointer_returning_functions: HashMap::new(),
            multidim_array_dims: HashMap::new(),
        }
    }

    /// Sanitize identifier name for WGSL compatibility
    ///
    /// WGSL spec: Identifiers must not start with two or more underscores.
    /// This function converts `__name` to `_name` to comply with the spec.
    pub(super) fn sanitize_identifier_for_wgsl(name: &str) -> String {
        if name.starts_with("__") {
            // Remove one leading underscore: __name -> _name
            name[1..].to_string()
        } else {
            name.to_string()
        }
    }

    /// Generate a Naga module from a DCTL module
    pub fn generate(&mut self, dctl_module: &DctlModule) -> Result<Module, CodegenError> {
        // Register built-in types
        self.register_builtin_types();

        // Pre-pass: collect typedef declarations for type resolution
        for decl in &dctl_module.declarations {
            if let Declaration::Typedef(typedef_decl) = decl {
                let target_type = self.convert_ast_type(&typedef_decl.target_type);
                self.typedefs.insert(typedef_decl.name.clone(), target_type);
            }
        }

        // First pass: collect all struct and function declarations
        for decl in &dctl_module.declarations {
            if let Declaration::Struct(struct_decl) = decl {
                self.generate_struct(struct_decl)?;
            }
        }

        // Second pass: generate global variables
        // Skip variables that have the same name as UI params (they're in the uniform buffer)
        let ui_param_names: HashSet<&str> = dctl_module.ui_params.iter().map(|p| p.name.as_str()).collect();
        for decl in &dctl_module.declarations {
            if let Declaration::Variable(var_decl) = decl {
                // Skip if this variable name matches a UI param
                if ui_param_names.contains(var_decl.name.as_str()) {
                    continue;
                }
                // Check if this is a texture type - skip creating global variable
                // Textures in WGSL cannot be var<private>, they must be bindings
                // We just track the type for _tex2D channel resolution
                let var_type = self.convert_ast_type(&var_decl.var_type);
                if matches!(var_type, DctlType::Texture2D | DctlType::Texture3D | DctlType::Sampler) {
                    // Track as texture type for _tex2D resolution but don't create global var
                    self.global_variable_types.insert(var_decl.name.clone(), var_type);
                    continue;
                }
                self.generate_global_variable(var_decl)?;
            }
        }

        // Generate UI params as uniform buffer
        if !dctl_module.ui_params.is_empty() {
            self.generate_uniform_buffer(dctl_module)?;
        }

        // Pre-pass for pointer parameters: collect local array sizes and infer pointer param sizes from call sites
        self.collect_pointer_param_array_sizes(dctl_module);

        // Third pass: generate functions
        for decl in &dctl_module.declarations {
            if let Declaration::Function(func_decl) = decl {
                self.generate_function(func_decl)?;
            }
        }

        Ok(std::mem::take(&mut self.module))
    }

    /// Check if an expression is loading an int from uniform params (e.g., CheckBox)
    pub(super) fn is_loading_int_uniform(&self, expr: &NagaExpr, ctx: &FunctionContext) -> bool {
        // Check if this is a Load of an AccessIndex into the params struct
        if let NagaExpr::Load { pointer } = expr {
            let pointer_expr = &ctx.expressions[*pointer];
            if let NagaExpr::AccessIndex { base, index } = pointer_expr {
                let base_expr = &ctx.expressions[*base];
                if let NagaExpr::GlobalVariable(global_handle) = base_expr {
                    // Check if this is the params global
                    if let Some(&params_handle) = self.global_handles.get("params") {
                        if *global_handle == params_handle {
                            // Check the type of the accessed member
                            if let Some(&struct_type) = self.type_handles.get("DctlParams") {
                                if let TypeInner::Struct { ref members, .. } =
                                    self.module.types[struct_type].inner
                                {
                                    if let Some(member) = members.get(*index as usize) {
                                        let member_type = &self.module.types[member.ty].inner;
                                        // Check if the member type is i32 (int)
                                        if let TypeInner::Scalar(s) = member_type {
                                            return s.kind == naga::ScalarKind::Sint;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        false
    }

    /// Check if an expression is loading an int from a global variable
    pub(super) fn is_loading_int_global(&self, expr: &NagaExpr, ctx: &FunctionContext) -> bool {
        // Check if this is a Load of a GlobalVariable
        if let NagaExpr::Load { pointer } = expr {
            let pointer_expr = &ctx.expressions[*pointer];
            if let NagaExpr::GlobalVariable(global_handle) = pointer_expr {
                // Check the type of the global variable
                let global_var = &self.module.global_variables[*global_handle];
                if let TypeInner::Scalar(s) = &self.module.types[global_var.ty].inner {
                    return s.kind == naga::ScalarKind::Sint;
                }
            }
        }
        false
    }

    /// Check if an expression needs to be emitted
    pub(super) fn needs_emit(&self, expr: &NagaExpr) -> bool {
        match expr {
            // These are automatically in scope
            NagaExpr::Literal(_) => false,
            NagaExpr::FunctionArgument(_) => false,
            NagaExpr::GlobalVariable(_) => false,
            NagaExpr::LocalVariable(_) => false,
            NagaExpr::Constant(_) => false,
            // CallResult becomes available after Statement::Call, not through Emit
            NagaExpr::CallResult(_) => false,
            // Load can be emitted
            NagaExpr::Load { .. } => true,
            // These need to be emitted
            _ => true,
        }
    }


}

impl Default for NagaModuleGenerator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generator_creation() {
        let generator = NagaModuleGenerator::new();
        assert!(generator.type_handles.is_empty());
    }

    #[test]
    fn test_builtin_types() {
        let mut generator = NagaModuleGenerator::new();
        generator.register_builtin_types();
        assert!(generator.type_handles.contains_key("f32"));
        assert!(generator.type_handles.contains_key("vec3<f32>"));
        assert!(generator.type_handles.contains_key("mat4x4<f32>"));
    }

    #[test]
    fn test_empty_module() {
        let mut generator = NagaModuleGenerator::new();
        let module = DctlModule::default();
        let result = generator.generate(&module);
        assert!(result.is_ok());
    }

    #[test]
    fn test_simple_return_function() {
        use crate::parser::{FunctionDecl, Block, Statement, ReturnStmt, Expression, LiteralExpr, LiteralValue, Location};

        // Create a simple function: float test() { return 1.0; }
        let func = FunctionDecl {
            name: "test".to_string(),
            return_type: crate::parser::Type {
                base: crate::parser::BaseType::Float,
                is_pointer: false,
                is_const: false,
                array_dims: vec![],
            },
            params: vec![],
            body: Some(Block {
                statements: vec![
                    Statement::Return(ReturnStmt {
                        value: Some(Expression::Literal(LiteralExpr {
                            value: LiteralValue::Float(1.0),
                            loc: Location::default(),
                        })),
                        loc: Location::default(),
                    }),
                ],
                loc: Location::default(),
            }),
            modifiers: vec![],
            loc: Location::default(),
        };

        let mut module = DctlModule::default();
        module.declarations.push(Declaration::Function(func));

        let mut generator = NagaModuleGenerator::new();
        let naga_module = generator.generate(&module).expect("Failed to generate naga module");

        // Validate module
        use naga::valid::{Validator, ValidationFlags, Capabilities};
        let validation_result = Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&naga_module);

        assert!(validation_result.is_ok(), "Validation failed: {:?}", validation_result.err());
    }

    #[test]
    fn test_return_parameter() {
        use crate::parser::{FunctionDecl, Parameter, Block, Statement, ReturnStmt, Expression, IdentifierExpr, Location};

        // Create a simple function: float test(float x) { return x; }
        let func = FunctionDecl {
            name: "test".to_string(),
            return_type: crate::parser::Type {
                base: crate::parser::BaseType::Float,
                is_pointer: false,
                is_const: false,
                array_dims: vec![],
            },
            params: vec![
                Parameter {
                    name: "x".to_string(),
                    param_type: crate::parser::Type {
                        base: crate::parser::BaseType::Float,
                        is_pointer: false,
                        is_const: false,
                        array_dims: vec![],
                    },
                    is_const: false,
                    is_pointer: false,
                    modifiers: vec![],
                    loc: Location::default(),
                },
            ],
            body: Some(Block {
                statements: vec![
                    Statement::Return(ReturnStmt {
                        value: Some(Expression::Identifier(IdentifierExpr {
                            name: "x".to_string(),
                            loc: Location::default(),
                        })),
                        loc: Location::default(),
                    }),
                ],
                loc: Location::default(),
            }),
            modifiers: vec![],
            loc: Location::default(),
        };

        let mut module = DctlModule::default();
        module.declarations.push(Declaration::Function(func));

        let mut generator = NagaModuleGenerator::new();
        let naga_module = generator.generate(&module).expect("Failed to generate naga module");

        println!("Module functions: {:?}", naga_module.functions.len());
        for (handle, func) in naga_module.functions.iter() {
            println!("Function {:?}: {:?}", handle, func.name);
            println!("  Arguments: {:?}", func.arguments.len());
            println!("  Expressions: {:?}", func.expressions.len());
            for (eh, expr) in func.expressions.iter() {
                println!("    {:?}: {:?}", eh, expr);
            }
        }

        // Validate module
        use naga::valid::{Validator, ValidationFlags, Capabilities};
        let validation_result = Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&naga_module);

        assert!(validation_result.is_ok(), "Validation failed: {:?}", validation_result.err());
    }

    #[test]
    fn test_make_float3() {
        use crate::parser::{FunctionDecl, Parameter, Block, Statement, ReturnStmt, Expression, CallExpr, IdentifierExpr, Location};

        // Create: float3 test(float x, float y, float z) { return make_float3(x, y, z); }
        let func = FunctionDecl {
            name: "test".to_string(),
            return_type: crate::parser::Type {
                base: crate::parser::BaseType::Float3,
                is_pointer: false,
                is_const: false,
                array_dims: vec![],
            },
            params: vec![
                Parameter {
                    name: "x".to_string(),
                    param_type: crate::parser::Type {
                        base: crate::parser::BaseType::Float,
                        is_pointer: false,
                        is_const: false,
                        array_dims: vec![],
                    },
                    is_const: false,
                    is_pointer: false,
                    modifiers: vec![],
                    loc: Location::default(),
                },
                Parameter {
                    name: "y".to_string(),
                    param_type: crate::parser::Type {
                        base: crate::parser::BaseType::Float,
                        is_pointer: false,
                        is_const: false,
                        array_dims: vec![],
                    },
                    is_const: false,
                    is_pointer: false,
                    modifiers: vec![],
                    loc: Location::default(),
                },
                Parameter {
                    name: "z".to_string(),
                    param_type: crate::parser::Type {
                        base: crate::parser::BaseType::Float,
                        is_pointer: false,
                        is_const: false,
                        array_dims: vec![],
                    },
                    is_const: false,
                    is_pointer: false,
                    modifiers: vec![],
                    loc: Location::default(),
                },
            ],
            body: Some(Block {
                statements: vec![
                    Statement::Return(ReturnStmt {
                        value: Some(Expression::Call(CallExpr {
                            callee: Box::new(Expression::Identifier(IdentifierExpr {
                                name: "make_float3".to_string(),
                                loc: Location::default(),
                            })),
                            args: vec![
                                Expression::Identifier(IdentifierExpr {
                                    name: "x".to_string(),
                                    loc: Location::default(),
                                }),
                                Expression::Identifier(IdentifierExpr {
                                    name: "y".to_string(),
                                    loc: Location::default(),
                                }),
                                Expression::Identifier(IdentifierExpr {
                                    name: "z".to_string(),
                                    loc: Location::default(),
                                }),
                            ],
                            loc: Location::default(),
                        })),
                        loc: Location::default(),
                    }),
                ],
                loc: Location::default(),
            }),
            modifiers: vec![],
            loc: Location::default(),
        };

        let mut module = DctlModule::default();
        module.declarations.push(Declaration::Function(func));

        let mut generator = NagaModuleGenerator::new();
        let naga_module = generator.generate(&module).expect("Failed to generate naga module");

        println!("Module functions: {:?}", naga_module.functions.len());
        for (handle, func) in naga_module.functions.iter() {
            println!("Function {:?}: {:?}", handle, func.name);
            println!("  Arguments: {:?}", func.arguments.len());
            println!("  Expressions: {:?}", func.expressions.len());
            for (eh, expr) in func.expressions.iter() {
                println!("    {:?}: {:?}", eh, expr);
            }
            println!("  Body statements: {:?}", func.body.len());
        }

        // Validate module
        use naga::valid::{Validator, ValidationFlags, Capabilities};
        let validation_result = Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&naga_module);

        assert!(validation_result.is_ok(), "Validation failed: {:?}", validation_result.err());
    }

    #[test]
    fn test_comma_expression() {
        use crate::parser::{
            FunctionDecl, Block, Statement, IfStmt, ExpressionStmt,
            ReturnStmt, Expression, CommaExpr, AssignmentExpr, AssignmentOp,
            IdentifierExpr, CallExpr, BinaryExpr, BinaryOp, LiteralExpr, LiteralValue,
            VariableDecl, Location
        };

        // Create: float3 transform(...) {
        //     float a = 1.0f;
        //     float3 z = make_float3(1.0f, 2.0f, 3.0f);
        //     if (a > 0) a = 2.0f, z = make_float3(3.0f, 4.0f, 5.0f);
        //     return z;
        // }
        let func = FunctionDecl {
            name: "transform".to_string(),
            return_type: crate::parser::Type {
                base: crate::parser::BaseType::Float3,
                is_pointer: false,
                is_const: false,
                array_dims: vec![],
            },
            params: vec![],
            body: Some(Block {
                statements: vec![
                    // float a = 1.0f;
                    Statement::Variable(VariableDecl {
                        name: "a".to_string(),
                        var_type: crate::parser::Type {
                            base: crate::parser::BaseType::Float,
                            is_pointer: false,
                            is_const: false,
                            array_dims: vec![],
                        },
                        initializer: Some(Expression::Literal(LiteralExpr {
                            value: LiteralValue::Float(1.0),
                            loc: Location::default(),
                        })),
                        is_const: false,
                        modifiers: vec![],
                        loc: Location::default(),
                    }),
                    // float3 z = make_float3(1.0f, 2.0f, 3.0f);
                    Statement::Variable(VariableDecl {
                        name: "z".to_string(),
                        var_type: crate::parser::Type {
                            base: crate::parser::BaseType::Float3,
                            is_pointer: false,
                            is_const: false,
                            array_dims: vec![],
                        },
                        initializer: Some(Expression::Call(CallExpr {
                            callee: Box::new(Expression::Identifier(IdentifierExpr {
                                name: "make_float3".to_string(),
                                loc: Location::default(),
                            })),
                            args: vec![
                                Expression::Literal(LiteralExpr {
                                    value: LiteralValue::Float(1.0),
                                    loc: Location::default(),
                                }),
                                Expression::Literal(LiteralExpr {
                                    value: LiteralValue::Float(2.0),
                                    loc: Location::default(),
                                }),
                                Expression::Literal(LiteralExpr {
                                    value: LiteralValue::Float(3.0),
                                    loc: Location::default(),
                                }),
                            ],
                            loc: Location::default(),
                        })),
                        is_const: false,
                        modifiers: vec![],
                        loc: Location::default(),
                    }),
                    // if (a > 0) a = 2.0f, z = make_float3(...);
                    Statement::If(IfStmt {
                        condition: Expression::Binary(BinaryExpr {
                            left: Box::new(Expression::Identifier(IdentifierExpr {
                                name: "a".to_string(),
                                loc: Location::default(),
                            })),
                            op: BinaryOp::Gt,
                            right: Box::new(Expression::Literal(LiteralExpr {
                                value: LiteralValue::Float(0.0),
                                loc: Location::default(),
                            })),
                            loc: Location::default(),
                        }),
                        then_branch: Box::new(Statement::Expression(ExpressionStmt {
                            expression: Expression::Comma(CommaExpr {
                                expressions: vec![
                                    // a = 2.0f
                                    Expression::Assignment(AssignmentExpr {
                                        left: Box::new(Expression::Identifier(IdentifierExpr {
                                            name: "a".to_string(),
                                            loc: Location::default(),
                                        })),
                                        op: AssignmentOp::Assign,
                                        right: Box::new(Expression::Literal(LiteralExpr {
                                            value: LiteralValue::Float(2.0),
                                            loc: Location::default(),
                                        })),
                                        loc: Location::default(),
                                    }),
                                    // z = make_float3(3.0f, 4.0f, 5.0f)
                                    Expression::Assignment(AssignmentExpr {
                                        left: Box::new(Expression::Identifier(IdentifierExpr {
                                            name: "z".to_string(),
                                            loc: Location::default(),
                                        })),
                                        op: AssignmentOp::Assign,
                                        right: Box::new(Expression::Call(CallExpr {
                                            callee: Box::new(Expression::Identifier(IdentifierExpr {
                                                name: "make_float3".to_string(),
                                                loc: Location::default(),
                                            })),
                                            args: vec![
                                                Expression::Literal(LiteralExpr {
                                                    value: LiteralValue::Float(3.0),
                                                    loc: Location::default(),
                                                }),
                                                Expression::Literal(LiteralExpr {
                                                    value: LiteralValue::Float(4.0),
                                                    loc: Location::default(),
                                                }),
                                                Expression::Literal(LiteralExpr {
                                                    value: LiteralValue::Float(5.0),
                                                    loc: Location::default(),
                                                }),
                                            ],
                                            loc: Location::default(),
                                        })),
                                        loc: Location::default(),
                                    }),
                                ],
                                loc: Location::default(),
                            }),
                            loc: Location::default(),
                        })),
                        else_branch: None,
                        loc: Location::default(),
                    }),
                    // return z;
                    Statement::Return(ReturnStmt {
                        value: Some(Expression::Identifier(IdentifierExpr {
                            name: "z".to_string(),
                            loc: Location::default(),
                        })),
                        loc: Location::default(),
                    }),
                ],
                loc: Location::default(),
            }),
            modifiers: vec![],
            loc: Location::default(),
        };

        let mut module = DctlModule::default();
        module.declarations.push(Declaration::Function(func));

        let mut generator = NagaModuleGenerator::new();
        let naga_module = generator.generate(&module).expect("Failed to generate naga module");

        println!("Module functions: {:?}", naga_module.functions.len());
        for (handle, func) in naga_module.functions.iter() {
            println!("Function {:?}: {:?}", handle, func.name);
            println!("  Expressions:");
            for (eh, expr) in func.expressions.iter() {
                println!("    {:?}: {:?}", eh, expr);
            }
        }

        // Validate module
        use naga::valid::{Validator, ValidationFlags, Capabilities};
        let validation_result = Validator::new(ValidationFlags::all(), Capabilities::all())
            .validate(&naga_module);

        assert!(validation_result.is_ok(), "Validation failed: {:?}", validation_result.err());
    }
}
