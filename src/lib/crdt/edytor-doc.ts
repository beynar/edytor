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

		/**
		 * The data step of `patches` (sanitized) on a block, one of its atoms or
		 * the document (`crdt/data.ts`): none when it changes nothing, `null`
		 * when a patch is refused.
		 */
		const dataSteps = (target: DataTarget, patches: DataPatch[]): PlanStep[] | null => {
			const [id, inlineId] =
				typeof target === 'object' && target ? [target.block, target.atom] : [target ?? undefined];
			const node = dataNode(id, inlineId);
			// A block kind's atomic paths are written as one leaf each (`data.atomic`, H8).
			const type = inlineId === undefined && id !== undefined ? blockTypeOf(id) : undefined;
			const atomic = (type === undefined ? undefined : roleOf(type)?.atomic) ?? [];
			const leaves = node
				? patchWrites(
						node,
						patches,
						doc.clientID,
						randOf(doc),
						atomic.map((p) => leafKey(typeof p === 'string' ? [p] : p))
					)
				: [];
			if (leaves === null) return null; // a patch fits no value there
			if (leaves.length === 0) return [];
			const offset = inlineId === undefined ? undefined : atomOf(id!, inlineId)?.at;
			return [
				{
					op: 'patchData',
					...(id !== undefined && { id }),
					...(inlineId !== undefined && { inlineId, offset }),
					ops: patches,
					leaves
				}
			];
		};
		/** A whole-data replace: a patch of the root. */
		const replaceData = (data: unknown): DataPatch[] => [
			{ path: [], value: sanitizeWireJson(data) }
		];
		/**
		 * `data`'s leaves as sets over `current` (`data.retype.keep`, H4): a
		 * plain object's keys, recursively where `current` holds an object
		 * there too; anything else (an array, a primitive, an empty object, an
		 * object where `current` holds none) as one value at its path. Nothing
		 * else under the root is touched.
		 */
		const leafSets = (data: unknown, current: unknown): DataPatch[] => {
			const out: DataPatch[] = [];
			const plainObject = (v: unknown): v is Record<string, unknown> =>
				v !== null && typeof v === 'object' && !Array.isArray(v);
			const walk = (v: unknown, at: unknown, path: string[]): void => {
				if (plainObject(v) && Object.keys(v).length > 0 && (path.length === 0 || plainObject(at)))
					for (const [k, x] of Object.entries(v))
						walk(x, plainObject(at) ? at[k] : undefined, [...path, k]);
				else if (path.length > 0) out.push({ path, value: v });
			};
			walk(sanitizeWireJson(data), current, []);
			return out;
		};
		/**
		 * Insert blocks (specs may carry children/content/data; the batch is
		 * all-or-nothing). A spec is a `BlockSpec` or the `JSONBlock` that
		 * `toJSON` and the view's `value` speak (`{ type, content: [{ text }] }`):
		 * its ids are kept, minted where missing (`asBlockSpec`). Ids must be fresh.
		 * Refused when the parent is not live, is `void` or is an island's
		 * line (it holds no children), or any id collides.
		 * Inserting INSIDE an island is allowed — island interiors are built
		 * this way. `ids`: the inserted roots.
		 */
		const insertBlocks = (
			dest: Destination,
			specs: readonly (BlockSpec | JSONBlock)[]
		): Prepared => {
			const parent = ref(dest.parent);
			const clean = specs.map((spec) => sanitizeSpec(asBlockSpec(spec)));
			if (parent !== null && (isVoid(parent) || isLine(parent))) return REFUSED;
			if (clean.length === 0) return plan([], []);
			if ((parent !== null && !live(parent)) || M.collides(doc, clean)) return REFUSED;
			const ranks = ranksFor(parent, dest.index, clean.length, [], true);
			return plan(
				clean.map((s) => s.id),
				[{ op: 'insertBlocks', parent, index: dest.index, specs: clean, ranks }]
			);
		};

		/**
		 * Grouped move — one step, per-member conflict resolution; refused
		 * exactly when `canPlace` refuses the group. `ids`: the moved blocks,
		 * in request order.
		 */
		const moveBlocks = (ids: readonly BlockId[], dest: Destination): Prepared => {
			const moved = ids.map(ref);
			const parent = ref(dest.parent);
			if (moved.length === 0) return plan([], []);
			if (!canPlace(moved, parent)) return REFUSED;
			// A list the move leaves with no item goes (not one it moves or lands in).
			const into = new Set([...moved, ...landing(parent)]);
			return plan(moved, emptied(moved, move(moved, parent, dest.index), into));
		};
		/**
		 * Outdent (UW-23): move sibling blocks `ids` (document order) right
		 * after their parent, and hand the siblings that followed the last of
		 * them to it as its last children — every outliner's Shift+Tab. A last
		 * block that cannot adopt them (void, island, a container they do not
		 * fit) leaves them with the parent. The blocks take the kind they show
		 * in their new slot (`settledKind`: a list's item becomes a paragraph,
		 * a paragraph outdented into a list its item); refused where one would
		 * not fit (a paragraph out of a column into its columns layout, ZW-14).
		 * Items leaving a container never take the items after them (DR-crdt-3):
		 * the list splits around them, Notion's way — outdented first items go
		 * before it, last ones after it; from the middle, the list keeps the
		 * items after them and a new list of its kind takes the ones before
		 * them, so an item a peer appends meanwhile stays with the items it
		 * follows (ZW-03; `splitOut`, the split Turn into's `liftOut` makes). A
		 * container left with no child goes (YW-02). One plan; refused as the
		 * move is. `ids`: the moved blocks.
		 */
		const unNestBlocks = (ids: readonly BlockId[]): Prepared => {
			const moved = ids.map(ref);
			const last = moved.at(-1);
			const pos = last === undefined ? null : positionOf(last);
			const ppos = pos?.parent != null ? positionOf(pos.parent) : null;
			if (!ppos || moved.some((id) => positionOf(id)?.parent !== pos!.parent)) return REFUSED;
			const from = pos!.parent!;
			if (!canPlace(moved, ppos.parent, (id) => settledKind(from, id, ppos.parent))) return REFUSED;
			const after = childrenIds(from).slice(pos!.index + 1);
			const retype = settle(from, moved, ppos.parent);
			if (isContainer(from)) return splitOut(moved, [from], [], false, retype);
			const out = leaving(from, true, moved);
			const writes = [...moveTo(moved, ppos.parent, ppos.index + 1, out), ...retype];
			const adopts =
				after.length > 0 &&
				!isVoid(last!) &&
				!isIsland(last!) &&
				after.every((id) => fits(last!, blockTypeOf(id)));
			if (adopts) writes.push(...move(after, last!, Infinity));
			return plan(moved, writes);
		};
		/** Outdent one block (`unNestBlocks`). */
		const unNestBlock = (id: BlockId): Prepared => unNestBlocks([id]);

		/**
		 * Where a block of `kind` at `id`'s place lands: `id`'s parent, or the
		 * first one up that `kind` fits (`fits`: a list holds only its items),
		 * and the containers it leaves on the way, innermost first (`levels`).
		 * Its own kind keeps a block where it is (DR-behavior-3), as a reorder
		 * does (`canPlace`); a block inserted after it (`after`) has no place
		 * yet.
		 */
		const landingOf = (id: BlockId, kind: string, after = false) => {
			const levels: BlockId[] = [];
			let parent = positionOf(id)?.parent ?? null;
			const own = !after && blockTypeOf(id) === kind;
			for (; !own && parent !== null && !fits(parent, kind); parent = positionOf(parent)!.parent)
				levels.push(parent);
			return { parent, levels };
		};
		/**
		 * Lift sibling blocks `ids` (document order) out of `levels`, the
		 * containers around them, innermost first (ZW-03, AW-01): each level
		 * splits around them as an outdent splits one list — the blocks
		 * before them go to a new container of its kind, which the level above
		 * holds the same way, and the level keeps the ones after them, so an
		 * item a peer appends meanwhile stays with the items it follows; one
		 * left with no child goes. `specs` (new blocks) land right after them.
		 * With `keep`, `ids` stay before the split and only `specs` go out.
		 * `retype` (the caller's kind steps) joins the plan. The one split
		 * `unNestBlocks` and `liftOut` share. `ids`: the placed blocks.
		 */
		const splitOut = (
			ids: readonly BlockId[],
			levels: readonly BlockId[],
			specs: BlockSpec[],
			keep: boolean,
			retype: readonly PlanStep[] = []
		): Plan => {
			const moved = keep ? [] : [...ids];
			const placed = [...moved, ...specs.map((s) => s.id)];
			const insert = (at: BlockId | null, index: number, s: BlockSpec[], ranks: string[]) =>
				s.length ? [{ op: 'insertBlocks' as const, parent: at, index, specs: s, ranks }] : [];
			const last = ids.at(-1)!;
			const { parent, index } = positionOf(levels.at(-1) ?? last)!;
			if (levels.length === 0) {
				const ranks = ranksFor(parent, index + 1, specs.length, [], true);
				return plan(placed, [...insert(parent, index + 1, specs, ranks), ...retype]);
			}
			// Bottom up: what stays before the split at each level (the level
			// itself, or a new head holding it), and whether anything follows it.
			const heads: { spec: BlockSpec; kids: BlockId[]; inner?: BlockSpec }[] = [];
			let before: { id: BlockId; head?: BlockSpec } | null = null;
			let follows = false;
			// The block right after `last` (what the split ends at when `keep`).
			let next: BlockId | undefined;
			let child = last;
			for (const level of levels) {
				const kids = childrenIds(level);
				const at = kids.indexOf(child);
				const lead: BlockId[] = [
					...kids.slice(0, keep && child === last ? at + 1 : at).filter((k) => !moved.includes(k)),
					...(before && !before.head ? [before.id] : [])
				];
				if (!follows && at + 1 < kids.length) [follows, next] = [true, kids[at + 1]];
				if ((lead.length > 0 || before?.head) && follows) {
					const spec = sanitizeSpec({
						id: newId('b'),
						type: kindToCopy(level),
						data: blockDataOf(level) ?? {}
					});
					heads.push({ spec, kids: lead, inner: before?.head });
					before = { id: spec.id, head: spec };
				} else before = lead.length > 0 ? { id: level } : null;
				child = level;
			}
			// Ranked by where each comes from in the outermost level (CW-01): the
			// head right before the first block (with `keep`, right before it
			// leaves), the blocks, then `specs` after the last — with `keep`,
			// right before the block after it, so a peer's head that takes the
			// block they follow sorts before them.
			const outside = before !== null && !before.head;
			let gap = index + (outside ? 1 : 0);
			const ranks = exitRanks(levels.at(-1)!, outside, [
				...(before?.head ? [{ at: ids[0]!, part: [keep ? WITH : HEAD] }] : []),
				...moved.map((id) => ({ at: id, part: [SELF] })),
				...specs.map((_, i) =>
					keep && !outside ? { at: next!, part: [KEPT, i] } : { at: last, part: [AFTER, i] }
				)
			]);
			const writes: PlanStep[] = before?.head
				? insert(parent, gap++, [before.head], ranks.splice(0, 1))
				: [];
			for (const { spec, kids, inner } of heads.reverse()) {
				const inside = ranksFor(spec.id, 0, kids.length + (inner ? 1 : 0));
				writes.push(
					...moveTo(kids, spec.id, 0, inside.slice(0, kids.length)),
					...(inner ? insert(spec.id, kids.length, [inner], inside.slice(-1)) : [])
				);
			}
			const mine = ranks.splice(0, moved.length);
			writes.push(
				...moveTo(moved, parent, gap, mine),
				...insert(parent, gap + moved.length, specs, ranks),
				...retype
			);
			return plan(placed, emptying(levels[0]!, moved, writes, landing(parent)));
		};
		/**
		 * Place `id` where a block of `kind` fits, in one plan (AW-01, AW-03):
		 * out of every container around it that `kind` does not fit
		 * (`landingOf`: a list, and a list holding that list directly, for a
		 * heading or a divider), each split around it (`splitOut`). `after`
		 * (new blocks) lands right after it. With `keep`, `id` stays and only
		 * `after` goes out, the split right after `id` (a divider inserted
		 * after an item). Its own kind never moves it. The kinds are the
		 * caller's: it composes the retype (`setBlock`). Refused where `id`
		 * may not move there (`canPlace`). `ids`: the placed blocks.
		 */
		const liftOut = (
			id: BlockId,
			kind: string,
			{ keep = false, after = [] }: { keep?: boolean; after?: readonly BlockSpec[] } = {}
		): Prepared => {
			id = ref(id);
			kind = ref(kind);
			const specs = after.map(sanitizeSpec);
			const { parent, levels } = landingOf(id, kind, keep);
			if (!positionOf(id) || M.collides(doc, specs) || !canPlace([id], parent, () => kind))
				return REFUSED;
			return splitOut([id], levels, specs, keep);
		};

		/** The layout kind a new layout takes: `kind` when it is one, else the only one the roles declare. */
		const layoutKind = (kind?: string): string | undefined => {
			if (kind !== undefined) return roles.layout(kind) === undefined ? undefined : kind;
			const kinds = [...roles.layoutKinds()];
			return kinds.length === 1 ? kinds[0] : undefined;
		};
		/**
		 * The block a beside placement at `target` stands beside
		 * (`layout.place-beside`): a layout or an item for itself; a block whose
		 * parent shows only its children (a list item → its list, at any depth)
		 * or is an island of lines (a code line → its code block) for that
		 * parent; then the block itself when it sits directly in an item or at
		 * the root, or where a new layout of `kind` (else the only layout kind)
		 * fits beside it (a toggle's, a callout's or a nested block's child,
		 * outside any item and island, D2); else its outermost block below the
		 * root or an item.
		 */
		const besideAt = (target: BlockId, kind?: string): BlockId => {
			let at = ref(target);
			if (isLayout(at) || isLayoutItem(at)) return at;
			for (
				let parent = positionOf(at)?.parent ?? null;
				parent !== null && !isLayoutItem(parent) && (isContainer(parent) || isLines(parent));
				parent = positionOf(parent)?.parent ?? null
			)
				at = parent;
			const parent = positionOf(at)?.parent ?? null;
			if (parent === null || isLayoutItem(parent)) return at;
			const wrap = layoutKind(kind);
			if (
				wrap !== undefined &&
				fits(parent, wrap) &&
				!insideItem(parent) &&
				!isIsland(parent) &&
				!insideIsland(parent)
			)
				return at;
			for (
				let up: BlockId | null = parent;
				up !== null && !isLayoutItem(up);
				up = positionOf(up)!.parent
			)
				at = up;
			return at;
		};
		/**
		 * Place `ids` beside `target`, to its `side` (`layout.place-beside`: a
		 * block dragged to another block's left or right edge). The target
		 * resolves to its outermost block below the root or below a layout
		 * item (a list item → its list, a code line → its code block); an item
		 * stands for itself, a layout for its first or last slot. Beside a
		 * block in an item, a new item holding `ids` goes beside that item;
		 * otherwise the block and a new item holding `ids` are wrapped in a new
		 * layout of the layout `kind` (else the only one the roles declare) at
		 * its place. Refused when `ids` holds the target or an ancestor of it,
		 * an item, a layout or a block holding one (D2), a block that does not
		 * fit an item, a block or a layout inside an island, and, wrapping,
		 * when there is no layout kind. The sources are cleaned in the same
		 * plan (`emptying`, `dissolving`); plain ranks (a move). `ids`: the
		 * moved blocks.
		 */
		const placeBeside = (
			ids: readonly BlockId[],
			target: BlockId,
			side: 'left' | 'right',
			kind?: string
		): Prepared => {
			const moved = ids.map(ref);
			target = ref(target);
			const v = view();
			if ((side !== 'left' && side !== 'right') || !canPlace(moved) || !live(target))
				return REFUSED;
			if ([target, ...ancestorsOf(target, v)].some((a) => moved.includes(a))) return REFUSED;
			if (moved.some((id) => isLayoutItem(id) || holdsLayout(id))) return REFUSED;
			const right = side === 'right';
			// Where the new item goes: beside an item of a layout, or a new layout wrapping `at`.
			const at = besideAt(target, kind && ref(kind));
			let layout: BlockId | null = null;
			let index = 0;
			if (isLayout(at)) [layout, index] = [at, right ? childrenIds(at).length : 0];
			else {
				const item = isLayoutItem(at) ? at : positionOf(at)!.parent;
				if (item !== null) {
					const pos = positionOf(item)!;
					[layout, index] = [pos.parent!, pos.index + (right ? 1 : 0)];
				}
			}
			const wrap = layout === null ? layoutKind(kind && ref(kind)) : blockTypeOf(layout);
			const item = wrap === undefined ? undefined : roles.layout(wrap);
			if (wrap === undefined || item === undefined) return REFUSED;
			if (moved.some((id) => !fitsIn(item, blockTypeOf(id)))) return REFUSED;
			if (layout !== null && (isIsland(layout) || insideIsland(layout, v))) return REFUSED;
			const spec = (type: string): BlockSpec => sanitizeSpec({ id: newId('b'), type, data: {} });
			const fresh = spec(item);
			const into = (parent: BlockId) => moveTo(moved, parent, 0, ranksFor(parent, 0, moved.length));
			let writes: PlanStep[];
			let kept: Set<BlockId | null>;
			if (layout !== null) {
				const ranks = ranksFor(layout, index, 1);
				writes = [
					{ op: 'insertBlocks', parent: layout, index, specs: [fresh], ranks },
					...into(fresh.id)
				];
				kept = new Set([fresh.id, ...landing(layout)]);
			} else {
				const pos = positionOf(at)!;
				const host = spec(item);
				const wrapper = { ...spec(wrap), children: right ? [host, fresh] : [fresh, host] };
				const ranks = ranksFor(pos.parent, pos.index, 1);
				writes = [
					{ op: 'insertBlocks', parent: pos.parent, index: pos.index, specs: [wrapper], ranks },
					...moveTo([at], host.id, 0, ranksFor(host.id, 0, 1)),
					...into(fresh.id)
				];
				kept = new Set([wrapper.id, host.id, fresh.id, ...landing(pos.parent)]);
			}
			return plan(moved, emptied(moved, writes, kept));
		};

		/**
		 * Wrap sibling blocks in a new layout of `columns` items (default: one
		 * per block), at the first one's place (`layout.wrap`: Turn into N
		 * columns, as Notion): the blocks fill the first items, one each, in
		 * document order; each item after them holds one empty block of the
		 * item's default child (one block turned into 3 columns: it, then two
		 * empty columns). The layout is of the layout `kind` (else the only one
		 * the roles declare). Refused for no block, fewer than two items or
		 * fewer items than blocks, blocks of different parents, an item, a
		 * layout or a block holding one (D2), where the layout does not fit
		 * (`fits`: in a list, a code block) or lands inside an item (D2) or an
		 * island, and for a block that does not fit an item. Plain ranks (a
		 * move). `ids`: the new layout.
		 */
		const wrapInLayout = (
			ids: readonly BlockId[],
			kind?: string,
			columns: number = ids.length
		): Prepared => {
			const blocks = ids.map(ref);
			const v = view();
			if (!Number.isInteger(columns) || columns < 2 || blocks.length < 1) return REFUSED;
			if (columns < blocks.length || !canPlace(blocks)) return REFUSED;
			const parent = positionOf(blocks[0]!)!.parent;
			if (blocks.some((id) => positionOf(id)!.parent !== parent)) return REFUSED;
			if (blocks.some((id) => isLayoutItem(id) || holdsLayout(id))) return REFUSED;
			const wrap = layoutKind(kind && ref(kind));
			const item = wrap === undefined ? undefined : roles.layout(wrap);
			if (wrap === undefined || item === undefined || !fits(parent, wrap)) return REFUSED;
			if (parent !== null && (insideItem(parent, v) || isIsland(parent) || insideIsland(parent, v)))
				return REFUSED;
			if (blocks.some((id) => !fitsIn(item, blockTypeOf(id)))) return REFUSED;
			const fill = roles.defaultChild(item);
			if (columns > blocks.length && !fitsIn(item, fill)) return REFUSED;
			const ordered = blocks.toSorted((a, b) => positionOf(a)!.index - positionOf(b)!.index);
			const spec = (type: string): BlockSpec => sanitizeSpec({ id: newId('b'), type, data: {} });
			const items = Array.from({ length: columns }, (_, i) =>
				i < ordered.length ? spec(item) : { ...spec(item), children: [spec(fill)] }
			);
			const wrapper = { ...spec(wrap), children: items };
			const at = positionOf(ordered[0]!)!.index;
			const writes: PlanStep[] = [
				{
					op: 'insertBlocks',
					parent,
					index: at,
					specs: [wrapper],
					ranks: ranksFor(parent, at, 1)
				},
				...ordered.flatMap((id, i) => moveTo([id], items[i]!.id, 0, ranksFor(items[i]!.id, 0, 1)))
			];
			const kept = new Set<BlockId | null>([
				wrapper.id,
				...items.map((it) => it.id),
				...landing(parent)
			]);
			return plan([wrapper.id], emptied(ordered, writes, kept));
		};

		/**
		 * Split `id` at content `offset` into a new sibling `newId` (one boundary
		 * item and the claims that follow it, no text copied; children follow).
		 * `tail` decides the sibling's type/data once (default: the source's —
		 * the kind it displays, RW-01; an empty `tail.type` is the default too).
		 * Refused on `void` blocks and on blocks that render no content (a
		 * list, a code block: nothing to split, SW8-roles-3). `ids`: the new
		 * block.
		 */
		const splitBlock = (
			id: BlockId,
			offset: number,
			newId: BlockId,
			tail?: SplitTail
		): Prepared => {
			id = ref(id);
			const born = ref(newId);
			const pos = positionOf(id);
			const rec = view().blocks.get(id);
			if (pos === null || isVoid(id) || !rendersContent(id) || !rec?.claimsNode) return REFUSED;
			if (isIncarnationId(born) || M.blockNodeOf(doc, born) !== null) return REFUSED;
			const [at] = clamp(id, offset, 0);
			// An empty tail type is the one a view reads mid-retype: copy the kind (YW-07).
			const type = tail?.type ? ref(tail.type) : kindToCopy(id);
			const t = tail
				? { type, data: tail.data && sanitizeWireJson(tail.data) }
				: { type, data: readData(rec.node) };
			const [rank] = pieceRanks(id, at, 1);
			const length = displayLength(id) - at;
			const split: PlanStep = {
				op: 'splitBlock',
				id,
				offset: at,
				length,
				newId: born,
				tail: t,
				parent: pos.parent,
				rank: rank!
			};
			return plan([born], [split, ...move(childrenIds(id), born, 0)]);
		};

		/**
		 * Engine merge primitive: `from`'s content is claimed by `into`, its
		 * children ADOPTED as `into`'s last children — an island's take
		 * `into`'s default child, like a baseline merge's — and `from` is
		 * hidden via the claim (undo restores it). The children stay under
		 * `from`, ranked after `into`'s children, and display under `into`
		 * through the claim (FW-12): a concurrent delete of `into` voids the
		 * claim and `from` comes back with its children, never below them.
		 * Role rules are `canMerge`'s; a merge that would close a display
		 * cycle is refused. `ids`: `into`.
		 */
		const mergeBlocks = (fromId: BlockId, intoId: BlockId): Prepared => {
			const from = ref(fromId);
			const into = ref(intoId);
			const v = view();
			if (!canMerge(from, into) || !contentTarget(into)) return REFUSED;
			if (M.isSelfOrDescendant(v.placements, v.own, into, from)) return REFUSED;
			const kids = childrenIds(from);
			const retype = settle(from, kids, into);
			const adopt = moveTo(kids, from, kids.length, ranksFor(into, Infinity, kids.length, kids));
			// A list its only item leaves goes, as with every sibling op (DR-crdt-5).
			return plan([into], emptied([from], [merge(from, into), ...adopt, ...retype], landing(into)));
		};

		/**
		 * Baseline-shaped merge (both `mergeBackward` and `mergeForward`):
		 * `from`'s children unnest right after `from`'s vacated sibling slot —
		 * NOT adopted into `into` — and take the kind they show there
		 * (`settledKind`: an island's children its parent's default child, a
		 * paragraph in a list its item, ZW-01); then `from`'s content claims
		 * into `into`. Ranked after `from`, not at it: a concurrent delete of
		 * `into` revives `from` above its former children (UW-20).
		 */
		const mergeUnnesting = (from: BlockId, into: BlockId): Prepared => {
			const pos = canMerge(from, into) ? positionOf(from) : null;
			if (pos === null || !contentTarget(into)) return REFUSED;
			const kids = childrenIds(from);
			const retype = settle(from, kids, pos.parent);
			const out = leaving(from, true, kids);
			return plan(
				[into],
				[...moveTo(kids, pos.parent, pos.index + 1, out), ...retype, merge(from, into)]
			);
		};

		/** Remove `container`, left empty, for the key at `id` (refused if it holds text). */
		const gone = (id: BlockId, container: BlockId): Prepared => {
			const writes = emptying(container, [], []);
			return writes.length > 0 ? plan([id], writes) : REFUSED;
		};

		/**
		 * Baseline `mergeBlockBackward`: merge `id` into the previous block in
		 * document order. No previous block → an empty block merges forward,
		 * else refused. The first item of a container (`isContainer`) outside
		 * any island lifts out of it instead (YW-02, Notion): it takes the
		 * container's slot, as its new parent's default child, with its
		 * children (a first cell stays: nothing leaves an island; a block that
		 * would land directly in a container it is no item of stays too,
		 * DR-crdt-1). The first block of a layout item merges across items
		 * instead, in reading order (`layout.merge`, D4, Notion): into the
		 * previous item's last line, or, in the first item, the line before
		 * the layout; an item it empties goes and the layout dissolves.
		 * `ids`: the surviving block.
		 */
		const mergeBackward = (id: BlockId): Prepared => {
			id = ref(id);
			const prev = previous(id);
			if (prev === null && childrenIds(id).length === 0 && displayLength(id) === 0) {
				return mergeForward(id);
			}
			// A container a concurrent edit left empty shows nothing: the key removes it.
			if (prev !== null && isContainer(prev) && childrenIds(prev).length === 0)
				return gone(id, prev);
			if (prev !== null && prev === positionOf(id)?.parent && isLayoutItem(prev)) {
				const layout = positionOf(prev)!.parent!;
				let into = previous(prev);
				if (into === layout) into = previous(layout);
				const merged = into === null ? REFUSED : mergeUnnesting(id, into);
				if (!('writes' in merged) || childrenIds(id).length > 0) return merged;
				return plan(merged.ids, emptying(prev, [id], merged.writes));
			}
			if (
				prev !== null &&
				prev === positionOf(id)?.parent &&
				isContainer(prev) &&
				!insideIsland(prev)
			) {
				// It lands only where it fits: never directly in a container it is no item of.
				const slot = positionOf(prev)!;
				if (!fits(slot.parent, settledKind(prev, id, slot.parent))) return REFUSED;
				const lift = [
					...moveTo([id], slot.parent, slot.index, leaving(prev, false, [id])),
					...settle(prev, [id], slot.parent)
				];
				return plan([id], emptying(prev, [id], lift, landing(slot.parent)));
			}
			return prev ? mergeUnnesting(id, prev) : REFUSED;
		};

		/**
		 * Baseline `mergeBlockForward`: pull the next block in document order
		 * into `id`. A container passes the merge to its first item (YW-02:
		 * Delete above a list pulls the item's text up and the list keeps the
		 * rest, or goes when that was its only item). A container left
		 * empty (by concurrent edits) is removed instead, by either key.
		 */
		const mergeForward = (id: BlockId): Prepared => {
			id = ref(id);
			let after = next(id);
			while (after !== null && isContainer(after)) {
				const first = childrenIds(after)[0];
				// A container a concurrent edit left empty shows nothing: the key removes it.
				if (first === undefined) return gone(id, after);
				after = first;
			}
			const out = after ? mergeUnnesting(after, id) : REFUSED;
			const parent = after && positionOf(after)?.parent;
			if (!('writes' in out) || !parent || childrenIds(after!).length > 0) return out;
			return plan(out.ids, emptying(parent, [after!], out.writes));
		};

		/**
		 * Delete a set of blocks (R3, `del.blocks.promote`): this writer's mark on
		 * every member and on what it displays through merge claims (wins over
		 * concurrent moves). Only the members leave: the unselected children of a
		 * deleted block take its slot, in order, with their subtrees, as the
		 * kind they show there (`settledKind`: a deleted island's children take
		 * the slot parent's default child, a deleted list's items leave its
		 * kind, a block promoted into a list is its item). A container the delete leaves with no child goes too
		 * (`del.range.empty-container`). `subtree` is the explicit whole-subtree
		 * delete. `filled`: a parent the same plan fills again (a flow placed in
		 * the deleted blocks' slot, `flow.slot`), which is never emptied, so its
		 * layout never dissolves (`layout.flow-slot`).
		 */
		const deleteBlocks = (
			ids: readonly BlockId[],
			subtree = false,
			filled?: BlockId | null
		): Prepared => {
			const set = new Set(ids.map(ref));
			if ([...set].some((id) => !live(id))) return REFUSED;
			// A layout goes with its items: their blocks take its slot (`layout.dissolving`).
			for (const id of [...set])
				if (isLayout(id)) for (const kid of childrenIds(id)) if (isLayoutItem(kid)) set.add(kid);
			if (subtree) {
				const roots = [...set].filter((id) => !ancestorsOf(id).some((a) => set.has(a)));
				return plan(
					roots,
					emptied(
						roots,
						roots.map((id) => remove(id))
					)
				);
			}
			const roots = [...set].filter((id) => !set.has(positionOf(id)!.parent!));
			const { kids } = view();
			const promoting = new Set<BlockId>();
			const members: BlockId[] = [];
			const writes = roots.flatMap((root) => {
				const pos = positionOf(root)!;
				const chunk: BlockId[] = [];
				const kept: { id: BlockId; from: BlockId; rank: string }[] = [];
				// Each kept child moves to the rank read-time promotion gives it
				// (`promotedRank`), so a block a peer puts under a member meanwhile
				// takes the slot in the member's order among them. Right after the
				// root: a flow placed in the root's slot precedes them.
				const walk = (b: BlockId, slotRank: string): void => {
					chunk.push(b);
					for (const kid of kids.get(b) ?? []) {
						const rank = promotedRank(slotRank, kid.rank);
						if (set.has(kid.id)) walk(kid.id, rank);
						else kept.push({ id: kid.id, from: b, rank });
					}
				};
				walk(root, kids.get(pos.parent)![pos.index]!.rank);
				members.push(...chunk);
				if (kept.length > 0) promoting.add(root);
				// A layout shows only its items: a deleted item's blocks land right
				// after it, where read-time promotion shows them (`layout.only-items`).
				const item = pos.parent === null ? undefined : itemKindOf(pos.parent);
				const at = (k: { id: BlockId }) => item !== undefined && blockTypeOf(k.id) !== item;
				const out = kept.filter(at);
				const inside = kept.filter((k) => !at(k));
				const lpos = out.length > 0 ? positionOf(pos.parent!)! : null;
				const lrank = lpos && kids.get(lpos.parent)![lpos.index]!.rank;
				return [
					...moveTo(
						inside.map((k) => k.id),
						pos.parent,
						pos.index + 1,
						inside.map((k) => k.rank)
					),
					...inside.flatMap((k) => settle(k.from, [k.id], pos.parent)),
					...(lpos === null
						? []
						: [
								...moveTo(
									out.map((k) => k.id),
									lpos.parent,
									lpos.index + 1,
									out.map((k) => promotedRank(lrank!, k.rank))
								),
								...out.flatMap((k) => settle(k.from, [k.id], lpos.parent))
							]),
					deleting(root, chunk)
				];
			});
			return plan(
				roots,
				emptyingAll(
					roots.filter((r) => !promoting.has(r)).map((id) => positionOf(id)!.parent),
					roots.filter((r) => !promoting.has(r)),
					writes,
					filled === undefined ? undefined : new Set([filled]),
					members
				)
			);
		};

		/** Delete `id` — its children take its slot (`keepChildren: false`: the whole subtree). */
		const deleteBlock = (id: BlockId, opts: { keepChildren?: boolean } = {}): Prepared =>
			deleteBlocks([id], opts.keepChildren === false);

		/**
		 * The target role decides (UW-21): nothing renders a void's children,
		 * so a block retyped to a void kind hands them to the slot right after
		 * it, as the kind they show there (`settledKind`). Each moves to the
		 * rank the read-time
		 * shedding gives it (`promotedRank`, UW-21b), so a child a peer adds
		 * meanwhile keeps its place in the void's order among them. An island
		 * declared `lines` retyped to an ordinary kind keeps its lines, each
		 * retyped to the new kind's default child (the document's where that
		 * renders no content): no line kind outside its island. Any other
		 * island's children keep their kinds (a table's rows stay rows), as
		 * `typeOf` shows a child a peer adds meanwhile (DR-crdt-2).
		 */
		const retypeSteps = (id: BlockId, type: string): PlanStep[] => {
			const { kids } = view();
			const pos = positionOf(id);
			const steps = attr(id, TYPE, type);
			const moved = kids.get(id) ?? [];
			// A code block retyped to an ordinary kind keeps its lines as that kind's children
			// (`leavingIsland`: never a kind that hides their text, AW-05).
			const lined = is(id, (t) => roles.line(t) !== undefined);
			if (lined && !roles.island(type) && !roles.childless(type)) {
				const to = roles.defaultChild(type);
				return [
					...steps,
					...moved.flatMap((k) => {
						const kind = leavingIsland(id, blockTypeOf(k.id), to);
						return kind === undefined ? [] : attr(k.id, TYPE, kind);
					})
				];
			}
			if (!roles.childless(type) || moved.length === 0 || pos === null) return steps;
			const slotRank = kids.get(pos.parent)![pos.index]!.rank;
			const ids = moved.map((k) => k.id);
			return [
				...steps,
				...moveTo(
					ids,
					pos.parent,
					pos.index + 1,
					moved.map((k) => promotedRank(slotRank, k.rank))
				),
				...settle(id, ids, pos.parent)
			];
		};

		/** Set the block type (attr write — the block keeps its identity; see `retypeSteps`). */
		const setBlockType = (id: BlockId, type: string): Prepared => {
			id = ref(id);
			return live(id) ? plan([id], retypeSteps(id, ref(type))) : REFUSED;
		};

		/**
		 * Patch the data of a block, one of its inline atoms or the document
		 * (`null`), in order (`crdt/data.ts`): each patch replaces the value at
		 * its path (`value` absent deletes it), `splice` and `order` edit the
		 * array there; a path addresses array items by index, resolved here
		 * to the items' ids. Only the leaves it changes are written, so a
		 * peer's edit of another key or item is kept. Refused for an absent
		 * target, a path that is no array of strings, a root value that is no
		 * object, or an op that fits no value at its path.
		 */
		const patchData = (target: DataTarget, patches: readonly DataPatch[]): Prepared => {
			const valid = (p: DataPatch) =>
				Array.isArray(p?.path) &&
				p.path.every((k) => typeof k === 'string') &&
				(p.path.length > 0 || p.value === undefined || isObject(p.value));
			if (!Array.isArray(patches) || !patches.every(valid)) return REFUSED;
			// Only the fields a patch has: an absent one is no non-JSON value to report.
			const clean = patches.map(({ path, value, splice, order }) =>
				sanitizeWireJson({
					path,
					...(value !== undefined && { value }),
					...(splice !== undefined && { splice }),
					...(order !== undefined && { order })
				})
			);
			const t: DataTarget =
				target === null
					? null
					: typeof target === 'string'
						? ref(target)
						: { block: ref(target.block), atom: ref(target.atom) };
			if (typeof t === 'string' ? !live(t) : t !== null && atomOf(t.block, t.atom) === undefined)
				return REFUSED;
			const steps = dataSteps(t, clean);
			return steps ? plan(t === null ? [] : [typeof t === 'string' ? t : t.block], steps) : REFUSED;
		};

		/**
		 * Baseline `setBlock`: `type` updates the block in place and `data`
		 * sets the leaves it names, removing none (`data.retype.keep`, H4: a
		 * retype keeps the block's properties, as Notion's Turn into does;
		 * `setBlockData` replaces them); `content`/`children` REPLACE
		 * wholesale — explicit replacement is a
		 * new-identity operation; a retype to a void kind without `children`
		 * unnests the current ones (`retypeSteps`). All-or-nothing (D-12): children
		 * for a block that is `void` after the write, or a replacement id that
		 * is already taken (a live or deleted
		 * block, the replaced children included, or a duplicate inside the
		 * replacement), refuses before any write — `id-collision` for the
		 * latter. A caller wanting a child back re-creates it with a fresh id.
		 */
		const setBlock = (
			id: BlockId,
			value: {
				type?: string;
				data?: Record<string, unknown>;
				content?: ContentItem[];
				children?: BlockSpec[];
			}
		): Prepared => {
			id = ref(id);
			const content = value.content?.map(sanitizeItem);
			const children = value.children?.map(sanitizeSpec);
			if (!live(id) || (content !== undefined && !contentTarget(id))) return REFUSED;
			const type = value.type === undefined ? undefined : ref(value.type);
			const toVoid = type === undefined ? isVoid(id) : roles.childless(type);
			if (children?.length && toVoid) return REFUSED;
			if (children !== undefined && M.collides(doc, children)) return refused('id-collision');
			const data =
				value.data === undefined ? [] : dataSteps(id, leafSets(value.data, blockDataOf(id)));
			if (data === null) return REFUSED;
			const writes: PlanStep[] = [
				...(type === undefined
					? []
					: children === undefined
						? retypeSteps(id, type)
						: attr(id, TYPE, type)),
				...data
			];
			if (content !== undefined) {
				const length = displayLength(id);
				if (length > 0) writes.push({ op: 'deleteText', id, offset: 0, length });
				let at = 0;
				for (const item of content) {
					if (item.kind === 'inline')
						writes.push({ op: 'insertInline', id, offset: at++, atom: item });
					else if (item.text !== '') {
						writes.push({ op: 'insertText', id, offset: at, text: item.text, marks: item.marks });
						at += item.text.length;
					}
				}
			}
			if (children !== undefined) {
				for (const kid of childrenIds(id)) writes.push(remove(kid));
				// Every current child is deleted, so the new ones rank from an empty list.
				const ranks = M.ranksAt([], 0, children.length, doc.clientID, randOf(doc));
				if (children.length > 0)
					writes.push({ op: 'insertBlocks', parent: id, index: 0, specs: children, ranks });
			}
			return plan([id], writes);
		};

		/**
		 * Explicit fresh-identity copy of a subtree (paste / drag-clone):
		 * serializes `id`, remaps every block and inline atom id through
		 * `freshId`, inserts the copy right after `id`. Text atoms get new
		 * identity too — duplication is a creation op, not a relocation. An
		 * inline id `freshId` does not answer (a block-only callback) is
		 * minted; a block id it does not answer refuses the copy. `ids`: the
		 * copy's root.
		 */
		const duplicateBlock = (
			id: BlockId,
			freshId: (oldId: string, kind: 'block' | 'inline') => string
		): Prepared => {
			id = ref(id);
			const pos = positionOf(id);
			if (pos === null) return REFUSED;
			const spec = (b: BlockId): BlockSpec | null => {
				const fresh = freshId(b, 'block');
				if (typeof fresh !== 'string') return null;
				const content = contentItems(b).map((item) => {
					if (item.kind !== 'inline') return item;
					const atom = freshId(item.id, 'inline');
					return { ...item, id: typeof atom === 'string' ? atom : newId('i') };
				});
				const children = childrenIds(b).map(spec);
				if (children.includes(null)) return null;
				const data = blockDataOf(b);
				return {
					id: fresh,
					type: kindToCopy(b),
					...(data !== undefined && { data }),
					content,
					children: children as BlockSpec[]
				};
			};
			const copy = spec(id);
			return copy ? insertBlocks({ parent: pos.parent, index: pos.index + 1 }, [copy]) : REFUSED;
		};

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
