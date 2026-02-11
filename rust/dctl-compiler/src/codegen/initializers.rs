//! Initializer generation for DCTL to WGSL
//!
//! This module handles the generation of variable initializers and zero values.

use naga::{
    BinaryOperator, Block as NagaBlock, Expression as NagaExpr, Function, Handle, Literal,
    LocalVariable, Span, Statement as NagaStmt, TypeInner,
};

use super::naga_module::{FunctionContext, NagaModuleGenerator};
use super::CodegenError;
use crate::parser::{Expression, UnaryOp};
use crate::semantic::{DctlType, ScalarType};

impl NagaModuleGenerator {
    /// Generate a local variable declaration
    pub(super) fn generate_local_variable(
        &mut self,
        var_decl: &crate::parser::VariableDecl,
        ctx: &mut FunctionContext,
        _func: &mut Function,
        block: &mut NagaBlock,
    ) -> Result<(), CodegenError> {
        // Track const int values for VLA size resolution BEFORE type conversion
        // This allows later VLA declarations to use earlier const int values
        if var_decl.is_const {
            let base_type = &var_decl.var_type.base;
            if matches!(base_type, crate::parser::BaseType::Int) {
                if let Some(init_expr) = &var_decl.initializer {
                    // Try to evaluate the constant expression (handles literals, binary ops, etc.)
                    if let Some(value) = self.evaluate_const_int_expression_with_locals(
                        init_expr,
                        Some(&ctx.local_int_constants),
                    ) {
                        ctx.local_int_constants.insert(var_decl.name.clone(), value);
                    }
                }
            }
        }

        // Check for multi-dimensional arrays and flatten them
        let (mut var_type, multidim_dims) =
            self.convert_multidim_array_type(&var_decl.var_type, Some(&ctx.local_int_constants));

        // Store multi-dimensional array dimensions for index transformation
        if let Some(dims) = multidim_dims {
            self.multidim_array_dims
                .insert(var_decl.name.clone(), dims);
        }

        // If this is an unsized array with an initializer list, infer the size
        if let DctlType::Array(ref elem_type, None) = var_type {
            if let Some(Expression::InitializerList(init_list)) = &var_decl.initializer {
                // Count elements recursively for nested initializers
                let size = self.count_flat_initializer_elements(init_list);
                var_type = DctlType::Array(elem_type.clone(), Some(size));
            }
        }

        let type_handle = self.get_or_create_type(&var_type);

        // Track variable type for overload resolution
        ctx.variable_types
            .insert(var_decl.name.clone(), var_type.clone());

        // Track struct/matrix type for member access resolution
        match &var_type {
            DctlType::Struct(struct_name) => {
                ctx.var_types
                    .insert(var_decl.name.clone(), struct_name.clone());
            }
            DctlType::Mat2 => {
                ctx.var_types
                    .insert(var_decl.name.clone(), "mat2".to_string());
            }
            DctlType::Mat3 => {
                ctx.var_types
                    .insert(var_decl.name.clone(), "mat3".to_string());
            }
            DctlType::Mat4 => {
                ctx.var_types
                    .insert(var_decl.name.clone(), "mat4".to_string());
            }
            _ => {}
        }

        // Handle pointer types specially - WGSL doesn't allow ptr<function, T> as local variable type
        // Instead, we store the pointer expression as an alias and substitute it when referenced
        if let DctlType::Pointer(_) = &var_type {
            if let Some(init_expr) = &var_decl.initializer {
                // Check if this is a pointer to a multi-dimensional array element: &arr[i][j]
                if let Expression::Unary(unary) = init_expr {
                    if matches!(unary.op, UnaryOp::AddrOf) {
                        if let Some((array_name, indices)) =
                            self.collect_multidim_indices(&unary.operand)
                        {
                            if let Some(dims) = self.multidim_array_dims.get(&array_name).cloned() {
                                // Compute the base offset
                                let base_offset = self.compute_flat_index(&indices, &dims, ctx)?;
                                ctx.multidim_ptr_aliases.insert(
                                    var_decl.name.clone(),
                                    (array_name.clone(), base_offset),
                                );
                                return Ok(());
                            }
                        }
                    }
                }

                // Standard pointer alias - generate the pointer expression
                // For address-of expressions, generate_expression returns the pointer directly
                // (since UnaryOp::AddrOf calls generate_lvalue on its operand)
                let pointer_expr = self.emit_expression(init_expr, ctx, block)?;
                ctx.pointer_aliases
                    .insert(var_decl.name.clone(), pointer_expr);
            } else {
                // Pointer without initializer - this is problematic but we can handle it
                // by creating a null-like expression (though WGSL doesn't have null pointers)
                return Err(CodegenError::UnsupportedFeature(
                    "Pointer local variable without initializer is not supported in WGSL"
                        .to_string(),
                ));
            }
            return Ok(());
        }

        // Create local variable for non-pointer types
        // Sanitize variable name for WGSL compatibility
        let wgsl_var_name = NagaModuleGenerator::sanitize_identifier_for_wgsl(&var_decl.name);

        let local = LocalVariable {
            name: Some(wgsl_var_name.into()),
            ty: type_handle,
            init: None,
        };
        let local_handle = ctx.local_variables.append(local, Span::UNDEFINED);
        ctx.local_vars.insert(var_decl.name.clone(), local_handle);

        // Generate initializer if present
        if let Some(init_expr) = &var_decl.initializer {
            // For InitializerList, use the typed version to properly handle arrays/matrices
            let init_value = if matches!(init_expr, Expression::InitializerList(_)) {
                self.generate_initializer_with_type(init_expr, &var_type, ctx, block)?
            } else {
                self.emit_expression(init_expr, ctx, block)?
            };

            // Coerce scalar to vector if needed (e.g., float3 x = scalar)
            let init_type = self.infer_expression_type(init_expr, ctx);
            let coerced_value =
                self.coerce_scalar_to_vector(init_value, init_type, &var_type, ctx, block);

            let pointer = ctx
                .expressions
                .append(NagaExpr::LocalVariable(local_handle), Span::UNDEFINED);
            block.push(
                NagaStmt::Store {
                    pointer,
                    value: coerced_value,
                },
                Span::UNDEFINED,
            );
        }

        Ok(())
    }

    /// Generate an initializer expression with a known target type
    /// This is needed for InitializerList to create properly typed arrays/matrices
    pub(super) fn generate_initializer_with_type(
        &mut self,
        expr: &Expression,
        target_type: &DctlType,
        ctx: &mut FunctionContext,
        block: &mut NagaBlock,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        match expr {
            Expression::InitializerList(init_list) => {
                let type_handle = self.get_or_create_type(target_type);

                // Handle empty initializer {} - create zero-initialized value
                if init_list.elements.is_empty() {
                    return self.generate_zero_value(target_type, ctx, block);
                }

                match target_type {
                    // Array (possibly flattened from multi-dimensional)
                    DctlType::Array(inner, outer_size) => {
                        // Determine flattening strategy based on element type
                        let inner_is_scalar = matches!(
                            inner.as_ref(),
                            DctlType::Float
                                | DctlType::Int
                                | DctlType::UInt
                                | DctlType::Bool
                                | DctlType::Half
                                | DctlType::Double
                        );
                        let has_nested_init = init_list
                            .elements
                            .iter()
                            .any(|e| matches!(e, Expression::InitializerList(_)));

                        let elements_to_process: Vec<Expression> = if has_nested_init {
                            if inner_is_scalar {
                                // Scalar array: flatten all levels
                                self.flatten_initializer_list(init_list)
                            } else {
                                // Non-scalar array (vector/struct/etc): flatten only the array dimensions
                                // Count nesting depth of initializer and check what's at the innermost level
                                let mut depth = 0;
                                let mut probe = &init_list.elements;
                                let mut innermost_is_literal = false;
                                while !probe.is_empty() {
                                    if let Expression::InitializerList(nested) = &probe[0] {
                                        depth += 1;
                                        probe = &nested.elements;
                                    } else {
                                        // Check if innermost elements are literals (element initializers like {1.0, 2.0})
                                        // vs function calls (make_float2 etc.)
                                        innermost_is_literal =
                                            matches!(&probe[0], Expression::Literal(_));
                                        break;
                                    }
                                }
                                // If innermost elements are literals, the enclosing InitializerLists are element
                                // initializers (like {1.0, 2.0} for vec2), so subtract 1 from depth to preserve them
                                if innermost_is_literal && depth > 0 {
                                    depth -= 1;
                                }
                                // Flatten to the appropriate depth
                                if depth > 0 {
                                    self.flatten_initializer_list_depth(init_list, depth)
                                } else {
                                    init_list.elements.clone()
                                }
                            }
                        } else {
                            // No nested initializers, use elements directly
                            init_list.elements.clone()
                        };

                        // Generate provided elements
                        let mut components: Vec<Handle<NagaExpr>> = Vec::new();
                        for e in &elements_to_process {
                            let comp = self.generate_initializer_with_type(e, inner, ctx, block)?;
                            components.push(comp);
                        }

                        // Pad with zeros if fewer elements than expected
                        if let Some(expected_size) = outer_size {
                            while components.len() < *expected_size {
                                let zero = self.generate_zero_value(inner, ctx, block)?;
                                components.push(zero);
                            }
                        }

                        let compose = ctx.expressions.append(
                            NagaExpr::Compose {
                                ty: type_handle,
                                components,
                            },
                            Span::UNDEFINED,
                        );
                        block.push(
                            NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                            Span::UNDEFINED,
                        );
                        Ok(compose)
                    }
                    // Mat3 from 9 floats: {{a,b,c},{d,e,f},{g,h,i}}
                    DctlType::Mat3 => {
                        let vec3_type = self.get_or_create_type(&DctlType::Vec3(ScalarType::Float));
                        // Build 3 rows (columns in WGSL)
                        let mut columns = Vec::with_capacity(3);
                        for elem in &init_list.elements {
                            if let Expression::InitializerList(inner_list) = elem {
                                let mut col_components = Vec::with_capacity(3);
                                for inner_elem in &inner_list.elements {
                                    let val = self.generate_expression(inner_elem, ctx)?;
                                    col_components.push(val);
                                }
                                let col = ctx.expressions.append(
                                    NagaExpr::Compose {
                                        ty: vec3_type,
                                        components: col_components,
                                    },
                                    Span::UNDEFINED,
                                );
                                block.push(
                                    NagaStmt::Emit(naga::Range::new_from_bounds(col, col)),
                                    Span::UNDEFINED,
                                );
                                columns.push(col);
                            } else {
                                // Single element - may be part of a flat list
                                let val = self.generate_expression(elem, ctx)?;
                                columns.push(val);
                            }
                        }

                        // If we got 9 elements (flat list), group into 3 columns
                        if columns.len() == 9 {
                            let mut mat_columns = Vec::with_capacity(3);
                            for i in 0..3 {
                                let col = ctx.expressions.append(
                                    NagaExpr::Compose {
                                        ty: vec3_type,
                                        components: vec![
                                            columns[i * 3],
                                            columns[i * 3 + 1],
                                            columns[i * 3 + 2],
                                        ],
                                    },
                                    Span::UNDEFINED,
                                );
                                block.push(
                                    NagaStmt::Emit(naga::Range::new_from_bounds(col, col)),
                                    Span::UNDEFINED,
                                );
                                mat_columns.push(col);
                            }
                            columns = mat_columns;
                        }

                        let compose = ctx.expressions.append(
                            NagaExpr::Compose {
                                ty: type_handle,
                                components: columns,
                            },
                            Span::UNDEFINED,
                        );
                        block.push(
                            NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                            Span::UNDEFINED,
                        );
                        Ok(compose)
                    }
                    // Vec3 from 3 floats
                    DctlType::Vec3(_) => {
                        let components: Result<Vec<_>, _> = init_list
                            .elements
                            .iter()
                            .map(|e| self.generate_expression(e, ctx))
                            .collect();
                        let compose = ctx.expressions.append(
                            NagaExpr::Compose {
                                ty: type_handle,
                                components: components?,
                            },
                            Span::UNDEFINED,
                        );
                        block.push(
                            NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                            Span::UNDEFINED,
                        );
                        Ok(compose)
                    }
                    // Struct from initializer list: coerce each element to member type
                    DctlType::Struct(struct_name) => {
                        // Get member types for this struct
                        let member_types_opt = self.struct_member_types.get(struct_name).cloned();

                        // Get the ordered list of member names from the Naga type
                        let member_names: Vec<String> =
                            if let Some(&type_h) = self.type_handles.get(struct_name) {
                                if let TypeInner::Struct { ref members, .. } =
                                    self.module.types[type_h].inner
                                {
                                    members
                                        .iter()
                                        .filter_map(|m| m.name.as_ref().map(|s| s.to_string()))
                                        .collect()
                                } else {
                                    Vec::new()
                                }
                            } else {
                                Vec::new()
                            };

                        let mut components = Vec::with_capacity(init_list.elements.len());

                        for (idx, elem) in init_list.elements.iter().enumerate() {
                            // Get the expected type for this member
                            let expected_type = member_names.get(idx).and_then(|name| {
                                member_types_opt.as_ref().and_then(|mt| mt.get(name))
                            });

                            // Generate the element expression
                            // For nested InitializerLists (arrays, nested structs), use generate_initializer_with_type
                            let elem_expr = if matches!(elem, Expression::InitializerList(_)) {
                                if let Some(member_type) = expected_type {
                                    self.generate_initializer_with_type(
                                        elem,
                                        member_type,
                                        ctx,
                                        block,
                                    )?
                                } else {
                                    self.generate_expression(elem, ctx)?
                                }
                            } else {
                                self.generate_expression(elem, ctx)?
                            };

                            // Coerce if needed (int to float)
                            let elem_type = self.infer_expression_type(elem, ctx);
                            let coerced = if let (
                                Some(DctlType::Int),
                                Some(DctlType::Float | DctlType::Double | DctlType::Half),
                            ) = (&elem_type, expected_type)
                            {
                                let cast = ctx.expressions.append(
                                    NagaExpr::As {
                                        expr: elem_expr,
                                        kind: naga::ScalarKind::Float,
                                        convert: Some(4),
                                    },
                                    Span::UNDEFINED,
                                );
                                block.push(
                                    NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                                    Span::UNDEFINED,
                                );
                                cast
                            } else {
                                elem_expr
                            };

                            components.push(coerced);
                        }

                        let compose = ctx.expressions.append(
                            NagaExpr::Compose {
                                ty: type_handle,
                                components,
                            },
                            Span::UNDEFINED,
                        );
                        block.push(
                            NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                            Span::UNDEFINED,
                        );
                        Ok(compose)
                    }
                    // Other types: generate components and compose
                    _ => {
                        let components: Result<Vec<_>, _> = init_list
                            .elements
                            .iter()
                            .map(|e| self.generate_expression(e, ctx))
                            .collect();
                        let compose = ctx.expressions.append(
                            NagaExpr::Compose {
                                ty: type_handle,
                                components: components?,
                            },
                            Span::UNDEFINED,
                        );
                        block.push(
                            NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                            Span::UNDEFINED,
                        );
                        Ok(compose)
                    }
                }
            }
            // Non-InitializerList: use standard expression generation with type coercion
            _ => {
                let value = self.emit_expression(expr, ctx, block)?;
                let expr_type = self.infer_expression_type(expr, ctx);

                // Coerce int to float if needed
                if let (
                    Some(DctlType::Int | DctlType::UInt),
                    DctlType::Float | DctlType::Double | DctlType::Half,
                ) = (&expr_type, target_type)
                {
                    let cast = ctx.expressions.append(
                        NagaExpr::As {
                            expr: value,
                            kind: naga::ScalarKind::Float,
                            convert: Some(4),
                        },
                        Span::UNDEFINED,
                    );
                    block.push(
                        NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                        Span::UNDEFINED,
                    );
                    return Ok(cast);
                }

                // Coerce int to bool if needed
                if let (Some(DctlType::Int | DctlType::UInt), DctlType::Bool) =
                    (&expr_type, target_type)
                {
                    let zero = ctx
                        .expressions
                        .append(NagaExpr::Literal(Literal::I32(0)), Span::UNDEFINED);
                    let bool_expr = ctx.expressions.append(
                        NagaExpr::Binary {
                            op: BinaryOperator::NotEqual,
                            left: value,
                            right: zero,
                        },
                        Span::UNDEFINED,
                    );
                    block.push(
                        NagaStmt::Emit(naga::Range::new_from_bounds(bool_expr, bool_expr)),
                        Span::UNDEFINED,
                    );
                    return Ok(bool_expr);
                }

                Ok(value)
            }
        }
    }

    /// Generate a zero-initialized value for the given type
    /// Used for empty initializers like `float x[3] = {}`
    pub(super) fn generate_zero_value(
        &mut self,
        target_type: &DctlType,
        ctx: &mut FunctionContext,
        block: &mut NagaBlock,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        let type_handle = self.get_or_create_type(target_type);

        match target_type {
            DctlType::Bool => Ok(ctx
                .expressions
                .append(NagaExpr::Literal(Literal::Bool(false)), Span::UNDEFINED)),
            DctlType::Int => Ok(ctx
                .expressions
                .append(NagaExpr::Literal(Literal::I32(0)), Span::UNDEFINED)),
            DctlType::UInt => Ok(ctx
                .expressions
                .append(NagaExpr::Literal(Literal::U32(0)), Span::UNDEFINED)),
            DctlType::Float | DctlType::Half | DctlType::Double => Ok(ctx
                .expressions
                .append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED)),
            DctlType::Vec2(scalar) => {
                let zero =
                    self.generate_zero_value(&self.scalar_to_dctl_type(scalar), ctx, block)?;
                let compose = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: type_handle,
                        components: vec![zero, zero],
                    },
                    Span::UNDEFINED,
                );
                block.push(
                    NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                    Span::UNDEFINED,
                );
                Ok(compose)
            }
            DctlType::Vec3(scalar) => {
                let zero =
                    self.generate_zero_value(&self.scalar_to_dctl_type(scalar), ctx, block)?;
                let compose = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: type_handle,
                        components: vec![zero, zero, zero],
                    },
                    Span::UNDEFINED,
                );
                block.push(
                    NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                    Span::UNDEFINED,
                );
                Ok(compose)
            }
            DctlType::Vec4(scalar) => {
                let zero =
                    self.generate_zero_value(&self.scalar_to_dctl_type(scalar), ctx, block)?;
                let compose = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: type_handle,
                        components: vec![zero, zero, zero, zero],
                    },
                    Span::UNDEFINED,
                );
                block.push(
                    NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                    Span::UNDEFINED,
                );
                Ok(compose)
            }
            DctlType::Mat3 => {
                // Zero mat3: 3 columns of vec3(0,0,0)
                let vec3_type = self.get_or_create_type(&DctlType::Vec3(ScalarType::Float));
                let zero_f32 = ctx
                    .expressions
                    .append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED);
                let zero_vec3 = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: vec3_type,
                        components: vec![zero_f32, zero_f32, zero_f32],
                    },
                    Span::UNDEFINED,
                );
                block.push(
                    NagaStmt::Emit(naga::Range::new_from_bounds(zero_vec3, zero_vec3)),
                    Span::UNDEFINED,
                );
                let compose = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: type_handle,
                        components: vec![zero_vec3, zero_vec3, zero_vec3],
                    },
                    Span::UNDEFINED,
                );
                block.push(
                    NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                    Span::UNDEFINED,
                );
                Ok(compose)
            }
            DctlType::Mat4 => {
                // Zero mat4: 4 columns of vec4(0,0,0,0)
                let vec4_type = self.get_or_create_type(&DctlType::Vec4(ScalarType::Float));
                let zero_f32 = ctx
                    .expressions
                    .append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED);
                let zero_vec4 = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: vec4_type,
                        components: vec![zero_f32, zero_f32, zero_f32, zero_f32],
                    },
                    Span::UNDEFINED,
                );
                block.push(
                    NagaStmt::Emit(naga::Range::new_from_bounds(zero_vec4, zero_vec4)),
                    Span::UNDEFINED,
                );
                let compose = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: type_handle,
                        components: vec![zero_vec4, zero_vec4, zero_vec4, zero_vec4],
                    },
                    Span::UNDEFINED,
                );
                block.push(
                    NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                    Span::UNDEFINED,
                );
                Ok(compose)
            }
            DctlType::Array(inner, Some(size)) => {
                // Generate size copies of zero-initialized inner type
                let mut components = Vec::with_capacity(*size as usize);
                for _ in 0..*size {
                    let zero = self.generate_zero_value(inner, ctx, block)?;
                    components.push(zero);
                }
                let compose = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: type_handle,
                        components,
                    },
                    Span::UNDEFINED,
                );
                block.push(
                    NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                    Span::UNDEFINED,
                );
                Ok(compose)
            }
            DctlType::Struct(struct_name) => {
                // Zero-initialize struct: compose zero values for each member
                // Clone the data we need to avoid borrow checker issues
                let member_types_opt = self.struct_member_types.get(struct_name).cloned();
                let member_order_opt = self.struct_members.get(struct_name).cloned();

                if let (Some(member_types), Some(member_order)) =
                    (member_types_opt, member_order_opt)
                {
                    // Sort members by their index to maintain order
                    let mut ordered_members: Vec<_> = member_order.iter().collect();
                    ordered_members.sort_by_key(|(_, idx)| *idx);

                    let mut components = Vec::with_capacity(ordered_members.len());
                    for (member_name, _) in ordered_members {
                        if let Some(member_type) = member_types.get(member_name) {
                            let zero = self.generate_zero_value(member_type, ctx, block)?;
                            components.push(zero);
                        } else {
                            // Fallback for unknown member type
                            components.push(ctx.expressions.append(
                                NagaExpr::Literal(Literal::F32(0.0)),
                                Span::UNDEFINED,
                            ));
                        }
                    }

                    let compose = ctx.expressions.append(
                        NagaExpr::Compose {
                            ty: type_handle,
                            components,
                        },
                        Span::UNDEFINED,
                    );
                    block.push(
                        NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                        Span::UNDEFINED,
                    );
                    return Ok(compose);
                }
                // Fallback: cannot determine struct members
                Err(CodegenError::Internal(format!(
                    "Cannot generate zero value for struct: {}",
                    struct_name
                )))
            }
            _ => {
                // Fallback to zero i32 for unknown types
                Ok(ctx
                    .expressions
                    .append(NagaExpr::Literal(Literal::I32(0)), Span::UNDEFINED))
            }
        }
    }
}
