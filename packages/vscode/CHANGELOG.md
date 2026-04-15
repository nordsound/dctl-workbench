# Changelog

## [0.4.0] - 2026-04-15 (unreleased)

### Added

- **Plugin API 0.4.0 — `DctlWorkbenchApi.extensionUri` + `renderImage`** (T013).
  Plugin extensions can now host their own `customEditor` contributions
  and reuse the host's renderer by calling
  `api.renderImage(panel, uri, plugin)` from inside their own
  `resolveCustomEditor`. `api.extensionUri` returns the host extension's
  install directory so the plugin can include it in the panel's
  `localResourceRoots` at creation time (VS Code freezes resource roots
  after the panel is created — they can't be set post-hoc by the host).
  This replaces the T011 `vscode.openWith` redirect proxy, eliminating
  the placeholder-tab / twin-tab class of bugs without moving RAW file
  selectors into the host manifest (which would regress native fallback
  when the plugin isn't installed).
- **Plugin API 0.3.0 — `DecodedImage.preTransformMatrix`**. InputPlugins
  can now return an optional row-major 3×3 matrix that the host applies
  to each pixel's RGB channels before the OCIO display transform runs.
  Enables plugins to land pixels in ACES2065-1 via a single matrix
  multiply (e.g. DNG `ForwardMatrix` × `diag(1/AsShotNeutral)` ×
  `XYZ_D50→AP0`). When the field is omitted, the pre-transform is a
  no-op and pre-0.3.0 plugin behavior is unchanged.
- **WebGPU compute pre-pass** for `preTransformMatrix`. A compute
  shader applies the plugin-supplied 3×3 matrix to RGB (alpha
  preserved), writes into an rgba32float intermediate, and the
  existing OCIO shader chain samples from the transformed output
  without further changes. Pipeline + uniform buffer are cached for
  the webview's lifetime; only the output texture is fresh per load.
- **WebGL2 render-to-texture fallback** for the same transform. An
  ESSL 3.0 vertex + fragment shader pair renders a full-screen quad
  into an RGBA32F FBO attachment; the matrix is uploaded via
  `uniformMatrix3fv(loc, false, <column-major 9 floats>)`. The default
  framebuffer is restored after the pass.
- **Color-space helpers in `@dctl-workbench/core`**. New
  `M_XYZ_D50_TO_AP0` / `M_AP0_TO_XYZ_D50` Bradford-adapted matrices and
  `M_SRGB_TO_AP0` / `M_AP0_TO_SRGB` live under
  `packages/core/src/color-space/` so plugins and the host can share
  them.

### Changed

- `InputPlugin` and `DecodedImage` now live in the bumped
  `PLUGIN_API_VERSION = '0.3.0'`. The previous 0.2.x consumers remain
  backward-compatible — no field was removed or changed in its type,
  and `preTransformMatrix` is optional.

### Known limitations

- Using `preTransformMatrix` under Tier 1 (WebGPU + `rgba16unorm`)
  allocates an rgba32float intermediate texture for the compute pass.
  For a 24 MP image this is ~384 MB of GPU memory, 2× the Tier 1
  baseline. Plugins that don't need a pre-transform should leave the
  field unset to avoid the cost.
- The WebGL2 fallback is currently validated at the API-sequence level
  only (mock WebGL2 + structural shader tests); there's no headless
  GPU readback coverage. Real-GPU verification is deferred to manual
  smoke testing.
- Tier 2 Extension Host tests that exercise the real Dawn WebGPU
  backend still exit with code 6 on shutdown because of a missing
  destroy API in the `webgpu` npm package. The integration runner
  script (`scripts/run-integration-tests.sh`) absorbs this when all
  mocha tests pass.

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
