/**
 * `edytor` package root — the curated public surface of a Svelte app.
 *
 * Every name is listed: nothing reaches the root by `export *`, and
 * `api/edytor.api.md` (`pnpm api:report`, checked by
 * `src/tests/api/public-surface.test.ts`) is the reviewed list.
 *
 * ```ts
 * import { Edytor, createDocument } from 'edytor';
 * const document = createDocument({ value });
 * // <Edytor {document} {plugins} />  — one or many views
 * ```
 *
 * The other entry points:
 *
 * - `edytor/crdt/edytor` — the document API without Svelte (Node, Workers),
 *   and the full facade vocabulary (`BlockSpec`, `Destination`,
 *   `ProjectedDoc`, `DocAnchor`, …), attribution, migration and `bindCrdt`;
 * - `edytor/protocol` — the wire and coordinator vocabulary (frames,
 *   message types, codecs, generation records, admission gates, the raw
 *   provider classes);
 * - `edytor/crdt` — the vendored engine itself;
 * - `edytor/cloudflare` — the Durable Object room.
 *
 * This module re-exports the `.svelte` component, so it requires a
 * bundler that understands Svelte (vite-plugin-svelte).
 */

// ── The editor ─────────────────────────────────────────────────────────
export { default as Edytor } from './components/Edytor.svelte';
export { useEdytor } from './edytor.svelte.js';
/** The editor instance plugins, hotkeys and `bind:edytor` receive (`Edytor` names the component). */
export type { Edytor as EdytorInstance, EdytorDocData } from './edytor.svelte.js';
export type { EdytorSelection } from './selection/selection.svelte.js';
export { Block } from './block/block.svelte.js';
export { InlineBlock } from './block/inlineBlock.svelte.js';
export { Text } from './text/text.svelte.js';
export type { BlockMoveDirection, BlockMovePosition, BlockMoveRequest } from './session/moves.js';
export type { HotKey, HotKeyCombination } from './session/keymap.js';

// ── Plugins: the records and the commands ──────────────────────────────
export type {
	Plugin,
	KindPreset,
	EditorCommand,
	BlockDefinition,
	MarkDefinition,
	InlineBlockDefinition,
	BlockSnippetPayload,
	MarkSnippetPayload,
	InlineBlockSnippetPayload,
	Placeholder,
	PlaceholderView,
	ChangePayload,
	AfterOperationPayload,
	Prevent
} from './plugins.js';
export { PreventionError, isPrevention } from './utils.js';
export type { CommandResult } from './session/commands.js';
export { convertToKind, turnCommands, wrapBlocks, wrappable, type KindRow } from './kinds.js';
export { textToBlocks, type TextToBlocksOptions } from './clipboard/textBlocks.js';
export type {
	Suggestion,
	Suggestions,
	SuggestionAt,
	SuggestionContent,
	SuggestionOptions,
	SuggestionRange,
	SuggestionStatus,
	SuggestionsAt,
	ResolvedAt
} from './session/suggestions.svelte.js';

// ── The bundled plugins ────────────────────────────────────────────────
export {
	richTextPlugin,
	richTextOperations,
	richTextPlaceholder,
	arrowMovePlugin,
	codePlugin,
	createCodePlugin,
	CODE_LANGUAGES,
	loadCodeLanguage,
	type CodeLanguage,
	type CodePluginOptions,
	markdownShortcutsPlugin,
	BLOCK_ACTIVATE_EVENT,
	BLOCK_ADD_EVENT,
	type BlockActivation,
	type BlockAddition,
	blockHandlesPlugin,
	createBlockHandlesPlugin,
	type BlockHandleActivation,
	type BlockHandlesOptions,
	type BlockHandleSnippetPayload,
	type BlockHandleController,
	slashMenuPlugin,
	createSlashMenuPlugin,
	type SlashMenuOptions,
	type SlashMenuItem,
	type SlashMenuController,
	toolbarPlugin,
	createToolbarPlugin,
	TOOLBAR_COLORS,
	type ToolbarOptions,
	type ToolbarController,
	blockMenuPlugin,
	createBlockMenuPlugin,
	type BlockMenuOptions,
	type BlockMenuController,
	type BlockMenuAction,
	suggestionsPlugin,
	createSuggestionsPlugin,
	type SuggestionsOptions,
	type SuggestionBarPayload,
	imagePlugin,
	createImagePlugin,
	isImagePlugin,
	safeImageSrc,
	storableImageSrc,
	MAX_INLINE_IMAGE_BYTES,
	type ImagePluginOptions,
	columnsPlugin,
	createColumnsPlugin,
	isColumnsPlugin,
	type ColumnsPluginOptions,
	embedPlugin,
	createEmbedPlugin,
	EMBED_PROVIDERS,
	EMBED_SANDBOX,
	EMBED_ALLOW,
	embedSourceOf,
	type EmbedProvider,
	type EmbedPluginOptions,
	bookmarkPlugin,
	createBookmarkPlugin,
	type BookmarkPluginOptions,
	type BookmarkPreview,
	filePlugin,
	createFilePlugin,
	videoPlugin,
	createVideoPlugin,
	audioPlugin,
	createAudioPlugin,
	safeWebUrl,
	safeMediaSrc,
	type MediaPluginOptions,
	findPlugin,
	createFindPlugin,
	findController,
	findMatches,
	type FindPluginOptions,
	type FindController,
	type ReplaceMatches,
	type FindMatch,
	type FindOptions
} from './plugins/index.js';

// ── The document ───────────────────────────────────────────────────────
//
// The application names of `edytor/crdt/edytor`: a Svelte app builds,
// loads and catches its documents from here. The facade's full vocabulary
// stays on that entry.
export {
	EdytorDocument,
	createDocument,
	loadDocument,
	attachDocument,
	defaultSemantics,
	semanticsOf,
	mergeSemantics,
	SemanticConflictError,
	DocumentNotReadyError,
	DocumentDestroyedError,
	SchemaMismatchError,
	UndecodableUpdateError,
	UnsupportedDocError,
	SyncRefusedError,
	type CreateDocumentOptions,
	type LoadDocumentOptions,
	type DocumentActor,
	type DocumentReadiness,
	type KindSemantics,
	type JSONDoc,
	type JSONBlock,
	type JSONText,
	type JSONInlineBlock,
	type OpResult,
	type Plan,
	type Prepared,
	type DocChange
} from './crdt/index.js';

// ── Sync and presence ──────────────────────────────────────────────────
export {
	createIndexeddbSync,
	createWebsocketSync,
	clearDocument,
	prefetch,
	lastUpdated,
	documentSnapshot,
	DEFAULT_PRESENCE_THROTTLE,
	type EdytorSync,
	type EdytorSyncPayload,
	type IndexeddbSyncOptions,
	type WebsocketSync,
	type WebsocketSyncOptions,
	type PresenceOptions,
	type PresenceShare
} from './collaboration/index.js';
