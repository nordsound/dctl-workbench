# Changelog

All notable changes to the DCTL Workbench project will be documented in this file.

## [Unreleased]

### Added
- CLI `check` command for validating DCTL files from the command line (#10)
- Bool arithmetic promotion: C-style `x *= (a > 0)` now compiles to WGSL via `select()` (#11)
- Global pointer address space coercion: `&global_var` passed to `ptr<function, T>` params now auto-copies between address spaces (#11)
- `pointer_expression` handler for tree-sitter `&expr` nodes (#11)
- String literal initialization for char arrays: `char s[] = "hello"` (#8)
- Array parameter comparison codegen (`==`, `!=` for array params) (#9)

### Fixed
- Naga validation `ArgumentType` error when passing pointer to global variable to function parameter (#11)
- `InvalidBinaryOperandTypes` error for bool in arithmetic expressions (#11)
- Compile error handling in `compileWithTsParser` — no longer crashes on WASM error result (#10)
- Array parameter parsing for comparison operators (#9)
- Typedef struct parsing and semantic overload resolution (#7)

## [0.1.3] - 2025-01-29

### Added
- Document-aware auto-completion for user-defined variables, functions, and struct members (#3)
- Hover information showing function signatures and variable types (#3)
- Semantic warnings for unused variables (`SEM_W002`) and unused functions (`SEM_W003`) in VS Code diagnostics (#4)
- Semantic warning integration tests with lineOffset correction (#6)
- Code examples added to all DCTL builtin function documentation (#2)

### Fixed
- Naga validation diagnostic line number mapping (#5)
- lineOffset off-by-one error in semantic warning line mapping (#6)
- False positive diagnostics from function overloading suppressed (#6)

## [0.1.2] - 2025-01-22

### Added
- DCTL editor screenshot in READMEs
- GitHub Actions CI workflows

## [0.1.1] - 2025-01-21

### Added
- VS Code extension README for Marketplace

## [0.1.0] - 2025-01-21

### Added
- Initial release
- DCTL syntax highlighting and language support
- DCTL to WGSL compilation via Rust/WASM backend
- Real-time diagnostics (parse errors, semantic errors, Naga validation)
- EXR image viewer with WebGPU rendering
- DCTL shader preview with live parameter editing
- ACES color pipeline support (AP0/AP1/ACEScct working spaces)
- RGC (Reference Gamut Compression) integration via OpenColorIO
- Builtin function documentation and completion
- CLI tool for batch compilation and validation
