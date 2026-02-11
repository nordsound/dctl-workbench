/**
 * DCTL Scope Management
 *
 * Handles nested scopes for variable and symbol resolution.
 */

import type { Symbol } from './types.js';

/**
 * Scope represents a lexical scope containing symbols
 */
export class Scope {
    /** Symbols defined in this scope */
    private symbols: Map<string, Symbol> = new Map();

    /** Parent scope (null for global scope) */
    private _parent: Scope | null;

    /** Scope name for debugging */
    readonly name: string;

    /** Nesting depth */
    readonly depth: number;

    constructor(name: string, parent: Scope | null = null) {
        this.name = name;
        this._parent = parent;
        this.depth = parent ? parent.depth + 1 : 0;
    }

    /**
     * Get parent scope
     */
    get parent(): Scope | null {
        return this._parent;
    }

    /**
     * Define a new symbol in this scope
     *
     * @param symbol - Symbol to define
     * @returns true if successful, false if symbol already exists in this scope
     */
    define(symbol: Symbol): boolean {
        if (this.symbols.has(symbol.name)) {
            return false;
        }
        this.symbols.set(symbol.name, symbol);
        return true;
    }

    /**
     * Look up a symbol by name in this scope only
     *
     * @param name - Symbol name
     * @returns Symbol if found, undefined otherwise
     */
    lookupLocal(name: string): Symbol | undefined {
        return this.symbols.get(name);
    }

    /**
     * Look up a symbol by name, searching parent scopes
     *
     * @param name - Symbol name
     * @returns Symbol if found, undefined otherwise
     */
    lookup(name: string): Symbol | undefined {
        const local = this.symbols.get(name);
        if (local) {
            return local;
        }
        return this._parent?.lookup(name);
    }

    /**
     * Check if a symbol is defined in this scope only
     */
    hasLocal(name: string): boolean {
        return this.symbols.has(name);
    }

    /**
     * Check if a symbol is defined in this scope or any parent scope
     */
    has(name: string): boolean {
        if (this.symbols.has(name)) {
            return true;
        }
        return this._parent?.has(name) ?? false;
    }

    /**
     * Get all symbols defined in this scope
     */
    getAllSymbols(): Symbol[] {
        return Array.from(this.symbols.values());
    }

    /**
     * Get all symbol names in this scope
     */
    getSymbolNames(): string[] {
        return Array.from(this.symbols.keys());
    }

    /**
     * Check if this is the global scope
     */
    isGlobal(): boolean {
        return this._parent === null;
    }

    /**
     * Get the global scope
     */
    getGlobalScope(): Scope {
        let scope: Scope = this;
        while (scope._parent !== null) {
            scope = scope._parent;
        }
        return scope;
    }

    /**
     * Get a string representation for debugging
     */
    toString(): string {
        const symbols = this.getSymbolNames().join(', ');
        return `Scope(${this.name}, depth=${this.depth}, symbols=[${symbols}])`;
    }
}

/**
 * Scope manager for tracking current scope during analysis
 */
export class ScopeManager {
    private globalScope: Scope;
    private currentScope: Scope;
    private scopeStack: Scope[] = [];

    constructor() {
        this.globalScope = new Scope('global');
        this.currentScope = this.globalScope;
        this.scopeStack.push(this.globalScope);
    }

    /**
     * Enter a new scope
     *
     * @param name - Name of the new scope
     * @returns The new scope
     */
    enterScope(name: string): Scope {
        const newScope = new Scope(name, this.currentScope);
        this.currentScope = newScope;
        this.scopeStack.push(newScope);
        return newScope;
    }

    /**
     * Exit the current scope
     *
     * @returns The scope that was exited, or null if at global scope
     */
    exitScope(): Scope | null {
        if (this.currentScope === this.globalScope) {
            return null;
        }

        const exitedScope = this.currentScope;
        this.scopeStack.pop();
        this.currentScope = this.currentScope.parent ?? this.globalScope;
        return exitedScope;
    }

    /**
     * Get the current scope
     */
    getCurrentScope(): Scope {
        return this.currentScope;
    }

    /**
     * Get the global scope
     */
    getGlobalScope(): Scope {
        return this.globalScope;
    }

    /**
     * Define a symbol in the current scope
     */
    define(symbol: Symbol): boolean {
        return this.currentScope.define(symbol);
    }

    /**
     * Define a symbol in the global scope
     */
    defineGlobal(symbol: Symbol): boolean {
        return this.globalScope.define(symbol);
    }

    /**
     * Look up a symbol starting from current scope
     */
    lookup(name: string): Symbol | undefined {
        return this.currentScope.lookup(name);
    }

    /**
     * Look up a symbol in current scope only
     */
    lookupLocal(name: string): Symbol | undefined {
        return this.currentScope.lookupLocal(name);
    }

    /**
     * Look up a symbol in global scope only
     */
    lookupGlobal(name: string): Symbol | undefined {
        return this.globalScope.lookupLocal(name);
    }

    /**
     * Get current scope depth
     */
    getDepth(): number {
        return this.currentScope.depth;
    }

    /**
     * Check if currently in global scope
     */
    isAtGlobalScope(): boolean {
        return this.currentScope === this.globalScope;
    }

    /**
     * Reset to initial state
     */
    reset(): void {
        this.globalScope = new Scope('global');
        this.currentScope = this.globalScope;
        this.scopeStack = [this.globalScope];
    }
}
