//! Type handling for DCTL to Naga code generation
//!
//! Handles type registration, conversion, and utility functions for type manipulation.

use super::naga_module::{FunctionContext, NagaModuleGenerator};
use super::CodegenError;
use crate::parser::{BaseType, Expression, Type};
use crate::semantic::{DctlType, ScalarType};
use naga::{
    AddressSpace, Expression as NagaExpr, Handle, Scalar, Span, Type as NagaType, TypeInner,
};
use std::collections::HashMap;
use std::num::NonZeroU32;

impl NagaModuleGenerator {
    /// Extract the innermost (base) element type from a possibly nested Array type.
    /// e.g., Array(Array(Int, 10), 256) -> Int
    /// e.g., Array(Float, 10) -> Float
    pub(super) fn extract_base_element_type(dctl_type: &DctlType) -> DctlType {
        match dctl_type {
            DctlType::Array(inner, _) => Self::extract_base_element_type(inner),
            other => other.clone(),
        }
    }

    /// Register built-in types in the Naga module
    pub(super) fn register_builtin_types(&mut self) {
        // Scalar types
        self.register_type(
            "bool",
            NagaType {
                name: Some("bool".into()),
                inner: TypeInner::Scalar(Scalar::BOOL),
            },
        );
        self.register_type(
            "i32",
            NagaType {
                name: Some("i32".into()),
                inner: TypeInner::Scalar(Scalar::I32),
            },
        );
        self.register_type(
            "u32",
            NagaType {
                name: Some("u32".into()),
                inner: TypeInner::Scalar(Scalar::U32),
            },
        );
        self.register_type(
            "f32",
            NagaType {
                name: Some("f32".into()),
                inner: TypeInner::Scalar(Scalar::F32),
            },
        );

        // Vector types (f32)
        self.register_type(
            "vec2<f32>",
            NagaType {
                name: Some("vec2<f32>".into()),
                inner: TypeInner::Vector {
                    size: naga::VectorSize::Bi,
                    scalar: Scalar::F32,
                },
            },
        );
        self.register_type(
            "vec3<f32>",
            NagaType {
                name: Some("vec3<f32>".into()),
                inner: TypeInner::Vector {
                    size: naga::VectorSize::Tri,
                    scalar: Scalar::F32,
                },
            },
        );
        self.register_type(
            "vec4<f32>",
            NagaType {
                name: Some("vec4<f32>".into()),
                inner: TypeInner::Vector {
                    size: naga::VectorSize::Quad,
                    scalar: Scalar::F32,
                },
            },
        );

        // Vector types (i32)
        self.register_type(
            "vec2<i32>",
            NagaType {
                name: Some("vec2<i32>".into()),
                inner: TypeInner::Vector {
                    size: naga::VectorSize::Bi,
                    scalar: Scalar::I32,
                },
            },
        );
        self.register_type(
            "vec3<i32>",
            NagaType {
                name: Some("vec3<i32>".into()),
                inner: TypeInner::Vector {
                    size: naga::VectorSize::Tri,
                    scalar: Scalar::I32,
                },
            },
        );
        self.register_type(
            "vec4<i32>",
            NagaType {
                name: Some("vec4<i32>".into()),
                inner: TypeInner::Vector {
                    size: naga::VectorSize::Quad,
                    scalar: Scalar::I32,
                },
            },
        );

        // Vector types (u32)
        self.register_type(
            "vec2<u32>",
            NagaType {
                name: Some("vec2<u32>".into()),
                inner: TypeInner::Vector {
                    size: naga::VectorSize::Bi,
                    scalar: Scalar::U32,
                },
            },
        );
        self.register_type(
            "vec3<u32>",
            NagaType {
                name: Some("vec3<u32>".into()),
                inner: TypeInner::Vector {
                    size: naga::VectorSize::Tri,
                    scalar: Scalar::U32,
                },
            },
        );
        self.register_type(
            "vec4<u32>",
            NagaType {
                name: Some("vec4<u32>".into()),
                inner: TypeInner::Vector {
                    size: naga::VectorSize::Quad,
                    scalar: Scalar::U32,
                },
            },
        );

        // Matrix types
        self.register_type(
            "mat2x2<f32>",
            NagaType {
                name: Some("mat2x2<f32>".into()),
                inner: TypeInner::Matrix {
                    columns: naga::VectorSize::Bi,
                    rows: naga::VectorSize::Bi,
                    scalar: Scalar::F32,
                },
            },
        );
        self.register_type(
            "mat3x3<f32>",
            NagaType {
                name: Some("mat3x3<f32>".into()),
                inner: TypeInner::Matrix {
                    columns: naga::VectorSize::Tri,
                    rows: naga::VectorSize::Tri,
                    scalar: Scalar::F32,
                },
            },
        );
        self.register_type(
            "mat4x4<f32>",
            NagaType {
                name: Some("mat4x4<f32>".into()),
                inner: TypeInner::Matrix {
                    columns: naga::VectorSize::Quad,
                    rows: naga::VectorSize::Quad,
                    scalar: Scalar::F32,
                },
            },
        );

        // Register matrix "row members" for DCTL-style row access (mat.r0, mat.r1, etc.)
        // Note: WGSL matrices are column-major, so mat[0] gives first column.
        // We map DCTL row access to column access for convenience.
        // This is semantically different but works for many use cases.
        let mut mat2_members = HashMap::new();
        mat2_members.insert("r0".to_string(), 0);
        mat2_members.insert("r1".to_string(), 1);
        // Also support DCTL struct-style access: mat.x, mat.y
        mat2_members.insert("x".to_string(), 0);
        mat2_members.insert("y".to_string(), 1);
        self.struct_members.insert("mat2".to_string(), mat2_members);

        let mut mat3_members = HashMap::new();
        mat3_members.insert("r0".to_string(), 0);
        mat3_members.insert("r1".to_string(), 1);
        mat3_members.insert("r2".to_string(), 2);
        // Also support DCTL struct-style access: mat.x, mat.y, mat.z
        mat3_members.insert("x".to_string(), 0);
        mat3_members.insert("y".to_string(), 1);
        mat3_members.insert("z".to_string(), 2);
        self.struct_members.insert("mat3".to_string(), mat3_members);

        let mut mat4_members = HashMap::new();
        mat4_members.insert("r0".to_string(), 0);
        mat4_members.insert("r1".to_string(), 1);
        mat4_members.insert("r2".to_string(), 2);
        mat4_members.insert("r3".to_string(), 3);
        // Also support DCTL struct-style access: mat.x, mat.y, mat.z, mat.w
        mat4_members.insert("x".to_string(), 0);
        mat4_members.insert("y".to_string(), 1);
        mat4_members.insert("z".to_string(), 2);
        mat4_members.insert("w".to_string(), 3);
        self.struct_members.insert("mat4".to_string(), mat4_members);
    }

    /// Register a type in the module
    pub(super) fn register_type(&mut self, name: &str, naga_type: NagaType) -> Handle<NagaType> {
        let handle = self.module.types.insert(naga_type, Span::UNDEFINED);
        self.type_handles.insert(name.to_string(), handle);
        handle
    }

    /// Get or create a Naga type handle for a DCTL type
    pub(super) fn get_or_create_type(&mut self, dctl_type: &DctlType) -> Handle<NagaType> {
        let type_name = self.dctl_type_to_wgsl_name(dctl_type);

        if let Some(&handle) = self.type_handles.get(&type_name) {
            return handle;
        }

        let naga_type = self.create_naga_type(dctl_type);
        self.register_type(&type_name, naga_type)
    }

    /// Convert DCTL type to WGSL type name
    pub(super) fn dctl_type_to_wgsl_name(&self, dctl_type: &DctlType) -> String {
        match dctl_type {
            DctlType::Void => "void".to_string(),
            DctlType::Bool => "bool".to_string(),
            DctlType::Int | DctlType::Char => "i32".to_string(),
            DctlType::UInt => "u32".to_string(),
            DctlType::Float | DctlType::Double | DctlType::Half => "f32".to_string(),
            DctlType::Vec2(ScalarType::Float) | DctlType::Vec2(ScalarType::Half) => {
                "vec2<f32>".to_string()
            }
            DctlType::Vec3(ScalarType::Float) | DctlType::Vec3(ScalarType::Half) => {
                "vec3<f32>".to_string()
            }
            DctlType::Vec4(ScalarType::Float) | DctlType::Vec4(ScalarType::Half) => {
                "vec4<f32>".to_string()
            }
            DctlType::Vec2(ScalarType::Int) => "vec2<i32>".to_string(),
            DctlType::Vec3(ScalarType::Int) => "vec3<i32>".to_string(),
            DctlType::Vec4(ScalarType::Int) => "vec4<i32>".to_string(),
            DctlType::Vec2(ScalarType::UInt) => "vec2<u32>".to_string(),
            DctlType::Vec3(ScalarType::UInt) => "vec3<u32>".to_string(),
            DctlType::Vec4(ScalarType::UInt) => "vec4<u32>".to_string(),
            DctlType::Vec2(ScalarType::Bool) => "vec2<bool>".to_string(),
            DctlType::Vec3(ScalarType::Bool) => "vec3<bool>".to_string(),
            DctlType::Vec4(ScalarType::Bool) => "vec4<bool>".to_string(),
            DctlType::Mat2 => "mat2x2<f32>".to_string(),
            DctlType::Mat3 => "mat3x3<f32>".to_string(),
            DctlType::Mat4 => "mat4x4<f32>".to_string(),
            DctlType::Array(inner, Some(size)) => {
                format!("array<{}, {}>", self.dctl_type_to_wgsl_name(inner), size)
            }
            DctlType::Array(inner, None) => {
                format!("array<{}>", self.dctl_type_to_wgsl_name(inner))
            }
            DctlType::Struct(name) => name.clone(),
            DctlType::Pointer(inner) => {
                format!("ptr<function, {}>", self.dctl_type_to_wgsl_name(inner))
            }
            DctlType::Texture2D => "texture_2d<f32>".to_string(),
            DctlType::Texture3D => "texture_3d<f32>".to_string(),
            DctlType::Sampler => "sampler".to_string(),
            DctlType::Function { .. } => "<function>".to_string(),
            DctlType::Unknown => "<unknown>".to_string(),
        }
    }

    /// Create a Naga type from DCTL type
    pub(super) fn create_naga_type(&mut self, dctl_type: &DctlType) -> NagaType {
        let inner = match dctl_type {
            DctlType::Void => TypeInner::Scalar(Scalar::U32), // WGSL doesn't have void
            DctlType::Bool => TypeInner::Scalar(Scalar::BOOL),
            DctlType::Int | DctlType::Char => TypeInner::Scalar(Scalar::I32),
            DctlType::UInt => TypeInner::Scalar(Scalar::U32),
            DctlType::Float | DctlType::Double | DctlType::Half => TypeInner::Scalar(Scalar::F32),
            DctlType::Vec2(scalar) => TypeInner::Vector {
                size: naga::VectorSize::Bi,
                scalar: self.scalar_type_to_naga(*scalar),
            },
            DctlType::Vec3(scalar) => TypeInner::Vector {
                size: naga::VectorSize::Tri,
                scalar: self.scalar_type_to_naga(*scalar),
            },
            DctlType::Vec4(scalar) => TypeInner::Vector {
                size: naga::VectorSize::Quad,
                scalar: self.scalar_type_to_naga(*scalar),
            },
            DctlType::Mat2 => TypeInner::Matrix {
                columns: naga::VectorSize::Bi,
                rows: naga::VectorSize::Bi,
                scalar: Scalar::F32,
            },
            DctlType::Mat3 => TypeInner::Matrix {
                columns: naga::VectorSize::Tri,
                rows: naga::VectorSize::Tri,
                scalar: Scalar::F32,
            },
            DctlType::Mat4 => TypeInner::Matrix {
                columns: naga::VectorSize::Quad,
                rows: naga::VectorSize::Quad,
                scalar: Scalar::F32,
            },
            DctlType::Array(inner, size) => {
                let inner_handle = self.get_or_create_type(inner);
                TypeInner::Array {
                    base: inner_handle,
                    size: match size {
                        Some(n) => {
                            // Array size as NonZeroU32
                            naga::ArraySize::Constant(NonZeroU32::new(*n as u32).unwrap_or(NonZeroU32::new(1).unwrap()))
                        }
                        None => naga::ArraySize::Dynamic,
                    },
                    stride: 0, // Will be calculated
                }
            }
            DctlType::Struct(name) => {
                // Look up existing struct type
                if let Some(&handle) = self.type_handles.get(name) {
                    return self.module.types[handle].clone();
                }
                // Create placeholder if not found
                TypeInner::Struct {
                    members: vec![],
                    span: 0,
                }
            }
            DctlType::Pointer(inner) => {
                // Create pointer type - if inner is already an array (from analysis), use that directly
                // If inner is a scalar, keep as scalar pointer (for dereference-only usage)
                // Array pointer conversion is now done in generate_function based on indexing analysis
                let inner_handle = self.get_or_create_type(inner);
                TypeInner::Pointer {
                    base: inner_handle,
                    space: AddressSpace::Function,
                }
            }
            DctlType::Texture2D => TypeInner::Image {
                dim: naga::ImageDimension::D2,
                arrayed: false,
                class: naga::ImageClass::Sampled {
                    kind: naga::ScalarKind::Float,
                    multi: false,
                },
            },
            DctlType::Texture3D => TypeInner::Image {
                dim: naga::ImageDimension::D3,
                arrayed: false,
                class: naga::ImageClass::Sampled {
                    kind: naga::ScalarKind::Float,
                    multi: false,
                },
            },
            DctlType::Sampler => TypeInner::Sampler { comparison: false },
            _ => TypeInner::Scalar(Scalar::F32), // Default fallback
        };

        NagaType {
            name: Some(self.dctl_type_to_wgsl_name(dctl_type).into()),
            inner,
        }
    }

    /// Convert DCTL scalar type to Naga scalar
    pub(super) fn scalar_type_to_naga(&self, scalar: ScalarType) -> Scalar {
        match scalar {
            ScalarType::Bool => Scalar::BOOL,
            ScalarType::Int => Scalar::I32,
            ScalarType::UInt => Scalar::U32,
            ScalarType::Float | ScalarType::Half => Scalar::F32,
        }
    }

    /// Generate a struct definition
    pub(super) fn generate_struct(
        &mut self,
        struct_decl: &crate::parser::StructDecl,
    ) -> Result<Handle<NagaType>, CodegenError> {
        let mut members = Vec::new();
        let mut member_indices = HashMap::new();
        let mut member_types = HashMap::new();
        let mut offset = 0u32;
        let mut max_align = 4u32; // Track maximum alignment

        // WGSL doesn't allow empty structs, so add a dummy field if needed
        if struct_decl.fields.is_empty() {
            let dummy_type = DctlType::UInt;
            let type_handle = self.get_or_create_type(&dummy_type);
            members.push(naga::StructMember {
                name: Some("_dummy".into()),
                ty: type_handle,
                binding: None,
                offset: 0,
            });
            member_indices.insert("_dummy".to_string(), 0);
            member_types.insert("_dummy".to_string(), dummy_type);
            offset = 4;
        }

        for (idx, field) in struct_decl.fields.iter().enumerate() {
            let field_type = self.convert_ast_type(&field.field_type);
            let type_handle = self.get_or_create_type(&field_type);

            // Get alignment for this type
            let align = self.type_alignment(&field_type);
            max_align = max_align.max(align);

            // Align offset
            offset = (offset + align - 1) / align * align;

            // Adjust index for dummy field
            let actual_idx = if struct_decl.fields.is_empty() { idx + 1 } else { idx };

            members.push(naga::StructMember {
                name: Some(field.name.clone().into()),
                ty: type_handle,
                binding: None,
                offset,
            });

            member_indices.insert(field.name.clone(), actual_idx as u32);
            member_types.insert(field.name.clone(), field_type.clone());

            // Advance offset
            let size = self.type_size(&field_type);
            offset += size;
        }

        // Store struct member info for lvalue resolution
        self.struct_members.insert(struct_decl.name.clone(), member_indices);
        // Store struct member types for type inference
        self.struct_member_types.insert(struct_decl.name.clone(), member_types);

        // Round up total size to largest alignment
        let struct_align = max_align;
        let span = (offset + struct_align - 1) / struct_align * struct_align;

        // Store struct size and alignment for nested struct support
        self.struct_sizes.insert(struct_decl.name.clone(), (span, struct_align));

        let struct_type = NagaType {
            name: Some(struct_decl.name.clone().into()),
            inner: TypeInner::Struct { members, span },
        };

        let handle = self.register_type(&struct_decl.name, struct_type);
        Ok(handle)
    }

    /// Get type size in bytes
    pub(super) fn type_size(&self, dctl_type: &DctlType) -> u32 {
        match dctl_type {
            DctlType::Bool | DctlType::Int | DctlType::UInt | DctlType::Float | DctlType::Char => 4,
            DctlType::Double => 8,
            DctlType::Half => 4, // Promoted to f32
            DctlType::Vec2(_) => 8,
            DctlType::Vec3(_) => 12,
            DctlType::Vec4(_) => 16,
            DctlType::Mat2 => 16, // 2 vec2 columns
            DctlType::Mat3 => 48, // 3 vec4 columns (padded)
            DctlType::Mat4 => 64,
            DctlType::Array(inner, Some(size)) => {
                // WGSL arrays have stride = element size rounded up to element alignment
                let elem_size = self.type_size(inner);
                let elem_align = self.type_alignment(inner);
                let stride = (elem_size + elem_align - 1) / elem_align * elem_align;
                stride * (*size as u32)
            }
            DctlType::Struct(name) => {
                // Look up stored struct size
                self.struct_sizes.get(name).map(|(size, _)| *size).unwrap_or(4)
            }
            _ => 4,
        }
    }

    /// Get type alignment in bytes
    pub(super) fn type_alignment(&self, dctl_type: &DctlType) -> u32 {
        match dctl_type {
            DctlType::Bool | DctlType::Int | DctlType::UInt | DctlType::Float | DctlType::Char => 4,
            DctlType::Double => 8,
            DctlType::Half => 4,
            DctlType::Vec2(_) => 8,
            DctlType::Vec3(_) | DctlType::Vec4(_) => 16,
            DctlType::Mat3 | DctlType::Mat4 => 16,
            DctlType::Array(inner, _) => self.type_alignment(inner),
            DctlType::Struct(name) => {
                // Look up stored struct alignment
                self.struct_sizes.get(name).map(|(_, align)| *align).unwrap_or(4)
            }
            _ => 4,
        }
    }

    /// Get type alignment from handle (reserved for future use)
    #[allow(dead_code)]
    pub(super) fn type_alignment_from_handle(&self, _handle: Handle<NagaType>) -> u32 {
        16 // Conservative alignment
    }

    /// Convert a parameter's type, taking modifiers into account
    pub(super) fn convert_parameter_type(&self, param: &crate::parser::Parameter) -> DctlType {
        // Check if parameter has __TEXTURE__ modifier
        for modifier in &param.modifiers {
            match modifier {
                crate::parser::Modifier::Texture | crate::parser::Modifier::Texture2D => {
                    return DctlType::Texture2D;
                }
                crate::parser::Modifier::Texture3D => {
                    return DctlType::Texture3D;
                }
                _ => {}
            }
        }
        // Otherwise, use the regular type conversion
        self.convert_ast_type(&param.param_type)
    }

    /// Convert AST type to semantic type
    pub(super) fn convert_ast_type(&self, ast_type: &Type) -> DctlType {
        let _base = self.convert_base_type(&ast_type.base);
        self.convert_ast_type_with_locals(ast_type, None)
    }

    /// Convert AST type to semantic type, with access to local constants for VLA size resolution
    pub(super) fn convert_ast_type_with_locals(
        &self,
        ast_type: &Type,
        local_constants: Option<&HashMap<String, i32>>,
    ) -> DctlType {
        self.convert_ast_type_with_locals_and_name(ast_type, local_constants, None)
    }

    /// Convert AST type to semantic type, flattening multi-dimensional arrays
    /// If var_name is provided and the type is a multi-dimensional array, the dimensions
    /// will be stored for index transformation
    pub(super) fn convert_ast_type_with_locals_and_name(
        &self,
        ast_type: &Type,
        local_constants: Option<&HashMap<String, i32>>,
        _var_name: Option<&str>,
    ) -> DctlType {
        let base = self.convert_base_type(&ast_type.base);

        // Handle arrays
        let result = if !ast_type.array_dims.is_empty() {
            // Collect all dimension sizes
            let mut dims: Vec<Option<usize>> = Vec::new();
            for dim in &ast_type.array_dims {
                let size = match dim {
                    crate::parser::ArrayDim::Fixed(n) => Some(*n),
                    crate::parser::ArrayDim::Expression(expr) => {
                        // Try to evaluate the constant expression
                        self.evaluate_const_int_expression_with_locals(expr, local_constants)
                            .map(|v| v as usize)
                    }
                    _ => None,
                };
                dims.push(size);
            }

            // Check if this is a multi-dimensional array with all dimensions known
            if dims.len() > 1 && dims.iter().all(|d| d.is_some()) {
                // Flatten to 1D array: int[M][N] -> array<i32, M*N>
                let flat_size: usize = dims.iter().map(|d| d.unwrap()).product();
                DctlType::Array(Box::new(base), Some(flat_size))
            } else {
                // Single dimension or unknown sizes: use original nested structure
                let mut current = base;
                for dim in dims.iter().rev() {
                    current = DctlType::Array(Box::new(current), *dim);
                }
                current
            }
        } else {
            base
        };

        // Handle pointers
        if ast_type.is_pointer {
            DctlType::Pointer(Box::new(result))
        } else {
            result
        }
    }

    /// Convert multi-dimensional array type and register dimensions for index transformation
    /// Returns the flattened type and the original dimensions (if multi-dimensional)
    pub(super) fn convert_multidim_array_type(
        &self,
        ast_type: &Type,
        local_constants: Option<&HashMap<String, i32>>,
    ) -> (DctlType, Option<Vec<usize>>) {
        let base = self.convert_base_type(&ast_type.base);

        if ast_type.array_dims.len() > 1 {
            // Collect all dimension sizes
            let mut dims: Vec<usize> = Vec::new();
            for dim in &ast_type.array_dims {
                let size = match dim {
                    crate::parser::ArrayDim::Fixed(n) => Some(*n),
                    crate::parser::ArrayDim::Expression(expr) => {
                        self.evaluate_const_int_expression_with_locals(expr, local_constants)
                            .map(|v| v as usize)
                    }
                    _ => None,
                };
                if let Some(s) = size {
                    dims.push(s);
                } else {
                    // If any dimension is unknown, fall back to nested arrays
                    return (self.convert_ast_type_with_locals(ast_type, local_constants), None);
                }
            }

            // All dimensions known - flatten to 1D
            let flat_size: usize = dims.iter().product();
            let flat_type = DctlType::Array(Box::new(base), Some(flat_size));
            (flat_type, Some(dims))
        } else {
            // Single dimension or no array
            (self.convert_ast_type_with_locals(ast_type, local_constants), None)
        }
    }

    /// Convert AST base type to semantic base type
    pub(super) fn convert_base_type(&self, base: &BaseType) -> DctlType {
        match base {
            BaseType::Void => DctlType::Void,
            BaseType::Bool => DctlType::Bool,
            BaseType::Char => DctlType::Char,
            BaseType::Int => DctlType::Int,
            BaseType::UInt => DctlType::UInt,
            BaseType::Float => DctlType::Float,
            BaseType::Double => DctlType::Double,
            BaseType::Half => DctlType::Half,
            BaseType::Float2 => DctlType::Vec2(ScalarType::Float),
            BaseType::Float3 => DctlType::Vec3(ScalarType::Float),
            BaseType::Float4 => DctlType::Vec4(ScalarType::Float),
            BaseType::Int2 => DctlType::Vec2(ScalarType::Int),
            BaseType::Int3 => DctlType::Vec3(ScalarType::Int),
            BaseType::Int4 => DctlType::Vec4(ScalarType::Int),
            BaseType::Half2 => DctlType::Vec2(ScalarType::Half),
            BaseType::Half3 => DctlType::Vec3(ScalarType::Half),
            BaseType::Half4 => DctlType::Vec4(ScalarType::Half),
            BaseType::Float2x2 => DctlType::Mat2,
            BaseType::Float3x3 => DctlType::Mat3,
            BaseType::Float4x4 => DctlType::Mat4,
            BaseType::Struct(name) => DctlType::Struct(name.clone()),
            BaseType::Typedef(name) => {
                // Resolve typedef to its underlying type
                if let Some(resolved) = self.typedefs.get(name) {
                    resolved.clone()
                } else {
                    // Fall back to treating as struct if not found
                    DctlType::Struct(name.clone())
                }
            }
            BaseType::Texture2D => DctlType::Texture2D,
            BaseType::Texture3D => DctlType::Texture3D,
            BaseType::Sampler => DctlType::Sampler,
        }
    }

    /// Count the total number of scalar elements in a potentially nested initializer list
    /// Used for flattening multi-dimensional array initializers
    pub(super) fn count_flat_initializer_elements(&self, init_list: &crate::parser::InitializerListExpr) -> usize {
        let mut count = 0;
        for elem in &init_list.elements {
            match elem {
                Expression::InitializerList(nested) => {
                    count += self.count_flat_initializer_elements(nested);
                }
                _ => {
                    count += 1;
                }
            }
        }
        count
    }

    /// Flatten a nested initializer list for multi-dimensional arrays
    /// depth: how many levels of nesting to flatten (0 means keep structure, 1 means flatten one level, etc.)
    pub(super) fn flatten_initializer_list_depth(&self, init_list: &crate::parser::InitializerListExpr, depth: usize) -> Vec<Expression> {
        if depth == 0 {
            // Don't flatten, return elements as-is
            return init_list.elements.clone();
        }

        let mut flattened = Vec::new();
        for elem in &init_list.elements {
            match elem {
                Expression::InitializerList(nested) => {
                    if depth > 1 {
                        flattened.extend(self.flatten_initializer_list_depth(nested, depth - 1));
                    } else {
                        // depth == 1: extract elements from this level (not keep InitializerList as-is)
                        // This allows complete flattening of all grouping levels
                        flattened.extend(nested.elements.clone());
                    }
                }
                _ => {
                    flattened.push(elem.clone());
                }
            }
        }
        flattened
    }

    /// Flatten a nested initializer list into a single-level list (default behavior: flatten all levels)
    pub(super) fn flatten_initializer_list(&self, init_list: &crate::parser::InitializerListExpr) -> Vec<Expression> {
        let mut flattened = Vec::new();
        for elem in &init_list.elements {
            match elem {
                Expression::InitializerList(nested) => {
                    flattened.extend(self.flatten_initializer_list(nested));
                }
                _ => {
                    flattened.push(elem.clone());
                }
            }
        }
        flattened
    }

    /// Collect indices from a multi-dimensional array access
    /// For arr[i][j], returns Some(("arr", [i, j]))
    /// Returns None if not a multi-dimensional access pattern
    pub(super) fn collect_multidim_indices(&self, expr: &Expression) -> Option<(String, Vec<Expression>)> {
        let mut indices = Vec::new();
        let mut current = expr;

        // Walk through nested Index expressions
        loop {
            match current {
                Expression::Index(index_expr) => {
                    indices.push((*index_expr.index).clone());
                    current = &index_expr.object;
                }
                Expression::Identifier(ident) => {
                    // Reached the base array identifier
                    if !indices.is_empty() {
                        // Reverse indices since we collected them outer-to-inner
                        indices.reverse();
                        return Some((ident.name.clone(), indices));
                    } else {
                        return None;
                    }
                }
                _ => {
                    // Not a simple identifier base
                    return None;
                }
            }
        }
    }

    /// Compute flat index from multi-dimensional indices and dimensions
    /// For indices [i, j] and dims [M, N]: flat = i * N + j
    /// For indices [i, j, k] and dims [M, N, P]: flat = i * N * P + j * P + k
    pub(super) fn compute_flat_index(
        &mut self,
        indices: &[Expression],
        dims: &[usize],
        ctx: &mut FunctionContext,
    ) -> Result<Handle<NagaExpr>, CodegenError> {
        // Generate expressions for each index
        let mut index_handles: Vec<Handle<NagaExpr>> = Vec::new();
        for idx_expr in indices {
            let handle = self.generate_expression(idx_expr, ctx)?;
            index_handles.push(handle);
        }

        // Compute strides: for dims [M, N, P], strides are [N*P, P, 1]
        let mut strides: Vec<usize> = Vec::with_capacity(dims.len());
        for i in 0..dims.len() {
            let s: usize = dims[i+1..].iter().product();
            strides.push(if s == 0 { 1 } else { s });
        }

        // Build the flat index expression: sum of (index_i * stride_i)
        let mut result: Option<Handle<NagaExpr>> = None;
        for (i, &index_handle) in index_handles.iter().enumerate() {
            let stride_val = strides[i];
            let term = if stride_val == 1 {
                // No need to multiply by 1
                index_handle
            } else {
                // Multiply index by stride
                let stride_literal = ctx.expressions.append(
                    NagaExpr::Literal(naga::Literal::I32(stride_val as i32)),
                    Span::UNDEFINED,
                );
                ctx.expressions.append(
                    NagaExpr::Binary {
                        op: naga::BinaryOperator::Multiply,
                        left: index_handle,
                        right: stride_literal,
                    },
                    Span::UNDEFINED,
                )
            };

            result = Some(match result {
                None => term,
                Some(acc) => {
                    ctx.expressions.append(
                        NagaExpr::Binary {
                            op: naga::BinaryOperator::Add,
                            left: acc,
                            right: term,
                        },
                        Span::UNDEFINED,
                    )
                }
            });
        }

        result.ok_or_else(|| CodegenError::Internal("Empty indices in multi-dimensional access".to_string()))
    }

    /// Evaluate a constant integer expression (global scope)
    /// Used for array size resolution and switch case evaluation
    pub(super) fn evaluate_const_int_expression(&self, expr: &Expression) -> Option<i32> {
        self.evaluate_const_int_expression_with_locals(expr, None)
    }

    /// Evaluate a constant integer expression with access to local constants
    pub(super) fn evaluate_const_int_expression_with_locals(
        &self,
        expr: &Expression,
        local_constants: Option<&HashMap<String, i32>>,
    ) -> Option<i32> {
        use crate::parser::{BinaryOp, LiteralValue, UnaryOp};

        match expr {
            Expression::Literal(lit) => {
                match &lit.value {
                    LiteralValue::Int(v) => Some(*v as i32),
                    LiteralValue::Float(v) => Some(*v as i32),
                    LiteralValue::Bool(b) => Some(if *b { 1 } else { 0 }),
                    _ => None,
                }
            }
            Expression::Identifier(ident) => {
                // Look up in local constants first, then global integer_constants
                local_constants
                    .and_then(|lc| lc.get(&ident.name).copied())
                    .or_else(|| self.integer_constants.get(&ident.name).copied())
            }
            Expression::Binary(binary) => {
                // Evaluate binary operations
                let left = self.evaluate_const_int_expression_with_locals(&binary.left, local_constants)?;
                let right = self.evaluate_const_int_expression_with_locals(&binary.right, local_constants)?;
                match binary.op {
                    BinaryOp::Add => Some(left + right),
                    BinaryOp::Sub => Some(left - right),
                    BinaryOp::Mul => Some(left * right),
                    BinaryOp::Div => if right != 0 { Some(left / right) } else { None },
                    BinaryOp::Mod => if right != 0 { Some(left % right) } else { None },
                    BinaryOp::BitAnd => Some(left & right),
                    BinaryOp::BitOr => Some(left | right),
                    BinaryOp::BitXor => Some(left ^ right),
                    BinaryOp::Shl => Some(left << right),
                    BinaryOp::Shr => Some(left >> right),
                    _ => None,
                }
            }
            Expression::Unary(unary) => {
                let operand = self.evaluate_const_int_expression_with_locals(&unary.operand, local_constants)?;
                match unary.op {
                    UnaryOp::Neg => Some(-operand),
                    UnaryOp::BitNot => Some(!operand),
                    _ => None,
                }
            }
            Expression::Sizeof(sizeof_expr) => {
                // Handle sizeof() expressions
                match &sizeof_expr.operand {
                    crate::parser::SizeofOperand::Type(ty) => {
                        let dtype = self.convert_ast_type(ty);
                        Some(self.type_size(&dtype) as i32)
                    }
                    crate::parser::SizeofOperand::Expression(expr) => {
                        if let Expression::Identifier(ident) = expr.as_ref() {
                            // Check if it's a type name
                            if let Some(dtype) = self.typedefs.get(&ident.name) {
                                return Some(self.type_size(dtype) as i32);
                            }
                            // Check if it's a variable
                            if let Some(dtype) = self.global_variable_types.get(&ident.name) {
                                return Some(self.type_size(dtype) as i32);
                            }
                        }
                        None
                    }
                }
            }
            _ => None,
        }
    }
}
