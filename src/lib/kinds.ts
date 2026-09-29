import type { Block } from './block/block.svelte.js';
import type { Edytor } from './edytor.svelte.js';
import type { BlockDefinition, EditorCommand, KindPreset } from './plugins.js';
import type { JSONBlock } from './utils/json.js';
import { dispatchPlan, prepareSet } from './block/block.utils.js';
import { id } from './utils.js';

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
	/** Whether converting replaces the block's content and children. */
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

/**
 * Convert `block` to a row's kind as one command. With `caret` (by default
 * when the conversion replaces the content) the caret lands at the start of
 * the converted block, or of its first child when the conversion creates one.
 * A kind rendering no content (a divider) holds no caret: a fresh default
 * block after it takes it, in the same plan (one refusal, one undo step).
 * Answers whether it applied.
 */
export const convertToKind = (
	edytor: Edytor,
	block: Block | null | undefined,
	row: KindRow,
	caret = row.replaces
) => {
	if (!block?.convertible) return false;
	const value = structuredClone(row.value);
	const { parent } = block;
	if (parent && !edytor.document.rendersContent(value.type) && !value.children?.length) {
		const { facade } = edytor;
		const next = { id: id('b'), type: edytor.defaultChild(parent) };
		const slot = { parent: parent.isRoot ? null : parent.id, index: block.index + 1 };
		const applied = dispatchPlan(block, 'setBlock', { value }, (payload) =>
			facade.compose(prepareSet.call(block, payload), facade.prepare.insertBlocks(slot, [next]))
		);
		if (applied) edytor.dispatcher.caret(edytor.idToBlock.get(next.id)?.firstText, 0);
		return Boolean(applied);
	}
	block.setBlock({ value });
	if (edytor.dispatcher.last?.status !== 'applied') return false;
	if (caret) {
		const target = row.value.children?.length ? block.children[0] : block;
		edytor.dispatcher.caret(target?.firstText, 0);
	}
	return true;
};

/** A row as a command on the block holding the selection's start. */
export const kindCommand = (edytor: Edytor, row: KindRow): EditorCommand => ({
	id: row.id,
	label: row.label,
	icon: row.icon,
	keywords: row.keywords,
	group: row.group ?? 'Basic blocks',
	hint: row.markdown?.[0]?.trim(),
	isEnabled: () => Boolean(edytor.selection.state.startBlock?.convertible),
	run: () => convertToKind(edytor, edytor.selection.state.startBlock, row)
});
