# Changelog

## [0.3.0] - 2026-02-20

### Added

- Compound literal support: `(Type){expr1, expr2, ...}` syntax now compiles to WGSL (#32)
- `float2`/`float4` overloads for `dot`, `length`, `normalize` built-in functions (#22)
- Known Limitations section in VS Code extension README (#32)
- Known Limitations test suite for verifying compilation boundaries (#32)

### Fixed

- **EXR Viewer: DCTL files with `#include` now render correctly** — previously, `#include` directives were not resolved before compilation, causing "Unknown function" errors (#33)
- Bool-to-int coercion for return statements (#20)
- False `SEM002` errors for functions defined in `#include` headers (#21)
- Overload resolution now considers numeric type compatibility (#23)
- Element-wise built-in function registration priority (#24)
- Backslash continuation line mapping and false `SEM018` for shadowed UI params (#25)
- Multi-variable `for`-loop initializer support in Rust compiler (#26)
- `DCTL010` errors for 2D array parameter row access (#27, #28)
- `SEM_W001` variable shadowing warning line number mapping (#29)
- False `SEM009` when user code redefines built-in struct types (#30)

### Improved

- Unsupported DCTL syntax now produces descriptive error messages mentioning the specific limitation and WGSL constraint (#31)

## [0.2.0] - 2025-01-17

- Initial pre-release
