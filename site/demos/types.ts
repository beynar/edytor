import type { Component } from 'svelte';
import type { JSONDoc, Plugin } from 'edytor';

/** What the "Customize" component receives: a copy of the seed and the rest of the editor. */
export type DemoProps = { value: JSONDoc; plugins: Plugin[] };

/**
 * A plugin page's demo: the default export of `site/demos/<page>/index.ts`,
 * `<page>` being the page's file name under `site/content/docs/plugins/`.
 */
export type PluginDemo = {
	/** The seed document. Each editor opens its own copy; nothing is saved. */
	value: JSONDoc;
	/** The "Try it" editor's plugins: the page's own, listed first, then `basePlugins()`. */
	plugins: () => Plugin[];
	/**
	 * The "Customize" editor: the component the page shows in its `check`
	 * fence, rendering `<Edytor {value} plugins={[...yours, ...plugins]} />`,
	 * where `yours` is the page's plugin as the fence configures it. Leave it
	 * out where the plugin renders nothing (arrow move, input rules).
	 */
	custom?: Component<DemoProps>;
	/**
	 * The `plugins` the "Customize" component gets: the rest of the editor,
	 * never a second instance of the plugin it configures (default
	 * `basePlugins()`).
	 */
	customPlugins?: () => Plugin[];
};
