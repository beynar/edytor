import type { Block } from './block/block.svelte.js';
import type { Edytor } from './edytor.svelte.js';
import type { BlockDefinition, EditorCommand, KindPreset } from './plugins.js';
import { jsonBlockToSpec, jsonEquals, type JSONBlock } from './utils/json.js';
import { dispatchPlan, prepareSet } from './block/block.utils.js';
import { id } from './utils.js';
import { getSelectionBlocks } from './selection/replaceSelection.js';
import { hidden } from './selection/visibility.js';

/**
 * The kind catalogue (§2.4): one row per preset of each registered kind
 * record, in registration order. The slash menu, markdown shortcuts and
 * block menus read it; nothing else names a kind.
 */
export type KindRow = KindPreset & {
	/** The command id: `block.<type>`, numbered from 1 when the kind has several presets. */
	id: string;
	/** The conversion: the kind, the preset's data, the kind's empty shape. */
	value: JSONBlock;
	/**
	 * Whether the kind has an `empty` shape: it converts in place only a
	 * block that holds nothing, and is inserted after any other block.
	 */
	replaces: boolean;
};

export const kindCatalogue = (blocks: Map<string, BlockDefinition>): KindRow[] =>
	[...blocks].flatMap(([type, { presets = [], empty }]) =>
		presets.map((preset, index) => ({
			...preset,
			id: `block.${type}${presets.length > 1 ? index + 1 : ''}`,
			value: { type, data: { ...preset.data }, ...empty },
			replaces: empty !== undefined
		}))
	);

/** A label's or keyword's words: lowercase, hyphens dropped (`To-do` reads `todo`). */
const wordsOf = (value: string) =>
	value.replace(/-/g, '').toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Whether `query` names a row (a kind, a command, a menu action), as in
 * Notion: each query word, in order, starts a word of the label or of one
 * keyword, or continues the word the previous one started (`to do` names
 * To-do). An empty query names every row; the id is never searched. The
 * slash menu and the block menu's search share it.
 */
export const matchesQuery = (
	{ label, keywords = [] }: { label: string; keywords?: string[] },
	query: string
) => {
	const wanted = wordsOf(query);
	const fits = (words: string[]) => {
		const from = (i: number, j: number, rest: string): boolean =>
			i === wanted.length ||
			(rest.startsWith(wanted[i]!) && from(i + 1, j, rest.slice(wanted[i]!.length))) ||
			words
				.slice(j)
				.some(
					(word, k) =>
						word.startsWith(wanted[i]!) && from(i + 1, j + k + 1, word.slice(wanted[i]!.length))
				);
		return from(0, 0, '');
	};
	return [label, ...keywords].some((value) => fits(wordsOf(value)));
};

/** The rows a block may turn into while keeping its content and children (the menus' list). */
export const convertibleKinds = (edytor: Edytor): KindRow[] =>
	edytor.kinds.filter((kind) => !kind.replaces);

/**
 * The kind `block` shows as: its own, or an item's list's `itemKind` (a
 * `list-item` of an `ordered-list` is a numbered item, DR-behavior-3).
 */
const shownKind = (block: Block) => block.list?.definition.itemKind ?? block.type;

/**
 * The row naming `block` (by the kind it shows as, `shownKind`): of its
 * kind's rows, the one whose preset data shares the most values with the block's (the first on a tie). A block
 * matching no preset exactly (a checked to-do) still gets its kind's row;
 * among equals, the row drawn with the block's element wins, so a stored
 * `h5` heading, drawn as an `h3`, is "Heading 3".
 */
export const rowOf = (edytor: Edytor, block: Block | null | undefined): KindRow | undefined => {
	if (!block) return undefined;
	const type = shownKind(block);
	const data = block.data ?? {};
	const { element } = block.definition;
	const drawn = (of: Record<string, unknown>) =>
		typeof element === 'function' ? JSON.stringify(element(of)) : undefined;
	const own = drawn(data);
	const score = ({ value }: KindRow) =>
		2 * Object.entries(value.data ?? {}).filter(([key, v]) => jsonEquals(data[key], v)).length +
		Number(own !== undefined && drawn(value.data ?? {}) === own);
	let best: KindRow | undefined;
	for (const row of edytor.kinds)
		if (row.value.type === type && (!best || score(row) > score(best))) best = row;
	return best;
};

/**
 * Whether converting `block` loses nothing: it has no children, and no
 * content (text or inline atoms) but what the pending lead (a slash query)
 * removes with it. Turn into and the horizontal rule share it.
 */
export const holdsNothing = (edytor: Edytor, block: Block) => {
	if (block.hasChildren) return false;
	const removed = (edytor.dispatcher.pendingLead?.writes ?? []).reduce(
		(sum, w) => sum + (w.op === 'deleteText' && w.id === block.id ? w.length : 0),
		0
	);
	return edytor.facade.displayLength(block.id) <= removed;
};

/**
 * The plan putting `payload` (a kind, `block`'s own when it names none) at
 * `block`'s place: `block` retyped in place or, `after`, the payload
 * inserted right after it, where its kind fits (the
 * document's `liftOut`: a list holds only its items, so an item leaves its
 * list, and a block inserted after one splits the list there). A kind
 * rendering no content (a divider) holds no caret: block `next`, of the
 * default kind where it lands, follows it. An emptied document's line
 * creates them (DR-behavior-2). Turn into and the horizontal rule share it,
 * and prepare it from the payload hooks leave (BW-03).
 */
export const placing = (
	block: Block,
	payload: Partial<JSONBlock>,
	after: boolean,
	next: string
) => {
	const { facade, document } = block.edytor;
	const value = { ...payload, type: payload.type ?? block.type };
	const { parent } = facade.landingOf(block.id, value.type, after);
	const bare = !document.rendersContent(value.type) && !value.children?.length;
	const tail = bare ? [{ id: next, type: facade.defaultChild(parent) }] : [];
	const specs = [...(after ? [value] : []), ...tail].map((b) => jsonBlockToSpec(b));
	if (facade.virtual() === block.id)
		return tail.length
			? facade.prepare.insertBlocks({ parent: null, index: 0 }, [jsonBlockToSpec(value), ...specs])
			: prepareSet.call(block, { value: payload });
	const lift = facade.prepare.liftOut(block.id, value.type, { keep: after, after: specs });
	return after ? lift : facade.compose(lift, prepareSet.call(block, { value: payload }));
};

/** `block` and its ancestors: the blocks a placement may change the children of. */
export const lineage = (block: Block | undefined): Block[] =>
	block ? [block, ...lineage(block.parent)] : [];

/**
 * Convert `block` to a row's kind as one command. With `caret` (by default
 * when the conversion replaces the content) the caret lands at the start of
 * the converted block, or of its first child when the conversion creates one.
 * A replacing kind (a divider, a code block) converts in place only a block
 * that holds nothing (`holdsNothing`); after text, atoms or children it is
 * inserted after the block instead, which stays intact. The kind lands where
 * it fits (`placing`): a list's item turned into another kind leaves the
 * list — out of every list it sits in directly (a list nested right in a
 * list, DR-behavior-2) — where Shift+Tab lifts it, as a bullet turned into
 * a heading stops being a bullet in Notion; a block's own kind (only its
 * data changes) never moves it. Each is one plan: one refusal or veto keeps
 * everything, one undo step (AW-03). Answers whether it applied.
 */
export const convertToKind = (
	edytor: Edytor,
	block: Block | null | undefined,
	row: KindRow,
	caret = row.replaces
) => {
	if (!block?.convertible) return false;
	const value = structuredClone(row.value);
	const { parent: holder } = block;
	// The kind an item already shows as keeps it in its list (DR-behavior-3); a
	// list's own flat kind makes a block shed into it its item (SW10-lists-1).
	if (value.type === shownKind(block)) value.type = block.type;
	else if (holder?.isContainer && value.type === holder.definition.itemKind)
		value.type = edytor.defaultChild(holder);
	const after = row.replaces && !holdsNothing(edytor, block);
	const [next, touched] = [id('b'), lineage(block)];
	// The kind as hooks leave it (BW-03): placed, normalized by its kind, and given the caret.
	let kind: Partial<JSONBlock> & { id: string } = { ...value, id: id('b') };
	const converted = (payload: Partial<JSONBlock>) => {
		kind = { ...payload, id: after ? (payload.id ?? kind.id) : block.id };
		edytor.idToBlock.get(kind.id)?.normalizeContent();
	};
	if (after)
		dispatchPlan(
			block,
			'insertBlockAfter',
			{ block: kind as JSONBlock },
			(p) => placing(block, { ...p.block, id: p.block.id ?? kind.id }, true, next),
			touched,
			(p) => converted(p.block)
		);
	else
		dispatchPlan(
			block,
			'setBlock',
			{ value },
			(p) => placing(block, p.value, false, next),
			touched,
			(p) => converted(p.value)
		);
	if (edytor.dispatcher.last?.status !== 'applied') return false;
	const landing = edytor.idToBlock.get(next);
	if (caret || after || landing) {
		const at = landing ?? edytor.idToBlock.get(kind.id);
		edytor.dispatcher.caret((kind.children?.length ? at?.children[0] : at)?.firstText, 0);
	}
	return true;
};

/**
 * The blocks a Turn into over `blocks` converts, in document order: the
 * convertible ones. A list container is not, whether a text range, a block
 * selection or its grip names it: the items selected with it convert
 * (ZW-02). A closed toggle's hidden body is skipped (Select all selects it).
 */
export const convertedBlocks = (blocks: Iterable<Block>): Block[] =>
	[...blocks].filter((block) => block.convertible && !hidden(block));

/**
 * Convert several blocks (`convertedBlocks`) to a row's kind as one undo
 * step, keeping the selection (Notion's Turn into over several blocks): one
 * conversion per block, each one plan, so a block the document refuses or
 * an extension vetoes keeps its kind and the others convert (`dispatcher.each`,
 * BW-02). A block selection keeps the converted blocks selected, even once
 * the list that held them is gone (its items lifted out of it). Answers
 * whether any conversion applied.
 */
export const convertBlocks = (edytor: Edytor, blocks: Iterable<Block>, row: KindRow) => {
	const selection = edytor.selection.value;
	const converted = convertedBlocks(blocks);
	const applied = edytor.dispatcher.each('setBlock', converted, (block) =>
		convertToKind(edytor, block, row, false)
	);
	if (selection.kind === 'blocks') {
		const ids = new Set([...selection.ids, ...converted.map((block) => block.id)]);
		const live = [...ids].flatMap((id) => edytor.idToBlock.get(id) ?? []);
		edytor.selection.selectBlocks(...live.sort(edytor.compareBlocks));
	} else edytor.selection.select(selection);
	return applied.some(Boolean);
};

/**
 * A row as a command on the selection: the caret's block, or every block
 * of a block selection or of a text range (`convertedBlocks`; a kind that
 * replaces content converts only the block holding the selection's start).
 */
export const kindCommand = (edytor: Edytor, row: KindRow): EditorCommand => ({
	id: row.id,
	label: row.label,
	icon: row.icon,
	keywords: row.keywords,
	group: row.group ?? 'Basic blocks',
	hint: row.markdown?.[0]?.trim(),
	isEnabled: () =>
		row.replaces
			? Boolean(edytor.selection.state.startBlock?.convertible)
			: convertedBlocks(getSelectionBlocks(edytor)).length > 0,
	run: () => {
		const blocks = row.replaces ? [] : getSelectionBlocks(edytor);
		return blocks.length > 1 || (blocks[0] && !blocks[0].convertible)
			? convertBlocks(edytor, blocks, row)
			: convertToKind(edytor, edytor.selection.state.startBlock, row);
	}
});
