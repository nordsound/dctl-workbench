# DCTL Workbench

> **Pre-Release** — This extension is currently in pre-release. Features and APIs may change. Bug reports and feedback are welcome on [GitHub](https://github.com/nordsound/dctl-workbench/issues).

A Visual Studio Code extension for developing DaVinci Color Transform Language (DCTL) shaders with real-time EXR preview.

![VS Code](https://img.shields.io/badge/VS%20Code-1.109%2B-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Pre--Release](https://img.shields.io/badge/status-pre--release-orange)

![DCTL Editor](https://raw.githubusercontent.com/nordsound/dctl-workbench/main/images/DCTL_editor.png)

## Features

### DCTL Language Support

- **Syntax Highlighting** — Full TextMate grammar for DCTL keywords, types, macros, intrinsics, and preprocessor directives
- **Real-time Diagnostics** — Syntax errors and warnings as you type, powered by a native DCTL parser
- **IntelliSense** — Auto-completion for 60+ DCTL functions and keywords with documentation
- **Hover Documentation** — Function signatures, parameter types, return values, and code examples on hover
- **40+ Code Snippets** — Transform entry points, UI controls, math operations, color space conversions, and more

### EXR Viewer

Built-in custom editor for OpenEXR files with DCTL integration:

- **DCTL Live Preview** — Apply DCTL shaders to EXR images in real time
- **Auto Preview** — Automatically updates the preview when you edit a DCTL file
- **ACES Color Pipeline** — Working color spaces: ACES2065-1, ACEScg, Linear sRGB, Linear Rec.2020
- **Reference Gamut Compression** — ACES 2.0 RGC with configurable peak luminance
- **GPU Accelerated** — WebGPU rendering with WebGL2 and CPU fallbacks
- **EXR Export** — Export processed images with configurable compression (ZIP, PIZ, RLE, ZIPS, NONE)
- **UI Parameter Controls** — Automatically generates sliders, checkboxes, and dropdowns from `DEFINE_UI_PARAMS`

### DaVinci Resolve Integration

- **Copy to Resolve** — One-click copy of DCTL files to DaVinci Resolve's LUT/DCTL directory
- **Cross-platform** — Auto-detects Resolve's DCTL directory on macOS, Windows, and Linux

## Snippets

Quickly scaffold common DCTL patterns:

| Prefix | Description |
|--------|-------------|
| `transform` | Transform entry point (float3/float4) |
| `ui-slider-float` | UI Slider Float parameter |
| `ui-combo` | UI Combo Box parameter |
| `ui-checkbox` | UI Checkbox parameter |
| `ui-color` | UI Color Picker (Resolve 19.1+) |
| `rgb-to-hsv` | RGB to HSV conversion |
| `logc3-to-linear` | ARRI LogC3 to Linear conversion |
| `lut` | LUT definition and application |

Type `dctl` in a `.dctl` file to see all available snippets.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `dctlWorkbench.dctl.autoPreview` | `true` | Auto-update preview on DCTL changes |
| `dctlWorkbench.dctl.previewDebounceMs` | `300` | Debounce time for auto-preview (ms) |
| `dctlWorkbench.colorSpace.working` | `ACES2065-1` | Working color space |
| `dctlWorkbench.colorSpace.display` | `sRGB` | Display color space |
| `dctlWorkbench.preview.renderer` | `auto` | Renderer: auto, webgpu, webgl2, or cpu |
| `dctlWorkbench.export.exrCompression` | `ZIP` | EXR export compression method |
| `dctlWorkbench.diagnostics.enabled` | `true` | Enable DCTL syntax checking |
| `dctlWorkbench.resolve.dctlDirectory` | *(empty)* | Custom path to Resolve DCTL directory |

## Commands

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and search for:

- **DCTL Workbench: Preview in EXR Viewer** — Load the current DCTL into an EXR viewer
- **DCTL Workbench: Copy to DaVinci Resolve** — Copy the current DCTL file to Resolve's DCTL directory

Both commands are also available as toolbar buttons when editing `.dctl` files.

## Requirements

- VS Code 1.109 or later
- For GPU-accelerated preview: a browser engine with WebGPU support (falls back to WebGL2/CPU automatically)

## License

MIT
