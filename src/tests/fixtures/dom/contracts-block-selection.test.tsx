/** @jsxImportSource ../../jsx */
/**
 * Contract `sel.blocks.exact` + `del.blocks.promote` (2026-09-28, "preserve
 * content the user did not remove") through the view: a block selection is
 * exactly its members — a parent and its children are separate members, the
 * selected attribute marks the members only, copy and delete take the
 * members only — and deleting a selected parent promotes its unselected
 * children to its slot. Expected values are the contract's, hand-written.
 */
import { describe, expect, test } from 'vitest';
import {
	assertCanonicalTree,
	dispatchCopy,
	dispatchDomKeyDown,
	renderDomEdytor,
	type CanonicalBlock
} from '../../dom/test.utils.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';
import { readEdytorClipboardFragment } from '$lib/clipboard/fragmentData.js';

const own = (block: { content: unknown[] }) =>
	(block.content[0] as Text | undefined)?.stringContent;

/** Selected blocks as their own text, in document order. */
const selectedTexts = (edytor: Edytor) =>
	Array.from(edytor.selection.selectedBlocks)
		.sort(edytor.compareBlocks)
		.map((block) => own(block));

/** Texts of the blocks whose element carries `data-edytor-selected`, in DOM order. */
const markedTexts = (editor: HTMLElement, edytor: Edytor) =>
	Array.from(editor.querySelectorAll<HTMLElement>('[data-edytor-selected="true"]')).map((node) =>
		own(edytor.idToBlock.get(node.dataset.edytorId!)!)
	);

const mod = (key: string, shiftKey = false) =>
	dispatchDomKeyDown(document, { key, code: `Key${key.toUpperCase()}`, metaKey: true, shiftKey });
const key = (k: string, shiftKey = false) => dispatchDomKeyDown(document, { key: k, shiftKey });

const p = (text: string, children?: CanonicalBlock[]): CanonicalBlock => ({
	type: 'paragraph',
	content: [{ text }],
	...(children ? { children } : {})
});

const family = () => (
	<root>
		<paragraph>
			A|<paragraph>A1</paragraph>
			<paragraph>A2</paragraph>
			<paragraph>A3</paragraph>
		</paragraph>
		<paragraph>B</paragraph>
	</root>
);

describe('sel.blocks.exact — a block selection is exactly its members', () => {
	test('the block step of the ladder selects the parent only; only it is marked selected', async () => {
		const { edytor, editor } = await renderDomEdytor(family());
		await mod('a');
		await mod('a');
		expect(selectedTexts(edytor)).toEqual(['A']);
		expect(markedTexts(editor, edytor)).toEqual(['A']);
	});

	test('select-all (the third step) selects every block, nested ones included', async () => {
		const { edytor, editor } = await renderDomEdytor(family());
		for (let i = 0; i < 3; i++) await mod('a');
		expect(selectedTexts(edytor)).toEqual(['A', 'A1', 'A2', 'A3', 'B']);
		expect(markedTexts(editor, edytor)).toEqual(['A', 'A1', 'A2', 'A3', 'B']);
		// Deleting everything that is selected empties the document: the view shows
		// its virtual paragraph (`doc.empty.virtual`), nothing is written for it.
		await key('Backspace');
		expect(edytor.value.children).toEqual([]);
		const [only, ...rest] = edytor.root!.children;
		expect(rest).toEqual([]);
		expect(edytor.facade.virtual()).toBe(only!.id);
		expect(edytor.selection.state.startText?.parent.id).toBe(only!.id);
	});

	test('Shift+Down from a parent adds its first child, then the next', async () => {
		const { edytor } = await renderDomEdytor(family());
		await mod('a');
		await mod('a');
		await key('ArrowDown', true);
		expect(selectedTexts(edytor)).toEqual(['A', 'A1']);
		await key('ArrowDown', true);
		expect(selectedTexts(edytor)).toEqual(['A', 'A1', 'A2']);
	});

	test('Shift+Up from a first child adds the parent and keeps the child', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>
					A<paragraph>A1|</paragraph>
					<paragraph>A2</paragraph>
				</paragraph>
			</root>
		);
		await mod('a');
		await mod('a');
		expect(selectedTexts(edytor)).toEqual(['A1']);
		await key('ArrowUp', true);
		// Reaching the parent does not swap the child out: both are members.
		expect(selectedTexts(edytor)).toEqual(['A', 'A1']);
	});

	test('copying a selected parent copies the parent only; with its children selected, the subtree', async () => {
		const { edytor, editor } = await renderDomEdytor(family());
		await mod('a');
		await mod('a');
		const fragmentOf = (data: Record<string, string>) =>
			readEdytorClipboardFragment({ getData: (type: string) => data[type] ?? '' });
		const alone = fragmentOf((await dispatchCopy(editor)).clipboardData);
		expect(alone?.kind === 'blocks' && alone.blocks.map((b) => [b.content, b.children])).toEqual([
			[[{ text: 'A' }], undefined]
		]);
		await key('ArrowDown', true);
		const withChild = fragmentOf((await dispatchCopy(editor)).clipboardData);
		expect(
			withChild?.kind === 'blocks' &&
				withChild.blocks.map((b) => [b.content, b.children?.map((c) => c.content)])
		).toEqual([[[{ text: 'A' }], [[{ text: 'A1' }]]]]);
	});
});

describe('del.blocks.promote — deleting a selected parent keeps its unselected children', () => {
	test('Backspace over the parent: its children take its slot in order; undo puts them back under it; redo again', async () => {
		const { edytor } = await renderDomEdytor(family());
		const before = edytor.value;
		const [a] = edytor.root!.children;
		const kids = a!.children.map((c) => c.id);
		await mod('a');
		await mod('a');
		await key('Backspace');
		assertCanonicalTree(edytor, [
			{ ...p('A1'), id: kids[0] },
			{ ...p('A2'), id: kids[1] },
			{ ...p('A3'), id: kids[2] },
			p('B')
		]);
		// Caret: nothing unselected before the set → the end of the next unselected block (FP-7).
		expect(edytor.selection.state.startText?.parent.id).toBe(kids[0]);
		expect(edytor.selection.state.yStart).toBe(2);

		await mod('z');
		expect(edytor.value).toEqual(before);
		await mod('z', true);
		assertCanonicalTree(edytor, [
			{ ...p('A1'), id: kids[0] },
			{ ...p('A2'), id: kids[1] },
			{ ...p('A3'), id: kids[2] },
			p('B')
		]);
	});

	test('parent and first child selected: both go, the other children take the parent slot', async () => {
		const { edytor } = await renderDomEdytor(family());
		await mod('a');
		await mod('a');
		await key('ArrowDown', true);
		await key('Backspace');
		assertCanonicalTree(edytor, [p('A2'), p('A3'), p('B')]);
	});

	test('a selected grandparent and grandchild: the unselected child takes the grandparent slot with its other child', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>
					G|
					<paragraph>
						C<paragraph>K</paragraph>
						<paragraph>L</paragraph>
					</paragraph>
				</paragraph>
			</root>
		);
		const [g] = edytor.root!.children;
		const c = g!.children[0]!;
		edytor.selection.selectBlocks(g!, c.children[0]!);
		await key('Backspace');
		assertCanonicalTree(edytor, [p('C', [p('L')])]);
	});

	test('the block handle action (removeBlock) promotes; keepChildren: false removes the subtree', async () => {
		const { edytor } = await renderDomEdytor(family());
		edytor.root!.children[0]!.removeBlock();
		assertCanonicalTree(edytor, [p('A1'), p('A2'), p('A3'), p('B')]);
	});

	test('removeBlock({ keepChildren: false }) is the explicit whole-subtree delete', async () => {
		const { edytor } = await renderDomEdytor(family());
		edytor.root!.children[0]!.removeBlock({ keepChildren: false });
		assertCanonicalTree(edytor, [p('B')]);
	});
});
