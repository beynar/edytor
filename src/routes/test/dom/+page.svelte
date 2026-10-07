<script lang="ts">
	import { untrack } from 'svelte';
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
	import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
	import { createImagePlugin, imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
	import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
	import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
	import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
	import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
	import { suggestionsPlugin } from '$lib/plugins/suggestions/suggestionsPlugin.js';
	import { columnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
	import { findPlugin } from '$lib/plugins/find/findPlugin.js';
	import { embedPlugin } from '$lib/plugins/media/EmbedPlugin.svelte';
	import { bookmarkPlugin } from '$lib/plugins/media/BookmarkPlugin.svelte';
	import { propsPlugin } from '../../../tests/dom/PropsKind.svelte';
	import { clearDocument, createWebsocketSync, type EdytorSync } from '$lib/collaboration/index.js';
	import {
		IndexeddbPersistence,
		WebsocketProvider,
		checkSchema,
		storeState
	} from '$lib/crdt/protocol.js';
	import { Y } from '$lib/crdt/engine.js';
	import { createDocument } from '$lib/crdt/index.js';
	import { bindMigration } from '$lib/crdt/migration/migrate.js';
	import {
		GENERATION_KEY,
		GENERATION_RECORD,
		generationDbName
	} from '$lib/crdt/protocols/envelope.js';
	import type { EdytorDocument, JSONBlock as CrdtJSONBlock, YDoc } from '$lib/crdt/index.js';
	import { blockRecordsOf } from '../../../tests/oracles/block-records.js';
	import { cellsLib, compareView } from '../../../tests/oracles/cells-render-model.js';
	import type { JSONDoc } from '$lib/utils/json.js';
	import type { Text } from '$lib/text/text.svelte.js';
	import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
	import type { HotKey } from '$lib/session/keymap.js';
	import { anchorsInOrder } from '$lib/session/selection.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const scenarios: Record<string, JSONDoc> = {
		basic: {
			children: [
				{
					type: 'paragraph'
				},
				{
					type: 'paragraph',
					content: [{ text: 'note' }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'tail' }]
				}
			]
		},
		compositionRepeat: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'に' }]
				}
			]
		},
		callout: {
			children: [
				{
					type: 'callout',
					content: [{ text: 'task' }],
					data: { icon: '!' }
				},
				{
					type: 'paragraph',
					content: [{ text: 'after callout' }]
				}
			]
		},
		nested: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'Hello' }],
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'Nested child' }]
						},
						{
							type: 'paragraph',
							content: [{ text: 'Nested tail' }]
						}
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'After' }]
				}
			]
		},
		nestedInline: {
			children: [
				{
					type: 'paragraph',
					content: [
						{ text: 'hello', marks: { bold: true } },
						{ type: 'mention' },
						{ text: 'World', marks: { bold: true } },
						{ type: 'mention' },
						{ text: 'Prout', marks: { bold: true } }
					],
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'One', marks: { bold: true } }]
						}
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'After' }]
				}
			]
		},
		navigation: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'Start' }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'Parent' }],
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'Nested middle' }]
						}
					]
				},
				{
					type: 'image',
					content: [{ text: 'image caption' }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'Finish' }]
				}
			]
		},
		marks: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'Alpha', marks: { bold: true } }, { text: ' beta' }]
				},
				{
					type: 'paragraph',
					content: [
						{ text: 'Gamma', marks: { italic: true } },
						{ text: ' delta', marks: { underline: true } }
					]
				}
			]
		},
		// A block whose snippet edits its properties through bound inputs (0.1.0-next.6).
		props: {
			children: [
				{ type: 'paragraph', content: [{ text: 'note' }] },
				{ type: 'card', data: { title: '', done: false, tags: [] }, content: [{ text: 'card' }] }
			]
		},
		links: {
			children: [
				{
					type: 'paragraph',
					content: [
						{
							text: 'Link',
							marks: { link: { href: 'https://example.com', target: '_blank' } }
						},
						{ text: ' tail' }
					]
				}
			]
		},
		inline: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: '' }, { type: 'mention', data: {} }, { text: 'tail' }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'lead ' }, { type: 'mention', data: {} }, { text: ' end' }]
				}
			]
		},
		rtlInline: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'שלום ' }, { type: 'mention', data: {} }, { text: ' סוף' }]
				}
			]
		},
		code: {
			children: [
				{
					type: 'code',
					content: [{ text: 'caption' }],
					children: [
						{
							type: 'codeLine',
							content: [{ text: 'const a = 1;' }]
						},
						{
							type: 'codeLine',
							content: [{ text: 'return a;' }]
						}
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'after code' }]
				}
			]
		},
		void: {
			children: [
				{
					type: 'image',
					content: [{ text: 'caption' }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'after image' }]
				}
			]
		},
		// WU-21: an image 400px wide (an inline SVG: no network), then a line.
		image: {
			children: [
				{
					id: 'img',
					type: 'image',
					data: {
						src:
							'data:image/svg+xml,' +
							encodeURIComponent(
								'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#9bc"/></svg>'
							)
					},
					content: [{ text: 'caption' }]
				},
				{ id: 'after', type: 'paragraph', content: [{ text: 'after image' }] }
			]
		},
		divider: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'before divider' }]
				},
				{
					type: 'divider'
				},
				{
					type: 'paragraph',
					content: [{ text: 'after divider' }]
				}
			]
		},
		lists: {
			children: [
				{
					type: 'ordered-list',
					children: [
						{
							type: 'list-item',
							content: [{ text: 'First' }]
						},
						{
							type: 'list-item',
							content: [{ text: 'Second' }],
							children: [
								{
									type: 'paragraph',
									content: [{ text: 'Nested item child' }]
								}
							]
						}
					]
				},
				{
					type: 'unordered-list',
					children: [
						{
							type: 'list-item',
							content: [{ text: 'Bullet' }]
						}
					]
				}
			]
		},
		selection: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'First block' }]
				},
				{
					type: 'paragraph',
					content: [
						{ text: 'Marked ', marks: { bold: true } },
						{ text: 'middle', marks: { italic: true } }
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'lead ' }, { type: 'mention', data: {} }, { text: ' tail' }]
				}
			]
		},
		wordNavigation: {
			children: [
				{
					type: 'paragraph',
					content: [
						{ text: 'alpha ' },
						{ text: 'bold', marks: { bold: true } },
						{ text: ' ' },
						{ type: 'mention', data: {} },
						{ text: ' rocket 🚀 tail' }
					]
				}
			]
		},
		unicode: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'A 🚀 e\u0301 Z' }]
				}
			]
		},
		// A layout of two columns between two paragraphs (`layout.*` in the delete contract).
		columns: {
			children: [
				{ id: 'P', type: 'paragraph', content: [{ text: 'before' }] },
				{
					id: 'C',
					type: 'columns',
					children: [
						{
							id: 'K1',
							type: 'column',
							children: [
								{ id: 'A', type: 'paragraph', content: [{ text: 'left one' }] },
								{ id: 'A2', type: 'paragraph', content: [{ text: 'left two' }] }
							]
						},
						{
							id: 'K2',
							type: 'column',
							children: [{ id: 'B', type: 'paragraph', content: [{ text: 'right' }] }]
						}
					]
				},
				{ id: 'Z', type: 'paragraph', content: [{ text: 'after' }] }
			]
		},
		// Deterministic block ids: two clients mounting this scenario seed the
		// identical spec set, so concurrent `init`s LWW-dedupe to one block per
		// id instead of duplicating content.
		collab: {
			children: [
				{
					type: 'paragraph',
					id: 'collab-b1',
					content: [{ text: 'alpha' }]
				},
				{
					type: 'paragraph',
					id: 'collab-b2',
					content: [{ text: 'beta' }]
				},
				{
					type: 'paragraph',
					id: 'collab-b3',
					content: [{ text: 'gamma' }]
				}
			]
		}
	};

	/**
	 * The `image` scenario's upload (WU-21): the file back as an inline image,
	 * after a short wait, so a spec sees the placeholder, then the image.
	 */
	const uploadingImagePlugin = createImagePlugin({
		upload: (file) =>
			new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => setTimeout(() => resolve(String(reader.result)), 150);
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(file);
			})
	});

	const plugins = $derived([
		...(data.find ? [findPlugin] : []),
		...(data.media ? [embedPlugin, bookmarkPlugin] : []),
		arrowMovePlugin,
		data.scenario === 'image' ? uploadingImagePlugin : imagePlugin,
		codePlugin,
		markdownShortcutsPlugin,
		mentionPlugin,
		slashMenuPlugin,
		toolbarPlugin,
		suggestionsPlugin,
		columnsPlugin,
		richTextPlugin,
		propsPlugin
	]);
	const collaborationTestRuntime = {
		IndexeddbPersistence,
		clearDocument,
		storeState,
		/** The v13 → v14 migrator, so specs can drive it from two tabs of one origin (F-T16). */
		migration: bindMigration(Y),
		/**
		 * Persist `doc` directly into the room's IndexedDB store — bypasses
		 * the application-schema boundary (`storeState` refuses to snapshot
		 * schema-problem docs), so specs can seed documents a CLEAN provider
		 * is expected to refuse at hydration (e.g. `meta.v = 99`).
		 */
		/**
		 * Collaboration-DST probes: state-vector diffing lets the multi-peer
		 * runner capture each peer's locally-authored update after an
		 * action, and `dumpDocument` projects the full convergent state
		 * (canonical value + attribution + lineage ring) for exact
		 * cross-peer comparison — no testid serialization shortcuts.
		 */
		stateVector: (doc: YDoc) => Y.encodeStateVector(doc),
		encodeDiff: (doc: YDoc, stateVector: Uint8Array) => Y.encodeStateAsUpdate(doc, stateVector),
		dumpDocument: (document: EdytorDocument) => {
			// A captured `TextAnchor` is only evidence the runner can re-resolve
			// if it currently resolves back to the dumped endpoint — otherwise
			// the state's stored anchor lagged the absolute selection (paths
			// that write `{text, offset}` without rebuilding the anchor), and
			// production recovery would resolve a different anchor than the
			// one captured.
			const anchorConsistent = (
				owner: unknown,
				anchor: unknown,
				text: { id?: string; isInDocument?: boolean } | null,
				offset: number | null
			): boolean => {
				if (anchor == null || text?.id == null || offset == null) return false;
				const resolved = (
					owner as {
						selection?: {
							resolveTextAnchor?: (a: unknown) => {
								text: { id?: string; isInDocument?: boolean };
								offset: number;
							} | null;
						};
					}
				)?.selection?.resolveTextAnchor?.(anchor);
				return (
					resolved != null &&
					resolved.text.isInDocument === true &&
					resolved.text.id === text.id &&
					resolved.offset === offset
				);
			};
			const value = document.facade.toJSON();
			const blocks: Record<string, unknown> = {};
			const lineage: Record<string, unknown> = {};
			const live = new Set<string>();
			const walk = (children: CrdtJSONBlock[]) => {
				for (const child of children) {
					if (child.id !== undefined) {
						live.add(child.id);
						const attribution = document.attribution.block(child.id);
						blocks[child.id] = attribution
							? {
									createdBy: attribution.createdBy,
									contributors: [...attribution.contributors].sort(),
									lastChangedBy: attribution.lastChangedBy
								}
							: null;
						lineage[child.id] = document.attribution.history(child.id) ?? null;
					}
					if (child.children) walk(child.children);
				}
			};
			walk(value.children);
			// Attribution records survive their block's deletion — enumerate
			// them directly so a deleted block's ring and stamps enter the
			// comparison (live-tree walks can't reach them). Each entry is
			// tagged `deleted` + its incarnation stamp.
			for (const rec of blockRecordsOf(
				document.doc as unknown as Parameters<typeof blockRecordsOf>[0]
			)) {
				const deleted = !live.has(rec.id);
				const attribution = rec.attribution;
				blocks[rec.id] = {
					deleted,
					incarnation: rec.incarnation,
					createdBy: attribution?.createdBy,
					contributors: attribution ? [...attribution.contributors].sort() : [],
					lastChangedBy: attribution?.lastChangedBy
				};
				lineage[rec.id] = rec.lineage ?? null;
			}
			// The capturing peer's own model-side selection — per-peer by
			// nature, so the runner excludes it from the convergence
			// signature but bounds-checks it at barriers: a caret anchored
			// on a remotely-deleted block must recover onto live content
			// with in-range offsets. Text lengths ride along so the check
			// needs no model access.
			const owner = edytor?.document === document ? edytor : undefined;
			const selectionState = owner?.selection?.state ?? null;
			const selectionValue = owner?.selection.value;
			// The endpoints' relative anchors in document order (`end` only for a range).
			const [startAnchor, endAnchor] =
				owner && selectionValue?.kind === 'text'
					? anchorsInOrder(selectionValue, owner.selection.projection)
					: [null, null];
			const selectedBlockIds = owner
				? [...owner.selection.selectedBlocks].map((block) => block.id)
				: [];
			const hasSelection =
				selectionState !== null &&
				(selectionState.startText !== null ||
					selectionState.startBlock !== null ||
					selectedBlockIds.length > 0);
			// Per-block first/last EDITABLE text identity.
			// `firstEditableText`/`lastEditableText` descend past noneditable
			// children and skip container phantom slots — the returned text
			// can belong to a descendant block, so the dump records the
			// text's actual OWNING block (`firstOwner`/`lastOwner`)
			// alongside: a seam endpoint must compare against the
			// descendant's block id, not the container's. `textContents`
			// maps every live text part id to its content — the
			// passive-selection oracle needs it to distinguish an
			// untouched endpoint text from an edited one.
			const blockTexts: Record<
				string,
				{
					firstId: string | null;
					firstOwner: string | null;
					lastId: string | null;
					lastOwner: string | null;
					lastLen: number | null;
				}
			> = {};
			const textContents: Record<string, string> = {};
			// Live text part id → containing block id, derived from the
			// TRAVERSAL (which block's `content` array holds the part) —
			// never from `part.parent`, which is the very pointer a
			// stale-parent corruption breaks. `textClaims` records each
			// part's claimed parent separately so the runner can flag a
			// claim/containment mismatch on ANY live part, selected or not.
			const textOwners: Record<string, string> = {};
			const textClaims: Record<string, string | null> = {};
			// Whether the part held a DOM node AT DUMP TIME — a container's
			// phantom text never mounts; a temporarily-unmounted editable
			// text only exists inside a settle window (the F2 recovery
			// defers until it mounts), so `false` at a barrier is never a
			// legal settled endpoint.
			const textMounted: Record<string, boolean> = {};
			if (owner?.root) {
				type DumpText = {
					id: string;
					length: number;
					stringContent?: string;
					parent?: { id: string };
					node?: unknown;
				};
				// `first`/`last` resolve before the descendant's `content` is
				// walked, so their owners land in `textOwners` only after the
				// traversal completes — defer via `pendingOwners`.
				const pendingOwners: {
					blockId: string;
					key: 'firstOwner' | 'lastOwner';
					textId: string;
				}[] = [];
				const walkWrapper = (block: {
					id: string;
					firstEditableText: DumpText | null;
					lastEditableText: DumpText | null;
					content: DumpText[];
					children: unknown[];
				}) => {
					// `firstEditableText`/`lastEditableText` — the same getters
					// production's dead-endpoint seam walk uses. They skip
					// container phantom slots and noneditable children, so the
					// seam expectation lands where recovery actually lands.
					// Contentless/void hosts throw — a textless sibling is not a
					// landing spot.
					const editableTextOf = (pick: (b: typeof block) => DumpText | null): DumpText | null => {
						try {
							return pick(block);
						} catch {
							return null;
						}
					};
					const first = editableTextOf((b) => b.firstEditableText);
					const last = editableTextOf((b) => b.lastEditableText);
					blockTexts[block.id] = {
						firstId: first?.id ?? null,
						firstOwner: null,
						lastId: last?.id ?? null,
						lastOwner: null,
						lastLen: last?.length ?? null
					};
					if (first) pendingOwners.push({ blockId: block.id, key: 'firstOwner', textId: first.id });
					if (last) pendingOwners.push({ blockId: block.id, key: 'lastOwner', textId: last.id });
					for (const part of block.content ?? []) {
						if (typeof part.stringContent === 'string') {
							textContents[part.id] = part.stringContent;
							// Containment wins: the part physically sits in THIS
							// block's content list. The claimed parent rides along
							// for the mismatch check.
							textOwners[part.id] = block.id;
							textClaims[part.id] = part.parent?.id ?? null;
							textMounted[part.id] = part.node != null;
						}
					}
					for (const child of block.children) {
						walkWrapper(
							child as {
								id: string;
								firstEditableText: DumpText | null;
								lastEditableText: DumpText | null;
								content: DumpText[];
								children: unknown[];
							}
						);
					}
				};
				for (const child of owner.root.children) {
					walkWrapper(
						child as {
							id: string;
							firstEditableText: DumpText | null;
							lastEditableText: DumpText | null;
							content: DumpText[];
							children: unknown[];
						}
					);
				}
				// Resolve editable-text owners from the traversal-derived
				// map — a container's `firstEditableText` can live inside a
				// descendant's content, which only lands in `textOwners`
				// once the walk reaches it.
				for (const { blockId, key, textId } of pendingOwners) {
					blockTexts[blockId][key] = textOwners[textId] ?? null;
				}
			}
			return {
				value,
				blocks,
				lineage,
				blockTexts,
				textContents,
				textOwners,
				textClaims,
				textMounted,
				actor: document.actor.id,
				selection: hasSelection
					? {
							kind: selectedBlockIds.length > 0 ? ('block' as const) : ('text' as const),
							startBlockId:
								selectionState.startText?.parent?.id ?? selectionState.startBlock?.id ?? null,
							endBlockId: selectionState.endText?.parent?.id ?? selectionState.endBlock?.id ?? null,
							startTextId: selectionState.startText?.id ?? null,
							endTextId: selectionState.endText?.id ?? null,
							// The endpoint's relative anchor — re-resolving it on the
							// converged document IS production's recovery contract;
							// the runner's exact check compares the landed position
							// to this resolution (or to the repair seam when the
							// anchor is unresolvable).
							startAnchor,
							endAnchor: selectionState.isCollapsed ? null : endAnchor,
							// The anchors are only production's
							// recovery input when the remote update touched the
							// endpoint — and can lag the absolute position (the
							// caret's last write may predate the anchor's). An
							// anchor is only trustworthy evidence when it resolves
							// HERE to the dumped endpoint position right now.
							startAnchorOk: anchorConsistent(
								owner,
								startAnchor,
								selectionState.startText,
								selectionState.yStart
							),
							endAnchorOk: anchorConsistent(
								owner,
								selectionState.isCollapsed ? null : endAnchor,
								selectionState.endText,
								selectionState.yEnd
							),
							yStart: selectionState.yStart,
							yEnd: selectionState.yEnd,
							startTextLen: selectionState.startText?.length ?? null,
							endTextLen: selectionState.endText?.length ?? null,
							isCollapsed: selectionState.isCollapsed,
							selectedBlockIds
						}
					: null
			};
		},
		/**
		 * Every backing text's live stream boundaries (R2): item id, the
		 * block each starts, its incarnation nonce and live index, plus the
		 * text's live length. Replica-independent inputs: equal documents
		 * must report equal rows on every peer.
		 */
		probeStreams: (document: EdytorDocument) => {
			const registry = (document.doc as any).get('blocks');
			const out: Record<string, unknown> = {};
			for (const key of registry.attrKeys()) {
				const text = registry.getAttr(key)?.getAttr?.('content');
				if (!text) continue;
				const rows: unknown[] = [];
				let at = 0;
				for (let it = text._start; it !== null; it = it.right) {
					if (it.deleted || !it.countable) continue;
					(it.content?.arr ?? []).forEach((v: { s?: unknown; n?: unknown }, j: number) => {
						if (typeof v?.s === 'string')
							rows.push({ id: `${it.id.client}:${it.id.clock + j}`, s: v.s, n: v.n, at: at + j });
					});
					at += it.length;
				}
				out[key] = { bounds: rows, textLen: at };
			}
			return out;
		},
		seedDocument: async (name: string, doc: YDoc) => {
			const update = Y.encodeStateAsUpdate(doc as Parameters<typeof Y.encodeStateAsUpdate>[0]);
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(generationDbName(name), 1);
				request.onupgradeneeded = () => {
					request.result.createObjectStore('updates', { autoIncrement: true });
					request.result.createObjectStore('custom');
				};
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				await new Promise<void>((resolve, reject) => {
					const transaction = db.transaction(['updates', 'custom'], 'readwrite');
					transaction.objectStore('custom').put({ ...GENERATION_RECORD }, GENERATION_KEY);
					const stored = new Uint8Array(update.byteLength);
					stored.set(update);
					transaction.objectStore('updates').add(stored.buffer);
					transaction.oncomplete = () => resolve();
					transaction.onerror = () => reject(transaction.error);
				});
			} finally {
				db.close();
			}
		}
	};

	/**
	 * `?collab=<room>` mounts the editor on the real provider stack:
	 * `IndexeddbPersistence` gives IndexedDB persistence AND BroadcastChannel
	 * cross-context sync (channel = db name) — no external relay. The provider
	 * is exposed on `window.__EDYTOR_COLLAB__` so specs can partition the room
	 * (`disconnectBc`/`connectBc`) or force a state flush (`storeState`).
	 */
	// `data` is a static load() payload for this navigation, so the initial
	// `data.collab`/`data.collabws` reads are intentionally untracked.
	const handBuiltSync: EdytorSync | undefined = untrack(
		() => data.collab || (data.collabws && data.wsserver)
	)
		? ({ doc, awareness, synced }) => {
				// `?collabws=<room>&wsserver=<ws-url>` mounts the REAL websocket
				// provider against the spec-driven local opaque relay
				// (tests/editor-dom/ws-relay.ts). The websocket provider has no
				// BroadcastChannel leg (D-24 G-e), so nothing can mask a socket
				// failure — the only transport is the socket. `resyncInterval` is
				// off unless a spec passes `wsresync`: the join rule makes every
				// member hear the room, and the periodic resync only heals
				// deliberate harness loss (dropped frames).
				const provider =
					data.collabws && data.wsserver
						? new WebsocketProvider(data.wsserver, data.collabws, doc, {
								awareness,
								resyncInterval: data.wsresync,
								maxBackoffTime: data.wsbackoff
							})
						: new IndexeddbPersistence(`edytor-collab-${data.collab!}`, doc, {
								awareness
							});
				// Production stacks BOTH providers: websocket sync alone gives
				// offline edits nowhere to survive a reload. IndexeddbPersistence
				// is per-context here (each browser context has isolated storage),
				// so a reloaded peer rehydrates its own un-synced updates and the
				// socket re-delivers them to the room.
				const persistence =
					data.collabws && data.wsserver
						? new IndexeddbPersistence(`edytor-collabws-${data.collabws}`, doc)
						: null;
				// Debug surface for the collab DST — every doc update with its
				// origin and the schema-gate verdict at emit time. Lets the
				// runner distinguish "quarantined while unversioned" from
				// "never persisted" on lost-update failures.
				(window as Window & { __EDYTOR_UPDATE_LOG__?: unknown[] }).__EDYTOR_UPDATE_LOG__ = [];
				doc.on('update', (update: Uint8Array, origin: unknown) => {
					(window as Window & { __EDYTOR_UPDATE_LOG__?: unknown[] }).__EDYTOR_UPDATE_LOG__?.push({
						bytes: update.length,
						origin: String(origin),
						isProvider: origin === provider,
						isIdb: origin === persistence,
						gate: checkSchema(doc as unknown as Parameters<typeof checkSchema>[0])?.kind ?? null,
						t: Date.now()
					});
				});
				(
					window as Window & {
						__EDYTOR_COLLAB__?: {
							provider:
								| InstanceType<typeof IndexeddbPersistence>
								| InstanceType<typeof WebsocketProvider>;
						};
						__EDYTOR_SYNC_ERROR__?: unknown;
					}
				).__EDYTOR_COLLAB__ = { provider };
				let fired = false;
				// Readiness requires BOTH transports settled: the socket's
				// 'synced' AND the local store's `whenSynced`. A ws-sync that
				// beats IndexedDB hydration must not seed the pending doc —
				// a refused hydration landing a tick later would leave the
				// fixture mounted over refused data.
				let persistenceReady = persistence === null;
				const fireSynced = () => {
					if (fired || !persistenceReady) {
						return;
					}
					// A failed hydration is terminal: `loadError` (a container of
					// another generation, a load failure) means the stored state
					// was rejected — seeding the pending doc now would mount the
					// fixture over refused data and report a refused sync as a
					// successful one. (A forged stamp that hydrated is refused by
					// `document.sync()` admission below.)
					const refusal = persistence == null ? null : persistence.loadError;
					if (refusal != null) {
						fired = true;
						(window as Window & { __EDYTOR_SYNC_ERROR__?: unknown }).__EDYTOR_SYNC_ERROR__ =
							refusal;
						return;
					}
					fired = true;
					try {
						synced(provider);
					} catch (error) {
						// Schema-gate refusal surfaces here instead of an async
						// unhandled rejection, so specs can assert it deterministically.
						(window as Window & { __EDYTOR_SYNC_ERROR__?: unknown }).__EDYTOR_SYNC_ERROR__ = error;
					}
				};
				// `document.sync(value)` seeds only while pending, so a reload
				// hydrates from IndexedDB and skips the seed entirely (a
				// re-seed's fresh items would LWW-win the registry election
				// and revert room state), while an empty store seeds
				// immediately. A REJECTED whenSynced is a refused hydration —
				// it goes to the failure channel, never the readiness path.
				if (persistence !== null) {
					void persistence.whenSynced.then(
						() => {
							persistenceReady = true;
							fireSynced();
						},
						(error) => {
							(window as Window & { __EDYTOR_SYNC_ERROR__?: unknown }).__EDYTOR_SYNC_ERROR__ =
								error;
						}
					);
				}
				(provider as { on(name: 'synced', listener: () => void): void }).on('synced', fireSynced);
				// Schema-boundary refusal at hydration suppresses `synced` and
				// rejects `whenSynced` (docs/crdt-v14-providers.md) — mirror the
				// refusal into the same channel so specs observe it.
				if ('whenSynced' in provider) {
					provider.whenSynced.catch((error) => {
						(window as Window & { __EDYTOR_SYNC_ERROR__?: unknown }).__EDYTOR_SYNC_ERROR__ = error;
					});
				}
				return () => {
					void persistence?.destroy();
					void provider.destroy();
				};
			}
		: undefined;

	// `?wssync=factory` swaps the hand-built stack for the library's
	// `createWebsocketSync` (its default local store; `wspersist=off` opts out).
	const collabSync: EdytorSync | undefined = untrack(() =>
		data.wssync === 'factory' && data.collabws && data.wsserver
			? createWebsocketSync({
					serverUrl: data.wsserver,
					roomName: data.collabws,
					maxBackoffTime: data.wsbackoff,
					persist: data.wspersist !== 'off'
				})
			: handBuiltSync
	);

	let edytor = $state<EdytorContext>();
	let secondaryEdytor = $state<EdytorContext>();

	const getScenarioValue = (
		scenario: string,
		emptyPosition: string | null,
		dstDocument: JSONDoc | undefined
	) => {
		const value = structuredClone(dstDocument ?? scenarios[scenario] ?? scenarios.basic);

		if (scenario === 'basic') {
			const paragraphs = value.children;
			const nonEmptyValues = ['lead', 'note', 'tail'];
			const emptyIndex = emptyPosition === 'middle' ? 1 : emptyPosition === 'last' ? 2 : 0;

			paragraphs.forEach((paragraph, index) => {
				if (emptyIndex === index) {
					delete paragraph.content;
					return;
				}

				paragraph.content = [{ text: nonEmptyValues[index] }];
			});
		}

		return value;
	};

	const getPartPath = (part: Text | InlineBlock) => {
		const index = part.parent.content.findIndex((candidate) => candidate.id === part.id);
		return [...part.parent.path, index === -1 ? part.index : index];
	};

	const getSelectionSnapshot = (instance: EdytorContext | undefined) => {
		if (!instance) {
			return {
				startBlockPath: null,
				endBlockPath: null,
				startTextPath: null,
				endTextPath: null,
				yStart: 0,
				yEnd: 0,
				isCollapsed: true,
				selectedBlockPaths: [],
				focusedBlockPaths: []
			};
		}

		return {
			startBlockPath: instance.selection.state.startBlock?.path ?? null,
			endBlockPath: instance.selection.state.endBlock?.path ?? null,
			startTextPath: instance.selection.state.startText
				? getPartPath(instance.selection.state.startText)
				: null,
			endTextPath: instance.selection.state.endText
				? getPartPath(instance.selection.state.endText)
				: null,
			yStart: instance.selection.state.yStart,
			yEnd: instance.selection.state.yEnd,
			isCollapsed: instance.selection.state.isCollapsed,
			selectedBlockPaths: Array.from(instance.selection.selectedBlocks).map((block) => block.path),
			focusedBlockPaths: Array.from(instance.selection.focusedBlocks).map((block) => block.path)
		};
	};

	const scenario = $derived(data.scenario);
	const value = $derived(getScenarioValue(data.scenario, data.empty, data.dstDocument));
	// Collaboration-DST injection: `?actor=`/`?lineagedepth=` make the page
	// OWN the document so each browser peer gets a deterministic local actor
	// and an enabled lineage ring — the props `createDocument` can't reach
	// through the plain `{value}` mount path. Without either param the view
	// stays on the internal-document path (`document` prop stays undefined).
	const injectedDocument = untrack(() =>
		data.actor === null && data.lineagedepth === undefined
			? undefined
			: createDocument({
					// With a sync factory attached the doc must stay PENDING
					// — `attachSync` carries `value` and `document.sync(value)`
					// seeds only when hydration (IndexedDB + room handshake)
					// found nothing. Eager seeding — even an empty `value`,
					// which still stamps the bootstrap — would mark the doc
					// `local` before the provider answers, and re-seeding on
					// reload lets fresh items' id election revert the room's
					// converged state.
					...(collabSync
						? {}
						: { value: getScenarioValue(data.scenario, data.empty, data.dstDocument) }),
					...(data.actor !== null ? { actor: { id: data.actor, name: data.actor } } : {}),
					...(data.lineagedepth !== undefined ? { lineage: { depth: data.lineagedepth } } : {})
				})
	);
	const secondaryValue = $derived({
		children: [
			{
				type: 'paragraph',
				content: [{ text: 'other' }]
			}
		]
	} satisfies JSONDoc);
	const placeholder = $derived(data.placeholder ?? 'Write something here ...');
	// Mounted with the URL's readonly, so a readonly view is readonly from its construction.
	let runtimeReadonly = $state(untrack(() => Boolean(data.readonly)));
	let runtimeReadonlySource = $state<string | null>(
		untrack(() => `${data.dynamicReadonly}:${data.readonly}`)
	);
	const readonly = $derived(data.dynamicReadonly ? runtimeReadonly : Boolean(data.readonly));
	$effect(() => {
		const source = `${data.dynamicReadonly}:${data.readonly}`;
		if (runtimeReadonlySource === source) {
			return;
		}

		runtimeReadonlySource = source;
		runtimeReadonly = Boolean(data.readonly);
	});
	const direction: 'ltr' | 'rtl' = $derived(data.dir === 'rtl' ? 'rtl' : 'ltr');
	const hotkeys = $derived.by(() => {
		const routeHotKeys: Record<string, HotKey> = {};

		const insertProbeText = (edytor: EdytorContext, value: string) => {
			const text = edytor.selection.state.startText;
			const offset = edytor.selection.state.yStart;
			if (!text) {
				return;
			}

			text.insertText({ value, start: offset, end: offset });
			edytor.selection.setAtTextOffset(text, offset + value.length);
		};

		if (data.enterHotkey) {
			routeHotKeys.enter = ({ edytor, prevent }) => {
				prevent(() => insertProbeText(edytor, '!'));
			};
		}

		if (data.backspaceHotkey) {
			routeHotKeys.backspace = ({ edytor, prevent }) => {
				prevent(() => insertProbeText(edytor, '?'));
			};
		}

		if (data.altGraphHotkey) {
			routeHotKeys['mod+alt+b'] = ({ edytor, prevent }) => {
				prevent(() => insertProbeText(edytor, '!'));
			};
		}

		if (data.deadKeyHotkey) {
			routeHotKeys['mod+alt+dead'] = ({ edytor, prevent }) => {
				prevent(() => insertProbeText(edytor, '!'));
			};
		}

		return Object.keys(routeHotKeys).length ? routeHotKeys : undefined;
	});
	const translate: 'yes' | 'no' = $derived(data.translate === 'yes' ? 'yes' : 'no');
	const spellcheck = $derived(data.spellcheck);
	const autocorrect: 'on' | 'off' | undefined = $derived(
		data.autocorrect === 'on' || data.autocorrect === 'off' ? data.autocorrect : undefined
	);
	const autocomplete: 'on' | 'off' | undefined = $derived(
		data.autocomplete === 'on' || data.autocomplete === 'off' ? data.autocomplete : undefined
	);
	const autocapitalize = $derived.by(() => {
		const value = data.autocapitalize;
		if (
			value === 'off' ||
			value === 'none' ||
			value === 'on' ||
			value === 'sentences' ||
			value === 'words' ||
			value === 'characters'
		) {
			return value;
		}
		return undefined;
	});
	const serializedValue = $derived(JSON.stringify(edytor?.value ?? { type: 'root', children: [] }));
	const serializedSelection = $derived(JSON.stringify(getSelectionSnapshot(edytor)));
	const serializedSecondaryValue = $derived(
		JSON.stringify(secondaryEdytor?.value ?? { type: 'root', children: [] })
	);
	const serializedSecondarySelection = $derived(
		JSON.stringify(getSelectionSnapshot(secondaryEdytor))
	);

	// arch-v2 R1/R2: the cells the editor renders, compared on demand with a fresh build.
	$effect(() => {
		const view = edytor;
		if (!data.cells || !view || !cellsLib) return;
		(window as Window & { __EDYTOR_CELLS__?: () => unknown }).__EDYTOR_CELLS__ = () =>
			view.cells ? compareView(view, view.cells) : null;
	});

	$effect(() => {
		if (typeof window !== 'undefined') {
			(
				window as Window & {
					__EDYTOR__?: EdytorContext;
					__SECOND_EDYTOR__?: EdytorContext;
					__EDYTOR_COLLABORATION_TEST__?: typeof collaborationTestRuntime;
				}
			).__EDYTOR__ = edytor;
			(
				window as Window & {
					__EDYTOR_COLLABORATION_TEST__?: typeof collaborationTestRuntime;
				}
			).__EDYTOR_COLLABORATION_TEST__ = collaborationTestRuntime;
			if (data.secondary) {
				(
					window as Window & {
						__SECOND_EDYTOR__?: EdytorContext;
					}
				).__SECOND_EDYTOR__ = secondaryEdytor;
			}
		}
	});
</script>

<div class="grid gap-4 p-6">
	<div data-testid="scenario">{scenario}</div>
	{#if data.dynamicReadonly}
		<button
			type="button"
			data-testid="toggle-readonly"
			aria-pressed={readonly}
			onclick={() => {
				runtimeReadonly = !runtimeReadonly;
			}}
		>
			{readonly ? 'Set editable' : 'Set readonly'}
		</button>
	{/if}
	<div data-testid="editor-shell" dir={direction}>
		<Edytor
			bind:edytor
			{plugins}
			defaultPlugins={false}
			blockDnd={data.handles}
			document={injectedDocument}
			{value}
			{readonly}
			{translate}
			{spellcheck}
			{autocorrect}
			{autocomplete}
			{autocapitalize}
			{hotkeys}
			sync={collabSync}
			class="outline-none"
			{placeholder}
		/>
	</div>
	{#if data.secondary}
		<div data-testid="secondary-editor-shell" dir={direction}>
			<Edytor
				bind:edytor={secondaryEdytor}
				{plugins}
				defaultPlugins={false}
				blockDnd={data.handles}
				value={secondaryValue}
				{translate}
				{spellcheck}
				{autocorrect}
				{autocomplete}
				{autocapitalize}
				class="outline-none"
				placeholder="Second editor"
			/>
		</div>
		<pre data-testid="secondary-value">{serializedSecondaryValue}</pre>
		<pre data-testid="secondary-selection">{serializedSecondarySelection}</pre>
	{/if}
	<pre data-testid="value">{serializedValue}</pre>
	<pre data-testid="selection">{serializedSelection}</pre>
</div>
