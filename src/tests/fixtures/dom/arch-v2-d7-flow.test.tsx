/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint D7 rows, dom lane (the doc rows live in
 * `src/tests/crdt/arch-v2/d7-flow.test.ts`): paste, drop and fragment
 * insertion all place a flow through ONE prepared document op (`doc/flow`).
 *
 * - F-P5 (decision D-4) — `X`, `Y` pasted at `Hello|World` through the
 *   internal clipboard, HTML (imported again since P4.1), plain text and a
 *   drop → `["HelloX", "YWorld"]` every time (red on the reference: internal
 *   `HelloWorld, X, Y`, plain `HelloX⏎YWorld`).
 * - F-P10 — HTML with only a comment, a `<script>` or an empty `<span>`
 *   pasted into an empty `h2` → no change, no undo step (red on the
 *   reference: the heading became a paragraph with stale data).
 * - Clipboard spec assertions (`tests/editor-dom/clipboard.spec.ts`,
 *   `input.spec.ts:3099`) on the dom lane, their expectations taken from the
 *   specs (the multiline plain paste under D-4).
 * - P4.1 (phase 2) restores HTML import (D8 had retired it, D-24 G-a): the
 *   former `paste-html.spec.ts` rows expect the imported structure again,
 *   placed by D-4 (`arch-v2-p41-html-import.test.tsx` has the full set).
 *
 * Expected values come from the plan rows, the `flow.*` contract rows and the
 * pinned specs, never from running the code.
 */
import { describe, expect, it } from 'vitest';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	dispatchClipboardPaste,
	dispatchCopy,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference; green since D7. */
const row = it;
/** Green on the reference: a clipboard spec assertion kept as a regression guard. */
const pin = it;
/** A former `paste-html.spec` row: D8 rewrote it to the plain fallback, P4.1 restores the import. */
const html = it;

const texts = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((block) =>
		(block.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('')
	);

const caret = (edytor: Edytor) => ({
	block: edytor.selection.state.startBlock?.path,
	at: edytor.selection.state.yStart,
	collapsed: edytor.selection.state.isCollapsed
});

const blockText = (edytor: Edytor, index: number) => edytor.root!.children[index]!.firstText;

const helloWorld = () => (
	<root>
		<paragraph>X</paragraph>
		<paragraph>Y</paragraph>
		<paragraph>HelloWorld</paragraph>
	</root>
);

const drop = (edytor: Edytor, data: Record<string, string>) =>
	runBeforeInputCommand(
		edytor,
		attemptOf(edytor, {
			inputType: 'insertFromDrop',
			data: null,
			dataTransfer: {
				types: Object.keys(data),
				files: [],
				getData: (type: string) => data[type] ?? ''
			} as unknown as DataTransfer,
			cancelable: true
		})
	);

describe('F-P5 — one paste shape on every path (D-4)', () => {
	row('internal clipboard: a copied X, Y fragment at Hello|World', async () => {
		const { edytor, editor } = await renderDomEdytor(helloWorld(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 0), 0, blockText(edytor, 1), 1);
		const copied = await dispatchCopy(editor);
		await setNativeSelection(edytor, blockText(edytor, 2), 5);
		await dispatchClipboardPaste(editor, copied.clipboardData);
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['X', 'Y', 'HelloX', 'YWorld']);
		expect(caret(edytor)).toEqual({ block: [3], at: 1, collapsed: true });
	});

	pin('HTML: <p>X</p><p>Y</p> at Hello|World (imported, P4.1)', async () => {
		const { edytor, editor } = await renderDomEdytor(helloWorld(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 2), 5);
		await dispatchClipboardPaste(editor, { 'text/html': '<p>X</p><p>Y</p>', 'text/plain': 'X\nY' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['X', 'Y', 'HelloX', 'YWorld']);
		expect(caret(edytor)).toEqual({ block: [3], at: 1, collapsed: true });
	});

	row('plain text: "X\\nY" at Hello|World', async () => {
		const { edytor, editor } = await renderDomEdytor(helloWorld(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 2), 5);
		await dispatchClipboardPaste(editor, { 'text/plain': 'X\nY' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['X', 'Y', 'HelloX', 'YWorld']);
		expect(caret(edytor)).toEqual({ block: [3], at: 1, collapsed: true });
	});

	row('drop: a plain "X\\nY" payload at Hello|World', async () => {
		const { edytor } = await renderDomEdytor(helloWorld(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 2), 5);
		await drop(edytor, { 'text/plain': 'X\nY' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['X', 'Y', 'HelloX', 'YWorld']);
	});
});

describe('F-P10 — an empty HTML paste changes nothing', () => {
	for (const html of ['<!-- only a comment -->', '<script>alert(1)</script>', '<span></span>']) {
		row(`${html} into an empty h2: no change, no undo step`, async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<heading level="h2">|</heading>
				</root>
			);
			const before = JSON.stringify(edytor.value);
			const undo = edytor.undoManager.undoStack.length;
			await dispatchClipboardPaste(editor, { 'text/html': html, 'text/plain': '' });
			await flushDomUpdates();
			expect(JSON.stringify(edytor.value)).toBe(before);
			expect(edytor.undoManager.undoStack.length).toBe(undo);
		});
	}
});

describe('clipboard spec assertions (dom lane)', () => {
	const basic = () => (
		<root>
			<paragraph>lead</paragraph>
			<paragraph>note</paragraph>
			<paragraph></paragraph>
		</root>
	);

	pin('clipboard.spec:43 — plain text at note@0 → "Nativenote", caret after it', async () => {
		const { edytor, editor } = await renderDomEdytor(basic(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 1), 0);
		await dispatchClipboardPaste(editor, { 'text/plain': 'Native' });
		expect(texts(edytor)).toEqual(['lead', 'Nativenote', '']);
		expect(caret(edytor)).toEqual({ block: [1], at: 6, collapsed: true });
	});

	pin('clipboard.spec:164 — a copied nested selected block lands whole, fresh ids', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>
					Hello
					<paragraph>Nested child</paragraph>
					<paragraph>Nested tail</paragraph>
				</paragraph>
				<paragraph>After</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const source = edytor.root!.children[0]!;
		const original = [source.id, source.children[0]!.id];
		// A block selection is exactly its members: the nested blocks are selected too.
		edytor.selection.selectBlocks(source, ...source.children);
		const copied = await dispatchCopy(editor);
		// The user's click at the end of "After": a press, then the browser's caret.
		blockText(edytor, 1).node!.dispatchEvent(
			new PointerEvent('pointerdown', { bubbles: true, button: 0 })
		);
		await setNativeSelection(edytor, blockText(edytor, 1), 5);
		await dispatchClipboardPaste(editor, copied.clipboardData);
		await flushDomUpdates();
		expect(edytor.value.children?.length).toBe(3);
		const pasted = edytor.root!.children[2]!;
		expect(texts(edytor)).toEqual(['Hello', 'After', 'Hello']);
		expect(pasted.children.map((child) => child.firstText?.stringContent)).toEqual([
			'Nested child',
			'Nested tail'
		]);
		expect(original).not.toContain(pasted.id);
		expect(original).not.toContain(pasted.children[0]!.id);
	});

	pin('clipboard.spec:272 — internal content over a selected block → one replacement', async () => {
		const { edytor, editor } = await renderDomEdytor(basic(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 0), 0, blockText(edytor, 0), 2);
		const copied = await dispatchCopy(editor);
		edytor.selection.selectBlocks(edytor.root!.children[1]!);
		await dispatchClipboardPaste(editor, copied.clipboardData);
		expect(texts(edytor)).toEqual(['lead', 'le', '']);
	});

	pin('clipboard.spec:529 — text/uri-list pastes as a link', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
				<paragraph>note</paragraph>
			</root>
		);
		await dispatchClipboardPaste(editor, {
			'text/uri-list': '# clipboard comment\nhttps://example.com/'
		});
		expect(edytor.value.children?.[0]?.content).toEqual([
			{ text: 'https://example.com/', marks: { link: { href: 'https://example.com/' } } }
		]);
	});

	html('paste-html.spec:121 — <p>Alpha</p><p>Beta</p> at le|ad splits the block', async () => {
		const { edytor, editor } = await renderDomEdytor(basic(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 0), 2);
		await dispatchClipboardPaste(editor, {
			'text/html': '<p>Alpha</p><p>Beta</p>',
			'text/plain': 'Alpha\nBeta'
		});
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['leAlpha', 'Betaad', 'note', '']);
		expect(caret(edytor)).toEqual({ block: [1], at: 4, collapsed: true });
	});

	html('paste-html.spec:153 — a pasted <blockquote> into an empty block is a quote', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
				<paragraph>note</paragraph>
			</root>
		);
		await dispatchClipboardPaste(editor, {
			'text/html': '<blockquote>Quoted</blockquote>',
			'text/plain': 'Quoted'
		});
		const first = edytor.value.children?.[0];
		expect([first?.type, first?.content]).toEqual(['quote', [{ text: 'Quoted' }]]);
	});

	html('paste-html.spec:180 — html lists into an empty block become list items', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
				<paragraph>note</paragraph>
			</root>
		);
		await dispatchClipboardPaste(editor, {
			'text/html': '<ul><li>Bullet</li></ul><ol><li>Number</li></ol>',
			'text/plain': 'Bullet\nNumber'
		});
		expect(edytor.value.children?.slice(0, 2).map((block) => [block.type, block.content])).toEqual([
			['bulleted-list-item', [{ text: 'Bullet' }]],
			['numbered-list-item', [{ text: 'Number' }]]
		]);
	});

	html('paste-html.spec:237 — malformed html over a range places two lines (D-4)', async () => {
		const { edytor, editor } = await renderDomEdytor(basic(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 0), 1, blockText(edytor, 1), 2);
		await dispatchClipboardPaste(editor, {
			'text/html': '<p><strong>oops<p>tail',
			'text/plain': 'fallback'
		});
		await flushDomUpdates();
		// The parser reconstructs <strong> into the second paragraph: two lines.
		expect(texts(edytor)).toEqual(['loops', 'tailte', '']);
		expect(caret(edytor)).toEqual({ block: [1], at: 4, collapsed: true });
	});

	row('input.spec:3099 under D-4 — multiline plain text over a live selection', async () => {
		const { edytor, editor } = await renderDomEdytor(basic(), { autoSelectFixture: false });
		await setNativeSelection(edytor, blockText(edytor, 0), 2, blockText(edytor, 1), 2);
		await dispatchClipboardPaste(editor, { 'text/plain': 'X\nY' });
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['leX', 'Yte', '']);
		expect(caret(edytor)).toEqual({ block: [1], at: 1, collapsed: true });
	});
});
