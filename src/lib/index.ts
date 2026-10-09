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
	KindMenuAction,
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
	Prevent,
	InputRule,
	InputRuleContext,
	Trigger,
	TriggerContext,
	TriggerItemPayload,
	TextRuleContext
} from './plugins.js';
export type { Caret } from './selection/selection.svelte.js';
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
	createRichTextPlugin,
	richTextOperations,
	richTextPlaceholder,
	createRichTextPlaceholder,
	CALLOUT_ICONS,
	type CalloutIconPicker,
	type CalloutIconOption,
	type RichTextPluginOptions,
	arrowMovePlugin,
	codePlugin,
	createCodePlugin,
	CODE_LANGUAGES,
	loadCodeLanguage,
	type CodeLanguage,
	type CodePluginOptions,
	type CodeHeader,
	type LanguageMenu,
	type LanguageMenuItem,
	type LanguageRow,
	markdownShortcutsPlugin,
	createMentionPlugin,
	type MentionItem,
	type MentionData,
	type MentionPluginOptions,
	createPageLinkPlugin,
	type PageLinkItem,
	type PageLinkData,
	type PageLinkPluginOptions,
	type TriggerMenuController,
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
	type BlockMenuColor,
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
	type MediaKind,
	type MediaPluginOptions,
	type MediaEmptyController,
	type MediaEmptyFailure,
	type UrlPasteController,
	type UrlPasteOffer,
	type UrlPasteOption,
	type ImageControls,
	type ImageBox,
	type ImageEmptyController,
	type ImageEmptyFailure,
	type MenuItemPayload,
	type OptionAttributes,
	findPlugin,
	createFindPlugin,
	findController,
	findMatches,
	type FindPluginOptions,
	type FindController,
	type ReplaceMatches,
	type FindMatch,
	type FindOptions,
	createCommentsPlugin,
	commentsController,
	type CommentsPluginOptions,
	type CommentCardPayload,
	type CommentsController,
	type CommentDraft,
	type CommentNotice,
	type CommentUser,
	type PlacedThread,
	pagePlugin,
	createPagePlugin,
	type PagePluginOptions,
	tocPlugin,
	createTocPlugin,
	type TocPluginOptions,
	type TocHeadingLevel,
	tablePlugin,
	createTablePlugin,
	isTablePlugin,
	type TablePluginOptions,
	type TableChrome,
	type TableMenu,
	type TableMenuRow,
	type TableMenuItem,
	type TableGripPayload,
	type TableAddPayload,
	tableBlock,
	type TableBlockOptions,
	createEquationPlugin,
	KATEX_CDN,
	KATEX_VERSION,
	type EquationPluginOptions,
	type EquationData,
	type EquationEditor,
	type EquationTarget,
	type KatexLike,
	type KatexLoader
} from './plugins/index.js';
export { BLOCK_COLORS, setBlockColor, type BlockColorField } from './block/colors.js';

// ── Localization ───────────────────────────────────────────────────────
export { englishLabels, type Labels, type PartialLabels } from './labels.js';

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

// ── Comment threads ────────────────────────────────────────────────────
export {
	createCommentsClient,
	createMemoryCommentsClient,
	CommentRequestError,
	commentAnchors,
	type CommentDocument,
	type CommentFeed,
	type CommentResult,
	type CommentsClient,
	type CommentsClientOptions,
	type MemoryCommentsClient,
	type MemoryCommentsClientOptions,
	type CommentChange,
	type CommentRequest,
	type CommentRun,
	type CommentSnapshot,
	type CommentThread,
	type ThreadComment
} from './collaboration/comments/index.js';

// ── Version history ────────────────────────────────────────────────────
export {
	HistoryPanel,
	createHistoryClient,
	HistoryRequestError,
	versionDiff,
	defaultHistoryLabels,
	type HistoryClient,
	type HistoryClientOptions,
	type HistoryRestoreResult,
	type HistoryUndoResult,
	type HistoryVersion,
	type HistoryPanelLabels,
	type HistoryPanelProps,
	type VersionChange,
	type VersionDiff
} from './collaboration/history/index.js';

// ── Types the exports above use ────────────────────────────────────────
// The types a consumer meets through a prop, an option, a member or a
// callback above, exported so an app can name them.
export type { EdytorProps } from './components/Edytor.svelte';
export type { EdytorOptions, Snippets } from './edytor.svelte.js';
export type { HistoryVersionItem } from './collaboration/history/index.js';
export type {
	BlockHandlesLabels,
	BlockMenuLabels,
	CodeLabels,
	ColumnsLabels,
	CommentsLabels,
	EditorLabels,
	EquationLabels,
	FindLabels,
	ImageLabels,
	MediaKindLabels,
	MediaLabels,
	MentionLabels,
	PageLabels,
	PageLinkLabels,
	RichTextLabels,
	SlashMenuLabels,
	SuggestionsLabels,
	TableLabels,
	TocLabels,
	ToolbarLabels
} from './labels.js';
export type {
	BlockElement,
	BlockView,
	InitializedPlugin,
	InlineBlockView,
	PluginDefinitions,
	PluginOperations
} from './plugins.js';
export type { Dispatcher } from './session/commands.js';
export type {
	PresenceSelection,
	SelectionPoint,
	SelectionProjection,
	SelectionSegment,
	SelectionValue
} from './session/selection.js';
export type { SelectionState, TextAnchor } from './selection/selection.svelte.js';
export type { Key, Modifier, Modifiers } from './session/keymap.js';
export type { TextOperations } from './text/text.utils.js';
export type { BlockBeside, BlockOperations } from './block/block.utils.js';
export type {
	TextInsertionPayload,
	TriggerRange
} from './plugins/triggers/TriggerController.svelte.js';
export type { RichTextLink, RichTextMark } from './plugins/richtext/richTextOperations.js';
export type { UploadReport, Uploader } from './plugins/uploads.svelte.js';
export type { AwarenessLike, PresenceWriter } from './collaboration/awarenessSelection.js';
export type { DataPatch } from './crdt/data.js';
export type { AnchorAffinity, BlockRole, DocAnchor, TextRange } from './crdt/doc/types.js';
export type { Flow, FlowLine, FlowTarget } from './crdt/flow.js';
export type { DocumentOperations, DocumentReads, DocumentWrites } from './crdt/operations.js';
export type {
	BlockId,
	BlockSpec,
	ContentItem,
	Destination,
	InlineSpec,
	ProjectedBlock,
	ProjectedDoc,
	SplitTail
} from './crdt/placement/model.js';
export type { DocPosition, RangeView } from './crdt/rangeDelete.js';
export type { FlowView } from './crdt/flow.js';
export type { ContentRun } from './crdt/text/runs.js';
export type { DataTarget, OrderPolicy, PlanEffect, PlanStep } from './crdt/doc/types.js';
export type { DocBlock, NodeRef } from './crdt/nodes.js';
export type { MarkEdge } from './crdt/text/marks.js';
export type { Cell, Cells } from './surface/cells.js';
export type { Measure, Overlay } from './surface/overlay.js';
export type { Popup, PopupOpener, Popups } from './surface/popups.svelte.js';
export type { Announcer } from './session/announcer.svelte.js';
export type { Handles } from './session/handles.js';
export type { DocumentSemanticsConfig } from './crdt/document.js';
export type { KindRecord, MergedSemantics } from './crdt/semantics.js';
export type { SchemaProblem } from './crdt/doc/gate.js';
export type {
	Awareness,
	AwarenessStates,
	AwarenessUpdate,
	MetaClientState
} from './crdt/protocols/awareness.js';
export type { DocumentOptions } from './crdt/document.js';
export type {
	ActorProfile,
	AttributionActor,
	BlockLineageEntry,
	DocumentAttribution
} from './crdt/attribution/attribution.js';
export type { ActorId, BlockAttribution } from './crdt/attribution/block.js';
export type { CommentMessage } from './crdt/protocols/comments.js';
export type {
	EdytorSyncCleanup,
	LastUpdatedOptions,
	PrefetchOptions,
	PrefetchResult,
	WebsocketTarget
} from './crdt/providers/index.js';
export type { ProtocolMismatch, SchemaMismatchDetail } from './crdt/providers/room.js';
