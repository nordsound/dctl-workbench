//! Tree-sitter based DCTL parser
//!
//! This module wraps the tree-sitter-dctl grammar for parsing DCTL source code.
//! Only compiled when the `native-parser` feature is enabled.

use super::ast::*;
use super::ParseError;
use tree_sitter::{Node, Parser};

/// Tree-sitter based DCTL Parser
pub struct TreeSitterParser {
    parser: Parser,
}

impl TreeSitterParser {
    /// Create a new tree-sitter parser
    pub fn new() -> Result<Self, ParseError> {
        let mut parser = Parser::new();
        let language: tree_sitter::Language = tree_sitter_dctl::LANGUAGE.into();
        parser
            .set_language(&language)
            .map_err(|e| ParseError::InitializationError(e.to_string()))?;
        Ok(Self { parser })
    }

    /// Parse DCTL source code into an AST
    pub fn parse(&mut self, source: &str) -> Result<DctlModule, ParseError> {
        if source.trim().is_empty() {
            return Ok(DctlModule::default());
        }

        let tree = self
            .parser
            .parse(source, None)
            .ok_or_else(|| ParseError::Internal("Failed to parse source".to_string()))?;

        self.tree_to_ast(tree.root_node(), source)
    }

    /// Convert tree-sitter CST to AST
    fn tree_to_ast(&self, node: Node, source: &str) -> Result<DctlModule, ParseError> {
        let mut declarations = Vec::new();
        let mut ui_params = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "function_definition" => {
                    if let Some(decl) = self.parse_function(child, source)? {
                        declarations.push(Declaration::Function(decl));
                    }
                }
                "struct_specifier" => {
                    if let Some(decl) = self.parse_struct(child, source)? {
                        declarations.push(Declaration::Struct(decl));
                    }
                }
                "declaration" => {
                    if let Some(decl) = self.parse_variable_decl(child, source)? {
                        declarations.push(Declaration::Variable(decl));
                    }
                }
                "preproc_def" | "preproc_function_def" => {
                    if let Some(decl) = self.parse_macro(child, source)? {
                        declarations.push(Declaration::Macro(decl));
                    }
                }
                "dctl_macro" => {
                    // Parse DCTL UI parameter macros
                    if let Some(param) = self.parse_dctl_macro(child, source)? {
                        ui_params.push(param);
                    }
                }
                "type_definition" => {
                    let (typedef_decl, struct_decl) = self.parse_typedef(child, source)?;
                    if let Some(s) = struct_decl {
                        declarations.push(Declaration::Struct(s));
                    }
                    if let Some(t) = typedef_decl {
                        declarations.push(Declaration::Typedef(t));
                    }
                }
                _ => {
                    // Skip other top-level items (comments, etc.)
                }
            }
        }

        Ok(DctlModule {
            declarations,
            ui_params,
        })
    }

    /// Parse a function definition
    fn parse_function(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Option<FunctionDecl>, ParseError> {
        let mut name = String::new();
        let mut return_type = Type::default();
        let mut params = Vec::new();
        let mut body = None;
        let mut modifiers = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "storage_class_specifier" | "type_qualifier" => {
                    if let Some(modifier) = self.text_to_modifier(self.get_text(child, source)) {
                        modifiers.push(modifier);
                    }
                }
                // DCTL modifiers are their own node kinds (not wrapped in storage_class_specifier)
                "__DEVICE__" | "__GLOBAL__" | "__CONSTANT__" | "__PRIVATE__" | "__TEXTURE__"
                | "__TEXTURE2D__" | "__TEXTURE3D__" | "__CONSTANTREF__" | "__RESOLVE__" => {
                    if let Some(modifier) = self.text_to_modifier(child.kind()) {
                        modifiers.push(modifier);
                    }
                }
                "primitive_type" | "type_identifier" | "sized_type_specifier" => {
                    return_type = self.parse_type_from_node(child, source)?;
                }
                "function_declarator" | "pointer_declarator" => {
                    let (n, p) = self.parse_function_declarator(child, source)?;
                    name = n;
                    params = p;
                }
                "compound_statement" => {
                    body = Some(self.parse_block(child, source)?);
                }
                _ => {}
            }
        }

        if name.is_empty() {
            return Ok(None);
        }

        Ok(Some(FunctionDecl {
            name,
            return_type,
            params,
            body,
            modifiers,
            loc: self.get_location(node),
        }))
    }

    /// Convert text to Modifier
    fn text_to_modifier(&self, text: &str) -> Option<Modifier> {
        match text {
            "__DEVICE__" => Some(Modifier::Device),
            "__GLOBAL__" => Some(Modifier::Global),
            "__CONSTANT__" => Some(Modifier::Constant),
            "__PRIVATE__" => Some(Modifier::Private),
            "__TEXTURE__" => Some(Modifier::Texture),
            "__TEXTURE2D__" => Some(Modifier::Texture2D),
            "__TEXTURE3D__" => Some(Modifier::Texture3D),
            "__CONSTANTREF__" => Some(Modifier::ConstantRef),
            "__RESOLVE__" => Some(Modifier::Resolve),
            _ => None,
        }
    }

    /// Parse function declarator to get name and parameters
    fn parse_function_declarator(
        &self,
        node: Node,
        source: &str,
    ) -> Result<(String, Vec<Parameter>), ParseError> {
        let mut name = String::new();
        let mut params = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "identifier" | "field_identifier" => {
                    name = self.get_text(child, source).to_string();
                }
                "pointer_declarator" | "function_declarator" => {
                    let (n, p) = self.parse_function_declarator(child, source)?;
                    if !n.is_empty() {
                        name = n;
                    }
                    if !p.is_empty() {
                        params = p;
                    }
                }
                "parameter_list" => {
                    params = self.parse_parameter_list(child, source)?;
                }
                _ => {}
            }
        }

        Ok((name, params))
    }

    /// Parse parameter list
    fn parse_parameter_list(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Vec<Parameter>, ParseError> {
        let mut params = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "parameter_declaration" {
                if let Some(param) = self.parse_parameter_declaration(child, source)? {
                    params.push(param);
                }
            }
        }

        Ok(params)
    }

    /// Parse a single parameter declaration
    fn parse_parameter_declaration(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Option<Parameter>, ParseError> {
        let mut param_type = Type::default();
        let mut name = String::new();
        let mut is_const = false;
        let mut is_pointer = false;
        let mut modifiers = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "type_qualifier" => {
                    if self.get_text(child, source) == "const" {
                        is_const = true;
                    }
                }
                "storage_class_specifier" => {
                    if let Some(modifier) = self.text_to_modifier(self.get_text(child, source)) {
                        modifiers.push(modifier);
                    }
                }
                // DCTL modifiers are their own node kinds (not wrapped in storage_class_specifier)
                "__DEVICE__" | "__GLOBAL__" | "__CONSTANT__" | "__PRIVATE__" | "__TEXTURE__"
                | "__TEXTURE2D__" | "__TEXTURE3D__" | "__CONSTANTREF__" | "__RESOLVE__" => {
                    if let Some(modifier) = self.text_to_modifier(child.kind()) {
                        modifiers.push(modifier);
                    }
                }
                "primitive_type" | "type_identifier" | "sized_type_specifier" => {
                    param_type = self.parse_type_from_node(child, source)?;
                }
                "identifier" => {
                    name = self.get_text(child, source).to_string();
                }
                "array_declarator" => {
                    // Handle `char a[]` or `char a[N]` parameter syntax
                    // In C, array parameters decay to pointers
                    let mut arr_cursor = child.walk();
                    for arr_child in child.children(&mut arr_cursor) {
                        match arr_child.kind() {
                            "identifier" => {
                                name = self.get_text(arr_child, source).to_string();
                            }
                            "number_literal" => {
                                if let Ok(size) = self.get_text(arr_child, source).parse::<usize>() {
                                    param_type.array_dims.push(ArrayDim::Fixed(size));
                                }
                            }
                            _ => {}
                        }
                    }
                    if param_type.array_dims.is_empty() {
                        param_type.array_dims.push(ArrayDim::Unspecified);
                    }
                }
                "pointer_declarator" => {
                    is_pointer = true;
                    param_type.is_pointer = true;
                    // Get identifier from pointer declarator
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        if inner_child.kind() == "identifier" {
                            name = self.get_text(inner_child, source).to_string();
                        }
                    }
                }
                _ => {}
            }
        }

        if name.is_empty() {
            return Ok(None);
        }

        Ok(Some(Parameter {
            name,
            param_type,
            is_const,
            is_pointer,
            modifiers,
            loc: self.get_location(node),
        }))
    }

    /// Parse a type from a node
    fn parse_type_from_node(&self, node: Node, source: &str) -> Result<Type, ParseError> {
        let type_text = self.get_text(node, source);
        let base = self.text_to_base_type(type_text);

        Ok(Type {
            base,
            is_const: false,
            is_pointer: false,
            array_dims: Vec::new(),
        })
    }

    /// Convert type text to BaseType
    fn text_to_base_type(&self, text: &str) -> BaseType {
        match text {
            "void" => BaseType::Void,
            "bool" => BaseType::Bool,
            "char" => BaseType::Char,
            "int" => BaseType::Int,
            "unsigned int" | "uint" => BaseType::UInt,
            "float" => BaseType::Float,
            "double" => BaseType::Double,
            "half" => BaseType::Half,
            "float2" => BaseType::Float2,
            "float3" => BaseType::Float3,
            "float4" => BaseType::Float4,
            "int2" => BaseType::Int2,
            "int3" => BaseType::Int3,
            "int4" => BaseType::Int4,
            "half2" => BaseType::Half2,
            "half3" => BaseType::Half3,
            "half4" => BaseType::Half4,
            "float3x3" => BaseType::Float3x3,
            "float4x4" => BaseType::Float4x4,
            other => BaseType::Typedef(other.to_string()),
        }
    }

    /// Parse a compound statement (block)
    fn parse_block(&self, node: Node, source: &str) -> Result<Block, ParseError> {
        let mut statements = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(stmt) = self.parse_statement(child, source)? {
                statements.push(stmt);
            }
        }

        Ok(Block {
            statements,
            loc: self.get_location(node),
        })
    }

    /// Parse a statement
    fn parse_statement(&self, node: Node, source: &str) -> Result<Option<Statement>, ParseError> {
        let loc = self.get_location(node);
        match node.kind() {
            "return_statement" => {
                // Try to get expression from field name first
                let mut expr_node = node.child_by_field_name("expression");

                // If not found, search children manually
                if expr_node.is_none() {
                    let mut cursor = node.walk();
                    for child in node.children(&mut cursor) {
                        if child.kind() != "return" && child.kind() != ";" {
                            expr_node = Some(child);
                            break;
                        }
                    }
                }

                let value = expr_node
                    .map(|n| self.parse_expression(n, source))
                    .transpose()?;

                Ok(Some(Statement::Return(ReturnStmt { value, loc })))
            }
            "expression_statement" => {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() != ";" {
                        let expression = self.parse_expression(child, source)?;
                        return Ok(Some(Statement::Expression(ExpressionStmt {
                            expression,
                            loc,
                        })));
                    }
                }
                Ok(None)
            }
            "declaration" => {
                if let Some(var_decl) = self.parse_variable_decl(node, source)? {
                    Ok(Some(Statement::Variable(var_decl)))
                } else {
                    Ok(None)
                }
            }
            "if_statement" => self.parse_if_statement(node, source),
            "for_statement" => self.parse_for_statement(node, source),
            "while_statement" => self.parse_while_statement(node, source),
            "do_statement" => self.parse_do_while_statement(node, source),
            "switch_statement" => self.parse_switch_statement(node, source),
            "break_statement" => Ok(Some(Statement::Break(BreakStmt { loc }))),
            "continue_statement" => Ok(Some(Statement::Continue(ContinueStmt { loc }))),
            "compound_statement" => {
                let block = self.parse_block(node, source)?;
                Ok(Some(Statement::Block(block)))
            }
            ";" => Ok(Some(Statement::Empty(EmptyStmt { loc }))),
            _ => Ok(None),
        }
    }

    /// Parse if statement
    fn parse_if_statement(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Option<Statement>, ParseError> {
        let loc = self.get_location(node);

        let condition = node
            .child_by_field_name("condition")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_bool_literal(true, loc));

        let then_branch = node
            .child_by_field_name("consequence")
            .map(|n| self.parse_statement_boxed(n, source))
            .transpose()?
            .unwrap_or_else(|| Box::new(Statement::Empty(EmptyStmt { loc })));

        let else_branch = node
            .child_by_field_name("alternative")
            .map(|n| self.parse_statement_boxed(n, source))
            .transpose()?;

        Ok(Some(Statement::If(IfStmt {
            condition,
            then_branch,
            else_branch,
            loc,
        })))
    }

    /// Parse a statement and box it
    fn parse_statement_boxed(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Box<Statement>, ParseError> {
        let loc = self.get_location(node);
        let stmt = self
            .parse_statement(node, source)?
            .unwrap_or(Statement::Empty(EmptyStmt { loc }));
        Ok(Box::new(stmt))
    }

    /// Parse for statement
    fn parse_for_statement(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Option<Statement>, ParseError> {
        let loc = self.get_location(node);

        let init = node
            .child_by_field_name("initializer")
            .map(|n| self.parse_for_init(n, source))
            .transpose()?
            .flatten();

        let condition = node
            .child_by_field_name("condition")
            .map(|n| self.parse_expression(n, source))
            .transpose()?;

        let update = node
            .child_by_field_name("update")
            .map(|n| self.parse_expression(n, source))
            .transpose()?;

        let body = node
            .child_by_field_name("body")
            .map(|n| self.parse_statement_boxed(n, source))
            .transpose()?
            .unwrap_or_else(|| Box::new(Statement::Empty(EmptyStmt { loc })));

        Ok(Some(Statement::For(ForStmt {
            init,
            condition,
            update,
            body,
            loc,
        })))
    }

    /// Parse for loop initializer
    fn parse_for_init(&self, node: Node, source: &str) -> Result<Option<ForInit>, ParseError> {
        match node.kind() {
            "declaration" => {
                let decls = self.parse_variable_decls(node, source)?;
                if decls.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(ForInit::Variables(decls)))
                }
            }
            _ => {
                let expr = self.parse_expression(node, source)?;
                Ok(Some(ForInit::Expression(expr)))
            }
        }
    }

    /// Parse a declaration node that may contain multiple declarators.
    /// e.g. `int a = 0, b = 1, c = 2;` → Vec of 3 VariableDecls
    fn parse_variable_decls(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Vec<VariableDecl>, ParseError> {
        let mut var_type = Type::default();
        let mut is_const = false;
        let mut modifiers = Vec::new();
        let mut decls = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "storage_class_specifier" => {
                    let text = self.get_text(child, source);
                    if text == "const" {
                        is_const = true;
                    } else if let Some(modifier) = self.text_to_modifier(text) {
                        modifiers.push(modifier);
                    }
                }
                "type_qualifier" => {
                    if self.get_text(child, source) == "const" {
                        is_const = true;
                    }
                }
                "__DEVICE__" | "__GLOBAL__" | "__CONSTANT__" | "__PRIVATE__" | "__TEXTURE__"
                | "__TEXTURE2D__" | "__TEXTURE3D__" | "__CONSTANTREF__" | "__RESOLVE__" => {
                    if let Some(modifier) = self.text_to_modifier(child.kind()) {
                        modifiers.push(modifier);
                    }
                }
                "primitive_type" | "type_identifier" | "sized_type_specifier" => {
                    var_type = self.parse_type_from_node(child, source)?;
                }
                "init_declarator" => {
                    let mut name = String::new();
                    let mut initializer = None;
                    let mut decl_type = var_type.clone();
                    let mut seen_equals = false;
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        match inner_child.kind() {
                            "=" => { seen_equals = true; }
                            "identifier" if !seen_equals => {
                                name = self.get_text(inner_child, source).to_string();
                            }
                            "array_declarator" if !seen_equals => {
                                let mut arr_cursor = inner_child.walk();
                                for arr_child in inner_child.children(&mut arr_cursor) {
                                    match arr_child.kind() {
                                        "identifier" => {
                                            name = self.get_text(arr_child, source).to_string();
                                        }
                                        "number_literal" => {
                                            if let Ok(size) = self.get_text(arr_child, source).parse::<usize>() {
                                                decl_type.array_dims.push(ArrayDim::Fixed(size));
                                            }
                                        }
                                        "[" | "]" => {}
                                        _ => {}
                                    }
                                }
                                if decl_type.array_dims.is_empty() {
                                    decl_type.array_dims.push(ArrayDim::Unspecified);
                                }
                            }
                            _ if seen_equals => {
                                initializer = Some(self.parse_expression(inner_child, source)?);
                            }
                            _ => {}
                        }
                    }
                    if !name.is_empty() {
                        decl_type.is_const = is_const;
                        decls.push(VariableDecl {
                            name,
                            var_type: decl_type,
                            initializer,
                            is_const,
                            modifiers: modifiers.clone(),
                            loc: self.get_location(child),
                        });
                    }
                }
                "identifier" => {
                    // Simple declarator without initializer (e.g. `int x;`)
                    let name = self.get_text(child, source).to_string();
                    if !name.is_empty() {
                        let mut decl_type = var_type.clone();
                        decl_type.is_const = is_const;
                        decls.push(VariableDecl {
                            name,
                            var_type: decl_type,
                            initializer: None,
                            is_const,
                            modifiers: modifiers.clone(),
                            loc: self.get_location(child),
                        });
                    }
                }
                _ => {}
            }
        }
        Ok(decls)
    }

    /// Parse while statement
    fn parse_while_statement(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Option<Statement>, ParseError> {
        let loc = self.get_location(node);

        let condition = node
            .child_by_field_name("condition")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_bool_literal(true, loc));

        let body = node
            .child_by_field_name("body")
            .map(|n| self.parse_statement_boxed(n, source))
            .transpose()?
            .unwrap_or_else(|| Box::new(Statement::Empty(EmptyStmt { loc })));

        Ok(Some(Statement::While(WhileStmt {
            condition,
            body,
            loc,
        })))
    }

    /// Parse do-while statement
    fn parse_do_while_statement(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Option<Statement>, ParseError> {
        let loc = self.get_location(node);

        let body = node
            .child_by_field_name("body")
            .map(|n| self.parse_statement_boxed(n, source))
            .transpose()?
            .unwrap_or_else(|| Box::new(Statement::Empty(EmptyStmt { loc })));

        let condition = node
            .child_by_field_name("condition")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_bool_literal(true, loc));

        Ok(Some(Statement::DoWhile(DoWhileStmt {
            body,
            condition,
            loc,
        })))
    }

    /// Parse switch statement
    fn parse_switch_statement(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Option<Statement>, ParseError> {
        let loc = self.get_location(node);

        let expression = node
            .child_by_field_name("condition")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_int_literal(0, loc));

        let mut cases = Vec::new();
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "compound_statement" {
                let mut inner_cursor = child.walk();
                for inner_child in child.children(&mut inner_cursor) {
                    if inner_child.kind() == "case_statement" {
                        if let Some(case) = self.parse_switch_case(inner_child, source)? {
                            cases.push(case);
                        }
                    }
                }
            }
        }

        Ok(Some(Statement::Switch(SwitchStmt {
            expression,
            cases,
            loc,
        })))
    }

    /// Parse a switch case
    fn parse_switch_case(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Option<SwitchCase>, ParseError> {
        let loc = self.get_location(node);
        let mut value = None;
        let mut statements = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "case" | "default" | ":" => {}
                _ => {
                    if value.is_none() && child.kind() != "case" {
                        // First expression is the case value (unless it's a default case)
                        let first_text = self.get_text(child, source);
                        if first_text != "default" {
                            value = Some(self.parse_expression(child, source)?);
                            continue;
                        }
                    }
                    if let Some(stmt) = self.parse_statement(child, source)? {
                        statements.push(stmt);
                    }
                }
            }
        }

        Ok(Some(SwitchCase {
            value,
            statements,
            loc,
        }))
    }

    /// Create a bool literal expression
    fn make_bool_literal(&self, value: bool, loc: Location) -> Expression {
        Expression::Literal(LiteralExpr {
            value: LiteralValue::Bool(value),
            loc,
        })
    }

    /// Create an int literal expression
    fn make_int_literal(&self, value: i64, loc: Location) -> Expression {
        Expression::Literal(LiteralExpr {
            value: LiteralValue::Int(value),
            loc,
        })
    }

    /// Parse an expression
    fn parse_expression(&self, node: Node, source: &str) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);
        match node.kind() {
            "number_literal" => {
                let text = self.get_text(node, source);
                if text.contains('.') || text.contains('e') || text.contains('E') {
                    Ok(Expression::Literal(LiteralExpr {
                        value: LiteralValue::Float(
                            text.trim_end_matches('f').parse().unwrap_or(0.0),
                        ),
                        loc,
                    }))
                } else {
                    Ok(Expression::Literal(LiteralExpr {
                        value: LiteralValue::Int(text.parse().unwrap_or(0)),
                        loc,
                    }))
                }
            }
            "true" => Ok(Expression::Literal(LiteralExpr {
                value: LiteralValue::Bool(true),
                loc,
            })),
            "false" => Ok(Expression::Literal(LiteralExpr {
                value: LiteralValue::Bool(false),
                loc,
            })),
            "string_literal" => {
                let text = self.get_text(node, source);
                // Remove quotes
                let content = text
                    .trim_start_matches('"')
                    .trim_end_matches('"')
                    .to_string();
                Ok(Expression::Literal(LiteralExpr {
                    value: LiteralValue::String(content),
                    loc,
                }))
            }
            "char_literal" => {
                let text = self.get_text(node, source);
                let c = text
                    .trim_start_matches('\'')
                    .trim_end_matches('\'')
                    .chars()
                    .next()
                    .unwrap_or('\0');
                Ok(Expression::Literal(LiteralExpr {
                    value: LiteralValue::Char(c),
                    loc,
                }))
            }
            "identifier" => Ok(Expression::Identifier(IdentifierExpr {
                name: self.get_text(node, source).to_string(),
                loc,
            })),
            "call_expression" => self.parse_call_expression(node, source),
            "binary_expression" => self.parse_binary_expression(node, source),
            "unary_expression" | "pointer_expression" => self.parse_unary_expression(node, source),
            "field_expression" => self.parse_field_expression(node, source),
            "subscript_expression" => self.parse_subscript_expression(node, source),
            "assignment_expression" => self.parse_assignment_expression(node, source),
            "update_expression" => self.parse_update_expression(node, source),
            "parenthesized_expression" | "condition_clause" => {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() != "(" && child.kind() != ")" {
                        return self.parse_expression(child, source);
                    }
                }
                Ok(Expression::Literal(LiteralExpr {
                    value: LiteralValue::Int(0),
                    loc,
                }))
            }
            "conditional_expression" => self.parse_conditional_expression(node, source),
            "cast_expression" => self.parse_cast_expression(node, source),
            "sizeof_expression" => self.parse_sizeof_expression(node, source),
            "comma_expression" => self.parse_comma_expression(node, source),
            "initializer_list" => self.parse_initializer_list(node, source),
            "compound_literal_expression" => self.parse_compound_literal(node, source),
            _ => {
                // Fallback: try to parse as identifier
                let text = self.get_text(node, source);
                Ok(Expression::Identifier(IdentifierExpr {
                    name: text.to_string(),
                    loc,
                }))
            }
        }
    }

    /// Parse a call expression
    fn parse_call_expression(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);
        let mut callee: Option<Expression> = None;
        let mut args = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "identifier" => {
                    callee = Some(Expression::Identifier(IdentifierExpr {
                        name: self.get_text(child, source).to_string(),
                        loc: self.get_location(child),
                    }));
                }
                "field_expression" => {
                    callee = Some(self.parse_field_expression(child, source)?);
                }
                "argument_list" => {
                    args = self.parse_argument_list(child, source)?;
                }
                _ => {}
            }
        }

        let callee = callee.unwrap_or(Expression::Identifier(IdentifierExpr {
            name: String::new(),
            loc,
        }));

        Ok(Expression::Call(CallExpr {
            callee: Box::new(callee),
            args,
            loc,
        }))
    }

    /// Parse argument list
    fn parse_argument_list(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Vec<Expression>, ParseError> {
        let mut args = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() != "(" && child.kind() != ")" && child.kind() != "," {
                args.push(self.parse_expression(child, source)?);
            }
        }

        Ok(args)
    }

    /// Parse binary expression
    fn parse_binary_expression(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);

        let left = node
            .child_by_field_name("left")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_int_literal(0, loc));

        let right = node
            .child_by_field_name("right")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_int_literal(0, loc));

        let op = node
            .child_by_field_name("operator")
            .map(|n| self.text_to_binary_op(self.get_text(n, source)))
            .unwrap_or(BinaryOp::Add);

        Ok(Expression::Binary(BinaryExpr {
            op,
            left: Box::new(left),
            right: Box::new(right),
            loc,
        }))
    }

    /// Convert text to binary operator
    fn text_to_binary_op(&self, text: &str) -> BinaryOp {
        match text {
            "+" => BinaryOp::Add,
            "-" => BinaryOp::Sub,
            "*" => BinaryOp::Mul,
            "/" => BinaryOp::Div,
            "%" => BinaryOp::Mod,
            "==" => BinaryOp::Eq,
            "!=" => BinaryOp::Ne,
            "<" => BinaryOp::Lt,
            "<=" => BinaryOp::Le,
            ">" => BinaryOp::Gt,
            ">=" => BinaryOp::Ge,
            "&&" => BinaryOp::And,
            "||" => BinaryOp::Or,
            "&" => BinaryOp::BitAnd,
            "|" => BinaryOp::BitOr,
            "^" => BinaryOp::BitXor,
            "<<" => BinaryOp::Shl,
            ">>" => BinaryOp::Shr,
            _ => BinaryOp::Add,
        }
    }

    /// Parse unary expression
    fn parse_unary_expression(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);
        let mut op = UnaryOp::Neg;
        let mut operand = self.make_int_literal(0, loc);

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "-" => op = UnaryOp::Neg,
                "!" => op = UnaryOp::Not,
                "~" => op = UnaryOp::BitNot,
                "*" => op = UnaryOp::Deref,
                "&" => op = UnaryOp::AddrOf,
                _ => {
                    operand = self.parse_expression(child, source)?;
                }
            }
        }

        Ok(Expression::Unary(UnaryExpr {
            op,
            operand: Box::new(operand),
            is_prefix: true,
            loc,
        }))
    }

    /// Parse update expression (++x, x++, --x, x--)
    fn parse_update_expression(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);
        let text = self.get_text(node, source);

        let is_prefix = text.starts_with("++") || text.starts_with("--");
        let op = if text.contains("++") {
            if is_prefix {
                UnaryOp::PreInc
            } else {
                UnaryOp::PostInc
            }
        } else {
            if is_prefix {
                UnaryOp::PreDec
            } else {
                UnaryOp::PostDec
            }
        };

        let mut operand = self.make_int_literal(0, loc);
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() != "++" && child.kind() != "--" {
                operand = self.parse_expression(child, source)?;
            }
        }

        Ok(Expression::Unary(UnaryExpr {
            op,
            operand: Box::new(operand),
            is_prefix,
            loc,
        }))
    }

    /// Parse field expression (member access)
    fn parse_field_expression(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);

        let object = node
            .child_by_field_name("argument")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_int_literal(0, loc));

        let member = node
            .child_by_field_name("field")
            .map(|n| self.get_text(n, source).to_string())
            .unwrap_or_default();

        // Check for arrow operator
        let is_arrow = self.get_text(node, source).contains("->");

        Ok(Expression::Member(MemberExpr {
            object: Box::new(object),
            member,
            is_arrow,
            loc,
        }))
    }

    /// Parse subscript expression (array indexing)
    fn parse_subscript_expression(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);

        let object = node
            .child_by_field_name("argument")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_int_literal(0, loc));

        let index = node
            .child_by_field_name("index")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_int_literal(0, loc));

        Ok(Expression::Index(IndexExpr {
            object: Box::new(object),
            index: Box::new(index),
            loc,
        }))
    }

    /// Parse assignment expression
    fn parse_assignment_expression(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);

        let left = node
            .child_by_field_name("left")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_int_literal(0, loc));

        let right = node
            .child_by_field_name("right")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_int_literal(0, loc));

        let op = node
            .child_by_field_name("operator")
            .map(|n| self.text_to_assignment_op(self.get_text(n, source)))
            .unwrap_or(AssignmentOp::Assign);

        Ok(Expression::Assignment(AssignmentExpr {
            op,
            left: Box::new(left),
            right: Box::new(right),
            loc,
        }))
    }

    /// Convert text to assignment operator
    fn text_to_assignment_op(&self, text: &str) -> AssignmentOp {
        match text {
            "=" => AssignmentOp::Assign,
            "+=" => AssignmentOp::AddAssign,
            "-=" => AssignmentOp::SubAssign,
            "*=" => AssignmentOp::MulAssign,
            "/=" => AssignmentOp::DivAssign,
            "%=" => AssignmentOp::ModAssign,
            "&=" => AssignmentOp::BitAndAssign,
            "|=" => AssignmentOp::BitOrAssign,
            "^=" => AssignmentOp::BitXorAssign,
            "<<=" => AssignmentOp::ShlAssign,
            ">>=" => AssignmentOp::ShrAssign,
            _ => AssignmentOp::Assign,
        }
    }

    /// Parse conditional (ternary) expression
    fn parse_conditional_expression(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);

        let condition = node
            .child_by_field_name("condition")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_bool_literal(true, loc));

        let then_expr = node
            .child_by_field_name("consequence")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_int_literal(0, loc));

        let else_expr = node
            .child_by_field_name("alternative")
            .map(|n| self.parse_expression(n, source))
            .transpose()?
            .unwrap_or_else(|| self.make_int_literal(0, loc));

        Ok(Expression::Ternary(TernaryExpr {
            condition: Box::new(condition),
            then_expr: Box::new(then_expr),
            else_expr: Box::new(else_expr),
            loc,
        }))
    }

    /// Parse cast expression
    fn parse_cast_expression(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);
        let mut target_type = Type::default();
        let mut operand = self.make_int_literal(0, loc);

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "type_descriptor" => {
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        if inner_child.kind() == "primitive_type"
                            || inner_child.kind() == "type_identifier"
                        {
                            target_type = self.parse_type_from_node(inner_child, source)?;
                        }
                    }
                }
                _ if child.kind() != "(" && child.kind() != ")" => {
                    operand = self.parse_expression(child, source)?;
                }
                _ => {}
            }
        }

        Ok(Expression::Cast(CastExpr {
            target_type,
            operand: Box::new(operand),
            loc,
        }))
    }

    /// Parse compound literal expression: (Type){expr1, expr2, ...}
    /// Represented as Cast(Type, InitializerList) in the AST, same as the TS parser.
    fn parse_compound_literal(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);
        let mut target_type = Type::default();
        let mut initializer = self.make_int_literal(0, loc);

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "type_descriptor" => {
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        if inner_child.kind() == "primitive_type"
                            || inner_child.kind() == "type_identifier"
                            || inner_child.kind() == "struct_specifier"
                        {
                            target_type = self.parse_type_from_node(inner_child, source)?;
                        }
                    }
                }
                "initializer_list" => {
                    initializer = self.parse_initializer_list(child, source)?;
                }
                _ => {}
            }
        }

        Ok(Expression::Cast(CastExpr {
            target_type,
            operand: Box::new(initializer),
            loc,
        }))
    }

    /// Parse sizeof expression
    fn parse_sizeof_expression(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);
        let mut operand = SizeofOperand::Expression(Box::new(self.make_int_literal(0, loc)));

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "type_descriptor" => {
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        if inner_child.kind() == "primitive_type"
                            || inner_child.kind() == "type_identifier"
                        {
                            let t = self.parse_type_from_node(inner_child, source)?;
                            operand = SizeofOperand::Type(t);
                        }
                    }
                }
                _ if child.kind() != "sizeof" && child.kind() != "(" && child.kind() != ")" => {
                    let expr = self.parse_expression(child, source)?;
                    operand = SizeofOperand::Expression(Box::new(expr));
                }
                _ => {}
            }
        }

        Ok(Expression::Sizeof(SizeofExpr { operand, loc }))
    }

    /// Parse comma expression
    fn parse_comma_expression(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);
        let mut expressions = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() != "," {
                expressions.push(self.parse_expression(child, source)?);
            }
        }

        Ok(Expression::Comma(CommaExpr { expressions, loc }))
    }

    /// Parse initializer list
    fn parse_initializer_list(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Expression, ParseError> {
        let loc = self.get_location(node);
        let mut elements = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() != "{" && child.kind() != "}" && child.kind() != "," {
                elements.push(self.parse_expression(child, source)?);
            }
        }

        Ok(Expression::InitializerList(InitializerListExpr {
            elements,
            loc,
        }))
    }

    /// Parse a struct definition
    fn parse_struct(&self, node: Node, source: &str) -> Result<Option<StructDecl>, ParseError> {
        let mut name = String::new();
        let mut fields = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "type_identifier" => {
                    name = self.get_text(child, source).to_string();
                }
                "field_declaration_list" => {
                    fields = self.parse_struct_fields(child, source)?;
                }
                _ => {}
            }
        }

        if name.is_empty() {
            return Ok(None);
        }

        Ok(Some(StructDecl {
            name,
            fields,
            loc: self.get_location(node),
        }))
    }

    /// Parse struct fields
    fn parse_struct_fields(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Vec<StructField>, ParseError> {
        let mut fields = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "field_declaration" {
                let parsed = self.parse_struct_field(child, source)?;
                fields.extend(parsed);
            }
        }

        Ok(fields)
    }

    /// Parse a struct field declaration (may contain comma-separated declarators,
    /// e.g. `float3 r0, r1, r2;` → three fields)
    fn parse_struct_field(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Vec<StructField>, ParseError> {
        let mut field_type = Type::default();
        let mut names = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "primitive_type" | "type_identifier" | "sized_type_specifier" => {
                    field_type = self.parse_type_from_node(child, source)?;
                }
                "field_identifier" => {
                    names.push(self.get_text(child, source).to_string());
                }
                _ => {}
            }
        }

        Ok(names
            .into_iter()
            .map(|name| StructField {
                name,
                field_type: field_type.clone(),
                loc: self.get_location(node),
            })
            .collect())
    }

    /// Parse a variable declaration
    fn parse_variable_decl(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Option<VariableDecl>, ParseError> {
        let mut var_type = Type::default();
        let mut name = String::new();
        let mut initializer = None;
        let mut is_const = false;
        let mut modifiers = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "storage_class_specifier" => {
                    let text = self.get_text(child, source);
                    if text == "const" {
                        is_const = true;
                    } else if let Some(modifier) = self.text_to_modifier(text) {
                        modifiers.push(modifier);
                    }
                }
                "type_qualifier" => {
                    if self.get_text(child, source) == "const" {
                        is_const = true;
                    }
                }
                // DCTL modifiers are their own node kinds (not wrapped in storage_class_specifier)
                "__DEVICE__" | "__GLOBAL__" | "__CONSTANT__" | "__PRIVATE__" | "__TEXTURE__"
                | "__TEXTURE2D__" | "__TEXTURE3D__" | "__CONSTANTREF__" | "__RESOLVE__" => {
                    if let Some(modifier) = self.text_to_modifier(child.kind()) {
                        modifiers.push(modifier);
                    }
                }
                "primitive_type" | "type_identifier" | "sized_type_specifier" => {
                    var_type = self.parse_type_from_node(child, source)?;
                }
                "init_declarator" => {
                    let mut seen_equals = false;
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        match inner_child.kind() {
                            "=" => {
                                seen_equals = true;
                            }
                            "identifier" if !seen_equals => {
                                // Before "=", this is the variable name
                                name = self.get_text(inner_child, source).to_string();
                            }
                            "array_declarator" if !seen_equals => {
                                // Handle `type name[] = init` or `type name[N] = init`
                                let mut arr_cursor = inner_child.walk();
                                for arr_child in inner_child.children(&mut arr_cursor) {
                                    match arr_child.kind() {
                                        "identifier" => {
                                            name = self.get_text(arr_child, source).to_string();
                                        }
                                        "number_literal" => {
                                            // Explicit array size: name[N]
                                            if let Ok(size) = self.get_text(arr_child, source).parse::<usize>() {
                                                var_type.array_dims.push(ArrayDim::Fixed(size));
                                            }
                                        }
                                        "[" | "]" => {
                                            // If no size was pushed yet after seeing `[`, it's unsized
                                        }
                                        _ => {}
                                    }
                                }
                                // If no explicit size was found, mark as unsized array
                                if var_type.array_dims.is_empty() {
                                    var_type.array_dims.push(ArrayDim::Unspecified);
                                }
                            }
                            _ if seen_equals => {
                                // After "=", this is the initializer expression
                                initializer = Some(self.parse_expression(inner_child, source)?);
                            }
                            _ => {}
                        }
                    }
                }
                "identifier" => {
                    name = self.get_text(child, source).to_string();
                }
                "array_declarator" => {
                    // Handle `type name[N];` without initializer
                    let mut arr_cursor = child.walk();
                    for arr_child in child.children(&mut arr_cursor) {
                        match arr_child.kind() {
                            "identifier" => {
                                name = self.get_text(arr_child, source).to_string();
                            }
                            "number_literal" => {
                                if let Ok(size) = self.get_text(arr_child, source).parse::<usize>() {
                                    var_type.array_dims.push(ArrayDim::Fixed(size));
                                }
                            }
                            _ => {}
                        }
                    }
                    if var_type.array_dims.is_empty() {
                        var_type.array_dims.push(ArrayDim::Unspecified);
                    }
                }
                _ => {}
            }
        }

        if name.is_empty() {
            return Ok(None);
        }

        var_type.is_const = is_const;

        Ok(Some(VariableDecl {
            name,
            var_type,
            initializer,
            is_const,
            modifiers,
            loc: self.get_location(node),
        }))
    }

    /// Parse a macro definition
    fn parse_macro(&self, _node: Node, _source: &str) -> Result<Option<MacroDecl>, ParseError> {
        // TODO: Implement macro parsing
        Ok(None)
    }

    /// Parse a DCTL macro (DEFINE_UI_PARAMS, etc.)
    fn parse_dctl_macro(
        &self,
        node: Node,
        source: &str,
    ) -> Result<Option<UiParamDecl>, ParseError> {
        let loc = self.get_location(node);
        let mut macro_name = String::new();
        let mut args_text = String::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "identifier" => {
                    macro_name = self.get_text(child, source).to_string();
                }
                "dctl_macro_arguments" => {
                    args_text = self.get_text(child, source).to_string();
                }
                _ => {}
            }
        }

        if macro_name != "DEFINE_UI_PARAMS" {
            return Ok(None);
        }

        // Parse DEFINE_UI_PARAMS arguments
        // Format: DEFINE_UI_PARAMS(name, label, type, default, min, max, step)
        let args: Vec<&str> = args_text.split(',').map(|s| s.trim()).collect();
        if args.len() < 4 {
            return Ok(None);
        }

        let name = args[0].to_string();
        let label = args[1].trim_matches('"').to_string();
        let ui_type_str = args[2].to_string();

        // Parse UI type based on the type string
        let ui_type = self.parse_ui_param_type(&ui_type_str, &args)?;

        Ok(Some(UiParamDecl {
            name,
            label,
            ui_type,
            loc,
        }))
    }

    /// Parse UI parameter type from arguments
    fn parse_ui_param_type(&self, type_str: &str, args: &[&str]) -> Result<UiParamType, ParseError> {
        match type_str {
            "DCTLUI_SLIDER_FLOAT" => {
                let default = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let min = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(0.0);
                let max = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(1.0);
                let step = args.get(6).and_then(|s| s.parse().ok()).unwrap_or(0.01);
                Ok(UiParamType::SliderFloat {
                    default,
                    min,
                    max,
                    step,
                })
            }
            "DCTLUI_SLIDER_INT" => {
                let default = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
                let min = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);
                let max = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(100);
                let step = args.get(6).and_then(|s| s.parse().ok()).unwrap_or(1);
                Ok(UiParamType::SliderInt {
                    default,
                    min,
                    max,
                    step,
                })
            }
            "DCTLUI_CHECK_BOX" => {
                let default = args.get(3).map(|s| *s == "1" || *s == "true").unwrap_or(false);
                Ok(UiParamType::CheckBox { default })
            }
            "DCTLUI_COMBO_BOX" => {
                let default = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
                // Parse options from remaining args
                let options: Vec<String> = args
                    .iter()
                    .skip(4)
                    .map(|s| s.trim_matches('"').to_string())
                    .collect();
                Ok(UiParamType::ComboBox { default, options })
            }
            _ => Ok(UiParamType::SliderFloat {
                default: 0.0,
                min: 0.0,
                max: 1.0,
                step: 0.01,
            }),
        }
    }

    /// Parse a typedef declaration.
    /// For `typedef struct { ... } name;`, returns both a StructDecl and a TypedefDecl.
    fn parse_typedef(
        &self,
        node: Node,
        source: &str,
    ) -> Result<(Option<TypedefDecl>, Option<StructDecl>), ParseError> {
        let loc = self.get_location(node);
        let mut name = String::new();
        let mut target_type = Type::default();
        let mut struct_decl: Option<StructDecl> = None;

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "primitive_type" | "sized_type_specifier" => {
                    target_type = self.parse_type_from_node(child, source)?;
                }
                "type_identifier" => {
                    // For `typedef struct { ... } name;`, the type_identifier after
                    // struct_specifier is the typedef name, not the target type.
                    if struct_decl.is_some() {
                        name = self.get_text(child, source).to_string();
                    } else {
                        target_type = self.parse_type_from_node(child, source)?;
                    }
                }
                "struct_specifier" => {
                    // Parse the inline struct definition (typedef struct { ... } name;)
                    let mut fields = Vec::new();
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        if inner_child.kind() == "field_declaration_list" {
                            fields = self.parse_struct_fields(inner_child, source)?;
                        }
                    }
                    struct_decl = Some(StructDecl {
                        name: String::new(), // Will be set below once we know the typedef name
                        fields,
                        loc: self.get_location(child),
                    });
                }
                "type_definition" => {
                    // Nested typedef
                }
                "identifier" => {
                    name = self.get_text(child, source).to_string();
                }
                _ => {}
            }
        }

        if name.is_empty() {
            return Ok((None, None));
        }

        // If we have an inline struct, set its name to the typedef name
        // and set the target type to reference that struct
        if let Some(ref mut s) = struct_decl {
            s.name = name.clone();
            target_type = Type {
                base: BaseType::Struct(name.clone()),
                ..Type::default()
            };
        }

        Ok((
            Some(TypedefDecl {
                name,
                target_type,
                loc,
            }),
            struct_decl,
        ))
    }

    /// Get text for a node
    fn get_text<'a>(&self, node: Node, source: &'a str) -> &'a str {
        &source[node.byte_range()]
    }

    /// Get location from node
    fn get_location(&self, node: Node) -> Location {
        let start = node.start_position();
        let end = node.end_position();
        Location {
            line: start.row + 1,
            column: start.column + 1,
            end_line: end.row + 1,
            end_column: end.column + 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parser_creation() {
        let parser = TreeSitterParser::new();
        assert!(parser.is_ok());
    }

    #[test]
    fn test_empty_source() {
        let mut parser = TreeSitterParser::new().unwrap();
        let result = parser.parse("");
        assert!(result.is_ok());
        let module = result.unwrap();
        assert!(module.declarations.is_empty());
    }

    #[test]
    fn test_parse_simple_function() {
        let mut parser = TreeSitterParser::new().unwrap();
        let source = r#"
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R, p_G, p_B);
}
"#;
        let result = parser.parse(source);
        assert!(result.is_ok());
        let module = result.unwrap();
        assert_eq!(module.declarations.len(), 1);

        if let Declaration::Function(func) = &module.declarations[0] {
            assert_eq!(func.name, "transform");
            assert_eq!(func.params.len(), 7);
            assert!(func.modifiers.contains(&Modifier::Device));
        } else {
            panic!("Expected function declaration");
        }
    }

    #[test]
    fn test_parse_dctl_macro() {
        let mut parser = TreeSitterParser::new().unwrap();
        let source = r#"
DEFINE_UI_PARAMS(gain, Gain, DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)
"#;
        let result = parser.parse(source);
        assert!(result.is_ok());
        let module = result.unwrap();
        assert_eq!(module.ui_params.len(), 1);
        assert_eq!(module.ui_params[0].name, "gain");
    }

    #[test]
    fn test_parse_binary_expression() {
        let mut parser = TreeSitterParser::new().unwrap();
        let source = r#"
__DEVICE__ float test() {
    float a = 1.0 + 2.0 * 3.0;
    return a;
}
"#;
        let result = parser.parse(source);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_if_statement() {
        let mut parser = TreeSitterParser::new().unwrap();
        let source = r#"
__DEVICE__ float test(float x) {
    if (x > 0.0) {
        return x;
    } else {
        return -x;
    }
}
"#;
        let result = parser.parse(source);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_for_loop() {
        let mut parser = TreeSitterParser::new().unwrap();
        let source = r#"
__DEVICE__ float test() {
    float sum = 0.0;
    for (int i = 0; i < 10; i++) {
        sum += (float)i;
    }
    return sum;
}
"#;
        let result = parser.parse(source);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_real_saturation_dctl() {
        let mut parser = TreeSitterParser::new().unwrap();
        let source = r#"
// Saturation Adjustment
// HSL-based saturation control

DEFINE_UI_PARAMS(saturation, Saturation, DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 3.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    // Rec.709 luminance coefficients
    const float luma_r = 0.2126f;
    const float luma_g = 0.7152f;
    const float luma_b = 0.0722f;

    float luma = p_R * luma_r + p_G * luma_g + p_B * luma_b;

    float3 result;
    result.x = luma + (p_R - luma) * saturation;
    result.y = luma + (p_G - luma) * saturation;
    result.z = luma + (p_B - luma) * saturation;

    return result;
}
"#;
        let result = parser.parse(source);
        assert!(result.is_ok(), "Parse failed: {:?}", result.err());

        let module = result.unwrap();

        // Should have 1 UI param
        assert_eq!(module.ui_params.len(), 1);
        assert_eq!(module.ui_params[0].name, "saturation");

        // Should have 1 function
        let functions: Vec<_> = module
            .declarations
            .iter()
            .filter_map(|d| {
                if let Declaration::Function(f) = d {
                    Some(f)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(functions.len(), 1);
        assert_eq!(functions[0].name, "transform");
        assert_eq!(functions[0].params.len(), 7);
        assert!(functions[0].modifiers.contains(&Modifier::Device));
    }
}
