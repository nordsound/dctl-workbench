//! DCTL Abstract Syntax Tree definitions
//!
//! These types represent the parsed structure of DCTL source code.

use serde::{Deserialize, Serialize};

/// Source location information
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Location {
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

/// A complete DCTL module (file)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DctlModule {
    pub declarations: Vec<Declaration>,
    pub ui_params: Vec<UiParamDecl>,
}

/// Top-level declarations
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Declaration {
    Function(FunctionDecl),
    Struct(StructDecl),
    Variable(VariableDecl),
    Typedef(TypedefDecl),
    Macro(MacroDecl),
}

/// Function declaration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionDecl {
    pub name: String,
    pub return_type: Type,
    pub params: Vec<Parameter>,
    pub body: Option<Block>,
    pub modifiers: Vec<Modifier>,
    pub loc: Location,
}

/// Function parameter
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Parameter {
    pub name: String,
    pub param_type: Type,
    pub is_const: bool,
    pub is_pointer: bool,
    pub modifiers: Vec<Modifier>,
    pub loc: Location,
}

/// Structure definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructDecl {
    pub name: String,
    pub fields: Vec<StructField>,
    pub loc: Location,
}

/// Structure field
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructField {
    pub name: String,
    pub field_type: Type,
    pub loc: Location,
}

/// Variable declaration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariableDecl {
    pub name: String,
    pub var_type: Type,
    pub initializer: Option<Expression>,
    pub is_const: bool,
    pub modifiers: Vec<Modifier>,
    pub loc: Location,
}

/// Typedef declaration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypedefDecl {
    pub name: String,
    pub target_type: Type,
    pub loc: Location,
}

/// DCTL macro declaration (DEFINE_UI_PARAMS, etc.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacroDecl {
    pub macro_type: MacroType,
    pub args: Vec<Expression>,
    pub loc: Location,
}

/// Types of DCTL macros
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MacroType {
    DefineUiParams,
    DefineLut,
    DefineCubeLut,
    DefineAcesParam,
    Other(String),
}

/// DCTL UI parameter declaration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiParamDecl {
    pub name: String,
    pub label: String,
    pub ui_type: UiParamType,
    pub loc: Location,
}

/// UI parameter types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum UiParamType {
    SliderFloat {
        default: f64,
        min: f64,
        max: f64,
        step: f64,
    },
    SliderInt {
        default: i64,
        min: i64,
        max: i64,
        step: i64,
    },
    CheckBox {
        default: bool,
    },
    ComboBox {
        default: i64,
        options: Vec<String>,
    },
}

/// DCTL modifiers (__DEVICE__, __CONSTANT__, etc.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Modifier {
    Device,
    Global,
    Constant,
    Private,
    Texture,
    Texture2D,
    Texture3D,
    ConstantRef,
    Resolve,
}

/// Type representation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Type {
    pub base: BaseType,
    pub is_pointer: bool,
    pub is_const: bool,
    pub array_dims: Vec<ArrayDim>,
}

impl Default for Type {
    fn default() -> Self {
        Self {
            base: BaseType::Void,
            is_pointer: false,
            is_const: false,
            array_dims: Vec::new(),
        }
    }
}

/// Array dimension
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ArrayDim {
    Fixed(usize),
    Unspecified,
    Expression(Box<Expression>),
}

/// Base types in DCTL
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BaseType {
    Void,
    Bool,
    Char,
    Int,
    UInt,
    Float,
    Double,
    Half,
    // Vector types
    Float2,
    Float3,
    Float4,
    Int2,
    Int3,
    Int4,
    Half2,
    Half3,
    Half4,
    // Matrix types
    Float2x2,
    Float3x3,
    Float4x4,
    // User-defined types
    Struct(String),
    Typedef(String),
    // Texture types
    Texture2D,
    Texture3D,
    Sampler,
}

/// Block of statements
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Block {
    pub statements: Vec<Statement>,
    pub loc: Location,
}

/// Statement types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Statement {
    Block(Block),
    Variable(VariableDecl),
    Expression(ExpressionStmt),
    If(IfStmt),
    While(WhileStmt),
    DoWhile(DoWhileStmt),
    For(ForStmt),
    Switch(SwitchStmt),
    Return(ReturnStmt),
    Break(BreakStmt),
    Continue(ContinueStmt),
    Empty(EmptyStmt),
}

/// Expression statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpressionStmt {
    pub expression: Expression,
    pub loc: Location,
}

/// If statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IfStmt {
    pub condition: Expression,
    pub then_branch: Box<Statement>,
    pub else_branch: Option<Box<Statement>>,
    pub loc: Location,
}

/// While statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhileStmt {
    pub condition: Expression,
    pub body: Box<Statement>,
    pub loc: Location,
}

/// Do-while statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoWhileStmt {
    pub body: Box<Statement>,
    pub condition: Expression,
    pub loc: Location,
}

/// For statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForStmt {
    pub init: Option<ForInit>,
    pub condition: Option<Expression>,
    pub update: Option<Expression>,
    pub body: Box<Statement>,
    pub loc: Location,
}

/// For loop initializer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ForInit {
    Variable(VariableDecl),
    Expression(Expression),
}

/// Switch statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwitchStmt {
    pub expression: Expression,
    pub cases: Vec<SwitchCase>,
    pub loc: Location,
}

/// Switch case
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwitchCase {
    pub value: Option<Expression>, // None for default case
    pub statements: Vec<Statement>,
    pub loc: Location,
}

/// Return statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReturnStmt {
    pub value: Option<Expression>,
    pub loc: Location,
}

/// Break statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreakStmt {
    pub loc: Location,
}

/// Continue statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContinueStmt {
    pub loc: Location,
}

/// Empty statement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmptyStmt {
    pub loc: Location,
}

/// Expression types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Expression {
    Literal(LiteralExpr),
    Identifier(IdentifierExpr),
    Binary(BinaryExpr),
    Unary(UnaryExpr),
    Ternary(TernaryExpr),
    Call(CallExpr),
    Index(IndexExpr),
    Member(MemberExpr),
    Cast(CastExpr),
    Sizeof(SizeofExpr),
    Assignment(AssignmentExpr),
    Comma(CommaExpr),
    InitializerList(InitializerListExpr),
}

/// Literal expression
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiteralExpr {
    pub value: LiteralValue,
    pub loc: Location,
}

/// Literal values
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LiteralValue {
    Int(i64),
    UInt(u64),
    Float(f64),
    Bool(bool),
    Char(char),
    String(String),
}

/// Identifier expression
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentifierExpr {
    pub name: String,
    pub loc: Location,
}

/// Binary expression
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryExpr {
    pub op: BinaryOp,
    pub left: Box<Expression>,
    pub right: Box<Expression>,
    pub loc: Location,
}

/// Binary operators
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BinaryOp {
    // Arithmetic
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    // Comparison
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    // Logical
    And,
    Or,
    // Bitwise
    BitAnd,
    BitOr,
    BitXor,
    Shl,
    Shr,
}

/// Unary expression
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnaryExpr {
    pub op: UnaryOp,
    pub operand: Box<Expression>,
    pub is_prefix: bool,
    pub loc: Location,
}

/// Unary operators
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UnaryOp {
    Neg,
    Not,
    BitNot,
    Deref,
    AddrOf,
    PreInc,
    PreDec,
    PostInc,
    PostDec,
}

/// Ternary expression (condition ? then : else)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TernaryExpr {
    pub condition: Box<Expression>,
    pub then_expr: Box<Expression>,
    pub else_expr: Box<Expression>,
    pub loc: Location,
}

/// Function call expression
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallExpr {
    pub callee: Box<Expression>,
    pub args: Vec<Expression>,
    pub loc: Location,
}

/// Index expression (array[index])
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexExpr {
    pub object: Box<Expression>,
    pub index: Box<Expression>,
    pub loc: Location,
}

/// Member access expression (obj.member or obj->member)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberExpr {
    pub object: Box<Expression>,
    pub member: String,
    pub is_arrow: bool,
    pub loc: Location,
}

/// Cast expression
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CastExpr {
    pub target_type: Type,
    pub operand: Box<Expression>,
    pub loc: Location,
}

/// Sizeof expression
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SizeofExpr {
    pub operand: SizeofOperand,
    pub loc: Location,
}

/// Sizeof operand
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SizeofOperand {
    Type(Type),
    Expression(Box<Expression>),
}

/// Assignment expression
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssignmentExpr {
    pub op: AssignmentOp,
    pub left: Box<Expression>,
    pub right: Box<Expression>,
    pub loc: Location,
}

/// Assignment operators
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AssignmentOp {
    Assign,
    AddAssign,
    SubAssign,
    MulAssign,
    DivAssign,
    ModAssign,
    BitAndAssign,
    BitOrAssign,
    BitXorAssign,
    ShlAssign,
    ShrAssign,
}

/// Comma expression
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommaExpr {
    pub expressions: Vec<Expression>,
    pub loc: Location,
}

/// Initializer list expression
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitializerListExpr {
    pub elements: Vec<Expression>,
    pub loc: Location,
}
