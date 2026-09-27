/** @jsxImportSource ../../jsx */
/**
 * Adversarial review wave 2 — regression coverage for the gaps found by
 * comparing the input pipeline against PM/Quill/Lexical/browser behavior:
 *
 * - nested `contenteditable` islands must own their input/keydown/
 *   paste/composition lifecycle (the model-selection pipeline used to
 *   route their events against a stale model selection);
 * - `insertTranspose`/`insertFromYank` carry no `data` — a text-local
 *   native event is browser-owned (reconciled, not swallowed), while a
 *   payload-bearing synthetic event still models the insert;
 * - `insertLink`/list/horizontal-rule/font-color inputTypes route
 *   through rich-text operations instead of being preventDefault'ed
 *   into no-ops;
 * - foreign elements spoofing managed markers (`data-edytor-text`,
 *   `data-edytor-mark`, …) are removed — marker presence alone used to
 *   exempt any injected element from `removeAddedUnmanagedNodes`;
 * - prototype-chain attribute names (`constructor`, `toString`) on
 *   managed elements must not crash the attribute-heal flush;
 * - `historyUndo`/`historyRedo` during an active composition are
 *   swallowed instead of consuming capture groups under the IME;
 * - attribute damage recorded mid-composition is requeued and healed
 *   after the commit instead of being dropped;
 * - a post-mutation caret restore never steals the DOM selection back
 *   from an element outside the editor.
 */
import { describe, expect, test, vi } from 'vitest';
import {
	renderDomEdytor,
	flushDomUpdates,
	setNativeSelection,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	dispatchClipboardPaste,
	dispatchComposition
} from '../../dom/test.utils.js';
import { Text as ModelText } from '$lib/text/text.svelte.js';
import type { JSONBlock } from '$lib/utils/json.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const firstText = (edytor: { root?: { children: { firstText?: ModelText | null }[] } }) => {
	const text = edytor.root?.children[0]?.firstText;
	if (!text) {
		throw new Error('Missing first text');
	}
	return text;
};

const blockTypes = (value: { children?: JSONBlock[] }) =>
	(value.children ?? []).map((block) => block.type);

/** Mount a nested `contenteditable` island inside the first block. The
 * `data-edytor-plugin-chrome` marker makes it renderer-owned chrome so
 * the observer leaves it alone — which is exactly how real plugins host
 * embedded editors. */
const mountNestedEditable = (editor: HTMLElement, text = 'island text') => {
	const blockElement = editor.querySelector<HTMLElement>('[data-edytor-block]');
	if (!blockElement) {
		throw new Error('Missing block element for island mount');
	}
	const island = document.createElement('div');
	island.setAttribute('data-edytor-plugin-chrome', '');
	island.setAttribute('contenteditable', 'true');
	const inner = document.createElement('span');
	inner.textContent = text;
	island.append(inner);
	blockElement.append(island);
	return island;
};

describe('nested contenteditable islands', () => {
	test('beforeinput inside an island is browser-owned and does not touch the model', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const island = mountNestedEditable(editor);
		const before = JSON.stringify(edytor.value);

		const result = await dispatchDomBeforeInput(island, {
			inputType: 'insertText',
			data: 'x'
		});

		expect(result.defaultPrevented).toBe(false);
		expect(JSON.stringify(edytor.value)).toBe(before);
	});

	test('keydown inside an island does not run editor hotkeys or structural fallbacks', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const island = mountNestedEditable(editor);
		const before = JSON.stringify(edytor.value);

		const enter = await dispatchDomKeyDown(island, { key: 'Enter' });
		const arrow = await dispatchDomKeyDown(island, { key: 'ArrowDown' });
		const backspace = await dispatchDomKeyDown(island, { key: 'Backspace' });

		expect(enter.defaultPrevented).toBe(false);
		expect(arrow.defaultPrevented).toBe(false);
		expect(backspace.defaultPrevented).toBe(false);
		expect(JSON.stringify(edytor.value)).toBe(before);
		expect(edytor.root!.children.length).toBe(1);
	});

	test('paste inside an island does not insert a model fragment', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const island = mountNestedEditable(editor);
		const before = JSON.stringify(edytor.value);

		const result = await dispatchClipboardPaste(island, { 'text/plain': 'pasted' });

		expect(result.defaultPrevented).toBe(false);
		expect(JSON.stringify(edytor.value)).toBe(before);
	});

	test('composition inside an island never commits into the model', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const island = mountNestedEditable(editor);
		const before = JSON.stringify(edytor.value);

		await dispatchComposition(island, [
			{ type: 'compositionstart' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' },
			{ type: 'compositionend', data: 'にほん' }
		]);

		expect(edytor.isComposing).toBe(false);
		expect(JSON.stringify(edytor.value)).toBe(before);
	});

	test('a bare input event inside an island does not run the fallback reconcile', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const island = mountNestedEditable(editor);
		island.append(document.createTextNode('island text'));
		const before = JSON.stringify(edytor.value);

		island.dispatchEvent(new Event('input', { bubbles: true }));
		await flushDomUpdates();

		expect(JSON.stringify(edytor.value)).toBe(before);
	});
});

describe('insertTranspose / insertFromYank', () => {
	test('a payload-free text-local transpose is browser-owned (not prevented)', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, { inputType: 'insertTranspose' });
		expect(result.defaultPrevented).toBe(false);
	});

	test('a payload-free text-local yank is browser-owned (not prevented)', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, { inputType: 'insertFromYank' });
		expect(result.defaultPrevented).toBe(false);
	});

	test('a payload-bearing synthetic transpose still models the insert', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, {
			inputType: 'insertTranspose',
			text: 'X'
		});

		expect(result.defaultPrevented).toBe(true);
		expect(firstText(edytor).stringContent).toBe('HelXlo');
	});

	test('a payload-bearing synthetic yank still models the insert', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hel|lo</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, {
			inputType: 'insertFromYank',
			text: 'YANKED'
		});

		expect(result.defaultPrevented).toBe(true);
		expect(firstText(edytor).stringContent).toBe('HelYANKEDlo');
	});
});

describe('rich-text native inputType routing', () => {
	test('insertLink applies the link mark with the URL payload', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>|Hello|</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, {
			inputType: 'insertLink',
			data: 'https://example.com'
		});

		expect(result.defaultPrevented).toBe(true);
		const content = (edytor.value.children ?? [])[0]?.content as Array<Record<string, unknown>>;
		expect(content).toEqual([
			expect.objectContaining({
				text: 'Hello',
				marks: { link: { href: 'https://example.com' } }
			})
		]);
	});

	test('insertLink without a recoverable URL stays a no-op', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>|Hello|</paragraph>
			</root>
		);
		const before = JSON.stringify(edytor.value);

		await dispatchDomBeforeInput(editor, { inputType: 'insertLink' });
		expect(JSON.stringify(edytor.value)).toBe(before);
	});

	test('insertOrderedList converts the current block to a numbered list item', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, { inputType: 'insertOrderedList' });

		expect(result.defaultPrevented).toBe(true);
		expect(blockTypes(edytor.value)).toEqual(['numbered-list-item']);
	});

	test('insertUnorderedList converts the current block to a bulleted list item', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, { inputType: 'insertUnorderedList' });

		expect(result.defaultPrevented).toBe(true);
		expect(blockTypes(edytor.value)).toEqual(['bulleted-list-item']);
	});

	test('insertHorizontalRule inserts a divider without destroying block content', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, { inputType: 'insertHorizontalRule' });

		expect(result.defaultPrevented).toBe(true);
		// The old implementation converted the current block into a void
		// divider — discarding its text and children. Divider insertion
		// preserves the paragraph and lands the caret in a fresh block.
		expect(blockTypes(edytor.value)).toEqual(['paragraph', 'divider', 'paragraph']);
		expect(
			(edytor.value.children ?? [])[0].content?.map((p) => ('text' in p ? p.text : '')).join('')
		).toBe('Hello');
	});

	test('formatFontColor applies the color mark with the payload', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>|Hello|</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, {
			inputType: 'formatFontColor',
			data: 'rgb(255, 0, 0)'
		});

		expect(result.defaultPrevented).toBe(true);
		const content = (edytor.value.children ?? [])[0]?.content as Array<Record<string, unknown>>;
		expect(content).toEqual([
			expect.objectContaining({
				text: 'Hello',
				marks: { color: 'rgb(255, 0, 0)' }
			})
		]);
	});

	test('formatBackColor applies the highlight mark with the payload', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>|Hello|</paragraph>
			</root>
		);

		const result = await dispatchDomBeforeInput(editor, {
			inputType: 'formatBackColor',
			data: 'yellow'
		});

		expect(result.defaultPrevented).toBe(true);
		const content = (edytor.value.children ?? [])[0]?.content as Array<Record<string, unknown>>;
		expect(content).toEqual([
			expect.objectContaining({
				text: 'Hello',
				marks: { highlight: 'yellow' }
			})
		]);
	});
});

describe('foreign element spoofing of managed markers', () => {
	test('an injected element spoofing data-edytor-text is removed', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		const spoof = document.createElement('span');
		spoof.setAttribute('data-edytor-text', 'true');
		spoof.setAttribute('data-edytor-id', 'bogus-id');
		spoof.textContent = 'spoofed';
		editor.append(spoof);
		await flushDomUpdates();

		expect(spoof.isConnected).toBe(false);
	});

	test('an injected subtree containing only spoofed managed markers is removed', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		const wrapper = document.createElement('div');
		const spoof = document.createElement('span');
		spoof.setAttribute('data-edytor-block', '');
		spoof.setAttribute('data-edytor-id', 'bogus-block');
		spoof.textContent = 'spoofed block';
		wrapper.append(spoof);
		editor.append(wrapper);
		await flushDomUpdates();

		expect(wrapper.isConnected).toBe(false);
	});

	test('an injected element spoofing the root marker is removed', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		const spoof = document.createElement('div');
		spoof.setAttribute('data-edytor', '');
		spoof.textContent = 'nested editor spoof';
		editor.append(spoof);
		await flushDomUpdates();

		expect(spoof.isConnected).toBe(false);
	});

	// R7 rewrite (answer (c)): a text element is a strict container; a foreign
	// element carrying text inside it is input — its text is adopted by the
	// location default and the element removed. A mark name no mark declares
	// claims no core identity.
	test('a spoofed mark inside a live text: its text is adopted, the element removed', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const textElement = firstText(edytor).node!;
		const modelBefore = JSON.stringify(edytor.value);

		const spoof = document.createElement('span');
		spoof.setAttribute('data-edytor-mark', 'evil-mark');
		spoof.textContent = 'x';
		textElement.append(spoof);
		await flushDomUpdates();

		expect(spoof.isConnected).toBe(false);
		expect(modelBefore).not.toContain('Hellox');
		expect(edytor.root!.children[0]!.firstText!.stringContent).toBe('Hellox');
		expect(
			textElement.isConnected ? textElement.textContent : firstText(edytor).node!.textContent
		).toBe('Hellox');
	});
});

describe('prototype-chain attribute names on managed elements', () => {
	test('constructor/toString/hasOwnProperty attributes heal without crashing the flush', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const textElement = firstText(edytor).node!;

		// `attributeName in spec` used to resolve `constructor` to the
		// Object constructor — `Object.entries(spec.owned)` then threw and
		// the whole mutation batch was dropped. Own-key checks fixed it;
		// these foreign attrs must simply be stripped.
		textElement.setAttribute('constructor', 'spoof');
		textElement.setAttribute('toString', 'spoof');
		textElement.setAttribute('hasOwnProperty', 'spoof');
		await flushDomUpdates();

		expect(textElement.hasAttribute('constructor')).toBe(false);
		expect(textElement.hasAttribute('toString')).toBe(false);
		expect(textElement.hasAttribute('hasOwnProperty')).toBe(false);
		expect((edytor.value.children ?? [])[0]?.content).toEqual([
			expect.objectContaining({ text: 'Hello' })
		]);
	});
});

describe('composition + history guard', () => {
	test('historyUndo during an active composition is swallowed', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const before = JSON.stringify(edytor.value);

		await dispatchComposition(editor, [{ type: 'compositionstart' }]);
		expect(edytor.isComposing).toBe(true);

		const undo = await dispatchDomBeforeInput(editor, { inputType: 'historyUndo' });
		const redo = await dispatchDomBeforeInput(editor, { inputType: 'historyRedo' });

		expect(undo.defaultPrevented).toBe(true);
		expect(redo.defaultPrevented).toBe(true);
		expect(JSON.stringify(edytor.value)).toBe(before);

		await dispatchComposition(editor, [{ type: 'compositionend', data: '' }]);
	});
});

describe('attribute damage recorded mid-composition', () => {
	test('foreign attribute mutations requeue during composition and heal after the commit', async () => {
		const { editor, edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const textElement = firstText(edytor).node!;

		await dispatchComposition(editor, [{ type: 'compositionstart' }]);
		textElement.setAttribute('data-foreign', 'x');

		// Let at least one composition-idle observer pass run so the record
		// is PROCESSED-and-requeued (not just still sitting in the queue).
		await sleep(850);

		await dispatchComposition(editor, [{ type: 'compositionend', data: '' }]);
		await sleep(850);
		await flushDomUpdates();

		expect(textElement.hasAttribute('data-foreign')).toBe(false);
	});
});

describe('post-repair caret restore', () => {
	test('a foreign mutation does not steal the DOM selection back from outside the editor', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);
		const text = firstText(edytor);
		const textElement = text.node!;
		const textNode = Array.from(textElement.childNodes).find(
			(node) => node.nodeType === Node.TEXT_NODE
		);
		if (!textNode) {
			throw new Error('Missing DOM text node');
		}

		// A real document selection outside the editor — the derive
		// ignores outside anchors, so the model still holds its caret
		// while the DOM selection belongs to another element. (No
		// `focus()` — jsdom collapses the document selection on it, and
		// the restore guard only inspects the range, not focus.)
		const outside = document.createElement('div');
		outside.textContent = 'outside text';
		document.body.append(outside);
		const outsideText = outside.firstChild!;
		const selection = window.getSelection()!;
		const range = document.createRange();
		range.setStart(outsideText, 2);
		range.setEnd(outsideText, 2);
		selection.removeAllRanges();
		selection.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
		await flushDomUpdates();
		// Boolean assertions only — chai's deep inspector walks
		// ownerDocument.defaultView on Node values and crashes on
		// Svelte's DEV `globalThis.$state` getter.
		expect(selection.anchorNode === outsideText).toBe(true);

		// Foreign text mutation → observer flush → reconcile → caret
		// restore. The restore must bail: the DOM selection lives outside.
		textNode.textContent = 'Hello!';
		await flushDomUpdates();
		await sleep(30);

		expect(selection.anchorNode === outsideText).toBe(true);
		expect(selection.isCollapsed).toBe(true);
		outside.remove();
	});

	test('a blur caused by foreign DOM damage (no outside gesture) still restores the caret', async () => {
		// DST seed-2 regression: a foreign mutation that removes
		// `contenteditable` blurs the editor — Chromium then drops the
		// document range in a later task. The blur arrives as a focusout
		// with NO relatedTarget — indistinguishable from a user blur by
		// event kind, but it carries no outside gesture evidence, so the
		// repair must still re-assert the caret.
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		editor.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null }));
		window.getSelection()!.removeAllRanges();

		// The DST trigger: a foreign attribute mutation on the root that
		// the observer heals — the repair path that restores the caret.
		editor.removeAttribute('contenteditable');
		await flushDomUpdates();
		await sleep(30);

		const selection = window.getSelection()!;
		expect(editor.getAttribute('contenteditable') !== null).toBe(true);
		expect(selection.rangeCount > 0).toBe(true);
		expect(selection.anchorNode && editor.contains(selection.anchorNode)).toBe(true);
	});

	test('a focusout toward an outside target suppresses the caret restore', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		// Focus moving to a real outside element is user-owned — the same
		// evidence an outside pointerdown provides.
		const outsideButton = document.createElement('button');
		document.body.append(outsideButton);
		editor.dispatchEvent(new FocusEvent('focusout', { relatedTarget: outsideButton }));
		window.getSelection()!.removeAllRanges();

		editor.removeAttribute('contenteditable');
		await flushDomUpdates();
		await sleep(30);

		expect(window.getSelection()!.rangeCount).toBe(0);
		outsideButton.remove();
	});

	test('a pointerdown outside the editor suppresses the caret restore; an inside gesture re-arms it', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>
		);

		// Outside pointerdown → the next dropped range is user-owned.
		// (MouseEvent stands in — jsdom lacks PointerEvent; the listener
		// only reads `target`.)
		document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
		window.getSelection()!.removeAllRanges();
		editor.removeAttribute('contenteditable');
		await flushDomUpdates();
		await sleep(30);
		expect(window.getSelection()!.rangeCount).toBe(0);

		// An inside gesture re-establishes editor ownership — the next
		// repair restores again.
		editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
		editor.removeAttribute('contenteditable');
		await flushDomUpdates();
		await sleep(30);
		expect(window.getSelection()!.rangeCount > 0).toBe(true);
	});
});

describe('selection emission dedupe', () => {
	test('setCollapsedStateAtTextOffset emits once for a repeated identical write', async () => {
		const onSelectionChange = vi.fn();
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello|</paragraph>
			</root>,
			{ onSelectionChange }
		);
		const text = firstText(edytor);
		onSelectionChange.mockClear();

		edytor.selection.setCollapsedStateAtTextOffset(text, 2);
		edytor.selection.setCollapsedStateAtTextOffset(text, 2);

		expect(onSelectionChange).toHaveBeenCalledTimes(1);
	});
});
