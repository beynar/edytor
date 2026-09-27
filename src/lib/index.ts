/**
 * `edytor` package root — public surface.
 *
 * The headline is the integrated document: `createDocument` builds an
 * `EdytorDocument` (shared facade + history + awareness + actor +
 * attribution on the v14 CRDT substrate) that any number of `<Edytor>`
 * views can render, or that works headlessly with no view at all:
 *
 * ```ts
 * import { Edytor, createDocument } from 'edytor';
 * const document = createDocument({ value });
 * // <Edytor {document} {plugins} />  — one or many views
 * ```
 *
 * The same module also exports the rest of the bound CRDT layer
 * (`./crdt/index.js` — provider/sync factories, the admission gate
 * vocabulary, attribution reads, migration, and the `bind*` engine-
 * injection internals documented as advanced there). The raw engine
 * itself is only reachable through `import * as Y from 'edytor/crdt'`,
 * which keeps the published dependency set free of a second,
 * wire-incompatible engine.
 *
 * This module re-exports the `.svelte` component, so it requires a
 * bundler that understands Svelte (vite-plugin-svelte). Plain-node/SSR
 * CRDT work imports the same bindings from `edytor/crdt/edytor` —
 * identical surface, no component in the graph.
 */
export { default as Edytor } from './components/Edytor.svelte';
export { useEdytor } from './edytor.svelte.js';
export { Block } from './block/block.svelte.js';
export type { BlockMoveDirection, BlockMovePosition, BlockMoveRequest } from './session/moves.js';
export { InlineBlock } from './block/inlineBlock.svelte.js';
export { Text } from './text/text.svelte.js';
export { type Plugin, type KindPreset } from './plugins.js';
export { convertToKind, type KindRow } from './kinds.js';
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
