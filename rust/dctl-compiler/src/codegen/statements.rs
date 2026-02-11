//! Statement generation for DCTL to WGSL
//!
//! This module handles the generation of Naga statements from DCTL AST.

use naga::{
    BinaryOperator, Block as NagaBlock, Expression as NagaExpr, Function, Handle, Literal, Span,
    Statement as NagaStmt, SwitchCase as NagaSwitchCase, TypeInner, UnaryOperator,
};

use super::naga_module::{FunctionContext, NagaModuleGenerator};
use super::CodegenError;
use crate::parser::{AssignmentOp, Block, Expression, ForInit, LiteralValue, Statement, UnaryOp};
use crate::semantic::{DctlType, ScalarType};

impl NagaModuleGenerator {
    pub(super) fn generate_block(
        &mut self,
        block: &Block,
        ctx: &mut FunctionContext,
        func: &mut Function,
    ) -> Result<NagaBlock, CodegenError> {
        let mut naga_block = NagaBlock::new();

        for stmt in &block.statements {
            self.generate_statement(stmt, ctx, func, &mut naga_block)?;
        }

        Ok(naga_block)
    }

    /// Emit an expression if needed (makes it available for use)
    /// Returns the expression handle for use in statements
    pub(super) fn emit_expression(
        &mut self,
        expr: &Expression,
        ctx: &mut FunctionContext,
        block: &mut NagaBlock,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        let handle = self.generate_expression(expr, ctx)?;

        // Track which expressions have been emitted by pending_stmts
        let mut already_emitted = false;

        // Flush any pending statements (e.g., function calls that need Statement::Call)
        for (stmt, span) in ctx.pending_stmts.drain(..) {
            // Check if this Emit statement covers our handle
            if let NagaStmt::Emit(range) = &stmt {
                if let Some((start, end)) = range.first_and_last() {
                    // Check if handle is within the emit range
                    if handle.index() >= start.index() && handle.index() <= end.index() {
                        already_emitted = true;
                    }
                }
            }
            block.push(stmt, span);
        }

        // Check if the expression needs to be emitted
        // Some expressions are automatically in scope and don't need emission:
        // - Literal, FunctionArgument, GlobalVariable, Constant, LocalVariable
        // We need to emit evaluated expressions like: Binary, Compose, Math, etc.
        // BUT skip if it was already emitted by pending_stmts
        if !already_emitted && self.needs_emit(&ctx.expressions[handle]) {
            block.push(
                NagaStmt::Emit(naga::Range::new_from_bounds(handle, handle)),
                Span::UNDEFINED,
            );
        }

        Ok(handle)
    }

    pub(super) fn generate_statement(
        &mut self,
        stmt: &Statement,
        ctx: &mut FunctionContext,
        func: &mut Function,
        block: &mut NagaBlock,
    ) -> Result<(), CodegenError> {
        match stmt {
            Statement::Block(inner_block) => {
                // Check if block only contains variable declarations
                // If so, flatten it to avoid creating a WGSL nested scope
                // This handles multi-variable declarations like "int i, j;" which
                // the TS parser wraps in a Block
                let is_var_only = inner_block
                    .statements
                    .iter()
                    .all(|s| matches!(s, Statement::Variable(_)));

                if is_var_only {
                    // Flatten: just inline the declarations without creating a block
                    for inner_stmt in &inner_block.statements {
                        self.generate_statement(inner_stmt, ctx, func, block)?;
                    }
                } else {
                    // Normal block with mixed statements - create WGSL block for scoping
                    let inner = self.generate_block(inner_block, ctx, func)?;
                    block.push(NagaStmt::Block(inner), Span::UNDEFINED);
                }
            }
            Statement::Variable(var_decl) => {
                self.generate_local_variable(var_decl, ctx, func, block)?;
            }
            Statement::Expression(expr_stmt) => {
                // Check if it's an assignment - if so, we need to emit a Store statement
                if let Expression::Assignment(assign) = &expr_stmt.expression {
                    // Skip assignments to texture variables (TexR = p_TexR, etc.)
                    // Textures are handled specially and don't need global variable storage
                    if let Expression::Identifier(ident) = assign.left.as_ref() {
                        if let Some(var_type) = self.global_variable_types.get(&ident.name) {
                            if matches!(
                                var_type,
                                DctlType::Texture2D | DctlType::Texture3D | DctlType::Sampler
                            ) {
                                // Skip this assignment - it's a no-op for textures
                                return Ok(());
                            }
                        }
                    }

                    // Try to transform ternary-as-lvalue pattern (GCC extension)
                    // Pattern: `L = (cond ? T : L) = R` -> `L = cond ? T : R`
                    let assign = if let Some(transformed) =
                        Self::try_transform_ternary_lvalue_assign(assign)
                    {
                        std::borrow::Cow::Owned(transformed)
                    } else {
                        std::borrow::Cow::Borrowed(assign)
                    };

                    let value = self.emit_expression(&assign.right, ctx, block)?;
                    let pointer = self.generate_lvalue(&assign.left, ctx)?;

                    // Get types for coercion
                    let left_type = self.infer_expression_type(&assign.left, ctx);
                    let right_type = self.infer_expression_type(&assign.right, ctx);

                    // Handle compound assignments
                    let final_value = match assign.op {
                        AssignmentOp::Assign => {
                            // For simple assignment, coerce int to float if needed
                            self.coerce_for_simple_assign(
                                value,
                                left_type.clone(),
                                right_type,
                                ctx,
                                block,
                            )
                        }
                        op => {
                            let current = ctx
                                .expressions
                                .append(NagaExpr::Load { pointer }, Span::UNDEFINED);
                            // Emit the Load expression
                            block.push(
                                NagaStmt::Emit(naga::Range::new_from_bounds(current, current)),
                                Span::UNDEFINED,
                            );
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

                            // Handle vector/scalar type mismatch and int/uint coercion for compound assignments
                            let left_type = self.infer_expression_type(&assign.left, ctx);
                            let right_type = self.infer_expression_type(&assign.right, ctx);

                            // Step 1: Use coerce_binary_operands for signed/unsigned int coercion
                            let (coerced_left, coerced_right_int) = self.coerce_binary_operands(
                                current,
                                value,
                                left_type.clone(),
                                right_type.clone(),
                                ctx,
                            );

                            // Emit any pending coercion statements (e.g., cast expressions)
                            for (stmt, span) in ctx.pending_stmts.drain(..) {
                                block.push(stmt, span);
                            }

                            // Step 2: Use coerce_for_binary_op for int-to-float coercion and scalar-to-vector splatting
                            // NOTE: coerce_binary_operands may have already done int-to-float coercion,
                            // but coerce_for_binary_op uses the TYPE to decide what to do, so we need
                            // to pass the ORIGINAL right_type, not an updated one.
                            // If coerce_binary_operands already did int-to-float, coerce_for_binary_op
                            // will see that right_type is Int, but the actual expression is already Float.
                            // In that case, creating another As expression is unnecessary but harmless
                            // (Naga should optimize it away or it's a no-op).
                            // More importantly, we need the scalar-to-vector splatting which coerce_for_binary_op provides.
                            let coerced_right = self.coerce_for_binary_op(
                                coerced_left,
                                coerced_right_int,
                                left_type,
                                right_type.clone(), // Use original right_type, not updated
                                ctx,
                            );

                            // Emit any pending coercion statements from splat
                            for (stmt, span) in ctx.pending_stmts.drain(..) {
                                block.push(stmt, span);
                            }

                            let result = ctx.expressions.append(
                                NagaExpr::Binary {
                                    op: binary_op,
                                    left: coerced_left,
                                    right: coerced_right,
                                },
                                Span::UNDEFINED,
                            );
                            // Emit the Binary expression
                            block.push(
                                NagaStmt::Emit(naga::Range::new_from_bounds(result, result)),
                                Span::UNDEFINED,
                            );
                            result
                        }
                    };

                    // Emit the Store statement
                    block.push(
                        NagaStmt::Store {
                            pointer,
                            value: final_value,
                        },
                        Span::UNDEFINED,
                    );
                } else if let Expression::Unary(unary) = &expr_stmt.expression {
                    // Handle increment/decrement operators as statements
                    match unary.op {
                        UnaryOp::PreInc | UnaryOp::PostInc => {
                            // i++ or ++i -> i = i + 1
                            let pointer = self.generate_lvalue(&unary.operand, ctx)?;
                            let current =
                                ctx.expressions
                                    .append(NagaExpr::Load { pointer }, Span::UNDEFINED);
                            block.push(
                                NagaStmt::Emit(naga::Range::new_from_bounds(current, current)),
                                Span::UNDEFINED,
                            );
                            // Use the correct literal type based on operand type
                            let operand_type = self.infer_expression_type(&unary.operand, ctx);
                            let one = match &operand_type {
                                Some(DctlType::Float)
                                | Some(DctlType::Double)
                                | Some(DctlType::Half) => ctx.expressions.append(
                                    NagaExpr::Literal(Literal::F32(1.0)),
                                    Span::UNDEFINED,
                                ),
                                _ => ctx.expressions.append(
                                    NagaExpr::Literal(Literal::I32(1)),
                                    Span::UNDEFINED,
                                ),
                            };
                            let incremented = ctx.expressions.append(
                                NagaExpr::Binary {
                                    op: BinaryOperator::Add,
                                    left: current,
                                    right: one,
                                },
                                Span::UNDEFINED,
                            );
                            block.push(
                                NagaStmt::Emit(naga::Range::new_from_bounds(
                                    incremented,
                                    incremented,
                                )),
                                Span::UNDEFINED,
                            );
                            block.push(
                                NagaStmt::Store {
                                    pointer,
                                    value: incremented,
                                },
                                Span::UNDEFINED,
                            );
                        }
                        UnaryOp::PreDec | UnaryOp::PostDec => {
                            // i-- or --i -> i = i - 1
                            let pointer = self.generate_lvalue(&unary.operand, ctx)?;
                            let current =
                                ctx.expressions
                                    .append(NagaExpr::Load { pointer }, Span::UNDEFINED);
                            block.push(
                                NagaStmt::Emit(naga::Range::new_from_bounds(current, current)),
                                Span::UNDEFINED,
                            );
                            // Use the correct literal type based on operand type
                            let operand_type = self.infer_expression_type(&unary.operand, ctx);
                            let one = match &operand_type {
                                Some(DctlType::Float)
                                | Some(DctlType::Double)
                                | Some(DctlType::Half) => ctx.expressions.append(
                                    NagaExpr::Literal(Literal::F32(1.0)),
                                    Span::UNDEFINED,
                                ),
                                _ => ctx.expressions.append(
                                    NagaExpr::Literal(Literal::I32(1)),
                                    Span::UNDEFINED,
                                ),
                            };
                            let decremented = ctx.expressions.append(
                                NagaExpr::Binary {
                                    op: BinaryOperator::Subtract,
                                    left: current,
                                    right: one,
                                },
                                Span::UNDEFINED,
                            );
                            block.push(
                                NagaStmt::Emit(naga::Range::new_from_bounds(
                                    decremented,
                                    decremented,
                                )),
                                Span::UNDEFINED,
                            );
                            block.push(
                                NagaStmt::Store {
                                    pointer,
                                    value: decremented,
                                },
                                Span::UNDEFINED,
                            );
                        }
                        _ => {
                            // For other unary expressions, just evaluate them
                            let _handle = self.emit_expression(&expr_stmt.expression, ctx, block)?;
                        }
                    }
                } else {
                    // For non-assignment expressions, just evaluate them
                    let _handle = self.emit_expression(&expr_stmt.expression, ctx, block)?;
                    // Expression statements that aren't assignments become no-ops
                }
            }
            Statement::If(if_stmt) => {
                let condition_expr = self.emit_expression(&if_stmt.condition, ctx, block)?;

                // Coerce non-bool to bool if needed: WGSL requires bool for if conditions
                // DCTL/C allows any scalar (int, float) in if conditions
                let condition_type = self.infer_expression_type(&if_stmt.condition, ctx);
                let condition = match condition_type {
                    Some(DctlType::Int) | Some(DctlType::UInt) | None => {
                        // Convert int to bool: condition != 0
                        // None case: treat as int (common for struct member access)
                        let zero = ctx
                            .expressions
                            .append(NagaExpr::Literal(Literal::I32(0)), Span::UNDEFINED);
                        let cmp = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::NotEqual,
                                left: condition_expr,
                                right: zero,
                            },
                            Span::UNDEFINED,
                        );
                        block.push(
                            NagaStmt::Emit(naga::Range::new_from_bounds(cmp, cmp)),
                            Span::UNDEFINED,
                        );
                        cmp
                    }
                    Some(DctlType::Float) => {
                        // Convert float to bool: condition != 0.0
                        let zero = ctx
                            .expressions
                            .append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED);
                        let cmp = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::NotEqual,
                                left: condition_expr,
                                right: zero,
                            },
                            Span::UNDEFINED,
                        );
                        block.push(
                            NagaStmt::Emit(naga::Range::new_from_bounds(cmp, cmp)),
                            Span::UNDEFINED,
                        );
                        cmp
                    }
                    _ => condition_expr, // Bool or other types - use as-is
                };

                let then_block = match if_stmt.then_branch.as_ref() {
                    Statement::Block(b) => self.generate_block(b, ctx, func)?,
                    other => {
                        let mut b = NagaBlock::new();
                        self.generate_statement(other, ctx, func, &mut b)?;
                        b
                    }
                };

                let else_block = if let Some(else_branch) = &if_stmt.else_branch {
                    match else_branch.as_ref() {
                        Statement::Block(b) => self.generate_block(b, ctx, func)?,
                        other => {
                            let mut b = NagaBlock::new();
                            self.generate_statement(other, ctx, func, &mut b)?;
                            b
                        }
                    }
                } else {
                    NagaBlock::new()
                };

                block.push(
                    NagaStmt::If {
                        condition,
                        accept: then_block,
                        reject: else_block,
                    },
                    Span::UNDEFINED,
                );
            }
            Statement::While(while_stmt) => {
                let mut body_block = NagaBlock::new();

                // Generate condition check at start of loop body
                let condition_expr =
                    self.emit_expression(&while_stmt.condition, ctx, &mut body_block)?;

                // Coerce non-bool to bool if needed: WGSL requires bool for while conditions
                let condition_type = self.infer_expression_type(&while_stmt.condition, ctx);
                let condition = match condition_type {
                    Some(DctlType::Int) | Some(DctlType::UInt) | None => {
                        // None case: treat as int (common for struct member access)
                        let zero = ctx
                            .expressions
                            .append(NagaExpr::Literal(Literal::I32(0)), Span::UNDEFINED);
                        let cmp = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::NotEqual,
                                left: condition_expr,
                                right: zero,
                            },
                            Span::UNDEFINED,
                        );
                        body_block.push(
                            NagaStmt::Emit(naga::Range::new_from_bounds(cmp, cmp)),
                            Span::UNDEFINED,
                        );
                        cmp
                    }
                    Some(DctlType::Float) => {
                        let zero = ctx
                            .expressions
                            .append(NagaExpr::Literal(Literal::F32(0.0)), Span::UNDEFINED);
                        let cmp = ctx.expressions.append(
                            NagaExpr::Binary {
                                op: BinaryOperator::NotEqual,
                                left: condition_expr,
                                right: zero,
                            },
                            Span::UNDEFINED,
                        );
                        body_block.push(
                            NagaStmt::Emit(naga::Range::new_from_bounds(cmp, cmp)),
                            Span::UNDEFINED,
                        );
                        cmp
                    }
                    _ => condition_expr, // Bool - use as-is
                };

                let not_condition = ctx.expressions.append(
                    NagaExpr::Unary {
                        op: UnaryOperator::LogicalNot,
                        expr: condition,
                    },
                    Span::UNDEFINED,
                );
                // Emit the negated condition
                body_block.push(
                    NagaStmt::Emit(naga::Range::new_from_bounds(not_condition, not_condition)),
                    Span::UNDEFINED,
                );

                // Break if condition is false
                let mut break_block = NagaBlock::new();
                break_block.push(NagaStmt::Break, Span::UNDEFINED);

                body_block.push(
                    NagaStmt::If {
                        condition: not_condition,
                        accept: break_block,
                        reject: NagaBlock::new(),
                    },
                    Span::UNDEFINED,
                );

                // Generate loop body
                match while_stmt.body.as_ref() {
                    Statement::Block(b) => {
                        for s in &b.statements {
                            self.generate_statement(s, ctx, func, &mut body_block)?;
                        }
                    }
                    other => {
                        self.generate_statement(other, ctx, func, &mut body_block)?;
                    }
                }

                block.push(
                    NagaStmt::Loop {
                        body: body_block,
                        continuing: NagaBlock::new(),
                        break_if: None,
                    },
                    Span::UNDEFINED,
                );
            }
            Statement::DoWhile(do_while_stmt) => {
                let mut body_block = NagaBlock::new();

                // Generate loop body first
                match do_while_stmt.body.as_ref() {
                    Statement::Block(b) => {
                        for s in &b.statements {
                            self.generate_statement(s, ctx, func, &mut body_block)?;
                        }
                    }
                    other => {
                        self.generate_statement(other, ctx, func, &mut body_block)?;
                    }
                }

                // Generate condition check at end in continuing block
                let mut continuing = NagaBlock::new();
                let condition =
                    self.emit_expression(&do_while_stmt.condition, ctx, &mut continuing)?;
                let not_condition = ctx.expressions.append(
                    NagaExpr::Unary {
                        op: UnaryOperator::LogicalNot,
                        expr: condition,
                    },
                    Span::UNDEFINED,
                );
                continuing.push(
                    NagaStmt::Emit(naga::Range::new_from_bounds(not_condition, not_condition)),
                    Span::UNDEFINED,
                );

                block.push(
                    NagaStmt::Loop {
                        body: body_block,
                        continuing,
                        break_if: Some(not_condition),
                    },
                    Span::UNDEFINED,
                );
            }
            Statement::For(for_stmt) => {
                // Generate initializer
                if let Some(init) = &for_stmt.init {
                    match init {
                        ForInit::Variable(var_decl) => {
                            self.generate_local_variable(var_decl, ctx, func, block)?;
                        }
                        ForInit::Expression(expr) => {
                            let _handle = self.emit_expression(expr, ctx, block)?;
                        }
                    }
                }

                let mut body_block = NagaBlock::new();

                // Generate condition check
                if let Some(condition_expr) = &for_stmt.condition {
                    let condition = self.emit_expression(condition_expr, ctx, &mut body_block)?;
                    let not_condition = ctx.expressions.append(
                        NagaExpr::Unary {
                            op: UnaryOperator::LogicalNot,
                            expr: condition,
                        },
                        Span::UNDEFINED,
                    );
                    body_block.push(
                        NagaStmt::Emit(naga::Range::new_from_bounds(not_condition, not_condition)),
                        Span::UNDEFINED,
                    );

                    let mut break_block = NagaBlock::new();
                    break_block.push(NagaStmt::Break, Span::UNDEFINED);

                    body_block.push(
                        NagaStmt::If {
                            condition: not_condition,
                            accept: break_block,
                            reject: NagaBlock::new(),
                        },
                        Span::UNDEFINED,
                    );
                }

                // Generate loop body
                match for_stmt.body.as_ref() {
                    Statement::Block(b) => {
                        for s in &b.statements {
                            self.generate_statement(s, ctx, func, &mut body_block)?;
                        }
                    }
                    other => {
                        self.generate_statement(other, ctx, func, &mut body_block)?;
                    }
                }

                // Generate update in continuing block
                let mut continuing = NagaBlock::new();
                if let Some(update_expr) = &for_stmt.update {
                    // Handle increment/decrement operators specially
                    if let Expression::Unary(unary) = update_expr {
                        match unary.op {
                            UnaryOp::PreInc | UnaryOp::PostInc => {
                                let pointer = self.generate_lvalue(&unary.operand, ctx)?;
                                let current = ctx
                                    .expressions
                                    .append(NagaExpr::Load { pointer }, Span::UNDEFINED);
                                continuing.push(
                                    NagaStmt::Emit(naga::Range::new_from_bounds(current, current)),
                                    Span::UNDEFINED,
                                );
                                // Use the correct literal type based on operand type
                                let operand_type = self.infer_expression_type(&unary.operand, ctx);
                                let one = match &operand_type {
                                    Some(DctlType::Float)
                                    | Some(DctlType::Double)
                                    | Some(DctlType::Half) => ctx.expressions.append(
                                        NagaExpr::Literal(Literal::F32(1.0)),
                                        Span::UNDEFINED,
                                    ),
                                    Some(DctlType::UInt) => ctx.expressions.append(
                                        NagaExpr::Literal(Literal::U32(1)),
                                        Span::UNDEFINED,
                                    ),
                                    _ => ctx.expressions.append(
                                        NagaExpr::Literal(Literal::I32(1)),
                                        Span::UNDEFINED,
                                    ),
                                };
                                let incremented = ctx.expressions.append(
                                    NagaExpr::Binary {
                                        op: BinaryOperator::Add,
                                        left: current,
                                        right: one,
                                    },
                                    Span::UNDEFINED,
                                );
                                continuing.push(
                                    NagaStmt::Emit(naga::Range::new_from_bounds(
                                        incremented,
                                        incremented,
                                    )),
                                    Span::UNDEFINED,
                                );
                                continuing.push(
                                    NagaStmt::Store {
                                        pointer,
                                        value: incremented,
                                    },
                                    Span::UNDEFINED,
                                );
                            }
                            UnaryOp::PreDec | UnaryOp::PostDec => {
                                let pointer = self.generate_lvalue(&unary.operand, ctx)?;
                                let current = ctx
                                    .expressions
                                    .append(NagaExpr::Load { pointer }, Span::UNDEFINED);
                                continuing.push(
                                    NagaStmt::Emit(naga::Range::new_from_bounds(current, current)),
                                    Span::UNDEFINED,
                                );
                                // Use the correct literal type based on operand type
                                let operand_type = self.infer_expression_type(&unary.operand, ctx);
                                let one = match &operand_type {
                                    Some(DctlType::Float)
                                    | Some(DctlType::Double)
                                    | Some(DctlType::Half) => ctx.expressions.append(
                                        NagaExpr::Literal(Literal::F32(1.0)),
                                        Span::UNDEFINED,
                                    ),
                                    Some(DctlType::UInt) => ctx.expressions.append(
                                        NagaExpr::Literal(Literal::U32(1)),
                                        Span::UNDEFINED,
                                    ),
                                    _ => ctx.expressions.append(
                                        NagaExpr::Literal(Literal::I32(1)),
                                        Span::UNDEFINED,
                                    ),
                                };
                                let decremented = ctx.expressions.append(
                                    NagaExpr::Binary {
                                        op: BinaryOperator::Subtract,
                                        left: current,
                                        right: one,
                                    },
                                    Span::UNDEFINED,
                                );
                                continuing.push(
                                    NagaStmt::Emit(naga::Range::new_from_bounds(
                                        decremented,
                                        decremented,
                                    )),
                                    Span::UNDEFINED,
                                );
                                continuing.push(
                                    NagaStmt::Store {
                                        pointer,
                                        value: decremented,
                                    },
                                    Span::UNDEFINED,
                                );
                            }
                            _ => {
                                let _handle =
                                    self.emit_expression(update_expr, ctx, &mut continuing)?;
                            }
                        }
                    } else {
                        let _handle = self.emit_expression(update_expr, ctx, &mut continuing)?;
                    }
                }

                block.push(
                    NagaStmt::Loop {
                        body: body_block,
                        continuing,
                        break_if: None,
                    },
                    Span::UNDEFINED,
                );
            }
            Statement::Switch(switch_stmt) => {
                let selector = self.emit_expression(&switch_stmt.expression, ctx, block)?;

                let mut cases = Vec::new();
                let mut default_body = NagaBlock::new();
                let mut has_default = false;

                for case in &switch_stmt.cases {
                    let mut case_body = NagaBlock::new();
                    for s in &case.statements {
                        self.generate_statement(s, ctx, func, &mut case_body)?;
                    }

                    if let Some(value_expr) = &case.value {
                        // Case with value
                        let switch_value = match value_expr {
                            Expression::Literal(lit) => match &lit.value {
                                LiteralValue::Int(v) => Some(naga::SwitchValue::I32(*v as i32)),
                                LiteralValue::UInt(v) => Some(naga::SwitchValue::I32(*v as i32)),
                                _ => None,
                            },
                            Expression::Identifier(ident) => {
                                // Look up integer constant value for enum-like identifiers
                                self.integer_constants
                                    .get(&ident.name)
                                    .map(|&v| naga::SwitchValue::I32(v))
                            }
                            _ => None,
                        };

                        if let Some(value) = switch_value {
                            cases.push(NagaSwitchCase {
                                value,
                                body: case_body,
                                fall_through: false,
                            });
                        }
                    } else {
                        // Default case
                        default_body = case_body;
                        has_default = true;
                    }
                }

                // Add default case
                if has_default {
                    cases.push(NagaSwitchCase {
                        value: naga::SwitchValue::Default,
                        body: default_body,
                        fall_through: false,
                    });
                } else {
                    // WGSL requires a default case
                    cases.push(NagaSwitchCase {
                        value: naga::SwitchValue::Default,
                        body: NagaBlock::new(),
                        fall_through: false,
                    });
                }

                block.push(NagaStmt::Switch { selector, cases }, Span::UNDEFINED);
            }
            Statement::Return(return_stmt) => {
                // For pointer-returning functions, emit void return instead
                // (the caller already has the pointer via the out-parameter)
                if ctx.result_type.is_none() && return_stmt.value.is_some() {
                    // This is a pointer-returning function converted to void
                    // Just emit a void return (the return value is ignored)
                    block.push(NagaStmt::Return { value: None }, Span::UNDEFINED);
                    return Ok(());
                }

                let value = if let Some(expr) = &return_stmt.value {
                    let mut ret_val = self.emit_expression(expr, ctx, block)?;

                    // Coerce return value to match expected return type
                    if let Some(result) = &ctx.result_type {
                        let expected_type = result.clone();
                        let expr_type = self.infer_expression_type(expr, ctx);

                        // Check for int → float coercion
                        let expected_is_float = matches!(
                            expected_type,
                            DctlType::Float | DctlType::Double | DctlType::Half
                        );
                        let actual_is_int =
                            matches!(expr_type, Some(DctlType::Int) | Some(DctlType::UInt));

                        if expected_is_float && actual_is_int {
                            // Coerce int to float
                            let cast = ctx.expressions.append(
                                NagaExpr::As {
                                    expr: ret_val,
                                    kind: naga::ScalarKind::Float,
                                    convert: Some(4),
                                },
                                Span::UNDEFINED,
                            );
                            block.push(
                                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                                Span::UNDEFINED,
                            );
                            ret_val = cast;
                        }

                        // Check for float → int coercion
                        let expected_is_int =
                            matches!(expected_type, DctlType::Int | DctlType::UInt);
                        let actual_is_float = matches!(
                            expr_type,
                            Some(DctlType::Float) | Some(DctlType::Double) | Some(DctlType::Half)
                        );

                        if expected_is_int && actual_is_float {
                            // Coerce float to int
                            let kind = match expected_type {
                                DctlType::UInt => naga::ScalarKind::Uint,
                                _ => naga::ScalarKind::Sint,
                            };
                            let cast = ctx.expressions.append(
                                NagaExpr::As {
                                    expr: ret_val,
                                    kind,
                                    convert: Some(4),
                                },
                                Span::UNDEFINED,
                            );
                            block.push(
                                NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                                Span::UNDEFINED,
                            );
                            ret_val = cast;
                        }

                        // Check for scalar → vector coercion
                        let actual_is_scalar = matches!(
                            expr_type,
                            Some(DctlType::Float)
                                | Some(DctlType::Double)
                                | Some(DctlType::Half)
                                | Some(DctlType::Int)
                                | Some(DctlType::UInt)
                        );

                        if let Some(vec_size) = match &expected_type {
                            DctlType::Vec2(_) => Some(naga::VectorSize::Bi),
                            DctlType::Vec3(_) => Some(naga::VectorSize::Tri),
                            DctlType::Vec4(_) => Some(naga::VectorSize::Quad),
                            _ => None,
                        } {
                            if actual_is_scalar {
                                // Determine the scalar type from expected type
                                let scalar = match &expected_type {
                                    DctlType::Vec2(st) | DctlType::Vec3(st) | DctlType::Vec4(st) => {
                                        match st {
                                            ScalarType::Float | ScalarType::Half => naga::Scalar::F32,
                                            ScalarType::Int => naga::Scalar::I32,
                                            ScalarType::UInt => naga::Scalar::U32,
                                            ScalarType::Bool => naga::Scalar::BOOL,
                                        }
                                    }
                                    _ => naga::Scalar::F32,
                                };

                                // First ensure ret_val is the correct scalar type (float for vec<f32>)
                                let actual_is_int_now =
                                    matches!(expr_type, Some(DctlType::Int) | Some(DctlType::UInt));
                                let need_float = matches!(scalar.kind, naga::ScalarKind::Float);
                                if actual_is_int_now && need_float {
                                    let cast = ctx.expressions.append(
                                        NagaExpr::As {
                                            expr: ret_val,
                                            kind: naga::ScalarKind::Float,
                                            convert: Some(4),
                                        },
                                        Span::UNDEFINED,
                                    );
                                    block.push(
                                        NagaStmt::Emit(naga::Range::new_from_bounds(cast, cast)),
                                        Span::UNDEFINED,
                                    );
                                    ret_val = cast;
                                }

                                // Splat scalar to vector
                                let _vec_type = self.module.types.insert(
                                    naga::Type {
                                        name: None,
                                        inner: TypeInner::Vector { size: vec_size, scalar },
                                    },
                                    Span::UNDEFINED,
                                );
                                let splat = ctx.expressions.append(
                                    NagaExpr::Splat {
                                        size: vec_size,
                                        value: ret_val,
                                    },
                                    Span::UNDEFINED,
                                );
                                block.push(
                                    NagaStmt::Emit(naga::Range::new_from_bounds(splat, splat)),
                                    Span::UNDEFINED,
                                );
                                ret_val = splat;
                            }
                        }
                    }

                    Some(ret_val)
                } else if let Some(result) = &func.result {
                    // Empty return in non-void function - generate default value
                    // This handles DCTL code like:
                    //   float3 foo() { if (cond) { return; } ... }
                    // which should return a default value (vec3(0.0)) on early exit
                    let type_info = self.extract_zero_type_info(result.ty);
                    let default_val = self.create_zero_from_info(result.ty, type_info, ctx)?;
                    // Flush pending statements (emits for the zero value)
                    for (stmt, span) in ctx.pending_stmts.drain(..) {
                        block.push(stmt, span);
                    }
                    Some(default_val)
                } else {
                    None
                };
                block.push(NagaStmt::Return { value }, Span::UNDEFINED);
            }
            Statement::Break(_) => {
                block.push(NagaStmt::Break, Span::UNDEFINED);
            }
            Statement::Continue(_) => {
                block.push(NagaStmt::Continue, Span::UNDEFINED);
            }
            Statement::Empty(_) => {
                // No-op
            }
        }

        Ok(())
    }
}
