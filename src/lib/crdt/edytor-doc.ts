/**
 * EdytorDoc (U06) — the assembled document model.
 *
 * This module binds the three proven engine layers over ONE Y.Doc into the
 * single public surface the command layer (U08) and providers (U07) consume:
 *
 * - `placement/model.ts` (`bindModel`) — stable block registry + placement
 *   candidates; identity-preserving move/nest/split/merge (U03).
 * - `text/model.ts` (`bindText`) — stable backing texts delimited by stream
 *   boundaries + merge claims (R2); split/merge never copy text.
 * - `text/runs.ts` (`bindRuns`) — the maintained run view: immutable run
 *   snapshots, structural sharing, the change report (U05, D9).
 *
 * The schema gate and manifest live in `doc/gate.ts`, the version record
 * and the deterministic seed in `doc/seed.ts`, the public types in
 * `doc/types.ts` and the pure plan helpers in `doc/plan.ts`.
 *
 * ── Identity discipline ────────────────────────────────────────────────
 *
 * Relocation (move/nest/unnest/split/merge/delete-with-children) preserves
 * block AND atom identity — the U03/U04 contract. New identity is created
 * ONLY by ops whose purpose is fresh identity: `insertBlock`
 * (caller-assigned ids; nested spec children included), `duplicateBlock`
 * (explicit fresh ids for paste/drag-clone), and `setBlock` content/children
 * replacement (baseline `setBlock` semantics — replacement is a new-identity
 * operation).
 */
import { setMarkEdges, type MarkEdge } from './text/marks.js';
import { isIncarnationId } from './incarnations.js';
import { DEV } from 'esm-env';
import type { EngineApi, EngineDoc, EngineNode, YDoc, YNode, YUndoManager } from './engine-api.js';
import { hash32, randOf, setDocRand } from './rand.js';
import {
	AT,
	BLOCK_NODE,
	DATA,
	DATA_LEAF_PREFIX,
	DEL_PREFIX,
	DOC_DATA_ROOT,
	HORIZON_ROOT,
	ID,
	INLINE_NODE,
	isNodeLike,
	LAST_CHANGED_ATTR,
	TYPE,
	SCHEMA
} from './schema.js';
import {
	bindModel,
	displayParentOf,
	displaySlotOf,
	isLiveIn,
	promotedRank,
	sourceRank,
	SOURCE_SIDE,
	type BlockId,
	type BlockSpec,
	type ContentItem,
	type Destination,
	type InlineSpec,
	type ModelView,
	type ProjectedBlock,
	type SplitTail
} from './placement/model.js';
import {
	bindText,
	DEAD,
	displayOf,
	locate,
	ownedLength,
	ownTextIds,
	type Anchor
} from './text/model.js';
import { bindDeletes } from './text/deletes.js';
import { bindPurge, readHorizon } from './purge.js';
import { restoreDocument } from './restore.js';
import {
	bindRuns,
	ENTRY_FACET,
	type ContentRun,
	type DisplayRoles,
	type Folded,
	type IndexReport,
	type RunView
} from './text/runs.js';
import { callEach } from './protocols/observable.js';
import { bindNodes, type DocBlock } from './nodes.js';
import {
	followRedone,
	holdsPending,
	walkIdSetStructs,
	type IdSetLike,
	type StoreStruct
} from './structs.js';
import {
	bindBlockAttribution,
	blockAttributionOf,
	type BlockAttribution
} from './attribution/block.js';
import type { AttributionActor } from './attribution/index.js';
import { isLegacyDoc } from './migration/legacy-schema.js';
import { rangeDeleteOps, type DocPosition } from './rangeDelete.js';
import { flowOps, type FlowContext } from './flow.js';
import {
	dataLeaves,
	isObject,
	itemIds,
	leafKey,
	patchWrites,
	readData,
	writeLeaves,
	type DataPatch,
	type LeafWrite
} from './data.js';
import { id as newId } from '../utils.js';
import {
	asBlockSpec,
	cloneJsonSafe,
	jsonBlockToSpec,
	jsonEquals,
	sanitizeSpec,
	sanitizeWireJson,
	sanitizeWireString,
	type JSONBlock,
	type JSONDoc
} from '../utils/json.js';

import {
	assertSchema,
	assertUsableDoc,
	checkSchema,
	isInitialized,
	META_KEY,
	registryEmpty,
	SCHEMA_NAME,
	SCHEMA_VERSION,
	SchemaMismatchError,
	schemaVersion
} from './doc/gate.js';
import { bindSeed } from './doc/seed.js';
import { docReads, type DocBase } from './doc/reads.js';
import { docCapability } from './doc/capability.js';
import { writeFunnel } from './doc/funnel.js';
import { docEvents } from './doc/events.js';
import { docHistory } from './doc/history.js';
import { docAnchors } from './doc/anchors.js';
import { planSteps } from './doc/steps.js';
import { metaOps } from './doc/meta.js';
import { deleteOps } from './doc/delete.js';
import { splitMergeOps } from './doc/split-merge.js';
import { layoutOps } from './doc/layout.js';
import { moveOps } from './doc/moves.js';
export { EdytorDocDisposedError, lineageDepthOf } from './doc/funnel.js';
export { DEFAULT_HISTORY_LIMIT } from './doc/history.js';
import {
	applied,
	effectOf,
	EMPTY_IDS,
	NOOP,
	ref,
	refused,
	sanitizeInline,
	sanitizeItem
} from './doc/plan.js';
import type {
	AnchorAffinity,
	BlockRole,
	DataTarget,
	DocAnchor,
	DocChange,
	EdytorDocConfig,
	JsonObj,
	OpResult,
	OrderPolicy,
	Plan,
	PlanEffect,
	PlanStep,
	Prepared,
	TextRange
} from './doc/types.js';

// ── schema manifest and gate (`doc/gate.ts`) ────────────────────────────

export { SCHEMA };
export {
	assertSchema,
	assertUsableDoc,
	checkSchema,
	isInitialized,
	META_KEY,
	registryEmpty,
	SCHEMA_NAME,
	SCHEMA_VERSION,
	SchemaMismatchError,
	schemaVersion
};
export { UnsupportedDocError, type SchemaProblem } from './doc/gate.js';
export { SEED_ORIGIN } from './doc/seed.js';
export type {
	AnchorAffinity,
	BlockRole,
	DataTarget,
	DocAnchor,
	DocChange,
	EdytorDocConfig,
	OpResult,
	OrderPolicy,
	Plan,
	PlanEffect,
	PlanStep,
	Prepared,
	TextRange
};

export type EdytorDoc = ReturnType<EdytorDocBinding['create']>;
export type EdytorDocBinding = ReturnType<typeof bindEdytorDoc>;

/**
 * Bind the assembled model to a concrete engine surface. `Y` must be the
 * vendored v14 module — injected so this file type-checks structurally and
 * never imports vendor `.js` (see `engine-api.ts`).
 */
export const bindEdytorDoc = (Y: EngineApi) => {
	// The doc's index (`text/runs.ts`) is the one owner of derived state:
	// commands, runs, anchors, the change report and rendering read it.
	const R = bindRuns(Y);
	const M = bindModel(Y);
	const T = bindText(Y);
	const D = bindDeletes(Y);
	const P = bindPurge(Y);
	/** Each history's release of all its steps (`releaseHistory`). */
	const releasers = new WeakMap<YUndoManager, () => void>();
	// Compact per-block attribution writes (`attribution/block.ts`).
	// One bound instance per engine binding; its suppression memory is
	// per-doc (WeakMap-keyed), so facades on the same doc share it.
	const BA = bindBlockAttribution(Y);

	// ── version record / bootstrap (doc-level, facade-free) ────────────
	// `schemaVersion`, `registryEmpty`, `isInitialized`, `checkSchema` and
	// `assertSchema` are module-level (see above) — pure doc reads shared by
	// providers and migration without re-binding.
	const { restore, init, seed } = bindSeed(Y, M, BA);

	// ── per-doc facade ──────────────────────────────────────────────────

	const create = (doc: EngineDoc, config: EdytorDocConfig = {}) => {
		// Document-boundary check — foreign (v13-engine) and legacy-schema docs
		// fail fast here rather than inside the runs view (see assertUsableDoc).
		assertUsableDoc(doc);
		setMarkEdges(doc, config.markEdge ?? (() => undefined));
		const roleOf = config.roleOf ?? (() => undefined);
		const defaultType = config.defaultType ?? 'paragraph';
		const defaultChildOf = config.defaultChildOf ?? (() => undefined);
		const rendersContentOf = config.rendersContent ?? (() => true);
		const runsView: RunView = R.attach(doc);
		// The role table — the display and every guard below ask it. UW-21b:
		// a void kind displays no children — the index sheds them into its
		// slot at read time, so a child a peer nests or splits under a block
		// another peer retypes to a void shows on every replica. A block
		// promoted out of an island displays as its display parent's default
		// child, as a delete of the island retypes the ones it saw. An island
		// declared `lines` holds only lines of its `defaultChild` kind
		// (FW-01, XW-03). A layout displays only its items — its
		// `defaultChild` kind — and only two or more (`layout.*`).
		const roles: DisplayRoles = {
			childless: (type) => roleOf(type)?.void === true,
			island: (type) => roleOf(type)?.island === true,
			container: (type) =>
				!rendersContentOf(type) && roleOf(type)?.void !== true && roleOf(type)?.island !== true,
			rendersContent: (type) => rendersContentOf(type),
			defaultChild: (type) => (type !== null ? defaultChildOf(type) : undefined) ?? defaultType,
			line: (type) => {
				const role = roleOf(type);
				return role?.island === true && role.lines === true ? defaultChildOf(type) : undefined;
			},
			lineKinds: () => [...(config.kinds?.() ?? [])].flatMap((type) => roles.line(type) ?? []),
			layout: (type) => (roleOf(type)?.layout === true ? defaultChildOf(type) : undefined),
			layoutKinds: () =>
				[...(config.kinds?.() ?? [])].filter((type) => roles.layout(type) !== undefined)
		};
		if (config.roleOf) runsView.roles(roles);

		// The facade's parts, each over the ones before it (`doc/*`).
		const base: DocBase = { Y, doc, M, T, runsView, roles, roleOf, rendersContentOf };
		const reads = { ...base, ...docReads(base) };
		const shape = { ...reads, ...docCapability(reads) };
		const {
			dataNode,
			blockJSON,
			view,
			blockTypeOf,
			blockDataOf,
			docData,
			dataItemIds,
			childrenIds,
			positionOf,
			pathOf,
			ancestorsOf,
			slotOf,
			is,
			isVoid,
			isIsland,
			isLines,
			islandOf,
			insideIsland,
			isLine,
			itemKindOf,
			isLayout,
			isLayoutItem,
			holdsLayout,
			insideItem,
			order,
			compare,
			next,
			previous,
			displayLength,
			contentItems,
			hasBlock,
			live,
			contentTarget
		} = reads;
		const {
			canPlace,
			isContainer,
			fits,
			fitsIn,
			fitted,
			emptiable,
			nestParent,
			canMerge,
			rendersContent,
			defaultChild,
			kindToCopy
		} = shape;

		// Lineage ring watermark repair — concurrent partition appends can
		// merge a ring past every writer's `depth`; this converges the
		// stored ring back to the entries' own watermark after remote
		// applies. Once per doc, doc-lifetime, no-op when nothing is over.
		BA.attachRingTrim(doc);

		const funnel = writeFunnel({ ...reads, BA, config });
		const { write, apply } = funnel;
		const events = docEvents({ runsView });
		const { onChange } = events;
		const dispose = (): void => {
			funnel.dispose();
			events.close();
		};
		const { createUndoManager } = docHistory({ ...base, ...funnel, D, BA, releasers, init });
		const { anchorAt, followUndo, resolveAnchor } = docAnchors(reads);
		const steps = { ...shape, ...planSteps(shape) };
		const {
			REFUSED,
			HEAD,
			KEPT,
			WITH,
			SELF,
			AFTER,
			plan,
			ranksFor,
			moveTo,
			move,
			exitRanks,
			pieceRanks,
			leaving,
			attr,
			leavingIsland,
			settledKind,
			settle,
			landing,
			emptyingAll,
			dissolving,
			emptying,
			emptied,
			deleting,
			remove,
			merge,
			clamp,
			atomOf,
			textIn
		} = steps;
		const { dataSteps, replaceData, setBlockType, patchData, setBlock } = metaOps(steps);
		const { deleteBlocks, deleteBlock } = deleteOps(steps);
		const { splitBlock, mergeBlocks, gone, mergeBackward, mergeForward } = splitMergeOps(steps);
		const { besideAt, placeBeside, wrapInLayout } = layoutOps(steps);
		const {
			insertBlocks,
			moveBlocks,
			unNestBlocks,
			unNestBlock,
			landingOf,
			liftOut,
			duplicateBlock
		} = moveOps(steps);

		// content ops (allowed inside voids — caption contract)

		const insertText = (
			id: BlockId,
			offset: number,
			text: string,
			marks?: Record<string, unknown>
		): Prepared => {
			id = ref(id);
			const clean = ref(text);
			if (!contentTarget(id)) return REFUSED;
			const [at] = clamp(id, offset, 0);
			const m = marks && sanitizeWireJson(marks);
			return plan(
				[id],
				clean === '' ? [] : [{ op: 'insertText', id, offset: at, text: clean, marks: m }]
			);
		};

		const deleteText = (id: BlockId, offset: number, length: number): Prepared => {
			id = ref(id);
			if (!contentTarget(id)) return REFUSED;
			const [at, end] = clamp(id, offset, length);
			return plan([id], end > at ? [{ op: 'deleteText', id, offset: at, length: end - at }] : []);
		};

		/**
		 * Multi-mark format over a range (values may be null = unset); planned
		 * only when some text atom in the range carries a different value.
		 */
		const formatRange = (
			id: BlockId,
			offset: number,
			length: number,
			marks: Record<string, unknown>
		): Prepared => {
			id = ref(id);
			const clean = sanitizeWireJson(marks);
			if (!contentTarget(id)) return REFUSED;
			const [at, end] = clamp(id, offset, length);
			// Planned only when some text atom carries another value (the same-value guard).
			const differs = textIn(id, at, end).some((item) =>
				Object.keys(clean).some((k) => !jsonEquals(item.marks?.[k] ?? null, clean[k] ?? null))
			);
			return plan(
				[id],
				differs ? [{ op: 'formatRange', id, offset: at, length: end - at, marks: clean }] : []
			);
		};

		/**
		 * Baseline `removeMarksFromText`: every mark present anywhere in the
		 * range is unset over the range. Names are discovered from the content.
		 */
		const clearMarks = (id: BlockId, offset: number, length: number): Prepared => {
			const clears: JsonObj = {};
			for (const item of textIn(ref(id), offset, offset + length)) {
				for (const k of Object.keys(item.marks ?? {})) clears[k] = null;
			}
			return formatRange(id, offset, length, clears);
		};

		const insertInline = (id: BlockId, offset: number, atom: InlineSpec): Prepared => {
			id = ref(id);
			const clean = sanitizeInline(atom);
			if (!contentTarget(id)) return REFUSED;
			return plan([id], [{ op: 'insertInline', id, offset: clamp(id, offset, 0)[0], atom: clean }]);
		};

		const removeInline = (id: BlockId, inlineId: string): Prepared => {
			id = ref(id);
			const atom = atomOf(id, ref(inlineId));
			if (atom === undefined) return REFUSED;
			return plan([id], [{ op: 'removeInline', id, offset: atom.at, inlineId: ref(inlineId) }]);
		};

		/** What range deletion and flow placement read, and the step writers they compose. */
		const context: FlowContext = {
			ref,
			refused: REFUSED,
			plan,
			order: () => view().order,
			positionOf,
			ancestorsOf: (id) => ancestorsOf(id),
			childrenIds,
			displayLength,
			contentTarget,
			rendersContent,
			canMerge,
			isIsland,
			isLines,
			defaultChild,
			fitted,
			move,
			retype: (id, type) => attr(id, TYPE, type),
			isContainer,
			emptiable,
			settle,
			remove,
			insertBlocks,
			sanitize: sanitizeSpec,
			collides: (specs) => M.collides(doc, specs),
			isVoid,
			roleOf: (kind) => ({
				void: roles.childless(kind),
				island: roles.island(kind),
				rendersContent: roles.rendersContent(kind),
				layout: roles.layout(kind)
			}),
			insideItem: (id) => insideItem(id),
			tailOf: (id) => ({ type: kindToCopy(id), data: blockDataOf(id) }),
			ranksFor,
			insertRanks: (parent, index, count) => ranksFor(parent, index, count, [], true),
			pieceRanks,
			redata: (id, data) => dataSteps(id, replaceData(data)) ?? [],
			deleteBlocks: (ids, filled) => deleteBlocks(ids, false, filled),
			dissolving: (gone, leaving, writes) => dissolving(new Set(gone), leaving, writes)
		};

		/** Every document op, prepared (R6) — `apply(prepare.op(…))` is the op. */
		const prepare = {
			insertBlocks,
			insertBlock: (dest: Destination, spec: BlockSpec | JSONBlock) => insertBlocks(dest, [spec]),
			moveBlocks,
			/** Relocate `id` — identity preserved. */
			moveBlock: (id: BlockId, dest: Destination) => moveBlocks([id], dest),
			/**
			 * Move `id` to the last position under `parent` — under a container
			 * it is no item of, under its last item (`nestParent`: Tab after a list).
			 */
			nestBlock: (id: BlockId, parent: BlockId) => {
				const at = nestParent([ref(id)], ref(parent));
				return moveBlocks([id], { parent: at, index: childrenIds(at).length });
			},
			unNestBlock,
			unNestBlocks,
			liftOut,
			placeBeside,
			wrapInLayout,
			splitBlock,
			mergeBlocks,
			mergeBackward,
			mergeForward,
			deleteBlock,
			setBlock,
			setBlockType,
			patchData,
			/** Replace a block's `data`: a patch of its root. */
			setBlockData: (id: BlockId, data: Record<string, unknown>) =>
				patchData(id, [{ path: [], value: data }]),
			duplicateBlock,
			insertText,
			deleteText,
			formatRange,
			setMark: (id: BlockId, offset: number, length: number, name: string, value: unknown) =>
				formatRange(id, offset, length, { [name]: value }),
			unsetMark: (id: BlockId, offset: number, length: number, name: string) =>
				formatRange(id, offset, length, { [name]: null }),
			clearMarks,
			insertInline,
			removeInline,
			/** Replace an inline atom's `data`: a patch of its root. */
			setInlineData: (id: BlockId, inlineId: string, data: Record<string, unknown>) =>
				patchData({ block: id, atom: inlineId }, [{ path: [], value: data }]),
			/** Delete a block selection — one plan; only the members leave (`deleteBlocks` above). */
			deleteBlocks: (ids: readonly BlockId[]): Prepared => deleteBlocks(ids),
			...rangeDeleteOps(context),
			...flowOps(context)
		};

		/**
		 * Plans prepared at one version, as one plan (refused if any part is;
		 * stamped with the oldest part's version, so `apply` refuses a stale
		 * one). The caller guarantees the parts are independent: no step's
		 * coordinates depend on an earlier part's writes.
		 */
		const compose = (...parts: Prepared[]): Prepared => {
			const plans = parts as Plan[];
			const version = Math.min(...plans.map((p) => p.version));
			return (
				parts.find((p) => !('writes' in p)) ?? {
					...plan(
						plans.flatMap((p) => p.ids),
						plans.flatMap((p) => p.writes)
					),
					version
				}
			);
		};

		// ── JSON boundary ─────────────────────────────────────────────────

		/**
		 * Public JSON export — `{ children: JSONBlock[] }` matching
		 * `src/lib/utils/json.ts` (`data` always present, `content`/`children`
		 * omitted when empty): the one serializer, {@link blockJSON}, over the
		 * root's visible children.
		 */
		const toJSON = (): JSONDoc => {
			const data = docData();
			const children = childrenIds(null).map(blockJSON);
			return Object.keys(data).length > 0
				? { data: data as JSONDoc['data'], children }
				: { children };
		};

		// ── facade object ─────────────────────────────────────────────────

		/** A read taking an id first: the id normalizes at ingress (O1). */
		const byRef =
			<I extends BlockId | null, A extends unknown[], R>(f: (id: I, ...rest: A) => R) =>
			(id: I, ...rest: A): R =>
				f(ref(id), ...rest);

		/**
		 * The typed-node surface (`document.block(id)` handles — see
		 * `nodes.ts`). Created lazily on first use; `bindNodes` caches one
		 * handle per block id, so repeated `facade.block(id)` calls return
		 * the same instance.
		 */
		let nodeApi: ReturnType<typeof bindNodes> | undefined;
		const nodes = () => (nodeApi ??= bindNodes(facade));

		const facade = {
			// lifecycle
			init: (opts?: Parameters<typeof init>[1]) => write(() => init(doc, opts)),
			/** Apply the deterministic seed of `value` and the document's `data` — the document's seed decision. */
			seed: (value: JSONBlock[], data?: JsonObj) =>
				write(() => seed(doc, value, defaultType, data)),
			isInitialized: () => isInitialized(doc),
			/** Replicated `meta.v` schema version (the module-level read, bound). */
			schemaVersion: () => schemaVersion(doc),
			/**
			 * The schema gate for this doc — throws {@link SchemaMismatchError}
			 * on unversioned-content or unsupported-version state. Consumers
			 * (`Edytor.sync()`, packed consumers) call it before trusting
			 * a synced doc.
			 */
			checkSchema: () => checkSchema(doc),
			assertSchema: () => assertSchema(doc),
			dispose,
			createUndoManager,
			/**
			 * Drop every step of a history `createUndoManager` made (undo and
			 * redo) and release what they kept for their undo, as the history
			 * limit does: the engine collects that content now, the doc's
			 * `gcFilter` still deciding. The room's validation history runs
			 * it after each frame.
			 */
			releaseHistory: (um: YUndoManager): void => releasers.get(um)?.(),
			// reads — every id argument normalizes at ingress (O1)
			project: () => M.project(doc),
			toJSON,
			blockJSON: byRef(blockJSON),
			childrenIds: byRef(childrenIds),
			/** Visible children of `parent` with their ranks, in `(rank, id)` order. */
			childSlots: (parent: BlockId | null) => view().kids.get(parent) ?? [],
			slotOf: byRef(slotOf),
			positionOf: byRef(positionOf),
			pathOf: byRef(pathOf),
			parentOf: byRef((id: BlockId) => positionOf(id)?.parent ?? null),
			ancestorsOf: byRef((id: BlockId) => ancestorsOf(id)),
			listBlockIds: () => M.listBlockIds(doc),
			blockText: byRef((id: BlockId) => M.blockText(doc, id)),
			blockTypeOf: byRef(blockTypeOf),
			blockDataOf: byRef(blockDataOf),
			docData,
			dataItemIds,
			/**
			 * Compact per-block attribution (`{createdBy, contributors,
			 * lastChangedBy}`), or `undefined` for unauthored/system blocks.
			 * O(1) per call; live-replicated (remote values read the same).
			 */
			blockAttribution: byRef((id: BlockId): BlockAttribution | undefined =>
				blockAttributionOf(doc, id)
			),
			crdtId: byRef((id: BlockId) => M.crdtId(doc, id)),
			resolveBlock: byRef((id: BlockId) => M.resolveBlock(doc, id)),
			displayLength: byRef(displayLength),
			contentItems: byRef(contentItems),
			hasBlock: byRef(hasBlock),
			isVisibleBlock: byRef(live),
			order,
			compare: (a: BlockId, b: BlockId) => compare(ref(a), ref(b)),
			next: byRef(next),
			previous: byRef(previous),
			// caret anchors (U09) — backing-text-bound selection endpoints
			anchorAt: byRef(anchorAt),
			resolveAnchor,
			followUndo,
			// roles
			/** Re-read the roles after `roleOf` answers differently (roles adopted later). */
			rolesChanged: () => runsView.roles(roles),
			isVoid: byRef(isVoid),
			isIsland: byRef(isIsland),
			isLines: byRef(isLines),
			/** `id` is a layout: its kind's role says `layout` (`layout.*`). */
			isLayout: byRef(isLayout),
			/** `id` is a layout item: of its layout's item kind, directly in it (a column). */
			isLayoutItem: byRef(isLayoutItem),
			/** The block a beside placement at `id` stands beside (`placeBeside`'s resolution). */
			besideAt: (id: BlockId, kind?: string) => besideAt(id, kind),
			islandOf: byRef((id: BlockId) => islandOf(id)),
			insideIsland: byRef((id: BlockId) => insideIsland(id)),
			// structural capability (R5)
			canPlace: (ids: readonly BlockId[], parent?: BlockId | null) =>
				canPlace(ids.map(ref), parent == null ? parent : ref(parent)),
			canMerge: (from: BlockId, into: BlockId) => canMerge(ref(from), ref(into)),
			/** May a block of `kind` sit directly under `parent`? The container rule (`fits`). */
			fits: (parent: BlockId | null, kind: string) =>
				fits(parent == null ? null : ref(parent), ref(kind)),
			/** Where `ids` nest when nested into `parent` (Tab, a drop inside it): `nestParent`. */
			nestParent: (ids: readonly BlockId[], parent: BlockId) =>
				nestParent(ids.map(ref), ref(parent)),
			/** Where a block of `kind` at `id`'s place lands, and the containers it leaves (`liftOut`). */
			landingOf: (id: BlockId, kind: string, after?: boolean) =>
				landingOf(ref(id), ref(kind), after),
			defaultChild: byRef(defaultChild),
			// maintained runs (U05 surface, bound to this doc)
			runs: byRef(runsView.runs),
			contentJSON: byRef(runsView.contentJSON),
			// events
			onChange,
			// every op — each returns an {@link OpResult}; `apply(prepare.op(…))`
			...applied(prepare, apply),
			/** Every op prepared: pure, a plan of named steps + its effect, or `refused`. */
			prepare,
			/** Write a prepared plan exactly (refusals pass through). */
			apply,
			compose,
			// transactions (composed ops already run in one; expose for callers
			// that batch several ops into one undo step / one event)
			transact: <R>(fn: () => R, origin?: unknown): R => write(() => doc.transact(fn, origin)),
			// escape hatch for U08/debugging — the bound engine layers.
			model: M,
			text: T,
			runsView,
			// ── model-state version + typed node surface (WU2) ──────────
			/**
			 * The index version — bumps on every fold that changed derived
			 * state, mid-transaction writes included. Read surfaces that
			 * memoize on it (the editor's projected-tree cache) always observe
			 * post-write state — this is the read-your-writes contract.
			 */
			get version() {
				return runsView.version();
			},
			/**
			 * The typed handle over one document block — the domain command
			 * surface (see `nodes.ts` for the contract: display offsets,
			 * transaction-aware reads, dead-safe). Handles are cached per
			 * id; a handle for an absent id reports `exists`/`live`/`visible`
			 * false and refuses ops.
			 */
			block: (id: BlockId): DocBlock => nodes().block(ref(id))
		};
		return facade;
	};

	return {
		/** The schema manifest constants table. */
		SCHEMA,
		SCHEMA_VERSION,
		SCHEMA_NAME,
		META_KEY,
		/** Doc-level API (no facade needed). */
		init,
		restore,
		seed,
		isInitialized,
		schemaVersion,
		registryEmpty,
		checkSchema,
		assertSchema,
		SchemaMismatchError,
		/** Attach the per-doc facade. */
		create,
		/**
		 * Keep, on `doc`, the text a replica may have to copy again: its
		 * `gcFilter` then spares a deleted copy's content, as every facade's
		 * history does. A doc that only relays updates (the room) calls it
		 * before applying anything, so what it collects and encodes matches
		 * what an editing replica keeps.
		 */
		keepCopies: (doc: EngineDoc): void => void D.scope(doc),
		/**
		 * Purge from `doc` what was deleted before `horizon` (`room.purge.what`): real deletes, inside the caller's transaction,
		 * and the horizon record every history reads (`hist.purge.horizon`).
		 * The room's purge task runs it; `facade` is a facade over `doc`.
		 */
		purge: P.purge,
		/** The purge horizon `doc` holds, or `null`. */
		horizonOf: (doc: EngineDoc) => readHorizon(doc),
		/**
		 * Make the visible document `doc` equal `json`, keeping the ids the
		 * registry holds and writing only what differs (`room.history.restore`), inside the caller's transaction.
		 */
		restoreTo: restoreDocument,
		/** The bound engine layers (same instances the facades use). */
		model: M,
		text: T,
		runs: R
	};
};
