//! Pointer parameter analysis for DCTL to WGSL conversion
//!
//! This module analyzes how pointer parameters are used in functions to determine:
//! - Whether they're used with array indexing (ptr[i]) or just dereferenced (*ptr)
//! - What array sizes should be used for pointer parameters based on call sites

use super::naga_module::NagaModuleGenerator;
use crate::parser::{
    Block, DctlModule, Declaration, Expression, ForInit, Statement, UnaryOp,
};
use crate::semantic::DctlType;
use std::collections::HashMap;

impl NagaModuleGenerator {
    /// Collect pointer parameter array sizes from call sites
    /// This pre-pass scans all function bodies to:
    /// 1. Collect local array declarations (function_name, array_name) -> size
    /// 2. Find function calls where local/global arrays are passed to pointer parameters
    /// 3. Infer the required array size for each pointer parameter
    pub(super) fn collect_pointer_param_array_sizes(&mut self, dctl_module: &DctlModule) {
        // First, collect all local array sizes from function bodies
        for decl in &dctl_module.declarations {
            if let Declaration::Function(func_decl) = decl {
                if let Some(ref body) = func_decl.body {
                    self.collect_local_arrays_from_block(&func_decl.name, body);
                }
            }
        }

        // Collect function parameter info (which params are pointers)
        let mut func_pointer_params: HashMap<String, Vec<(usize, DctlType)>> = HashMap::new();
        for decl in &dctl_module.declarations {
            if let Declaration::Function(func_decl) = decl {
                let mut pointer_params = Vec::new();
                for (idx, param) in func_decl.params.iter().enumerate() {
                    let param_type = self.convert_ast_type(&param.param_type);
                    // Check if it's a pointer to scalar type
                    if let DctlType::Pointer(ref inner) = param_type {
                        if matches!(inner.as_ref(),
                            DctlType::Float | DctlType::Int | DctlType::UInt | DctlType::Bool |
                            DctlType::Double | DctlType::Half | DctlType::Char
                        ) {
                            pointer_params.push((idx, param_type.clone()));
                        }
                    }
                }
                if !pointer_params.is_empty() {
                    func_pointer_params.insert(func_decl.name.clone(), pointer_params);
                }
            }
        }

        // Analyze how pointer parameters are used (indexing vs dereference)
        for decl in &dctl_module.declarations {
            if let Declaration::Function(func_decl) = decl {
                // Get the pointer parameter names for this function
                let pointer_param_names: Vec<String> = func_decl.params.iter()
                    .filter(|p| {
                        let ty = self.convert_ast_type(&p.param_type);
                        if let DctlType::Pointer(ref inner) = ty {
                            matches!(inner.as_ref(),
                                DctlType::Float | DctlType::Int | DctlType::UInt | DctlType::Bool |
                                DctlType::Double | DctlType::Half | DctlType::Char
                            )
                        } else {
                            false
                        }
                    })
                    .map(|p| p.name.clone())
                    .collect();

                // Analyze function body for indexing usage
                if let Some(ref body) = func_decl.body {
                    for param_name in &pointer_param_names {
                        let uses_indexing = self.check_pointer_uses_indexing(param_name, body);
                        self.pointer_uses_indexing.insert(
                            (func_decl.name.clone(), param_name.clone()),
                            uses_indexing,
                        );
                    }
                }
            }
        }

        // Now scan function bodies for calls and infer array sizes
        for decl in &dctl_module.declarations {
            if let Declaration::Function(func_decl) = decl {
                if let Some(ref body) = func_decl.body {
                    self.scan_calls_for_pointer_params(&func_decl.name, body, &func_pointer_params);
                }
            }
        }
    }

    /// Check if a pointer parameter uses array indexing within a block
    fn check_pointer_uses_indexing(&self, param_name: &str, block: &Block) -> bool {
        for stmt in &block.statements {
            if self.check_stmt_for_indexing(param_name, stmt) {
                return true;
            }
        }
        false
    }

    fn check_stmt_for_indexing(&self, param_name: &str, stmt: &Statement) -> bool {
        match stmt {
            Statement::Expression(expr_stmt) => {
                self.check_expr_for_indexing(param_name, &expr_stmt.expression)
            }
            Statement::Variable(var_decl) => {
                if let Some(ref init) = var_decl.initializer {
                    if self.check_expr_for_indexing(param_name, init) {
                        return true;
                    }
                }
                false
            }
            Statement::Block(block) => {
                self.check_pointer_uses_indexing(param_name, block)
            }
            Statement::If(if_stmt) => {
                self.check_expr_for_indexing(param_name, &if_stmt.condition) ||
                self.check_stmt_for_indexing(param_name, &if_stmt.then_branch) ||
                if_stmt.else_branch.as_ref().map_or(false, |eb| self.check_stmt_for_indexing(param_name, eb))
            }
            Statement::While(while_stmt) => {
                self.check_expr_for_indexing(param_name, &while_stmt.condition) ||
                self.check_stmt_for_indexing(param_name, &while_stmt.body)
            }
            Statement::DoWhile(do_while_stmt) => {
                self.check_stmt_for_indexing(param_name, &do_while_stmt.body) ||
                self.check_expr_for_indexing(param_name, &do_while_stmt.condition)
            }
            Statement::For(for_stmt) => {
                let init_uses = match &for_stmt.init {
                    Some(ForInit::Expression(expr)) => self.check_expr_for_indexing(param_name, expr),
                    _ => false,
                };
                init_uses ||
                for_stmt.condition.as_ref().map_or(false, |c| self.check_expr_for_indexing(param_name, c)) ||
                for_stmt.update.as_ref().map_or(false, |u| self.check_expr_for_indexing(param_name, u)) ||
                self.check_stmt_for_indexing(param_name, &for_stmt.body)
            }
            Statement::Switch(switch_stmt) => {
                if self.check_expr_for_indexing(param_name, &switch_stmt.expression) {
                    return true;
                }
                for case in &switch_stmt.cases {
                    for case_stmt in &case.statements {
                        if self.check_stmt_for_indexing(param_name, case_stmt) {
                            return true;
                        }
                    }
                }
                false
            }
            Statement::Return(ret_stmt) => {
                ret_stmt.value.as_ref().map_or(false, |v| self.check_expr_for_indexing(param_name, v))
            }
            _ => false,
        }
    }

    fn check_expr_for_indexing(&self, param_name: &str, expr: &Expression) -> bool {
        match expr {
            Expression::Index(index_expr) => {
                // Check if the base is the parameter we're looking for
                if let Expression::Identifier(ident) = index_expr.object.as_ref() {
                    if ident.name == param_name {
                        return true;
                    }
                }
                // Recursively check
                self.check_expr_for_indexing(param_name, &index_expr.object) ||
                self.check_expr_for_indexing(param_name, &index_expr.index)
            }
            Expression::Binary(bin_expr) => {
                self.check_expr_for_indexing(param_name, &bin_expr.left) ||
                self.check_expr_for_indexing(param_name, &bin_expr.right)
            }
            Expression::Unary(unary_expr) => {
                self.check_expr_for_indexing(param_name, &unary_expr.operand)
            }
            Expression::Ternary(ternary_expr) => {
                self.check_expr_for_indexing(param_name, &ternary_expr.condition) ||
                self.check_expr_for_indexing(param_name, &ternary_expr.then_expr) ||
                self.check_expr_for_indexing(param_name, &ternary_expr.else_expr)
            }
            Expression::Call(call_expr) => {
                for arg in &call_expr.args {
                    if self.check_expr_for_indexing(param_name, arg) {
                        return true;
                    }
                }
                false
            }
            Expression::Member(member_expr) => {
                self.check_expr_for_indexing(param_name, &member_expr.object)
            }
            Expression::Cast(cast_expr) => {
                self.check_expr_for_indexing(param_name, &cast_expr.operand)
            }
            Expression::Assignment(assign_expr) => {
                self.check_expr_for_indexing(param_name, &assign_expr.left) ||
                self.check_expr_for_indexing(param_name, &assign_expr.right)
            }
            Expression::Comma(comma_expr) => {
                comma_expr.expressions.iter().any(|e| self.check_expr_for_indexing(param_name, e))
            }
            Expression::InitializerList(init_list) => {
                init_list.elements.iter().any(|e| self.check_expr_for_indexing(param_name, e))
            }
            _ => false,
        }
    }

    /// Recursively collect local array declarations from a block
    fn collect_local_arrays_from_block(&mut self, func_name: &str, block: &Block) {
        for stmt in &block.statements {
            self.collect_local_arrays_from_stmt(func_name, stmt);
        }
    }

    fn collect_local_arrays_from_stmt(&mut self, func_name: &str, stmt: &Statement) {
        match stmt {
            Statement::Variable(var_decl) => {
                let var_type = self.convert_ast_type(&var_decl.var_type);
                if let DctlType::Array(_, Some(size)) = var_type {
                    self.local_array_sizes.insert(
                        (func_name.to_string(), var_decl.name.clone()),
                        size,
                    );
                }
            }
            Statement::Block(block) => {
                self.collect_local_arrays_from_block(func_name, block);
            }
            Statement::If(if_stmt) => {
                self.collect_local_arrays_from_stmt(func_name, &if_stmt.then_branch);
                if let Some(ref else_branch) = if_stmt.else_branch {
                    self.collect_local_arrays_from_stmt(func_name, else_branch);
                }
            }
            Statement::While(while_stmt) => {
                self.collect_local_arrays_from_stmt(func_name, &while_stmt.body);
            }
            Statement::DoWhile(do_while_stmt) => {
                self.collect_local_arrays_from_stmt(func_name, &do_while_stmt.body);
            }
            Statement::For(for_stmt) => {
                if let Some(ForInit::Variables(var_decls)) = &for_stmt.init {
                    for var_decl in var_decls {
                        let var_type = self.convert_ast_type(&var_decl.var_type);
                        if let DctlType::Array(_, Some(size)) = var_type {
                            self.local_array_sizes.insert(
                                (func_name.to_string(), var_decl.name.clone()),
                                size,
                            );
                        }
                    }
                }
                self.collect_local_arrays_from_stmt(func_name, &for_stmt.body);
            }
            Statement::Switch(switch_stmt) => {
                for case in &switch_stmt.cases {
                    for case_stmt in &case.statements {
                        self.collect_local_arrays_from_stmt(func_name, case_stmt);
                    }
                }
            }
            _ => {}
        }
    }

    /// Scan function calls to find where arrays are passed to pointer parameters
    fn scan_calls_for_pointer_params(
        &mut self,
        caller_func_name: &str,
        block: &Block,
        func_pointer_params: &HashMap<String, Vec<(usize, DctlType)>>,
    ) {
        for stmt in &block.statements {
            self.scan_stmt_for_calls(caller_func_name, stmt, func_pointer_params);
        }
    }

    fn scan_stmt_for_calls(
        &mut self,
        caller_func_name: &str,
        stmt: &Statement,
        func_pointer_params: &HashMap<String, Vec<(usize, DctlType)>>,
    ) {
        match stmt {
            Statement::Expression(expr_stmt) => {
                self.scan_expr_for_calls(caller_func_name, &expr_stmt.expression, func_pointer_params);
            }
            Statement::Variable(var_decl) => {
                if let Some(ref init) = var_decl.initializer {
                    self.scan_expr_for_calls(caller_func_name, init, func_pointer_params);
                }
            }
            Statement::Block(block) => {
                self.scan_calls_for_pointer_params(caller_func_name, block, func_pointer_params);
            }
            Statement::If(if_stmt) => {
                self.scan_expr_for_calls(caller_func_name, &if_stmt.condition, func_pointer_params);
                self.scan_stmt_for_calls(caller_func_name, &if_stmt.then_branch, func_pointer_params);
                if let Some(ref else_branch) = if_stmt.else_branch {
                    self.scan_stmt_for_calls(caller_func_name, else_branch, func_pointer_params);
                }
            }
            Statement::While(while_stmt) => {
                self.scan_expr_for_calls(caller_func_name, &while_stmt.condition, func_pointer_params);
                self.scan_stmt_for_calls(caller_func_name, &while_stmt.body, func_pointer_params);
            }
            Statement::DoWhile(do_while_stmt) => {
                self.scan_stmt_for_calls(caller_func_name, &do_while_stmt.body, func_pointer_params);
                self.scan_expr_for_calls(caller_func_name, &do_while_stmt.condition, func_pointer_params);
            }
            Statement::For(for_stmt) => {
                if let Some(ForInit::Expression(expr)) = &for_stmt.init {
                    self.scan_expr_for_calls(caller_func_name, expr, func_pointer_params);
                }
                if let Some(ref cond) = for_stmt.condition {
                    self.scan_expr_for_calls(caller_func_name, cond, func_pointer_params);
                }
                if let Some(ref update) = for_stmt.update {
                    self.scan_expr_for_calls(caller_func_name, update, func_pointer_params);
                }
                self.scan_stmt_for_calls(caller_func_name, &for_stmt.body, func_pointer_params);
            }
            Statement::Switch(switch_stmt) => {
                self.scan_expr_for_calls(caller_func_name, &switch_stmt.expression, func_pointer_params);
                for case in &switch_stmt.cases {
                    for case_stmt in &case.statements {
                        self.scan_stmt_for_calls(caller_func_name, case_stmt, func_pointer_params);
                    }
                }
            }
            Statement::Return(ret_stmt) => {
                if let Some(ref val) = ret_stmt.value {
                    self.scan_expr_for_calls(caller_func_name, val, func_pointer_params);
                }
            }
            _ => {}
        }
    }

    fn scan_expr_for_calls(
        &mut self,
        caller_func_name: &str,
        expr: &Expression,
        func_pointer_params: &HashMap<String, Vec<(usize, DctlType)>>,
    ) {
        match expr {
            Expression::Call(call_expr) => {
                // Check if this is a call to a function with pointer parameters
                if let Expression::Identifier(callee_ident) = call_expr.callee.as_ref() {
                    let callee_name = &callee_ident.name;
                    if let Some(pointer_params) = func_pointer_params.get(callee_name) {
                        // Check each argument at a pointer parameter position
                        for (param_idx, _param_type) in pointer_params {
                            if *param_idx < call_expr.args.len() {
                                let arg = &call_expr.args[*param_idx];

                                // Helper to find array name and look up size
                                let mut try_register_array = |array_name: &str| {
                                    // Check if it's a local array
                                    let key = (caller_func_name.to_string(), array_name.to_string());
                                    if let Some(&size) = self.local_array_sizes.get(&key) {
                                        self.pointer_param_array_sizes.insert(
                                            (callee_name.clone(), *param_idx),
                                            size,
                                        );
                                        return;
                                    }
                                    // Check global arrays
                                    if let Some(&(_, ref _elem_type)) = self.global_array_sizes.get(array_name) {
                                        // For global arrays, get size from global_variable_types
                                        if let DctlType::Array(_, Some(size)) = self.global_variable_types.get(array_name).cloned().unwrap_or(DctlType::Void) {
                                            self.pointer_param_array_sizes.insert(
                                                (callee_name.clone(), *param_idx),
                                                size,
                                            );
                                        }
                                    }
                                };

                                // Check if arg is a simple identifier (array name)
                                if let Expression::Identifier(arg_ident) = arg {
                                    try_register_array(&arg_ident.name);
                                }
                                // Handle &ARRAY[0] pattern: Unary(AddrOf, Index(Identifier, ...))
                                else if let Expression::Unary(unary) = arg {
                                    if matches!(unary.op, UnaryOp::AddrOf) {
                                        if let Expression::Index(index_expr) = unary.operand.as_ref() {
                                            if let Expression::Identifier(arr_ident) = index_expr.object.as_ref() {
                                                try_register_array(&arr_ident.name);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // Recursively scan arguments
                for arg in &call_expr.args {
                    self.scan_expr_for_calls(caller_func_name, arg, func_pointer_params);
                }
            }
            Expression::Binary(bin_expr) => {
                self.scan_expr_for_calls(caller_func_name, &bin_expr.left, func_pointer_params);
                self.scan_expr_for_calls(caller_func_name, &bin_expr.right, func_pointer_params);
            }
            Expression::Unary(unary_expr) => {
                self.scan_expr_for_calls(caller_func_name, &unary_expr.operand, func_pointer_params);
            }
            Expression::Ternary(ternary_expr) => {
                self.scan_expr_for_calls(caller_func_name, &ternary_expr.condition, func_pointer_params);
                self.scan_expr_for_calls(caller_func_name, &ternary_expr.then_expr, func_pointer_params);
                self.scan_expr_for_calls(caller_func_name, &ternary_expr.else_expr, func_pointer_params);
            }
            Expression::Index(index_expr) => {
                self.scan_expr_for_calls(caller_func_name, &index_expr.object, func_pointer_params);
                self.scan_expr_for_calls(caller_func_name, &index_expr.index, func_pointer_params);
            }
            Expression::Member(member_expr) => {
                self.scan_expr_for_calls(caller_func_name, &member_expr.object, func_pointer_params);
            }
            Expression::Cast(cast_expr) => {
                self.scan_expr_for_calls(caller_func_name, &cast_expr.operand, func_pointer_params);
            }
            Expression::Assignment(assign_expr) => {
                self.scan_expr_for_calls(caller_func_name, &assign_expr.left, func_pointer_params);
                self.scan_expr_for_calls(caller_func_name, &assign_expr.right, func_pointer_params);
            }
            Expression::Comma(comma_expr) => {
                for e in &comma_expr.expressions {
                    self.scan_expr_for_calls(caller_func_name, e, func_pointer_params);
                }
            }
            Expression::InitializerList(init_list) => {
                for e in &init_list.elements {
                    self.scan_expr_for_calls(caller_func_name, e, func_pointer_params);
                }
            }
            _ => {}
        }
    }
}
