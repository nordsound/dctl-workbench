# Contributing to DCTL Workbench

Thank you for your interest in contributing to DCTL Workbench!

## Development Setup

### Prerequisites

Install the required tools:

- **Node.js** (v18+)
- **Rust** (latest stable)
- **Emscripten** - Installed automatically via `npm run setup:deps`
- **GitHub CLI** (optional, for dependency checks)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/your-org/dctl-workbench.git
cd dctl-workbench

# Install dependencies
npm install

# Setup external C/C++ dependencies
npm run setup:deps

# Build all packages
npm run build
```

### Running the VS Code Extension

1. Open the project in VS Code
2. Press `F5` to launch the Extension Development Host
3. The extension will be active in the new window

## Project Structure

```text
dctl-workbench/
├── packages/
│   ├── core/       # Core runtime library
│   ├── cli/        # CLI tool
│   └── vscode/     # VS Code extension
├── native/         # Native WASM build sources
│   ├── openexr-wasm/
│   └── ocio-wasm/
├── rust/           # Rust WASM compiler
├── wasm/           # Built WASM modules
├── deps/           # External C/C++ dependencies (git-ignored)
└── scripts/        # Build and utility scripts
```

## Development Workflow

### Building

```bash
# Full build
npm run build

# Individual packages
npm run build:core
npm run build:cli
npm run build:vscode
npm run build:wasm
```

### Testing

```bash
# Run all tests
npm test

# Run specific package tests
cd packages/core && npm test
cd packages/cli && npm test
cd packages/vscode && npm test
```

### Code Style

- Use TypeScript for all new code
- Follow existing code patterns and conventions
- Run linting before committing

## Pull Request Process

1. Create a feature branch from `master`
2. Make your changes with clear, focused commits
3. Ensure all tests pass
4. Submit a pull request with a clear description

## Commit Messages

Keep commit messages simple and concise:

- Use imperative mood ("Add feature" not "Added feature")
- Keep the first line under 72 characters
- No signatures or co-authored-by lines

## Reporting Issues

When reporting bugs, please include:

- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, VS Code version)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
