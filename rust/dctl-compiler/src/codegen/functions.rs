//! Function generation for WGSL code generation
//!
//! Handles generation of Naga functions from DCTL AST functions,
//! including parameter handling, name mangling, and overload resolution.

use super::naga_module::{FunctionContext, FunctionOverload, NagaModuleGenerator};
use super::CodegenError;
use crate::parser::FunctionDecl;
use crate::semantic::DctlType;
use naga::{
    Block as NagaBlock, Expression as NagaExpr, Function, FunctionArgument, FunctionResult,
    Handle, LocalVariable, Span, Statement as NagaStmt,
};

impl NagaModuleGenerator {
    /// Generate a function
    pub(super) fn generate_function(
        &mut self,
        func_decl: &FunctionDecl,
    ) -> Result<Handle<Function>, CodegenError> {
        let mut ctx = FunctionContext::new();
        let mut function = Function::default();

        // Collect parameter types for overload resolution
        let param_types: Vec<DctlType> = func_decl
            .params
            .iter()
            .map(|p| self.convert_parameter_type(p))
            .collect();

        // Generate a mangled name if there's already a function with this name
        let original_name = func_decl.name.clone();
        let mangled_name = self.generate_mangled_name(&original_name, &param_types);
        function.name = Some(mangled_name.clone().into());

        // Track unsized array params for call-site coercion
        let mut unsized_array_params_info: Vec<(usize, Handle<naga::Type>, u32)> = Vec::new();

        // Generate parameters
        for (idx, param) in func_decl.params.iter().enumerate() {
            let original_param_type = self.convert_parameter_type(param);
            let mut param_type = original_param_type.clone();

            // Check if this is a multi-dimensional array parameter and track dimensions
            if param.param_type.array_dims.len() > 1 {
                let mut dims: Vec<usize> = Vec::new();
                let mut all_known = true;
                for dim in &param.param_type.array_dims {
                    match dim {
                        crate::parser::ArrayDim::Fixed(n) => dims.push(*n),
                        crate::parser::ArrayDim::Expression(expr) => {
                            if let Some(v) = self.evaluate_const_int_expression(expr) {
                                dims.push(v as usize);
                            } else {
                                all_known = false;
                                break;
                            }
                        }
                        _ => {
                            all_known = false;
                            break;
                        }
                    }
                }
                if all_known && dims.len() > 1 {
                    // Store dimensions for this parameter
                    self.multidim_array_dims.insert(param.name.clone(), dims);
                }
            }

            // Convert unsized arrays to a default size (256) for function parameters
            // WGSL doesn't support dynamic arrays in function scope
            let is_unsized_array = matches!(&original_param_type, DctlType::Array(_, None));

            if let DctlType::Array(ref inner, None) = original_param_type {
                // Use default size of 256 elements
                param_type = DctlType::Array(inner.clone(), Some(256));
            }

            // Track unsized array params early for proper handling later
            if is_unsized_array {
                ctx.unsized_array_params.insert(param.name.clone());
            }

            // For pointer to scalar parameters (float*, int*, etc.):
            // - If the parameter uses array indexing (ptr[i]), convert to array pointer
            // - If only used for dereferencing (*ptr), keep as scalar pointer
            let final_param_type = if let DctlType::Pointer(ref inner) = param_type {
                if matches!(
                    inner.as_ref(),
                    DctlType::Float
                        | DctlType::Int
                        | DctlType::UInt
                        | DctlType::Bool
                        | DctlType::Double
                        | DctlType::Half
                        | DctlType::Char
                ) {
                    // Check if this pointer parameter uses array indexing
                    let uses_indexing = self
                        .pointer_uses_indexing
                        .get(&(original_name.clone(), param.name.clone()))
                        .copied()
                        .unwrap_or(false);

                    if uses_indexing {
                        // Look up the array size from call site analysis
                        if let Some(&array_size) =
                            self.pointer_param_array_sizes.get(&(original_name.clone(), idx))
                        {
                            // Create a pointer to array with the specific size
                            DctlType::Pointer(Box::new(DctlType::Array(
                                inner.clone(),
                                Some(array_size),
                            )))
                        } else {
                            // Fallback to default size (256) if no call site info available
                            DctlType::Pointer(Box::new(DctlType::Array(inner.clone(), Some(256))))
                        }
                    } else {
                        // Keep as scalar pointer for simple dereference usage
                        param_type.clone()
                    }
                } else {
                    param_type.clone()
                }
            } else {
                param_type.clone()
            };

            let type_handle = self.get_or_create_type(&final_param_type);

            // Track unsized array params with actual type handle for call-site expansion
            if is_unsized_array {
                unsized_array_params_info.push((idx, type_handle, 256));
            }

            // Sanitize parameter name for WGSL compatibility
            let wgsl_param_name = NagaModuleGenerator::sanitize_identifier_for_wgsl(&param.name);

            function.arguments.push(FunctionArgument {
                name: Some(wgsl_param_name.into()),
                ty: type_handle,
                binding: None,
            });

            ctx.param_indices.insert(param.name.clone(), idx as u32);
            // Track variable type for overload resolution (use sized version for pointers)
            ctx.variable_types.insert(param.name.clone(), final_param_type);
        }

        // Generate return type
        let return_type = self.convert_ast_type(&func_decl.return_type);

        // WGSL doesn't allow pointer return types (NonConstructibleReturnType)
        // Convert pointer-returning functions to void and track them
        let is_pointer_return = matches!(return_type, DctlType::Pointer(_));
        if is_pointer_return {
            // Analyze which parameter is being returned (if any)
            // This is used at call sites to substitute the argument
            let returned_param_idx = self.find_returned_parameter(func_decl);
            self.pointer_returning_functions
                .insert(func_decl.name.clone(), returned_param_idx);
        }

        // Store return type in context for return coercion
        // Treat pointer returns as void
        ctx.result_type = if matches!(return_type, DctlType::Void) || is_pointer_return {
            None
        } else {
            Some(return_type.clone())
        };
        if !matches!(return_type, DctlType::Void) && !is_pointer_return {
            let type_handle = self.get_or_create_type(&return_type);
            function.result = Some(FunctionResult {
                ty: type_handle,
                binding: None,
            });
        }

        // Generate function body
        if let Some(body) = &func_decl.body {
            let mut init_block = NagaBlock::new();

            // Create local variable copies of parameters for mutability
            // DCTL allows modifying function parameters, but WGSL doesn't
            for (idx, param) in func_decl.params.iter().enumerate() {
                // Get param type - use the potentially converted type from variable_types
                // (unsized arrays were converted to sized arrays in the first loop)
                let param_type = ctx
                    .variable_types
                    .get(&param.name)
                    .cloned()
                    .unwrap_or_else(|| self.convert_ast_type(&param.param_type));

                // Skip creating copies for textures, samplers (read-only)
                if matches!(
                    param_type,
                    DctlType::Texture2D | DctlType::Texture3D | DctlType::Sampler
                ) {
                    continue;
                }

                // Skip creating copies for pointer parameters
                // WGSL doesn't allow ptr<function, T> as LocalVariable type
                // Pointer parameters are used directly as FunctionArgument
                if matches!(param_type, DctlType::Pointer(_)) {
                    ctx.pointer_params.insert(param.name.clone());
                    // Keep in param_indices for access as FunctionArgument
                    continue;
                }

                // For unsized array parameters, we create a local copy
                // because DCTL code may modify array elements (e.g., in-place sorting)
                // The array type was already converted to a fixed-size array (256 elements)
                // in the first loop.

                let type_handle = self.get_or_create_type(&param_type);

                // Create local variable copy
                // Sanitize parameter name for WGSL compatibility
                let wgsl_param_name = NagaModuleGenerator::sanitize_identifier_for_wgsl(&param.name);

                let local = LocalVariable {
                    name: Some(wgsl_param_name.into()),
                    ty: type_handle,
                    init: None,
                };
                let local_handle = ctx.local_variables.append(local, Span::UNDEFINED);

                // Store parameter value to local variable
                let param_expr = ctx
                    .expressions
                    .append(NagaExpr::FunctionArgument(idx as u32), Span::UNDEFINED);
                let local_ptr = ctx
                    .expressions
                    .append(NagaExpr::LocalVariable(local_handle), Span::UNDEFINED);

                // Store to local copy (FunctionArgument doesn't need Emit)
                init_block.push(
                    NagaStmt::Store {
                        pointer: local_ptr,
                        value: param_expr,
                    },
                    Span::UNDEFINED,
                );

                // Track struct/matrix type for member access resolution
                match &param_type {
                    DctlType::Struct(struct_name) => {
                        ctx.var_types.insert(param.name.clone(), struct_name.clone());
                    }
                    DctlType::Mat2 => {
                        ctx.var_types.insert(param.name.clone(), "mat2".to_string());
                    }
                    DctlType::Mat3 => {
                        ctx.var_types.insert(param.name.clone(), "mat3".to_string());
                    }
                    DctlType::Mat4 => {
                        ctx.var_types.insert(param.name.clone(), "mat4".to_string());
                    }
                    _ => {}
                }

                // Register local copy instead of parameter
                // Remove from param_indices and add to local_vars
                ctx.param_indices.remove(&param.name);
                ctx.local_vars.insert(param.name.clone(), local_handle);
            }

            let body_block = self.generate_block(body, &mut ctx, &mut function)?;

            // Combine init block and body block
            for (stmt, span) in body_block.span_iter() {
                init_block.push(stmt.clone(), *span);
            }
            function.body = init_block;
        } else {
            function.body = NagaBlock::new();
        }

        // Transfer local variables and expressions to function
        function.local_variables = ctx.local_variables;
        function.expressions = ctx.expressions;
        function.named_expressions = ctx.named_expressions;

        let handle = self.module.functions.append(function, Span::UNDEFINED);

        // Store in function_handles with mangled name
        self.function_handles.insert(mangled_name.clone(), handle);

        // Store unsized array param info for call-site coercion
        if !unsized_array_params_info.is_empty() {
            self.unsized_array_param_functions
                .insert(handle, unsized_array_params_info);
        }

        // Register overload information
        let func_return_type = self.convert_ast_type(&func_decl.return_type);
        let overload = FunctionOverload {
            param_types,
            return_type: if matches!(func_return_type, DctlType::Void) {
                None
            } else {
                Some(func_return_type)
            },
            mangled_name,
            handle,
        };
        self.function_overloads
            .entry(original_name)
            .or_insert_with(Vec::new)
            .push(overload);

        Ok(handle)
    }

    /// Find which parameter a pointer-returning function returns (if any)
    /// Returns Some(index) if the function returns one of its parameters, None otherwise
    fn find_returned_parameter(&self, func_decl: &FunctionDecl) -> Option<usize> {
        // Look for return statements in the function body
        if let Some(body) = &func_decl.body {
            for stmt in &body.statements {
                if let crate::parser::Statement::Return(ret_stmt) = stmt {
                    if let Some(expr) = &ret_stmt.value {
                        // Check if the return value is a simple identifier (parameter name)
                        if let crate::parser::Expression::Identifier(ident) = expr {
                            // Find which parameter this corresponds to
                            for (idx, param) in func_decl.params.iter().enumerate() {
                                if param.name == ident.name {
                                    return Some(idx);
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Check if a function name conflicts with WGSL built-in functions
    pub(super) fn is_wgsl_builtin(&self, name: &str) -> bool {
        // WGSL built-in function names that might conflict with user-defined functions
        const WGSL_BUILTINS: &[&str] = &[
            // Scalar/vector math functions
            "abs", "acos", "acosh", "asin", "asinh", "atan", "atanh", "atan2", "ceil", "clamp",
            "cos", "cosh", "cross", "degrees", "determinant", "distance", "dot", "exp", "exp2",
            "faceForward", "floor", "fma", "fract", "frexp", "inverseSqrt", "ldexp", "length",
            "log", "log2", "max", "min", "mix", "modf", "normalize", "pow", "radians", "reflect",
            "refract", "round", "saturate", "sign", "sin", "sinh", "smoothstep", "sqrt", "step",
            "tan", "tanh", "transpose", "trunc",
            // Texture functions
            "textureSample",
            "textureSampleLevel",
            "textureSampleBias",
            "textureSampleGrad",
            "textureSampleCompare",
            "textureLoad",
            "textureStore",
            "textureDimensions",
            "textureNumLayers",
            "textureNumLevels",
            "textureNumSamples",
            // Atomic functions
            "atomicLoad",
            "atomicStore",
            "atomicAdd",
            "atomicSub",
            "atomicMax",
            "atomicMin",
            "atomicAnd",
            "atomicOr",
            "atomicXor",
            "atomicExchange",
            "atomicCompareExchangeWeak",
            // Pack/unpack functions
            "pack4x8snorm",
            "pack4x8unorm",
            "pack2x16snorm",
            "pack2x16unorm",
            "pack2x16float",
            "unpack4x8snorm",
            "unpack4x8unorm",
            "unpack2x16snorm",
            "unpack2x16unorm",
            "unpack2x16float",
            // Derivative functions
            "dpdx",
            "dpdxCoarse",
            "dpdxFine",
            "dpdy",
            "dpdyCoarse",
            "dpdyFine",
            "fwidth",
            // Other
            "all",
            "any",
            "select",
            "arrayLength",
            "countLeadingZeros",
            "countOneBits",
            "countTrailingZeros",
            "extractBits",
            "firstLeadingBit",
            "firstTrailingBit",
            "insertBits",
            "reverseBits",
            "workgroupBarrier",
            "storageBarrier",
            "workgroupUniformLoad",
        ];
        WGSL_BUILTINS.contains(&name)
    }

    /// Generate a mangled name for a function based on its parameter types
    pub(super) fn generate_mangled_name(&self, name: &str, param_types: &[DctlType]) -> String {
        // Check if the name conflicts with WGSL built-in functions
        let base_name = if self.is_wgsl_builtin(name) {
            // Prefix with "dctl_" to avoid conflict with WGSL built-ins
            format!("dctl_{}", name)
        } else {
            name.to_string()
        };

        // Check if there are existing overloads for this function
        if let Some(overloads) = self.function_overloads.get(name) {
            // Check if this exact signature already exists
            for overload in overloads {
                if overload.param_types == param_types {
                    // Same signature exists, return the existing mangled name
                    return overload.mangled_name.clone();
                }
            }
            // Different signature, create a new mangled name
            format!("{}_{}", base_name, overloads.len())
        } else {
            // First function with this name
            base_name
        }
    }

    /// Get the type suffix for a DctlType (used in name mangling, reserved for future use)
    #[allow(dead_code)]
    pub(super) fn type_suffix(&self, ty: &DctlType) -> String {
        match ty {
            DctlType::Void => "v".to_string(),
            DctlType::Bool => "b".to_string(),
            DctlType::Int | DctlType::Char => "i".to_string(),
            DctlType::UInt => "u".to_string(),
            DctlType::Float | DctlType::Double | DctlType::Half => "f".to_string(),
            DctlType::Vec2(_) => "f2".to_string(),
            DctlType::Vec3(_) => "f3".to_string(),
            DctlType::Vec4(_) => "f4".to_string(),
            DctlType::Mat2 => "m2".to_string(),
            DctlType::Mat3 => "m3".to_string(),
            DctlType::Mat4 => "m4".to_string(),
            DctlType::Array(inner, _) => format!("a{}", self.type_suffix(inner)),
            DctlType::Struct(name) => format!("s{}", name),
            DctlType::Pointer(inner) => format!("p{}", self.type_suffix(inner)),
            _ => "x".to_string(),
        }
    }
}
