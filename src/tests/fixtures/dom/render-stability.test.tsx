/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint R2 rows (dom lane): components render from cells
 * (plan §2.4 "Render cells", "Segments"; §4.4 components, `surface/cells`,
 * `surface/pin`; §5 L18, L19; §9.3 R2).
 *
 * - F-P9 — one Tab on `A, B|b`: zero root remounts; only B's subtree is
 *   recreated (A and a following C keep their elements); the caret is kept
 *   (reader `tab-remount`: three whole-editor remounts).
 * - No DOM remount under the caret while typing (the product guarantee behind
 *   `mirror-incremental` / `scoped-text-refresh`): typing keeps the text
 *   element and the text node under the caret; the first character typed into
 *   an empty block, a format over a range and a peer's insert in the same
 *   block keep the text element.
 * - A peer's inline atom inserted in the composing block keeps the IME's node
 *   and renders the composed text once; the atom shows after the session
 *   (D16, X12, BI-13: the host cell's segment list is frozen while composing).
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	dispatchComposition,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference (`arch-v2/ref-r2`); green since R2. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

/** A replica of the mounted document; `sync` exchanges both ways. */
const peer = (edytor: Edytor) => {
	const remoteDoc = new Y.Doc();
	Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
	const remote = attachDocument(remoteDoc);
	return {
		facade: remote.facade,
		sync: () => {
			const local = Y.encodeStateAsUpdate(edytor.doc, Y.encodeStateVector(remoteDoc));
			Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)));
			Y.applyUpdate(remoteDoc, local);
		}
	};
};

const textNodes = (element: Node) => {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	const out: globalThis.Text[] = [];
	while (walker.nextNode()) out.push(walker.currentNode as globalThis.Text);
	return out.filter((node) => node.data.replace(/\u200B/g, '').length > 0);
};
const blockElement = (edytor: Edytor, index: number) => edytor.root!.children[index]!.node!;
const textElement = (edytor: Edytor, index: number) =>
	edytor.root!.children[index]!.firstText!.node!;
const shown = (element: Element) => (element.textContent ?? '').replace(/\u200B/g, '');
const type = (editor: HTMLElement, data: string) =>
	dispatchDomBeforeInput(editor, { inputType: 'insertText', data });

describe('F-P9 — one Tab re-parents one subtree, nothing else remounts', () => {
	row('Tab on `A, B|b, C`: the root, A and C keep their elements; the caret stays', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>A</paragraph>
				<paragraph>B|b</paragraph>
				<paragraph>C</paragraph>
			</root>
		);
		const a = blockElement(edytor, 0);
		const b = blockElement(edytor, 1);
		const c = blockElement(edytor, 2);

		await dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab' });
		await flushDomUpdates();

		const root = document.querySelector('[data-edytor]');
		expect(root).toBe(editor);
		expect(editor.isConnected).toBe(true);
		expect(blockElement(edytor, 0)).toBe(a);
		expect(blockElement(edytor, 1)).toBe(c);
		expect(a.isConnected && c.isConnected).toBe(true);
		// B moved under A: its subtree was recreated there.
		const nested = edytor.root!.children[0]!.children[0]!;
		expect(nested.node).not.toBe(b);
		expect(a.contains(nested.node!)).toBe(true);
		const { startText, yStart, isCollapsed } = edytor.selection.state;
		expect([startText?.parent === nested, yStart, isCollapsed]).toEqual([true, 1, true]);
		const dom = document.getSelection();
		expect(nested.node!.contains(dom?.anchorNode ?? null)).toBe(true);
	});
});

describe('no DOM remount under the caret while typing', () => {
	pin('typing keeps the text element and the text node under the caret', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		);
		const element = textElement(edytor, 0);
		const [node] = textNodes(element);
		await type(editor, 'X');
		await type(editor, 'Y');
		await type(editor, 'Z');
		expect(textElement(edytor, 0)).toBe(element);
		expect(element.isConnected).toBe(true);
		expect(node.isConnected && element.contains(node)).toBe(true);
		expect(shown(element)).toBe('HelXYZlo');
	});

	row('the first character typed into an empty block keeps the text element', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>
		);
		const element = textElement(edytor, 0);
		await type(editor, 'a');
		await type(editor, 'b');
		expect(textElement(edytor, 0)).toBe(element);
		expect(element.isConnected).toBe(true);
		expect(shown(element)).toBe('ab');
	});

	row('a format over a range keeps the text element', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello world</paragraph>
			</root>
		);
		const element = textElement(edytor, 0);
		const text = edytor.root!.children[0]!.firstText!;
		await setNativeSelection(edytor, text, 6, text, 11);
		await dispatchDomBeforeInput(editor, { inputType: 'formatBold' });
		await flushDomUpdates();
		expect(edytor.value.children?.[0]?.content).toEqual([
			{ text: 'Hello ' },
			{ text: 'world', marks: { bold: true } }
		]);
		expect(textElement(edytor, 0)).toBe(element);
		expect(element.isConnected).toBe(true);
		expect(element.querySelector('[data-edytor-mark="bold"]')?.textContent).toBe('world');
	});

	pin('a peer insert in the same block keeps the text element and the caret node', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		);
		const remote = peer(edytor);
		const element = textElement(edytor, 0);
		const [node] = textNodes(element);
		remote.facade.insertText(edytor.root!.children[0]!.id, 0, 'P');
		remote.sync();
		await flushDomUpdates();
		expect(textElement(edytor, 0)).toBe(element);
		expect(node.isConnected && element.contains(node)).toBe(true);
		expect(shown(element)).toBe('PHello');
	});
});

describe('a peer atom in the composing block keeps the IME node (D16, BI-13)', () => {
	row(
		'the host keeps its element and text nodes; the text shows once; the atom after',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>abc|</paragraph>
					<paragraph>other</paragraph>
				</root>
			);
			const remote = peer(edytor);
			const block = blockElement(edytor, 0);
			const host = textElement(edytor, 0);
			await dispatchComposition(editor, [{ type: 'compositionstart' }]);
			await dispatchComposition(editor, [
				{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' }
			]);
			const nodes = textNodes(host);

			remote.facade.insertInline(edytor.root!.children[0]!.id, 0, {
				id: 'peer-atom',
				type: 'mention',
				data: {}
			});
			remote.sync();
			await flushDomUpdates();

			expect(edytor.isComposing).toBe(true);
			expect(host.isConnected && block.contains(host)).toBe(true);
			expect(nodes.every((node) => node.isConnected && host.contains(node))).toBe(true);
			// The composed text renders once (the frozen segment list), never twice.
			expect(shown(block).split('abc').length - 1).toBe(1);
			expect(block.querySelector('[data-edytor-inline-block]')).toBeNull();

			await dispatchComposition(editor, [{ type: 'compositionend', data: 'に' }]);
			await flushDomUpdates();
			expect(edytor.value.children?.[0]?.content).toEqual([
				{ type: 'mention', id: 'peer-atom', data: {} },
				{ text: 'abcに' }
			]);
			expect(block.querySelector('[data-edytor-inline-block]')).not.toBeNull();
			expect(shown(block).split('abcに').length - 1).toBe(1);
		}
	);
});
