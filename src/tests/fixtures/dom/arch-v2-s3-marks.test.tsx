/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint S3 rows (dom lane): the marks of an insertion are
 * chosen by ONE rule, `marksForInsertion` (O29, L42): explicit → pending →
 * common-of-replaced → the neighbour before, else after → the mark record's
 * edge policy, which reads the admitted edge side (R4, O48, O69, FP-8).
 *
 * - F-P4 — caret inside red italic text; Mod+B; type → `{color, italic, bold}`.
 * - F-P15 — `Link|` with the DOM caret inside the anchor extends the link;
 *   the same model offset with the DOM caret after the anchor does not.
 * - One row per insertion path proving the same answer: valued pending marks
 *   at a caret (typing, soft break, native adoption, IME commit, WebKit
 *   `insertFromComposition`, plain paste, a programmatic `insertText`), and the
 *   common marks of a replaced range (typing, autocorrect replacement, plain
 *   paste, IME).
 * - Valued pending marks: a link survives a collapsed Mod+B inside it.
 * - Mark records declare their edge policy: an `exclusive` mark does not
 *   extend at its trailing edge.
 *
 * Expected values come from the plan rows, never from running the code.
 */
import { describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { Text } from '$lib/text/text.svelte.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { JSONDoc, JSONText } from '$lib/utils/json.js';
import {
	dispatchComposition,
	dispatchDomBeforeInput,
	dispatchDomInput,
	dispatchDomKeyDown,
	dispatchPaste,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference; green since S3. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

const LINK = { href: 'https://example.com', target: '_blank' };
const RED_ITALIC = { color: 'red', italic: true };

const paragraph = (...content: JSONText[]): JSONDoc => ({
	children: [{ type: 'paragraph', content }]
});

const mount = async (value: JSONDoc, plugins: Plugin[] = [richTextPlugin, mentionPlugin]) => {
	const rendered = await renderDomEdytor(<root></root>, {
		value,
		plugins,
		autoSelectFixture: false
	});
	const text = rendered.edytor.root!.children[0]!.firstText!;
	return { ...rendered, text };
};

/** The model runs of the first paragraph, attribution stripped. */
const runs = (edytor: Edytor): JSONText[] =>
	(edytor.root!.children[0]!.firstText!.value ?? []).map(({ text, marks }) =>
		marks && Object.keys(marks).length ? { text, marks: { ...marks } } : { text }
	);

/** The marks the character at `offset` of the first paragraph carries. */
const marksAt = (edytor: Edytor, offset: number) =>
	edytor.root!.children[0]!.firstText!.getMarksAtRange(offset, offset + 1)[0]?.marks ?? {};

/** The DOM text node holding display offset `offset` of `text`, first match (the mapper's). */
const leafAt = (text: Text, offset: number) => {
	const walker = document.createTreeWalker(text.node!, NodeFilter.SHOW_TEXT);
	let start = 0;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const length = node.textContent?.length ?? 0;
		if (offset <= start + length) return { node: node as globalThis.Text, offset: offset - start };
		start += length;
	}
	throw new Error(`no DOM text at ${offset}`);
};

/** A native point: `node`/`offset` exactly as given, then `selectionchange`. */
const placeDomCaret = async (edytor: Edytor, node: Node, offset: number) => {
	edytor.markUserGesture();
	edytor.node?.focus();
	const range = document.createRange();
	range.setStart(node, offset);
	range.collapse(true);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	document.dispatchEvent(new Event('selectionchange'));
	await flushDomUpdates();
};

const modB = () => dispatchDomKeyDown(document, { key: 'b', code: 'KeyB', metaKey: true });

describe('F-P4 — pending marks keep their values (D12)', () => {
	row('caret inside red italic text; Mod+B; type → {color: red, italic, bold}', async () => {
		const { edytor, editor, text } = await mount(paragraph({ text: 'abcd', marks: RED_ITALIC }));
		await setNativeSelection(edytor, text, 2);
		await modB();
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		expect(runs(edytor)).toEqual([
			{ text: 'ab', marks: RED_ITALIC },
			{ text: 'x', marks: { ...RED_ITALIC, bold: true } },
			{ text: 'cd', marks: RED_ITALIC }
		]);
	});

	row('caret inside a link; Mod+B; type → the typed text stays linked', async () => {
		const { edytor, editor, text } = await mount(
			paragraph({ text: 'Link', marks: { link: LINK } })
		);
		// jsdom's `focus()` on an anchor moves the caret to its start (also when
		// the Mod+B command restores the selection): place it again after.
		const inside = leafAt(text, 2);
		await placeDomCaret(edytor, inside.node, inside.offset);
		await modB();
		await placeDomCaret(edytor, inside.node, inside.offset);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		expect(runs(edytor).map((run) => run.text)).toEqual(['Li', 'x', 'nk']);
		expect(marksAt(edytor, 2)).toEqual({ link: LINK, bold: true });
	});
});

describe('F-P15 — the link trailing edge reads the admitted side (FP-8)', () => {
	const linkThenTail = () => paragraph({ text: 'Link', marks: { link: LINK } }, { text: ' tail' });

	pin('DOM caret inside the anchor at `Link|`: `!` extends the link', async () => {
		const { edytor, editor, text } = await mount(linkThenTail());
		const inside = leafAt(text, 4);
		expect(inside.node.data).toBe('Link');
		await placeDomCaret(edytor, inside.node, inside.offset);
		expect(edytor.selection.state.yStart).toBe(4);
		const result = await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
		expect(result.defaultPrevented).toBe(true);
		expect(runs(edytor)).toEqual([{ text: 'Link!', marks: { link: LINK } }, { text: ' tail' }]);
	});

	row('DOM caret after the anchor (same model offset): `!` is not linked', async () => {
		const { edytor, editor, text } = await mount(linkThenTail());
		const after = leafAt(text, 5);
		expect(after.node.data).toBe(' tail');
		await placeDomCaret(edytor, after.node, 0);
		expect(edytor.selection.state.yStart).toBe(4);
		const result = await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
		expect(result.defaultPrevented).toBe(true);
		expect(runs(edytor)).toEqual([{ text: 'Link', marks: { link: LINK } }, { text: '! tail' }]);
	});

	row('DOM caret on the text element after the anchor: `!` is not linked', async () => {
		const { edytor, editor, text } = await mount(
			paragraph({ text: 'Link', marks: { link: LINK } })
		);
		// The element boundary after the mark element (child index 1 of the text element).
		const markElement = text.node!.querySelector('[data-edytor-mark="link"]')!;
		const host = markElement.parentNode!;
		await placeDomCaret(edytor, host, Array.from(host.childNodes).indexOf(markElement) + 1);
		expect(edytor.selection.state.yStart).toBe(4);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
		expect(runs(edytor)).toEqual([{ text: 'Link', marks: { link: LINK } }, { text: '!' }]);
	});
});

describe('one rule on every insertion path: valued pending marks at a caret', () => {
	const PENDING = { ...RED_ITALIC, bold: true };

	/** Mount `abcd` red italic, caret at 2 in the DOM, Mod+B pending. */
	const pending = async () => {
		const mounted = await mount(paragraph({ text: 'abcd', marks: RED_ITALIC }));
		await setNativeSelection(mounted.edytor, mounted.text, 2);
		await modB();
		return mounted;
	};

	row('typing (cancelable insertText)', async () => {
		const { edytor, editor } = await pending();
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		expect(marksAt(edytor, 2)).toEqual(PENDING);
	});

	row('soft break (insertLineBreak)', async () => {
		const { edytor, editor } = await pending();
		await dispatchDomBeforeInput(editor, { inputType: 'insertLineBreak' });
		expect(edytor.root!.children[0]!.firstText!.stringContent).toBe('ab\ncd');
		expect(marksAt(edytor, 2)).toEqual(PENDING);
	});

	row('native adoption (non-cancelable insertText, the browser writes)', async () => {
		const { edytor, editor, text } = await pending();
		const event = new Event('beforeinput', { bubbles: true, cancelable: false });
		Object.defineProperties(event, {
			inputType: { value: 'insertText' },
			data: { value: 'x' }
		});
		editor.dispatchEvent(event);
		const leaf = leafAt(text, 2);
		leaf.node.data = `${leaf.node.data.slice(0, leaf.offset)}x${leaf.node.data.slice(leaf.offset)}`;
		const range = document.createRange();
		range.setStart(leaf.node, leaf.offset + 1);
		range.collapse(true);
		window.getSelection()!.removeAllRanges();
		window.getSelection()!.addRange(range);
		await dispatchDomInput(editor, { inputType: 'insertText', data: 'x' });
		await flushDomUpdates();
		expect(edytor.root!.children[0]!.firstText!.stringContent).toBe('abxcd');
		expect(marksAt(edytor, 2)).toEqual(PENDING);
	});

	row('IME commit (model-owned preview, compositionend)', async () => {
		const { edytor, editor } = await pending();
		await dispatchComposition(editor, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);
		expect(edytor.root!.children[0]!.firstText!.stringContent).toBe('abにcd');
		expect(marksAt(edytor, 2)).toEqual(PENDING);
	});

	row('WebKit insertFromComposition', async () => {
		const { edytor, editor } = await pending();
		await dispatchComposition(editor, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertFromComposition', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);
		expect(edytor.root!.children[0]!.firstText!.stringContent).toBe('abにcd');
		expect(marksAt(edytor, 2)).toEqual(PENDING);
	});

	row('plain-text paste', async () => {
		const { edytor, editor } = await pending();
		await dispatchPaste(editor, 'x');
		expect(edytor.root!.children[0]!.firstText!.stringContent).toBe('abxcd');
		expect(marksAt(edytor, 2)).toEqual(PENDING);
	});

	row('a programmatic insertText without marks', async () => {
		const { edytor, text } = await pending();
		text.insertText({ value: 'x', start: 2, end: 2 });
		expect(marksAt(edytor, 2)).toEqual(PENDING);
	});
});

describe('one rule on every insertion path: common marks of a replaced range', () => {
	// `ab` red italic, `cd` red; the range `b|c` → common `{color: red}`.
	const COMMON = { color: 'red' };
	const range = async () => {
		const mounted = await mount(
			paragraph({ text: 'ab', marks: RED_ITALIC }, { text: 'cd', marks: { color: 'red' } })
		);
		await setNativeSelection(mounted.edytor, mounted.text, 1, mounted.text, 3);
		return mounted;
	};

	pin('typing over the range', async () => {
		const { edytor, editor } = await range();
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'x' });
		expect(edytor.root!.children[0]!.firstText!.stringContent).toBe('axd');
		expect(marksAt(edytor, 1)).toEqual(COMMON);
	});

	pin('autocorrect replacement (insertReplacementText)', async () => {
		const { edytor, editor } = await range();
		await dispatchDomBeforeInput(editor, { inputType: 'insertReplacementText', data: 'x' });
		expect(edytor.root!.children[0]!.firstText!.stringContent).toBe('axd');
		expect(marksAt(edytor, 1)).toEqual(COMMON);
	});

	row('plain-text paste over the range', async () => {
		const { edytor, editor } = await range();
		await dispatchPaste(editor, 'x');
		expect(edytor.root!.children[0]!.firstText!.stringContent).toBe('axd');
		expect(marksAt(edytor, 1)).toEqual(COMMON);
	});

	pin('IME commit over the range', async () => {
		const { edytor, editor } = await range();
		await dispatchComposition(editor, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);
		expect(edytor.root!.children[0]!.firstText!.stringContent).toBe('aにd');
		expect(marksAt(edytor, 1)).toEqual(COMMON);
	});
});

describe('O69 — a mark record declares its edge policy', () => {
	/** Rich text with `underline` redeclared as an exclusive mark. */
	const exclusiveUnderline: Plugin = (edytor) => {
		const definitions = richTextPlugin(edytor);
		const underline = definitions.marks!.underline!;
		definitions.marks!.underline = {
			snippet: typeof underline === 'function' ? underline : underline.snippet,
			edge: 'exclusive'
		} as never;
		return definitions;
	};

	row('an exclusive mark does not extend at its trailing edge', async () => {
		const { edytor, editor, text } = await mount(
			paragraph({ text: 'ab', marks: { underline: true } }, { text: ' tail' }),
			[exclusiveUnderline, mentionPlugin]
		);
		const inside = leafAt(text, 2);
		await placeDomCaret(edytor, inside.node, inside.offset);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
		expect(runs(edytor)).toEqual([{ text: 'ab', marks: { underline: true } }, { text: '! tail' }]);
	});

	pin('inside an exclusive run the insertion takes it', async () => {
		const { edytor, editor, text } = await mount(
			paragraph({ text: 'ab', marks: { underline: true } }, { text: ' tail' }),
			[exclusiveUnderline, mentionPlugin]
		);
		await setNativeSelection(edytor, text, 1);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
		expect(runs(edytor)).toEqual([{ text: 'a!b', marks: { underline: true } }, { text: ' tail' }]);
	});
});
