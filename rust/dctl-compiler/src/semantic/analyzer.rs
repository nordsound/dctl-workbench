//! Semantic Analyzer
//!
//! Performs type checking, symbol resolution, and semantic validation.

use super::types::*;
use super::{AnalysisResult, SemanticError};
use crate::parser::{
    AssignmentOp, BaseType, BinaryOp, Block, Declaration, DctlModule, Expression, ForInit,
    FunctionDecl, Statement, Type, UnaryOp,
};
use crate::{Diagnostic, DiagnosticSeverity, Parameter, ParameterType};

/// Semantic analyzer for DCTL code
pub struct SemanticAnalyzer {
    /// Symbol table for tracking declarations
    symbols: SymbolTable,
    /// Collected diagnostics
    diagnostics: Vec<Diagnostic>,
    /// Current function being analyzed
    current_function: Option<String>,
    /// Current function's return type
    current_return_type: Option<DctlType>,
    /// Detected entry point
    entry_point: Option<String>,
    /// Extracted UI parameters
    parameters: Vec<Parameter>,
    /// Loop nesting count (for break/continue validation)
    loop_depth: usize,
    /// Switch nesting count
    switch_depth: usize,
    /// UI parameter names (to skip duplicate variable declarations)
    ui_param_names: std::collections::HashSet<String>,
}

impl SemanticAnalyzer {
    /// Create a new semantic analyzer
    pub fn new() -> Self {
        Self {
            symbols: SymbolTable::new(),
            diagnostics: Vec::new(),
            current_function: None,
            current_return_type: None,
            entry_point: None,
            parameters: Vec::new(),
            loop_depth: 0,
            switch_depth: 0,
            ui_param_names: std::collections::HashSet::new(),
        }
    }

    /// Analyze a DCTL module
    pub fn analyze(&mut self, module: &DctlModule) -> Result<AnalysisResult, SemanticError> {
        // Pass 0: Register UI parameters as global variables
        self.register_ui_params_as_variables(module);

        // Pass 1: Collect struct and function signatures
        self.collect_declarations(module)?;

        // Pass 2: Analyze function bodies
        self.analyze_functions(module)?;

        // Pass 3: Extract UI parameters
        self.extract_ui_params(module);

        // Pass 4: Validate entry point
        self.validate_entry_point()?;

        Ok(AnalysisResult {
            module: module.clone(),
            diagnostics: std::mem::take(&mut self.diagnostics),
            parameters: std::mem::take(&mut self.parameters),
            entry_point: self
                .entry_point
                .clone()
                .unwrap_or_else(|| "transform".to_string()),
        })
    }

    /// Pass 0: Register UI parameters as global variables
    fn register_ui_params_as_variables(&mut self, module: &DctlModule) {
        for ui_param in &module.ui_params {
            let param_type = match &ui_param.ui_type {
                crate::parser::UiParamType::SliderFloat { .. } => DctlType::Float,
                crate::parser::UiParamType::SliderInt { .. } => DctlType::Int,
                crate::parser::UiParamType::CheckBox { .. } => DctlType::Int, // bool as int
                crate::parser::UiParamType::ComboBox { .. } => DctlType::Int,
            };

            // Track UI param names to skip duplicate variable declarations
            self.ui_param_names.insert(ui_param.name.clone());

            self.symbols
                .define(Symbol {
                    name: ui_param.name.clone(),
                    symbol_type: param_type,
                    kind: SymbolKind::Variable,
                    line: ui_param.loc.line,
                })
                .ok(); // Ignore errors (e.g., duplicate definitions)
        }
    }

    /// Pass 1: Collect top-level declarations
    fn collect_declarations(&mut self, module: &DctlModule) -> Result<(), SemanticError> {
        for decl in &module.declarations {
            match decl {
                Declaration::Struct(struct_decl) => {
                    let fields: Vec<(String, DctlType)> = struct_decl
                        .fields
                        .iter()
                        .map(|f| (f.name.clone(), self.convert_type(&f.field_type)))
                        .collect();

                    self.symbols.structs.insert(
                        struct_decl.name.clone(),
                        StructDef {
                            name: struct_decl.name.clone(),
                            fields,
                        },
                    );
                }

                Declaration::Function(func_decl) => {
                    self.register_function(func_decl)?;
                }

                Declaration::Variable(var_decl) => {
                    // Skip variable declarations that match UI param names
                    // (preprocessor converts DEFINE_UI_PARAMS to variable declarations)
                    if self.ui_param_names.contains(&var_decl.name) {
                        continue;
                    }
                    let var_type = self.convert_type(&var_decl.var_type);
                    self.symbols
                        .define(Symbol {
                            name: var_decl.name.clone(),
                            symbol_type: var_type,
                            kind: SymbolKind::Variable,
                            line: var_decl.loc.line,
                        })
                        .map_err(|_msg| SemanticError::DuplicateDefinition {
                            name: var_decl.name.clone(),
                            line: var_decl.loc.line,
                        })?;
                }

                Declaration::Typedef(typedef_decl) => {
                    let target = self.convert_type(&typedef_decl.target_type);
                    self.symbols
                        .typedefs
                        .insert(typedef_decl.name.clone(), target);
                }

                Declaration::Macro(_) => {
                    // Macros are processed separately
                }
            }
        }

        Ok(())
    }

    /// Register a function in the symbol table
    fn register_function(&mut self, func: &FunctionDecl) -> Result<(), SemanticError> {
        let params: Vec<(String, DctlType)> = func
            .params
            .iter()
            .map(|p| {
                let param_type = self.convert_parameter_type(p);
                (p.name.clone(), param_type)
            })
            .collect();

        let return_type = self.convert_type(&func.return_type);

        // Check if this is the main transform function
        if self.is_transform_function(func) {
            self.entry_point = Some(func.name.clone());
        }

        let is_device = func
            .modifiers
            .iter()
            .any(|m| matches!(m, crate::parser::Modifier::Device));

        let func_def = FunctionDef {
            name: func.name.clone(),
            params,
            return_type,
            is_device,
        };
        self.symbols.function_overloads
            .entry(func.name.clone())
            .or_insert_with(Vec::new)
            .push(func_def.clone());
        self.symbols.functions.insert(func.name.clone(), func_def);

        Ok(())
    }

    /// Check if a function is the main transform function
    fn is_transform_function(&self, func: &FunctionDecl) -> bool {
        // Check return type is float3
        let ret_type = self.convert_type(&func.return_type);
        if ret_type != DctlType::Vec3(ScalarType::Float) {
            return false;
        }

        // Check for standard transform signature patterns
        let param_count = func.params.len();

        // Pattern 1: (int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
        if param_count == 7 {
            return true;
        }

        // Pattern 2: (float p_R, float p_G, float p_B)
        if param_count == 3 {
            let all_float = func
                .params
                .iter()
                .all(|p| self.convert_type(&p.param_type) == DctlType::Float);
            if all_float {
                return true;
            }
        }

        false
    }

    /// Pass 2: Analyze function bodies
    fn analyze_functions(&mut self, module: &DctlModule) -> Result<(), SemanticError> {
        for decl in &module.declarations {
            if let Declaration::Function(func) = decl {
                if func.body.is_some() {
                    self.analyze_function_body(func)?;
                }
            }
        }
        Ok(())
    }

    /// Analyze a function body
    fn analyze_function_body(&mut self, func: &FunctionDecl) -> Result<(), SemanticError> {
        self.current_function = Some(func.name.clone());
        self.current_return_type = Some(self.convert_type(&func.return_type));
        self.symbols.push_scope();

        // Add parameters to scope
        for param in &func.params {
            let param_type = self.convert_parameter_type(param);
            self.symbols
                .define(Symbol {
                    name: param.name.clone(),
                    symbol_type: param_type,
                    kind: SymbolKind::Parameter,
                    line: param.loc.line,
                })
                .ok(); // Ignore duplicate parameter errors for now
        }

        // Analyze function body
        if let Some(body) = &func.body {
            self.analyze_block(body)?;
        }

        self.symbols.pop_scope();
        self.current_function = None;
        self.current_return_type = None;

        Ok(())
    }

    /// Analyze a block of statements
    fn analyze_block(&mut self, block: &Block) -> Result<(), SemanticError> {
        self.symbols.push_scope();

        for stmt in &block.statements {
            self.analyze_statement(stmt)?;
        }

        self.symbols.pop_scope();
        Ok(())
    }

    /// Analyze a statement
    fn analyze_statement(&mut self, stmt: &Statement) -> Result<(), SemanticError> {
        match stmt {
            Statement::Block(block) => {
                // Check if block only contains variable declarations
                // If so, flatten it to avoid creating a nested scope
                // This handles multi-variable declarations like "int i, j;" which
                // the TS parser wraps in a Block
                let is_var_only = block.statements.iter().all(|s| {
                    matches!(s, Statement::Variable(_))
                });

                if is_var_only {
                    // Flatten: analyze statements without creating new scope
                    for inner_stmt in &block.statements {
                        self.analyze_statement(inner_stmt)?;
                    }
                } else {
                    // Normal block - create new scope
                    self.analyze_block(block)?;
                }
            }

            Statement::Variable(var_decl) => {
                let var_type = self.convert_type(&var_decl.var_type);

                // Check void type
                if var_type == DctlType::Void {
                    self.add_diagnostic(
                        DiagnosticSeverity::Error,
                        format!(
                            "Cannot declare variable '{}' with void type",
                            var_decl.name
                        ),
                        var_decl.loc.line,
                        var_decl.loc.column,
                    );
                }

                // Add to current scope
                self.symbols
                    .define(Symbol {
                        name: var_decl.name.clone(),
                        symbol_type: var_type.clone(),
                        kind: SymbolKind::Variable,
                        line: var_decl.loc.line,
                    })
                    .ok();

                // Analyze initializer
                if let Some(init) = &var_decl.initializer {
                    let init_type = self.analyze_expression(init);

                    // Check type compatibility
                    if let Some(init_t) = init_type {
                        if !self.is_type_compatible(&init_t, &var_type) {
                            self.add_diagnostic(
                                DiagnosticSeverity::Warning,
                                format!(
                                    "Type mismatch: initializing '{}' with '{}'",
                                    var_type.display_name(),
                                    init_t.display_name()
                                ),
                                var_decl.loc.line,
                                var_decl.loc.column,
                            );
                        }
                    }
                }
            }

            Statement::Expression(expr_stmt) => {
                self.analyze_expression(&expr_stmt.expression);
            }

            Statement::If(if_stmt) => {
                self.analyze_expression(&if_stmt.condition);
                self.analyze_statement(&if_stmt.then_branch)?;
                if let Some(else_branch) = &if_stmt.else_branch {
                    self.analyze_statement(else_branch)?;
                }
            }

            Statement::While(while_stmt) => {
                self.analyze_expression(&while_stmt.condition);
                self.loop_depth += 1;
                self.analyze_statement(&while_stmt.body)?;
                self.loop_depth -= 1;
            }

            Statement::DoWhile(do_while_stmt) => {
                self.loop_depth += 1;
                self.analyze_statement(&do_while_stmt.body)?;
                self.loop_depth -= 1;
                self.analyze_expression(&do_while_stmt.condition);
            }

            Statement::For(for_stmt) => {
                self.symbols.push_scope();

                // Analyze init
                if let Some(init) = &for_stmt.init {
                    match init {
                        ForInit::Variables(var_decls) => {
                            for var_decl in var_decls {
                                let var_type = self.convert_type(&var_decl.var_type);
                                self.symbols
                                    .define(Symbol {
                                        name: var_decl.name.clone(),
                                        symbol_type: var_type,
                                        kind: SymbolKind::Variable,
                                        line: var_decl.loc.line,
                                    })
                                    .ok();
                                if let Some(init_expr) = &var_decl.initializer {
                                    self.analyze_expression(init_expr);
                                }
                            }
                        }
                        ForInit::Expression(expr) => {
                            self.analyze_expression(expr);
                        }
                    }
                }

                // Analyze condition
                if let Some(cond) = &for_stmt.condition {
                    self.analyze_expression(cond);
                }

                // Analyze update
                if let Some(update) = &for_stmt.update {
                    self.analyze_expression(update);
                }

                // Analyze body
                self.loop_depth += 1;
                self.analyze_statement(&for_stmt.body)?;
                self.loop_depth -= 1;

                self.symbols.pop_scope();
            }

            Statement::Switch(switch_stmt) => {
                self.analyze_expression(&switch_stmt.expression);

                self.switch_depth += 1;
                for case in &switch_stmt.cases {
                    if let Some(value) = &case.value {
                        self.analyze_expression(value);
                    }
                    for case_stmt in &case.statements {
                        self.analyze_statement(case_stmt)?;
                    }
                }
                self.switch_depth -= 1;
            }

            Statement::Return(return_stmt) => {
                let return_type = return_stmt
                    .value
                    .as_ref()
                    .and_then(|v| self.analyze_expression(v));

                // Check return type compatibility
                if let Some(expected) = &self.current_return_type {
                    if expected == &DctlType::Void {
                        if return_type.is_some() {
                            self.add_diagnostic(
                                DiagnosticSeverity::Error,
                                "Void function should not return a value".to_string(),
                                return_stmt.loc.line,
                                return_stmt.loc.column,
                            );
                        }
                    } else if return_type.is_none() && return_stmt.value.is_none() {
                        self.add_diagnostic(
                            DiagnosticSeverity::Error,
                            format!(
                                "Non-void function must return a value of type '{}'",
                                expected.display_name()
                            ),
                            return_stmt.loc.line,
                            return_stmt.loc.column,
                        );
                    }
                }
            }

            Statement::Break(break_stmt) => {
                if self.loop_depth == 0 && self.switch_depth == 0 {
                    self.add_diagnostic(
                        DiagnosticSeverity::Error,
                        "Break statement outside loop or switch".to_string(),
                        break_stmt.loc.line,
                        break_stmt.loc.column,
                    );
                }
            }

            Statement::Continue(continue_stmt) => {
                if self.loop_depth == 0 {
                    self.add_diagnostic(
                        DiagnosticSeverity::Error,
                        "Continue statement outside loop".to_string(),
                        continue_stmt.loc.line,
                        continue_stmt.loc.column,
                    );
                }
            }

            Statement::Empty(_) => {
                // Nothing to analyze
            }
        }

        Ok(())
    }

    /// Analyze an expression and return its type
    fn analyze_expression(&mut self, expr: &Expression) -> Option<DctlType> {
        match expr {
            Expression::Literal(lit) => Some(self.analyze_literal(lit)),

            Expression::Identifier(ident) => {
                if let Some(symbol) = self.symbols.lookup(&ident.name) {
                    Some(symbol.symbol_type.clone())
                } else if self.symbols.functions.contains_key(&ident.name) {
                    // It's a function name
                    None
                } else {
                    self.add_diagnostic(
                        DiagnosticSeverity::Error,
                        format!("Undefined variable '{}'", ident.name),
                        ident.loc.line,
                        ident.loc.column,
                    );
                    None
                }
            }

            Expression::Binary(binary) => {
                let left_type = self.analyze_expression(&binary.left);
                let right_type = self.analyze_expression(&binary.right);
                self.infer_binary_type(binary.op, left_type, right_type)
            }

            Expression::Unary(unary) => {
                let operand_type = self.analyze_expression(&unary.operand);
                self.infer_unary_type(unary.op, operand_type)
            }

            Expression::Ternary(ternary) => {
                self.analyze_expression(&ternary.condition);
                let then_type = self.analyze_expression(&ternary.then_expr);
                let else_type = self.analyze_expression(&ternary.else_expr);

                // Return the type of then branch (or else if then is None)
                then_type.or(else_type)
            }

            Expression::Call(call) => {
                // Analyze arguments
                let arg_types: Vec<Option<DctlType>> = call
                    .args
                    .iter()
                    .map(|arg| self.analyze_expression(arg))
                    .collect();

                // Get function name
                let func_name = if let Expression::Identifier(ident) = call.callee.as_ref() {
                    Some(ident.name.clone())
                } else {
                    self.analyze_expression(&call.callee);
                    None
                };

                if let Some(name) = func_name {
                    self.infer_call_type(&name, &arg_types)
                } else {
                    None
                }
            }

            Expression::Index(index) => {
                let object_type = self.analyze_expression(&index.object);
                self.analyze_expression(&index.index);

                // Return element type
                object_type.and_then(|t| self.get_element_type(&t))
            }

            Expression::Member(member) => {
                let object_type = self.analyze_expression(&member.object);
                self.infer_member_type(object_type, &member.member)
            }

            Expression::Cast(cast) => {
                self.analyze_expression(&cast.operand);
                Some(self.convert_type(&cast.target_type))
            }

            Expression::Sizeof(_) => Some(DctlType::UInt),

            Expression::Assignment(assign) => {
                let left_type = self.analyze_expression(&assign.left);
                let right_type = self.analyze_expression(&assign.right);

                // Check assignment operator validity
                if assign.op != AssignmentOp::Assign {
                    // Compound assignments require numeric types
                    if let Some(ref lt) = left_type {
                        if !lt.is_numeric() {
                            self.add_diagnostic(
                                DiagnosticSeverity::Error,
                                format!(
                                    "Cannot apply compound assignment to non-numeric type '{}'",
                                    lt.display_name()
                                ),
                                assign.loc.line,
                                assign.loc.column,
                            );
                        }
                    }
                }

                // Check type compatibility
                if let (Some(lt), Some(rt)) = (&left_type, &right_type) {
                    // For compound assignments (+=, *=, etc.), compute the result type
                    // of the equivalent binary operation first.
                    // E.g., for `float3 *= float`, the binary op `float3 * float` yields `float3`,
                    // so the effective assignment is `float3 = float3` which is valid.
                    let effective_right = if assign.op != AssignmentOp::Assign {
                        let binary_op = compound_assign_to_binary_op(assign.op);
                        self.infer_binary_type(binary_op, Some(lt.clone()), Some(rt.clone()))
                            .unwrap_or_else(|| rt.clone())
                    } else {
                        rt.clone()
                    };

                    if !self.is_type_compatible(&effective_right, lt) {
                        self.add_diagnostic(
                            DiagnosticSeverity::Warning,
                            format!(
                                "Assignment type mismatch: '{}' = '{}'",
                                lt.display_name(),
                                effective_right.display_name()
                            ),
                            assign.loc.line,
                            assign.loc.column,
                        );
                    }
                }

                left_type
            }

            Expression::Comma(comma) => {
                // Analyze all expressions, return type of last one
                let mut last_type = None;
                for expr in &comma.expressions {
                    last_type = self.analyze_expression(expr);
                }
                last_type
            }

            Expression::InitializerList(init_list) => {
                for element in &init_list.elements {
                    self.analyze_expression(element);
                }
                // Cannot determine type from initializer list alone
                None
            }
        }
    }

    /// Analyze a literal and return its type
    fn analyze_literal(&self, lit: &crate::parser::LiteralExpr) -> DctlType {
        match &lit.value {
            crate::parser::LiteralValue::Int(_) => DctlType::Int,
            crate::parser::LiteralValue::UInt(_) => DctlType::UInt,
            crate::parser::LiteralValue::Float(_) => DctlType::Float,
            crate::parser::LiteralValue::Bool(_) => DctlType::Bool,
            crate::parser::LiteralValue::Char(_) => DctlType::Char,
            crate::parser::LiteralValue::String(_) => {
                DctlType::Array(Box::new(DctlType::Char), None)
            }
        }
    }

    /// Infer type from binary operation
    fn infer_binary_type(
        &self,
        op: BinaryOp,
        left: Option<DctlType>,
        right: Option<DctlType>,
    ) -> Option<DctlType> {
        // Comparison and logical operators return int (C uses int for boolean)
        match op {
            BinaryOp::Eq
            | BinaryOp::Ne
            | BinaryOp::Lt
            | BinaryOp::Le
            | BinaryOp::Gt
            | BinaryOp::Ge
            | BinaryOp::And
            | BinaryOp::Or => return Some(DctlType::Int),
            _ => {}
        }

        // For arithmetic operators, handle vector/scalar promotion
        match (left, right) {
            (Some(l), Some(r)) => {
                // Vector promotion: if one is vector, result is vector
                if l.is_vector() && !r.is_vector() {
                    Some(l)
                } else if !l.is_vector() && r.is_vector() {
                    Some(r)
                } else {
                    // Same type or both scalars - return left type
                    Some(l)
                }
            }
            (Some(l), None) => Some(l),
            (None, Some(r)) => Some(r),
            (None, None) => None,
        }
    }

    /// Infer type from unary operation
    fn infer_unary_type(&self, op: UnaryOp, operand: Option<DctlType>) -> Option<DctlType> {
        match op {
            UnaryOp::Not => Some(DctlType::Int), // Logical not returns int
            UnaryOp::AddrOf => {
                operand.map(|t| DctlType::Pointer(Box::new(t)))
            }
            UnaryOp::Deref => {
                operand.and_then(|t| {
                    if let DctlType::Pointer(inner) = t {
                        Some(*inner)
                    } else {
                        None
                    }
                })
            }
            _ => operand, // Other unary ops preserve type
        }
    }

    /// Infer type from function call
    fn infer_call_type(&self, name: &str, arg_types: &[Option<DctlType>]) -> Option<DctlType> {
        // Check built-in element-wise math functions
        if is_elementwise_math_function(name) {
            if let Some(Some(first_arg)) = arg_types.first() {
                // Return type matches first argument type
                return Some(first_arg.clone());
            }
        }

        // Check built-in binary element-wise functions (pow, min, max, etc.)
        if is_elementwise_binary_function(name) && arg_types.len() >= 2 {
            // Return the "larger" type (vector > scalar)
            let first = arg_types.first().and_then(|t| t.clone());
            let second = arg_types.get(1).and_then(|t| t.clone());

            match (first, second) {
                (Some(f), Some(s)) => {
                    if f.is_vector() {
                        return Some(f);
                    } else if s.is_vector() {
                        return Some(s);
                    }
                    return Some(f);
                }
                (Some(f), None) => return Some(f),
                (None, Some(s)) => return Some(s),
                _ => {}
            }
        }

        // Look up user-defined function with overload resolution
        if let Some(overloads) = self.symbols.function_overloads.get(name) {
            if overloads.len() == 1 {
                return Some(overloads[0].return_type.clone());
            }

            // Score each overload and find the best match
            let mut best: Option<(&FunctionDef, i32)> = None;
            for func_def in overloads {
                if func_def.params.len() != arg_types.len() {
                    continue;
                }
                let mut score = 0i32;
                let mut has_mismatch = false;
                for (i, (_, param_type)) in func_def.params.iter().enumerate() {
                    if let Some(arg_type) = &arg_types[i] {
                        if self.is_type_compatible(arg_type, param_type) {
                            score += 10;
                        } else {
                            has_mismatch = true;
                            break;
                        }
                    } else {
                        // Unknown arg type - don't penalize
                    }
                }
                if has_mismatch {
                    continue;
                }
                if let Some((_, best_score)) = best {
                    if score > best_score {
                        best = Some((func_def, score));
                    }
                } else {
                    best = Some((func_def, score));
                }
            }

            if let Some((func_def, _)) = best {
                return Some(func_def.return_type.clone());
            }

            // Fallback: return the first overload with matching arg count
            for func_def in overloads {
                if func_def.params.len() == arg_types.len() {
                    return Some(func_def.return_type.clone());
                }
            }
        }

        // Fall back to single function lookup
        if let Some(func) = self.symbols.get_function(name) {
            return Some(func.return_type.clone());
        }

        None
    }

    /// Infer type from member access
    fn infer_member_type(&self, object_type: Option<DctlType>, member: &str) -> Option<DctlType> {
        let obj = object_type?;

        // Check struct field access
        if let DctlType::Struct(struct_name) = &obj {
            if let Some(struct_def) = self.symbols.get_struct(struct_name) {
                for (field_name, field_type) in &struct_def.fields {
                    if field_name == member {
                        return Some(field_type.clone());
                    }
                }
            }
        }

        // Check vector swizzle
        if obj.is_vector() {
            let valid_swizzle =
                member.chars().all(|c| matches!(c, 'x' | 'y' | 'z' | 'w' | 'r' | 'g' | 'b' | 'a'));

            if valid_swizzle {
                let scalar = obj.scalar_type()?;
                let len = member.len();

                return match len {
                    1 => match scalar {
                        ScalarType::Float => Some(DctlType::Float),
                        ScalarType::Int => Some(DctlType::Int),
                        ScalarType::UInt => Some(DctlType::UInt),
                        ScalarType::Half => Some(DctlType::Half),
                        ScalarType::Bool => Some(DctlType::Bool),
                    },
                    2 => Some(DctlType::Vec2(scalar)),
                    3 => Some(DctlType::Vec3(scalar)),
                    4 => Some(DctlType::Vec4(scalar)),
                    _ => None,
                };
            }
        }

        // Check matrix row access
        if obj.is_matrix() {
            // Matrix indexing returns a row vector
            let size = if matches!(obj, DctlType::Mat3) { 3 } else { 4 };
            return Some(match size {
                3 => DctlType::Vec3(ScalarType::Float),
                _ => DctlType::Vec4(ScalarType::Float),
            });
        }

        None
    }

    /// Get element type for array/vector indexing
    fn get_element_type(&self, container: &DctlType) -> Option<DctlType> {
        match container {
            DctlType::Array(inner, _) => Some(inner.as_ref().clone()),
            DctlType::Pointer(inner) => Some(inner.as_ref().clone()),
            DctlType::Vec2(s) | DctlType::Vec3(s) | DctlType::Vec4(s) => match s {
                ScalarType::Float => Some(DctlType::Float),
                ScalarType::Int => Some(DctlType::Int),
                ScalarType::UInt => Some(DctlType::UInt),
                ScalarType::Half => Some(DctlType::Half),
                ScalarType::Bool => Some(DctlType::Bool),
            },
            DctlType::Mat3 => Some(DctlType::Vec3(ScalarType::Float)),
            DctlType::Mat4 => Some(DctlType::Vec4(ScalarType::Float)),
            _ => None,
        }
    }

    /// Check if two types are compatible for assignment
    fn is_type_compatible(&self, actual: &DctlType, expected: &DctlType) -> bool {
        // Resolve typedef aliases
        let actual = self.resolve_typedef(actual);
        let expected = self.resolve_typedef(expected);

        // Exact match
        if actual == expected {
            return true;
        }

        // bool <-> int compatibility (C uses int for boolean)
        if (actual == DctlType::Bool && expected == DctlType::Int)
            || (actual == DctlType::Int && expected == DctlType::Bool)
        {
            return true;
        }

        // Implicit numeric conversions
        if actual.is_numeric() && expected.is_numeric() {
            // Both are numeric - allow conversion
            if actual.is_scalar() && expected.is_scalar() {
                return true;
            }

            // Same-size vectors are compatible
            if actual.vector_size() > 0 && actual.vector_size() == expected.vector_size() {
                return true;
            }
        }

        // Array to pointer decay
        if let (DctlType::Array(inner_a, _), DctlType::Pointer(inner_e)) = (&actual, &expected) {
            return self.is_type_compatible(inner_a, inner_e);
        }

        false
    }

    /// Resolve typedef to underlying type
    fn resolve_typedef(&self, t: &DctlType) -> DctlType {
        // For now, just return the type as-is
        // A full implementation would resolve typedef chains
        t.clone()
    }

    /// Pass 3: Extract UI parameters
    fn extract_ui_params(&mut self, module: &DctlModule) {
        for ui_param in &module.ui_params {
            let param_type = match &ui_param.ui_type {
                crate::parser::UiParamType::SliderFloat {
                    default,
                    min,
                    max,
                    step,
                } => ParameterType::Float {
                    default: *default as f32,
                    min: *min as f32,
                    max: *max as f32,
                    step: *step as f32,
                },
                crate::parser::UiParamType::SliderInt {
                    default,
                    min,
                    max,
                    step,
                } => ParameterType::Int {
                    default: *default as i32,
                    min: *min as i32,
                    max: *max as i32,
                    step: *step as i32,
                },
                crate::parser::UiParamType::CheckBox { default } => {
                    ParameterType::Bool { default: *default }
                }
                crate::parser::UiParamType::ComboBox { default, options } => ParameterType::Combo {
                    default: *default as i32,
                    options: options.clone(),
                },
            };

            self.parameters.push(Parameter {
                name: ui_param.name.clone(),
                label: ui_param.label.clone(),
                param_type,
            });
        }
    }

    /// Pass 4: Validate entry point
    fn validate_entry_point(&mut self) -> Result<(), SemanticError> {
        if self.entry_point.is_none() {
            // Try to find a function named "transform"
            if self.symbols.functions.contains_key("transform") {
                self.entry_point = Some("transform".to_string());
            } else {
                self.diagnostics.push(Diagnostic {
                    severity: DiagnosticSeverity::Warning,
                    message: "No transform function found".to_string(),
                    line: 0,
                    column: 0,
                });
            }
        }
        Ok(())
    }

    /// Convert a parameter's type, taking modifiers into account
    fn convert_parameter_type(&self, param: &crate::parser::Parameter) -> DctlType {
        // Check if parameter has __TEXTURE__ modifier
        for modifier in &param.modifiers {
            match modifier {
                crate::parser::Modifier::Texture | crate::parser::Modifier::Texture2D => {
                    return DctlType::Texture2D;
                }
                crate::parser::Modifier::Texture3D => {
                    return DctlType::Texture3D;
                }
                _ => {}
            }
        }
        // Otherwise, use the regular type conversion
        self.convert_type(&param.param_type)
    }

    /// Convert AST type to semantic type
    fn convert_type(&self, ast_type: &Type) -> DctlType {
        let base = self.convert_base_type(&ast_type.base);

        // Handle arrays
        let result = if !ast_type.array_dims.is_empty() {
            let mut current = base;
            for dim in ast_type.array_dims.iter().rev() {
                let size = match dim {
                    crate::parser::ArrayDim::Fixed(n) => Some(*n),
                    _ => None,
                };
                current = DctlType::Array(Box::new(current), size);
            }
            current
        } else {
            base
        };

        // Handle pointers
        if ast_type.is_pointer {
            DctlType::Pointer(Box::new(result))
        } else {
            result
        }
    }

    /// Convert AST base type to semantic base type
    fn convert_base_type(&self, base: &BaseType) -> DctlType {
        match base {
            BaseType::Void => DctlType::Void,
            BaseType::Bool => DctlType::Bool,
            BaseType::Char => DctlType::Char,
            BaseType::Int => DctlType::Int,
            BaseType::UInt => DctlType::UInt,
            BaseType::Float => DctlType::Float,
            BaseType::Double => DctlType::Double,
            BaseType::Half => DctlType::Half,
            BaseType::Float2 => DctlType::Vec2(ScalarType::Float),
            BaseType::Float3 => DctlType::Vec3(ScalarType::Float),
            BaseType::Float4 => DctlType::Vec4(ScalarType::Float),
            BaseType::Int2 => DctlType::Vec2(ScalarType::Int),
            BaseType::Int3 => DctlType::Vec3(ScalarType::Int),
            BaseType::Int4 => DctlType::Vec4(ScalarType::Int),
            BaseType::Half2 => DctlType::Vec2(ScalarType::Half),
            BaseType::Half3 => DctlType::Vec3(ScalarType::Half),
            BaseType::Half4 => DctlType::Vec4(ScalarType::Half),
            BaseType::Float2x2 => DctlType::Mat2,
            BaseType::Float3x3 => DctlType::Mat3,
            BaseType::Float4x4 => DctlType::Mat4,
            BaseType::Struct(name) => DctlType::Struct(name.clone()),
            BaseType::Typedef(name) => {
                // Try to resolve typedef
                if let Some(resolved) = self.symbols.resolve_typedef(name) {
                    resolved.clone()
                } else {
                    DctlType::Unknown
                }
            }
            BaseType::Texture2D => DctlType::Texture2D,
            BaseType::Texture3D => DctlType::Texture3D,
            BaseType::Sampler => DctlType::Sampler,
        }
    }

    /// Add a diagnostic message
    fn add_diagnostic(
        &mut self,
        severity: DiagnosticSeverity,
        message: String,
        line: usize,
        column: usize,
    ) {
        self.diagnostics.push(Diagnostic {
            severity,
            message,
            line,
            column,
        });
    }
}

impl Default for SemanticAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

/// Check if a function is an element-wise math function
fn is_elementwise_math_function(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "sin"
            | "cos"
            | "tan"
            | "asin"
            | "acos"
            | "atan"
            | "sinh"
            | "cosh"
            | "tanh"
            | "exp"
            | "exp2"
            | "log"
            | "log2"
            | "log10"
            | "sqrt"
            | "rsqrt"
            | "floor"
            | "ceil"
            | "round"
            | "trunc"
            | "fract"
            | "abs"
            | "fabs"
            | "sign"
            | "saturate"
            | "normalize"
            | "_sinf"
            | "_cosf"
            | "_tanf"
            | "_expf"
            | "_logf"
            | "_sqrtf"
            | "_fabsf"
            | "_floorf"
            | "_ceilf"
            | "_roundf"
            | "_saturatef"
    )
}

/// Check if a function is a binary element-wise function
fn is_elementwise_binary_function(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "pow"
            | "atan2"
            | "fmod"
            | "min"
            | "max"
            | "fmin"
            | "fmax"
            | "mix"
            | "lerp"
            | "clamp"
            | "step"
            | "smoothstep"
            | "_powf"
            | "_fminf"
            | "_fmaxf"
            | "_mix"
            | "_clampf"
    )
}

/// Map compound assignment operator to its equivalent binary operator.
/// E.g., `*=` maps to `*`, `+=` maps to `+`, etc.
fn compound_assign_to_binary_op(op: AssignmentOp) -> BinaryOp {
    match op {
        AssignmentOp::AddAssign => BinaryOp::Add,
        AssignmentOp::SubAssign => BinaryOp::Sub,
        AssignmentOp::MulAssign => BinaryOp::Mul,
        AssignmentOp::DivAssign => BinaryOp::Div,
        AssignmentOp::ModAssign => BinaryOp::Mod,
        AssignmentOp::BitAndAssign => BinaryOp::BitAnd,
        AssignmentOp::BitOrAssign => BinaryOp::BitOr,
        AssignmentOp::BitXorAssign => BinaryOp::BitXor,
        AssignmentOp::ShlAssign => BinaryOp::Shl,
        AssignmentOp::ShrAssign => BinaryOp::Shr,
        AssignmentOp::Assign => BinaryOp::Add, // Shouldn't be called with Assign
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{
        AssignmentExpr, AssignmentOp, BaseType, Block, Declaration,
        DctlModule, ExpressionStmt, FunctionDecl, IdentifierExpr, LiteralExpr, LiteralValue,
        Location, Modifier, Parameter, Statement, Type, VariableDecl,
    };

    fn loc() -> Location {
        Location { line: 1, column: 1, end_line: 1, end_column: 1 }
    }

    fn make_type(base: BaseType) -> Type {
        Type { base, is_pointer: false, is_const: false, array_dims: vec![] }
    }

    fn make_ident(name: &str) -> Expression {
        Expression::Identifier(IdentifierExpr { name: name.to_string(), loc: loc() })
    }

    fn make_float_literal(v: f64) -> Expression {
        Expression::Literal(LiteralExpr { value: LiteralValue::Float(v), loc: loc() })
    }

    #[test]
    fn test_analyzer_creation() {
        let analyzer = SemanticAnalyzer::new();
        assert!(analyzer.entry_point.is_none());
    }

    #[test]
    fn test_elementwise_function_detection() {
        assert!(is_elementwise_math_function("sin"));
        assert!(is_elementwise_math_function("SIN"));
        assert!(is_elementwise_math_function("_sinf"));
        assert!(!is_elementwise_math_function("make_float3"));
    }

    #[test]
    fn test_elementwise_binary_function_detection() {
        assert!(is_elementwise_binary_function("pow"));
        assert!(is_elementwise_binary_function("POW"));
        assert!(is_elementwise_binary_function("mix"));
        assert!(!is_elementwise_binary_function("sin"));
    }

    /// Test that compound assignment float3 *= float does NOT produce a type mismatch diagnostic.
    /// In DCTL/C, `vec *= scalar` is valid: it means `vec = vec * scalar` where the result is vec type.
    #[test]
    fn test_compound_assign_vector_scalar_no_false_positive() {
        // Build AST for:
        //   __DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
        //       float3 rgb = make_float3(p_R, p_G, p_B);
        //       float ds = 1.0;
        //       rgb *= ds;
        //       return rgb;
        //   }
        let module = DctlModule {
            declarations: vec![Declaration::Function(FunctionDecl {
                name: "transform".to_string(),
                return_type: make_type(BaseType::Float3),
                params: vec![
                    Parameter { name: "p_Width".to_string(), param_type: make_type(BaseType::Int), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_Height".to_string(), param_type: make_type(BaseType::Int), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_X".to_string(), param_type: make_type(BaseType::Int), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_Y".to_string(), param_type: make_type(BaseType::Int), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_R".to_string(), param_type: make_type(BaseType::Float), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_G".to_string(), param_type: make_type(BaseType::Float), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_B".to_string(), param_type: make_type(BaseType::Float), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                ],
                body: Some(Block {
                    statements: vec![
                        // float3 rgb = make_float3(p_R, p_G, p_B);
                        Statement::Variable(VariableDecl {
                            name: "rgb".to_string(),
                            var_type: make_type(BaseType::Float3),
                            initializer: Some(Expression::Call(crate::parser::CallExpr {
                                callee: Box::new(make_ident("make_float3")),
                                args: vec![make_ident("p_R"), make_ident("p_G"), make_ident("p_B")],
                                loc: loc(),
                            })),
                            is_const: false,
                            modifiers: vec![],
                            loc: loc(),
                        }),
                        // float ds = 1.0;
                        Statement::Variable(VariableDecl {
                            name: "ds".to_string(),
                            var_type: make_type(BaseType::Float),
                            initializer: Some(make_float_literal(1.0)),
                            is_const: false,
                            modifiers: vec![],
                            loc: loc(),
                        }),
                        // rgb *= ds;
                        Statement::Expression(ExpressionStmt {
                            expression: Expression::Assignment(AssignmentExpr {
                                op: AssignmentOp::MulAssign,
                                left: Box::new(make_ident("rgb")),
                                right: Box::new(make_ident("ds")),
                                loc: loc(),
                            }),
                            loc: loc(),
                        }),
                        // return rgb;
                        Statement::Return(crate::parser::ReturnStmt {
                            value: Some(make_ident("rgb")),
                            loc: loc(),
                        }),
                    ],
                    loc: loc(),
                }),
                modifiers: vec![Modifier::Device],
                loc: loc(),
            })],
            ui_params: vec![],
        };

        let mut analyzer = SemanticAnalyzer::new();
        let result = analyzer.analyze(&module);
        assert!(result.is_ok(), "Analysis should succeed");
        let analysis = result.unwrap();

        // Check that no diagnostic contains "Assignment type mismatch"
        let type_mismatch_diags: Vec<_> = analysis
            .diagnostics
            .iter()
            .filter(|d| d.message.contains("Assignment type mismatch"))
            .collect();

        assert!(
            type_mismatch_diags.is_empty(),
            "Should not produce 'Assignment type mismatch' for float3 *= float, but got: {:?}",
            type_mismatch_diags
        );
    }

    /// Test that regular assignment of incompatible types still produces a diagnostic.
    #[test]
    fn test_regular_assign_type_mismatch_still_detected() {
        // Build AST for:
        //   __DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
        //       float3 rgb = make_float3(p_R, p_G, p_B);
        //       float ds = 1.0;
        //       rgb = ds;  // Direct assignment of float to float3 should warn
        //       return rgb;
        //   }
        let module = DctlModule {
            declarations: vec![Declaration::Function(FunctionDecl {
                name: "transform".to_string(),
                return_type: make_type(BaseType::Float3),
                params: vec![
                    Parameter { name: "p_Width".to_string(), param_type: make_type(BaseType::Int), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_Height".to_string(), param_type: make_type(BaseType::Int), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_X".to_string(), param_type: make_type(BaseType::Int), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_Y".to_string(), param_type: make_type(BaseType::Int), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_R".to_string(), param_type: make_type(BaseType::Float), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_G".to_string(), param_type: make_type(BaseType::Float), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                    Parameter { name: "p_B".to_string(), param_type: make_type(BaseType::Float), is_const: false, is_pointer: false, modifiers: vec![], loc: loc() },
                ],
                body: Some(Block {
                    statements: vec![
                        // float3 rgb = make_float3(p_R, p_G, p_B);
                        Statement::Variable(VariableDecl {
                            name: "rgb".to_string(),
                            var_type: make_type(BaseType::Float3),
                            initializer: Some(Expression::Call(crate::parser::CallExpr {
                                callee: Box::new(make_ident("make_float3")),
                                args: vec![make_ident("p_R"), make_ident("p_G"), make_ident("p_B")],
                                loc: loc(),
                            })),
                            is_const: false,
                            modifiers: vec![],
                            loc: loc(),
                        }),
                        // float ds = 1.0;
                        Statement::Variable(VariableDecl {
                            name: "ds".to_string(),
                            var_type: make_type(BaseType::Float),
                            initializer: Some(make_float_literal(1.0)),
                            is_const: false,
                            modifiers: vec![],
                            loc: loc(),
                        }),
                        // rgb = ds;  (direct assignment - should warn)
                        Statement::Expression(ExpressionStmt {
                            expression: Expression::Assignment(AssignmentExpr {
                                op: AssignmentOp::Assign,
                                left: Box::new(make_ident("rgb")),
                                right: Box::new(make_ident("ds")),
                                loc: loc(),
                            }),
                            loc: loc(),
                        }),
                        // return rgb;
                        Statement::Return(crate::parser::ReturnStmt {
                            value: Some(make_ident("rgb")),
                            loc: loc(),
                        }),
                    ],
                    loc: loc(),
                }),
                modifiers: vec![Modifier::Device],
                loc: loc(),
            })],
            ui_params: vec![],
        };

        let mut analyzer = SemanticAnalyzer::new();
        let result = analyzer.analyze(&module);
        assert!(result.is_ok(), "Analysis should succeed");
        let analysis = result.unwrap();

        // Direct assignment of float to float3 SHOULD produce a type mismatch
        let type_mismatch_diags: Vec<_> = analysis
            .diagnostics
            .iter()
            .filter(|d| d.message.contains("Assignment type mismatch"))
            .collect();

        assert!(
            !type_mismatch_diags.is_empty(),
            "Should produce 'Assignment type mismatch' for float3 = float (direct assignment)"
        );
    }
}
