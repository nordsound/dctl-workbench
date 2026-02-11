//! Declaration generation for WGSL code generation
//!
//! Handles generation of uniform buffers, global variables, and constant expressions.

use super::naga_module::NagaModuleGenerator;
use super::CodegenError;
use crate::parser::{DctlModule, Expression, LiteralValue, VariableDecl};
use crate::semantic::{DctlType, ScalarType};
use naga::{
    AddressSpace, Expression as NagaExpr, GlobalVariable, Handle, Literal, Span, TypeInner,
};

impl NagaModuleGenerator {
    /// Generate uniform buffer for UI parameters
    pub(super) fn generate_uniform_buffer(
        &mut self,
        dctl_module: &DctlModule,
    ) -> Result<(), CodegenError> {
        // Create struct for uniform buffer
        let mut members = Vec::new();
        let mut offset = 0u32;

        for param in &dctl_module.ui_params {
            let (type_handle, size, align, dctl_type) = match &param.ui_type {
                crate::parser::UiParamType::SliderFloat { .. } => {
                    (self.type_handles["f32"], 4u32, 4u32, DctlType::Float)
                }
                crate::parser::UiParamType::SliderInt { .. } => {
                    (self.type_handles["i32"], 4u32, 4u32, DctlType::Int)
                }
                crate::parser::UiParamType::CheckBox { .. } => {
                    (self.type_handles["i32"], 4u32, 4u32, DctlType::Int) // bool as i32
                }
                crate::parser::UiParamType::ComboBox { .. } => {
                    (self.type_handles["i32"], 4u32, 4u32, DctlType::Int)
                }
            };

            // Track uniform param type for type inference
            self.uniform_param_types
                .insert(param.name.clone(), dctl_type);

            // Align offset
            offset = (offset + align - 1) / align * align;

            members.push(naga::StructMember {
                name: Some(param.name.clone().into()),
                ty: type_handle,
                binding: None,
                offset,
            });

            offset += size;
        }

        if members.is_empty() {
            return Ok(());
        }

        // Round up to 16-byte alignment for uniform buffer
        let span = (offset + 15) / 16 * 16;

        let struct_type = naga::Type {
            name: Some("DctlParams".into()),
            inner: TypeInner::Struct { members, span },
        };

        let struct_handle = self.register_type("DctlParams", struct_type);

        // Create global variable with uniform binding
        let global = GlobalVariable {
            name: Some("params".into()),
            space: AddressSpace::Uniform,
            binding: Some(naga::ResourceBinding {
                group: 0,
                binding: 0,
            }),
            ty: struct_handle,
            init: None,
        };

        let handle = self.module.global_variables.append(global, Span::UNDEFINED);
        self.global_handles.insert("params".to_string(), handle);

        Ok(())
    }

    /// Generate a global variable
    pub(super) fn generate_global_variable(
        &mut self,
        var_decl: &VariableDecl,
    ) -> Result<Handle<GlobalVariable>, CodegenError> {
        // Check for multi-dimensional arrays and flatten them
        let (mut var_type, multidim_dims) =
            self.convert_multidim_array_type(&var_decl.var_type, None);

        // Store multi-dimensional array dimensions for index transformation
        if let Some(dims) = multidim_dims {
            self.multidim_array_dims.insert(var_decl.name.clone(), dims);
        }

        // If this is an unsized array with an initializer list, infer the size
        if let DctlType::Array(ref elem_type, None) = var_type {
            if let Some(Expression::InitializerList(init_list)) = &var_decl.initializer {
                // Count elements recursively for nested initializers
                let size = self.count_flat_initializer_elements(init_list);
                var_type = DctlType::Array(elem_type.clone(), Some(size));
            }
        }

        let type_handle = self.get_or_create_type(&var_type);

        // Generate initializer if present
        let init = if let Some(init_expr) = &var_decl.initializer {
            // Use typed initializer for InitializerList to properly compose vectors/arrays
            self.generate_const_expression_with_type(init_expr, Some(&var_type))?
        } else {
            None
        };

        // Sanitize variable name for WGSL compatibility
        let wgsl_name = NagaModuleGenerator::sanitize_identifier_for_wgsl(&var_decl.name);

        let global = GlobalVariable {
            name: Some(wgsl_name.into()),
            space: if var_decl.is_const {
                AddressSpace::Private // Constants in private space
            } else {
                AddressSpace::Private
            },
            binding: None,
            ty: type_handle,
            init,
        };

        let handle = self.module.global_variables.append(global, Span::UNDEFINED);
        self.global_handles.insert(var_decl.name.clone(), handle);

        // Track global variable type for type inference
        self.global_variable_types
            .insert(var_decl.name.clone(), var_type.clone());

        // Track array sizes for sizeof() support
        if let DctlType::Array(ref elem_type, Some(size)) = var_type {
            let elem_size = self.type_size(elem_type) as usize;
            let total_size = elem_size * size;
            self.global_array_sizes
                .insert(var_decl.name.clone(), (total_size, (**elem_type).clone()));
        }

        // Track integer constant values for switch case resolution and array size evaluation
        if let Some(init_expr) = &var_decl.initializer {
            // Try to evaluate the constant expression
            if let Some(value) = self.evaluate_const_int_expression(init_expr) {
                self.integer_constants.insert(var_decl.name.clone(), value);
            }
        }

        Ok(handle)
    }

    /// Generate a constant expression (for global initializers)
    pub(super) fn generate_const_expression(
        &mut self,
        expr: &Expression,
    ) -> Result<Option<Handle<NagaExpr>>, CodegenError> {
        self.generate_const_expression_with_type(expr, None)
    }

    /// Generate a constant expression with an expected type (for typed initializers)
    pub(super) fn generate_const_expression_with_type(
        &mut self,
        expr: &Expression,
        expected_type: Option<&DctlType>,
    ) -> Result<Option<Handle<NagaExpr>>, CodegenError> {
        match expr {
            Expression::Literal(lit) => {
                // Convert literal to expected type if specified
                let literal = match (&lit.value, expected_type) {
                    // Int literal to float variable: convert int to float
                    (
                        LiteralValue::Int(v),
                        Some(DctlType::Float | DctlType::Double | DctlType::Half),
                    ) => Literal::F32(*v as f32),
                    // Int literal to bool variable: convert int to bool (0 = false, non-zero = true)
                    (LiteralValue::Int(v), Some(DctlType::Bool)) => Literal::Bool(*v != 0),
                    // Float literal to int variable: convert float to int
                    (LiteralValue::Float(v), Some(DctlType::Int)) => Literal::I32(*v as i32),
                    // Int literal to unsigned int: convert int to uint
                    (LiteralValue::Int(v), Some(DctlType::UInt)) => Literal::U32(*v as u32),
                    // UInt literal to int: convert uint to int
                    (LiteralValue::UInt(v), Some(DctlType::Int)) => Literal::I32(*v as i32),
                    // Float literal to unsigned int: convert float to uint
                    (LiteralValue::Float(v), Some(DctlType::UInt)) => Literal::U32(*v as u32),
                    // Default: use literal type as-is
                    (LiteralValue::Int(v), _) => Literal::I32(*v as i32),
                    (LiteralValue::UInt(v), _) => Literal::U32(*v as u32),
                    (LiteralValue::Float(v), _) => Literal::F32(*v as f32),
                    (LiteralValue::Bool(v), _) => Literal::Bool(*v),
                    _ => return Ok(None),
                };
                let handle = self
                    .module
                    .global_expressions
                    .append(NagaExpr::Literal(literal), Span::UNDEFINED);
                Ok(Some(handle))
            }
            Expression::InitializerList(init_list) => {
                // Determine target type
                let target_type = expected_type
                    .cloned()
                    .unwrap_or(DctlType::Vec3(ScalarType::Float));
                let type_handle = self.get_or_create_type(&target_type);

                match &target_type {
                    // Array (possibly flattened from multi-dimensional)
                    DctlType::Array(inner, _) => {
                        // Determine flattening strategy based on element type
                        let inner_is_scalar = matches!(
                            inner.as_ref(),
                            DctlType::Float
                                | DctlType::Int
                                | DctlType::UInt
                                | DctlType::Bool
                                | DctlType::Half
                                | DctlType::Double
                        );
                        let has_nested_init = init_list
                            .elements
                            .iter()
                            .any(|e| matches!(e, Expression::InitializerList(_)));

                        let elements_to_process: Vec<Expression> = if has_nested_init {
                            if inner_is_scalar {
                                // Scalar array: flatten all levels
                                self.flatten_initializer_list(init_list)
                            } else {
                                // Non-scalar array (vector/struct/etc): flatten only the array dimensions
                                // Count nesting depth of initializer and check what's at the innermost level
                                let mut depth = 0;
                                let mut probe = &init_list.elements;
                                let mut innermost_is_literal = false;
                                while !probe.is_empty() {
                                    if let Expression::InitializerList(nested) = &probe[0] {
                                        depth += 1;
                                        probe = &nested.elements;
                                    } else {
                                        // Check if innermost elements are literals (element initializers like {1.0, 2.0})
                                        // vs function calls (make_float2 etc.)
                                        innermost_is_literal =
                                            matches!(&probe[0], Expression::Literal(_));
                                        break;
                                    }
                                }
                                // If innermost elements are literals, the enclosing InitializerLists are element
                                // initializers (like {1.0, 2.0} for vec2), so subtract 1 from depth to preserve them
                                if innermost_is_literal && depth > 0 {
                                    depth -= 1;
                                }
                                // Flatten to the appropriate depth
                                if depth > 0 {
                                    self.flatten_initializer_list_depth(init_list, depth)
                                } else {
                                    init_list.elements.clone()
                                }
                            }
                        } else {
                            // No nested initializers, use elements directly
                            init_list.elements.clone()
                        };

                        let mut components = Vec::new();
                        for elem in &elements_to_process {
                            if let Some(handle) =
                                self.generate_const_expression_with_type(elem, Some(inner))?
                            {
                                components.push(handle);
                            } else {
                                return Ok(None); // Can't generate constant for this element
                            }
                        }
                        let handle = self.module.global_expressions.append(
                            NagaExpr::Compose {
                                ty: type_handle,
                                components,
                            },
                            Span::UNDEFINED,
                        );
                        Ok(Some(handle))
                    }
                    // Vec3 from 3 floats
                    DctlType::Vec3(scalar) => {
                        if init_list.elements.len() != 3 {
                            return Ok(None);
                        }
                        let elem_type = match scalar {
                            ScalarType::Float | ScalarType::Half => DctlType::Float,
                            ScalarType::Int | ScalarType::UInt | ScalarType::Bool => DctlType::Int,
                        };
                        let mut components = Vec::new();
                        for elem in &init_list.elements {
                            if let Some(handle) =
                                self.generate_const_expression_with_type(elem, Some(&elem_type))?
                            {
                                components.push(handle);
                            } else {
                                return Ok(None);
                            }
                        }
                        let handle = self.module.global_expressions.append(
                            NagaExpr::Compose {
                                ty: type_handle,
                                components,
                            },
                            Span::UNDEFINED,
                        );
                        Ok(Some(handle))
                    }
                    // Vec4 from 4 floats
                    DctlType::Vec4(scalar) => {
                        if init_list.elements.len() != 4 {
                            return Ok(None);
                        }
                        let elem_type = match scalar {
                            ScalarType::Float | ScalarType::Half => DctlType::Float,
                            ScalarType::Int | ScalarType::UInt | ScalarType::Bool => DctlType::Int,
                        };
                        let mut components = Vec::new();
                        for elem in &init_list.elements {
                            if let Some(handle) =
                                self.generate_const_expression_with_type(elem, Some(&elem_type))?
                            {
                                components.push(handle);
                            } else {
                                return Ok(None);
                            }
                        }
                        let handle = self.module.global_expressions.append(
                            NagaExpr::Compose {
                                ty: type_handle,
                                components,
                            },
                            Span::UNDEFINED,
                        );
                        Ok(Some(handle))
                    }
                    // Vec2 from 2 floats
                    DctlType::Vec2(scalar) => {
                        if init_list.elements.len() != 2 {
                            return Ok(None);
                        }
                        let elem_type = match scalar {
                            ScalarType::Float | ScalarType::Half => DctlType::Float,
                            ScalarType::Int | ScalarType::UInt | ScalarType::Bool => DctlType::Int,
                        };
                        let mut components = Vec::new();
                        for elem in &init_list.elements {
                            if let Some(handle) =
                                self.generate_const_expression_with_type(elem, Some(&elem_type))?
                            {
                                components.push(handle);
                            } else {
                                return Ok(None);
                            }
                        }
                        let handle = self.module.global_expressions.append(
                            NagaExpr::Compose {
                                ty: type_handle,
                                components,
                            },
                            Span::UNDEFINED,
                        );
                        Ok(Some(handle))
                    }
                    // Mat3 from 9 floats or 3 vec3s
                    DctlType::Mat3 => {
                        let vec3_type = self.get_or_create_type(&DctlType::Vec3(ScalarType::Float));
                        let mut columns = Vec::new();

                        if init_list.elements.len() == 3 {
                            // 3 nested initializer lists (column-major)
                            for elem in &init_list.elements {
                                if let Some(col_handle) = self.generate_const_expression_with_type(
                                    elem,
                                    Some(&DctlType::Vec3(ScalarType::Float)),
                                )? {
                                    columns.push(col_handle);
                                } else {
                                    return Ok(None);
                                }
                            }
                        } else if init_list.elements.len() == 9 {
                            // Flat list of 9 elements
                            for i in 0..3 {
                                let mut col_components = Vec::new();
                                for j in 0..3 {
                                    if let Some(handle) = self
                                        .generate_const_expression(&init_list.elements[i * 3 + j])?
                                    {
                                        col_components.push(handle);
                                    } else {
                                        return Ok(None);
                                    }
                                }
                                let col = self.module.global_expressions.append(
                                    NagaExpr::Compose {
                                        ty: vec3_type,
                                        components: col_components,
                                    },
                                    Span::UNDEFINED,
                                );
                                columns.push(col);
                            }
                        } else {
                            return Ok(None);
                        }

                        let handle = self.module.global_expressions.append(
                            NagaExpr::Compose {
                                ty: type_handle,
                                components: columns,
                            },
                            Span::UNDEFINED,
                        );
                        Ok(Some(handle))
                    }
                    _ => Ok(None), // Other types not yet supported
                }
            }
            _ => Ok(None), // Non-constant expressions not supported
        }
    }
}
