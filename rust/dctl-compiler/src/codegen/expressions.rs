//! Expression generation for WGSL code generation
//!
//! Handles generation of Naga expressions from DCTL AST expressions,
//! including lvalue handling for assignments.

use super::naga_module::{FunctionContext, NagaModuleGenerator};
use super::CodegenError;
use crate::parser::{AssignmentOp, BinaryOp, Expression, LiteralValue, Type, UnaryOp};
use crate::semantic::{DctlType, ScalarType};
use naga::{
    BinaryOperator, Expression as NagaExpr, Handle, Literal, Span,
    Statement as NagaStmt, TypeInner, UnaryOperator, Block as NagaBlock,
};

impl NagaModuleGenerator {
    /// Convert a scalar type to DctlType
    pub(super) fn scalar_to_dctl_type(&self, scalar: &ScalarType) -> DctlType {
        match scalar {
            ScalarType::Bool => DctlType::Bool,
            ScalarType::Int => DctlType::Int,
            ScalarType::UInt => DctlType::UInt,
            ScalarType::Float | ScalarType::Half => DctlType::Float,
        }
    }

    /// Promote a bool expression to a numeric type using select(0, 1, cond).
    /// In C, comparison results are implicitly int (0 or 1) and can be used in
    /// arithmetic: `x *= (a > 0)`. WGSL requires explicit conversion.
    /// Returns the original expression if it's not bool or the target is bool.
    pub(super) fn coerce_bool_to_numeric(
        &mut self,
        expr: Handle<NagaExpr>,
        expr_type: &Option<DctlType>,
        target_type: &Option<DctlType>,
        ctx: &mut FunctionContext,
    ) -> Handle<NagaExpr> {
        if !matches!(expr_type, Some(DctlType::Bool)) {
            return expr;
        }
        // Don't convert if target is also bool
        if matches!(target_type, Some(DctlType::Bool)) {
            return expr;
        }

        let target_is_int = matches!(target_type, Some(DctlType::Int) | Some(DctlType::UInt));

        if target_is_int {
            // select(0i, 1i, condition)
            let zero = ctx.expressions.append(NagaExpr::Literal(Literal::I32(0)), Span::UNDEFINED);
            let one = ctx.expressions.append(NagaExpr::Literal(Literal::I32(1)), Span::UNDEFINED);
            ctx.expressions.append(
                NagaExpr::Select { condition: expr, accept: one, reject: zero },
                Span::UNDEFINED,
            )
        } else {
            // Default: select(0.0f, 1.0f, condition)
            let zero = ctx.expressions.append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED);
            let one = ctx.expressions.append(NagaExpr::Literal(Literal::F32(1.0)), Span::UNDEFINED);
            ctx.expressions.append(
                NagaExpr::Select { condition: expr, accept: one, reject: zero },
                Span::UNDEFINED,
            )
        }
    }

    /// Coerce a value to the target type if needed
    /// - Scalar int → scalar float
    /// - Scalar float → scalar int
    /// - Scalar → vector (splat)
    pub(super) fn coerce_scalar_to_vector(
        &mut self,
        value: Handle<NagaExpr>,
        value_type: Option<DctlType>,
        target_type: &DctlType,
        ctx: &mut FunctionContext,
        block: &mut NagaBlock,
    ) -> Handle<NagaExpr> {
        // First, handle scalar int → scalar float coercion
        let value_is_int = matches!(&value_type, Some(DctlType::Int) | Some(DctlType::UInt));
        let value_is_float = matches!(&value_type, Some(DctlType::Float) | Some(DctlType::Double) | Some(DctlType::Half));
        let target_is_float = matches!(target_type, DctlType::Float | DctlType::Double | DctlType::Half);
        let target_is_int = matches!(target_type, DctlType::Int | DctlType::UInt);
        let target_is_vec_float = matches!(
            target_type,
            DctlType::Vec2(ScalarType::Float) | DctlType::Vec3(ScalarType::Float) | DctlType::Vec4(ScalarType::Float)
        );

        // Handle int → float coercion
        let (coerced_value, coerced_type) = if value_is_int && (target_is_float || target_is_vec_float) {
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
            (cast, Some(DctlType::Float))
        // Handle float → int coercion
        } else if value_is_float && target_is_int {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: value,
                    kind: naga::ScalarKind::Sint,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            block.push(
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            );
            (cast, Some(DctlType::Int))
        // Handle int → uint coercion
        } else if matches!(&value_type, Some(DctlType::Int)) && matches!(target_type, DctlType::UInt) {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: value,
                    kind: naga::ScalarKind::Uint,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            block.push(
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            );
            (cast, Some(DctlType::UInt))
        // Handle uint → int coercion
        } else if matches!(&value_type, Some(DctlType::UInt)) && matches!(target_type, DctlType::Int) {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: value,
                    kind: naga::ScalarKind::Sint,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            block.push(
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            );
            (cast, Some(DctlType::Int))
        // Handle int → bool coercion (e.g., bool flag = 0 or flag = 1)
        } else if value_is_int && matches!(target_type, DctlType::Bool) {
            let zero = ctx.expressions.append(
                NagaExpr::Literal(Literal::I32(0)),
                Span::UNDEFINED,
            );
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
            (bool_expr, Some(DctlType::Bool))
        // Handle bool → int coercion (e.g., int h = (comparison_expr))
        } else if matches!(&value_type, Some(DctlType::Bool)) && target_is_int {
            let zero = ctx.expressions.append(
                NagaExpr::Literal(Literal::I32(0)),
                Span::UNDEFINED,
            );
            let one = ctx.expressions.append(
                NagaExpr::Literal(Literal::I32(1)),
                Span::UNDEFINED,
            );
            let select_expr = ctx.expressions.append(
                NagaExpr::Select {
                    condition: value,
                    accept: one,
                    reject: zero,
                },
                Span::UNDEFINED,
            );
            block.push(
                NagaStmt::Emit(naga::Range::new_from_bounds(select_expr, select_expr)),
                Span::UNDEFINED,
            );
            (select_expr, Some(DctlType::Int))
        } else {
            (value, value_type.clone())
        };

        // If target is scalar float and we already coerced, we're done
        if target_is_float {
            return coerced_value;
        }

        // If target is scalar int and we already coerced, we're done
        if target_is_int {
            return coerced_value;
        }

        // If target is scalar bool and we already coerced, we're done
        if matches!(target_type, DctlType::Bool) {
            return coerced_value;
        }

        // Get the size of target vector if any
        let target_size = match target_type {
            DctlType::Vec2(_) => Some(2),
            DctlType::Vec3(_) => Some(3),
            DctlType::Vec4(_) => Some(4),
            _ => None,
        };

        // Check if value is scalar
        let value_is_scalar = match &coerced_type {
            Some(DctlType::Float) | Some(DctlType::Int) | Some(DctlType::UInt) |
            Some(DctlType::Double) | Some(DctlType::Half) => true,
            _ => false,
        };

        // If target is vector and value is scalar, splat
        if let (Some(size), true) = (target_size, value_is_scalar) {
            let type_handle = self.get_or_create_type(target_type);
            let components: Vec<_> = (0..size).map(|_| coerced_value).collect();
            let compose = ctx.expressions.append(
                NagaExpr::Compose {
                    ty: type_handle,
                    components,
                },
                Span::UNDEFINED,
            );
            // Emit the Compose expression
            block.push(
                NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                Span::UNDEFINED,
            );
            return compose;
        }

        coerced_value
    }

    /// Check if an expression handle is already in pending_stmts as an Emit
    fn is_expr_in_pending_stmts(&self, handle: Handle<NagaExpr>, ctx: &FunctionContext) -> bool {
        for (stmt, _) in &ctx.pending_stmts {
            if let NagaStmt::Emit(range) = stmt {
                if let Some((start, end)) = range.first_and_last() {
                    if handle.index() >= start.index() && handle.index() <= end.index() {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Generate an expression
    pub(super) fn generate_expression(
        &mut self,
        expr: &Expression,
        ctx: &mut FunctionContext,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        match expr {
            Expression::Literal(lit) => {
                let literal = match &lit.value {
                    LiteralValue::Int(v) => Literal::I32(*v as i32),
                    LiteralValue::UInt(v) => Literal::U32(*v as u32),
                    LiteralValue::Float(v) => Literal::F32(*v as f32),
                    LiteralValue::Bool(v) => Literal::Bool(*v),
                    LiteralValue::Char(c) => Literal::I32(*c as i32),
                    LiteralValue::String(s) => {
                        // Convert string literal to array<i32, len+1> compose
                        let array_size = s.len() + 1;
                        let elem_type_handle =
                            self.get_or_create_type(&crate::semantic::DctlType::Int);
                        let array_type = self.module.types.insert(
                            naga::Type {
                                name: None,
                                inner: naga::TypeInner::Array {
                                    base: elem_type_handle,
                                    size: naga::ArraySize::Constant(
                                        std::num::NonZeroU32::new(array_size as u32).unwrap(),
                                    ),
                                    stride: 4,
                                },
                            },
                            Span::UNDEFINED,
                        );
                        let mut components = Vec::with_capacity(array_size);
                        for byte in s.bytes() {
                            components.push(ctx.expressions.append(
                                NagaExpr::Literal(Literal::I32(byte as i32)),
                                Span::UNDEFINED,
                            ));
                        }
                        components.push(ctx.expressions.append(
                            NagaExpr::Literal(Literal::I32(0)),
                            Span::UNDEFINED,
                        ));
                        return Ok(ctx.expressions.append(
                            NagaExpr::Compose {
                                ty: array_type,
                                components,
                            },
                            Span::UNDEFINED,
                        ));
                    }
                };
                Ok(ctx
                    .expressions
                    .append(NagaExpr::Literal(literal), Span::UNDEFINED))
            }
            Expression::Identifier(ident) => {
                // Check if it's a pointer alias (local pointer variable)
                // Pointer aliases are returned directly since they ARE the pointer value
                if let Some(&pointer_expr) = ctx.pointer_aliases.get(&ident.name) {
                    return Ok(pointer_expr);
                }

                // Check if it's a local variable
                if let Some(&local_handle) = ctx.local_vars.get(&ident.name) {
                    let pointer = ctx.expressions.append(
                        NagaExpr::LocalVariable(local_handle),
                        Span::UNDEFINED,
                    );
                    return Ok(ctx
                        .expressions
                        .append(NagaExpr::Load { pointer }, Span::UNDEFINED));
                }

                // Check if it's a parameter
                if let Some(&idx) = ctx.param_indices.get(&ident.name) {
                    return Ok(ctx.expressions.append(
                        NagaExpr::FunctionArgument(idx),
                        Span::UNDEFINED,
                    ));
                }

                // Check if it's a global variable
                if let Some(&global_handle) = self.global_handles.get(&ident.name) {
                    let pointer = ctx.expressions.append(
                        NagaExpr::GlobalVariable(global_handle),
                        Span::UNDEFINED,
                    );
                    return Ok(ctx
                        .expressions
                        .append(NagaExpr::Load { pointer }, Span::UNDEFINED));
                }

                // Check uniform buffer member (UI params)
                if let Some(&params_handle) = self.global_handles.get("params") {
                    // Access params.name
                    if let Some(&struct_type) = self.type_handles.get("DctlParams") {
                        if let TypeInner::Struct { ref members, .. } =
                            self.module.types[struct_type].inner
                        {
                            if let Some(idx) =
                                members.iter().position(|m| m.name.as_deref() == Some(ident.name.as_str()))
                            {
                                let base = ctx.expressions.append(
                                    NagaExpr::GlobalVariable(params_handle),
                                    Span::UNDEFINED,
                                );
                                let member_ptr = ctx.expressions.append(
                                    NagaExpr::AccessIndex {
                                        base,
                                        index: idx as u32,
                                    },
                                    Span::UNDEFINED,
                                );
                                return Ok(ctx.expressions.append(
                                    NagaExpr::Load { pointer: member_ptr },
                                    Span::UNDEFINED,
                                ));
                            }
                        }
                    }
                }

                // Check for built-in math constants
                if let Some(value) = self.get_math_constant(&ident.name) {
                    return Ok(ctx.expressions.append(
                        NagaExpr::Literal(Literal::F32(value)),
                        Span::UNDEFINED,
                    ));
                }

                Err(CodegenError::Internal(format!(
                    "Undefined variable: {}",
                    ident.name
                )))
            }
            Expression::Binary(bin) => {
                // Infer types early for array comparison detection
                let left_type = self.infer_expression_type(&bin.left, ctx);
                let right_type = self.infer_expression_type(&bin.right, ctx);

                // Handle array/pointer comparison: in C, `char a[]` params are pointers,
                // `a != b` is pointer comparison. WGSL doesn't support array comparison.
                // Replace with `true` for != and `false` for == (conservative: assume different).
                if matches!(bin.op, BinaryOp::Ne | BinaryOp::Eq) {
                    let either_is_array = matches!(&left_type, Some(DctlType::Array(..)))
                        || matches!(&right_type, Some(DctlType::Array(..)));
                    if either_is_array {
                        let value = matches!(bin.op, BinaryOp::Ne);
                        return Ok(ctx.expressions.append(
                            NagaExpr::Literal(Literal::Bool(value)),
                            Span::UNDEFINED,
                        ));
                    }
                }

                let left = self.generate_expression(&bin.left, ctx)?;
                let right = self.generate_expression(&bin.right, ctx)?;

                // Coerce int to float if needed for arithmetic/comparison operations
                let (left, right) =
                    self.coerce_binary_operands(left, right, left_type.clone(), right_type.clone(), ctx);

                // Handle vector/scalar coercion (splat scalar to vector for ops like vec3 / scalar)
                let right = self.coerce_for_binary_op(left, right, left_type.clone(), right_type.clone(), ctx);
                let left = self.coerce_for_binary_op(right, left, right_type.clone(), left_type.clone(), ctx);

                // For logical operators (&&, ||), coerce int operands to bool
                let (left, right) = if matches!(bin.op, BinaryOp::And | BinaryOp::Or) {
                    let left_is_int = matches!(&left_type, Some(DctlType::Int) | Some(DctlType::UInt));
                    let right_is_int = matches!(&right_type, Some(DctlType::Int) | Some(DctlType::UInt));

                    let new_left = if left_is_int {
                        let zero = ctx.expressions.append(
                            NagaExpr::Literal(Literal::I32(0)),
                            Span::UNDEFINED,
                        );
                        ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::NotEqual,
                                left,
                                right: zero,
                            },
                            Span::UNDEFINED,
                        )
                    } else {
                        left
                    };

                    let new_right = if right_is_int {
                        let zero = ctx.expressions.append(
                            NagaExpr::Literal(Literal::I32(0)),
                            Span::UNDEFINED,
                        );
                        ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::NotEqual,
                                left: right,
                                right: zero,
                            },
                            Span::UNDEFINED,
                        )
                    } else {
                        right
                    };

                    (new_left, new_right)
                } else {
                    (left, right)
                };

                // For arithmetic operators, promote bool operands to numeric type.
                // In C, comparison results (bool) are implicitly int (0/1) and can be
                // used in arithmetic: `(x > 0.04045) * _powf(...)`. WGSL requires explicit conversion.
                let (left, right) = if matches!(bin.op, BinaryOp::Add | BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod) {
                    let new_left = self.coerce_bool_to_numeric(left, &left_type, &right_type, ctx);
                    let new_right = self.coerce_bool_to_numeric(right, &right_type, &left_type, ctx);
                    (new_left, new_right)
                } else {
                    (left, right)
                };

                // For equality/inequality operators, coerce when comparing bool and int
                // DCTL allows: `direction == 1` where direction is bool
                let (left, right) = if matches!(bin.op, BinaryOp::Eq | BinaryOp::Ne) {
                    let left_is_bool = matches!(&left_type, Some(DctlType::Bool));
                    let right_is_bool = matches!(&right_type, Some(DctlType::Bool));
                    let left_is_int = matches!(&left_type, Some(DctlType::Int) | Some(DctlType::UInt));
                    let right_is_int = matches!(&right_type, Some(DctlType::Int) | Some(DctlType::UInt));

                    // If comparing bool with int, convert int to bool (int != 0)
                    if left_is_bool && right_is_int {
                        let zero = ctx.expressions.append(
                            NagaExpr::Literal(Literal::I32(0)),
                            Span::UNDEFINED,
                        );
                        let new_right = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::NotEqual,
                                left: right,
                                right: zero,
                            },
                            Span::UNDEFINED,
                        );
                        (left, new_right)
                    } else if left_is_int && right_is_bool {
                        let zero = ctx.expressions.append(
                            NagaExpr::Literal(Literal::I32(0)),
                            Span::UNDEFINED,
                        );
                        let new_left = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::NotEqual,
                                left,
                                right: zero,
                            },
                            Span::UNDEFINED,
                        );
                        (new_left, right)
                    } else {
                        (left, right)
                    }
                } else {
                    (left, right)
                };

                // For bitwise operators (&, |, ^), coerce bool operands to int
                // WGSL requires both operands to be integers for bitwise operations
                let (left, right) = if matches!(bin.op, BinaryOp::BitAnd | BinaryOp::BitOr | BinaryOp::BitXor) {
                    let left_is_bool = matches!(&left_type, Some(DctlType::Bool));
                    let right_is_bool = matches!(&right_type, Some(DctlType::Bool));
                    let left_is_int = matches!(&left_type, Some(DctlType::Int) | Some(DctlType::UInt));
                    let right_is_int = matches!(&right_type, Some(DctlType::Int) | Some(DctlType::UInt));

                    let new_left = if left_is_bool && right_is_int {
                        // Convert bool to int using select(0i, 1i, condition)
                        let zero = ctx.expressions.append(
                            NagaExpr::Literal(Literal::I32(0)),
                            Span::UNDEFINED,
                        );
                        let one = ctx.expressions.append(
                            NagaExpr::Literal(Literal::I32(1)),
                            Span::UNDEFINED,
                        );
                        ctx.expressions.append(
                            NagaExpr::Select {
                                condition: left,
                                accept: one,
                                reject: zero,
                            },
                            Span::UNDEFINED,
                        )
                    } else {
                        left
                    };

                    let new_right = if right_is_bool && left_is_int {
                        // Convert bool to int using select(0i, 1i, condition)
                        let zero = ctx.expressions.append(
                            NagaExpr::Literal(Literal::I32(0)),
                            Span::UNDEFINED,
                        );
                        let one = ctx.expressions.append(
                            NagaExpr::Literal(Literal::I32(1)),
                            Span::UNDEFINED,
                        );
                        ctx.expressions.append(
                            NagaExpr::Select {
                                condition: right,
                                accept: one,
                                reject: zero,
                            },
                            Span::UNDEFINED,
                        )
                    } else {
                        right
                    };

                    (new_left, new_right)
                } else {
                    (left, right)
                };

                let op = match bin.op {
                    BinaryOp::Add => BinaryOperator::Add,
                    BinaryOp::Sub => BinaryOperator::Subtract,
                    BinaryOp::Mul => BinaryOperator::Multiply,
                    BinaryOp::Div => BinaryOperator::Divide,
                    BinaryOp::Mod => BinaryOperator::Modulo,
                    BinaryOp::Eq => BinaryOperator::Equal,
                    BinaryOp::Ne => BinaryOperator::NotEqual,
                    BinaryOp::Lt => BinaryOperator::Less,
                    BinaryOp::Le => BinaryOperator::LessEqual,
                    BinaryOp::Gt => BinaryOperator::Greater,
                    BinaryOp::Ge => BinaryOperator::GreaterEqual,
                    BinaryOp::And => BinaryOperator::LogicalAnd,
                    BinaryOp::Or => BinaryOperator::LogicalOr,
                    BinaryOp::BitAnd => BinaryOperator::And,
                    BinaryOp::BitOr => BinaryOperator::InclusiveOr,
                    BinaryOp::BitXor => BinaryOperator::ExclusiveOr,
                    BinaryOp::Shl => BinaryOperator::ShiftLeft,
                    BinaryOp::Shr => BinaryOperator::ShiftRight,
                };

                // For shift operations, WGSL requires the shift amount (right operand) to be unsigned
                let right = if matches!(bin.op, BinaryOp::Shl | BinaryOp::Shr) {
                    let right_type = self.infer_expression_type(&bin.right, ctx);
                    if matches!(right_type, Some(DctlType::Int)) {
                        let coerced = ctx.expressions.append(
                            NagaExpr::As {
                                expr: right,
                                kind: naga::ScalarKind::Uint,
                                convert: Some(4),
                            },
                            Span::UNDEFINED,
                        );
                        ctx.pending_stmts.push((
                            NagaStmt::Emit(naga::Range::new_from_bounds(coerced, coerced)),
                            Span::UNDEFINED,
                        ));
                        coerced
                    } else {
                        right
                    }
                } else {
                    right
                };

                Ok(ctx.expressions.append(
                    NagaExpr::Binary { op, left, right },
                    Span::UNDEFINED,
                ))
            }
            Expression::Unary(unary) => {
                match unary.op {
                    UnaryOp::Neg => {
                        let operand = self.generate_expression(&unary.operand, ctx)?;
                        Ok(ctx.expressions.append(
                            NagaExpr::Unary {
                                op: UnaryOperator::Negate,
                                expr: operand,
                            },
                            Span::UNDEFINED,
                        ))
                    }
                    UnaryOp::Not => {
                        let operand = self.generate_expression(&unary.operand, ctx)?;
                        // DCTL allows !int, WGSL requires bool. Coerce int to bool if needed.
                        let operand_type = self.infer_expression_type(&unary.operand, ctx);
                        let is_int = matches!(&operand_type, Some(DctlType::Int) | Some(DctlType::UInt));
                        let bool_operand = if is_int {
                            // Convert int to bool: int != 0
                            let zero = ctx.expressions.append(
                                NagaExpr::Literal(Literal::I32(0)),
                                Span::UNDEFINED,
                            );
                            ctx.expressions.append(
                                NagaExpr::Binary {
                                    op: BinaryOperator::NotEqual,
                                    left: operand,
                                    right: zero,
                                },
                                Span::UNDEFINED,
                            )
                        } else {
                            operand
                        };
                        Ok(ctx.expressions.append(
                            NagaExpr::Unary {
                                op: UnaryOperator::LogicalNot,
                                expr: bool_operand,
                            },
                            Span::UNDEFINED,
                        ))
                    }
                    UnaryOp::BitNot => {
                        let operand = self.generate_expression(&unary.operand, ctx)?;
                        Ok(ctx.expressions.append(
                            NagaExpr::Unary {
                                op: UnaryOperator::BitwiseNot,
                                expr: operand,
                            },
                            Span::UNDEFINED,
                        ))
                    }
                    // Dereference: *ptr -> Load { pointer }
                    UnaryOp::Deref => {
                        // Check for type punning pattern: *((T*)&var) -> bitcast<T>(var)
                        // This is a common C idiom for reinterpreting bits between types
                        if let Expression::Cast(cast) = &*unary.operand {
                            if cast.target_type.is_pointer {
                                // This is a pointer cast like (T*)...
                                if let Expression::Unary(addr_of) = &*cast.operand {
                                    if matches!(addr_of.op, UnaryOp::AddrOf) {
                                        // Pattern: *((T*)&var) - type punning
                                        // Generate bitcast<T>(var)
                                        let var_expr = self.generate_expression(&addr_of.operand, ctx)?;
                                        let target_type = self.convert_ast_type(&Type {
                                            base: cast.target_type.base.clone(),
                                            is_pointer: false,
                                            is_const: false,
                                            array_dims: vec![],
                                        });
                                        let type_handle = self.get_or_create_type(&target_type);

                                        return Ok(ctx.expressions.append(
                                            NagaExpr::As {
                                                expr: var_expr,
                                                kind: match &self.module.types[type_handle].inner {
                                                    TypeInner::Scalar(s) => s.kind,
                                                    _ => naga::ScalarKind::Uint,
                                                },
                                                convert: None, // bitcast, not convert
                                            },
                                            Span::UNDEFINED,
                                        ));
                                    }
                                }
                            }
                        }

                        // Normal pointer dereference
                        let pointer = self.generate_lvalue(&unary.operand, ctx)?;
                        Ok(ctx.expressions.append(
                            NagaExpr::Load { pointer },
                            Span::UNDEFINED,
                        ))
                    }
                    // Address-of: &var -> Just return the pointer to the variable
                    UnaryOp::AddrOf => {
                        // The lvalue is already a pointer expression
                        self.generate_lvalue(&unary.operand, ctx)
                    }
                    // Pre-increment: ++x -> (x = x + 1, return new value)
                    UnaryOp::PreInc => {
                        // Create Literal FIRST (before Load) so it's not between Load and Binary
                        // This avoids potential issues with Naga's emit range validation
                        let operand_type = self.infer_expression_type(&unary.operand, ctx);
                        let one = match &operand_type {
                            Some(DctlType::Float) | Some(DctlType::Double) | Some(DctlType::Half) => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::F32(1.0)), Span::UNDEFINED)
                            }
                            Some(DctlType::UInt) => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::U32(1)), Span::UNDEFINED)
                            }
                            _ => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::I32(1)), Span::UNDEFINED)
                            }
                        };

                        let pointer = self.generate_lvalue(&unary.operand, ctx)?;
                        let current = ctx.expressions.append(
                            NagaExpr::Load { pointer },
                            Span::UNDEFINED,
                        );

                        let incremented = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::Add,
                                left: current,
                                right: one,
                            },
                            Span::UNDEFINED,
                        );

                        // Now emit current and incremented as a contiguous range (no Literal between them)
                        ctx.pending_stmts.push((
                            NagaStmt::Emit(naga::Range::new_from_bounds(current, incremented)),
                            Span::UNDEFINED,
                        ));
                        ctx.pending_stmts.push((
                            NagaStmt::Store {
                                pointer,
                                value: incremented,
                            },
                            Span::UNDEFINED,
                        ));

                        // Return incremented - it's in pending_stmts emit range
                        Ok(incremented)
                    }
                    // Post-increment: x++ -> (save old, x = x + 1, return old)
                    UnaryOp::PostInc => {
                        // Create Literal FIRST (before Load) so it's not between Load and Binary
                        // This avoids issues with Naga's emit range validation
                        let operand_type = self.infer_expression_type(&unary.operand, ctx);
                        let one = match &operand_type {
                            Some(DctlType::Float) | Some(DctlType::Double) | Some(DctlType::Half) => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::F32(1.0)), Span::UNDEFINED)
                            }
                            Some(DctlType::UInt) => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::U32(1)), Span::UNDEFINED)
                            }
                            _ => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::I32(1)), Span::UNDEFINED)
                            }
                        };

                        let pointer = self.generate_lvalue(&unary.operand, ctx)?;
                        let current = ctx.expressions.append(
                            NagaExpr::Load { pointer },
                            Span::UNDEFINED,
                        );

                        let incremented = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::Add,
                                left: current,
                                right: one,
                            },
                            Span::UNDEFINED,
                        );

                        // Emit current and incremented as a contiguous range (no Literal between them)
                        ctx.pending_stmts.push((
                            NagaStmt::Emit(naga::Range::new_from_bounds(current, incremented)),
                            Span::UNDEFINED,
                        ));
                        ctx.pending_stmts.push((
                            NagaStmt::Store {
                                pointer,
                                value: incremented,
                            },
                            Span::UNDEFINED,
                        ));

                        // Return current - it's in pending_stmts emit range
                        Ok(current)
                    }
                    // Pre-decrement: --x -> (x = x - 1, return new value)
                    UnaryOp::PreDec => {
                        // Create Literal FIRST (before Load) so it's not between Load and Binary
                        // This avoids issues with Naga's emit range validation
                        let operand_type = self.infer_expression_type(&unary.operand, ctx);
                        let one = match &operand_type {
                            Some(DctlType::Float) | Some(DctlType::Double) | Some(DctlType::Half) => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::F32(1.0)), Span::UNDEFINED)
                            }
                            Some(DctlType::UInt) => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::U32(1)), Span::UNDEFINED)
                            }
                            _ => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::I32(1)), Span::UNDEFINED)
                            }
                        };

                        let pointer = self.generate_lvalue(&unary.operand, ctx)?;
                        let current = ctx.expressions.append(
                            NagaExpr::Load { pointer },
                            Span::UNDEFINED,
                        );

                        let decremented = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::Subtract,
                                left: current,
                                right: one,
                            },
                            Span::UNDEFINED,
                        );

                        // Emit current and decremented as a contiguous range (no Literal between them)
                        ctx.pending_stmts.push((
                            NagaStmt::Emit(naga::Range::new_from_bounds(current, decremented)),
                            Span::UNDEFINED,
                        ));
                        ctx.pending_stmts.push((
                            NagaStmt::Store {
                                pointer,
                                value: decremented,
                            },
                            Span::UNDEFINED,
                        ));

                        // Return decremented - it's in pending_stmts emit range
                        Ok(decremented)
                    }
                    // Post-decrement: x-- -> (save old, x = x - 1, return old)
                    UnaryOp::PostDec => {
                        // Create Literal FIRST (before Load) so it's not between Load and Binary
                        // This avoids issues with Naga's emit range validation
                        let operand_type = self.infer_expression_type(&unary.operand, ctx);
                        let one = match &operand_type {
                            Some(DctlType::Float) | Some(DctlType::Double) | Some(DctlType::Half) => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::F32(1.0)), Span::UNDEFINED)
                            }
                            Some(DctlType::UInt) => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::U32(1)), Span::UNDEFINED)
                            }
                            _ => {
                                ctx.expressions.append(NagaExpr::Literal(Literal::I32(1)), Span::UNDEFINED)
                            }
                        };

                        let pointer = self.generate_lvalue(&unary.operand, ctx)?;
                        let current = ctx.expressions.append(
                            NagaExpr::Load { pointer },
                            Span::UNDEFINED,
                        );

                        let decremented = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::Subtract,
                                left: current,
                                right: one,
                            },
                            Span::UNDEFINED,
                        );

                        // Emit current and decremented as a contiguous range (no Literal between them)
                        ctx.pending_stmts.push((
                            NagaStmt::Emit(naga::Range::new_from_bounds(current, decremented)),
                            Span::UNDEFINED,
                        ));
                        ctx.pending_stmts.push((
                            NagaStmt::Store {
                                pointer,
                                value: decremented,
                            },
                            Span::UNDEFINED,
                        ));

                        // Return current - it's in pending_stmts emit range
                        Ok(current)
                    }
                }
            }
            Expression::Ternary(ternary) => {
                let condition_expr = self.generate_expression(&ternary.condition, ctx)?;
                let then_expr = self.generate_expression(&ternary.then_expr, ctx)?;
                let else_expr = self.generate_expression(&ternary.else_expr, ctx)?;

                // Coerce non-bool condition to bool if needed
                let condition_type = self.infer_expression_type(&ternary.condition, ctx);
                let condition = match condition_type {
                    Some(DctlType::Int) | Some(DctlType::UInt) | None => {
                        // None case: treat as int (common for struct member access)
                        let zero = ctx.expressions.append(
                            NagaExpr::Literal(Literal::I32(0)),
                            Span::UNDEFINED,
                        );
                        ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::NotEqual,
                                left: condition_expr,
                                right: zero,
                            },
                            Span::UNDEFINED,
                        )
                    }
                    Some(DctlType::Float) => {
                        let zero = ctx.expressions.append(
                            NagaExpr::Literal(Literal::F32(0.0)),
                            Span::UNDEFINED,
                        );
                        ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::NotEqual,
                                left: condition_expr,
                                right: zero,
                            },
                            Span::UNDEFINED,
                        )
                    }
                    _ => condition_expr,  // Bool - use as-is
                };

                // Get types of both branches
                let then_type = self.infer_expression_type(&ternary.then_expr, ctx);
                let else_type = self.infer_expression_type(&ternary.else_expr, ctx);

                // Coerce types if needed (e.g., int vs float)
                let (accept, reject) =
                    self.coerce_binary_operands(then_expr, else_expr, then_type, else_type, ctx);

                Ok(ctx.expressions.append(
                    NagaExpr::Select {
                        condition,
                        accept,
                        reject,
                    },
                    Span::UNDEFINED,
                ))
            }
            Expression::Call(call) => {
                self.generate_call_expression(call, ctx)
            }
            Expression::Index(index_expr) => {
                // Check for multi-dimensional array access (e.g., arr[i][j])
                // This is parsed as Index { object: Index { object: Identifier(arr), index: i }, index: j }
                if let Some((array_name, indices)) = self.collect_multidim_indices(expr) {
                    if let Some(dims) = self.multidim_array_dims.get(&array_name).cloned() {
                        if indices.len() == dims.len() {
                            // Compute flat index: i * N + j (for 2D) or i * N * M + j * M + k (for 3D), etc.
                            let flat_index = self.compute_flat_index(&indices, &dims, ctx)?;

                            // Now access the flattened array with the computed index
                            // Check local, pointer param, or global
                            if let Some(&local_handle) = ctx.local_vars.get(&array_name) {
                                let pointer = ctx.expressions.append(
                                    NagaExpr::LocalVariable(local_handle),
                                    Span::UNDEFINED,
                                );
                                let element_ptr = ctx.expressions.append(
                                    NagaExpr::Access { base: pointer, index: flat_index },
                                    Span::UNDEFINED,
                                );
                                return Ok(ctx.expressions.append(
                                    NagaExpr::Load { pointer: element_ptr },
                                    Span::UNDEFINED,
                                ));
                            }
                            if ctx.pointer_params.contains(&array_name) {
                                if let Some(&idx) = ctx.param_indices.get(&array_name) {
                                    let pointer = ctx.expressions.append(
                                        NagaExpr::FunctionArgument(idx),
                                        Span::UNDEFINED,
                                    );
                                    let element_ptr = ctx.expressions.append(
                                        NagaExpr::Access { base: pointer, index: flat_index },
                                        Span::UNDEFINED,
                                    );
                                    return Ok(ctx.expressions.append(
                                        NagaExpr::Load { pointer: element_ptr },
                                        Span::UNDEFINED,
                                    ));
                                }
                            }
                            if let Some(&global_handle) = self.global_handles.get(&array_name) {
                                let pointer = ctx.expressions.append(
                                    NagaExpr::GlobalVariable(global_handle),
                                    Span::UNDEFINED,
                                );
                                let element_ptr = ctx.expressions.append(
                                    NagaExpr::Access { base: pointer, index: flat_index },
                                    Span::UNDEFINED,
                                );
                                return Ok(ctx.expressions.append(
                                    NagaExpr::Load { pointer: element_ptr },
                                    Span::UNDEFINED,
                                ));
                            }
                            // Check if it's a non-pointer function parameter (array by value)
                            if let Some(&idx) = ctx.param_indices.get(&array_name) {
                                let param_expr = ctx.expressions.append(
                                    NagaExpr::FunctionArgument(idx),
                                    Span::UNDEFINED,
                                );
                                let element_expr = ctx.expressions.append(
                                    NagaExpr::Access { base: param_expr, index: flat_index },
                                    Span::UNDEFINED,
                                );
                                return Ok(element_expr);
                            }
                        }
                    }
                }

                // Standard single-dimension index access
                let index = self.generate_expression(&index_expr.index, ctx)?;

                // For array access, we need a pointer to the array, not the loaded value
                // Check if the object is a local variable (array) - use pointer directly
                if let Expression::Identifier(ident) = index_expr.object.as_ref() {
                    // Check if it's a multi-dimensional array pointer alias
                    // e.g., int* ptr = &arr2d[i][0]; ptr[j] -> arr2d[(i * N) + j]
                    if let Some((base_array, base_offset)) =
                        ctx.multidim_ptr_aliases.get(&ident.name).cloned()
                    {
                        // Compute new index = base_offset + index
                        let new_index = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: naga::BinaryOperator::Add,
                                left: base_offset,
                                right: index,
                            },
                            Span::UNDEFINED,
                        );

                        // Get the base array
                        let array_ptr = if let Some(&local_handle) =
                            ctx.local_vars.get(&base_array)
                        {
                            ctx.expressions
                                .append(NagaExpr::LocalVariable(local_handle), Span::UNDEFINED)
                        } else if let Some(&global_handle) = self.global_handles.get(&base_array) {
                            ctx.expressions
                                .append(NagaExpr::GlobalVariable(global_handle), Span::UNDEFINED)
                        } else {
                            return Err(CodegenError::Internal(format!(
                                "Base array for multidim ptr alias not found: {}",
                                base_array
                            )));
                        };

                        // Access the element
                        let element_ptr = ctx.expressions.append(
                            NagaExpr::Access {
                                base: array_ptr,
                                index: new_index,
                            },
                            Span::UNDEFINED,
                        );
                        return Ok(ctx.expressions.append(
                            NagaExpr::Load { pointer: element_ptr },
                            Span::UNDEFINED,
                        ));
                    }

                    // Check if it's a local variable (array copy)
                    if let Some(&local_handle) = ctx.local_vars.get(&ident.name) {
                        let pointer = ctx.expressions.append(
                            NagaExpr::LocalVariable(local_handle),
                            Span::UNDEFINED,
                        );
                        // Access the array element via pointer
                        let element_ptr = ctx.expressions.append(
                            NagaExpr::Access { base: pointer, index },
                            Span::UNDEFINED,
                        );
                        // Load the element value
                        return Ok(ctx.expressions.append(
                            NagaExpr::Load { pointer: element_ptr },
                            Span::UNDEFINED,
                        ));
                    }
                    // Check if it's a pointer parameter (e.g., float* arr)
                    // Pointer parameters are FunctionArguments that ARE pointers
                    if ctx.pointer_params.contains(&ident.name) {
                        if let Some(&idx) = ctx.param_indices.get(&ident.name) {
                            let pointer = ctx.expressions.append(
                                NagaExpr::FunctionArgument(idx),
                                Span::UNDEFINED,
                            );
                            // Access the element via pointer
                            let element_ptr = ctx.expressions.append(
                                NagaExpr::Access { base: pointer, index },
                                Span::UNDEFINED,
                            );
                            // Load the element value
                            return Ok(ctx.expressions.append(
                                NagaExpr::Load { pointer: element_ptr },
                                Span::UNDEFINED,
                            ));
                        }
                    }
                    // Check if it's a global variable
                    if let Some(&global_handle) = self.global_handles.get(&ident.name) {
                        let pointer = ctx.expressions.append(
                            NagaExpr::GlobalVariable(global_handle),
                            Span::UNDEFINED,
                        );
                        let element_ptr = ctx.expressions.append(
                            NagaExpr::Access { base: pointer, index },
                            Span::UNDEFINED,
                        );
                        return Ok(ctx.expressions.append(
                            NagaExpr::Load { pointer: element_ptr },
                            Span::UNDEFINED,
                        ));
                    }
                }

                // Default case: generate the base expression normally
                let base = self.generate_expression(&index_expr.object, ctx)?;
                Ok(ctx.expressions.append(
                    NagaExpr::Access { base, index },
                    Span::UNDEFINED,
                ))
            }
            Expression::Member(member) => {
                // Handle arrow access (ptr->member) - need to access member through pointer then load
                if member.is_arrow {
                    // Get the type of the pointer object
                    if let Some(base_type) = self.infer_expression_type(&member.object, ctx) {
                        if let DctlType::Pointer(inner) = base_type {
                            // If pointing to a struct, access member through pointer then load
                            if let DctlType::Struct(struct_name) = inner.as_ref() {
                                if let Some(members) = self.struct_members.get(struct_name) {
                                    if let Some(&member_index) = members.get(&member.member) {
                                        // Generate pointer expression (ptr to struct)
                                        let ptr_expr = self.generate_expression(&member.object, ctx)?;
                                        // AccessIndex on pointer gives pointer to member
                                        let member_ptr = ctx.expressions.append(
                                            NagaExpr::AccessIndex {
                                                base: ptr_expr,
                                                index: member_index,
                                            },
                                            Span::UNDEFINED,
                                        );
                                        // Load (dereference) the member pointer to get the value
                                        return Ok(ctx.expressions.append(
                                            NagaExpr::Load { pointer: member_ptr },
                                            Span::UNDEFINED,
                                        ));
                                    }
                                }
                                return Err(CodegenError::Internal(format!(
                                    "Unknown struct member: {}.{} (arrow access)",
                                    struct_name, member.member
                                )));
                            }

                            // Handle vector pointer (ptr->x, ptr->y, ptr->z, ptr->w)
                            let is_vector = matches!(
                                inner.as_ref(),
                                DctlType::Vec2(_) | DctlType::Vec3(_) | DctlType::Vec4(_)
                            );
                            if is_vector {
                                if let Some(swizzle) = self.parse_swizzle(&member.member) {
                                    if swizzle.len() == 1 {
                                        // Generate pointer expression
                                        let ptr_expr = self.generate_expression(&member.object, ctx)?;
                                        // AccessIndex on pointer gives pointer to component
                                        let component_ptr = ctx.expressions.append(
                                            NagaExpr::AccessIndex {
                                                base: ptr_expr,
                                                index: swizzle[0] as u32,
                                            },
                                            Span::UNDEFINED,
                                        );
                                        // Load the component value
                                        return Ok(ctx.expressions.append(
                                            NagaExpr::Load { pointer: component_ptr },
                                            Span::UNDEFINED,
                                        ));
                                    }
                                }
                                return Err(CodegenError::UnsupportedFeature(format!(
                                    "Arrow access to multi-component swizzle: {}->{}",
                                    format!("{:?}", member.object), member.member
                                )));
                            }
                        }
                    }
                    // Arrow access on non-pointer or unknown type
                    return Err(CodegenError::UnsupportedFeature(format!(
                        "Arrow access on non-pointer type: {}->{}",
                        format!("{:?}", member.object), member.member
                    )));
                }

                // First, check if base is a struct variable
                let struct_type_name = self.get_variable_struct_type(&member.object, ctx);

                if let Some(struct_name) = struct_type_name {
                    // This is a struct member access
                    if let Some(members) = self.struct_members.get(&struct_name) {
                        if let Some(&member_index) = members.get(&member.member) {
                            let base = self.generate_expression(&member.object, ctx)?;
                            return Ok(ctx.expressions.append(
                                NagaExpr::AccessIndex {
                                    base,
                                    index: member_index,
                                },
                                Span::UNDEFINED,
                            ));
                        }
                    }
                    return Err(CodegenError::Internal(format!(
                        "Unknown struct member: {}.{}",
                        struct_name, member.member
                    )));
                }

                // If not a struct variable, try to infer the type (handles function call results)
                if let Some(base_type) = self.infer_expression_type(&member.object, ctx) {
                    if let DctlType::Struct(struct_name) = base_type {
                        if let Some(members) = self.struct_members.get(&struct_name) {
                            if let Some(&member_index) = members.get(&member.member) {
                                let base = self.generate_expression(&member.object, ctx)?;
                                return Ok(ctx.expressions.append(
                                    NagaExpr::AccessIndex {
                                        base,
                                        index: member_index,
                                    },
                                    Span::UNDEFINED,
                                ));
                            }
                        }
                        return Err(CodegenError::Internal(format!(
                            "Unknown struct member: {}.{}",
                            struct_name, member.member
                        )));
                    }
                }

                let base = self.generate_expression(&member.object, ctx)?;

                // Handle swizzle access (e.g., vec.xyz, vec.x)
                if let Some(swizzle) = self.parse_swizzle(&member.member) {
                    if swizzle.len() == 1 {
                        // Single component access
                        Ok(ctx.expressions.append(
                            NagaExpr::AccessIndex {
                                base,
                                index: swizzle[0] as u32,
                            },
                            Span::UNDEFINED,
                        ))
                    } else {
                        // Swizzle
                        Ok(ctx.expressions.append(
                            NagaExpr::Swizzle {
                                size: match swizzle.len() {
                                    2 => naga::VectorSize::Bi,
                                    3 => naga::VectorSize::Tri,
                                    4 => naga::VectorSize::Quad,
                                    _ => naga::VectorSize::Bi,
                                },
                                vector: base,
                                pattern: [
                                    swizzle.first().copied().unwrap_or(naga::SwizzleComponent::X),
                                    swizzle.get(1).copied().unwrap_or(naga::SwizzleComponent::X),
                                    swizzle.get(2).copied().unwrap_or(naga::SwizzleComponent::X),
                                    swizzle.get(3).copied().unwrap_or(naga::SwizzleComponent::X),
                                ],
                            },
                            Span::UNDEFINED,
                        ))
                    }
                } else {
                    // Unknown member access
                    Err(CodegenError::UnsupportedFeature(format!(
                        "Unknown member access: {}",
                        member.member
                    )))
                }
            }
            Expression::Cast(cast) => {
                let operand = self.generate_expression(&cast.operand, ctx)?;
                let target_type = self.convert_ast_type(&cast.target_type);
                let type_handle = self.get_or_create_type(&target_type);

                // Check what kind of cast this is
                match &self.module.types[type_handle].inner {
                    TypeInner::Scalar(scalar) => Ok(ctx.expressions.append(
                        NagaExpr::As {
                            expr: operand,
                            kind: scalar.kind,
                            convert: Some(scalar.width),
                        },
                        Span::UNDEFINED,
                    )),
                    TypeInner::Vector { scalar, .. } => Ok(ctx.expressions.append(
                        NagaExpr::As {
                            expr: operand,
                            kind: scalar.kind,
                            convert: Some(scalar.width),
                        },
                        Span::UNDEFINED,
                    )),
                    _ => Err(CodegenError::UnsupportedFeature(format!(
                        "Unsupported cast target type: {:?}",
                        target_type
                    ))),
                }
            }
            Expression::Assignment(assign) => {
                // When assignment appears as an expression (e.g., h = s = 0),
                // we need to generate the Store and return the assigned value.
                let value = self.generate_expression(&assign.right, ctx)?;

                // Get pointer to left side
                let pointer = self.generate_lvalue(&assign.left, ctx)?;

                // Get types for coercion
                let left_type = self.infer_expression_type(&assign.left, ctx);
                let right_type = self.infer_expression_type(&assign.right, ctx);

                // Handle compound assignments
                let final_value = match assign.op {
                    AssignmentOp::Assign => {
                        // Apply type coercion for assignment in expression context
                        self.coerce_for_assign_expr(value, left_type.clone(), right_type, ctx)
                    }
                    op => {
                        let current = ctx
                            .expressions
                            .append(NagaExpr::Load { pointer }, Span::UNDEFINED);
                        // Emit the load
                        ctx.pending_stmts.push((
                            NagaStmt::Emit(naga::Range::new_from_bounds(current, current)),
                            Span::UNDEFINED,
                        ));
                        let binary_op = match op {
                            AssignmentOp::AddAssign => BinaryOperator::Add,
                            AssignmentOp::SubAssign => BinaryOperator::Subtract,
                            AssignmentOp::MulAssign => BinaryOperator::Multiply,
                            AssignmentOp::DivAssign => BinaryOperator::Divide,
                            AssignmentOp::ModAssign => BinaryOperator::Modulo,
                            AssignmentOp::BitAndAssign => BinaryOperator::And,
                            AssignmentOp::BitOrAssign => BinaryOperator::InclusiveOr,
                            AssignmentOp::BitXorAssign => BinaryOperator::ExclusiveOr,
                            AssignmentOp::ShlAssign => BinaryOperator::ShiftLeft,
                            AssignmentOp::ShrAssign => BinaryOperator::ShiftRight,
                            _ => unreachable!(),
                        };
                        let result = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: binary_op,
                                left: current,
                                right: value,
                            },
                            Span::UNDEFINED,
                        );
                        // Emit the binary result
                        ctx.pending_stmts.push((
                            NagaStmt::Emit(naga::Range::new_from_bounds(result, result)),
                            Span::UNDEFINED,
                        ));
                        result
                    }
                };

                // Emit the value if needed and not already emitted
                // Check if final_value is already in pending_stmts (from coercion, compound assignment,
                // or chained assignment from inner assignment expression)
                let already_emitted = self.is_expr_in_pending_stmts(final_value, ctx);
                if !already_emitted && self.needs_emit(&ctx.expressions[final_value]) {
                    ctx.pending_stmts.push((
                        NagaStmt::Emit(naga::Range::new_from_bounds(final_value, final_value)),
                        Span::UNDEFINED,
                    ));
                }

                // Create the Store statement for this assignment
                ctx.pending_stmts.push((
                    NagaStmt::Store {
                        pointer,
                        value: final_value,
                    },
                    Span::UNDEFINED,
                ));

                // Return the assigned value (for chained assignments like h = s = 0)
                Ok(final_value)
            }
            Expression::Sizeof(sizeof_expr) => {
                // Calculate sizeof at compile time and return as a constant
                let size = match &sizeof_expr.operand {
                    crate::parser::SizeofOperand::Type(t) => {
                        let dctl_type = self.convert_ast_type(t);
                        self.type_size(&dctl_type)
                    }
                    crate::parser::SizeofOperand::Expression(expr) => {
                        // Infer the type of the expression and get its size
                        if let Some(dctl_type) = self.infer_expression_type(expr, ctx) {
                            self.type_size(&dctl_type)
                        } else {
                            // For global constant arrays, try to look them up
                            if let Expression::Identifier(ident) = expr.as_ref() {
                                if let Some((size, _)) = self.global_array_sizes.get(&ident.name) {
                                    *size as u32
                                } else {
                                    return Err(CodegenError::UnsupportedFeature(format!(
                                        "sizeof({}) - cannot determine size, unknown expression type",
                                        ident.name
                                    )));
                                }
                            } else {
                                return Err(CodegenError::UnsupportedFeature(
                                    "sizeof - cannot determine expression type".to_string(),
                                ));
                            }
                        }
                    }
                };

                // Return sizeof as a constant u32
                let const_value = ctx.expressions.append(
                    NagaExpr::Literal(naga::Literal::U32(size)),
                    Span::UNDEFINED,
                );
                Ok(const_value)
            }
            Expression::Comma(comma) => {
                // Evaluate all expressions, return last
                // For assignments within comma, we need to create Store statements
                // These are added to pending_stmts and will be flushed later
                let mut last = None;
                for e in &comma.expressions {
                    // Check if this is an assignment - if so, we need to handle Store
                    if let Expression::Assignment(assign) = e {
                        // Generate the value (right side)
                        let value = self.generate_expression(&assign.right, ctx)?;

                        // Emit the value expression if needed (e.g., Compose from make_float3)
                        if self.needs_emit(&ctx.expressions[value]) {
                            ctx.pending_stmts.push((
                                NagaStmt::Emit(naga::Range::new_from_bounds(value, value)),
                                Span::UNDEFINED,
                            ));
                        }

                        // Generate pointer to left side
                        let pointer = self.generate_lvalue(&assign.left, ctx)?;

                        // Get types for potential coercion
                        let left_type = self.infer_expression_type(&assign.left, ctx);
                        let right_type = self.infer_expression_type(&assign.right, ctx);

                        // Handle compound assignments
                        let final_value = match assign.op {
                            AssignmentOp::Assign => {
                                // Apply int→float coercion for simple assignments
                                let left_is_float = matches!(
                                    left_type,
                                    Some(DctlType::Float) | Some(DctlType::Double) | Some(DctlType::Half)
                                );
                                let left_is_vec_float = matches!(
                                    left_type,
                                    Some(DctlType::Vec2(ScalarType::Float)) |
                                    Some(DctlType::Vec3(ScalarType::Float)) |
                                    Some(DctlType::Vec4(ScalarType::Float))
                                );
                                let right_is_int = matches!(
                                    right_type,
                                    Some(DctlType::Int) | Some(DctlType::UInt)
                                );

                                if (left_is_float || left_is_vec_float) && right_is_int {
                                    let cast = ctx.expressions.append(
                                        NagaExpr::As {
                                            expr: value,
                                            kind: naga::ScalarKind::Float,
                                            convert: Some(4),
                                        },
                                        Span::UNDEFINED,
                                    );
                                    ctx.pending_stmts.push((
                                        NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                                        Span::UNDEFINED,
                                    ));
                                    cast
                                } else {
                                    value
                                }
                            }
                            op => {
                                // Compound assignment: load, compute, then store
                                let current = ctx.expressions.append(
                                    NagaExpr::Load { pointer },
                                    Span::UNDEFINED,
                                );
                                ctx.pending_stmts.push((
                                    NagaStmt::Emit(naga::Range::new_from_bounds(current, current)),
                                    Span::UNDEFINED,
                                ));

                                let binary_op = match op {
                                    AssignmentOp::AddAssign => BinaryOperator::Add,
                                    AssignmentOp::SubAssign => BinaryOperator::Subtract,
                                    AssignmentOp::MulAssign => BinaryOperator::Multiply,
                                    AssignmentOp::DivAssign => BinaryOperator::Divide,
                                    AssignmentOp::ModAssign => BinaryOperator::Modulo,
                                    AssignmentOp::BitAndAssign => BinaryOperator::And,
                                    AssignmentOp::BitOrAssign => BinaryOperator::InclusiveOr,
                                    AssignmentOp::BitXorAssign => BinaryOperator::ExclusiveOr,
                                    AssignmentOp::ShlAssign => BinaryOperator::ShiftLeft,
                                    AssignmentOp::ShrAssign => BinaryOperator::ShiftRight,
                                    _ => unreachable!(),
                                };

                                // Handle vector/scalar coercion
                                let coerced_value = self.coerce_for_binary_op(
                                    current, value, left_type.clone(), right_type, ctx
                                );

                                let result = ctx.expressions.append(
                                    NagaExpr::Binary {
                                        op: binary_op,
                                        left: current,
                                        right: coerced_value,
                                    },
                                    Span::UNDEFINED,
                                );
                                ctx.pending_stmts.push((
                                    NagaStmt::Emit(naga::Range::new_from_bounds(result, result)),
                                    Span::UNDEFINED,
                                ));
                                result
                            }
                        };

                        // Create Store statement in pending_stmts
                        ctx.pending_stmts.push((
                            NagaStmt::Store {
                                pointer,
                                value: final_value,
                            },
                            Span::UNDEFINED,
                        ));

                        last = Some(final_value);
                    } else {
                        // Non-assignment: just evaluate
                        last = Some(self.generate_expression(e, ctx)?);
                    }
                }
                last.ok_or_else(|| CodegenError::Internal("Empty comma expression".to_string()))
            }
            Expression::InitializerList(init_list) => {
                // Generate as compose expression
                let components: Result<Vec<_>, _> = init_list
                    .elements
                    .iter()
                    .map(|e| self.generate_expression(e, ctx))
                    .collect();

                Ok(ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: self.type_handles["vec3<f32>"], // Default, should infer type
                        components: components?,
                    },
                    Span::UNDEFINED,
                ))
            }
        }
    }

    /// Get struct type name from an expression if it's a struct variable
    pub(super) fn get_variable_struct_type(
        &self,
        expr: &Expression,
        ctx: &FunctionContext,
    ) -> Option<String> {
        match expr {
            Expression::Identifier(ident) => {
                // First check local/parameter variable types (struct names)
                if let Some(struct_name) = ctx.var_types.get(&ident.name) {
                    return Some(struct_name.clone());
                }
                // Then check full type info for direct struct type
                if let Some(dctl_type) = ctx.variable_types.get(&ident.name) {
                    if let DctlType::Struct(name) = dctl_type {
                        return Some(name.clone());
                    }
                    // Also handle pointer to struct (for pointer parameters like char_trans_t*)
                    if let DctlType::Pointer(inner) = dctl_type {
                        if let DctlType::Struct(name) = inner.as_ref() {
                            return Some(name.clone());
                        }
                    }
                }
                // Then check global variable types
                if let Some(dctl_type) = self.global_variable_types.get(&ident.name) {
                    // Extract struct name from DctlType::Struct
                    if let DctlType::Struct(name) = dctl_type {
                        return Some(name.clone());
                    }
                    // Also handle pointer to struct
                    if let DctlType::Pointer(inner) = dctl_type {
                        if let DctlType::Struct(name) = inner.as_ref() {
                            return Some(name.clone());
                        }
                    }
                }
                None
            }
            Expression::Index(index_expr) => {
                // Array of structs - need to get the element type of the array
                // First, check if the base is an identifier with array type
                if let Expression::Identifier(ident) = index_expr.object.as_ref() {
                    // Check local variable types
                    if let Some(dctl_type) = ctx.variable_types.get(&ident.name) {
                        if let DctlType::Array(elem_type, _) = dctl_type {
                            if let DctlType::Struct(name) = elem_type.as_ref() {
                                return Some(name.clone());
                            }
                        }
                    }
                    // Check global variable types
                    if let Some(dctl_type) = self.global_variable_types.get(&ident.name) {
                        if let DctlType::Array(elem_type, _) = dctl_type {
                            if let DctlType::Struct(name) = elem_type.as_ref() {
                                return Some(name.clone());
                            }
                        }
                    }
                }
                // Fall back to recursively checking the base
                self.get_variable_struct_type(&index_expr.object, ctx)
            }
            Expression::Member(member) => {
                // Nested struct access - get the type of the member from the parent struct
                // e.g., for cs.logC_matrix where cs is LogCColorspace, we need to find
                // that logC_matrix has type Matrix
                if let Some(parent_struct_name) = self.get_variable_struct_type(&member.object, ctx) {
                    // Look up the member type in the parent struct
                    if let Some(member_types) = self.struct_member_types.get(&parent_struct_name) {
                        if let Some(member_type) = member_types.get(&member.member) {
                            // If the member is a struct, return its name
                            if let DctlType::Struct(name) = member_type {
                                return Some(name.clone());
                            }
                        }
                    }
                }
                None
            }
            _ => None,
        }
    }

    /// Check if two expressions are structurally equivalent (for lvalue comparison)
    fn exprs_equal(a: &Expression, b: &Expression) -> bool {
        match (a, b) {
            (Expression::Identifier(id_a), Expression::Identifier(id_b)) => {
                id_a.name == id_b.name
            }
            (Expression::Member(mem_a), Expression::Member(mem_b)) => {
                mem_a.member == mem_b.member && Self::exprs_equal(&mem_a.object, &mem_b.object)
            }
            (Expression::Index(idx_a), Expression::Index(idx_b)) => {
                Self::exprs_equal(&idx_a.object, &idx_b.object)
                    && Self::exprs_equal(&idx_a.index, &idx_b.index)
            }
            _ => false,
        }
    }

    /// Transform ternary-as-lvalue pattern if detected
    /// Pattern: `L = (cond ? T : L) = R` -> `L = cond ? T : R`
    ///
    /// This handles a GCC extension where ternary expressions can be lvalues.
    /// DCTL code like: `out.x = cond ? expr1 : out.x = expr2`
    /// parses as: `(out.x = cond ? expr1 : out.x) = expr2`
    /// which we transform to: `out.x = cond ? expr1 : expr2`
    #[allow(dead_code)]
    pub(super) fn try_transform_ternary_lvalue_assign(
        assign: &crate::parser::AssignmentExpr,
    ) -> Option<crate::parser::AssignmentExpr> {
        use crate::parser::{AssignmentExpr, TernaryExpr};

        // Check if right side is an assignment
        if let Expression::Assignment(inner_assign) = assign.right.as_ref() {
            // Check if inner assignment's left side is a ternary
            if let Expression::Ternary(ternary) = inner_assign.left.as_ref() {
                // Check if the ternary's else_expr equals the outer left side
                if Self::exprs_equal(&ternary.else_expr, &assign.left) {
                    // Transform: L = (cond ? T : L) = R -> L = cond ? T : R
                    let new_ternary = TernaryExpr {
                        condition: ternary.condition.clone(),
                        then_expr: ternary.then_expr.clone(),
                        else_expr: inner_assign.right.clone(),
                        loc: ternary.loc.clone(),
                    };
                    return Some(AssignmentExpr {
                        op: assign.op,
                        left: assign.left.clone(),
                        right: Box::new(Expression::Ternary(new_ternary)),
                        loc: assign.loc.clone(),
                    });
                }
            }
        }
        None
    }

    /// Generate an lvalue expression (for assignment targets)
    pub(super) fn generate_lvalue(
        &mut self,
        expr: &Expression,
        ctx: &mut FunctionContext,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        match expr {
            Expression::Identifier(ident) => {
                // Check if it's a pointer alias (local pointer variable)
                // Pointer aliases are returned directly as they ARE the pointer
                if let Some(&pointer_expr) = ctx.pointer_aliases.get(&ident.name) {
                    return Ok(pointer_expr);
                }

                // Check if it's a local variable
                if let Some(&local_handle) = ctx.local_vars.get(&ident.name) {
                    return Ok(ctx.expressions.append(
                        NagaExpr::LocalVariable(local_handle),
                        Span::UNDEFINED,
                    ));
                }

                // Check if it's a pointer parameter
                // Pointer parameters are FunctionArguments that ARE pointers
                if ctx.pointer_params.contains(&ident.name) {
                    if let Some(&idx) = ctx.param_indices.get(&ident.name) {
                        return Ok(ctx.expressions.append(
                            NagaExpr::FunctionArgument(idx),
                            Span::UNDEFINED,
                        ));
                    }
                }

                // Check if it's a global variable
                if let Some(&global_handle) = self.global_handles.get(&ident.name) {
                    return Ok(ctx.expressions.append(
                        NagaExpr::GlobalVariable(global_handle),
                        Span::UNDEFINED,
                    ));
                }

                Err(CodegenError::Internal(format!(
                    "Cannot assign to: {}",
                    ident.name
                )))
            }
            Expression::Index(index_expr) => {
                // Check if this is a multi-dimensional array access
                if let Some((array_name, indices)) = self.collect_multidim_indices(expr) {
                    // Check if we have dimension info for this array
                    if let Some(dims) = self.multidim_array_dims.get(&array_name).cloned() {
                        // Get the base array lvalue
                        let base = if let Some(&local_handle) = ctx.local_vars.get(&array_name) {
                            ctx.expressions.append(
                                NagaExpr::LocalVariable(local_handle),
                                Span::UNDEFINED,
                            )
                        } else if let Some(&global_handle) = self.global_handles.get(&array_name) {
                            ctx.expressions.append(
                                NagaExpr::GlobalVariable(global_handle),
                                Span::UNDEFINED,
                            )
                        } else if let Some(&idx) = ctx.param_indices.get(&array_name) {
                            ctx.expressions.append(
                                NagaExpr::FunctionArgument(idx),
                                Span::UNDEFINED,
                            )
                        } else {
                            return Err(CodegenError::Internal(format!(
                                "Multi-dim array not found: {}",
                                array_name
                            )));
                        };

                        // Compute flat index
                        let flat_index = self.compute_flat_index(&indices, &dims, ctx)?;

                        return Ok(ctx.expressions.append(
                            NagaExpr::Access {
                                base,
                                index: flat_index,
                            },
                            Span::UNDEFINED,
                        ));
                    }
                }

                // Check if base is a multi-dimensional array pointer alias
                if let Expression::Identifier(ident) = index_expr.object.as_ref() {
                    if let Some((base_array, base_offset)) =
                        ctx.multidim_ptr_aliases.get(&ident.name).cloned()
                    {
                        let index = self.generate_expression(&index_expr.index, ctx)?;

                        // Compute new index = base_offset + index
                        let new_index = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: naga::BinaryOperator::Add,
                                left: base_offset,
                                right: index,
                            },
                            Span::UNDEFINED,
                        );

                        // Get the base array
                        let array_ptr = if let Some(&local_handle) =
                            ctx.local_vars.get(&base_array)
                        {
                            ctx.expressions
                                .append(NagaExpr::LocalVariable(local_handle), Span::UNDEFINED)
                        } else if let Some(&global_handle) = self.global_handles.get(&base_array) {
                            ctx.expressions
                                .append(NagaExpr::GlobalVariable(global_handle), Span::UNDEFINED)
                        } else {
                            return Err(CodegenError::Internal(format!(
                                "Base array for multidim ptr alias not found: {}",
                                base_array
                            )));
                        };

                        return Ok(ctx.expressions.append(
                            NagaExpr::Access {
                                base: array_ptr,
                                index: new_index,
                            },
                            Span::UNDEFINED,
                        ));
                    }
                }

                // Default: standard single-dimension index
                let base = self.generate_lvalue(&index_expr.object, ctx)?;
                let index = self.generate_expression(&index_expr.index, ctx)?;

                Ok(ctx
                    .expressions
                    .append(NagaExpr::Access { base, index }, Span::UNDEFINED))
            }
            Expression::Member(member) => {
                // Handle arrow access (ptr->member) - access member through pointer
                if member.is_arrow {
                    if let Some(base_type) = self.infer_expression_type(&member.object, ctx) {
                        if let DctlType::Pointer(inner) = base_type {
                            // Handle struct pointer (ptr->struct_member)
                            if let DctlType::Struct(struct_name) = inner.as_ref() {
                                if let Some(members) = self.struct_members.get(struct_name) {
                                    if let Some(&member_index) = members.get(&member.member) {
                                        // Generate pointer expression (ptr to struct)
                                        let ptr_expr = self.generate_expression(&member.object, ctx)?;
                                        // AccessIndex on pointer gives pointer to member
                                        return Ok(ctx.expressions.append(
                                            NagaExpr::AccessIndex {
                                                base: ptr_expr,
                                                index: member_index,
                                            },
                                            Span::UNDEFINED,
                                        ));
                                    }
                                }
                                return Err(CodegenError::Internal(format!(
                                    "Unknown struct member: {}.{} (arrow lvalue)",
                                    struct_name, member.member
                                )));
                            }

                            // Handle vector pointer (ptr->x, ptr->y, ptr->z, ptr->w)
                            let is_vector = matches!(
                                inner.as_ref(),
                                DctlType::Vec2(_) | DctlType::Vec3(_) | DctlType::Vec4(_)
                            );
                            if is_vector {
                                if let Some(swizzle) = self.parse_swizzle(&member.member) {
                                    if swizzle.len() == 1 {
                                        // Generate pointer expression
                                        let ptr_expr = self.generate_expression(&member.object, ctx)?;
                                        // AccessIndex on pointer gives pointer to component
                                        return Ok(ctx.expressions.append(
                                            NagaExpr::AccessIndex {
                                                base: ptr_expr,
                                                index: swizzle[0] as u32,
                                            },
                                            Span::UNDEFINED,
                                        ));
                                    }
                                }
                                return Err(CodegenError::UnsupportedFeature(format!(
                                    "Arrow access to multi-component swizzle: {}->{}",
                                    format!("{:?}", member.object), member.member
                                )));
                            }
                        }
                    }
                    return Err(CodegenError::UnsupportedFeature(format!(
                        "Arrow lvalue on non-pointer type: {}->{}",
                        format!("{:?}", member.object), member.member
                    )));
                }

                // First, check if base is a struct variable
                let struct_type_name = self.get_variable_struct_type(&member.object, ctx);

                if let Some(struct_name) = struct_type_name {
                    // This is a struct member access
                    if let Some(members) = self.struct_members.get(&struct_name) {
                        if let Some(&member_index) = members.get(&member.member) {
                            let base = self.generate_lvalue(&member.object, ctx)?;
                            return Ok(ctx.expressions.append(
                                NagaExpr::AccessIndex {
                                    base,
                                    index: member_index,
                                },
                                Span::UNDEFINED,
                            ));
                        }
                    }
                    return Err(CodegenError::Internal(format!(
                        "Unknown struct member: {}.{}",
                        struct_name, member.member
                    )));
                }

                // Not a struct, try vector swizzle/component access
                let base = self.generate_lvalue(&member.object, ctx)?;

                // Handle swizzle/component access
                if let Some(swizzle) = self.parse_swizzle(&member.member) {
                    if swizzle.len() == 1 {
                        Ok(ctx.expressions.append(
                            NagaExpr::AccessIndex {
                                base,
                                index: swizzle[0] as u32,
                            },
                            Span::UNDEFINED,
                        ))
                    } else {
                        Err(CodegenError::UnsupportedFeature(
                            "Cannot assign to swizzle".to_string(),
                        ))
                    }
                } else {
                    Err(CodegenError::UnsupportedFeature(format!(
                        "Struct member lvalue: {}",
                        member.member
                    )))
                }
            }
            // Dereference as lvalue: *ptr = value
            // The pointer itself is the target for the store
            Expression::Unary(unary) if matches!(unary.op, UnaryOp::Deref) => {
                // Get the pointer expression - this should be a pointer to a local/global variable
                self.generate_lvalue(&unary.operand, ctx)
            }
            _ => Err(CodegenError::Internal(format!(
                "Invalid lvalue expression: {:?}",
                expr
            ))),
        }
    }
}
