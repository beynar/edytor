/**
 * Block placement ops: insert (`insertBlocks`, `duplicateBlock`), move
 * (`moveBlocks`), outdent (`unNestBlocks`) and the lift out of the
 * containers a kind does not fit (`landingOf`, `splitOut`, `liftOut`).
 */
import { id as newId } from '../../utils.js';
import { asBlockSpec, sanitizeSpec, type JSONBlock } from '../../utils/json.js';
import { collides, type BlockId, type BlockSpec, type Destination } from '../placement/model.js';
import { ref } from './plan.js';
import type { Prepared, PlanStep, Plan } from './types.js';
import { PART, type OpsContext } from './steps.js';

/** The moves ops of one facade, prepared. */
export const moveOps = (c: OpsContext) => {
	const {
		doc,
		blockTypeOf,
		blockDataOf,
		childrenIds,
		positionOf,
		isVoid,
		isIsland,
		isLine,
		contentItems,
		live,
		canPlace,
		isContainer,
		fits,
		kindToCopy,
		REFUSED,
		plan,
		moveTo,
		move,
		leaving,
		settledKind,
		settle,
		landing,
		emptying,
		emptied
	} = c;

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

	return {
		insertBlocks,
		moveBlocks,
		unNestBlocks,
		unNestBlock,
		landingOf,
		liftOut,
		duplicateBlock
	};
};

export type MoveOps = ReturnType<typeof moveOps>;
