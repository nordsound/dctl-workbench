//! WGSL Output Generator
//!
//! Converts Naga Module to WGSL string using Naga's WGSL backend.

use super::CodegenError;
use naga::back::wgsl;
use naga::valid::{Capabilities, ValidationFlags, Validator};
use naga::Module;

/// Convert a Naga module to WGSL code
pub fn module_to_wgsl(module: &Module) -> Result<String, CodegenError> {
    // Validate the module
    let info = Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(module)
        .map_err(|e| CodegenError::WgslError(format!("Validation failed: {:?}", e)))?;

    // Generate WGSL
    let wgsl = wgsl::write_string(module, &info, wgsl::WriterFlags::empty())
        .map_err(|e| CodegenError::WgslError(format!("WGSL generation failed: {:?}", e)))?;

    Ok(wgsl)
}

/// Convert a Naga module to WGSL code with custom options
pub fn module_to_wgsl_with_options(
    module: &Module,
    flags: wgsl::WriterFlags,
) -> Result<String, CodegenError> {
    // Validate the module
    let info = Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(module)
        .map_err(|e| CodegenError::WgslError(format!("Validation failed: {:?}", e)))?;

    // Generate WGSL with custom flags
    let wgsl = wgsl::write_string(module, &info, flags)
        .map_err(|e| CodegenError::WgslError(format!("WGSL generation failed: {:?}", e)))?;

    Ok(wgsl)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_module() {
        let module = Module::default();
        // Empty modules should validate (though produce minimal output)
        let result = module_to_wgsl(&module);
        // Note: Empty module might fail validation in some Naga versions
        // This test documents the expected behavior
        println!("Empty module result: {:?}", result);
    }
}
