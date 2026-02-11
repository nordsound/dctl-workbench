#!/bin/bash
# Rust code coverage using cargo-tarpaulin
# Usage: ./scripts/rust-coverage.sh [--install]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUST_DIR="$PROJECT_ROOT/rust"

cd "$RUST_DIR"

# Check if tarpaulin is installed
if ! command -v cargo-tarpaulin &> /dev/null; then
    if [ "$1" == "--install" ]; then
        echo "Installing cargo-tarpaulin..."
        cargo install cargo-tarpaulin
    else
        echo "Error: cargo-tarpaulin is not installed."
        echo "Run with --install to install it, or install manually:"
        echo "  cargo install cargo-tarpaulin"
        exit 1
    fi
fi

echo "=== Running Rust Code Coverage ==="
echo "Working directory: $RUST_DIR"
echo ""

# Run tarpaulin with config
cargo tarpaulin --config tarpaulin.toml

echo ""
echo "=== Coverage Report Generated ==="
echo "HTML report: $RUST_DIR/coverage/tarpaulin-report.html"
echo "LCOV report: $RUST_DIR/coverage/lcov.info"
