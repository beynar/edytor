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
 * content but what the pending lead (a slash query) removes with it.
 */
const holdsNothing = (edytor: Edytor, block: Block) => {
	if (block.hasChildren) return false;
	const removed = (edytor.dispatcher.pendingLead?.writes ?? []).reduce(
		(sum, w) => sum + (w.op === 'deleteText' && w.id === block.id ? w.length : 0),
		0
	);
	return edytor.facade.displayLength(block.id) <= removed;
};

/**
 * Convert `block` to a row's kind as one command. With `caret` (by default
 * when the conversion replaces the content) the caret lands at the start of
 * the converted block, or of its first child when the conversion creates one.
 * A replacing kind (a divider, a code block) converts in place only a block
 * that holds nothing; after text or children it is inserted after the
 * block instead, which stays intact. A kind rendering no content (a divider)
 * holds no caret: a fresh default block after it takes it. A list's item
 * (`isListItem`) leaves the list, as a bullet turned into a heading stops
 * being a bullet in Notion. Each is one plan (one refusal, one undo
 * step). Answers whether it applied.
 */
export const convertToKind = (
	edytor: Edytor,
	block: Block | null | undefined,
	row: KindRow,
	caret = row.replaces
) => {
	if (!block?.convertible) return false;
	const value = structuredClone(row.value);
	// The kind an item already shows as keeps it in its list (DR-behavior-3).
	if (value.type === shownKind(block)) value.type = block.type;
	const { parent } = block;
	const after = row.replaces && !holdsNothing(edytor, block);
	const bare = !edytor.document.rendersContent(value.type) && !value.children?.length;
	if (parent && (after || bare)) {
		const { facade } = edytor;
		const kind = { ...value, id: id('b') };
		const next = bare ? [{ id: id('b'), type: edytor.defaultChild(parent) }] : [];
		const slot = { parent: parent.isRoot ? null : parent.id, index: block.index + 1 };
		const applied = after
			? dispatchPlan(block, 'insertBlockAfter', { block: kind }, (payload) =>
					facade.prepare.insertBlocks(slot, [jsonBlockToSpec(payload.block), ...next])
				)
			: dispatchPlan(block, 'setBlock', { value }, (payload) =>
					facade.compose(prepareSet.call(block, payload), facade.prepare.insertBlocks(slot, next))
				);
		const landing = edytor.idToBlock.get(next[0]?.id ?? kind.id);
		if (applied) edytor.dispatcher.caret((landing?.children[0] ?? landing)?.firstText, 0);
		return Boolean(applied);
	}
	let applied = false;
	if (block.isListItem && value.type !== block.type) {
		// A list holds only items: the item leaves it where Shift+Tab lifts it,
		// the last lift and the conversion in one plan (a veto or a refusal
		// keeps the item). Out of a list nested right in a list, it first
		// leaves the inner ones, as Shift+Tab does (DR-behavior-2).
		const { facade, dispatcher } = edytor;
		const inner = () => {
			const outer = block.parent?.parent;
			return Boolean(outer?.isContainer && edytor.defaultChild(outer) === block.type);
		};
		dispatcher.run('setBlock', () => {
			while (block.isListItem && inner()) if (!block.unNestBlock()) return;
			const touched = [block.parent, block.parent?.parent, block];
			dispatchPlan(
				block,
				'setBlock',
				{ value },
				(payload) =>
					facade.compose(facade.prepare.unNestBlock(block.id), prepareSet.call(block, payload)),
				touched
			);
			applied = dispatcher.last?.status === 'applied';
		});
	} else {
		block.setBlock({ value });
		applied = edytor.dispatcher.last?.status === 'applied';
	}
	if (!applied) return false;
	if (caret) {
		const target = row.value.children?.length ? block.children[0] : block;
		edytor.dispatcher.caret(target?.firstText, 0);
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
 * step, keeping the selection (Notion's Turn into over several blocks).
 * Answers whether any conversion applied.
 */
export const convertBlocks = (edytor: Edytor, blocks: Iterable<Block>, row: KindRow) => {
	const selection = edytor.selection.value;
	const targets = convertedBlocks(blocks);
	const applied = edytor.dispatcher.run('setBlock', () =>
		targets.map((block) => convertToKind(edytor, block, row, false))
	);
	edytor.selection.select(selection);
	return Boolean(applied?.some(Boolean));
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
