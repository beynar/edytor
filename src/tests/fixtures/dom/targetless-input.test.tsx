/** @jsxImportSource ../../jsx */
/**
 * An input with no target is refused at admission (round 4, issue 2;
 * Notion: typing with no caret does nothing): a text, delete or line-break
 * intent while the selection value is `none` writes nothing, at its keydown
 * and at its `beforeinput`, whatever range the browser declares (Chromium
 * parks a caret at the host's start for the editor's own focus and for the
 * key itself). A caret a gesture placed still types; the caret the browser
 * parked is never adopted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { takeKeys } from '$lib/events/onFocus.js';
import {
	dispatchComposition,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection,
	textNodeOf
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const render = () =>
	renderDomEdytor(
		<root>
			<paragraph>before</paragraph>
			<paragraph>after</paragraph>
		</root>,
		{ plugins: [richTextPlugin], autoSelectFixture: false }
	);

const texts = (edytor: Awaited<ReturnType<typeof render>>['edytor']) =>
	(edytor.value.children ?? []).map((block) =>
		(block.content ?? []).map((part) => ('text' in part ? part.text : '')).join('')
	);

/** The DOM text node of a text element. */
const leafOf = (node: HTMLElement) =>
	document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode() ?? node;

/** The editor takes the keys (a drop, a resize), and the browser parks a caret at the host's start. */
const parkCaret = async (edytor: Awaited<ReturnType<typeof render>>['edytor']) => {
	takeKeys(edytor);
	const node = await textNodeOf(edytor.root!.children[0]!.content[0] as never);
	const leaf = leafOf(node);
	window.getSelection()!.collapse(leaf, 0);
	document.dispatchEvent(new Event('selectionchange'));
	await flushDomUpdates();
	return leaf;
};

/** A `beforeinput` declaring the parked caret as its target (Chromium's). */
const beforeInput = async (
	target: HTMLElement,
	inputType: string,
	at: Node,
	data?: string,
	offset = 0
) => {
	const event = new Event('beforeinput', { bubbles: true, cancelable: true }) as InputEvent;
	const range = {
		startContainer: at,
		startOffset: offset,
		endContainer: at,
		endOffset: offset,
		collapsed: true
	};
	Object.defineProperties(event, {
		inputType: { value: inputType },
		data: { value: data ?? null },
		dataTransfer: { value: null },
		getTargetRanges: { value: () => [range] }
	});
	target.dispatchEvent(event);
	await flushDomUpdates();
	return event.defaultPrevented;
};

describe('an input with no target', () => {
	it('a parked caret is never adopted; keys and beforeinputs over it write nothing', async () => {
		const { edytor, editor } = await render();
		const leaf = await parkCaret(edytor);
		expect(edytor.selection.value.kind).toBe('none');
		for (const key of ['k', 'Backspace', 'Delete', 'Enter']) {
			expect((await dispatchDomKeyDown(editor, { key })).defaultPrevented).toBe(true);
			expect(edytor.dispatcher.last?.status).toBe('refused');
		}
		for (const [inputType, data] of [
			['insertText', 'k'],
			['deleteContentBackward'],
			['deleteContentForward'],
			['insertParagraph'],
			['insertLineBreak']
		] as const)
			expect(await beforeInput(editor, inputType, leaf, data)).toBe(true);
		expect(texts(edytor)).toEqual(['before', 'after']);
		expect(edytor.selection.value.kind).toBe('none');
	});

	it('a caret a press placed types', async () => {
		const { edytor, editor } = await render();
		await parkCaret(edytor);
		const text = edytor.root!.children[0]!.content[0] as never;
		editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		await setNativeSelection(edytor, text, 6);
		expect(edytor.selection.value.kind).toBe('text');
		const node = await textNodeOf(text);
		await beforeInput(editor, 'insertText', leafOf(node), 'k', 6);
		expect(texts(edytor)).toEqual(['beforek', 'after']);
	});

	it('a press on the spot the parked caret sat at places it: typing goes there', async () => {
		const { edytor, editor } = await render();
		const leaf = await parkCaret(edytor);
		// The browser's caret does not move (no selectionchange): the press is the gesture.
		leaf.parentElement!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		leaf.parentElement!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		// The press leaves the browser's caret where the parked one sat.
		window.getSelection()!.collapse(leaf, 0);
		await flushDomUpdates();
		expect((await dispatchDomKeyDown(editor, { key: 'k' })).defaultPrevented).toBe(false);
		await beforeInput(editor, 'insertText', leaf, 'k');
		expect(texts(edytor)).toEqual(['kbefore', 'after']);
	});

	// Round 5, issue 1: a key is a gesture, but the caret Chromium parks after
	// it is still its own. Only a press, an adopted move or our own display
	// ends the parking; a history step or a closing menu giving back `none`
	// arms it again.
	for (const key of [
		{ key: 'z', metaKey: true },
		{ key: 'z', metaKey: true, shiftKey: true },
		{ key: 'Escape' }
	])
		it(`a parked caret after ${key.shiftKey ? 'Mod+Shift+Z' : key.metaKey ? 'Mod+Z' : key.key} stays the browser's: typing writes nothing`, async () => {
			const { edytor, editor } = await render();
			const leaf = await parkCaret(edytor);
			await dispatchDomKeyDown(editor, key);
			// The browser parks its caret again after the key (Chromium).
			window.getSelection()!.removeAllRanges();
			window.getSelection()!.collapse(leaf, 0);
			document.dispatchEvent(new Event('selectionchange'));
			await flushDomUpdates();
			expect(edytor.selection.value.kind).toBe('none');
			expect(edytor.projector.placed()).toBe(false);
			expect((await dispatchDomKeyDown(editor, { key: 'j' })).defaultPrevented).toBe(true);
			expect(await beforeInput(editor, 'insertText', leaf, 'j')).toBe(true);
			expect(texts(edytor)).toEqual(['before', 'after']);
		});

	for (const cause of ['history', 'model'] as const)
		it(`a value that becomes none (${cause === 'history' ? 'an undo' : 'a closing menu'}) under the host's focus parks again`, async () => {
			const { edytor, editor } = await render();
			const text = edytor.root!.children[0]!.content[0] as never;
			editor.focus();
			editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			await setNativeSelection(edytor, text, 3);
			expect(edytor.selection.value.kind).toBe('text');
			edytor.selection.select({ kind: 'none' }, cause);
			await flushDomUpdates();
			// The browser parks a caret at the host's start after the next key.
			await dispatchDomKeyDown(editor, { key: 'Escape' });
			const leaf = leafOf(await textNodeOf(text));
			window.getSelection()!.collapse(leaf, 0);
			document.dispatchEvent(new Event('selectionchange'));
			await flushDomUpdates();
			expect(edytor.selection.value.kind).toBe('none');
			expect((await dispatchDomKeyDown(editor, { key: 'j' })).defaultPrevented).toBe(true);
			expect(await beforeInput(editor, 'insertText', leaf, 'j')).toBe(true);
			expect(texts(edytor)).toEqual(['before', 'after']);
			// A press then places the caret: typing goes there.
			leaf.parentElement!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
			await setNativeSelection(edytor, text, 6);
			expect(edytor.selection.value.kind).toBe('text');
			await beforeInput(editor, 'insertText', leaf, 'k', 6);
			expect(texts(edytor)).toEqual(['beforek', 'after']);
		});

	it('a focus from outside (Tab) places the caret it brings: typing goes there', async () => {
		const { edytor, editor } = await render();
		const leaf = await parkCaret(edytor);
		const outside = document.createElement('button');
		document.body.append(outside);
		outside.focus();
		window.getSelection()!.collapse(leaf, 0);
		editor.focus();
		await flushDomUpdates();
		expect(edytor.projector.placed()).toBe(true);
		expect((await dispatchDomKeyDown(editor, { key: 'k' })).defaultPrevented).toBe(false);
	});

	// Round 5, issue 2: an IME with no target composes at the caret the browser
	// parked; the session refuses at its start, writes nothing, and its write
	// in the DOM is restored (the tail inverts its pinned host).
	it('a composition over a parked caret writes nothing; the IME write is restored', async () => {
		const { edytor, editor } = await render();
		const leaf = (await parkCaret(edytor)) as globalThis.Text;
		// The browser parks the IME's caret at the host's start again (the
		// display of none cleared the last one); its selectionchange comes later.
		window.getSelection()!.collapse(leaf, 0);
		await dispatchComposition(editor, [{ type: 'compositionstart' }]);
		expect(edytor.composition.host?.parent.id).toBe(edytor.root!.children[0]!.id);
		expect(edytor.composition.live).toBe(true);
		expect(edytor.composition.targetless).toBe(true);
		expect(edytor.selection.value.kind).toBe('none');
		// The IME writes its preview at the parked caret.
		leaf.data = 'あbefore';
		await dispatchComposition(editor, [
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'あ' },
			{ type: 'compositionupdate', data: 'あ' }
		]);
		expect(texts(edytor)).toEqual(['before', 'after']);
		expect(edytor.selection.value.kind).toBe('none');
		await dispatchComposition(editor, [
			{ type: 'beforeinput', inputType: 'insertFromComposition', data: 'あ' },
			{ type: 'compositionend', data: 'あ' }
		]);
		editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['before', 'after']);
		expect(edytor.selection.value.kind).toBe('none');
		expect(leaf.parentElement!.textContent).toBe('before');
		// A key after it is refused as well.
		expect((await dispatchDomKeyDown(editor, { key: 'j' })).defaultPrevented).toBe(true);
	});

	it('a composition over a caret a press placed composes there', async () => {
		const { edytor, editor } = await render();
		await parkCaret(edytor);
		const text = edytor.root!.children[0]!.content[0] as never;
		editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		await setNativeSelection(edytor, text, 6);
		await dispatchComposition(editor, [{ type: 'compositionstart' }]);
		expect(edytor.composition.targetless).toBe(false);
		await dispatchComposition(editor, [
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'あ' },
			{ type: 'compositionend', data: 'あ' }
		]);
		expect(texts(edytor)).toEqual(['beforeあ', 'after']);
	});
});
