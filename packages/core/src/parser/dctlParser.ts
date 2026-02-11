/**
 * DCTL Recursive Descent Parser
 *
 * Converts a token stream into an Abstract Syntax Tree.
 */

import { Token, TokenType, tokenToString, isTypeKeyword, isModifier } from './tokens';
import { DctlLexer, LexResult } from './lexer';
import {
    ASTNode, ModuleNode, DeclarationNode, MacroNode, UIParamNode, AlphaModeNode,
    FunctionNode, ParameterNode, ModifierNode, TypeNode, StructDefinitionNode,
    StructMemberNode, TypedefNode, StatementNode, BlockNode, VariableDeclarationNode,
    ExpressionStatementNode, IfNode, WhileNode, ForNode, DoWhileNode, SwitchNode,
    CaseNode, ReturnNode, BreakNode, ContinueNode, EmptyStatementNode,
    ExpressionNode, BinaryExpressionNode, UnaryExpressionNode, TernaryExpressionNode,
    CallExpressionNode, MemberExpressionNode, IndexExpressionNode, AssignmentExpressionNode,
    IdentifierNode, LiteralNode, CastExpressionNode, SizeofExpressionNode, InitializerListNode,
    StatementExpressionNode,
    ParseError, ParseResult, SourceLocation,
} from './ast';

export class DctlParser {
    private tokens: Token[] = [];
    private pos: number = 0;
    private errors: ParseError[] = [];
    /** Known user-defined type names (from typedef, struct) */
    private knownUserTypes: Set<string> = new Set();

    /**
     * Parse DCTL source code
     */
    parse(source: string): ParseResult {
        // Tokenize
        const lexer = new DctlLexer(source);
        const lexResult = lexer.tokenize();

        // Add lexer errors
        this.errors = lexResult.errors.map(e => ({
            message: e.message,
            line: e.line,
            column: e.column,
        }));

        this.tokens = lexResult.tokens;
        this.pos = 0;
        this.knownUserTypes = new Set();

        try {
            const ast = this.parseModule();
            return { ast, errors: this.errors };
        } catch (e) {
            return { ast: null, errors: this.errors };
        }
    }

    // =========================================================================
    // Token Access
    // =========================================================================

    private current(): Token {
        if (this.pos >= this.tokens.length) {
            return this.tokens[this.tokens.length - 1]; // EOF
        }
        return this.tokens[this.pos];
    }

    private peek(offset: number = 1): Token {
        const pos = this.pos + offset;
        if (pos >= this.tokens.length) {
            return this.tokens[this.tokens.length - 1];
        }
        return this.tokens[pos];
    }

    private atEnd(): boolean {
        return this.current().type === TokenType.EOF;
    }

    private check(...types: TokenType[]): boolean {
        return types.includes(this.current().type);
    }

    private previous(): Token {
        if (this.pos > 0) {
            return this.tokens[this.pos - 1];
        }
        return this.tokens[0];
    }

    private advance(): Token {
        const token = this.current();
        if (!this.atEnd()) {
            this.pos++;
        }
        return token;
    }

    private consume(type: TokenType, message: string): Token {
        if (this.check(type)) {
            return this.advance();
        }
        // For missing semicolons, report at the previous token (where ';' should be)
        // instead of the current token (which is the next unrelated statement)
        if (type === TokenType.SEMICOLON && this.pos > 0) {
            const prev = this.previous();
            this.errors.push({
                message,
                line: prev.line,
                column: prev.column + (typeof prev.value === 'string' ? prev.value.length : String(prev.value ?? '').length || 1),
                expected: tokenToString(type),
                found: tokenToString(this.current().type),
            });
            throw new Error(message);
        }
        this.error(message, type);
        throw new Error(message);
    }

    /**
     * Consume an identifier or type keyword as a typedef name.
     * Type keywords like mat2, mat3, mat4 can be used as typedef names.
     */
    private consumeTypedefName(message: string): Token {
        const token = this.current();
        if (token.type === TokenType.IDENTIFIER || isTypeKeyword(token.type)) {
            return this.advance();
        }
        this.error(message, TokenType.IDENTIFIER);
        throw new Error(message);
    }

    private match(...types: TokenType[]): Token | null {
        if (this.check(...types)) {
            return this.advance();
        }
        return null;
    }

    private error(message: string, expected?: TokenType): void {
        const token = this.current();
        this.errors.push({
            message,
            line: token.line,
            column: token.column,
            expected: expected ? tokenToString(expected) : undefined,
            found: tokenToString(token.type),
        });
    }

    private loc(startToken: Token, endToken?: Token): SourceLocation {
        return {
            line: startToken.line,
            column: startToken.column,
            endLine: endToken?.line ?? startToken.line,
            endColumn: endToken?.endColumn ?? startToken.endColumn,
        };
    }

    /**
     * Check if an identifier is a known type (built-in or user-defined)
     */
    private isKnownType(name: string): boolean {
        return this.knownUserTypes.has(name);
    }

    /**
     * Evaluate a constant expression for array size
     * Handles: literals, unary minus (e.g., -5)
     * Returns null for non-constant expressions
     */
    private evaluateArraySizeExpr(expr: ExpressionNode): number | null {
        if (expr.kind === 'Literal') {
            const value = (expr as LiteralNode).value;
            return typeof value === 'number' ? value : null;
        }
        if (expr.kind === 'UnaryExpression') {
            const unary = expr as UnaryExpressionNode;
            if (unary.operator === '-' && unary.operand.kind === 'Literal') {
                const value = (unary.operand as LiteralNode).value;
                return typeof value === 'number' ? -value : null;
            }
            if (unary.operator === '+' && unary.operand.kind === 'Literal') {
                const value = (unary.operand as LiteralNode).value;
                return typeof value === 'number' ? value : null;
            }
        }
        return null; // Non-constant expression (identifier, complex expression)
    }

    // =========================================================================
    // Module Parsing
    // =========================================================================

    private parseModule(): ModuleNode {
        const startToken = this.current();
        const declarations: DeclarationNode[] = [];
        const macros: MacroNode[] = [];

        while (!this.atEnd()) {
            try {
                // Check for DCTL macros
                if (this.check(TokenType.DEFINE_UI_PARAMS, TokenType.DEFINE_UI_TOOLTIP,
                    TokenType.DEFINE_ACES_PARAM, TokenType.DEFINE_DCTL_ALPHA_MODE)) {
                    macros.push(this.parseMacro());
                    continue;
                }

                // Check for struct DEFINITION (not struct as a type specifier)
                // struct Name { ... } is a definition
                // struct Name identifier; is a variable declaration (type specifier)
                // struct Name identifier(...) is a function declaration (type specifier)
                if (this.check(TokenType.STRUCT)) {
                    // Look ahead: struct Name { is a definition, struct Name identifier is a type specifier
                    const nextToken = this.peek(1);
                    if (nextToken.type === TokenType.OPEN_BRACE) {
                        // struct { ... } - anonymous struct definition
                        declarations.push(this.parseStructDefinition());
                        continue;
                    } else if (nextToken.type === TokenType.IDENTIFIER) {
                        const afterNameToken = this.peek(2);
                        if (afterNameToken.type === TokenType.OPEN_BRACE) {
                            // struct Name { ... } - named struct definition
                            declarations.push(this.parseStructDefinition());
                            continue;
                        }
                        // Otherwise it's struct Name varOrFuncName - a type specifier, not a definition
                        // Fall through to parseDeclaration()
                    }
                    // struct not followed by Name { - treat as type specifier for variable/function
                }

                // Check for typedef
                if (this.check(TokenType.TYPEDEF)) {
                    declarations.push(this.parseTypedef());
                    continue;
                }

                // Skip stray semicolons at top level (e.g., after function definitions: "} ;")
                if (this.check(TokenType.SEMICOLON)) {
                    this.advance();
                    continue;
                }

                // Otherwise, parse function or variable declaration
                const decl = this.parseDeclaration();
                if (decl) {
                    declarations.push(decl);
                } else {
                    // If parseDeclaration returns null, advance to prevent infinite loop
                    if (!this.atEnd()) {
                        this.advance();
                    }
                }
            } catch (e) {
                // Error recovery: skip to next semicolon or brace
                this.synchronize();
            }
        }

        return {
            kind: 'Module',
            declarations,
            macros,
            loc: this.loc(startToken, this.current()),
        };
    }

    private synchronize(): void {
        // If current token is already a block-closing brace, don't skip it.
        // Let the enclosing parseBlock consume it properly.
        if (this.check(TokenType.CLOSE_BRACE)) {
            return;
        }
        this.advance();
        while (!this.atEnd()) {
            if (this.check(TokenType.SEMICOLON)) {
                this.advance();
                return;
            }
            if (this.check(TokenType.CLOSE_BRACE)) {
                return;
            }
            // Skip balanced braces to avoid losing track of nesting.
            // Without this, synchronize could consume a '{' from an if/for/while block,
            // causing parseBlock to mistake the inner '}' for the function body's closing brace.
            if (this.check(TokenType.OPEN_BRACE)) {
                this.skipBalancedBraces();
                continue;
            }
            // Stop at statement keywords so parseBlock can resume normal statement parsing.
            if (this.check(TokenType.IF, TokenType.FOR, TokenType.WHILE,
                TokenType.DO, TokenType.SWITCH, TokenType.RETURN,
                TokenType.BREAK, TokenType.CONTINUE)) {
                return;
            }
            if (this.check(TokenType.__DEVICE__, TokenType.STRUCT, TokenType.TYPEDEF,
                TokenType.DEFINE_UI_PARAMS, TokenType.DEFINE_DCTL_ALPHA_MODE)) {
                return;
            }
            this.advance();
        }
    }

    /**
     * Skip a balanced pair of braces { ... }, handling nesting.
     * Used by synchronize() to avoid consuming tokens inside nested blocks.
     */
    private skipBalancedBraces(): void {
        let depth = 0;
        while (!this.atEnd()) {
            if (this.check(TokenType.OPEN_BRACE)) {
                depth++;
            } else if (this.check(TokenType.CLOSE_BRACE)) {
                depth--;
                if (depth === 0) {
                    this.advance(); // consume the closing brace
                    return;
                }
            }
            this.advance();
        }
    }

    // =========================================================================
    // DCTL Macros
    // =========================================================================

    private parseMacro(): MacroNode {
        const startToken = this.current();
        const name = this.advance().value as string;
        const args: string[] = [];

        // Parse macro arguments if present
        if (this.match(TokenType.OPEN_PAREN)) {
            let depth = 1;
            let currentArg = '';

            while (!this.atEnd() && depth > 0) {
                const token = this.current();
                if (token.type === TokenType.OPEN_PAREN) {
                    depth++;
                    currentArg += '(';
                    this.advance();
                } else if (token.type === TokenType.CLOSE_PAREN) {
                    depth--;
                    if (depth > 0) {
                        currentArg += ')';
                        this.advance();
                    }
                } else if (token.type === TokenType.COMMA && depth === 1) {
                    args.push(currentArg.trim());
                    currentArg = '';
                    this.advance();
                } else {
                    currentArg += token.value?.toString() ?? tokenToString(token.type);
                    this.advance();
                }
            }

            if (currentArg.trim()) {
                args.push(currentArg.trim());
            }

            this.match(TokenType.CLOSE_PAREN);
        }

        return {
            kind: 'Macro',
            name,
            arguments: args,
            rawText: name + (args.length > 0 ? `(${args.join(', ')})` : ''),
            loc: this.loc(startToken, this.current()),
        };
    }

    // =========================================================================
    // Declarations
    // =========================================================================

    private parseDeclaration(): DeclarationNode | null {
        const modifiers = this.parseModifiers();
        const type = this.parseType();

        if (!type) {
            this.error('Expected type');
            return null;
        }

        // Skip 'inline' if it appears after the type (e.g., "float3 inline func()")
        // This is valid C syntax but unusual ordering
        while (this.check(TokenType.INLINE, TokenType.STATIC, TokenType.CONST)) {
            const token = this.advance();
            modifiers.push({
                kind: 'Modifier',
                modifier: token.value as ModifierNode['modifier'],
                loc: this.loc(token),
            });
        }

        // Check if this is a function or variable
        const name = this.consume(TokenType.IDENTIFIER, 'Expected identifier');

        if (this.check(TokenType.OPEN_PAREN)) {
            // Function
            return this.parseFunction(modifiers, type, name.value as string);
        } else {
            // Variable
            return this.parseVariableDeclaration(type, name.value as string, modifiers.some(m => m.modifier === 'const'));
        }
    }

    private parseModifiers(): ModifierNode[] {
        const modifiers: ModifierNode[] = [];

        while (this.check(TokenType.__DEVICE__, TokenType.__CONSTANT__, TokenType.__GLOBAL__,
            TokenType.__LOCAL__, TokenType.__PRIVATE__, TokenType.CONST, TokenType.STATIC, TokenType.INLINE)) {
            const token = this.advance();
            modifiers.push({
                kind: 'Modifier',
                modifier: token.value as ModifierNode['modifier'],
                loc: this.loc(token),
            });
        }

        return modifiers;
    }

    private parseFunction(modifiers: ModifierNode[], returnType: TypeNode, name: string): FunctionNode {
        const startToken = this.tokens[this.pos - 1];

        this.consume(TokenType.OPEN_PAREN, 'Expected (');
        const parameters = this.parseParameterList();
        this.consume(TokenType.CLOSE_PAREN, 'Expected )');

        let body: BlockNode | null = null;
        if (this.check(TokenType.OPEN_BRACE)) {
            body = this.parseBlock();
        } else {
            this.consume(TokenType.SEMICOLON, 'Expected ; or {');
        }

        const isEntryPoint = (name === 'transform' || name === 'transition') &&
            modifiers.some(m => m.modifier === '__DEVICE__');

        return {
            kind: 'Function',
            name,
            returnType,
            parameters,
            body,
            modifiers,
            isEntryPoint,
            loc: this.loc(startToken, this.current()),
        };
    }

    private parseParameterList(): ParameterNode[] {
        const params: ParameterNode[] = [];

        if (this.check(TokenType.CLOSE_PAREN)) {
            return params;
        }

        do {
            const param = this.parseParameter();
            if (param) {
                params.push(param);
            }
        } while (this.match(TokenType.COMMA));

        return params;
    }

    private parseParameter(): ParameterNode | null {
        const startToken = this.current();
        let isConst = false;

        // Handle const modifier
        if (this.match(TokenType.CONST)) {
            isConst = true;
        }

        // Handle __CONSTANTREF__ modifier (treat as const pointer)
        if (this.match(TokenType.__CONSTANTREF__)) {
            isConst = true;
        }

        // Handle __PRIVATE__ modifier (OpenCL memory space qualifier for pointers)
        // Skip it as it's not relevant for GLSL output
        this.match(TokenType.__PRIVATE__);

        const type = this.parseType();
        if (!type) return null;

        // Parameter name can be an identifier OR a type keyword used as a name
        // (e.g., float2 half2, where half2 is used as a parameter name)
        let nameToken = this.match(TokenType.IDENTIFIER);
        if (!nameToken && isTypeKeyword(this.current().type)) {
            // Allow type keywords as parameter names (not ideal but valid C)
            nameToken = this.advance();
        }
        const name = nameToken?.value as string ?? '';

        // Handle array parameters (including multi-dimensional: float mat[3][3])
        // For unspecified dimensions like arr[], we use -1 as sentinel value
        const arraySizes: number[] = [];
        const arraySizeExprs: ExpressionNode[] = [];
        while (this.match(TokenType.OPEN_BRACKET)) {
            type.isArray = true;
            if (!this.check(TokenType.CLOSE_BRACKET)) {
                // Array size expression - handles literals and unary minus (e.g., -5)
                const sizeExpr = this.parseExpression();
                arraySizeExprs.push(sizeExpr);  // Always store the expression
                const sizeValue = this.evaluateArraySizeExpr(sizeExpr);
                // Use -1 for unresolved expressions (e.g., constants not yet evaluated)
                arraySizes.push(sizeValue ?? -1);
            } else {
                // Empty brackets [] - unspecified dimension (e.g., char arr[][10])
                // Use -1 as sentinel for unspecified dimensions
                arraySizes.push(-1);
            }
            this.consume(TokenType.CLOSE_BRACKET, 'Expected ]');
        }
        // Store array sizes for multi-dimensional arrays
        if (arraySizes.length > 0) {
            type.arraySize = arraySizes[0];
            if (arraySizes.length > 1) {
                // Store all dimensions for proper GLSL multi-dimensional array
                type.arraySizes = arraySizes;
            }
        }
        // Store expressions for const variable evaluation in codegen
        if (arraySizeExprs.length > 0) {
            type.arraySizeExprs = arraySizeExprs;
        }

        return {
            kind: 'Parameter',
            name,
            type,
            isConst,
            loc: this.loc(startToken, this.current()),
        };
    }

    // =========================================================================
    // Types
    // =========================================================================

    private parseType(): TypeNode | null {
        const startToken = this.current();
        let isConst = false;

        if (this.match(TokenType.CONST)) {
            isConst = true;
        }

        // Skip OpenCL memory space qualifiers (__PRIVATE__, __GLOBAL__, __LOCAL__, __CONSTANTREF__, etc.)
        // These appear in pointer type declarations but are not relevant for GLSL
        while (this.check(TokenType.__PRIVATE__, TokenType.__GLOBAL__, TokenType.__LOCAL__, TokenType.__CONSTANTREF__)) {
            this.advance();
        }

        let name: string;

        // Handle unsigned/signed modifiers (compound types like 'unsigned long', 'signed int')
        if (this.check(TokenType.UNSIGNED, TokenType.SIGNED)) {
            const modifier = this.advance().value as string;
            // Check for following type (long, int, short, char)
            if (this.check(TokenType.LONG, TokenType.INT, TokenType.SHORT, TokenType.CHAR)) {
                const baseType = this.advance().value as string;
                // Handle 'unsigned long long' or 'long long'
                if (baseType === 'long' && this.check(TokenType.LONG)) {
                    this.advance();
                    name = `${modifier} long long`;
                } else {
                    name = `${modifier} ${baseType}`;
                }
            } else if (this.check(TokenType.IDENTIFIER)) {
                // unsigned CustomType (rare but possible)
                name = `${modifier} ${this.advance().value as string}`;
            } else {
                // Just 'unsigned' or 'signed' alone means 'unsigned int' / 'signed int'
                name = `${modifier} int`;
            }
        } else if (isTypeKeyword(this.current().type)) {
            name = this.advance().value as string;
            // Handle 'long long' without unsigned/signed
            if (name === 'long' && this.check(TokenType.LONG)) {
                this.advance();
                name = 'long long';
            }
        } else if (this.check(TokenType.IDENTIFIER)) {
            name = this.advance().value as string;
        } else if (this.check(TokenType.STRUCT)) {
            this.advance();
            name = 'struct ' + (this.match(TokenType.IDENTIFIER)?.value ?? '');
        } else {
            return null;
        }

        let isPointer = false;
        while (this.match(TokenType.TIMES)) {
            isPointer = true;
        }

        return {
            kind: 'Type',
            name,
            isPointer,
            isArray: false,
            isConst,
            loc: this.loc(startToken, this.current()),
        };
    }

    private parseStructDefinition(): StructDefinitionNode {
        const startToken = this.current();
        this.consume(TokenType.STRUCT, 'Expected struct');

        const nameToken = this.match(TokenType.IDENTIFIER);
        const name = nameToken?.value as string ?? '';

        // Register struct name as a known type
        if (name) {
            this.knownUserTypes.add(name);
        }

        const members: StructMemberNode[] = [];

        if (this.match(TokenType.OPEN_BRACE)) {
            while (!this.check(TokenType.CLOSE_BRACE) && !this.atEnd()) {
                const memberType = this.parseType();
                if (!memberType) break;

                // Parse member names (can be comma-separated: float x, y, z;)
                // Also support array members: float arr[3];
                do {
                    const memberName = this.consume(TokenType.IDENTIFIER, 'Expected member name');

                    // Clone type for each member to handle arrays independently
                    const memberTypeClone: TypeNode = { ...memberType };

                    // Handle array member: float arr[3];
                    if (this.match(TokenType.OPEN_BRACKET)) {
                        memberTypeClone.isArray = true;
                        if (!this.check(TokenType.CLOSE_BRACKET)) {
                            const sizeExpr = this.parseExpression();
                            memberTypeClone.arraySizeExprs = [sizeExpr];  // Store expression
                            const sizeValue = this.evaluateArraySizeExpr(sizeExpr);
                            if (sizeValue !== null) {
                                memberTypeClone.arraySize = sizeValue;
                            }
                        }
                        this.consume(TokenType.CLOSE_BRACKET, 'Expected ]');
                    }

                    members.push({
                        kind: 'StructMember',
                        name: memberName.value as string,
                        type: memberTypeClone,
                        loc: this.loc(memberType.loc as unknown as Token),
                    });
                } while (this.match(TokenType.COMMA));

                this.consume(TokenType.SEMICOLON, 'Expected ;');
            }
            this.consume(TokenType.CLOSE_BRACE, 'Expected }');
        }

        this.match(TokenType.SEMICOLON);

        return {
            kind: 'StructDefinition',
            name,
            members,
            loc: this.loc(startToken, this.current()),
        };
    }

    private parseTypedef(): TypedefNode | StructDefinitionNode {
        const startToken = this.current();
        this.consume(TokenType.TYPEDEF, 'Expected typedef');

        // Check for typedef struct { ... } Name;
        if (this.check(TokenType.STRUCT)) {
            this.advance(); // consume 'struct'

            // Optional struct name (before {})
            const structName = this.match(TokenType.IDENTIFIER);

            // Parse struct body
            const members: StructMemberNode[] = [];
            if (this.match(TokenType.OPEN_BRACE)) {
                while (!this.check(TokenType.CLOSE_BRACE) && !this.atEnd()) {
                    const memberType = this.parseType();
                    if (!memberType) break;

                    // Parse member declarators (can be comma-separated: float x, y, z;)
                    // Each declarator can have an array size: float arr[10];
                    interface MemberDeclarator {
                        name: string;
                        arraySize: number | null;
                    }
                    const declarators: MemberDeclarator[] = [];

                    // Parse first declarator
                    const firstName = this.consume(TokenType.IDENTIFIER, 'Expected member name').value as string;
                    let firstArraySize: number | null = null;
                    if (this.match(TokenType.OPEN_BRACKET)) {
                        const sizeToken = this.consume(TokenType.INT_LITERAL, 'Expected array size');
                        firstArraySize = Number(sizeToken.value);
                        this.consume(TokenType.CLOSE_BRACKET, 'Expected ]');
                    }
                    declarators.push({ name: firstName, arraySize: firstArraySize });

                    // Parse additional declarators
                    while (this.match(TokenType.COMMA)) {
                        const name = this.consume(TokenType.IDENTIFIER, 'Expected member name').value as string;
                        let arraySize: number | null = null;
                        if (this.match(TokenType.OPEN_BRACKET)) {
                            const sizeToken = this.consume(TokenType.INT_LITERAL, 'Expected array size');
                            arraySize = Number(sizeToken.value);
                            this.consume(TokenType.CLOSE_BRACKET, 'Expected ]');
                        }
                        declarators.push({ name, arraySize });
                    }

                    this.consume(TokenType.SEMICOLON, 'Expected ;');

                    // Create a member entry for each declarator
                    for (const decl of declarators) {
                        const finalType: TypeNode = decl.arraySize !== null
                            ? {
                                ...memberType,
                                isArray: true,
                                arraySize: decl.arraySize,
                            }
                            : memberType;
                        members.push({
                            kind: 'StructMember',
                            name: decl.name,
                            type: finalType,
                            loc: this.loc(memberType.loc as unknown as Token),
                        });
                    }
                }
                this.consume(TokenType.CLOSE_BRACE, 'Expected }');
            }

            // Parse the typedef alias name (can be IDENTIFIER or type keyword like mat2, mat3, mat4)
            const aliasName = this.consumeTypedefName('Expected typedef name');
            this.consume(TokenType.SEMICOLON, 'Expected ;');

            // Register typedef alias as a known type
            const typeName = aliasName.value as string;
            if (typeName) {
                this.knownUserTypes.add(typeName);
            }

            // Return as StructDefinition with the alias name
            return {
                kind: 'StructDefinition',
                name: typeName,
                members,
                loc: this.loc(startToken, this.current()),
            };
        }

        // Regular typedef: typedef type name;
        const type = this.parseType();
        const name = this.consumeTypedefName('Expected name');
        this.consume(TokenType.SEMICOLON, 'Expected ;');

        // Register typedef name as a known type
        const typedefName = name.value as string;
        if (typedefName) {
            this.knownUserTypes.add(typedefName);
        }

        return {
            kind: 'Typedef',
            name: typedefName,
            type: type!,
            loc: this.loc(startToken, this.current()),
        };
    }

    // =========================================================================
    // Statements
    // =========================================================================

    private parseStatement(): StatementNode {
        if (this.check(TokenType.OPEN_BRACE)) {
            return this.parseBlock();
        }
        if (this.check(TokenType.IF)) {
            return this.parseIf();
        }
        if (this.check(TokenType.WHILE)) {
            return this.parseWhile();
        }
        if (this.check(TokenType.FOR)) {
            return this.parseFor();
        }
        if (this.check(TokenType.DO)) {
            return this.parseDoWhile();
        }
        if (this.check(TokenType.SWITCH)) {
            return this.parseSwitch();
        }
        if (this.check(TokenType.RETURN)) {
            return this.parseReturn();
        }
        if (this.check(TokenType.BREAK)) {
            const token = this.advance();
            this.consume(TokenType.SEMICOLON, 'Expected ;');
            return { kind: 'Break', loc: this.loc(token) };
        }
        if (this.check(TokenType.CONTINUE)) {
            const token = this.advance();
            this.consume(TokenType.SEMICOLON, 'Expected ;');
            return { kind: 'Continue', loc: this.loc(token) };
        }
        if (this.check(TokenType.SEMICOLON)) {
            const token = this.advance();
            return { kind: 'EmptyStatement', loc: this.loc(token) };
        }
        // Support typedef inside function bodies (e.g., typedef struct { ... } name;)
        if (this.check(TokenType.TYPEDEF)) {
            return this.parseTypedef();
        }

        // Check for variable declaration
        if (this.isVariableDeclaration()) {
            const declarations = this.parseVariableDeclarationStatement();
            if (declarations.length === 1) {
                return declarations[0];
            }
            // Multiple declarations: wrap in a block
            return {
                kind: 'Block',
                statements: declarations,
                loc: declarations[0].loc,
            } as BlockNode;
        }

        // Check for malformed variable declaration (const without proper type)
        if (this.check(TokenType.CONST)) {
            const constToken = this.current();
            this.advance(); // consume const
            const nextToken = this.current();

            // If next token is an identifier followed by ; this is a missing type error
            if (this.check(TokenType.IDENTIFIER)) {
                const identToken = this.advance();
                if (this.check(TokenType.SEMICOLON)) {
                    this.error(`Expected type after 'const' (e.g., 'const float ${identToken.value}')`);
                    this.advance(); // consume ;
                    // Return a placeholder declaration to continue parsing
                    return {
                        kind: 'VariableDeclaration',
                        name: identToken.value as string,
                        type: { kind: 'Type', name: 'unknown', isPointer: false, isArray: false, isConst: true, loc: this.loc(constToken) },
                        initializer: null,
                        isConst: true,
                        loc: this.loc(constToken, this.tokens[this.pos - 1]),
                    };
                }
            }
            // Reset position if not the expected pattern
            this.pos = this.tokens.indexOf(constToken);
        }

        // Expression statement
        return this.parseExpressionStatement();
    }

    private isVariableDeclaration(): boolean {
        // Look ahead to determine if this is a declaration
        let pos = this.pos;

        // Skip storage class specifiers (const, static, inline)
        while (
            this.tokens[pos]?.type === TokenType.CONST ||
            this.tokens[pos]?.type === TokenType.STATIC ||
            this.tokens[pos]?.type === TokenType.INLINE
        ) {
            pos++;
        }

        // Skip memory qualifiers (__PRIVATE__, __GLOBAL__, __LOCAL__, __CONSTANTREF__)
        while (
            this.tokens[pos]?.type === TokenType.__PRIVATE__ ||
            this.tokens[pos]?.type === TokenType.__GLOBAL__ ||
            this.tokens[pos]?.type === TokenType.__LOCAL__ ||
            this.tokens[pos]?.type === TokenType.__CONSTANTREF__
        ) {
            pos++;
        }

        // Check for struct TypeName declaration
        if (this.tokens[pos]?.type === TokenType.STRUCT) {
            pos++;
            // struct name
            if (this.tokens[pos]?.type === TokenType.IDENTIFIER) {
                pos++;
                // Skip pointer stars
                while (this.tokens[pos]?.type === TokenType.TIMES) pos++;
                // Check if followed by identifier (variable name)
                if (this.tokens[pos]?.type === TokenType.IDENTIFIER) {
                    pos++;
                    const nextType = this.tokens[pos]?.type;
                    return nextType === TokenType.ASSIGN ||
                        nextType === TokenType.SEMICOLON ||
                        nextType === TokenType.OPEN_BRACKET ||
                        nextType === TokenType.COMMA;
                }
            }
            return false;
        }

        // Check for unsigned/signed compound types (unsigned long, signed int, etc.)
        if (this.tokens[pos]?.type === TokenType.UNSIGNED ||
            this.tokens[pos]?.type === TokenType.SIGNED) {
            pos++;
            // Skip the base type (long, int, short, char) or identifier
            if (this.tokens[pos]?.type === TokenType.LONG ||
                this.tokens[pos]?.type === TokenType.INT ||
                this.tokens[pos]?.type === TokenType.SHORT ||
                this.tokens[pos]?.type === TokenType.CHAR ||
                this.tokens[pos]?.type === TokenType.IDENTIFIER) {
                pos++;
                // Handle 'unsigned long long'
                if (this.tokens[pos]?.type === TokenType.LONG) {
                    pos++;
                }
            }
            // Skip pointer stars
            while (this.tokens[pos]?.type === TokenType.TIMES) pos++;
            // Check if followed by identifier (variable name)
            if (this.tokens[pos]?.type === TokenType.IDENTIFIER) {
                pos++;
                const nextType = this.tokens[pos]?.type;
                return nextType === TokenType.ASSIGN ||
                    nextType === TokenType.SEMICOLON ||
                    nextType === TokenType.OPEN_BRACKET ||
                    nextType === TokenType.COMMA;
            }
            return false;
        }

        // Check for type keyword or identifier followed by identifier
        if (isTypeKeyword(this.tokens[pos]?.type) || this.tokens[pos]?.type === TokenType.IDENTIFIER) {
            pos++;
            // Skip pointer stars
            while (this.tokens[pos]?.type === TokenType.TIMES) pos++;
            // Check if followed by identifier
            if (this.tokens[pos]?.type === TokenType.IDENTIFIER) {
                // Check if followed by = or ; or [ (declaration) vs ( (function call)
                pos++;
                const nextType = this.tokens[pos]?.type;
                return nextType === TokenType.ASSIGN ||
                    nextType === TokenType.SEMICOLON ||
                    nextType === TokenType.OPEN_BRACKET ||
                    nextType === TokenType.COMMA;
            }
        }

        return false;
    }

    private parseBlock(): BlockNode {
        const startToken = this.current();
        this.consume(TokenType.OPEN_BRACE, 'Expected {');

        const statements: StatementNode[] = [];
        while (!this.check(TokenType.CLOSE_BRACE) && !this.atEnd()) {
            try {
                statements.push(this.parseStatement());
            } catch (e) {
                this.synchronize();
            }
        }

        this.consume(TokenType.CLOSE_BRACE, 'Expected }');

        return {
            kind: 'Block',
            statements,
            loc: this.loc(startToken, this.current()),
        };
    }

    /**
     * Parse variable declaration statement with support for multiple declarations:
     * int x;
     * int x = 1;
     * int x, y, z;
     * int x = 1, y = 2;
     * static float counter = 0.0f;
     * const static int MAX = 100;
     */
    private parseVariableDeclarationStatement(): VariableDeclarationNode[] {
        const startToken = this.current();
        let isConst = false;
        let isStatic = false;

        // Parse storage class specifiers (const, static) in any order
        while (this.check(TokenType.CONST) || this.check(TokenType.STATIC) || this.check(TokenType.INLINE)) {
            if (this.match(TokenType.CONST)) {
                isConst = true;
            } else if (this.match(TokenType.STATIC)) {
                isStatic = true;
            } else if (this.match(TokenType.INLINE)) {
                // inline is ignored for variables
            }
        }

        const baseType = this.parseType()!;
        const declarations: VariableDeclarationNode[] = [];

        do {
            // Variable name can be an identifier OR a type keyword used as a name
            let name: Token;
            if (this.check(TokenType.IDENTIFIER)) {
                name = this.advance();
            } else if (isTypeKeyword(this.current().type)) {
                // Allow type keywords as variable names (not ideal but valid C)
                name = this.advance();
            } else {
                name = this.consume(TokenType.IDENTIFIER, 'Expected variable name');
            }

            // Clone type for each variable to handle arrays independently
            const type: TypeNode = { ...baseType, isArray: baseType.isArray, arraySize: baseType.arraySize };

            // Handle array declaration (including multi-dimensional: float mat[3][3])
            // For unspecified dimensions like arr[], we use -1 as sentinel value
            const arraySizes: number[] = [];
            const arraySizeExprs: ExpressionNode[] = [];
            while (this.match(TokenType.OPEN_BRACKET)) {
                type.isArray = true;
                if (!this.check(TokenType.CLOSE_BRACKET)) {
                    const sizeExpr = this.parseExpression();
                    arraySizeExprs.push(sizeExpr);  // Always store the expression
                    const sizeValue = this.evaluateArraySizeExpr(sizeExpr);
                    // Use -1 for unresolved expressions (e.g., constants not yet evaluated)
                    arraySizes.push(sizeValue ?? -1);
                } else {
                    // Empty brackets [] - unspecified dimension
                    arraySizes.push(-1);
                }
                this.consume(TokenType.CLOSE_BRACKET, 'Expected ]');
            }
            // Store array sizes for multi-dimensional arrays
            if (arraySizes.length > 0) {
                type.arraySize = arraySizes[0];
                if (arraySizes.length > 1) {
                    type.arraySizes = arraySizes;
                }
            }
            // Store expressions for const variable evaluation in codegen
            if (arraySizeExprs.length > 0) {
                type.arraySizeExprs = arraySizeExprs;
            }

            let initializer: ExpressionNode | null = null;
            if (this.match(TokenType.ASSIGN)) {
                initializer = this.parseExpression();
            }

            declarations.push({
                kind: 'VariableDeclaration',
                name: name.value as string,
                type,
                initializer,
                isConst,
                isStatic,
                loc: this.loc(startToken, this.current()),
            });
        } while (this.match(TokenType.COMMA));

        this.consume(TokenType.SEMICOLON, 'Expected ;');

        return declarations;
    }

    private parseVariableDeclaration(type: TypeNode, name: string, isConst: boolean): VariableDeclarationNode {
        const startToken = this.tokens[this.pos - 1];

        // Handle array (including multi-dimensional: float mat[3][3])
        // For unspecified dimensions like arr[], we use -1 as sentinel value
        const arraySizes: number[] = [];
        const arraySizeExprs: ExpressionNode[] = [];
        while (this.match(TokenType.OPEN_BRACKET)) {
            type.isArray = true;
            if (!this.check(TokenType.CLOSE_BRACKET)) {
                const sizeExpr = this.parseExpression();
                arraySizeExprs.push(sizeExpr);  // Always store the expression
                const sizeValue = this.evaluateArraySizeExpr(sizeExpr);
                // Use -1 for unresolved expressions (e.g., constants not yet evaluated)
                arraySizes.push(sizeValue ?? -1);
            } else {
                // Empty brackets [] - unspecified dimension
                arraySizes.push(-1);
            }
            this.consume(TokenType.CLOSE_BRACKET, 'Expected ]');
        }
        // Store array sizes for multi-dimensional arrays
        if (arraySizes.length > 0) {
            type.arraySize = arraySizes[0];
            if (arraySizes.length > 1) {
                // Store all dimensions for proper GLSL multi-dimensional array
                type.arraySizes = arraySizes;
            }
        }
        // Store expressions for const variable evaluation in codegen
        if (arraySizeExprs.length > 0) {
            type.arraySizeExprs = arraySizeExprs;
        }

        let initializer: ExpressionNode | null = null;
        if (this.match(TokenType.ASSIGN)) {
            initializer = this.parseExpression();
        }

        this.consume(TokenType.SEMICOLON, 'Expected ;');

        return {
            kind: 'VariableDeclaration',
            name,
            type,
            initializer,
            isConst,
            loc: this.loc(startToken, this.current()),
        };
    }

    private parseExpressionStatement(): ExpressionStatementNode {
        const startToken = this.current();
        // Use parseCommaExpression to handle comma-separated assignments like: a = 1, b = 2, c = 3;
        const expr = this.parseCommaExpression();
        this.consume(TokenType.SEMICOLON, 'Expected ;');

        return {
            kind: 'ExpressionStatement',
            expression: expr,
            loc: this.loc(startToken, this.current()),
        };
    }

    private parseIf(): IfNode {
        const startToken = this.current();
        this.consume(TokenType.IF, 'Expected if');
        this.consume(TokenType.OPEN_PAREN, 'Expected (');
        const condition = this.parseExpression();
        this.consume(TokenType.CLOSE_PAREN, 'Expected )');

        const thenBranch = this.parseStatement();
        let elseBranch: StatementNode | null = null;

        if (this.match(TokenType.ELSE)) {
            elseBranch = this.parseStatement();
        }

        return {
            kind: 'If',
            condition,
            thenBranch,
            elseBranch,
            loc: this.loc(startToken, this.current()),
        };
    }

    private parseWhile(): WhileNode {
        const startToken = this.current();
        this.consume(TokenType.WHILE, 'Expected while');
        this.consume(TokenType.OPEN_PAREN, 'Expected (');
        const condition = this.parseExpression();
        this.consume(TokenType.CLOSE_PAREN, 'Expected )');
        const body = this.parseStatement();

        return {
            kind: 'While',
            condition,
            body,
            loc: this.loc(startToken, this.current()),
        };
    }

    private parseFor(): ForNode {
        const startToken = this.current();
        this.consume(TokenType.FOR, 'Expected for');
        this.consume(TokenType.OPEN_PAREN, 'Expected (');

        let init: VariableDeclarationNode | VariableDeclarationNode[] | ExpressionNode | null = null;
        if (!this.check(TokenType.SEMICOLON)) {
            if (this.isVariableDeclaration()) {
                const declarations = this.parseVariableDeclarationStatement();
                // Return array if multiple declarations, single node if one
                init = declarations.length === 1 ? declarations[0] : declarations;
            } else {
                init = this.parseExpression();
                this.consume(TokenType.SEMICOLON, 'Expected ;');
            }
        } else {
            this.advance(); // skip ;
        }

        let condition: ExpressionNode | null = null;
        if (!this.check(TokenType.SEMICOLON)) {
            condition = this.parseExpression();
        }
        this.consume(TokenType.SEMICOLON, 'Expected ;');

        let update: ExpressionNode | null = null;
        if (!this.check(TokenType.CLOSE_PAREN)) {
            // Use parseCommaExpression to handle update expressions like: i++, j--
            update = this.parseCommaExpression();
        }
        this.consume(TokenType.CLOSE_PAREN, 'Expected )');

        const body = this.parseStatement();

        return {
            kind: 'For',
            init,
            condition,
            update,
            body,
            loc: this.loc(startToken, this.current()),
        };
    }

    private parseDoWhile(): DoWhileNode {
        const startToken = this.current();
        this.consume(TokenType.DO, 'Expected do');
        const body = this.parseStatement();
        this.consume(TokenType.WHILE, 'Expected while');
        this.consume(TokenType.OPEN_PAREN, 'Expected (');
        const condition = this.parseExpression();
        this.consume(TokenType.CLOSE_PAREN, 'Expected )');
        this.consume(TokenType.SEMICOLON, 'Expected ;');

        return {
            kind: 'DoWhile',
            body,
            condition,
            loc: this.loc(startToken, this.current()),
        };
    }

    private parseSwitch(): SwitchNode {
        const startToken = this.current();
        this.consume(TokenType.SWITCH, 'Expected switch');
        this.consume(TokenType.OPEN_PAREN, 'Expected (');
        const expression = this.parseExpression();
        this.consume(TokenType.CLOSE_PAREN, 'Expected )');
        this.consume(TokenType.OPEN_BRACE, 'Expected {');

        const cases: CaseNode[] = [];
        while (!this.check(TokenType.CLOSE_BRACE) && !this.atEnd()) {
            cases.push(this.parseCase());
        }

        this.consume(TokenType.CLOSE_BRACE, 'Expected }');

        return {
            kind: 'Switch',
            expression,
            cases,
            loc: this.loc(startToken, this.current()),
        };
    }

    private parseCase(): CaseNode {
        const startToken = this.current();
        let value: ExpressionNode | null = null;

        if (this.match(TokenType.CASE)) {
            value = this.parseExpression();
        } else {
            this.consume(TokenType.DEFAULT, 'Expected case or default');
        }
        this.consume(TokenType.COLON, 'Expected :');

        const statements: StatementNode[] = [];
        while (!this.check(TokenType.CASE, TokenType.DEFAULT, TokenType.CLOSE_BRACE) && !this.atEnd()) {
            statements.push(this.parseStatement());
        }

        return {
            kind: 'Case',
            value,
            statements,
            loc: this.loc(startToken, this.current()),
        };
    }

    private parseReturn(): ReturnNode {
        const startToken = this.current();
        this.consume(TokenType.RETURN, 'Expected return');

        let value: ExpressionNode | null = null;
        if (!this.check(TokenType.SEMICOLON) && !this.atEnd() && this.canStartExpression()) {
            value = this.parseExpression();
        }
        this.consume(TokenType.SEMICOLON, 'Expected ;');

        return {
            kind: 'Return',
            value,
            loc: this.loc(startToken, this.current()),
        };
    }

    // =========================================================================
    // Expressions (Precedence Climbing)
    // =========================================================================

    private parseExpression(): ExpressionNode {
        return this.parseAssignment();
    }

    /**
     * Parse comma expression (sequence operator)
     * Used in expression statements where comma creates a sequence: a = 1, b = 2, c = 3;
     * Returns the last expression value (per C semantics)
     */
    private parseCommaExpression(): ExpressionNode {
        let expr = this.parseAssignment();

        while (this.match(TokenType.COMMA)) {
            const right = this.parseAssignment();
            // In GLSL/DCTL, comma expression evaluates all and returns last
            // We represent this as a binary expression with comma operator
            expr = {
                kind: 'BinaryExpression',
                operator: ',',
                left: expr,
                right,
                loc: this.loc(expr.loc as unknown as Token, this.current()),
            };
        }

        return expr;
    }

    private parseAssignment(): ExpressionNode {
        const expr = this.parseTernary();

        if (this.check(TokenType.ASSIGN, TokenType.PLUS_ASSIGN, TokenType.MINUS_ASSIGN,
            TokenType.TIMES_ASSIGN, TokenType.DIV_ASSIGN, TokenType.MOD_ASSIGN,
            TokenType.AND_ASSIGN, TokenType.OR_ASSIGN, TokenType.XOR_ASSIGN,
            TokenType.LEFT_SHIFT_ASSIGN, TokenType.RIGHT_SHIFT_ASSIGN)) {
            const operator = this.advance();
            const right = this.parseAssignment();
            return {
                kind: 'AssignmentExpression',
                operator: operator.value as string,
                left: expr,
                right,
                loc: this.loc(expr.loc as unknown as Token, this.current()),
            };
        }

        return expr;
    }

    private parseTernary(): ExpressionNode {
        let expr = this.parseOr();

        if (this.match(TokenType.QUESTION)) {
            const thenExpr = this.parseExpression();
            this.consume(TokenType.COLON, 'Expected :');
            // Use parseAssignment instead of parseTernary to allow assignments in else branch
            // This matches GCC behavior where `a ? b : c = d` is parsed as `a ? b : (c = d)`
            // rather than strict C standard `(a ? b : c) = d`
            const elseExpr = this.parseAssignment();
            return {
                kind: 'TernaryExpression',
                condition: expr,
                thenExpr,
                elseExpr,
                loc: this.loc(expr.loc as unknown as Token, this.current()),
            };
        }

        return expr;
    }

    private parseOr(): ExpressionNode {
        let left = this.parseAnd();

        while (this.match(TokenType.OR)) {
            const right = this.parseAnd();
            left = {
                kind: 'BinaryExpression',
                operator: '||',
                left,
                right,
                loc: this.loc(left.loc as unknown as Token, this.current()),
            };
        }

        return left;
    }

    private parseAnd(): ExpressionNode {
        let left = this.parseBitOr();

        while (this.match(TokenType.AND)) {
            const right = this.parseBitOr();
            left = {
                kind: 'BinaryExpression',
                operator: '&&',
                left,
                right,
                loc: this.loc(left.loc as unknown as Token, this.current()),
            };
        }

        return left;
    }

    private parseBitOr(): ExpressionNode {
        let left = this.parseBitXor();

        while (this.match(TokenType.BIT_OR)) {
            const right = this.parseBitXor();
            left = {
                kind: 'BinaryExpression',
                operator: '|',
                left,
                right,
                loc: this.loc(left.loc as unknown as Token, this.current()),
            };
        }

        return left;
    }

    private parseBitXor(): ExpressionNode {
        let left = this.parseBitAnd();

        while (this.match(TokenType.BIT_XOR)) {
            const right = this.parseBitAnd();
            left = {
                kind: 'BinaryExpression',
                operator: '^',
                left,
                right,
                loc: this.loc(left.loc as unknown as Token, this.current()),
            };
        }

        return left;
    }

    private parseBitAnd(): ExpressionNode {
        let left = this.parseEquality();

        while (this.match(TokenType.BIT_AND)) {
            const right = this.parseEquality();
            left = {
                kind: 'BinaryExpression',
                operator: '&',
                left,
                right,
                loc: this.loc(left.loc as unknown as Token, this.current()),
            };
        }

        return left;
    }

    private parseEquality(): ExpressionNode {
        let left = this.parseComparison();

        while (this.check(TokenType.EQUAL, TokenType.NOT_EQUAL)) {
            const op = this.advance();
            const right = this.parseComparison();
            left = {
                kind: 'BinaryExpression',
                operator: op.value as string,
                left,
                right,
                loc: this.loc(left.loc as unknown as Token, this.current()),
            };
        }

        return left;
    }

    private parseComparison(): ExpressionNode {
        let left = this.parseShift();

        while (this.check(TokenType.LESS, TokenType.LESS_EQUAL, TokenType.GREATER, TokenType.GREATER_EQUAL)) {
            const op = this.advance();
            const right = this.parseShift();
            left = {
                kind: 'BinaryExpression',
                operator: op.value as string,
                left,
                right,
                loc: this.loc(left.loc as unknown as Token, this.current()),
            };
        }

        return left;
    }

    private parseShift(): ExpressionNode {
        let left = this.parseAdditive();

        while (this.check(TokenType.LEFT_SHIFT, TokenType.RIGHT_SHIFT)) {
            const op = this.advance();
            const right = this.parseAdditive();
            left = {
                kind: 'BinaryExpression',
                operator: op.value as string,
                left,
                right,
                loc: this.loc(left.loc as unknown as Token, this.current()),
            };
        }

        return left;
    }

    private parseAdditive(): ExpressionNode {
        let left = this.parseMultiplicative();

        while (this.check(TokenType.PLUS, TokenType.MINUS)) {
            const op = this.advance();
            const right = this.parseMultiplicative();
            left = {
                kind: 'BinaryExpression',
                operator: op.value as string,
                left,
                right,
                loc: this.loc(left.loc as unknown as Token, this.current()),
            };
        }

        return left;
    }

    private parseMultiplicative(): ExpressionNode {
        let left = this.parseUnary();

        while (this.check(TokenType.TIMES, TokenType.DIV, TokenType.MOD)) {
            const op = this.advance();
            const right = this.parseUnary();
            left = {
                kind: 'BinaryExpression',
                operator: op.value as string,
                left,
                right,
                loc: this.loc(left.loc as unknown as Token, this.current()),
            };
        }

        return left;
    }

    private parseUnary(): ExpressionNode {
        // Standard unary operators: !, -, +, ~, ++, --
        if (this.check(TokenType.NOT, TokenType.MINUS, TokenType.PLUS, TokenType.BIT_NOT, TokenType.INCREMENT, TokenType.DECREMENT)) {
            const op = this.advance();
            const operand = this.parseUnary();
            return {
                kind: 'UnaryExpression',
                operator: op.value as string,
                operand,
                prefix: true,
                loc: this.loc(op, this.current()),
            };
        }

        // Pointer dereference: *expr
        if (this.check(TokenType.TIMES)) {
            const op = this.advance();
            const operand = this.parseUnary();
            return {
                kind: 'UnaryExpression',
                operator: '*',
                operand,
                prefix: true,
                loc: this.loc(op, this.current()),
            };
        }

        // Address-of: &expr
        if (this.check(TokenType.BIT_AND)) {
            const op = this.advance();
            const operand = this.parseUnary();
            return {
                kind: 'UnaryExpression',
                operator: '&',
                operand,
                prefix: true,
                loc: this.loc(op, this.current()),
            };
        }

        // sizeof expression: sizeof(type) or sizeof(expr) or sizeof expr
        if (this.check(TokenType.SIZEOF)) {
            const startToken = this.advance();

            if (this.match(TokenType.OPEN_PAREN)) {
                // sizeof(type) or sizeof(expr)
                // Try to parse as type first
                const savedPos = this.pos;
                const type = this.parseType();

                if (type && this.check(TokenType.CLOSE_PAREN)) {
                    this.advance(); // consume )
                    return {
                        kind: 'SizeofExpression',
                        operand: type,
                        loc: this.loc(startToken, this.current()),
                    } as SizeofExpressionNode;
                }

                // Not a type, restore and parse as expression
                this.pos = savedPos;
                const expr = this.parseExpression();
                this.consume(TokenType.CLOSE_PAREN, 'Expected )');
                return {
                    kind: 'SizeofExpression',
                    operand: expr,
                    loc: this.loc(startToken, this.current()),
                } as SizeofExpressionNode;
            } else {
                // sizeof expr (without parentheses)
                const operand = this.parseUnary();
                return {
                    kind: 'SizeofExpression',
                    operand,
                    loc: this.loc(startToken, this.current()),
                } as SizeofExpressionNode;
            }
        }

        // Cast expression: (type)expr
        // Need to distinguish from parenthesized expression like (variable)
        if (this.check(TokenType.OPEN_PAREN)) {
            const savedPos = this.pos;
            this.advance(); // consume '('

            // Check for cast:
            // 1. Type keyword: (float)x, (int)y
            // 2. Memory qualifier + type: (__PRIVATE__ rand_state*)&seed
            // 3. Identifier followed by * (pointer cast): (rand_state*)x - only for known types
            // 4. Known user-defined type: (MyStruct)x
            const hasMemoryQualifier = this.check(TokenType.__PRIVATE__, TokenType.__GLOBAL__, TokenType.__LOCAL__);
            const hasTypeKeyword = isTypeKeyword(this.current().type);
            // For identifier casts, we need to check if the identifier is a known type
            // This prevents treating (variable)*expr as a cast instead of multiplication
            const identifierName = this.check(TokenType.IDENTIFIER) ? this.current().value as string : '';
            const isKnownUserType = identifierName && this.isKnownType(identifierName);
            const isIdentifierCast = this.check(TokenType.IDENTIFIER) && (
                (this.peek().type === TokenType.TIMES && isKnownUserType) ||  // (type*) - only for known types
                (this.peek().type === TokenType.CLOSE_PAREN && isKnownUserType) // (type) - only for known types
            );

            if (hasTypeKeyword || hasMemoryQualifier || isIdentifierCast) {
                const type = this.parseType();
                if (type && this.match(TokenType.CLOSE_PAREN)) {
                    // After ), check if this looks like a cast target (expression start)
                    // If it's ;, ,, ), or binary operator, it's not a cast
                    if (this.canStartExpression()) {
                        const expr = this.parseUnary();
                        return {
                            kind: 'CastExpression',
                            type,
                            expression: expr,
                            loc: this.loc(this.tokens[savedPos], this.current()),
                        };
                    }
                }
            }
            // Not a cast, restore position
            this.pos = savedPos;
        }

        return this.parsePostfix();
    }

    private parsePostfix(): ExpressionNode {
        let expr = this.parsePrimary();

        while (true) {
            if (this.match(TokenType.OPEN_PAREN)) {
                // Function call
                const args = this.parseArgumentList();
                this.consume(TokenType.CLOSE_PAREN, 'Expected )');
                expr = {
                    kind: 'CallExpression',
                    callee: expr,
                    arguments: args,
                    loc: this.loc(expr.loc as unknown as Token, this.current()),
                };
            } else if (this.match(TokenType.OPEN_BRACKET)) {
                // Array index
                const index = this.parseExpression();
                this.consume(TokenType.CLOSE_BRACKET, 'Expected ]');
                expr = {
                    kind: 'IndexExpression',
                    object: expr,
                    index,
                    loc: this.loc(expr.loc as unknown as Token, this.current()),
                };
            } else if (this.check(TokenType.DOT, TokenType.ARROW)) {
                // Member access (both '.' and '->' for pointer members)
                const isArrow = this.current().type === TokenType.ARROW;
                this.advance(); // consume . or ->
                const property = this.consume(TokenType.IDENTIFIER, 'Expected property name');
                expr = {
                    kind: 'MemberExpression',
                    object: expr,
                    property: property.value as string,
                    isArrow,
                    loc: this.loc(expr.loc as unknown as Token, this.current()),
                };
            } else if (this.check(TokenType.INCREMENT, TokenType.DECREMENT)) {
                // Postfix ++/--
                const op = this.advance();
                expr = {
                    kind: 'UnaryExpression',
                    operator: op.value as string,
                    operand: expr,
                    prefix: false,
                    loc: this.loc(expr.loc as unknown as Token, this.current()),
                };
            } else {
                break;
            }
        }

        return expr;
    }

    private parseArgumentList(): ExpressionNode[] {
        const args: ExpressionNode[] = [];

        if (this.check(TokenType.CLOSE_PAREN)) {
            return args;
        }

        do {
            args.push(this.parseExpression());
        } while (this.match(TokenType.COMMA));

        return args;
    }

    private parsePrimary(): ExpressionNode {
        const token = this.current();

        // Literals
        if (this.match(TokenType.INT_LITERAL)) {
            return {
                kind: 'Literal',
                value: token.value as number,
                literalType: 'int',
                rawValue: token.rawValue,
                loc: this.loc(token),
            };
        }

        if (this.match(TokenType.UINT_LITERAL)) {
            return {
                kind: 'Literal',
                value: token.value as number,
                literalType: 'uint',
                rawValue: token.rawValue,
                loc: this.loc(token),
            };
        }

        if (this.match(TokenType.FLOAT_LITERAL)) {
            return {
                kind: 'Literal',
                value: token.value as number,
                literalType: 'float',
                hasFloatSuffix: token.hasFloatSuffix ?? false,
                rawValue: token.rawValue,
                loc: this.loc(token),
            };
        }

        if (this.match(TokenType.STRING_LITERAL)) {
            return {
                kind: 'Literal',
                value: token.value as string,
                literalType: 'string',
                loc: this.loc(token),
            };
        }

        if (this.match(TokenType.TRUE)) {
            return {
                kind: 'Literal',
                value: true,
                literalType: 'bool',
                loc: this.loc(token),
            };
        }

        if (this.match(TokenType.FALSE)) {
            return {
                kind: 'Literal',
                value: false,
                literalType: 'bool',
                loc: this.loc(token),
            };
        }

        // Identifier
        if (this.match(TokenType.IDENTIFIER)) {
            return {
                kind: 'Identifier',
                name: token.value as string,
                loc: this.loc(token),
            };
        }

        // GCC Statement Expression: ({ statement1; statement2; ...; expression; })
        // This is a GNU C extension where a compound statement can be used as an expression
        if (this.check(TokenType.OPEN_PAREN) && this.peek().type === TokenType.OPEN_BRACE) {
            const startToken = this.advance(); // consume '('
            this.advance(); // consume '{'

            const statements: StatementNode[] = [];
            let value: ExpressionNode | null = null;

            // Parse statements until we see '}'
            while (!this.check(TokenType.CLOSE_BRACE) && !this.atEnd()) {
                try {
                    statements.push(this.parseStatement());
                } catch (e) {
                    this.synchronize();
                }
            }

            this.consume(TokenType.CLOSE_BRACE, 'Expected }');
            this.consume(TokenType.CLOSE_PAREN, 'Expected )');

            // The value is the last expression statement's expression
            if (statements.length > 0) {
                const lastStatement = statements[statements.length - 1];
                if (lastStatement.kind === 'ExpressionStatement') {
                    value = (lastStatement as ExpressionStatementNode).expression;
                    // Remove it from statements since it's now the value
                    statements.pop();
                }
            }

            return {
                kind: 'StatementExpression',
                statements,
                value,
                loc: this.loc(startToken, this.current()),
            } as StatementExpressionNode;
        }

        // Parenthesized expression or initializer list
        // Use parseCommaExpression to support comma operator: (a, b, c)
        if (this.match(TokenType.OPEN_PAREN)) {
            const expr = this.parseCommaExpression();
            this.consume(TokenType.CLOSE_PAREN, 'Expected )');
            return expr;
        }

        // Initializer list { ... }
        if (this.match(TokenType.OPEN_BRACE)) {
            const elements: ExpressionNode[] = [];
            // Handle empty initializer list {}
            while (!this.check(TokenType.CLOSE_BRACE) && !this.atEnd()) {
                // Check for nested initializer list
                if (this.check(TokenType.OPEN_BRACE)) {
                    elements.push(this.parsePrimary());
                } else {
                    elements.push(this.parseExpression());
                }
                // If next is comma, consume it; if next is }, we're done
                if (!this.match(TokenType.COMMA)) {
                    break;
                }
                // Handle trailing comma: after consuming comma, if next is }, stop
            }
            this.consume(TokenType.CLOSE_BRACE, 'Expected }');
            return {
                kind: 'InitializerList',
                elements,
                loc: this.loc(token, this.current()),
            };
        }

        // Type constructors (make_float4, etc.)
        if (isTypeKeyword(token.type)) {
            this.advance();
            return {
                kind: 'Identifier',
                name: token.value as string,
                loc: this.loc(token),
            };
        }

        // Unknown token
        this.error('Expected expression');
        // If the token is a structural delimiter (closing brace/paren), don't consume it.
        // Throw to let error recovery (synchronize) handle the brace properly.
        if (this.check(TokenType.CLOSE_BRACE, TokenType.CLOSE_PAREN)) {
            throw new Error('Expected expression');
        }
        // For other tokens, advance to prevent infinite loop
        this.advance();
        return {
            kind: 'Identifier',
            name: '',
            loc: this.loc(token),
        };
    }

    /**
     * Check if the current token can start an expression
     * Used to distinguish cast expressions from parenthesized expressions
     */
    private canStartExpression(): boolean {
        const type = this.current().type;
        return (
            type === TokenType.IDENTIFIER ||
            type === TokenType.INT_LITERAL ||
            type === TokenType.UINT_LITERAL ||
            type === TokenType.FLOAT_LITERAL ||
            type === TokenType.STRING_LITERAL ||
            type === TokenType.TRUE ||
            type === TokenType.FALSE ||
            type === TokenType.OPEN_PAREN ||
            type === TokenType.OPEN_BRACE ||
            type === TokenType.MINUS ||
            type === TokenType.NOT ||
            type === TokenType.BIT_NOT ||
            type === TokenType.INCREMENT ||
            type === TokenType.DECREMENT ||
            type === TokenType.TIMES ||    // Pointer dereference: *(type)expr
            type === TokenType.BIT_AND ||  // Address-of: &expr
            isTypeKeyword(type)
        );
    }
}

/**
 * Parse DCTL source code
 */
export function parseDctl(source: string): ParseResult {
    const parser = new DctlParser();
    return parser.parse(source);
}
