import type { Plugin } from '$lib/plugins.js';

const brands = new WeakMap<Plugin, string>();

/**
 * `plugin`, known as a `name` plugin: `<Edytor>`'s default plugin of that
 * name yields to any instance listed (`brandOf`).
 */
export const branded = (name: string, plugin: Plugin): Plugin => (brands.set(plugin, name), plugin);

/** The name `plugin` was branded with, if any. */
export const brandOf = (plugin: Plugin) => brands.get(plugin);
