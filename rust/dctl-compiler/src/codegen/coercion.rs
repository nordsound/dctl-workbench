//! Type coercion utilities for DCTL to WGSL conversion
//!
//! Handles automatic type conversions including:
//! - int → float coercion
//! - float → int coercion
//! - scalar → vector splatting
//! - signed/unsigned int coercion
//! - int → bool coercion

use super::naga_module::{FunctionContext, NagaModuleGenerator};
use crate::semantic::{DctlType, ScalarType};
use naga::{
    Block as NagaBlock, BinaryOperator, Expression as NagaExpr, Handle, Literal, Span,
    Statement as NagaStmt,
};

impl NagaModuleGenerator {
    /// Coerce binary operands to compatible types (int -> float when mixed)
    pub(super) fn coerce_binary_operands(
        &self,
        left: Handle<NagaExpr>,
        right: Handle<NagaExpr>,
        left_type: Option<DctlType>,
        right_type: Option<DctlType>,
        ctx: &mut FunctionContext,
    ) -> (Handle<NagaExpr>, Handle<NagaExpr>) {
        // If either type is unknown, don't coerce
        let (Some(lt), Some(rt)) = (left_type, right_type) else {
            return (left, right);
        };

        // Check for scalar int/float mismatch
        let left_is_int = matches!(lt, DctlType::Int | DctlType::UInt);
        let left_is_float = matches!(lt, DctlType::Float | DctlType::Double | DctlType::Half);
        let right_is_int = matches!(rt, DctlType::Int | DctlType::UInt);
        let right_is_float = matches!(rt, DctlType::Float | DctlType::Double | DctlType::Half);

        // Also check for vector int/float mismatch
        let left_is_vec_int = matches!(
            lt,
            DctlType::Vec2(ScalarType::Int)
                | DctlType::Vec3(ScalarType::Int)
                | DctlType::Vec4(ScalarType::Int)
                | DctlType::Vec2(ScalarType::UInt)
                | DctlType::Vec3(ScalarType::UInt)
                | DctlType::Vec4(ScalarType::UInt)
        );
        let left_is_vec_float = matches!(
            lt,
            DctlType::Vec2(ScalarType::Float)
                | DctlType::Vec3(ScalarType::Float)
                | DctlType::Vec4(ScalarType::Float)
        );
        let right_is_vec_int = matches!(
            rt,
            DctlType::Vec2(ScalarType::Int)
                | DctlType::Vec3(ScalarType::Int)
                | DctlType::Vec4(ScalarType::Int)
                | DctlType::Vec2(ScalarType::UInt)
                | DctlType::Vec3(ScalarType::UInt)
                | DctlType::Vec4(ScalarType::UInt)
        );
        let right_is_vec_float = matches!(
            rt,
            DctlType::Vec2(ScalarType::Float)
                | DctlType::Vec3(ScalarType::Float)
                | DctlType::Vec4(ScalarType::Float)
        );

        // Signed vs unsigned int coercion (WGSL requires same kind)
        let left_is_signed = matches!(lt, DctlType::Int);
        let left_is_unsigned = matches!(lt, DctlType::UInt);
        let right_is_signed = matches!(rt, DctlType::Int);
        let right_is_unsigned = matches!(rt, DctlType::UInt);

        // Convert signed to unsigned for comparison (C-style promotion)
        if left_is_signed && right_is_unsigned {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: left,
                    kind: naga::ScalarKind::Uint,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            ));
            return (cast, right);
        }
        if left_is_unsigned && right_is_signed {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: right,
                    kind: naga::ScalarKind::Uint,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            ));
            return (left, cast);
        }

        // Scalar int vs scalar float
        if left_is_int && right_is_float {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: left,
                    kind: naga::ScalarKind::Float,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            ));
            return (cast, right);
        }
        if left_is_float && right_is_int {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: right,
                    kind: naga::ScalarKind::Float,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            ));
            return (left, cast);
        }

        // Vector int vs vector float
        if left_is_vec_int && right_is_vec_float {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: left,
                    kind: naga::ScalarKind::Float,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            ));
            return (cast, right);
        }
        if left_is_vec_float && right_is_vec_int {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: right,
                    kind: naga::ScalarKind::Float,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            ));
            return (left, cast);
        }

        // Scalar int vs vector float (int -> float for scalar-vector ops)
        if left_is_int && right_is_vec_float {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: left,
                    kind: naga::ScalarKind::Float,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            ));
            return (cast, right);
        }
        if left_is_vec_float && right_is_int {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: right,
                    kind: naga::ScalarKind::Float,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            ));
            return (left, cast);
        }

        // Note: Int vs Bool coercion is NOT done here because we don't know the operator.
        // - For bitwise ops (&, |): handled in binary expression generation (bool -> int via select)
        // - For logical ops (&&, ||): handled in logical operator coercion section (int -> bool via != 0)

        (left, right)
    }

    /// Coerce scalar to vector for binary operations if needed
    /// WGSL doesn't support vec / scalar or vec + scalar directly
    /// Also handles scalar int/float type coercion
    /// NOTE: Signed/unsigned int coercion is handled by coerce_binary_operands, NOT here,
    /// because this function is called with swapped arguments for bidirectional scalar-to-vector splatting.
    pub(super) fn coerce_for_binary_op(
        &self,
        _left: Handle<NagaExpr>,
        right: Handle<NagaExpr>,
        left_type: Option<DctlType>,
        right_type: Option<DctlType>,
        ctx: &mut FunctionContext,
    ) -> Handle<NagaExpr> {
        let (Some(lt), Some(rt)) = (left_type.clone(), right_type.clone()) else {
            return right;
        };

        // Handle scalar int/float coercion
        let left_is_float = matches!(lt, DctlType::Float | DctlType::Double | DctlType::Half);
        let left_is_vec_float = matches!(
            lt,
            DctlType::Vec2(ScalarType::Float) | DctlType::Vec3(ScalarType::Float) | DctlType::Vec4(ScalarType::Float)
        );
        let right_is_int = matches!(rt, DctlType::Int | DctlType::UInt);

        // If left is float (scalar or vector) and right is int, coerce right to float
        let coerced_right = if (left_is_float || left_is_vec_float) && right_is_int {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: right,
                    kind: naga::ScalarKind::Float,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            // Add emit for the As expression
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                Span::UNDEFINED,
            ));
            cast
        } else {
            right
        };

        // Check if left is a vector and right is a scalar
        let left_vec_size = match &lt {
            DctlType::Vec2(_) => Some(2),
            DctlType::Vec3(_) => Some(3),
            DctlType::Vec4(_) => Some(4),
            _ => None,
        };

        // After coercion, right is now float if it was int
        let effective_right_type = if (left_is_float || left_is_vec_float) && right_is_int {
            DctlType::Float
        } else {
            rt.clone()
        };

        let right_is_scalar = matches!(
            effective_right_type,
            DctlType::Float | DctlType::Int | DctlType::Double | DctlType::Half | DctlType::UInt
        );

        // If left is vector and right is scalar, splat the scalar to vector
        if let (Some(size), true) = (left_vec_size, right_is_scalar) {
            // Determine the vector size for Splat
            let vec_size = match size {
                2 => naga::VectorSize::Bi,
                3 => naga::VectorSize::Tri,
                4 => naga::VectorSize::Quad,
                _ => return coerced_right, // Can't splat for other sizes
            };

            // Use Splat expression which broadcasts scalar to vector
            let splat = ctx.expressions.append(
                NagaExpr::Splat {
                    size: vec_size,
                    value: coerced_right,
                },
                Span::UNDEFINED,
            );

            // Add emit for the splat expression so it's available for use
            ctx.pending_stmts.push((
                NagaStmt::Emit(naga::Range::new_from_bounds(splat, splat)),
                Span::UNDEFINED,
            ));

            return splat;
        }

        coerced_right
    }

    /// Coerce value for simple assignment (lvalue = rvalue)
    /// Handles int → float and scalar → vector coercion
    pub(super) fn coerce_for_simple_assign(
        &mut self,
        value: Handle<NagaExpr>,
        left_type: Option<DctlType>,
        right_type: Option<DctlType>,
        ctx: &mut FunctionContext,
        block: &mut NagaBlock,
    ) -> Handle<NagaExpr> {
        let (Some(lt), Some(rt)) = (left_type, right_type) else {
            return value;
        };

        // Check if we need int → float coercion
        let left_is_float = matches!(lt, DctlType::Float | DctlType::Double | DctlType::Half);
        let left_is_vec_float = matches!(
            lt,
            DctlType::Vec2(ScalarType::Float) | DctlType::Vec3(ScalarType::Float) | DctlType::Vec4(ScalarType::Float)
        );
        let right_is_int = matches!(rt, DctlType::Int | DctlType::UInt);
        let left_is_int = matches!(lt, DctlType::Int | DctlType::UInt);
        let right_is_float = matches!(rt, DctlType::Float | DctlType::Double | DctlType::Half);

        // Coerce int to float if left is float and right is int
        // Coerce float to int if left is int and right is float
        let (coerced_value, coerced_type) = if (left_is_float || left_is_vec_float) && right_is_int {
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
            (cast, DctlType::Float)
        } else if left_is_int && right_is_float {
            // Float to int coercion (e.g., int_var = float_val)
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
            (cast, DctlType::Int)
        } else if matches!(lt, DctlType::Bool) && right_is_int {
            // Int to bool coercion (e.g., bool_var = int_val)
            // Convert int to bool: int != 0
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
            (bool_expr, DctlType::Bool)
        } else if matches!(lt, DctlType::UInt) && matches!(rt, DctlType::Int) {
            // Int to UInt coercion (e.g., unsigned int j; j = some_int_value)
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
            (cast, DctlType::UInt)
        } else if matches!(lt, DctlType::Int) && matches!(rt, DctlType::UInt) {
            // UInt to Int coercion (e.g., int j; j = some_uint_value)
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
            (cast, DctlType::Int)
        } else {
            (value, rt)
        };

        // Check if we need scalar → vector splat
        let left_vec_size = match &lt {
            DctlType::Vec2(_) => Some(2),
            DctlType::Vec3(_) => Some(3),
            DctlType::Vec4(_) => Some(4),
            _ => None,
        };

        let right_is_scalar = matches!(
            coerced_type,
            DctlType::Float | DctlType::Int | DctlType::UInt | DctlType::Double | DctlType::Half
        );

        if let (Some(size), true) = (left_vec_size, right_is_scalar) {
            let type_handle = self.get_or_create_type(&lt);
            let components: Vec<_> = (0..size).map(|_| coerced_value).collect();
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
            return compose;
        }

        coerced_value
    }

    /// Apply type coercion for assignment in expression context
    /// This is used when assignment appears as an expression (e.g., h = s = 0)
    /// NOTE: This function does NOT emit - caller is responsible for emitting the result
    pub(super) fn coerce_for_assign_expr(
        &mut self,
        value: Handle<NagaExpr>,
        left_type: Option<DctlType>,
        right_type: Option<DctlType>,
        ctx: &mut FunctionContext,
    ) -> Handle<NagaExpr> {
        let (Some(lt), Some(rt)) = (left_type, right_type) else {
            return value;
        };

        // Check if we need int → float coercion
        let left_is_float = matches!(lt, DctlType::Float | DctlType::Double | DctlType::Half);
        let left_is_vec_float = matches!(
            lt,
            DctlType::Vec2(ScalarType::Float) | DctlType::Vec3(ScalarType::Float) | DctlType::Vec4(ScalarType::Float)
        );
        let right_is_int = matches!(rt, DctlType::Int | DctlType::UInt);
        let left_is_int = matches!(lt, DctlType::Int | DctlType::UInt);
        let right_is_float = matches!(rt, DctlType::Float | DctlType::Double | DctlType::Half);

        // Coerce int to float if left is float and right is int
        let (coerced_value, coerced_type) = if (left_is_float || left_is_vec_float) && right_is_int {
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: value,
                    kind: naga::ScalarKind::Float,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            (cast, DctlType::Float)
        } else if left_is_int && right_is_float {
            // Float to int coercion
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: value,
                    kind: naga::ScalarKind::Sint,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            (cast, DctlType::Int)
        } else if matches!(lt, DctlType::Bool) && right_is_int {
            // Int to bool coercion: int != 0
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
            (bool_expr, DctlType::Bool)
        } else if matches!(lt, DctlType::UInt) && matches!(rt, DctlType::Int) {
            // Int to UInt coercion
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: value,
                    kind: naga::ScalarKind::Uint,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            (cast, DctlType::UInt)
        } else if matches!(lt, DctlType::Int) && matches!(rt, DctlType::UInt) {
            // UInt to Int coercion
            let cast = ctx.expressions.append(
                NagaExpr::As {
                    expr: value,
                    kind: naga::ScalarKind::Sint,
                    convert: Some(4),
                },
                Span::UNDEFINED,
            );
            (cast, DctlType::Int)
        } else {
            (value, rt)
        };

        // Check if we need scalar → vector splat
        let left_vec_size = match &lt {
            DctlType::Vec2(_) => Some(2),
            DctlType::Vec3(_) => Some(3),
            DctlType::Vec4(_) => Some(4),
            _ => None,
        };

        let right_is_scalar = matches!(
            coerced_type,
            DctlType::Float | DctlType::Int | DctlType::UInt | DctlType::Double | DctlType::Half
        );

        if let (Some(size), true) = (left_vec_size, right_is_scalar) {
            let type_handle = self.get_or_create_type(&lt);
            let components: Vec<_> = (0..size).map(|_| coerced_value).collect();
            let compose = ctx.expressions.append(
                NagaExpr::Compose {
                    ty: type_handle,
                    components,
                },
                Span::UNDEFINED,
            );
            return compose;
        }

        coerced_value
    }
}
