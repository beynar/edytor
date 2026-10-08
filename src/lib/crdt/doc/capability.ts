/**
 * Structural capability: one answer in advance and at execution.
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
 *
 */
import { isLiveIn, type BlockId } from '../placement/model.js';
import type { DocBase, DocReads } from './reads.js';

/** The capability of the facade over its reads. */
export const docCapability = (c: DocBase & DocReads) => {
	const {
		roles,
		rendersContentOf,
		view,
		blockTypeOf,
		childrenIds,
		positionOf,
		ancestorsOf,
		isVoid,
		isIsland,
		islandOf,
		insideIsland,
		holdsLayout,
		insideItem,
		isRowKind,
		isCellKind,
		displayLength
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
	const isContainer = (id: BlockId): boolean => !rendersContent(id) && !isVoid(id) && !isIsland(id);
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
		if (!roles.container(parentType)) return true;
		const item = roles.defaultChild(parentType);
		if (item === defaultChild(null) || kind === item) return true;
		return (
			kind !== undefined &&
			roles.container(kind) &&
			roles.defaultChild(kind) === item &&
			rendersContentOf(item)
		);
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
		return rendersContentOf(item) ? item : kind;
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
	const rendersContent = (id: BlockId): boolean => rendersContentOf(blockTypeOf(id) ?? '');

	/** The adopted default child type under `parent` (`null` = the root). */
	const defaultChild = (parent: BlockId | null): string =>
		roles.defaultChild(parent === null ? null : (blockTypeOf(parent) ?? null));
	/**
	 * The kind a new block copies from `id` (a split tail, a flow's tail,
	 * a duplicate and each of its descendants). A type a peer's retype is
	 * replacing can be missing while its new value is pending: the copy
	 * then takes its parent's default child, never a missing type
	 * (it showed as `unknown` everywhere, for good).
	 */
	const kindToCopy = (id: BlockId): string =>
		blockTypeOf(id) ?? defaultChild(positionOf(id)?.parent ?? null);

	return {
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
	};
};

export type DocCapability = ReturnType<typeof docCapability>;
