//! Type inference for DCTL to WGSL
//!
//! This module handles type inference for expressions during code generation.

use naga::{Expression as NagaExpr, Handle, Literal, Scalar, TypeInner};

use super::naga_module::{FunctionContext, FunctionOverload, NagaModuleGenerator};
use crate::parser::{BinaryOp, Expression, LiteralValue, UnaryOp};
use crate::semantic::{DctlType, ScalarType};

impl NagaModuleGenerator {
    /// Resolve the TypeInner of a Naga expression handle (reserved for future use)
    /// Used to determine if an expression is a vector for proper argument coercion
    #[allow(dead_code)]
    pub(super) fn resolve_expr_type_inner(
        &self,
        expr: Handle<NagaExpr>,
        ctx: &FunctionContext,
    ) -> Option<TypeInner> {
        let naga_expr = &ctx.expressions[expr];
        match naga_expr {
            NagaExpr::Literal(lit) => {
                let scalar = match lit {
                    Literal::F32(_) | Literal::F64(_) | Literal::F16(_) => Scalar::F32,
                    Literal::I32(_) => Scalar::I32,
                    Literal::U32(_) => Scalar::U32,
                    Literal::Bool(_) => Scalar::BOOL,
                    Literal::I64(_) => Scalar::I64,
                    Literal::U64(_) => Scalar::U64,
                    Literal::AbstractInt(_) => Scalar::I32,
                    Literal::AbstractFloat(_) => Scalar::F32,
                };
                Some(TypeInner::Scalar(scalar))
            }
            NagaExpr::Compose { ty, .. } => Some(self.module.types[*ty].inner.clone()),
            NagaExpr::Binary { left, .. } => {
                // Binary result type is usually the same as operand types
                self.resolve_expr_type_inner(*left, ctx)
            }
            NagaExpr::Math { arg, fun, .. } => {
                // Most math functions return the same type as the first arg
                // (or scalar for functions like dot, length, distance)
                match fun {
                    naga::MathFunction::Dot
                    | naga::MathFunction::Length
                    | naga::MathFunction::Distance => Some(TypeInner::Scalar(Scalar::F32)),
                    _ => self.resolve_expr_type_inner(*arg, ctx),
                }
            }
            NagaExpr::Load { pointer } => {
                // Follow the pointer to get the pointee type
                self.resolve_expr_type_inner(*pointer, ctx)
            }
            NagaExpr::LocalVariable(_handle) => {
                // Local variable type lookup requires function context
                // For now, return None - this case is handled by other patterns
                None
            }
            NagaExpr::GlobalVariable(handle) => Some(
                self.module.types[self.module.global_variables[*handle].ty]
                    .inner
                    .clone(),
            ),
            NagaExpr::FunctionArgument(_idx) => {
                // Need to look up the function's parameter types
                // For now, return None as this requires function context
                None
            }
            NagaExpr::AccessIndex { base, index } => {
                if let Some(base_type) = self.resolve_expr_type_inner(*base, ctx) {
                    match base_type {
                        TypeInner::Vector { scalar, .. } => Some(TypeInner::Scalar(scalar)),
                        TypeInner::Matrix { rows, scalar, .. } => {
                            Some(TypeInner::Vector { size: rows, scalar })
                        }
                        TypeInner::Struct { members, .. } => members
                            .get(*index as usize)
                            .map(|m| self.module.types[m.ty].inner.clone()),
                        TypeInner::Array { base, .. } => {
                            Some(self.module.types[base].inner.clone())
                        }
                        _ => None,
                    }
                } else {
                    None
                }
            }
            NagaExpr::As {
                expr: _inner,
                kind,
                convert,
            } => {
                // Type conversion - determine result type
                if let Some(convert_width) = convert {
                    Some(TypeInner::Scalar(Scalar {
                        kind: *kind,
                        width: *convert_width,
                    }))
                } else {
                    None
                }
            }
            NagaExpr::Swizzle { size, .. } => Some(TypeInner::Vector {
                size: *size,
                scalar: Scalar::F32,
            }),
            _ => None,
        }
    }

    /// Infer the type of an expression for overload resolution
    pub(super) fn infer_expression_type(
        &self,
        expr: &Expression,
        ctx: &FunctionContext,
    ) -> Option<DctlType> {
        match expr {
            Expression::Literal(lit) => Some(match &lit.value {
                LiteralValue::Int(_) => DctlType::Int,
                LiteralValue::UInt(_) => DctlType::UInt,
                LiteralValue::Float(_) => DctlType::Float,
                LiteralValue::Bool(_) => DctlType::Bool,
                LiteralValue::Char(_) => DctlType::Char,
                LiteralValue::String(s) => DctlType::Array(Box::new(DctlType::Char), Some(s.len() + 1)),
            }),
            Expression::Identifier(ident) => {
                // First check local/parameter variable types
                if let Some(ty) = ctx.variable_types.get(&ident.name) {
                    return Some(ty.clone());
                }
                // Then check uniform parameter types (from DEFINE_UI_PARAMS)
                if let Some(ty) = self.uniform_param_types.get(&ident.name) {
                    return Some(ty.clone());
                }
                // Finally check global variable types
                if let Some(ty) = self.global_variable_types.get(&ident.name) {
                    return Some(ty.clone());
                }
                None
            }
            Expression::Binary(bin) => {
                // For comparison operators, result is always Bool
                match bin.op {
                    BinaryOp::Eq
                    | BinaryOp::Ne
                    | BinaryOp::Lt
                    | BinaryOp::Le
                    | BinaryOp::Gt
                    | BinaryOp::Ge
                    | BinaryOp::And
                    | BinaryOp::Or => {
                        return Some(DctlType::Bool);
                    }
                    _ => {}
                }

                // For arithmetic ops, if either operand is float, result is float
                let left_type = self.infer_expression_type(&bin.left, ctx);
                let right_type = self.infer_expression_type(&bin.right, ctx);

                match (&left_type, &right_type) {
                    (Some(lt), Some(rt)) => {
                        let left_is_float =
                            matches!(lt, DctlType::Float | DctlType::Double | DctlType::Half);
                        let right_is_float =
                            matches!(rt, DctlType::Float | DctlType::Double | DctlType::Half);
                        let left_is_vec_float = matches!(
                            lt,
                            DctlType::Vec2(ScalarType::Float)
                                | DctlType::Vec3(ScalarType::Float)
                                | DctlType::Vec4(ScalarType::Float)
                        );
                        let right_is_vec_float = matches!(
                            rt,
                            DctlType::Vec2(ScalarType::Float)
                                | DctlType::Vec3(ScalarType::Float)
                                | DctlType::Vec4(ScalarType::Float)
                        );

                        // Vector types take precedence (scalar * vec = vec)
                        if left_is_vec_float {
                            left_type
                        } else if right_is_vec_float {
                            right_type
                        // Otherwise, float scalar takes precedence over int
                        } else if left_is_float {
                            left_type
                        } else if right_is_float {
                            right_type
                        } else {
                            left_type
                        }
                    }
                    (Some(_), None) => left_type,
                    (None, Some(_)) => right_type,
                    (None, None) => None,
                }
            }
            Expression::Unary(unary) => {
                // For most unary ops, type is same as operand
                match unary.op {
                    UnaryOp::AddrOf => {
                        let inner = self.infer_expression_type(&unary.operand, ctx)?;
                        Some(DctlType::Pointer(Box::new(inner)))
                    }
                    UnaryOp::Deref => {
                        let inner = self.infer_expression_type(&unary.operand, ctx)?;
                        if let DctlType::Pointer(pointee) = inner {
                            Some(*pointee)
                        } else {
                            Some(inner)
                        }
                    }
                    UnaryOp::Not => {
                        // Logical NOT always returns Bool (even if operand is int/float)
                        Some(DctlType::Bool)
                    }
                    _ => self.infer_expression_type(&unary.operand, ctx),
                }
            }
            Expression::Call(call) => {
                // Lookup function return type
                if let Expression::Identifier(ident) = call.callee.as_ref() {
                    // Check for built-in constructors (DCTL, HLSL, and ShaderFuse styles)
                    let name_lower = ident.name.to_lowercase();
                    match name_lower.as_str() {
                        "make_float2" | "float2" | "to_float2" | "to_float2_s" => {
                            return Some(DctlType::Vec2(ScalarType::Float))
                        }
                        "make_float3" | "float3" | "to_float3" | "to_float3_s" => {
                            return Some(DctlType::Vec3(ScalarType::Float))
                        }
                        "make_float4" | "float4" | "to_float4" | "to_float4_s" => {
                            return Some(DctlType::Vec4(ScalarType::Float))
                        }
                        "make_int2" | "int2" | "to_int2" | "to_int2_s" => {
                            return Some(DctlType::Vec2(ScalarType::Int))
                        }
                        "make_int3" | "int3" | "to_int3" | "to_int3_s" => {
                            return Some(DctlType::Vec3(ScalarType::Int))
                        }
                        "make_int4" | "int4" | "to_int4" | "to_int4_s" => {
                            return Some(DctlType::Vec4(ScalarType::Int))
                        }
                        _ => {}
                    }
                    // Type cast functions (function-style casts like float(x), int(x))
                    match ident.name.as_str() {
                        "float" => return Some(DctlType::Float),
                        "int" => return Some(DctlType::Int),
                        "uint" | "unsigned" => return Some(DctlType::UInt),
                        "bool" => return Some(DctlType::Bool),
                        _ => {}
                    }
                    // Math and texture functions - check argument type for component-wise functions
                    match ident.name.as_str() {
                        "_tex2D" | "_tex3D" => return Some(DctlType::Float),
                        // Functions that always return a scalar regardless of input
                        "dot" | "length" => return Some(DctlType::Float),
                        // Functions that always return Float (even with int args)
                        // Functions that always return scalar Float (dot, length already handled above)
                        "fmin" | "fmax" => return Some(DctlType::Float),
                        // Component-wise functions that preserve vector type
                        // These return vec if input is vec, otherwise scalar Float
                        "_sinf" | "_cosf" | "_tanf" | "_sqrtf" | "_powf" | "_expf" | "_exp2f"
                        | "_logf" | "_log2f" | "_log10f" | "_fabs" | "_fabsf" | "_floorf"
                        | "_ceilf" | "_roundf" | "_truncf" | "_fmodf" | "_fminf" | "_fmaxf"
                        | "_asinf" | "_acosf" | "_atanf" | "_atan2f" | "_sinhf" | "_coshf"
                        | "_tanhf" | "_asinhf" | "_acoshf" | "_atanhf" | "_copysignf"
                        | "_hypotf" | "_floor" | "_ceil" | "_round" | "_trunc" | "_sqrt"
                        | "_pow" | "_exp" | "_exp2" | "_log" | "_log2" | "_log10" | "_sin"
                        | "_cos" | "_tan" | "_asin" | "_acos" | "_atan" | "_atan2" | "_sinh"
                        | "_cosh" | "_tanh" | "_clamp" | "_saturate" | "_fmod" | "_copysign"
                        | "_hypot" | "_fdivide" | "pow" | "exp" | "exp2" | "log" | "log2"
                        | "log10" |
                        // Short-form math functions (without underscore prefix)
                        "sinf" | "cosf" | "tanf" | "sqrtf" | "powf" | "expf" | "exp2f" | "logf"
                        | "log2f" | "log10f" | "absf" | "fabsf" | "floorf" | "ceilf" | "roundf"
                        | "truncf" | "fmodf" | "fminf" | "fmaxf" | "asinf" | "acosf" | "atanf"
                        | "atan2f" | "sinhf" | "coshf" | "tanhf" | "copysignf" | "hypotf"
                        | "floor" | "ceil" | "round" | "trunc" | "sqrt" | "abs" | "fabs"
                        | "sin" | "cos" | "tan" | "asin" | "acos" | "atan" | "atan2" | "sinh"
                        | "cosh" | "tanh" | "clamp" | "saturate" | "fmod" | "copysign"
                        | "hypot" | "fract" | "mix" | "_clampf" | "_saturatef" | "_mix"
                        | "smoothstep" | "_smoothstepf" | "step" => {
                            // Check first argument's type - these functions return vec if input is vec
                            if let Some(first_arg) = call.args.first() {
                                if let Some(arg_type) = self.infer_expression_type(first_arg, ctx) {
                                    match arg_type {
                                        DctlType::Vec2(_)
                                        | DctlType::Vec3(_)
                                        | DctlType::Vec4(_) => {
                                            return Some(arg_type);
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            return Some(DctlType::Float);
                        }
                        // cross product is only defined for vec3, so always returns vec3
                        "cross" => return Some(DctlType::Vec3(ScalarType::Float)),
                        // reflect returns the same vector type as its first input
                        "reflect" => {
                            if let Some(first_arg) = call.args.first() {
                                if let Some(arg_type) = self.infer_expression_type(first_arg, ctx) {
                                    match arg_type {
                                        DctlType::Vec2(_) => {
                                            return Some(DctlType::Vec2(ScalarType::Float))
                                        }
                                        DctlType::Vec3(_) => {
                                            return Some(DctlType::Vec3(ScalarType::Float))
                                        }
                                        DctlType::Vec4(_) => {
                                            return Some(DctlType::Vec4(ScalarType::Float))
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            return Some(DctlType::Vec3(ScalarType::Float));
                        }
                        // normalize returns the same vector type as its input
                        "normalize" => {
                            if let Some(first_arg) = call.args.first() {
                                if let Some(arg_type) = self.infer_expression_type(first_arg, ctx) {
                                    match arg_type {
                                        DctlType::Vec2(_) => {
                                            return Some(DctlType::Vec2(ScalarType::Float))
                                        }
                                        DctlType::Vec3(_) => {
                                            return Some(DctlType::Vec3(ScalarType::Float))
                                        }
                                        DctlType::Vec4(_) => {
                                            return Some(DctlType::Vec4(ScalarType::Float))
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            return Some(DctlType::Vec3(ScalarType::Float));
                        }
                        "min" | "max" => return Some(DctlType::Int),
                        // Boolean functions - these return Bool
                        "isnan" | "isnanf" | "_isnan" | "_isnanf" | "isinf" | "isinff"
                        | "_isinf" | "_isinff" | "isfinite" | "_isfinite" => {
                            return Some(DctlType::Bool)
                        }
                        _ => {}
                    }
                    // For user-defined functions, resolve the correct overload based on argument types
                    if let Some(overloads) = self.function_overloads.get(&ident.name) {
                        // Infer argument types
                        let arg_types: Vec<Option<DctlType>> = call
                            .args
                            .iter()
                            .map(|arg| self.infer_expression_type(arg, ctx))
                            .collect();

                        // Find best matching overload using same scoring as resolve_function_call
                        let mut best_overload: Option<(&FunctionOverload, i32)> = None;

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

                            if has_mismatch {
                                continue;
                            }

                            if let Some((_, best_score)) = best_overload {
                                if score > best_score {
                                    best_overload = Some((overload, score));
                                }
                            } else {
                                best_overload = Some((overload, score));
                            }
                        }

                        // Return the best overload's return type
                        if let Some((overload, _)) = best_overload {
                            return overload.return_type.clone();
                        }

                        // Fallback to first overload with matching arg count
                        for overload in overloads {
                            if overload.param_types.len() == call.args.len() {
                                return overload.return_type.clone();
                            }
                        }
                    }
                }
                None
            }
            Expression::Member(member) => {
                // Get base type and determine member type
                let base_type = self.infer_expression_type(&member.object, ctx)?;

                // Handle arrow access (ptr->member) - unwrap pointer first
                let effective_type = if member.is_arrow {
                    if let DctlType::Pointer(inner) = base_type {
                        *inner
                    } else {
                        // Arrow on non-pointer, treat as regular access
                        base_type
                    }
                } else {
                    base_type
                };

                match &effective_type {
                    DctlType::Vec2(_) | DctlType::Vec3(_) | DctlType::Vec4(_) => {
                        // Vector swizzle: single component returns scalar
                        if member.member.len() == 1 {
                            match &effective_type {
                                DctlType::Vec2(s) | DctlType::Vec3(s) | DctlType::Vec4(s) => {
                                    Some(match s {
                                        ScalarType::Float => DctlType::Float,
                                        ScalarType::Int => DctlType::Int,
                                        ScalarType::UInt => DctlType::UInt,
                                        ScalarType::Bool => DctlType::Bool,
                                        ScalarType::Half => DctlType::Half,
                                    })
                                }
                                _ => None,
                            }
                        } else {
                            // Multi-component swizzle returns vector
                            Some(effective_type)
                        }
                    }
                    DctlType::Struct(struct_name) => {
                        // Look up member type from struct definition
                        if let Some(member_types) = self.struct_member_types.get(struct_name) {
                            member_types.get(&member.member).cloned()
                        } else {
                            None
                        }
                    }
                    _ => None,
                }
            }
            Expression::Cast(cast) => {
                // Return the target type
                Some(self.convert_ast_type(&cast.target_type))
            }
            Expression::Ternary(tern) => {
                // Type is the unified type of then/else branches (considering coercion)
                let then_type = self.infer_expression_type(&tern.then_expr, ctx);
                let else_type = self.infer_expression_type(&tern.else_expr, ctx);

                // If one branch is float and the other is int, result is float (coercion)
                match (&then_type, &else_type) {
                    (Some(DctlType::Int), Some(DctlType::Float))
                    | (Some(DctlType::UInt), Some(DctlType::Float)) => Some(DctlType::Float),
                    (Some(DctlType::Float), Some(DctlType::Int))
                    | (Some(DctlType::Float), Some(DctlType::UInt)) => Some(DctlType::Float),
                    // For vectors, also check int/float coercion
                    (
                        Some(DctlType::Vec3(ScalarType::Int)),
                        Some(DctlType::Vec3(ScalarType::Float)),
                    )
                    | (
                        Some(DctlType::Vec3(ScalarType::Float)),
                        Some(DctlType::Vec3(ScalarType::Int)),
                    ) => Some(DctlType::Vec3(ScalarType::Float)),
                    (
                        Some(DctlType::Vec2(ScalarType::Int)),
                        Some(DctlType::Vec2(ScalarType::Float)),
                    )
                    | (
                        Some(DctlType::Vec2(ScalarType::Float)),
                        Some(DctlType::Vec2(ScalarType::Int)),
                    ) => Some(DctlType::Vec2(ScalarType::Float)),
                    (
                        Some(DctlType::Vec4(ScalarType::Int)),
                        Some(DctlType::Vec4(ScalarType::Float)),
                    )
                    | (
                        Some(DctlType::Vec4(ScalarType::Float)),
                        Some(DctlType::Vec4(ScalarType::Int)),
                    ) => Some(DctlType::Vec4(ScalarType::Float)),
                    // Otherwise prefer float type if available, else use then_type
                    _ => {
                        if matches!(else_type, Some(DctlType::Float) | Some(DctlType::Double)) {
                            else_type
                        } else {
                            then_type
                        }
                    }
                }
            }
            Expression::Index(index_expr) => {
                // Check for multi-dimensional array access first (e.g., arr[i][j] on float3[2][4])
                // This is parsed as nested Index expressions, and the type should be the flattened array's element type
                if let Some((array_name, indices)) = self.collect_multidim_indices(expr) {
                    // Check if this is a known multi-dimensional array
                    if let Some(dims) = self.multidim_array_dims.get(&array_name) {
                        if indices.len() == dims.len() {
                            // This is a complete multi-dim access - return the base element type
                            // Look up the array's element type
                            if let Some(arr_type) = ctx.variable_types.get(&array_name) {
                                if let DctlType::Array(elem_type, _) = arr_type {
                                    return Some(elem_type.as_ref().clone());
                                }
                            }
                            if let Some(arr_type) = self.global_variable_types.get(&array_name) {
                                if let DctlType::Array(elem_type, _) = arr_type {
                                    return Some(elem_type.as_ref().clone());
                                }
                            }
                        }
                    }
                }

                // For single-dimension array access arr[i], get the element type from the array type
                let base_type = self.infer_expression_type(&index_expr.object, ctx)?;
                match base_type {
                    DctlType::Array(elem_type, _) => Some(*elem_type),
                    // For vectors, indexing returns the scalar element type
                    DctlType::Vec2(s) | DctlType::Vec3(s) | DctlType::Vec4(s) => Some(match s {
                        ScalarType::Float => DctlType::Float,
                        ScalarType::Int => DctlType::Int,
                        ScalarType::UInt => DctlType::UInt,
                        ScalarType::Bool => DctlType::Bool,
                        ScalarType::Half => DctlType::Half,
                    }),
                    // For matrices, indexing returns a row vector
                    DctlType::Mat3 => Some(DctlType::Vec3(ScalarType::Float)),
                    DctlType::Mat4 => Some(DctlType::Vec4(ScalarType::Float)),
                    _ => None,
                }
            }
            Expression::Sizeof(_) => {
                // sizeof always returns u32 in our WGSL implementation
                Some(DctlType::UInt)
            }
            _ => None,
        }
    }
}
