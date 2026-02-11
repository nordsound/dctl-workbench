//! Function call generation
//!
//! Handles generation of function calls including:
//! - User-defined function calls with overload resolution
//! - Texture sampling calls (_tex2D)
//! - Array argument expansion/truncation
//! - Type coercion for function arguments

use super::naga_module::{FunctionContext, NagaModuleGenerator};
use super::CodegenError;
use crate::parser::Expression;
use crate::semantic::{DctlType, ScalarType};
use naga::{
    AddressSpace, BinaryOperator, Expression as NagaExpr, Function, FunctionArgument,
    FunctionResult, Handle, Literal, LocalVariable, Span, Statement as NagaStmt,
    Type as NagaType, TypeInner,
};

/// Extracted type information for creating zero values
/// This enum allows extracting type info from Naga types without holding a borrow
pub(super) enum ZeroTypeInfo {
    Scalar(naga::ScalarKind),
    Vector {
        size: naga::VectorSize,
        scalar_kind: naga::ScalarKind,
    },
    Matrix {
        columns: naga::VectorSize,
        rows: naga::VectorSize,
        scalar_kind: naga::ScalarKind,
    },
    Struct {
        member_types: Vec<Handle<NagaType>>,
    },
    Default,
}

impl NagaModuleGenerator {
    /// Generate a function call expression
    pub(super) fn generate_call_expression(
        &mut self,
        call: &crate::parser::CallExpr,
        ctx: &mut FunctionContext,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        // Get function name
        let func_name = match call.callee.as_ref() {
            Expression::Identifier(ident) => &ident.name,
            _ => {
                return Err(CodegenError::UnsupportedFeature(
                    "Complex callee expressions not supported".to_string(),
                ));
            }
        };

        // Special handling for _tex2D - needs raw AST args to determine channel
        if func_name == "_tex2D" || func_name == "_tex2DVec4" {
            return self.generate_tex2d_call(call, ctx);
        }

        // OPTIMIZATION: Detect make_float3(_tex2D(...), _tex2D(...), _tex2D(...)) pattern
        // This prevents the cyan cast bug in Film Grain MONO mode
        // IMPORTANT: Check this BEFORE generating arguments!
        if (func_name == "make_float3" || func_name == "float3") && call.args.len() == 3 {
            if let Some(optimized) = self.try_optimize_float3_tex2d_pattern(call, ctx)? {
                return Ok(optimized);
            }
        }

        // Generate arguments
        let args: Result<Vec<_>, _> = call
            .args
            .iter()
            .map(|arg| self.generate_expression(arg, ctx))
            .collect();
        let args = args?;

        // Check for user-defined functions FIRST (before built-ins)
        // This allows users to override built-in functions
        if self.function_overloads.contains_key(func_name) {
            let func_handle = self.resolve_function_call(func_name, &call.args, ctx)?;
            return self.generate_user_function_call(func_handle, args, ctx);
        }

        // Fall back to built-in functions
        if let Some(expr) = self.generate_builtin_call(func_name, &args, call, ctx)? {
            return Ok(expr);
        }

        // Try to resolve as user-defined function (shouldn't reach here normally)
        let func_handle = self.resolve_function_call(func_name, &call.args, ctx)?;

        // Emit any argument expressions that need it before the Call
        for &arg_handle in &args {
            if self.needs_emit(&ctx.expressions[arg_handle]) {
                ctx.pending_stmts.push((
                    NagaStmt::Emit(naga::Range::new_from_bounds(arg_handle, arg_handle)),
                    Span::UNDEFINED,
                ));
            }
        }

        // Check if function returns void
        let returns_void = self.module.functions[func_handle].result.is_none();

        if returns_void {
            // Void function: no result expression
            ctx.pending_stmts.push((
                NagaStmt::Call {
                    function: func_handle,
                    arguments: args.clone(),
                    result: None,
                },
                Span::UNDEFINED,
            ));

            // Return a dummy expression (literal 0) for void functions
            // This should only be used as a statement, not as a value
            return Ok(ctx.expressions.append(
                NagaExpr::Literal(Literal::I32(0)),
                Span::UNDEFINED,
            ));
        }

        // Create a CallResult expression to hold the return value
        let call_result = ctx
            .expressions
            .append(NagaExpr::CallResult(func_handle), Span::UNDEFINED);

        // Push a Statement::Call to pending statements
        // This will be emitted before the expression is used
        ctx.pending_stmts.push((
            NagaStmt::Call {
                function: func_handle,
                arguments: args.clone(),
                result: Some(call_result),
            },
            Span::UNDEFINED,
        ));

        Ok(call_result)
    }

    /// Resolve function call with overload resolution
    pub(super) fn resolve_function_call(
        &self,
        func_name: &str,
        args: &[Expression],
        ctx: &FunctionContext,
    ) -> Result<Handle<Function>, CodegenError> {
        // Check if there are overloads for this function
        if let Some(overloads) = self.function_overloads.get(func_name) {
            // Infer argument types
            let arg_types: Vec<Option<DctlType>> = args
                .iter()
                .map(|arg| self.infer_expression_type(arg, ctx))
                .collect();

            // Score each overload: higher is better
            // Score = (num_exact_matches * 2) + num_convertible_matches - (num_unknown * 10 if has mismatch)
            let mut best_overload: Option<(Handle<Function>, i32)> = None;

            for overload in overloads {
                if overload.param_types.len() != arg_types.len() {
                    continue;
                }

                let mut score = 0i32;
                let mut has_mismatch = false;

                for (i, param_type) in overload.param_types.iter().enumerate() {
                    if let Some(arg_type) = &arg_types[i] {
                        if self.types_compatible(param_type, arg_type) {
                            // Exact match
                            score += 10;
                        } else if self.types_convertible(arg_type, param_type) {
                            // Convertible match
                            score += 5;
                        } else {
                            // Definite mismatch
                            has_mismatch = true;
                            break;
                        }
                    } else {
                        // Unknown type - penalize but don't disqualify
                        score -= 1;
                    }
                }

                // Skip if there's a definite type mismatch
                if has_mismatch {
                    continue;
                }

                // Update best if this is better
                if let Some((_, best_score)) = best_overload {
                    if score > best_score {
                        best_overload = Some((overload.handle, score));
                    }
                } else {
                    best_overload = Some((overload.handle, score));
                }
            }

            if let Some((handle, _)) = best_overload {
                return Ok(handle);
            }

            // If still no match, return first overload with matching arg count
            for overload in overloads {
                if overload.param_types.len() == args.len() {
                    return Ok(overload.handle);
                }
            }
        }

        // Fall back to direct lookup (for non-overloaded functions)
        if let Some(&func_handle) = self.function_handles.get(func_name) {
            return Ok(func_handle);
        }

        Err(CodegenError::Internal(format!(
            "Unknown function: {}",
            func_name
        )))
    }

    /// Check if two types are compatible (exact match or equivalent)
    pub(super) fn types_compatible(&self, param_type: &DctlType, arg_type: &DctlType) -> bool {
        match (param_type, arg_type) {
            // Exact matches
            (DctlType::Float, DctlType::Float) => true,
            (DctlType::Double, DctlType::Double) => true,
            (DctlType::Half, DctlType::Half) => true,
            (DctlType::Int, DctlType::Int) => true,
            (DctlType::UInt, DctlType::UInt) => true,
            (DctlType::Bool, DctlType::Bool) => true,

            // Vector types with same scalar type
            (DctlType::Vec2(s1), DctlType::Vec2(s2)) => s1 == s2,
            (DctlType::Vec3(s1), DctlType::Vec3(s2)) => s1 == s2,
            (DctlType::Vec4(s1), DctlType::Vec4(s2)) => s1 == s2,

            // Matrix types
            (DctlType::Mat2, DctlType::Mat2) => true,
            (DctlType::Mat3, DctlType::Mat3) => true,
            (DctlType::Mat4, DctlType::Mat4) => true,

            // Pointer types
            (DctlType::Pointer(p1), DctlType::Pointer(p2)) => self.types_compatible(p1, p2),

            // Struct types
            (DctlType::Struct(n1), DctlType::Struct(n2)) => n1 == n2,

            // Array types
            (DctlType::Array(t1, s1), DctlType::Array(t2, s2)) => {
                s1 == s2 && self.types_compatible(t1, t2)
            }

            _ => false,
        }
    }

    /// Check if arg_type can be implicitly converted to param_type
    pub(super) fn types_convertible(&self, arg_type: &DctlType, param_type: &DctlType) -> bool {
        // First check if they're compatible
        if self.types_compatible(param_type, arg_type) {
            return true;
        }

        // Implicit conversions
        match (arg_type, param_type) {
            // Int can be converted to float
            (DctlType::Int, DctlType::Float) => true,
            (DctlType::Int, DctlType::Double) => true,

            // Float literals are typed as Float, can match Half
            (DctlType::Float, DctlType::Half) => true,
            (DctlType::Float, DctlType::Double) => true,

            // Array with smaller size can be converted to array with larger size
            // This is used for unsized array parameters where we need to expand the array
            (DctlType::Array(t1, Some(s1)), DctlType::Array(t2, Some(s2))) => {
                *s1 <= *s2 && self.types_compatible(t1, t2)
            }

            // Sized array can be converted to unsized array parameter
            (DctlType::Array(t1, Some(_)), DctlType::Array(t2, None)) => {
                self.types_compatible(t1, t2)
            }

            _ => false,
        }
    }

    /// Generate a call to a user-defined function
    pub(super) fn generate_user_function_call(
        &mut self,
        func_handle: Handle<Function>,
        args: Vec<Handle<NagaExpr>>,
        ctx: &mut FunctionContext,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        // Get the function's parameter types for coercion
        let func = &self.module.functions[func_handle];
        let func_name = func.name.clone().unwrap_or_default();
        let param_types: Vec<_> = func.arguments.iter().map(|a| a.ty).collect();

        // Handle array size coercion for unsized array parameters
        // Clone the unsized_array_param_functions info to avoid borrow checker issues
        let unsized_params: Vec<(usize, Handle<NagaType>, u32)> = self
            .unsized_array_param_functions
            .get(&func_handle)
            .cloned()
            .unwrap_or_default();

        // Note: unsized_params being empty is normal for most functions
        // Only functions with unsized array parameters will have entries

        let mut array_expanded_args = args.clone();
        for (param_idx, elem_type_handle, target_size) in &unsized_params {
            if *param_idx < args.len() {
                let arg_handle = args[*param_idx];
                let arg_expr = &ctx.expressions[arg_handle];

                // Try to determine the source array size from the expression
                // We need to get the type of the argument
                if let Some(source_size) = self.get_array_source_size(arg_expr, ctx) {
                    if source_size < *target_size {
                        // Create expanded array
                        let expanded = self.expand_array_argument(
                            arg_handle,
                            *elem_type_handle,
                            source_size,
                            *target_size,
                            ctx,
                        )?;
                        array_expanded_args[*param_idx] = expanded;
                    }
                } else {
                    // Cannot determine array size - skip expansion/coercion for this param
                    // This can happen with arrays declared with constant expressions (e.g., float arr[N*M])
                    // where the size is not evaluated at AST level
                    // Just pass the argument as-is - Naga validator will check type compatibility
                }
            }
        }

        // Coerce arguments to match parameter types
        let mut coerced_args = Vec::with_capacity(array_expanded_args.len());
        for (i, &arg_handle) in array_expanded_args.iter().enumerate() {
            if i < param_types.len() {
                let param_type = param_types[i];
                let param_type_inner = &self.module.types[param_type].inner;

                // Check if param is a pointer type and arg is a loaded local array
                // This handles array-to-pointer decay in C/DCTL:
                // When passing a local array to a pointer parameter, we need to pass the address
                if let TypeInner::Pointer {
                    base: _ptr_base,
                    space: AddressSpace::Function,
                } = param_type_inner
                {
                    let arg_expr = &ctx.expressions[arg_handle];
                    // If arg is Load(LocalVariable(...)), use the LocalVariable directly
                    if let NagaExpr::Load { pointer } = arg_expr {
                        let pointer_expr = &ctx.expressions[*pointer];
                        if matches!(pointer_expr, NagaExpr::LocalVariable(_)) {
                            // The argument is a loaded local variable, and param expects a pointer
                            // Use the pointer directly instead of the loaded value
                            coerced_args.push(*pointer);
                            continue;
                        }
                    }
                    // Handle pointer to global array element: &GLOBAL_ARRAY[0]
                    // WGSL doesn't allow ptr<private, T> to be passed as ptr<function, T>
                    // So we need to create a local array, copy element by element, and pass that
                    if let NagaExpr::Access { base, index: _ } = arg_expr {
                        let base_expr = &ctx.expressions[*base];
                        if let NagaExpr::GlobalVariable(global_handle) = base_expr {
                            // Copy handle value to avoid borrow conflict
                            let global_handle = *global_handle;
                            // Get the global variable info
                            let global_ty = self.module.global_variables[global_handle].ty;
                            let global_type = self.module.types[global_ty].inner.clone();
                            if let TypeInner::Array {
                                base: _elem_ty,
                                size,
                                ..
                            } = global_type
                            {
                                // Create a local variable (uninitialized)
                                let local_name = format!("_global_copy_{}", ctx.local_vars.len());
                                let local = LocalVariable {
                                    name: Some(local_name.clone().into()),
                                    ty: global_ty,
                                    init: None,
                                };
                                let local_handle =
                                    ctx.local_variables.append(local, Span::UNDEFINED);
                                ctx.local_vars.insert(local_name.clone(), local_handle);

                                // Get array size
                                let array_len = match size {
                                    naga::ArraySize::Constant(n) => n.get() as usize,
                                    _ => 0,
                                };

                                // Get pointer to global array
                                let global_ptr = ctx.expressions.append(
                                    NagaExpr::GlobalVariable(global_handle),
                                    Span::UNDEFINED,
                                );

                                // Get pointer to local array
                                let local_ptr = ctx.expressions.append(
                                    NagaExpr::LocalVariable(local_handle),
                                    Span::UNDEFINED,
                                );

                                // Copy each element from global to local
                                for i in 0..array_len {
                                    let global_elem = ctx.expressions.append(
                                        NagaExpr::AccessIndex {
                                            base: global_ptr,
                                            index: i as u32,
                                        },
                                        Span::UNDEFINED,
                                    );
                                    let elem_value = ctx.expressions.append(
                                        NagaExpr::Load {
                                            pointer: global_elem,
                                        },
                                        Span::UNDEFINED,
                                    );
                                    ctx.pending_stmts.push((
                                        NagaStmt::Emit(naga::Range::new_from_bounds(
                                            elem_value, elem_value,
                                        )),
                                        Span::UNDEFINED,
                                    ));
                                    let local_elem = ctx.expressions.append(
                                        NagaExpr::AccessIndex {
                                            base: local_ptr,
                                            index: i as u32,
                                        },
                                        Span::UNDEFINED,
                                    );
                                    ctx.pending_stmts.push((
                                        NagaStmt::Store {
                                            pointer: local_elem,
                                            value: elem_value,
                                        },
                                        Span::UNDEFINED,
                                    ));
                                }

                                // Pass pointer to local variable as the argument
                                coerced_args.push(local_ptr);
                                continue;
                            }
                        }
                    }
                    // Also check for AccessIndex pattern (when index is a constant)
                    if let NagaExpr::AccessIndex { base, index: _ } = arg_expr {
                        let base_expr = &ctx.expressions[*base];
                        if let NagaExpr::GlobalVariable(global_handle) = base_expr {
                            // Copy handle value to avoid borrow conflict
                            let global_handle = *global_handle;
                            // Get the global variable info
                            let global_ty = self.module.global_variables[global_handle].ty;
                            let global_type = self.module.types[global_ty].inner.clone();
                            if let TypeInner::Array {
                                base: _elem_ty,
                                size,
                                ..
                            } = global_type
                            {
                                // Create a local variable (uninitialized)
                                let local_name = format!("_global_copy_{}", ctx.local_vars.len());
                                let local = LocalVariable {
                                    name: Some(local_name.clone().into()),
                                    ty: global_ty,
                                    init: None,
                                };
                                let local_handle =
                                    ctx.local_variables.append(local, Span::UNDEFINED);
                                ctx.local_vars.insert(local_name.clone(), local_handle);

                                // Copy elements from global to local
                                let local_ptr = ctx.expressions.append(
                                    NagaExpr::LocalVariable(local_handle),
                                    Span::UNDEFINED,
                                );
                                let global_ptr = ctx.expressions.append(
                                    NagaExpr::GlobalVariable(global_handle),
                                    Span::UNDEFINED,
                                );

                                // Get array size
                                let array_len = match size {
                                    naga::ArraySize::Constant(n) => n.get() as usize,
                                    _ => 0,
                                };

                                // Copy each element
                                for i in 0..array_len {
                                    // Get pointer to global element
                                    let global_elem = ctx.expressions.append(
                                        NagaExpr::AccessIndex {
                                            base: global_ptr,
                                            index: i as u32,
                                        },
                                        Span::UNDEFINED,
                                    );
                                    // Load the element value
                                    let elem_value = ctx.expressions.append(
                                        NagaExpr::Load {
                                            pointer: global_elem,
                                        },
                                        Span::UNDEFINED,
                                    );
                                    ctx.pending_stmts.push((
                                        NagaStmt::Emit(naga::Range::new_from_bounds(
                                            elem_value, elem_value,
                                        )),
                                        Span::UNDEFINED,
                                    ));
                                    // Get pointer to local element
                                    let local_elem = ctx.expressions.append(
                                        NagaExpr::AccessIndex {
                                            base: local_ptr,
                                            index: i as u32,
                                        },
                                        Span::UNDEFINED,
                                    );
                                    // Store to local element
                                    ctx.pending_stmts.push((
                                        NagaStmt::Store {
                                            pointer: local_elem,
                                            value: elem_value,
                                        },
                                        Span::UNDEFINED,
                                    ));
                                }

                                // Pass pointer to local variable as the argument
                                coerced_args.push(local_ptr);
                                continue;
                            }
                        }
                    }
                    // Handle &local_arr[0] pattern - pass pointer to local array directly
                    // When passing address of first element of a local array to array pointer param,
                    // we can just pass the pointer to the whole local array
                    // IMPORTANT: Only do this if the local variable is actually an array type!
                    if let NagaExpr::Access { base, index: _ } = arg_expr {
                        let base_expr = &ctx.expressions[*base];
                        if let NagaExpr::LocalVariable(local_handle) = base_expr {
                            // Check if local variable's type is an array
                            let local_ty = ctx.local_variables[*local_handle].ty;
                            if matches!(self.module.types[local_ty].inner, TypeInner::Array { .. })
                            {
                                // Pass pointer to local array directly
                                coerced_args.push(*base);
                                continue;
                            }
                        }
                    }
                    if let NagaExpr::AccessIndex { base, index: _ } = arg_expr {
                        let base_expr = &ctx.expressions[*base];
                        if let NagaExpr::LocalVariable(local_handle) = base_expr {
                            // Check if local variable's type is an array
                            let local_ty = ctx.local_variables[*local_handle].ty;
                            if matches!(self.module.types[local_ty].inner, TypeInner::Array { .. })
                            {
                                // Pass pointer to local array directly
                                coerced_args.push(*base);
                                continue;
                            }
                        }
                    }
                    // Handle direct global array passing: sum_array(NORM)
                    // The global array reference is Load { pointer: GlobalVariable(handle) }
                    // Create local copy and pass pointer to that
                    let global_handle_opt = if let NagaExpr::GlobalVariable(global_handle) =
                        arg_expr
                    {
                        Some(*global_handle)
                    } else if let NagaExpr::Load { pointer } = arg_expr {
                        // Check if it's loading from a global variable
                        let ptr_expr = &ctx.expressions[*pointer];
                        if let NagaExpr::GlobalVariable(global_handle) = ptr_expr {
                            Some(*global_handle)
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    if let Some(global_handle) = global_handle_opt {
                        let global_ty = self.module.global_variables[global_handle].ty;
                        let global_type = self.module.types[global_ty].inner.clone();
                        if let TypeInner::Array {
                            base: _elem_ty,
                            size,
                            ..
                        } = global_type
                        {
                            // Create a local variable (uninitialized)
                            let local_name = format!("_global_copy_{}", ctx.local_vars.len());
                            let local = LocalVariable {
                                name: Some(local_name.clone().into()),
                                ty: global_ty,
                                init: None,
                            };
                            let local_handle = ctx.local_variables.append(local, Span::UNDEFINED);
                            ctx.local_vars.insert(local_name.clone(), local_handle);

                            // Get array size
                            let array_len = match size {
                                naga::ArraySize::Constant(n) => n.get() as usize,
                                _ => 0,
                            };

                            // Get pointers to global and local arrays
                            let global_ptr = ctx.expressions.append(
                                NagaExpr::GlobalVariable(global_handle),
                                Span::UNDEFINED,
                            );
                            let local_ptr = ctx.expressions.append(
                                NagaExpr::LocalVariable(local_handle),
                                Span::UNDEFINED,
                            );

                            // Copy each element from global to local
                            for i in 0..array_len {
                                let global_elem = ctx.expressions.append(
                                    NagaExpr::AccessIndex {
                                        base: global_ptr,
                                        index: i as u32,
                                    },
                                    Span::UNDEFINED,
                                );
                                let elem_value = ctx.expressions.append(
                                    NagaExpr::Load {
                                        pointer: global_elem,
                                    },
                                    Span::UNDEFINED,
                                );
                                ctx.pending_stmts.push((
                                    NagaStmt::Emit(naga::Range::new_from_bounds(
                                        elem_value, elem_value,
                                    )),
                                    Span::UNDEFINED,
                                ));
                                let local_elem = ctx.expressions.append(
                                    NagaExpr::AccessIndex {
                                        base: local_ptr,
                                        index: i as u32,
                                    },
                                    Span::UNDEFINED,
                                );
                                ctx.pending_stmts.push((
                                    NagaStmt::Store {
                                        pointer: local_elem,
                                        value: elem_value,
                                    },
                                    Span::UNDEFINED,
                                ));
                            }

                            // Pass pointer to local variable as the argument
                            coerced_args.push(local_ptr);
                            continue;
                        }
                    }
                    // Also handle case where argument is a Compose (array literal)
                    // We need to store it in a local variable and take its address
                    if let NagaExpr::Compose { .. } = arg_expr {
                        // This case is more complex - for now, just pass the value
                        // (may cause type error but handles most common cases)
                        coerced_args.push(arg_handle);
                        continue;
                    }
                }

                // Check if arg is int and param is float - need coercion
                let arg_expr = &ctx.expressions[arg_handle];

                // Check for negated int literal (e.g., -3)
                let is_negated_int_literal = match arg_expr {
                    NagaExpr::Unary {
                        op: naga::UnaryOperator::Negate,
                        expr: inner,
                    } => {
                        matches!(
                            &ctx.expressions[*inner],
                            NagaExpr::Literal(Literal::I32(_))
                                | NagaExpr::Literal(Literal::U32(_))
                        )
                    }
                    _ => false,
                };

                let needs_float_coercion = match (arg_expr, param_type_inner) {
                    // Literal i32 to f32
                    (NagaExpr::Literal(Literal::I32(_)), TypeInner::Scalar(s))
                        if s.kind == naga::ScalarKind::Float =>
                    {
                        true
                    }
                    // Load/FunctionArgument/AccessIndex/Binary that might be int, param is float
                    (
                        NagaExpr::Load { .. }
                        | NagaExpr::FunctionArgument(_)
                        | NagaExpr::AccessIndex { .. }
                        | NagaExpr::Binary { .. },
                        TypeInner::Scalar(s),
                    ) if s.kind == naga::ScalarKind::Float => true,
                    // Negated int literal: -3 should become f32(-3)
                    (
                        NagaExpr::Unary {
                            op: naga::UnaryOperator::Negate,
                            ..
                        },
                        TypeInner::Scalar(s),
                    ) if s.kind == naga::ScalarKind::Float && is_negated_int_literal => true,
                    _ => false,
                };

                // Check if arg is float and param is int - need coercion
                let needs_int_coercion = match (arg_expr, param_type_inner) {
                    // Literal f32 to i32
                    (NagaExpr::Literal(Literal::F32(_)), TypeInner::Scalar(s))
                        if s.kind == naga::ScalarKind::Sint =>
                    {
                        true
                    }
                    // Load/FunctionArgument/Binary/Math/AccessIndex that might be float, param is int
                    (
                        NagaExpr::Load { .. }
                        | NagaExpr::FunctionArgument(_)
                        | NagaExpr::Binary { .. }
                        | NagaExpr::Math { .. }
                        | NagaExpr::As { .. }
                        | NagaExpr::AccessIndex { .. },
                        TypeInner::Scalar(s),
                    ) if s.kind == naga::ScalarKind::Sint => true,
                    _ => false,
                };

                // Check if arg is int and param is bool - need coercion (int != 0)
                // But EXCLUDE expressions that are already bool (comparisons, logical ops, bool literals)
                let arg_is_bool = matches!(
                    arg_expr,
                    NagaExpr::Unary {
                        op: naga::UnaryOperator::LogicalNot,
                        ..
                    } | NagaExpr::Binary {
                        op: BinaryOperator::Equal
                            | BinaryOperator::NotEqual
                            | BinaryOperator::Less
                            | BinaryOperator::LessEqual
                            | BinaryOperator::Greater
                            | BinaryOperator::GreaterEqual
                            | BinaryOperator::LogicalAnd
                            | BinaryOperator::LogicalOr,
                        ..
                    } | NagaExpr::Literal(Literal::Bool(_))
                );
                let needs_bool_coercion = match param_type_inner {
                    TypeInner::Scalar(s) if s.kind == naga::ScalarKind::Bool => {
                        // Check if arg might be int, but NOT if it's already a bool expression
                        // For uniform params (CheckBox), values are stored as i32 and need coercion
                        // Also check global variables (when preprocessor is used, CheckBox becomes int global)
                        // Be careful to only coerce known int expressions, not bool loads
                        !arg_is_bool
                            && (matches!(arg_expr, NagaExpr::Literal(Literal::I32(_)))
                                || self.is_loading_int_uniform(arg_expr, ctx)
                                || self.is_loading_int_global(arg_expr, ctx))
                    }
                    _ => false,
                };

                // Check if arg is bool and param is int - need coercion (bool ? 1 : 0)
                let needs_bool_to_int_coercion = match param_type_inner {
                    TypeInner::Scalar(s) if s.kind == naga::ScalarKind::Sint => {
                        // Check if arg is likely bool (from Unary Not, Binary comparison, or bool literal)
                        matches!(
                            arg_expr,
                            NagaExpr::Unary {
                                op: naga::UnaryOperator::LogicalNot,
                                ..
                            } | NagaExpr::Binary {
                                op: BinaryOperator::Equal
                                    | BinaryOperator::NotEqual
                                    | BinaryOperator::Less
                                    | BinaryOperator::LessEqual
                                    | BinaryOperator::Greater
                                    | BinaryOperator::GreaterEqual
                                    | BinaryOperator::LogicalAnd
                                    | BinaryOperator::LogicalOr,
                                ..
                            } | NagaExpr::Literal(Literal::Bool(_))
                        )
                    }
                    _ => false,
                };

                if needs_int_coercion {
                    // Create i32 cast
                    let cast_expr = ctx.expressions.append(
                        NagaExpr::As {
                            expr: arg_handle,
                            kind: naga::ScalarKind::Sint,
                            convert: Some(4), // i32 width
                        },
                        Span::UNDEFINED,
                    );
                    coerced_args.push(cast_expr);
                } else if needs_bool_coercion {
                    // Convert int to bool: int != 0
                    let zero = ctx
                        .expressions
                        .append(NagaExpr::Literal(Literal::I32(0)), Span::UNDEFINED);
                    let bool_expr = ctx.expressions.append(
                        NagaExpr::Binary {
                            op: BinaryOperator::NotEqual,
                            left: arg_handle,
                            right: zero,
                        },
                        Span::UNDEFINED,
                    );
                    coerced_args.push(bool_expr);
                } else if needs_bool_to_int_coercion {
                    // Convert bool to int: select(0, 1, bool_value)
                    let zero = ctx
                        .expressions
                        .append(NagaExpr::Literal(Literal::I32(0)), Span::UNDEFINED);
                    let one = ctx
                        .expressions
                        .append(NagaExpr::Literal(Literal::I32(1)), Span::UNDEFINED);
                    let int_expr = ctx.expressions.append(
                        NagaExpr::Select {
                            condition: arg_handle,
                            accept: one,
                            reject: zero,
                        },
                        Span::UNDEFINED,
                    );
                    coerced_args.push(int_expr);
                } else if needs_float_coercion {
                    // Create f32 cast
                    let cast_expr = ctx.expressions.append(
                        NagaExpr::As {
                            expr: arg_handle,
                            kind: naga::ScalarKind::Float,
                            convert: Some(4), // f32 width
                        },
                        Span::UNDEFINED,
                    );
                    coerced_args.push(cast_expr);
                } else if let TypeInner::Array {
                    base: param_elem_ty,
                    size: naga::ArraySize::Constant(param_size),
                    ..
                } = param_type_inner
                {
                    // Check if argument is also an array with different size - need truncation/expansion
                    let arg_array_size = self.get_expression_array_size(arg_handle, ctx);
                    if let Some(arg_size) = arg_array_size {
                        let target_size = param_size.get();
                        if arg_size > target_size {
                            // Source array is larger than target - need to truncate
                            // Create a new array with only the first target_size elements
                            let truncated = self.truncate_array_argument(
                                arg_handle,
                                param_type,
                                *param_elem_ty,
                                arg_size,
                                target_size,
                                ctx,
                            )?;
                            coerced_args.push(truncated);
                        } else if arg_size < target_size {
                            // Source array is smaller than target - need to expand
                            // This is similar to expand_array_argument but for sized arrays
                            let expanded = self.expand_array_argument(
                                arg_handle,
                                param_type,
                                arg_size,
                                target_size,
                                ctx,
                            )?;
                            coerced_args.push(expanded);
                        } else {
                            coerced_args.push(arg_handle);
                        }
                    } else {
                        coerced_args.push(arg_handle);
                    }
                } else {
                    coerced_args.push(arg_handle);
                }
            } else {
                coerced_args.push(arg_handle);
            }
        }

        // Emit any argument expressions that need it before the Call
        for &arg_handle in &coerced_args {
            if self.needs_emit(&ctx.expressions[arg_handle]) {
                ctx.pending_stmts.push((
                    NagaStmt::Emit(naga::Range::new_from_bounds(arg_handle, arg_handle)),
                    Span::UNDEFINED,
                ));
            }
        }
        let args = coerced_args;

        // Check if function returns void
        let returns_void = self.module.functions[func_handle].result.is_none();

        // Check if this was a pointer-returning function converted to void
        let returned_param_idx = if returns_void {
            self.pointer_returning_functions
                .get(&func_name)
                .copied()
                .flatten()
        } else {
            None
        };

        if returns_void {
            // Void function: no result expression
            ctx.pending_stmts.push((
                NagaStmt::Call {
                    function: func_handle,
                    arguments: args.clone(),
                    result: None,
                },
                Span::UNDEFINED,
            ));

            // For pointer-returning functions converted to void,
            // create a fresh expression that references the same underlying variable
            // (can't reuse the argument expression since it's already been used in the call)
            if let Some(ret_idx) = returned_param_idx {
                if ret_idx < args.len() {
                    let arg_expr = &ctx.expressions[args[ret_idx]];
                    // Create a fresh reference to the underlying variable
                    let fresh_expr = match arg_expr {
                        NagaExpr::LocalVariable(local_handle) => {
                            // Create a fresh LocalVariable expression
                            ctx.expressions
                                .append(NagaExpr::LocalVariable(*local_handle), Span::UNDEFINED)
                        }
                        NagaExpr::FunctionArgument(idx) => {
                            // Create a fresh FunctionArgument expression
                            ctx.expressions
                                .append(NagaExpr::FunctionArgument(*idx), Span::UNDEFINED)
                        }
                        NagaExpr::GlobalVariable(global_handle) => {
                            // Create a fresh GlobalVariable expression
                            ctx.expressions
                                .append(NagaExpr::GlobalVariable(*global_handle), Span::UNDEFINED)
                        }
                        _ => {
                            // For other expression types, return dummy value
                            // (these patterns are uncommon for pointer returns)
                            ctx.expressions
                                .append(NagaExpr::Literal(Literal::I32(0)), Span::UNDEFINED)
                        }
                    };
                    return Ok(fresh_expr);
                }
            }

            // Return a dummy expression (literal 0) for void functions
            // This should only be used as a statement, not as a value
            return Ok(ctx
                .expressions
                .append(NagaExpr::Literal(Literal::I32(0)), Span::UNDEFINED));
        }

        // Create a CallResult expression to hold the return value
        let call_result = ctx
            .expressions
            .append(NagaExpr::CallResult(func_handle), Span::UNDEFINED);

        // Push a Statement::Call to pending statements
        ctx.pending_stmts.push((
            NagaStmt::Call {
                function: func_handle,
                arguments: args,
                result: Some(call_result),
            },
            Span::UNDEFINED,
        ));

        Ok(call_result)
    }

    /// Optimize make_float3(_tex2D(...), _tex2D(...), _tex2D(...)) pattern
    /// This prevents the cyan cast bug in Film Grain MONO mode by ensuring
    /// all three channels come from the same texture sample result
    fn try_optimize_float3_tex2d_pattern(
        &mut self,
        call: &crate::parser::CallExpr,
        ctx: &mut FunctionContext,
    ) -> Result<Option<Handle<NagaExpr>>, CodegenError> {
        // Check if all 3 arguments are _tex2D calls
        let mut tex2d_calls = Vec::new();
        for arg in &call.args {
            if let Expression::Call(inner_call) = arg {
                if let Expression::Identifier(ident) = inner_call.callee.as_ref() {
                    if ident.name == "_tex2D" && inner_call.args.len() >= 3 {
                        tex2d_calls.push(inner_call);
                    } else {
                        return Ok(None); // Not a _tex2D call
                    }
                } else {
                    return Ok(None);
                }
            } else {
                return Ok(None); // Not a call expression
            }
        }

        if tex2d_calls.len() != 3 {
            return Ok(None);
        }

        // Check if all three _tex2D calls have the same x, y coordinates
        let x0_key = self.ast_expr_to_cache_key(&tex2d_calls[0].args[1]);
        let y0_key = self.ast_expr_to_cache_key(&tex2d_calls[0].args[2]);

        for i in 1..3 {
            let xi_key = self.ast_expr_to_cache_key(&tex2d_calls[i].args[1]);
            let yi_key = self.ast_expr_to_cache_key(&tex2d_calls[i].args[2]);

            if xi_key != x0_key || yi_key != y0_key {
                return Ok(None); // Different coordinates - can't optimize
            }
        }

        // All three _tex2D calls have identical coordinates!
        // Generate a single dctl_sampleTexture call and extract channels

        // Generate x and y arguments from the first call
        let x_arg_raw = self.generate_expression(&tex2d_calls[0].args[1], ctx)?;
        let y_arg_raw = self.generate_expression(&tex2d_calls[0].args[2], ctx)?;

        // Emit arguments
        if self.needs_emit(&ctx.expressions[x_arg_raw]) {
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(x_arg_raw, x_arg_raw)),
                Span::UNDEFINED,
            ));
        }
        if self.needs_emit(&ctx.expressions[y_arg_raw]) {
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(y_arg_raw, y_arg_raw)),
                Span::UNDEFINED,
            ));
        }

        // Convert to i32
        let x_arg = ctx.expressions.append(
            NagaExpr::As {
                expr: x_arg_raw,
                kind: naga::ScalarKind::Sint,
                convert: Some(4),
            },
            Span::UNDEFINED,
        );
        ctx.pending_stmts.push((
            NagaStmt::Emit(naga::Range::new_from_bounds(x_arg, x_arg)),
            Span::UNDEFINED,
        ));

        let y_arg = ctx.expressions.append(
            NagaExpr::As {
                expr: y_arg_raw,
                kind: naga::ScalarKind::Sint,
                convert: Some(4),
            },
            Span::UNDEFINED,
        );
        ctx.pending_stmts.push((
            NagaStmt::Emit(naga::Range::new_from_bounds(y_arg, y_arg)),
            Span::UNDEFINED,
        ));

        // Call dctl_sampleTexture once
        let sample_func = self.ensure_dctl_sample_texture_exists()?;
        let call_result = ctx
            .expressions
            .append(NagaExpr::CallResult(sample_func), Span::UNDEFINED);
        ctx.pending_stmts.push((
            NagaStmt::Call {
                function: sample_func,
                arguments: vec![x_arg, y_arg],
                result: Some(call_result),
            },
            Span::UNDEFINED,
        ));

        // Extract .x, .y, .z from the single result
        let x_component = ctx.expressions.append(
            NagaExpr::AccessIndex {
                base: call_result,
                index: 0,
            },
            Span::UNDEFINED,
        );
        let y_component = ctx.expressions.append(
            NagaExpr::AccessIndex {
                base: call_result,
                index: 1,
            },
            Span::UNDEFINED,
        );
        let z_component = ctx.expressions.append(
            NagaExpr::AccessIndex {
                base: call_result,
                index: 2,
            },
            Span::UNDEFINED,
        );

        // Build vec3(x, y, z)
        let vec3_result = ctx.expressions.append(
            NagaExpr::Compose {
                ty: self.module.types.insert(
                    NagaType {
                        name: None,
                        inner: naga::TypeInner::Vector {
                            size: naga::VectorSize::Tri,
                            scalar: naga::Scalar {
                                kind: naga::ScalarKind::Float,
                                width: 4,
                            },
                        },
                    },
                    Span::UNDEFINED,
                ),
                components: vec![x_component, y_component, z_component],
            },
            Span::UNDEFINED,
        );

        Ok(Some(vec3_result))
    }

    /// Convert AST expression to a string key for caching
    /// This allows us to detect identical expressions at the AST level
    /// before they're converted to potentially different Naga handles
    fn ast_expr_to_cache_key(&self, expr: &Expression) -> String {
        use crate::parser::{BinaryOp as BinOp, LiteralValue, UnaryOp as UnOp};

        match expr {
            Expression::Identifier(id) => id.name.clone(),
            Expression::Literal(lit) => match &lit.value {
                LiteralValue::Int(v) => format!("{}", v),
                LiteralValue::UInt(v) => format!("{}u", v),
                LiteralValue::Float(v) => format!("{}", v),
                LiteralValue::Bool(v) => format!("{}", v),
                LiteralValue::Char(v) => format!("'{}'", v),
                LiteralValue::String(v) => format!("\"{}\"", v),
            },
            Expression::Binary(binop) => {
                let op_str = match binop.op {
                    BinOp::Add => "+",
                    BinOp::Sub => "-",
                    BinOp::Mul => "*",
                    BinOp::Div => "/",
                    BinOp::Mod => "%",
                    BinOp::Eq => "==",
                    BinOp::Ne => "!=",
                    BinOp::Lt => "<",
                    BinOp::Le => "<=",
                    BinOp::Gt => ">",
                    BinOp::Ge => ">=",
                    BinOp::And => "&&",
                    BinOp::Or => "||",
                    BinOp::BitAnd => "&",
                    BinOp::BitOr => "|",
                    BinOp::BitXor => "^",
                    BinOp::Shl => "<<",
                    BinOp::Shr => ">>",
                };
                format!(
                    "({} {} {})",
                    self.ast_expr_to_cache_key(&binop.left),
                    op_str,
                    self.ast_expr_to_cache_key(&binop.right)
                )
            }
            Expression::Unary(unop) => {
                let op_str = match unop.op {
                    UnOp::Neg => "-",
                    UnOp::Not => "!",
                    UnOp::BitNot => "~",
                    _ => "unary",
                };
                format!("({}{})", op_str, self.ast_expr_to_cache_key(&unop.operand))
            }
            Expression::Call(call) => {
                let callee_str = self.ast_expr_to_cache_key(&call.callee);
                let args = call
                    .args
                    .iter()
                    .map(|arg| self.ast_expr_to_cache_key(arg))
                    .collect::<Vec<_>>()
                    .join(",");
                format!("{}({})", callee_str, args)
            }
            Expression::Member(ma) => {
                format!("{}.{}", self.ast_expr_to_cache_key(&ma.object), ma.member)
            }
            Expression::Index(aa) => {
                format!(
                    "{}[{}]",
                    self.ast_expr_to_cache_key(&aa.object),
                    self.ast_expr_to_cache_key(&aa.index)
                )
            }
            Expression::Cast(cast) => {
                // Handle cast expressions: (type)expr
                let type_str = format!("{:?}", cast.target_type);
                format!("({}){}", type_str, self.ast_expr_to_cache_key(&cast.operand))
            }
            _ => format!("{:?}", expr), // Fallback for other types
        }
    }

    /// Generate a _tex2D call expression
    /// Transforms _tex2D(p_TexR, x, y) → dctl_sampleTexture(x, y).r
    pub(super) fn generate_tex2d_call(
        &mut self,
        call: &crate::parser::CallExpr,
        ctx: &mut FunctionContext,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        if call.args.len() < 3 {
            return Err(CodegenError::Internal(
                "_tex2D requires at least 3 arguments (texture, x, y)".to_string(),
            ));
        }

        // Get texture parameter name to determine channel
        // Support various naming conventions: p_TexR, texR, TexR, or any name ending with R/G/B/A
        let channel = match &call.args[0] {
            Expression::Identifier(ident) => {
                let name = &ident.name;
                // Check explicit matches first
                match name.as_str() {
                    "p_TexR" | "texR" | "TexR" => Some(naga::SwizzleComponent::X), // .r
                    "p_TexG" | "texG" | "TexG" => Some(naga::SwizzleComponent::Y), // .g
                    "p_TexB" | "texB" | "TexB" => Some(naga::SwizzleComponent::Z), // .b
                    "p_TexA" | "texA" | "TexA" => Some(naga::SwizzleComponent::W), // .a
                    _ => {
                        // Check if name ends with R, G, B, or A (case-insensitive)
                        // This handles patterns like sourceR, inputR, etc.
                        if name.ends_with('R') || name.ends_with('r') {
                            Some(naga::SwizzleComponent::X)
                        } else if name.ends_with('G') || name.ends_with('g') {
                            Some(naga::SwizzleComponent::Y)
                        } else if name.ends_with('B') || name.ends_with('b') {
                            Some(naga::SwizzleComponent::Z)
                        } else if name.ends_with('A') || name.ends_with('a') {
                            Some(naga::SwizzleComponent::W)
                        } else {
                            // Unknown texture name, default to .x (R channel)
                            // This handles user-defined functions with generic texture params like "Tex"
                            Some(naga::SwizzleComponent::X)
                        }
                    }
                }
            }
            _ => None,
        };

        // Check cache BEFORE generating expressions
        // Use AST-level keys to detect identical expressions
        let x_cache_key = self.ast_expr_to_cache_key(&call.args[1]);
        let y_cache_key = self.ast_expr_to_cache_key(&call.args[2]);
        let cache_key = (x_cache_key, y_cache_key);

        // Check if we already have a cached result for these coordinates
        if let Some(&cached_result) = ctx.tex2d_cache.get(&cache_key) {
            // Cache hit! Use AccessIndex to extract the appropriate channel from cached result
            let component = channel.unwrap_or(naga::SwizzleComponent::X);
            let index = match component {
                naga::SwizzleComponent::X => 0,
                naga::SwizzleComponent::Y => 1,
                naga::SwizzleComponent::Z => 2,
                naga::SwizzleComponent::W => 3,
            };
            return Ok(ctx.expressions.append(
                NagaExpr::AccessIndex {
                    base: cached_result,
                    index,
                },
                Span::UNDEFINED,
            ));
        }

        // Cache miss - generate the full call
        // Generate x and y arguments
        let x_arg_raw = self.generate_expression(&call.args[1], ctx)?;
        let y_arg_raw = self.generate_expression(&call.args[2], ctx)?;

        // Check if dctl_sampleTexture function exists, if not create a stub
        let sample_func = self.ensure_dctl_sample_texture_exists()?;

        // Emit raw arguments first
        if self.needs_emit(&ctx.expressions[x_arg_raw]) {
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(x_arg_raw, x_arg_raw)),
                Span::UNDEFINED,
            ));
        }
        if self.needs_emit(&ctx.expressions[y_arg_raw]) {
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(y_arg_raw, y_arg_raw)),
                Span::UNDEFINED,
            ));
        }

        // Convert arguments to i32 if they're not already
        // dctl_sampleTexture expects (i32, i32), but DCTL _tex2D accepts float coords
        let x_arg = ctx.expressions.append(
            NagaExpr::As {
                expr: x_arg_raw,
                kind: naga::ScalarKind::Sint,
                convert: Some(4),
            },
            Span::UNDEFINED,
        );
        ctx.pending_stmts.push((
            NagaStmt::Emit(naga::Range::new_from_bounds(x_arg, x_arg)),
            Span::UNDEFINED,
        ));
        let y_arg = ctx.expressions.append(
            NagaExpr::As {
                expr: y_arg_raw,
                kind: naga::ScalarKind::Sint,
                convert: Some(4),
            },
            Span::UNDEFINED,
        );
        ctx.pending_stmts.push((
            NagaStmt::Emit(naga::Range::new_from_bounds(y_arg, y_arg)),
            Span::UNDEFINED,
        ));

        // Call dctl_sampleTexture(x, y) - no cache check needed here since we checked earlier
        // Generate new call and cache it
        let call_result = ctx
            .expressions
            .append(NagaExpr::CallResult(sample_func), Span::UNDEFINED);
        ctx.pending_stmts.push((
            NagaStmt::Call {
                function: sample_func,
                arguments: vec![x_arg, y_arg],
                result: Some(call_result),
            },
            Span::UNDEFINED,
        ));

        // Cache the result for future reuse
        ctx.tex2d_cache.insert(cache_key, call_result);

        // Use AccessIndex to get single float from the appropriate channel
        // channel is always Some now - defaults to X for unknown texture names
        let component = channel.unwrap_or(naga::SwizzleComponent::X);
        let index = match component {
            naga::SwizzleComponent::X => 0,
            naga::SwizzleComponent::Y => 1,
            naga::SwizzleComponent::Z => 2,
            naga::SwizzleComponent::W => 3,
        };
        Ok(ctx.expressions.append(
            NagaExpr::AccessIndex {
                base: call_result,
                index,
            },
            Span::UNDEFINED,
        ))
    }

    /// Ensure dctl_sampleTexture function exists in the module
    /// Creates a stub that returns vec4(0.0) if it doesn't exist
    pub(super) fn ensure_dctl_sample_texture_exists(
        &mut self,
    ) -> Result<Handle<Function>, CodegenError> {
        if let Some(&handle) = self.function_handles.get("dctl_sampleTexture") {
            return Ok(handle);
        }

        // Create stub function: fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32>
        let vec4_type = self.type_handles["vec4<f32>"];
        let i32_type = self.type_handles["i32"];

        let mut func = Function::default();
        func.name = Some("dctl_sampleTexture".to_string());
        func.arguments = vec![
            FunctionArgument {
                name: Some("x".to_string()),
                ty: i32_type,
                binding: None,
            },
            FunctionArgument {
                name: Some("y".to_string()),
                ty: i32_type,
                binding: None,
            },
        ];
        func.result = Some(FunctionResult {
            ty: vec4_type,
            binding: None,
        });

        // Create return vec4(0.0, 0.0, 0.0, 0.0)
        // Naga requires separate expression handles for each component
        // Literals are automatically in scope (don't need Emit)
        let zero_x = func
            .expressions
            .append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED);
        let zero_y = func
            .expressions
            .append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED);
        let zero_z = func
            .expressions
            .append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED);
        let zero_w = func
            .expressions
            .append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED);
        let result = func.expressions.append(
            NagaExpr::Compose {
                ty: vec4_type,
                components: vec![zero_x, zero_y, zero_z, zero_w],
            },
            Span::UNDEFINED,
        );
        // Only emit the Compose expression (literals are automatically in scope)
        func.body.push(
            NagaStmt::Emit(naga::Range::new_from_bounds(result, result)),
            Span::UNDEFINED,
        );
        func.body
            .push(NagaStmt::Return { value: Some(result) }, Span::UNDEFINED);

        let handle = self.module.functions.append(func, Span::UNDEFINED);
        self.function_handles
            .insert("dctl_sampleTexture".to_string(), handle);

        Ok(handle)
    }

    /// Get the array source size from an expression (if it's an array access)
    pub(super) fn get_array_source_size(
        &self,
        expr: &NagaExpr,
        ctx: &FunctionContext,
    ) -> Option<u32> {
        match expr {
            NagaExpr::LocalVariable(local_handle) => {
                // First try to get the size from the Naga type directly
                let local_ty = ctx.local_variables[*local_handle].ty;
                if let TypeInner::Array {
                    size: naga::ArraySize::Constant(n),
                    ..
                } = &self.module.types[local_ty].inner
                {
                    return Some(n.get());
                }
                // Fallback: try to find the type from local_vars by searching for matching handle
                for (name, &handle) in &ctx.local_vars {
                    if handle == *local_handle {
                        // Get type from variable_types
                        if let Some(dtype) = ctx.variable_types.get(name) {
                            if let DctlType::Array(_, Some(size)) = dtype {
                                return Some(*size as u32);
                            }
                            // Handle pointer to array type (from pointer params)
                            if let DctlType::Pointer(inner) = dtype {
                                if let DctlType::Array(_, Some(size)) = inner.as_ref() {
                                    return Some(*size as u32);
                                }
                            }
                        }
                    }
                }
                // Also check by type handle directly for arrays with dynamic size that might have known DctlType size
                if let TypeInner::Array {
                    size: naga::ArraySize::Dynamic,
                    ..
                } = &self.module.types[local_ty].inner
                {
                    // Find variable name from local_vars
                    for (name, &handle) in &ctx.local_vars {
                        if handle == *local_handle {
                            if let Some(dtype) = ctx.variable_types.get(name) {
                                if let DctlType::Array(_, Some(size)) = dtype {
                                    return Some(*size as u32);
                                }
                            }
                        }
                    }
                }
                None
            }
            NagaExpr::FunctionArgument(idx) => {
                // For function arguments, try to find the type from param_indices
                for (name, &param_idx) in &ctx.param_indices {
                    if param_idx == *idx {
                        if let Some(dtype) = ctx.variable_types.get(name) {
                            if let DctlType::Array(_, Some(size)) = dtype {
                                return Some(*size as u32);
                            }
                        }
                    }
                }
                None
            }
            NagaExpr::Load { pointer } => {
                // Recursively check the pointer expression
                let ptr_expr = &ctx.expressions[*pointer];
                self.get_array_source_size(ptr_expr, ctx)
            }
            NagaExpr::Compose { ty, .. } => {
                // For composed arrays, check the type
                if let TypeInner::Array { size, .. } = &self.module.types[*ty].inner {
                    if let naga::ArraySize::Constant(sz) = size {
                        return Some(sz.get());
                    }
                }
                None
            }
            NagaExpr::Access { base, .. } | NagaExpr::AccessIndex { base, .. } => {
                // Recursively check the base expression
                self.get_array_source_size(&ctx.expressions[*base], ctx)
            }
            NagaExpr::GlobalVariable(global_handle) => {
                // Check global variable's type
                let global_ty = self.module.global_variables[*global_handle].ty;
                if let TypeInner::Array {
                    size: naga::ArraySize::Constant(n),
                    ..
                } = &self.module.types[global_ty].inner
                {
                    return Some(n.get());
                }
                None
            }
            _ => None,
        }
    }

    /// Expand a smaller array to a larger target size for function call using Compose
    pub(super) fn expand_array_argument(
        &mut self,
        source_handle: Handle<NagaExpr>,
        target_array_type: Handle<NagaType>,
        source_size: u32,
        target_size: u32,
        ctx: &mut FunctionContext,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        // Use the exact parameter type handle for the Compose expression
        // This ensures Naga sees the same type as the function parameter
        let target_type = target_array_type;

        // Get the element type from the array type for proper zero value creation
        let elem_type_handle =
            if let TypeInner::Array { base, .. } = &self.module.types[target_array_type].inner {
                Some(*base)
            } else {
                None
            };

        // Get the source array pointer (the argument might be a Load, need to get pointer)
        let source_ptr = match &ctx.expressions[source_handle] {
            NagaExpr::Load { pointer } => *pointer,
            _ => source_handle, // Assume it's already a pointer
        };

        // Create element expressions: copy from source for indices < source_size, else 0
        let mut components: Vec<Handle<NagaExpr>> = Vec::new();

        for i in 0..target_size {
            if i < source_size {
                // Index into source: source[i]
                let idx = ctx
                    .expressions
                    .append(NagaExpr::Literal(Literal::U32(i)), Span::UNDEFINED);
                let source_access = ctx.expressions.append(
                    NagaExpr::Access {
                        base: source_ptr,
                        index: idx,
                    },
                    Span::UNDEFINED,
                );
                let elem_value = ctx.expressions.append(
                    NagaExpr::Load {
                        pointer: source_access,
                    },
                    Span::UNDEFINED,
                );
                // Emit the Load
                ctx.pending_stmts.push((
                    NagaStmt::Emit(naga::Range::new_from_bounds(elem_value, elem_value)),
                    Span::UNDEFINED,
                ));
                components.push(elem_value);
            } else {
                // Fill with appropriate zero value for the element type
                let zero = self.create_zero_element(elem_type_handle, ctx)?;
                components.push(zero);
            }
        }

        // Create Compose expression to build the larger array
        let compose_expr = ctx.expressions.append(
            NagaExpr::Compose {
                ty: target_type,
                components,
            },
            Span::UNDEFINED,
        );

        Ok(compose_expr)
    }

    /// Truncate a larger array to a smaller target size for function call using Compose
    pub(super) fn truncate_array_argument(
        &mut self,
        source_handle: Handle<NagaExpr>,
        target_array_type: Handle<NagaType>,
        _elem_type: Handle<NagaType>,
        source_size: u32,
        target_size: u32,
        ctx: &mut FunctionContext,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        // Get the source array pointer (the argument might be a Load, need to get pointer)
        let source_ptr = match &ctx.expressions[source_handle] {
            NagaExpr::Load { pointer } => *pointer,
            _ => source_handle, // Assume it's already a pointer
        };

        // Create element expressions: copy only first target_size elements from source
        let mut components: Vec<Handle<NagaExpr>> = Vec::new();

        for i in 0..target_size {
            if i < source_size {
                // Index into source: source[i]
                let idx = ctx
                    .expressions
                    .append(NagaExpr::Literal(Literal::U32(i)), Span::UNDEFINED);
                let source_access = ctx.expressions.append(
                    NagaExpr::Access {
                        base: source_ptr,
                        index: idx,
                    },
                    Span::UNDEFINED,
                );
                let elem_value = ctx.expressions.append(
                    NagaExpr::Load {
                        pointer: source_access,
                    },
                    Span::UNDEFINED,
                );
                // Emit the Load
                ctx.pending_stmts.push((
                    NagaStmt::Emit(naga::Range::new_from_bounds(elem_value, elem_value)),
                    Span::UNDEFINED,
                ));
                components.push(elem_value);
            }
        }

        // Create Compose expression to build the smaller array
        let compose_expr = ctx.expressions.append(
            NagaExpr::Compose {
                ty: target_array_type,
                components,
            },
            Span::UNDEFINED,
        );

        Ok(compose_expr)
    }

    /// Get the array size from an expression (if it's an array type)
    pub(super) fn get_expression_array_size(
        &self,
        expr_handle: Handle<NagaExpr>,
        ctx: &FunctionContext,
    ) -> Option<u32> {
        let expr = &ctx.expressions[expr_handle];

        // Try to get the type handle for this expression
        let type_handle = match expr {
            NagaExpr::Load { pointer } => {
                // Follow the pointer to get the pointed-to type
                let ptr_expr = &ctx.expressions[*pointer];
                match ptr_expr {
                    NagaExpr::LocalVariable(local_handle) => {
                        Some(ctx.local_variables[*local_handle].ty)
                    }
                    NagaExpr::GlobalVariable(global_handle) => {
                        Some(self.module.global_variables[*global_handle].ty)
                    }
                    NagaExpr::FunctionArgument(_idx) => {
                        // Look up the function argument type
                        // ctx.param_indices maps name to index, but we need the reverse
                        // For now, return None as we don't have easy access to this
                        None
                    }
                    _ => None,
                }
            }
            NagaExpr::LocalVariable(local_handle) => Some(ctx.local_variables[*local_handle].ty),
            NagaExpr::GlobalVariable(global_handle) => {
                Some(self.module.global_variables[*global_handle].ty)
            }
            NagaExpr::Compose { ty, .. } => Some(*ty),
            _ => None,
        };

        // Check if it's an array type and get the size
        if let Some(ty) = type_handle {
            if let TypeInner::Array {
                size: naga::ArraySize::Constant(n),
                ..
            } = &self.module.types[ty].inner
            {
                return Some(n.get());
            }
        }

        None
    }

    /// Create a zero value for an array element type
    pub(super) fn create_zero_element(
        &mut self,
        elem_type_handle: Option<Handle<NagaType>>,
        ctx: &mut FunctionContext,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        if let Some(type_handle) = elem_type_handle {
            // Extract type info first to avoid borrow conflicts
            let type_info = self.extract_zero_type_info(type_handle);
            self.create_zero_from_info(type_handle, type_info, ctx)
        } else {
            // No type info, default to f32
            Ok(ctx
                .expressions
                .append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED))
        }
    }

    /// Extract type information needed for creating zero values
    pub(super) fn extract_zero_type_info(&self, type_handle: Handle<NagaType>) -> ZeroTypeInfo {
        match &self.module.types[type_handle].inner {
            TypeInner::Scalar(s) => ZeroTypeInfo::Scalar(s.kind),
            TypeInner::Vector { size, scalar } => ZeroTypeInfo::Vector {
                size: *size,
                scalar_kind: scalar.kind,
            },
            TypeInner::Matrix {
                columns,
                rows,
                scalar,
            } => ZeroTypeInfo::Matrix {
                columns: *columns,
                rows: *rows,
                scalar_kind: scalar.kind,
            },
            TypeInner::Struct { members, .. } => ZeroTypeInfo::Struct {
                member_types: members.iter().map(|m| m.ty).collect(),
            },
            _ => ZeroTypeInfo::Default,
        }
    }

    /// Create zero value from extracted type info
    pub(super) fn create_zero_from_info(
        &mut self,
        type_handle: Handle<NagaType>,
        type_info: ZeroTypeInfo,
        ctx: &mut FunctionContext,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        match type_info {
            ZeroTypeInfo::Scalar(kind) => {
                let literal = match kind {
                    naga::ScalarKind::Float => Literal::F32(0.0),
                    naga::ScalarKind::Sint => Literal::I32(0),
                    naga::ScalarKind::Uint => Literal::U32(0),
                    naga::ScalarKind::Bool => Literal::Bool(false),
                    _ => Literal::F32(0.0),
                };
                Ok(ctx
                    .expressions
                    .append(NagaExpr::Literal(literal), Span::UNDEFINED))
            }
            ZeroTypeInfo::Vector { size, scalar_kind } => {
                let literal = match scalar_kind {
                    naga::ScalarKind::Float => Literal::F32(0.0),
                    naga::ScalarKind::Sint => Literal::I32(0),
                    naga::ScalarKind::Uint => Literal::U32(0),
                    naga::ScalarKind::Bool => Literal::Bool(false),
                    _ => Literal::F32(0.0),
                };
                let count = match size {
                    naga::VectorSize::Bi => 2,
                    naga::VectorSize::Tri => 3,
                    naga::VectorSize::Quad => 4,
                };
                let zero_scalar = ctx
                    .expressions
                    .append(NagaExpr::Literal(literal), Span::UNDEFINED);
                let vec_components = vec![zero_scalar; count];
                let compose = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: type_handle,
                        components: vec_components,
                    },
                    Span::UNDEFINED,
                );
                ctx.pending_stmts.push((
                    NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                    Span::UNDEFINED,
                ));
                Ok(compose)
            }
            ZeroTypeInfo::Matrix {
                columns,
                rows,
                scalar_kind,
            } => {
                let col_count = match columns {
                    naga::VectorSize::Bi => 2,
                    naga::VectorSize::Tri => 3,
                    naga::VectorSize::Quad => 4,
                };
                let row_count = match rows {
                    naga::VectorSize::Bi => 2,
                    naga::VectorSize::Tri => 3,
                    naga::VectorSize::Quad => 4,
                };
                let literal = match scalar_kind {
                    naga::ScalarKind::Float => Literal::F32(0.0),
                    naga::ScalarKind::Sint => Literal::I32(0),
                    _ => Literal::F32(0.0),
                };
                let zero_scalar = ctx
                    .expressions
                    .append(NagaExpr::Literal(literal), Span::UNDEFINED);
                let col_vec_type = self.get_or_create_type(&match row_count {
                    2 => DctlType::Vec2(ScalarType::Float),
                    3 => DctlType::Vec3(ScalarType::Float),
                    4 => DctlType::Vec4(ScalarType::Float),
                    _ => DctlType::Vec3(ScalarType::Float),
                });
                let mut col_handles = Vec::new();
                for _ in 0..col_count {
                    let col = ctx.expressions.append(
                        NagaExpr::Compose {
                            ty: col_vec_type,
                            components: vec![zero_scalar; row_count],
                        },
                        Span::UNDEFINED,
                    );
                    ctx.pending_stmts.push((
                        NagaStmt::Emit(naga::Range::new_from_bounds(col, col)),
                        Span::UNDEFINED,
                    ));
                    col_handles.push(col);
                }
                let compose = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: type_handle,
                        components: col_handles,
                    },
                    Span::UNDEFINED,
                );
                ctx.pending_stmts.push((
                    NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                    Span::UNDEFINED,
                ));
                Ok(compose)
            }
            ZeroTypeInfo::Struct { member_types } => {
                let mut member_zeros = Vec::new();
                for member_ty in member_types {
                    let member_zero = self.create_zero_element(Some(member_ty), ctx)?;
                    member_zeros.push(member_zero);
                }
                let compose = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: type_handle,
                        components: member_zeros,
                    },
                    Span::UNDEFINED,
                );
                ctx.pending_stmts.push((
                    NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                    Span::UNDEFINED,
                ));
                Ok(compose)
            }
            ZeroTypeInfo::Default => Ok(ctx
                .expressions
                .append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED)),
        }
    }
}
