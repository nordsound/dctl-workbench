/**
 * Plugin registry for dctl-workbench.
 *
 * Single source of truth for registered input and demosaic plugins.
 * Lives outside `extension.ts` to avoid circular imports when the
 * registry is consumed by modules that `extension.ts` itself imports
 * (e.g. `ExrEditorProvider`).
 */

import type { InputPlugin, DemosaicPlugin } from './types';

const inputPlugins = new Map<string, InputPlugin>();
const demosaicPlugins = new Map<string, DemosaicPlugin>();

/**
 * Register an input plugin. Returns true on success, false if a plugin
 * with the same id is already registered.
 */
export function registerInputPlugin(plugin: InputPlugin): boolean {
    if (inputPlugins.has(plugin.id)) {
        console.warn(`Input plugin with id "${plugin.id}" is already registered`);
        return false;
    }
    inputPlugins.set(plugin.id, plugin);
    console.log(`Registered input plugin: ${plugin.name} (${plugin.id})`);
    return true;
}

/**
 * Unregister an input plugin by id. Calls plugin.dispose() and removes it.
 */
export function unregisterInputPlugin(id: string): boolean {
    const plugin = inputPlugins.get(id);
    if (plugin) {
        plugin.dispose();
        inputPlugins.delete(id);
        console.log(`Unregistered input plugin: ${id}`);
        return true;
    }
    return false;
}

/**
 * Register a demosaic plugin.
 */
export function registerDemosaicPlugin(plugin: DemosaicPlugin): boolean {
    if (demosaicPlugins.has(plugin.id)) {
        console.warn(`Demosaic plugin with id "${plugin.id}" is already registered`);
        return false;
    }
    demosaicPlugins.set(plugin.id, plugin);
    console.log(`Registered demosaic plugin: ${plugin.name} (${plugin.id})`);
    return true;
}

/**
 * Unregister a demosaic plugin by id.
 */
export function unregisterDemosaicPlugin(id: string): boolean {
    const deleted = demosaicPlugins.delete(id);
    if (deleted) {
        console.log(`Unregistered demosaic plugin: ${id}`);
    }
    return deleted;
}

/**
 * Get all registered input plugins.
 */
export function getInputPlugins(): InputPlugin[] {
    return Array.from(inputPlugins.values());
}

/**
 * Get all registered demosaic plugins.
 */
export function getDemosaicPlugins(): DemosaicPlugin[] {
    return Array.from(demosaicPlugins.values());
}

/**
 * Find the first registered input plugin that can handle the given file.
 * Iteration order follows registration order (Map semantics).
 */
export function findInputPlugin(extension: string, data?: Uint8Array): InputPlugin | undefined {
    const ext = extension.toLowerCase().replace(/^\./, '');
    for (const plugin of inputPlugins.values()) {
        if (plugin.canHandle(ext, data)) {
            return plugin;
        }
    }
    return undefined;
}

/**
 * Dispose all registered plugins and clear the registry.
 * Called from extension deactivate().
 */
export function disposeAllPlugins(): void {
    for (const plugin of inputPlugins.values()) {
        try {
            plugin.dispose();
        } catch (e) {
            console.error(`Error disposing input plugin ${plugin.id}:`, e);
        }
    }
    inputPlugins.clear();
    demosaicPlugins.clear();
}

/**
 * Test helper: reset the registry to empty state.
 * Should only be called from tests.
 */
export function __resetRegistryForTests(): void {
    inputPlugins.clear();
    demosaicPlugins.clear();
}
