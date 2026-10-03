/** @jsxImportSource ../../jsx */
/**
 * Shared fixtures of the `columns-*` DOM rows: a layout `C` of two columns
 * between two paragraphs (the delete contract's `layout.*` document,
 * `P, C:columns[K1:column[A, A2], K2:column[B]], Z`), trees as nested ids,
 * texts and the caret.
 */
import type { JSONBlock } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { columnsPlugin } from '$lib/plugins/columns/ColumnsPlugin.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

export const p = (id: string, text = id, children?: JSONBlock[]): JSONBlock => ({
	id,
	type: 'paragraph',
	content: [{ text }],
	...(children && { children })
});
export const column = (id: string, children: JSONBlock[], width?: number): JSONBlock => ({
	id,
	type: 'column',
	...(width !== undefined && { data: { width } }),
	children
});
export const columns = (id: string, ...items: JSONBlock[]): JSONBlock => ({
	id,
	type: 'columns',
	children: items
});

/** `P, C:columns[K1:column[A, A2], K2:column[B]], Z`. */
export const contractDoc = (): JSONBlock[] => [
	p('P', 'p'),
	columns('C', column('K1', [p('A', 'a'), p('A2', 'a2')]), column('K2', [p('B', 'b')])),
	p('Z', 'z')
];

export const renderColumns = (children: JSONBlock[], plugins: Plugin[] = []) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [...plugins, columnsPlugin, richTextPlugin],
			value: { children },
			autoSelectFixture: false
		}
	);

/** The displayed tree as nested ids: a block with children is `[id, children]`. */
export const tree = (edytor: Edytor): unknown[] => {
	const walk = (blocks: JSONBlock[] = []): unknown[] =>
		blocks.map((block) => (block.children?.length ? [block.id, walk(block.children)] : block.id));
	return walk(edytor.value.children);
};

/** The displayed text of block `id`. */
export const text = (edytor: Edytor, id: string) =>
	edytor.idToBlock
		.get(id)!
		.content.map((part) => ('stringContent' in part ? part.stringContent : '@'))
		.join('');

export const block = (edytor: Edytor, id: string) => edytor.idToBlock.get(id)!;

export const caretIn = async (edytor: Edytor, id: string, offset: number) => {
	edytor.selection.setAtTextOffset(block(edytor, id).firstText!, offset);
	await flushDomUpdates();
};

/** The model caret: its block, offset, and whether it is collapsed. */
export const caret = (edytor: Edytor) => {
	const { startBlock, yStart, isCollapsed } = edytor.selection.state;
	return { block: startBlock?.id, offset: yStart, isCollapsed };
};

export const selected = (edytor: Edytor) =>
	[...edytor.selection.selectedBlocks].sort(edytor.compareBlocks).map((b) => b.id);

export const click = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};
