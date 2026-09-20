/**
 * `edytor` package root — public surface.
 *
 * The editor runtime now runs on the v14 CRDT substrate (`./crdt/index.js`),
 * so the same module exports both the editor components and the
 * engine-injected CRDT layer — `bindCrdt`, the document facade, providers,
 * sync/awareness/auth protocols, and migration. The engine itself is only
 * reachable through `import * as Y from 'edytor/crdt'`, which keeps the
 * published dependency set free of a second, wire-incompatible engine.
 *
 * ```ts
 * import * as Y from 'edytor/crdt';   // vendored v14 engine
 * import { bindCrdt } from 'edytor';
 * const crdt = bindCrdt(Y);
 * ```
 *
 * This module also re-exports the `.svelte` component, so it requires a
 * bundler that understands Svelte (vite-plugin-svelte). Plain-node/SSR-side
 * CRDT work imports the same bindings from `edytor/crdt/edytor` — identical
 * surface, no component in the graph.
 */
export { default as Edytor } from './components/Edytor.svelte';
export { useEdytor } from './edytor.svelte.js';
export { Block } from './block/block.svelte.js';
export { InlineBlock } from './block/inlineBlock.svelte.js';
export { Text } from './text/text.svelte.js';
export { type Plugin } from './plugins.js';
export * from './plugins/index.js';
export * from './crdt/index.js';

// Provider + sync factories bound to the vendored engine — the documented
// consumer story (`import { Edytor, createIndexeddbSync } from 'edytor'`)
// needs no `edytor/crdt` import for the common IndexedDB/websocket cases.
// The `EdytorSync*`/`IndexeddbSyncOptions`/`WebsocketSyncOptions` types are
// already re-exported through `./crdt/index.js` above.
export {
	createIndexeddbSync,
	createWebsocketSync,
	clearDocument,
	storeState,
	IndexeddbPersistence,
	WebsocketProvider
} from './collaboration/index.js';
