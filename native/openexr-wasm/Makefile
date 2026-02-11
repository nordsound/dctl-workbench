# OpenEXR WASM Build Makefile
#
# Prerequisites:
#   - Emscripten SDK installed and activated
#   - deps/openexr and deps/Imath cloned
#
# Usage:
#   make        # Build WASM
#   make clean  # Clean build artifacts
#   make install # Copy to wasm/ directory

.PHONY: all clean install

BUILD_DIR = build
DIST_DIR = ../../wasm
SRC_DIR = src

all: $(BUILD_DIR)/openexr.js

$(BUILD_DIR)/openexr.js: $(SRC_DIR)/openexr_wasm.c $(SRC_DIR)/ht_stubs.c
	@echo "Building OpenEXR WASM..."
	@mkdir -p $(BUILD_DIR)
	@cd $(BUILD_DIR) && emcmake cmake .. && emmake make
	@echo "Build complete: $(BUILD_DIR)/openexr.js"

install: $(BUILD_DIR)/openexr.js
	@echo "Installing to $(DIST_DIR)..."
	@mkdir -p $(DIST_DIR)
	@cp $(BUILD_DIR)/openexr.js $(DIST_DIR)/
	@cp $(BUILD_DIR)/openexr.wasm $(DIST_DIR)/
	@cp $(SRC_DIR)/openexr_wasm.d.ts $(DIST_DIR)/
	@echo "Installed:"
	@ls -la $(DIST_DIR)/openexr.*

clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(BUILD_DIR)
	@echo "Clean complete"

# Development targets
rebuild: clean all

check-deps:
	@echo "Checking dependencies..."
	@test -d ../../deps/openexr || (echo "ERROR: deps/openexr not found" && exit 1)
	@test -d ../../deps/Imath || (echo "ERROR: deps/Imath not found" && exit 1)
	@which emcc > /dev/null || (echo "ERROR: Emscripten not found" && exit 1)
	@echo "All dependencies OK"
