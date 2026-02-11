/**
 * DCTL Parser Module (VSCode)
 *
 * Re-exports core parser functionality and provides VSCode-specific extensions.
 */

// Re-export everything from core parser
export * from '@dctl-workbench/core';

// VSCode-specific modules
export * from './types';
export * from './treeSitter';
export * from './dctlVisitor';
