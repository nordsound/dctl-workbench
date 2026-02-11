//! Built-in function generation
//!
//! Handles DCTL built-in functions like math functions, vector constructors, etc.

use super::naga_module::{FunctionContext, NagaModuleGenerator};
use super::CodegenError;
use crate::semantic::DctlType;
use naga::{
    BinaryOperator, Expression as NagaExpr, Handle, Literal, Module, Span,
    Statement as NagaStmt,
};

impl NagaModuleGenerator {
    /// Get value for built-in math constants
    pub(super) fn get_math_constant(&self, name: &str) -> Option<f32> {
        match name {
            // PI variants
            "PI" | "M_PI" | "pi" => Some(std::f32::consts::PI),
            "TWO_PI" | "M_2PI" | "M_2_PI" => Some(2.0 * std::f32::consts::PI),
            "HALF_PI" | "M_PI_2" => Some(std::f32::consts::FRAC_PI_2),
            "QUARTER_PI" | "M_PI_4" => Some(std::f32::consts::FRAC_PI_4),
            "INV_PI" | "M_1_PI" => Some(std::f32::consts::FRAC_1_PI),
            "INV_TWO_PI" | "M_1_2PI" => Some(0.5 * std::f32::consts::FRAC_1_PI),

            // E (Euler's number)
            "E" | "M_E" => Some(std::f32::consts::E),

            // Square root constants
            "SQRT2" | "M_SQRT2" | "SQRT_2" => Some(std::f32::consts::SQRT_2),
            "SQRT_HALF" | "M_SQRT1_2" => Some(std::f32::consts::FRAC_1_SQRT_2),

            // Log constants
            "LN2" | "M_LN2" => Some(std::f32::consts::LN_2),
            "LN10" | "M_LN10" => Some(std::f32::consts::LN_10),
            "LOG2E" | "M_LOG2E" => Some(std::f32::consts::LOG2_E),
            "LOG10E" | "M_LOG10E" => Some(std::f32::consts::LOG10_E),

            // Common values
            "EPSILON" | "FLT_EPSILON" => Some(f32::EPSILON),

            _ => None,
        }
    }

    /// Parse swizzle pattern
    pub(super) fn parse_swizzle(&self, member: &str) -> Option<Vec<naga::SwizzleComponent>> {
        let chars: Vec<char> = member.chars().collect();
        if chars.is_empty() || chars.len() > 4 {
            return None;
        }

        let mut components = Vec::new();
        for c in chars {
            let comp = match c {
                'x' | 'r' | 's' => naga::SwizzleComponent::X,
                'y' | 'g' | 't' => naga::SwizzleComponent::Y,
                'z' | 'b' | 'p' => naga::SwizzleComponent::Z,
                'w' | 'a' | 'q' => naga::SwizzleComponent::W,
                _ => return None,
            };
            components.push(comp);
        }

        Some(components)
    }

    /// Generate built-in function call
    pub(super) fn generate_builtin_call(
        &mut self,
        name: &str,
        args: &[Handle<NagaExpr>],
        call: &crate::parser::CallExpr,
        ctx: &mut FunctionContext,
    ) -> Result<Option<Handle<NagaExpr>>, CodegenError> {
        // Vector constructors (case-insensitive)
        // Support DCTL-style (make_float3), HLSL-style (float3), and ShaderFuse-style (to_float3) constructors
        let name_lower = name.to_lowercase();
        if name_lower.starts_with("make_float") || name_lower.starts_with("make_int")
            || name_lower.starts_with("to_float") || name_lower.starts_with("to_int")
            || matches!(name_lower.as_str(), "float2" | "float3" | "float4" | "int2" | "int3" | "int4")
        {
            let (ty, size) = match name_lower.as_str() {
                "make_float2" | "float2" | "to_float2" | "to_float2_s" => ("vec2<f32>", 2),
                "make_float3" | "float3" | "to_float3" | "to_float3_s" => ("vec3<f32>", 3),
                "make_float4" | "float4" | "to_float4" | "to_float4_s" => ("vec4<f32>", 4),
                "make_int2" | "int2" | "to_int2" | "to_int2_s" => ("vec2<i32>", 2),
                "make_int3" | "int3" | "to_int3" | "to_int3_s" => ("vec3<i32>", 3),
                "make_int4" | "int4" | "to_int4" | "to_int4_s" => ("vec4<i32>", 4),
                _ => return Ok(None),
            };

            let type_handle = self.type_handles[ty];
            let mut components = args.to_vec();

            // Check if this is a float vector constructor (needs int->float coercion)
            let is_float_vector = name_lower.starts_with("make_float")
                || name_lower.starts_with("to_float")
                || matches!(name_lower.as_str(), "float2" | "float3" | "float4");

            // Get AST types BEFORE splatting (for correct index lookup)
            let arg_types: Vec<_> = call.args.iter()
                .map(|expr| self.infer_expression_type(expr, ctx))
                .collect();

            // If single argument, splat it
            let was_splatted = components.len() == 1 && size > 1;
            if components.len() == 1 {
                while components.len() < size {
                    components.push(components[0]);
                }
            }

            // Coerce non-float arguments to float for float vector constructors
            if is_float_vector {
                components = components
                    .into_iter()
                    .enumerate()
                    .map(|(i, arg)| {
                        // When splatted, use the first argument's type for all components
                        let ast_index = if was_splatted { 0 } else { i };

                        // Check if argument is an integer or bool type (from AST)
                        let is_non_float_from_ast = arg_types.get(ast_index).map(|ty| {
                            matches!(ty, Some(DctlType::Int) | Some(DctlType::UInt) | Some(DctlType::Bool))
                        }).unwrap_or(false);

                        let is_int_expr = matches!(
                            &ctx.expressions[arg],
                            NagaExpr::Literal(Literal::I32(_)) |
                            NagaExpr::Literal(Literal::U32(_)) |
                            NagaExpr::Literal(Literal::Bool(_)) |
                            NagaExpr::AccessIndex { .. } | // Vector/struct member access
                            NagaExpr::Load { .. } // Variable load
                        );

                        // Also check for Negate expressions with int literals (e.g., -1)
                        let is_negated_int = matches!(
                            &ctx.expressions[arg],
                            NagaExpr::Unary { op: naga::UnaryOperator::Negate, expr: inner }
                            if matches!(&ctx.expressions[*inner], NagaExpr::Literal(Literal::I32(_)) | NagaExpr::Literal(Literal::U32(_)))
                        );

                        // Check if it's a function call result that returns bool
                        // (e.g., isValid() -> bool used in make_float4(vec3, isValid(...)))
                        let is_call_result = matches!(
                            &ctx.expressions[arg],
                            NagaExpr::CallResult(_)
                        );
                        let is_bool_call = is_call_result && arg_types.get(ast_index).map(|ty| {
                            matches!(ty, Some(DctlType::Bool))
                        }).unwrap_or(false);

                        if is_non_float_from_ast || is_int_expr || is_negated_int || is_bool_call {
                            ctx.expressions.append(
                                NagaExpr::As {
                                    expr: arg,
                                    kind: naga::ScalarKind::Float,
                                    convert: Some(4),
                                },
                                Span::UNDEFINED,
                            )
                        } else {
                            arg
                        }
                    })
                    .collect();
            }

            return Ok(Some(ctx.expressions.append(
                NagaExpr::Compose {
                    ty: type_handle,
                    components,
                },
                Span::UNDEFINED,
            )));
        }

        // Matrix constructors (case-insensitive)
        // Supports: make_mat2, make_mat3, make_mat4, MAT2, MAT3, MAT4
        let mat_type = match name_lower.as_str() {
            "make_mat2" | "mat2" => Some("mat2x2<f32>"),
            "make_mat3" | "mat3" => Some("mat3x3<f32>"),
            "make_mat4" | "mat4" => Some("mat4x4<f32>"),
            _ => None,
        };
        if let Some(ty) = mat_type {
            let type_handle = self.type_handles[ty];
            return Ok(Some(ctx.expressions.append(
                NagaExpr::Compose {
                    ty: type_handle,
                    components: args.to_vec(),
                },
                Span::UNDEFINED,
            )));
        }

        // Type cast functions (e.g., float(x), int(x))
        match name {
            "float" => {
                if args.len() != 1 {
                    return Err(CodegenError::Internal(format!(
                        "float() expects 1 argument, got {}",
                        args.len()
                    )));
                }
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::As {
                        expr: args[0],
                        kind: naga::ScalarKind::Float,
                        convert: Some(4), // f32
                    },
                    Span::UNDEFINED,
                )));
            }
            "int" => {
                if args.len() != 1 {
                    return Err(CodegenError::Internal(format!(
                        "int() expects 1 argument, got {}",
                        args.len()
                    )));
                }
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::As {
                        expr: args[0],
                        kind: naga::ScalarKind::Sint,
                        convert: Some(4), // i32
                    },
                    Span::UNDEFINED,
                )));
            }
            // isnan(x) => x != x (NaN doesn't equal itself)
            "isnan" | "_isnan" | "isnanf" => {
                if args.len() != 1 {
                    return Err(CodegenError::Internal(format!(
                        "isnan() expects 1 argument, got {}",
                        args.len()
                    )));
                }
                // NaN != NaN is true
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Binary {
                        op: BinaryOperator::NotEqual,
                        left: args[0],
                        right: args[0],
                    },
                    Span::UNDEFINED,
                )));
            }
            // isinf(x) => abs(x) > MAX_FLOAT (approximation)
            // A more precise check: (x * 0.0) != 0.0 works for infinity
            "isinf" | "_isinf" | "isinff" => {
                if args.len() != 1 {
                    return Err(CodegenError::Internal(format!(
                        "isinf() expects 1 argument, got {}",
                        args.len()
                    )));
                }
                // x * 0.0 != 0.0 for infinity
                let zero = ctx.expressions.append(
                    NagaExpr::Literal(Literal::F32(0.0)),
                    Span::UNDEFINED,
                );
                let mul_result = ctx.expressions.append(
                    NagaExpr::Binary {
                        op: BinaryOperator::Multiply,
                        left: args[0],
                        right: zero,
                    },
                    Span::UNDEFINED,
                );
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Binary {
                        op: BinaryOperator::NotEqual,
                        left: mul_result,
                        right: zero,
                    },
                    Span::UNDEFINED,
                )));
            }
            // _fmod(x, y) => x % y (floating-point remainder)
            // Note: This is different from WGSL's modf() which splits into int/frac parts
            "_fmod" | "_fmodf" | "fmodf" | "fmod" => {
                if args.len() != 2 {
                    return Err(CodegenError::Internal(format!(
                        "fmod() expects 2 arguments, got {}",
                        args.len()
                    )));
                }
                // Helper to check if an expression might be an integer type
                // (WGSL Modulo requires both operands to be the same type, and for fmod we need float)
                let might_be_int = |expr: &NagaExpr| -> bool {
                    matches!(
                        expr,
                        NagaExpr::Literal(Literal::I32(_)) |
                        NagaExpr::Literal(Literal::U32(_)) |
                        NagaExpr::Load { .. } |
                        NagaExpr::FunctionArgument(_) |
                        NagaExpr::AccessIndex { .. } |
                        NagaExpr::Binary { .. } |
                        NagaExpr::CallResult(_)
                    )
                };
                // Coerce int expressions to float for WGSL compatibility
                // fmod expects float operands
                let left = if might_be_int(&ctx.expressions[args[0]]) {
                    ctx.expressions.append(
                        NagaExpr::As {
                            expr: args[0],
                            kind: naga::ScalarKind::Float,
                            convert: Some(4),
                        },
                        Span::UNDEFINED,
                    )
                } else {
                    args[0]
                };
                let right = if might_be_int(&ctx.expressions[args[1]]) {
                    ctx.expressions.append(
                        NagaExpr::As {
                            expr: args[1],
                            kind: naga::ScalarKind::Float,
                            convert: Some(4),
                        },
                        Span::UNDEFINED,
                    )
                } else {
                    args[1]
                };
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Binary {
                        op: BinaryOperator::Modulo,
                        left,
                        right,
                    },
                    Span::UNDEFINED,
                )));
            }
            _ => {}
        }

        // Math functions mapped to WGSL built-ins
        // Supports DCTL style (_sinf), C style (sinf, sin), and uppercase (SIN)
        let math_func = match name {
            // Single-argument functions
            "_sinf" | "sinf" | "sin" | "SIN" => Some((naga::MathFunction::Sin, 1)),
            "_cosf" | "cosf" | "cos" | "COS" => Some((naga::MathFunction::Cos, 1)),
            "_tanf" | "tanf" | "tan" | "TAN" => Some((naga::MathFunction::Tan, 1)),
            "_asinf" | "asinf" | "asin" => Some((naga::MathFunction::Asin, 1)),
            "_acosf" | "acosf" | "acos" => Some((naga::MathFunction::Acos, 1)),
            "_atanf" | "atanf" | "atan" => Some((naga::MathFunction::Atan, 1)),
            "_sinhf" | "sinhf" | "sinh" => Some((naga::MathFunction::Sinh, 1)),
            "_coshf" | "coshf" | "cosh" => Some((naga::MathFunction::Cosh, 1)),
            "_tanhf" | "tanhf" | "tanh" => Some((naga::MathFunction::Tanh, 1)),
            "_asinhf" | "asinhf" | "asinh" => Some((naga::MathFunction::Asinh, 1)),
            "_acoshf" | "acoshf" | "acosh" => Some((naga::MathFunction::Acosh, 1)),
            "_atanhf" | "atanhf" | "atanh" => Some((naga::MathFunction::Atanh, 1)),
            "_expf" | "expf" | "exp" | "EXP" => Some((naga::MathFunction::Exp, 1)),
            "_exp2f" | "exp2f" | "exp2" => Some((naga::MathFunction::Exp2, 1)),
            "_logf" | "logf" | "log" | "LOG" => Some((naga::MathFunction::Log, 1)),
            "_log2f" | "log2f" | "log2" => Some((naga::MathFunction::Log2, 1)),
            "_sqrtf" | "sqrtf" | "sqrt" | "SQRT" => Some((naga::MathFunction::Sqrt, 1)),
            "_rsqrtf" | "rsqrtf" | "rsqrt" | "inversesqrt" => Some((naga::MathFunction::InverseSqrt, 1)),
            "_floor" | "_floorf" | "floorf" | "floor" | "FLOOR" => Some((naga::MathFunction::Floor, 1)),
            "_ceil" | "_ceilf" | "ceilf" | "ceil" | "CEIL" => Some((naga::MathFunction::Ceil, 1)),
            "_round" | "_roundf" | "roundf" | "round" | "ROUND" => Some((naga::MathFunction::Round, 1)),
            "_truncf" | "truncf" | "trunc" => Some((naga::MathFunction::Trunc, 1)),
            "_fabs" | "_fabsf" | "fabsf" | "fabs" | "abs" | "ABS" => Some((naga::MathFunction::Abs, 1)),
            "_signf" | "signf" | "sign" => Some((naga::MathFunction::Sign, 1)),
            "_saturatef" | "saturatef" | "saturate" => Some((naga::MathFunction::Saturate, 1)),
            "_fractf" | "fractf" | "fract" => Some((naga::MathFunction::Fract, 1)),
            "normalize" => Some((naga::MathFunction::Normalize, 1)),
            "length" => Some((naga::MathFunction::Length, 1)),

            // Two-argument functions
            "_powf" | "powf" | "pow" | "POW" => Some((naga::MathFunction::Pow, 2)),
            "_atan2f" | "atan2f" | "atan2" => Some((naga::MathFunction::Atan2, 2)),
            "_fminf" | "fminf" | "fmin" | "min" | "MIN" | "minf" => Some((naga::MathFunction::Min, 2)),
            "_fmaxf" | "fmaxf" | "fmax" | "max" | "MAX" | "maxf" => Some((naga::MathFunction::Max, 2)),
            // "_fmod" is handled separately as binary modulo operator (not Modf which splits into int/frac parts)
            "_stepf" | "stepf" | "step" => Some((naga::MathFunction::Step, 2)),
            "dot" => Some((naga::MathFunction::Dot, 2)),
            "cross" => Some((naga::MathFunction::Cross, 2)),
            "distance" => Some((naga::MathFunction::Distance, 2)),
            "reflect" => Some((naga::MathFunction::Reflect, 2)),

            // Three-argument functions
            "_clampf" | "clampf" | "clamp" | "CLAMP" => Some((naga::MathFunction::Clamp, 3)),
            "_mix" | "mixf" | "mix" | "lerp" | "lerpf" => Some((naga::MathFunction::Mix, 3)),
            "_smoothstepf" | "smoothstepf" | "smoothstep" => Some((naga::MathFunction::SmoothStep, 3)),
            "fma" | "fmaf" | "_fmaf" => Some((naga::MathFunction::Fma, 3)),

            _ => None,
        };

        if let Some((func, expected_args)) = math_func {
            if args.len() != expected_args {
                return Err(CodegenError::Internal(format!(
                    "Function {} expects {} arguments, got {}",
                    name,
                    expected_args,
                    args.len()
                )));
            }

            // Coerce int arguments to float for math functions that require float
            // WGSL's pow, etc. require all arguments to be the same type
            let coerce_to_float = |arg: Handle<NagaExpr>, ctx: &mut FunctionContext| -> Handle<NagaExpr> {
                let expr = &ctx.expressions[arg];

                // For integer literals, create a float literal directly instead of using As
                // This is more reliable for Naga validation
                if let NagaExpr::Literal(Literal::I32(v)) = expr {
                    return ctx.expressions.append(
                        NagaExpr::Literal(Literal::F32(*v as f32)),
                        Span::UNDEFINED,
                    );
                }
                if let NagaExpr::Literal(Literal::U32(v)) = expr {
                    return ctx.expressions.append(
                        NagaExpr::Literal(Literal::F32(*v as f32)),
                        Span::UNDEFINED,
                    );
                }

                // Check for various expression types that might be int (non-literal cases)
                let might_be_int = matches!(
                    expr,
                    NagaExpr::Load { .. } |
                    NagaExpr::FunctionArgument(_) |
                    NagaExpr::AccessIndex { .. } |
                    NagaExpr::Binary { .. } |
                    NagaExpr::Unary { .. } |
                    NagaExpr::CallResult(_)
                );
                if might_be_int {
                    // Convert to f32 using As
                    let cast = ctx.expressions.append(
                        NagaExpr::As {
                            expr: arg,
                            kind: naga::ScalarKind::Float,
                            convert: Some(4), // f32 width
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
                    arg
                }
            };

            // For multi-arg functions like clamp, min, max, mix - check if arg0 is a vector
            // If so, splat scalar args to match
            let arg0_vec_size = call.args.first().and_then(|expr| {
                match self.infer_expression_type(expr, ctx)? {
                    DctlType::Vec2(_) => Some(2),
                    DctlType::Vec3(_) => Some(3),
                    DctlType::Vec4(_) => Some(4),
                    _ => None,
                }
            });

            // Check if all arguments are integers - for min/max/clamp, don't coerce to float
            // as these functions work natively on integers in WGSL
            let supports_int = matches!(func, naga::MathFunction::Min | naga::MathFunction::Max | naga::MathFunction::Clamp);
            let all_args_int = call.args.iter().all(|expr| {
                let ty = self.infer_expression_type(expr, ctx);
                matches!(ty, Some(DctlType::Int) | Some(DctlType::UInt))
            });
            let skip_float_coercion = supports_int && all_args_int;

            let arg0 = if skip_float_coercion {
                args[0]
            } else {
                coerce_to_float(args[0], ctx)
            };

            // Check AST types for arg1 and arg2 to determine if they are scalars
            let arg1_is_scalar = call.args.get(1).map(|expr| {
                let ty = self.infer_expression_type(expr, ctx);
                matches!(ty, Some(DctlType::Int) | Some(DctlType::UInt) | Some(DctlType::Float) | Some(DctlType::Double) | Some(DctlType::Half) | None)
            }).unwrap_or(true);
            let arg2_is_scalar = call.args.get(2).map(|expr| {
                let ty = self.infer_expression_type(expr, ctx);
                matches!(ty, Some(DctlType::Int) | Some(DctlType::UInt) | Some(DctlType::Float) | Some(DctlType::Double) | Some(DctlType::Half) | None)
            }).unwrap_or(true);

            // Helper to splat scalar to vector if needed
            let splat_if_needed = |arg: Handle<NagaExpr>, is_scalar: bool, ctx: &mut FunctionContext, module: &mut Module| -> Handle<NagaExpr> {
                if let Some(size) = arg0_vec_size {
                    if is_scalar {
                        // Get or create the appropriate vector type
                        let vec_type_name = match size {
                            2 => "vec2<f32>",
                            3 => "vec3<f32>",
                            4 => "vec4<f32>",
                            _ => return arg,
                        };
                        // Find the type handle
                        if let Some(vec_type) = module.types.iter()
                            .find(|(_, ty)| ty.name.as_ref().map(|n| n.as_str() == vec_type_name).unwrap_or(false))
                            .map(|(h, _)| h)
                        {
                            // Splat: compose vector from repeated scalar
                            let components: Vec<_> = (0..size).map(|_| arg).collect();
                            let compose = ctx.expressions.append(
                                NagaExpr::Compose {
                                    ty: vec_type,
                                    components,
                                },
                                Span::UNDEFINED,
                            );
                            // Add emit for the Compose expression
                            ctx.pending_stmts.push((
                                NagaStmt::Emit(naga::Range::new_from_bounds(compose, compose)),
                                Span::UNDEFINED,
                            ));
                            return compose;
                        }
                    }
                }
                arg
            };

            let arg1 = args.get(1).map(|&a| {
                let coerced = if skip_float_coercion { a } else { coerce_to_float(a, ctx) };
                splat_if_needed(coerced, arg1_is_scalar, ctx, &mut self.module)
            });
            let arg2 = args.get(2).map(|&a| {
                let coerced = if skip_float_coercion { a } else { coerce_to_float(a, ctx) };
                splat_if_needed(coerced, arg2_is_scalar, ctx, &mut self.module)
            });

            return Ok(Some(ctx.expressions.append(
                NagaExpr::Math {
                    fun: func,
                    arg: arg0,
                    arg1,
                    arg2,
                    arg3: None,
                },
                Span::UNDEFINED,
            )));
        }

        // Handle composite functions that need special implementation
        match name {
            // _exp10f(x) = pow(10.0, x)
            "_exp10f" | "exp10" => {
                if args.len() != 1 {
                    return Err(CodegenError::Internal(format!(
                        "Function {} expects 1 argument, got {}",
                        name,
                        args.len()
                    )));
                }
                // Create constant 10.0
                let ten = ctx.expressions.append(
                    NagaExpr::Literal(naga::Literal::F32(10.0)),
                    Span::UNDEFINED,
                );
                // pow(10.0, x)
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Math {
                        fun: naga::MathFunction::Pow,
                        arg: ten,
                        arg1: Some(args[0]),
                        arg2: None,
                        arg3: None,
                    },
                    Span::UNDEFINED,
                )));
            }
            // _log10f(x) = log(x) / log(10.0)
            "_log10f" | "log10" => {
                if args.len() != 1 {
                    return Err(CodegenError::Internal(format!(
                        "Function {} expects 1 argument, got {}",
                        name,
                        args.len()
                    )));
                }
                // log(x)
                let log_x = ctx.expressions.append(
                    NagaExpr::Math {
                        fun: naga::MathFunction::Log,
                        arg: args[0],
                        arg1: None,
                        arg2: None,
                        arg3: None,
                    },
                    Span::UNDEFINED,
                );
                // log(10.0) ≈ 2.302585
                let log_10 = ctx.expressions.append(
                    NagaExpr::Literal(naga::Literal::F32(2.302585093)),
                    Span::UNDEFINED,
                );
                // log(x) / log(10.0)
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Binary {
                        op: naga::BinaryOperator::Divide,
                        left: log_x,
                        right: log_10,
                    },
                    Span::UNDEFINED,
                )));
            }
            // _fdivide(x, y) = x / y (safe division) - always coerce to float
            "_fdivide" | "fdivide" => {
                if args.len() != 2 {
                    return Err(CodegenError::Internal(format!(
                        "Function {} expects 2 arguments, got {}",
                        name,
                        args.len()
                    )));
                }
                // Helper to coerce int to float for division - checks for int types
                let coerce_arg_to_float = |arg: Handle<NagaExpr>, ctx: &mut FunctionContext| -> Handle<NagaExpr> {
                    let expr = &ctx.expressions[arg];
                    let needs_coerce = match expr {
                        NagaExpr::Literal(Literal::I32(_)) => true,
                        NagaExpr::Literal(Literal::U32(_)) => true,
                        // For loads and function arguments, we need to check if they might be int
                        // Since _fdivide is explicitly float division, coerce any non-float expression
                        NagaExpr::Load { .. } | NagaExpr::FunctionArgument(_) => true,
                        // Binary results might be int, coerce to be safe
                        NagaExpr::Binary { .. } => true,
                        // Other expressions are likely already float
                        _ => false,
                    };
                    if needs_coerce {
                        ctx.expressions.append(
                            NagaExpr::As {
                                expr: arg,
                                kind: naga::ScalarKind::Float,
                                convert: Some(4),
                            },
                            Span::UNDEFINED,
                        )
                    } else {
                        arg
                    }
                };
                let left = coerce_arg_to_float(args[0], ctx);
                let right = coerce_arg_to_float(args[1], ctx);
                // For now, just do regular division
                // A proper implementation would check for division by zero
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Binary {
                        op: naga::BinaryOperator::Divide,
                        left,
                        right,
                    },
                    Span::UNDEFINED,
                )));
            }
            // _hypotf(x, y) = sqrt(x*x + y*y)
            "_hypotf" | "hypot" | "hypotf" => {
                if args.len() != 2 {
                    return Err(CodegenError::Internal(format!(
                        "Function {} expects 2 arguments, got {}",
                        name,
                        args.len()
                    )));
                }
                // x * x
                let x_sq = ctx.expressions.append(
                    NagaExpr::Binary {
                        op: naga::BinaryOperator::Multiply,
                        left: args[0],
                        right: args[0],
                    },
                    Span::UNDEFINED,
                );
                // y * y
                let y_sq = ctx.expressions.append(
                    NagaExpr::Binary {
                        op: naga::BinaryOperator::Multiply,
                        left: args[1],
                        right: args[1],
                    },
                    Span::UNDEFINED,
                );
                // x*x + y*y
                let sum = ctx.expressions.append(
                    NagaExpr::Binary {
                        op: naga::BinaryOperator::Add,
                        left: x_sq,
                        right: y_sq,
                    },
                    Span::UNDEFINED,
                );
                // sqrt(x*x + y*y)
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Math {
                        fun: naga::MathFunction::Sqrt,
                        arg: sum,
                        arg1: None,
                        arg2: None,
                        arg3: None,
                    },
                    Span::UNDEFINED,
                )));
            }
            // _copysignf(x, y) = abs(x) * sign(y)
            "_copysignf" | "copysign" => {
                if args.len() != 2 {
                    return Err(CodegenError::Internal(format!(
                        "Function {} expects 2 arguments, got {}",
                        name,
                        args.len()
                    )));
                }
                // abs(x)
                let abs_x = ctx.expressions.append(
                    NagaExpr::Math {
                        fun: naga::MathFunction::Abs,
                        arg: args[0],
                        arg1: None,
                        arg2: None,
                        arg3: None,
                    },
                    Span::UNDEFINED,
                );
                // sign(y)
                let sign_y = ctx.expressions.append(
                    NagaExpr::Math {
                        fun: naga::MathFunction::Sign,
                        arg: args[1],
                        arg1: None,
                        arg2: None,
                        arg3: None,
                    },
                    Span::UNDEFINED,
                );
                // abs(x) * sign(y)
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Binary {
                        op: naga::BinaryOperator::Multiply,
                        left: abs_x,
                        right: sign_y,
                    },
                    Span::UNDEFINED,
                )));
            }

            // mult_f3_f33(vec3, mat3x3) = mat3x3 * vec3 (matrix-vector multiplication)
            // DCTL uses row-vector convention, WGSL uses column-vector
            // So DCTL's mult_f3_f33(v, M) = transpose(M) * v in WGSL
            // But in practice, for color grading, we can use M * v directly
            "mult_f3_f33" | "_mult_f3_f33" => {
                if args.len() != 2 {
                    return Err(CodegenError::Internal(format!(
                        "Function {} expects 2 arguments (vec3, mat3), got {}",
                        name,
                        args.len()
                    )));
                }
                // mat * vec in WGSL
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Binary {
                        op: naga::BinaryOperator::Multiply,
                        left: args[1], // matrix
                        right: args[0], // vector
                    },
                    Span::UNDEFINED,
                )));
            }

            // mult_f3_f44(vec3, mat4x4) - multiply vec3 by 4x4 matrix (ignoring translation)
            // This extends vec3 to vec4(v.x, v.y, v.z, 1.0), multiplies, then returns xyz
            "mult_f3_f44" | "_mult_f3_f44" => {
                if args.len() != 2 {
                    return Err(CodegenError::Internal(format!(
                        "Function {} expects 2 arguments (vec3, mat4), got {}",
                        name,
                        args.len()
                    )));
                }
                let vec4_type = self.type_handles["vec4<f32>"];

                // Get x, y, z components from vec3
                let x = ctx.expressions.append(
                    NagaExpr::AccessIndex { base: args[0], index: 0 },
                    Span::UNDEFINED,
                );
                let y = ctx.expressions.append(
                    NagaExpr::AccessIndex { base: args[0], index: 1 },
                    Span::UNDEFINED,
                );
                let z = ctx.expressions.append(
                    NagaExpr::AccessIndex { base: args[0], index: 2 },
                    Span::UNDEFINED,
                );
                let one = ctx.expressions.append(
                    NagaExpr::Literal(naga::Literal::F32(1.0)),
                    Span::UNDEFINED,
                );

                // Create vec4(x, y, z, 1.0)
                let vec4 = ctx.expressions.append(
                    NagaExpr::Compose {
                        ty: vec4_type,
                        components: vec![x, y, z, one],
                    },
                    Span::UNDEFINED,
                );

                // mat4 * vec4
                let result4 = ctx.expressions.append(
                    NagaExpr::Binary {
                        op: naga::BinaryOperator::Multiply,
                        left: args[1], // matrix
                        right: vec4,
                    },
                    Span::UNDEFINED,
                );

                // Extract xyz (swizzle)
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Swizzle {
                        size: naga::VectorSize::Tri,
                        vector: result4,
                        pattern: [
                            naga::SwizzleComponent::X,
                            naga::SwizzleComponent::Y,
                            naga::SwizzleComponent::Z,
                            naga::SwizzleComponent::W,
                        ],
                    },
                    Span::UNDEFINED,
                )));
            }

            // make_float3x3 - create a 3x3 matrix from components or column vectors
            "make_float3x3" | "_make_float3x3" => {
                let mat3_type = self.type_handles["mat3x3<f32>"];

                if args.len() == 9 {
                    // 9 floats: construct column by column
                    let vec3_type = self.type_handles["vec3<f32>"];
                    let col0 = ctx.expressions.append(
                        NagaExpr::Compose {
                            ty: vec3_type,
                            components: vec![args[0], args[1], args[2]],
                        },
                        Span::UNDEFINED,
                    );
                    let col1 = ctx.expressions.append(
                        NagaExpr::Compose {
                            ty: vec3_type,
                            components: vec![args[3], args[4], args[5]],
                        },
                        Span::UNDEFINED,
                    );
                    let col2 = ctx.expressions.append(
                        NagaExpr::Compose {
                            ty: vec3_type,
                            components: vec![args[6], args[7], args[8]],
                        },
                        Span::UNDEFINED,
                    );
                    return Ok(Some(ctx.expressions.append(
                        NagaExpr::Compose {
                            ty: mat3_type,
                            components: vec![col0, col1, col2],
                        },
                        Span::UNDEFINED,
                    )));
                } else if args.len() == 3 {
                    // 3 vec3s: use as columns directly
                    return Ok(Some(ctx.expressions.append(
                        NagaExpr::Compose {
                            ty: mat3_type,
                            components: args.to_vec(),
                        },
                        Span::UNDEFINED,
                    )));
                } else {
                    return Err(CodegenError::Internal(format!(
                        "make_float3x3 expects 9 floats or 3 vec3s, got {} arguments",
                        args.len()
                    )));
                }
            }

            // transpose_f33 - transpose a 3x3 matrix
            "transpose_f33" | "_transpose_f33" | "transpose" => {
                if args.len() != 1 {
                    return Err(CodegenError::Internal(format!(
                        "Function {} expects 1 argument (mat3), got {}",
                        name,
                        args.len()
                    )));
                }
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Math {
                        fun: naga::MathFunction::Transpose,
                        arg: args[0],
                        arg1: None,
                        arg2: None,
                        arg3: None,
                    },
                    Span::UNDEFINED,
                )));
            }

            // invert_f33 - invert a 3x3 matrix
            // WGSL doesn't have built-in matrix inverse, so we compute it manually
            "invert_f33" | "_invert_f33" => {
                if args.len() != 1 {
                    return Err(CodegenError::Internal(format!(
                        "Function {} expects 1 argument (mat3), got {}",
                        name,
                        args.len()
                    )));
                }
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Math {
                        fun: naga::MathFunction::Inverse,
                        arg: args[0],
                        arg1: None,
                        arg2: None,
                        arg3: None,
                    },
                    Span::UNDEFINED,
                )));
            }

            // determinant_f33 - compute determinant of 3x3 matrix
            "determinant_f33" | "_determinant_f33" | "determinant" => {
                if args.len() != 1 {
                    return Err(CodegenError::Internal(format!(
                        "Function {} expects 1 argument (mat3), got {}",
                        name,
                        args.len()
                    )));
                }
                return Ok(Some(ctx.expressions.append(
                    NagaExpr::Math {
                        fun: naga::MathFunction::Determinant,
                        arg: args[0],
                        arg1: None,
                        arg2: None,
                        arg3: None,
                    },
                    Span::UNDEFINED,
                )));
            }

            _ => {}
        }

        Ok(None)
    }
}
