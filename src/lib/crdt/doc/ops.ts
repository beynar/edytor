/**
 * The prepared ops of one facade, in one closure over its reads: the
 * structural capability (`canPlace`, `fits`, `canMerge`: one answer in
 * advance and at execution), the step writers every op composes, and the
 * op families — placement (insert, move, outdent, lift), layout, split and
 * merge, block deletion, meta (type and data) and content (text, atoms,
 * marks). Range deletion and flow placement (`rangeDelete.ts`, `flow.ts`)
 * compose them.
 *
 * ── Island/void enforcement (operation-layer, not stored) ──────────────
 *
 * Roles are resolved operation-time via `config.roleOf(type)`, through one
 * role table (`DisplayRoles`) that the index's display and every guard
 * below ask of a block's shown kind — the editor derives them from plugin
 * block definitions, exactly like the baseline's
 * `block.definition.island/void`. They are deliberately NOT replicated block
 * data: the schema stays policy-free, and a replica with different plugins
 * reads the same document. Enforced rules (baseline semantics, see
 * `plugins.ts` + `block.utils.ts`):
 *
 * - `void`: cannot accept children (insert/move/nest into void rejected),
 *   cannot merge either direction, cannot be split. Content edits ARE
 *   allowed — void rendered content (captions) stays editable per the
 *   baseline contract. Deletion is allowed (delete is not editing).
 * - `island`: editable content, but its subtree is structurally sealed —
 *   a block inside an island (`insideIsland`) cannot be moved, nested,
 *   unnested, or merged across the island boundary. Merges INSIDE one
 *   island are allowed; merging an island child into the island itself is
 *   allowed when the island renders its content. Moving or merging
 *   INTO an island subtree is rejected. An island declared `lines` (code)
 *   holds only lines of its `defaultChild` kind, and a line holds no
 *   children (the display enforces it against undo,
 *   `insertBlocks` refuses a line parent); any other island keeps its
 *   structure. `canPlace` and `canMerge` are the one answer, asked in
 *   advance or by the ops.
 * - Island merge: when an island block itself is merged (backward or
 *   forward), its children are unnested to the vacated sibling slot and
 *   reset to the default child of that slot's parent (`defaultChild`).
 * - Baseline merges NEVER adopt the merged block's children — they unnest
 *   to the vacated slot. The facade exposes both: `mergeBlocks` is the
 *   engine primitive (children adopt into the target
 *   by staying under the source, which the target's claim displays),
 *   `mergeBackward`/`mergeForward` reproduce the baseline command shape.
 */
import { id as newId } from '../../utils.js';
import {
	asBlockSpec,
	asContentItem,
	jsonEquals,
	sanitizeSpec,
	sanitizeWireJson,
	type JSONBlock,
	type JSONInlineBlock,
	type JSONText
} from '../../utils/json.js';
import { isIncarnationId } from '../incarnations.js';
import { randOf } from '../rand.js';
import { TYPE } from '../schema.js';
import { isObject, leafKey, patchWrites, readData, type DataPatch } from '../data.js';
import {
	blockNodeOf,
	collides,
	isLiveIn,
	isSelfOrDescendant,
	type BlockId,
	type BlockSpec,
	type ContentItem,
	type Destination,
	type InlineSpec,
	type SplitTail
} from '../placement/model.js';
import { REFUSED, effectOf, ref, refused, sanitizeInline, sanitizeItem } from './plan.js';
import type { DataTarget, JsonObj, Plan, PlanStep, Prepared } from './types.js';
import type { DocBase, DocReads } from './reads.js';

/**
 * A record's order among the records standing at one block, for the
 * engine's sort of two records at one origin (fork patch YP22): what a split
 * of a list around a block writes there — a new head list holding the items
 * before it (`head`), new blocks placed after the items before it, which
 * stay (`kept`), a head holding those items and the block (`with`), the
 * block itself leaving (`self`), new blocks after it (`after`) — in the
 * order every serial run of the gestures gives (`del.merge.container`).
 */
export const PART = { head: 0, kept: 1, with: 2, self: 3, after: 4 } as const;

/** An inline atom to insert: its id is minted when it names none. */
export type NewInline = Omit<InlineSpec, 'id'> & { id?: string };

/** The prepared ops of one facade over its reads. */
export const docOps = (c: DocBase & DocReads) => {
	const {
		doc,
		runsView,
		roles,
		roleOf,
		dataNode,
		view,
		blockTypeOf,
		blockDataOf,
		childrenIds,
		positionOf,
		ancestorsOf,
		isVoid,
		isIsland,
		isLines,
		isLine,
		islandOf,
		insideIsland,
		itemKindOf,
		isLayout,
		isLayoutItem,
		holdsLayout,
		insideItem,
		isTable,
		isTableRow,
		isRowKind,
		isCellKind,
		next,
		previous,
		displayLength,
		contentItems,
		live,
		contentTarget
	} = c;

	// ── structural capability: one answer in advance and at execution ──

	/**
	 * May `ids` be placed under `parent` (`null` = the root)? Every id is
	 * live, distinct and outside any island interior (island subtrees are
	 * sealed); the destination is live, neither void nor an island nor
	 * inside one, and not inside any moved block's own subtree; and every
	 * block fits it as the kind `kindOf` gives (`fits`; a move keeps its
	 * kind) or already sits in it (a reorder changes nothing a list holds:
	 * an image shed into a list still moves among its items); and
	 * no layout, nor a block holding one, lands inside a layout item
	 * (`layout.nest`). A table's cell never moves, and its row only
	 * within its table (`table.fits`).
	 * Without a `parent`: may these blocks move at all (the drag
	 * affordance). The move ops refuse exactly when this answers `false`.
	 * (`insertBlock` is looser — island interiors are built by inserting
	 * into them.)
	 */
	const canPlace = (
		ids: readonly BlockId[],
		parent?: BlockId | null,
		kindOf: (id: BlockId) => string | undefined = blockTypeOf
	): boolean => {
		const v = view();
		if (ids.length === 0 || new Set(ids).size !== ids.length) return false;
		if (ids.some((id) => !isLiveIn(v, id) || insideIsland(id, v))) return false;
		// A cell moves only with its column, never as a block (`table.fits`).
		if (ids.some((id) => isCellKind(blockTypeOf(id)))) return false;
		// A row moves only within its table: a table's rows are reordered, never re-homed.
		const rows = ids.filter((id) => isRowKind(blockTypeOf(id)));
		if (rows.length > 0 && parent !== undefined)
			if (parent === null || rows.some((id) => positionOf(id)?.parent !== parent)) return false;
		if (parent === undefined || parent === null) return true;
		if (!isLiveIn(v, parent) || isVoid(parent)) return false;
		const stays = (id: BlockId) => positionOf(id)?.parent === parent;
		if (!ids.every((id) => stays(id) || fits(parent, kindOf(id)))) return false;
		if (insideItem(parent, v) && ids.some(holdsLayout)) return false;
		return ![parent, ...ancestorsOf(parent, v)].some((a) => isIsland(a) || ids.includes(a));
	};

	/**
	 * A container: a block that shows only its children — no content of
	 * its own, neither void nor an island (a list, a table row, a column).
	 */
	const isContainer = (id: BlockId): boolean => roles.of(blockTypeOf(id) ?? '').container;
	/**
	 * THE container rule: may a block of `kind` sit directly
	 * under `parent` (`null` = the root)? A container whose default child is
	 * a kind of its own — its item (a list's `list-item`, a columns
	 * layout's `column`) — holds only its items, and containers of them
	 * when the item renders content (a list directly in a list, from JSON
	 * or the API; a layout holds no layout, `layout.fits`); one whose
	 * default child is the document's (a column) holds any block. Every
	 * structural placement asks it: a move is refused where its blocks do
	 * not fit (`canPlace`), Tab nests under a container's last item
	 * (`nestParent`), an outdent or a lift is refused where the block would
	 * not fit, and a block a merge, delete or range sheds into a container
	 * takes its item kind when it is a plain block (`fitted`). Explicit kind
	 * writes (`insertBlocks`, a retype) place what they are told (the
	 * view's Turn into places the kind where it fits first, `liftOut`); a
	 * plain block stored directly in a list still shows as its item (the
	 * index's `typeOf`), whatever write or race put it there.
	 */
	const fits = (parent: BlockId | null, kind: string | undefined): boolean =>
		parent === null || fitsIn(blockTypeOf(parent) ?? '', kind);
	/** `fits`, by the parent's kind (a block not written yet: `placeBeside`'s new item). */
	const fitsIn = (parentType: string, kind: string | undefined): boolean => {
		const { container, child: item } = roles.of(parentType);
		if (!container || item === defaultChild(null) || kind === item) return true;
		const k = kind === undefined ? undefined : roles.of(kind);
		return k?.container === true && k.child === item && roles.of(item).rendersContent;
	};
	/**
	 * `kind`, or — where a plain block (the document's default kind, or
	 * none: a pasted run) does not fit `parent` — `parent`'s item, when
	 * that renders content (a paragraph landing in a list is its item; one
	 * in a columns layout keeps its kind: its text never vanishes). Any
	 * other kind keeps its kind and data wherever a merge, a delete or a
	 * paste sheds it — an image under a bullet stays an image, a heading a
	 * heading, a to-do keeps its check — as a peer's
	 * concurrent promotion shows it (`typeOf` resets only the default
	 * kind); an outdent or a move that would place one directly in a list
	 * is refused (`fits`).
	 */
	const fitted = (parent: BlockId | null, kind: string | undefined): string | undefined => {
		if (fits(parent, kind) || (kind !== undefined && kind !== defaultChild(null))) return kind;
		const item = defaultChild(parent);
		return roles.of(item).rendersContent ? item : kind;
	};
	/** A container that goes once it loses every child: it holds no text of its own (a peer's retype can leave some, hidden: it renders none). */
	const emptiable = (id: BlockId): boolean => isContainer(id) && displayLength(id) === 0;
	/**
	 * Where `ids` nest when nested into `parent` (Tab, a drop inside it):
	 * `parent`, or — a container they are no items of — its last child,
	 * and so on down. Tab after a list nests under its last item (Notion);
	 * a last child that holds no children (an image, a code block) is
	 * answered as it is, and `canPlace` refuses it, as Tab right under
	 * that block is refused.
	 */
	const nestParent = (ids: readonly BlockId[], parent: BlockId): BlockId => {
		let at = parent;
		while (!ids.every((id) => fits(at, blockTypeOf(id)))) {
			const last = childrenIds(at).at(-1);
			if (last === undefined) break;
			at = last;
		}
		return at;
	};

	/**
	 * May `fromId`'s content merge into `intoId`? Both live and distinct,
	 * neither void, `intoId` renders its content (a list, a table row or a
	 * code block shows none, so a first item, cell or line never merges
	 * into it), `fromId` renders its own unless it is
	 * an island (a list or a row never merges as a whole: its items would
	 * leave it, `del.merge.container`), and the merge stays on one side of an island
	 * boundary (a block may merge into its own island root — that stays
	 * inside — but nothing from outside merges into an island).
	 */
	const canMerge = (fromId: BlockId, intoId: BlockId): boolean => {
		const v = view();
		if (fromId === intoId || !isLiveIn(v, fromId) || !isLiveIn(v, intoId)) return false;
		if (isVoid(fromId) || isVoid(intoId)) return false;
		// Nothing merges into or out of a table's cell (`table.merge`).
		if (isCellKind(blockTypeOf(fromId)) || isCellKind(blockTypeOf(intoId))) return false;
		if (!rendersContent(intoId) || !(rendersContent(fromId) || isIsland(fromId))) return false;
		const islandFrom = islandOf(fromId, v);
		if (intoId === islandFrom) return true;
		return islandFrom === islandOf(intoId, v) && !isIsland(intoId);
	};

	/** `id`'s shown kind renders its content. */
	const rendersContent = (id: BlockId): boolean => roles.of(blockTypeOf(id) ?? '').rendersContent;

	/** The adopted default child type under `parent` (`null` = the root). */
	const defaultChild = (parent: BlockId | null): string =>
		roles.of(parent === null ? null : (blockTypeOf(parent) ?? null)).child;
	/**
	 * The kind a new block copies from `id` (a split tail, a flow's tail,
	 * a duplicate and each of its descendants). A type a peer's retype is
	 * replacing can be missing while its new value is pending: the copy
	 * then takes its parent's default child, never a missing type
	 * (it showed as `unknown` everywhere, for good).
	 */
	const kindToCopy = (id: BlockId): string =>
		blockTypeOf(id) ?? defaultChild(positionOf(id)?.parent ?? null);

	// ── the step writers every op composes ──────────────────────────────
	// The plan itself, moves (a move's place and side), type steps and the
	// kind a block shows where it lands (`settle`), the containers and layouts
	// a write leaves empty (`emptying`, `dissolving`), delete and merge steps,
	// and display spans of a block's content.

	// ── prepared ops ─────────────────────────────────────────────
	// Every op is `prepare` (pure: `refused`, or a plan of named steps plus
	// its effect summary, against the current version) then `apply(plan)`;
	// composites compose their steps into one plan, so a hook sees the
	// whole command before any write and a refusal refuses before one.
	// Each prepare normalizes its inputs once, here at ingress: ids
	// and strings as the wire would deliver them, payloads cloned.

	const plan = (ids: readonly BlockId[], writes: PlanStep[]): Plan => ({
		ids,
		writes,
		effect: effectOf(writes),
		version: runsView.version()
	});

	/**
	 * Move `ids` to display index `index` among `parent`'s children (the
	 * slot hooks see). `side`: the move record's class among the items of
	 * its origin (`placement/slots.ts`) — `0`, the blocks stand after what
	 * precedes them (a move; blocks leaving a block for the gap after it:
	 * its children, a list's last items); `1`, before what follows them
	 * (blocks leaving a block for the gap before it: a list's first item
	 * lifted out). In one gap every serial order of the gestures puts a
	 * split's pieces first, then the after-records, then the before-records
	 * (`del.merge.container`), which the engine's sort gives whatever the
	 * client ids.
	 * Every planned move carries the type steps that keep what the moved
	 * blocks show: one displayed out of an island as another kind than its
	 * stored one (`displayType`) gets that kind written, so leaving the
	 * island's slot never brings the island's child kind back.
	 * `at`, `part`: the block the record stands at and its order among the
	 * records standing there, for the engine's sort of two records at one
	 * origin (`PART`; by default the first moved block, as itself).
	 */
	const moveTo = (
		ids: BlockId[],
		parent: BlockId | null,
		index: number,
		side: 0 | 1 = 0,
		at?: BlockId,
		part?: number
	): PlanStep[] =>
		ids.length === 0
			? []
			: [
					{
						op: 'moveBlocks',
						ids,
						parent,
						index,
						...(side === 1 && { side }),
						...(at !== undefined && { at }),
						...(part !== undefined && { part })
					},
					...ids.flatMap((id) => {
						const shown = runsView.displayType(id);
						return shown === undefined ? [] : attr(id, TYPE, shown);
					})
				];
	/** Move `ids` to `index` among `parent`'s children. */
	const move = (ids: BlockId[], parent: BlockId | null, index: number): PlanStep[] =>
		moveTo(ids, parent, index);
	/** The side of blocks leaving a block for the gap right after it (`after`) or right before it. */
	const leaving = (after: boolean): 0 | 1 => (after ? 0 : 1);
	/**
	 * A type step, planned only when the kind differs (the one same-value
	 * guard). A kind counts as the same only when the block is stored and
	 * shown as it: a move in the same plan pins the kind a block shows
	 * (`moveTo`), so a paragraph shown as its list's item (`itemOf`) that
	 * an outdent settles back to a paragraph is written back.
	 */
	const attr = (id: BlockId, key: typeof TYPE, value: string): PlanStep[] => {
		const same = blockNodeOf(doc, id)!.getAttr(key) === value;
		if (same && (runsView.displayType(id) ?? value) === value) return [];
		return [{ op: 'setBlockType', id, type: value }];
	};

	/**
	 * The kind `kid` shows once it leaves `from` for a slot under `parent`
	 * — the island and container rules, one answer:
	 * - an island's child takes `parent`'s default child (it leaves the
	 *   island's kinds) — unless that renders no content while the child
	 *   does: a line then takes the document's default kind (a code line
	 *   shed into a columns layout is a paragraph), any other child
	 *   keeps its kind, as `typeOf` shows one a peer adds meanwhile;
	 * - a container's item (its default child) takes `parent`'s default
	 *   child — an item never shows outside its list — unless it
	 *   stays inside an outer container of that kind (a nested list),
	 *   or that kind renders no content (a column in a
	 *   columns layout: its text would vanish);
	 * - then a plain block that does not fit `parent` (`fits`: a paragraph
	 *   shed into a list) becomes its item, when that item renders content
	 *   (`fitted`). A block that cannot (a paragraph in a columns
	 *   layout) keeps its kind: its text never vanishes; any other kind (an
	 *   image, a code block, a heading) keeps its kind.
	 */
	/**
	 * The kind a child of `island` (now `kind`) takes where the default
	 * child is `to`: `to` — unless `to` renders no content while the child
	 * does (its text would vanish): a line then takes the document's
	 * default kind, any other child keeps its kind (as `typeOf`).
	 */
	const leavingIsland = (island: BlockId, kind: string | undefined, to: string) => {
		if (roles.of(to).rendersContent || (kind !== undefined && !roles.of(kind).rendersContent))
			return to;
		return isLines(island) ? defaultChild(null) : kind;
	};
	const settledKind = (
		from: BlockId | null,
		kid: BlockId,
		parent: BlockId | null
	): string | undefined => {
		let kind = blockTypeOf(kid);
		if (from !== null && isIsland(from)) kind = leavingIsland(from, kind, defaultChild(parent));
		else if (from !== null && isContainer(from) && kind === defaultChild(from)) {
			const within = parent === null ? [] : [parent, ...ancestorsOf(parent)];
			const to = defaultChild(parent);
			// An outer container of its kind keeps it an item (a nested list); a
			// column's default child is the document's: it holds no items of its own.
			const outer =
				kind !== defaultChild(null) &&
				within.some((a) => isContainer(a) && defaultChild(a) === kind);
			if (!outer && roles.of(to).rendersContent) kind = to;
		}
		return fitted(parent, kind);
	};
	/** The kind steps for the `kids` of `from` (`null`: the root) landing under `parent` (`settledKind`). */
	const settle = (
		from: BlockId | null,
		kids: readonly BlockId[],
		parent: BlockId | null
	): PlanStep[] =>
		kids.flatMap((kid) => {
			const kind = settledKind(from, kid, parent);
			return kind === undefined || kind === blockTypeOf(kid) ? [] : attr(kid, TYPE, kind);
		});
	/** `parent` and its display ancestors: where blocks landing under `parent` keep alive. */
	const landing = (parent: BlockId | null): Set<BlockId | null> =>
		new Set(parent === null ? [] : [parent, ...ancestorsOf(parent)]);
	/**
	 * `writes`, then every container one of `from` (the blocks' former
	 * parents) is left with no child but `leaving` removed
	 * (`del.range.empty-container`), and so on upward — never one of
	 * `kept`, and only an `emptiable` one (a container holding text of its
	 * own stays). The containers are found together, deepest first: a
	 * list that loses its last item along with a list nested in it goes
	 * too. Then every layout the plan leaves with one
	 * item or none dissolves (`dissolving`); `removed`: blocks the plan
	 * deletes besides (a block delete's members), which only that counts.
	 */
	const emptyingAll = (
		from: readonly (BlockId | null)[],
		leaving: readonly BlockId[],
		writes: readonly PlanStep[],
		kept: ReadonlySet<BlockId | null> = new Set(),
		removed: readonly BlockId[] = []
	): PlanStep[] => {
		const gone = new Set<BlockId>(leaving);
		const tops: BlockId[] = [];
		const deepest = [...new Set(from)]
			.filter((c): c is BlockId => c !== null)
			.sort((a, b) => ancestorsOf(b).length - ancestorsOf(a).length);
		for (const start of deepest) {
			let top: BlockId | null = null;
			for (
				let c: BlockId | null = start;
				c !== null && !gone.has(c) && !kept.has(c) && emptiable(c);
				c = positionOf(c)!.parent
			) {
				if (!childrenIds(c).every((kid) => gone.has(kid))) break;
				gone.add((top = c));
			}
			if (top !== null) tops.push(top);
		}
		const roots = tops.filter((t) => !ancestorsOf(t).some((a) => tops.includes(a)));
		const steps = [...writes, ...roots.map((t) => remove(t, leaving))];
		for (const id of removed) gone.add(id);
		return [...steps, ...dissolving(gone, leaving, steps)];
	};
	/**
	 * `layout.dissolving`: the steps that delete each layout a plan leaves
	 * with one item or none — `gone` (blocks the plan removes) and
	 * `leaving` (blocks it moves) no longer count, an item `writes` move or
	 * insert into it does. With one left, the layout and that item are
	 * deleted and the item's children moved right after the layout, where
	 * `layout.single` shows them, as the kind they show there (`settle`);
	 * with none, the layout is deleted. One plan with the write that caused
	 * it.
	 */
	const dissolving = (
		gone: ReadonlySet<BlockId>,
		leaving: readonly BlockId[],
		writes: readonly PlanStep[]
	): PlanStep[] => {
		const away = new Set([...gone, ...leaving]);
		const layouts = new Set<BlockId>();
		for (const id of away) {
			const parent = positionOf(id)?.parent;
			if (parent != null && isLayout(parent)) layouts.add(parent);
		}
		const { kids } = view();
		const out: PlanStep[] = [];
		for (const layout of layouts) {
			if ([layout, ...ancestorsOf(layout)].some((a) => gone.has(a))) continue;
			const item = itemKindOf(layout)!;
			const arriving = writes.reduce(
				(n, w) =>
					w.op === 'moveBlocks' && w.parent === layout
						? n + w.ids.filter((id) => blockTypeOf(id) === item).length
						: w.op === 'insertBlocks' && w.parent === layout
							? n + w.specs.filter((spec) => spec.type === item).length
							: n,
				0
			);
			const slots = kids.get(layout) ?? [];
			const items = slots.filter((k) => !away.has(k.id) && blockTypeOf(k.id) === item);
			if (items.length + arriving > 1) continue;
			const { parent } = positionOf(layout)!;
			const last = items[0];
			if (last === undefined) {
				out.push(deleting(layout, [layout]));
				continue;
			}
			// Its blocks keep their home slots: the read shows them in the layout's
			// slot (`layout.single`), settled for its parent.
			const moved = (kids.get(last.id) ?? []).filter((k) => !away.has(k.id));
			const ids = moved.map((k) => k.id);
			out.push(...settle(last.id, ids, parent), deleting(layout, [layout, last.id]));
		}
		return out;
	};
	/** `writes`, then `container` removed when they leave it no child but `leaving` (`emptyingAll`). */
	const emptying = (
		container: BlockId,
		leaving: readonly BlockId[],
		writes: readonly PlanStep[],
		kept?: ReadonlySet<BlockId | null>
	): PlanStep[] => emptyingAll([container], leaving, writes, kept);
	/**
	 * Delete: `removes` leave. Every one is marked with what it
	 * displays — an unmarked one would be promoted into the deleted slot
	 * (`displaySlotOf`).
	 */
	const deleting = (id: BlockId, removes: BlockId[]): PlanStep => {
		const marks = [...new Set(removes.flatMap((b) => view().displays(b)))];
		return { op: 'deleteBlock', id, marks, removes };
	};
	/** Delete `id` and its subtree, `kept` children aside. */
	const remove = (id: BlockId, kept: readonly BlockId[] = []): PlanStep => {
		const removes: BlockId[] = [];
		const skip = new Set(kept);
		const walk = (b: BlockId): void => {
			removes.push(b);
			for (const kid of childrenIds(b)) if (!skip.has(kid)) walk(kid);
		};
		walk(id);
		return deleting(id, removes);
	};
	const merge = (from: BlockId, into: BlockId): PlanStep => ({
		op: 'mergeBlocks',
		from,
		into,
		at: displayLength(into),
		length: displayLength(from)
	});
	/** `[at, end)` — `[offset, offset + length)` clamped to `id`'s display. */
	const clamp = (id: BlockId, offset: number, length: number): [number, number] => {
		const total = displayLength(id);
		const at = Math.max(0, Math.min(offset, total));
		return [at, Math.min(total, at + Math.max(0, length))];
	};
	/** `id`'s display items, each with its `[at, end)` display offsets. */
	const spans = (id: BlockId) => {
		let end = 0;
		return contentItems(id).map((item) => {
			const at = end;
			end += item.kind === 'text' ? item.text.length : 1;
			return { item, at, end };
		});
	};
	/** The live inline atom `atom` in `id`'s display, or undefined. */
	const atomOf = (id: BlockId, atom: string) =>
		live(id) ? spans(id).find(({ item }) => item.kind === 'inline' && item.id === atom) : undefined;
	/** Text items overlapping `[at, end)` of `id` (inline atoms carry no marks). */
	const textIn = (id: BlockId, at: number, end: number) =>
		spans(id).flatMap((s) => (s.item.kind === 'text' && s.at < end && s.end > at ? [s.item] : []));
	/** Push the steps writing `items` into `id` from `at` (text runs and atoms in order); the end offset. */
	const writeContent = (
		writes: PlanStep[],
		id: BlockId,
		at: number,
		items: readonly ContentItem[] = []
	): number => {
		for (const item of items) {
			if (item.kind === 'inline') writes.push({ op: 'insertInline', id, offset: at++, atom: item });
			else if (item.text !== '') {
				writes.push({ op: 'insertText', id, offset: at, text: item.text, marks: item.marks });
				at += item.text.length;
			}
		}
		return at;
	};

	/** `writes`, then every container the `leaving` blocks leave with no child removed. */
	const emptied = (
		leaving: readonly BlockId[],
		writes: PlanStep[],
		kept?: ReadonlySet<BlockId | null>
	): PlanStep[] =>
		emptyingAll(
			leaving.map((id) => positionOf(id)!.parent),
			leaving,
			writes,
			kept
		);

	// ── placement: insert (`insertBlocks`, `duplicateBlock`), move
	// (`moveBlocks`), outdent (`unNestBlocks`) and the lift out of the
	// containers a kind does not fit (`landingOf`, `splitOut`, `liftOut`) ──

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
	const insertBlocks = (dest: Destination, specs: readonly (BlockSpec | JSONBlock)[]): Prepared => {
		const parent = ref(dest.parent);
		const clean = specs.map((spec) => sanitizeSpec(asBlockSpec(spec)));
		if (parent !== null && (isVoid(parent) || isLine(parent))) return REFUSED;
		if (clean.length === 0) return plan([], []);
		if ((parent !== null && !live(parent)) || collides(doc, clean)) return REFUSED;
		return plan(
			clean.map((s) => s.id),
			[{ op: 'insertBlocks', parent, index: dest.index, specs: clean }]
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
	 * Outdent: move sibling blocks `ids` (document order) right
	 * after their parent, and hand the siblings that followed the last of
	 * them to it as its last children — every outliner's Shift+Tab. A last
	 * block that cannot adopt them (void, island, a container they do not
	 * fit) leaves them with the parent. The blocks take the kind they show
	 * in their new slot (`settledKind`: a list's item becomes a paragraph,
	 * a paragraph outdented into a list its item); refused where one would
	 * not fit (a paragraph out of a column into its columns layout).
	 * Items leaving a container never take the items after them:
	 * the list splits around them, Notion's way — outdented first items go
	 * before it, last ones after it; from the middle, the list keeps the
	 * items after them and a new list of its kind takes the ones before
	 * them, so an item a peer appends meanwhile stays with the items it
	 * follows (`splitOut`, the split Turn into's `liftOut` makes). A
	 * container left with no child goes. One plan; refused as the
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
		const writes = [...moveTo(moved, ppos.parent, ppos.index + 1, leaving(true)), ...retype];
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
	 * Its own kind keeps a block where it is, as a reorder
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
	 * containers around them, innermost first: each level
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
		const insert = (at: BlockId | null, index: number, s: BlockSpec[]) =>
			s.length ? [{ op: 'insertBlocks' as const, parent: at, index, specs: s }] : [];
		const last = ids.at(-1)!;
		const { parent, index } = positionOf(levels.at(-1) ?? last)!;
		if (levels.length === 0) return plan(placed, [...insert(parent, index + 1, specs), ...retype]);
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
			const stays: boolean = (keep && child === last) || (before !== null && !before.head);
			const lead: BlockId[] = kids.slice(0, at + (stays ? 1 : 0)).filter((k) => !moved.includes(k));
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
		// Written in one gap, each right after the block before it, as an
		// after-record out of the level's slot or a before-record into the gap
		// before it (`leaving`): the engine's sort decides their order against
		// a peer's records there (fork patch YP22, `sourceOrder`: the block a
		// record stands at, then its part), so a peer's heads, pieces, lifts
		// and new blocks in the same gap keep the serial order whatever the
		// client ids (`del.merge.container`). The head stands at the first block
		// (with `keep`, at it: `with`), the blocks at themselves, the new
		// blocks after the last (`after`) — or, kept before the block that
		// follows, at that block (`kept`). The records are written last first,
		// so each stands before the one written before it, in the order the
		// sort gives them; the head and the new blocks are created in the
		// innermost level right after the block they stand at (their home,
		// hidden while their records show them) and moved out by them.
		const outside = before !== null && !before.head;
		const side = leaving(outside);
		const gap = index + (outside ? 1 : 0);
		const at = moved[0] ?? last;
		const kids0 = childrenIds(levels[0]!);
		const home = kids0.indexOf(last) + 1;
		const specIds = specs.map((sp) => sp.id);
		const [stands, part] = keep && !outside ? [next!, PART.kept] : [last, PART.after];
		// One record per run of adjacent blocks, each standing at its first: a
		// block a peer's move takes out of a run leaves the others at their own place.
		const runs: BlockId[][] = [];
		for (const id of moved) {
			const run = runs.at(-1);
			if (run !== undefined && kids0.indexOf(run.at(-1)!) + 1 === kids0.indexOf(id)) run.push(id);
			else runs.push([id]);
		}
		const writes: PlanStep[] = [
			...insert(levels[0]!, home, specs),
			...(before?.head ? insert(levels[0]!, home, [before.head]) : []),
			...moveTo(specIds, parent, gap, side, stands, part),
			...runs.reverse().flatMap((run) => moveTo(run, parent, gap, side, run[0], PART.self)),
			...(before?.head
				? moveTo([before.head.id], parent, gap, side, at, keep ? PART.with : PART.head)
				: [])
		];
		for (const { spec, kids, inner } of heads.reverse()) {
			writes.push(
				...moveTo(kids, spec.id, 0),
				...(inner ? insert(spec.id, kids.length, [inner]) : [])
			);
		}
		writes.push(...retype);
		void next;
		return plan(placed, emptying(levels[0]!, moved, writes, landing(parent)));
	};
	/**
	 * Place `id` where a block of `kind` fits, in one plan:
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
		if (!positionOf(id) || collides(doc, specs) || !canPlace([id], parent, () => kind))
			return REFUSED;
		return splitOut([id], levels, specs, keep);
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
		freshId: (oldId: string, kind: 'block' | 'inline') => string = (_, kind) =>
			newId(kind === 'block' ? 'b' : 'i')
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

	// ── layout (`layout.*`): the layout kind a new layout takes, where a
	// beside placement lands (`besideAt`), `placeBeside` and `wrapInLayout` ──

	/** The layout kind a new layout takes: `kind` when it is one, else the only one the roles declare. */
	const layoutKind = (kind?: string): string | undefined => {
		if (kind !== undefined) return roles.of(kind).layout === undefined ? undefined : kind;
		const kinds = roles.declared().layouts;
		return kinds.length === 1 ? kinds[0] : undefined;
	};
	/** A fresh empty block of `type`. */
	const spec = (type: string): BlockSpec => sanitizeSpec({ id: newId('b'), type, data: {} });
	/**
	 * The block a beside placement at `target` stands beside
	 * (`layout.place-beside`): a layout or an item for itself; a block whose
	 * parent shows only its children (a list item → its list, at any depth)
	 * or is an island of lines (a code line → its code block) for that
	 * parent; then the block itself when it sits directly in an item or at
	 * the root, or where a new layout of `kind` (else the only layout kind)
	 * fits beside it (a toggle's, a callout's or a nested block's child,
	 * outside any item and island); else its outermost block below the
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
	 * an item, a layout or a block holding one, a block that does not
	 * fit an item, a block or a layout inside an island, and, wrapping,
	 * when there is no layout kind. The sources are cleaned in the same
	 * plan (`emptying`, `dissolving`); a plain move. `ids`: the moved
	 * blocks.
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
		if ((side !== 'left' && side !== 'right') || !canPlace(moved) || !live(target)) return REFUSED;
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
		const item = wrap === undefined ? undefined : roles.of(wrap).layout;
		if (wrap === undefined || item === undefined) return REFUSED;
		if (moved.some((id) => !fitsIn(item, blockTypeOf(id)))) return REFUSED;
		if (layout !== null && (isIsland(layout) || insideIsland(layout, v))) return REFUSED;
		const fresh = spec(item);
		const into = (parent: BlockId) => moveTo(moved, parent, 0);
		let writes: PlanStep[];
		let kept: Set<BlockId | null>;
		if (layout !== null) {
			writes = [{ op: 'insertBlocks', parent: layout, index, specs: [fresh] }, ...into(fresh.id)];
			kept = new Set([fresh.id, ...landing(layout)]);
		} else {
			const pos = positionOf(at)!;
			const host = spec(item);
			const wrapper = { ...spec(wrap), children: right ? [host, fresh] : [fresh, host] };
			writes = [
				{ op: 'insertBlocks', parent: pos.parent, index: pos.index, specs: [wrapper] },
				...moveTo([at], host.id, 0),
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
	 * layout or a block holding one, where the layout does not fit
	 * (`fits`: in a list, a code block) or lands inside an item or an
	 * island, and for a block that does not fit an item. A plain move.
	 * `ids`: the new layout.
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
		const item = wrap === undefined ? undefined : roles.of(wrap).layout;
		if (wrap === undefined || item === undefined || !fits(parent, wrap)) return REFUSED;
		if (parent !== null && (insideItem(parent, v) || isIsland(parent) || insideIsland(parent, v)))
			return REFUSED;
		if (blocks.some((id) => !fitsIn(item, blockTypeOf(id)))) return REFUSED;
		const fill = roles.of(item).child;
		if (columns > blocks.length && !fitsIn(item, fill)) return REFUSED;
		const ordered = blocks.toSorted((a, b) => positionOf(a)!.index - positionOf(b)!.index);
		const items = Array.from({ length: columns }, (_, i) =>
			i < ordered.length ? spec(item) : { ...spec(item), children: [spec(fill)] }
		);
		const wrapper = { ...spec(wrap), children: items };
		const at = positionOf(ordered[0]!)!.index;
		const writes: PlanStep[] = [
			{ op: 'insertBlocks', parent, index: at, specs: [wrapper] },
			...ordered.flatMap((id, i) => moveTo([id], items[i]!.id, 0))
		];
		const kept = new Set<BlockId | null>([
			wrapper.id,
			...items.map((it) => it.id),
			...landing(parent)
		]);
		return plan([wrapper.id], emptied(ordered, writes, kept));
	};

	// ── split and merge: `splitBlock` (one boundary item, no text copied),
	// the engine merge primitive `mergeBlocks`, and the baseline-shaped
	// `mergeBackward`/`mergeForward` (a first item lifts out of its container,
	// a layout item's first block merges across items) ──

	/**
	 * Split `id` at content `offset` into a new sibling `newId` (one boundary
	 * item and the claims that follow it, no text copied; children follow).
	 * `tail` decides the sibling's type/data once (default: the source's —
	 * the kind it displays; an empty `tail.type` is the default too).
	 * Refused on `void` blocks and on blocks that render no content (a
	 * list, a code block: nothing to split). `ids`: the new
	 * block.
	 */
	const splitBlock = (id: BlockId, offset: number, newId: BlockId, tail?: SplitTail): Prepared => {
		id = ref(id);
		const born = ref(newId);
		const pos = positionOf(id);
		const rec = view().blocks.get(id);
		if (pos === null || isVoid(id) || !rendersContent(id) || rec === undefined) return REFUSED;
		// A table's cell holds its lines as line breaks: it never splits (`table.split`).
		if (isCellKind(blockTypeOf(id))) return REFUSED;
		if (isIncarnationId(born) || blockNodeOf(doc, born) !== null) return REFUSED;
		const [at] = clamp(id, offset, 0);
		// An empty tail type is the one a view reads mid-retype: copy the kind.
		const type = tail?.type ? ref(tail.type) : kindToCopy(id);
		const t = tail
			? { type, data: tail.data && sanitizeWireJson(tail.data) }
			: { type, data: readData(rec.node) };
		const length = displayLength(id) - at;
		const split: PlanStep = {
			op: 'splitBlock',
			id,
			offset: at,
			length,
			newId: born,
			tail: t,
			parent: pos.parent,
			index: pos.index + 1
		};
		return plan([born], [split, ...move(childrenIds(id), born, 0)]);
	};

	/**
	 * Engine merge primitive: `from`'s content is claimed by `into`, its
	 * children ADOPTED as `into`'s last children — an island's take
	 * `into`'s default child, like a baseline merge's — and `from` is
	 * hidden via the claim (undo restores it). The children stay under
	 * `from` and display under `into` through the claim, after `into`'s
	 * own children (the display's claim order): a concurrent delete of
	 * `into` voids the claim and `from` comes back with its children,
	 * never below them. Role rules are `canMerge`'s; a merge that would
	 * close a display cycle is refused. `ids`: `into`.
	 */
	const mergeBlocks = (fromId: BlockId, intoId: BlockId): Prepared => {
		const from = ref(fromId);
		const into = ref(intoId);
		const v = view();
		if (!canMerge(from, into) || !contentTarget(into)) return REFUSED;
		if (isSelfOrDescendant(v.placements, v.own, into, from)) return REFUSED;
		const kids = childrenIds(from);
		const retype = settle(from, kids, into);
		// A list its only item leaves goes, as with every sibling op.
		return plan([into], emptied([from], [merge(from, into), ...retype], landing(into)));
	};

	/**
	 * Baseline-shaped merge (both `mergeBackward` and `mergeForward`):
	 * `from`'s children unnest right after `from`'s vacated sibling slot —
	 * NOT adopted into `into` — and take the kind they show there
	 * (`settledKind`: an island's children its parent's default child, a
	 * paragraph in a list its item); then `from`'s content claims
	 * into `into`. Placed after `from`, not at it: a concurrent delete of
	 * `into` revives `from` above its former children.
	 */
	const mergeUnnesting = (from: BlockId, into: BlockId): Prepared => {
		const pos = canMerge(from, into) ? positionOf(from) : null;
		if (pos === null || !contentTarget(into)) return REFUSED;
		const kids = childrenIds(from);
		const retype = settle(from, kids, pos.parent);
		return plan(
			[into],
			[...moveTo(kids, pos.parent, pos.index + 1, leaving(true)), ...retype, merge(from, into)]
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
	 * any island lifts out of it instead (Notion): it takes the
	 * container's slot, as its new parent's default child, with its
	 * children (a first cell stays: nothing leaves an island; a block that
	 * would land directly in a container it is no item of stays too).
	 * The first block of a layout item merges across items
	 * instead, in reading order (`layout.merge`, Notion): into the
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
		if (prev !== null && isContainer(prev) && childrenIds(prev).length === 0) return gone(id, prev);
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
				...moveTo([id], slot.parent, slot.index, leaving(false)),
				...settle(prev, [id], slot.parent)
			];
			return plan([id], emptying(prev, [id], lift, landing(slot.parent)));
		}
		return prev ? mergeUnnesting(id, prev) : REFUSED;
	};

	/**
	 * Baseline `mergeBlockForward`: pull the next block in document order
	 * into `id`. A container passes the merge to its first item (`del.merge.container`:
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

	// ── block deletion (`del.blocks.promote`): only the members leave, the
	// unselected children of a deleted block take its slot ──

	/**
	 * Delete a set of blocks (`del.blocks.promote`): this writer's mark on
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
		// A table goes with its rows and cells, a row with its cells: none shows outside them (`table.delete-row`).
		const whole = (id: BlockId): void => {
			for (const kid of childrenIds(id)) {
				set.add(kid);
				whole(kid);
			}
		};
		for (const id of [...set]) if (isTable(id) || isTableRow(id)) whole(id);
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
			const kept: { id: BlockId; from: BlockId }[] = [];
			// The kept children keep their home slots: the read shows them in the
			// root's slot, in its order (a block a peer puts under a member
			// meanwhile takes the slot in that order too); only their kinds are
			// written, as the slot's parent settles them.
			const walk = (b: BlockId): void => {
				chunk.push(b);
				for (const kid of kids.get(b) ?? []) {
					if (set.has(kid.id)) walk(kid.id);
					else kept.push({ id: kid.id, from: b });
				}
			};
			walk(root);
			members.push(...chunk);
			if (kept.length > 0) promoting.add(root);
			// A layout shows only its items: a deleted item's blocks show right
			// after the layout (`layout.only-items`), settled for its parent.
			const item = pos.parent === null ? undefined : itemKindOf(pos.parent);
			const out = (k: { id: BlockId }) => item !== undefined && blockTypeOf(k.id) !== item;
			return [
				...kept.flatMap((k) =>
					settle(k.from, [k.id], out(k) ? positionOf(pos.parent!)!.parent : pos.parent)
				),
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

	// ── meta: a block's type (`setBlockType`, the steps a retype implies),
	// its data, a block's, an atom's or the document's (`patchData`, the
	// data steps of a patch), and the baseline `setBlock` ──

	/**
	 * The data step of `patches` (sanitized) on a block, one of its atoms or
	 * the document (`crdt/data.ts`): none when it changes nothing, `null`
	 * when a patch is refused.
	 */
	const dataSteps = (target: DataTarget, patches: DataPatch[]): PlanStep[] | null => {
		const [id, inlineId] =
			typeof target === 'object' && target ? [target.block, target.atom] : [target ?? undefined];
		const node = dataNode(id, inlineId);
		// A block kind's atomic paths are written as one leaf each (`data.atomic`).
		const type = inlineId === undefined && id !== undefined ? blockTypeOf(id) : undefined;
		const atomic = (type === undefined ? undefined : roleOf(type)?.atomic) ?? [];
		const writes = node
			? patchWrites(
					node,
					patches,
					doc.clientID,
					randOf(doc),
					atomic.map((p) => leafKey(typeof p === 'string' ? [p] : p))
				)
			: [];
		if (writes === null) return null; // a patch fits no value there
		if (writes.length === 0) return [];
		const offset = inlineId === undefined ? undefined : atomOf(id!, inlineId)?.at;
		return [
			{
				op: 'patchData',
				...(id !== undefined && { id }),
				...(inlineId !== undefined && { inlineId, offset }),
				ops: patches,
				writes
			}
		];
	};
	/** A whole-data replace: a patch of the root. */
	const replaceData = (data: unknown): DataPatch[] => [{ path: [], value: sanitizeWireJson(data) }];
	/**
	 * `data`'s leaves as sets over `current` (`data.retype.keep`): a
	 * plain object's keys, recursively where `current` holds an object
	 * there too; anything else (an array, a primitive, an empty object, an
	 * object where `current` holds none) as one value at its path. Nothing
	 * else under the root is touched.
	 */
	const leafSets = (data: unknown, current: unknown): DataPatch[] => {
		const out: DataPatch[] = [];
		const walk = (v: unknown, at: unknown, path: string[]): void => {
			if (isObject(v) && Object.keys(v).length > 0 && (path.length === 0 || isObject(at)))
				for (const [k, x] of Object.entries(v))
					walk(x, isObject(at) ? at[k] : undefined, [...path, k]);
			else if (path.length > 0) out.push({ path, value: v });
		};
		walk(sanitizeWireJson(data), current, []);
		return out;
	};

	/**
	 * The target role decides: nothing renders a void's children,
	 * so a block retyped to a void kind hands them to the slot right after
	 * it, as the kind they show there (`settledKind`), in their order (where
	 * the read-time shedding shows a child a peer adds meanwhile). An island
	 * declared `lines` retyped to an ordinary kind keeps its lines, each
	 * retyped to the new kind's default child (the document's where that
	 * renders no content): no line kind outside its island. Any other
	 * island's children keep their kinds (a table's rows stay rows), as
	 * `typeOf` shows a child a peer adds meanwhile.
	 */
	const retypeSteps = (id: BlockId, type: string): PlanStep[] => {
		const { kids } = view();
		const pos = positionOf(id);
		const steps = attr(id, TYPE, type);
		const moved = kids.get(id) ?? [];
		// A code block retyped to an ordinary kind keeps its lines as that kind's children
		// (`leavingIsland`: never a kind that hides their text).
		const to = roles.of(type);
		if (isLines(id) && !to.island && !to.childless) {
			return [
				...steps,
				...moved.flatMap((k) => {
					const kind = leavingIsland(id, blockTypeOf(k.id), to.child);
					return kind === undefined ? [] : attr(k.id, TYPE, kind);
				})
			];
		}
		if (!to.childless || moved.length === 0 || pos === null) return steps;
		// The children keep their home slots: the read shows them in the void's
		// slot (`conc.void-children`), settled for its parent.
		return [
			...steps,
			...settle(
				id,
				moved.map((k) => k.id),
				pos.parent
			)
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
	 * sets the leaves it names, removing none (`data.retype.keep`: a
	 * retype keeps the block's properties, as Notion's Turn into does;
	 * `setBlockData` replaces them); `content`/`children` REPLACE
	 * wholesale — explicit replacement is a
	 * new-identity operation; a retype to a void kind without `children`
	 * unnests the current ones (`retypeSteps`). All-or-nothing: children
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
			content?: (ContentItem | JSONText | JSONInlineBlock)[];
			children?: (BlockSpec | JSONBlock)[];
		}
	): Prepared => {
		id = ref(id);
		const content = value.content?.map((item) => sanitizeItem(asContentItem(item)));
		const children = value.children?.map((child) => sanitizeSpec(asBlockSpec(child)));
		if (!live(id) || (content !== undefined && !contentTarget(id))) return REFUSED;
		const type = value.type === undefined ? undefined : ref(value.type);
		const toVoid = type === undefined ? isVoid(id) : roles.of(type).childless;
		if (children?.length && toVoid) return REFUSED;
		if (children !== undefined && collides(doc, children)) return refused('id-collision');
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
			writeContent(writes, id, 0, content);
		}
		if (children !== undefined) {
			for (const kid of childrenIds(id)) writes.push(remove(kid));
			if (children.length > 0)
				writes.push({ op: 'insertBlocks', parent: id, index: 0, specs: children });
		}
		return plan([id], writes);
	};

	// ── content: text and inline atoms in a block's display (allowed inside
	// voids — the caption contract), and marks over a range ──

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

	/** An atom without an id gets a fresh one. */
	const insertInline = (id: BlockId, offset: number, atom: NewInline): Prepared => {
		id = ref(id);
		const clean = sanitizeInline({ ...atom, id: atom.id ?? newId('i') });
		if (!contentTarget(id)) return REFUSED;
		return plan([id], [{ op: 'insertInline', id, offset: clamp(id, offset, 0)[0], atom: clean }]);
	};

	const removeInline = (id: BlockId, inlineId: string): Prepared => {
		id = ref(id);
		const atom = atomOf(id, ref(inlineId));
		if (atom === undefined) return REFUSED;
		return plan([id], [{ op: 'removeInline', id, offset: atom.at, inlineId: ref(inlineId) }]);
	};

	return {
		// what range deletion, flow placement and the facade compose
		REFUSED,
		plan,
		canPlace,
		fits,
		nestParent,
		canMerge,
		rendersContent,
		defaultChild,
		kindToCopy,
		isContainer,
		fitted,
		emptiable,
		move,
		attr,
		settle,
		dissolving,
		remove,
		writeContent,
		dataSteps,
		replaceData,
		landingOf,
		besideAt,
		/** Every op of the families, prepared. */
		prepare: {
			insertBlocks,
			moveBlocks,
			unNestBlocks,
			unNestBlock,
			liftOut,
			duplicateBlock,
			placeBeside,
			wrapInLayout,
			splitBlock,
			mergeBlocks,
			mergeBackward,
			mergeForward,
			deleteBlocks,
			deleteBlock,
			setBlockType,
			patchData,
			setBlock,
			insertText,
			deleteText,
			formatRange,
			clearMarks,
			insertInline,
			removeInline
		}
	};
};

export type DocOps = ReturnType<typeof docOps>;

/** What range deletion and flow placement are prepared over: the reads and the ops. */
export type OpsContext = DocBase & DocReads & DocOps;
