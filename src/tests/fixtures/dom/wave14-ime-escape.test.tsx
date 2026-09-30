/** @jsxImportSource ../../jsx */
/**
 * Wave 14 (`docs/reviews/2026-09-30-rescore-11.md`): leaving a block
 * selection. A composition over a block selection replaces the blocks the
 * way typing does and writes nowhere else (EW-01): a block selection shows
 * no DOM range, so the IME would write at the editable's start unless the
 * session gives it a caret first. Escape over a lone selected divider puts
 * the caret on the next shown line, never in the divider's phantom text
 * (EW-06). Expected states are hand-authored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { createImagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import {
	setNativeSelection,
	dispatchComposition,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

let keep = false;
/** Refuses every operation while set (a plugin locking the document's structure). */
let lock = false;
/** Every `onDeleteSelectedBlocks` payload's ids, and every operation's `effect.removes`. */
const hooked: string[][] = [];
const removes: string[][] = [];
/** Keeps the blocks while `keep` is set (a plugin guarding them). */
const guarding: Plugin = () => ({
	onDeleteSelectedBlocks: ({ prevent, selectedBlocks }) => {
		hooked.push(selectedBlocks.map((block) => block.id));
		if (keep) prevent();
	},
	onBeforeOperation: ({ effect, prevent }) => {
		if (effect?.removes.length) removes.push([...effect.removes]);
		if (lock) prevent();
	}
});
afterEach(() => {
	keep = lock = false;
	hooked.length = removes.length = 0;
});

const render = (children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [
				guarding,
				richTextPlugin,
				mentionPlugin,
				codePlugin,
				blockMenuPlugin,
				createImagePlugin({ upload: async () => 'https://example.com/a.png' })
			],
			value: { children }
		}
	);
type View = Awaited<ReturnType<typeof render>>;

const p = (id: string, text = id): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });
const divider = (id: string): JSONBlock => ({ id, type: 'divider' });
const get = ({ edytor }: View, id: string) => edytor.idToBlock.get(id)!;
/** Each top-level block as `type:text` (a divider's phantom text included). */
const lines = ({ edytor }: View) =>
	(edytor.value.children ?? []).map(
		(block) =>
			`${block.type}:${(block.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('')}`
	);
const caret = ({ edytor }: View) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	return [startText?.parent.id, yStart, isCollapsed];
};
const caretIn = async (view: View, id: string, offset?: number) => {
	const text = get(view, id).firstText!;
	view.edytor.selection.setAtTextOffset(text, offset ?? text.length);
	await flushDomUpdates();
};
const key = (key: string, extra: Record<string, boolean> = {}) =>
	dispatchDomKeyDown(document, { key, ...extra });
const type = (editor: HTMLElement, data: string) =>
	dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
const undo = (editor: HTMLElement) => dispatchDomBeforeInput(editor, { inputType: 'historyUndo' });

/** The `[data-edytor-text]` element the DOM selection's focus sits in, and whose block it is. */
const domCaretBlock = ({ edytor }: View) => {
	const selection = document.getSelection();
	if (!selection?.rangeCount) return null;
	const element = (
		selection.focusNode?.nodeType === Node.TEXT_NODE
			? selection.focusNode.parentElement
			: (selection.focusNode as Element | null)
	)?.closest('[data-edytor-text]');
	return element ? (edytor.selection.getTextOfNode(element)?.parent.id ?? null) : null;
};

/**
 * What Chromium's IME does for one composition step: a `beforeinput`
 * it does not let the page cancel, then it writes `data` over its
 * composition range at the DOM caret — at the editable's first text when
 * the view shows no range — then an `input`.
 */
const imeStep = async (view: View, data: string, previous: string) => {
	const { editor } = view;
	const before = new Event('beforeinput', { bubbles: true, cancelable: false }) as InputEvent;
	Object.defineProperties(before, {
		inputType: { value: 'insertCompositionText' },
		data: { value: data },
		isComposing: { value: true },
		getTargetRanges: { value: () => [] }
	});
	editor.dispatchEvent(before);
	const selection = document.getSelection()!;
	// The first write replaces the range the IME found.
	if (selection.rangeCount && !selection.isCollapsed) {
		const range = selection.getRangeAt(0);
		range.deleteContents();
		selection.collapse(range.startContainer, range.startOffset);
	}
	let leaf: globalThis.Text;
	let at: number;
	if (selection.rangeCount && selection.focusNode?.nodeType === Node.TEXT_NODE) {
		leaf = selection.focusNode as globalThis.Text;
		at = selection.focusOffset;
	} else {
		const walker = document.createTreeWalker(
			selection.rangeCount ? selection.focusNode! : editor,
			NodeFilter.SHOW_TEXT
		);
		leaf = walker.nextNode() as globalThis.Text;
		at = 0;
	}
	const from = Math.max(0, at - previous.length);
	leaf.data = leaf.data.slice(0, from).replace(/\u200B/g, '') + data + leaf.data.slice(at);
	selection.collapse(leaf, from + data.length);
	const input = new Event('input', { bubbles: true }) as InputEvent;
	Object.defineProperties(input, {
		inputType: { value: 'insertCompositionText' },
		data: { value: data },
		isComposing: { value: true }
	});
	editor.dispatchEvent(input);
	await flushDomUpdates();
};

/** A whole IME session: start, `steps` written the way Chromium writes them, then commit `value`. */
const compose = async (view: View, steps: string[], value: string | null) => {
	await dispatchComposition(view.editor, [{ type: 'compositionstart' }]);
	let shown = '';
	for (const step of steps) {
		await imeStep(view, step, shown);
		shown = step;
	}
	if (value) await dispatchComposition(view.editor, [{ type: 'compositionend', data: value }]);
	else await dispatchComposition(view.editor, [{ type: 'compositionend', data: '' }]);
	await flushDomUpdates();
};

const seed = () => [p('first'), p('before'), divider('d'), p('after')];

describe('EW-01 — a composition over a block selection replaces it and writes nowhere else', () => {
	it('over a Backspace-selected divider: the composed text takes its place; one undo restores it', async () => {
		const view = await render(seed());
		await caretIn(view, 'after', 0);
		await key('Backspace');
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['d']);
		await dispatchComposition(view.editor, [{ type: 'compositionstart' }]);
		// The IME is given a caret in the block that takes the divider's place.
		const slot = domCaretBlock(view);
		expect(slot).not.toBeNull();
		expect(['first', 'before', 'd', 'after']).not.toContain(slot);
		await imeStep(view, 'に', '');
		await imeStep(view, 'にほ', 'に');
		await dispatchComposition(view.editor, [{ type: 'compositionend', data: '日本' }]);
		await flushDomUpdates();
		expect(lines(view)).toEqual([
			'paragraph:first',
			'paragraph:before',
			'paragraph:日本',
			'paragraph:after'
		]);
		expect(caret(view)).toEqual([slot, 2, true]);
		await undo(view.editor);
		await flushDomUpdates();
		expect(lines(view)).toEqual([
			'paragraph:first',
			'paragraph:before',
			'divider:',
			'paragraph:after'
		]);
	});

	it('over two selected paragraphs: one paragraph holds the composed text', async () => {
		const view = await render(seed());
		view.edytor.selection.selectBlocks(get(view, 'first'), get(view, 'before'));
		await flushDomUpdates();
		await compose(view, ['か'], '日');
		expect(lines(view)).toEqual(['paragraph:日', 'divider:', 'paragraph:after']);
		await undo(view.editor);
		await flushDomUpdates();
		expect(lines(view)).toEqual([
			'paragraph:first',
			'paragraph:before',
			'divider:',
			'paragraph:after'
		]);
	});

	it('a canceled composition leaves one empty paragraph in the blocks’ place, no stray text', async () => {
		const view = await render(seed());
		await caretIn(view, 'after', 0);
		await key('Backspace');
		await compose(view, ['に'], null);
		expect(lines(view)).toEqual([
			'paragraph:first',
			'paragraph:before',
			'paragraph:',
			'paragraph:after'
		]);
	});

	it('a plugin that keeps the blocks refuses it: no text lands anywhere, the blocks stay selected', async () => {
		const view = await render(seed());
		await caretIn(view, 'after', 0);
		await key('Backspace');
		keep = true;
		await compose(view, ['に'], '日');
		expect(lines(view)).toEqual([
			'paragraph:first',
			'paragraph:before',
			'divider:',
			'paragraph:after'
		]);
		expect(get(view, 'first').firstText!.node!.textContent).toBe('first');
		expect(get(view, 'after').firstText!.node!.textContent).toBe('after');
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['d']);
	});
});

describe('EW-01 — a composition over a selected inline atom replaces it and writes nowhere else', () => {
	it('the browser parks a caret at the editable’s start: the preview still replaces the atom', async () => {
		const view = await render([
			p('first'),
			{
				id: 'm',
				type: 'paragraph',
				content: [{ text: 'lead ' }, { type: 'mention', id: 'at', data: {} }, { text: ' end' }]
			}
		]);
		const atom = get(view, 'm').content.find((part) => !('stringContent' in part))!;
		view.edytor.selection.selectInlineBlock(atom as never);
		await flushDomUpdates();
		expect(view.edytor.selection.selectedInlineBlock.size).toBe(1);
		// Chromium's IME, finding no range, parks one at the editable's first text.
		document.getSelection()!.collapse(get(view, 'first').firstText!.node!.firstChild!, 0);
		await compose(view, ['に'], '日本');
		expect(lines(view)).toEqual(['paragraph:first', 'paragraph:lead 日本 end']);
		expect(caret(view)).toEqual(['m', 7, true]);
	});
});

describe('DR-behavior-1 — a composition over a block selection after an earlier composition', () => {
	/** An ordinary composition at the end of 'first', then past the tail and the undo capture window. */
	const composeEarlier = async (view: View) => {
		await caretIn(view, 'first');
		await compose(view, ['x'], 'x');
		expect(lines(view)[0]).toBe('paragraph:firstx');
		await new Promise((resolve) => setTimeout(resolve, 600));
	};
	/** The block that is none of `ids`. */
	const fresh = (view: View, ids: string[]) =>
		view.edytor.value.children!.map((block) => block.id!).find((id) => !ids.includes(id))!;

	it('over a Backspace-selected divider: the session stays live, the commit lands, the pin goes', async () => {
		const view = await render(seed());
		await composeEarlier(view);
		await caretIn(view, 'after', 0);
		await key('Backspace');
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['d']);
		await dispatchComposition(view.editor, [{ type: 'compositionstart' }]);
		expect(view.edytor.composition.phase).toBe('live');
		await imeStep(view, 'に', '');
		await dispatchComposition(view.editor, [{ type: 'compositionend', data: '日' }]);
		await flushDomUpdates();
		expect(lines(view)).toEqual([
			'paragraph:firstx',
			'paragraph:before',
			'paragraph:日',
			'paragraph:after'
		]);
		const slot = fresh(view, ['first', 'before', 'd', 'after']);
		const text = get(view, slot).firstText!;
		expect(view.edytor.composition.host).toBeNull();
		expect(view.edytor.pin.owns(text.node)).toBe(false);
		// The block renders again: typed text shows on screen.
		await type(view.editor, 'Z');
		await flushDomUpdates();
		expect(lines(view)[2]).toBe('paragraph:日Z');
		expect(text.node!.textContent!.replace(/\u200B/g, '')).toBe('日Z');
	});

	it('over two selected paragraphs: one paragraph holds the commit; one undo restores them', async () => {
		const view = await render(seed());
		await composeEarlier(view);
		view.edytor.selection.selectBlocks(get(view, 'first'), get(view, 'before'));
		await flushDomUpdates();
		await dispatchComposition(view.editor, [{ type: 'compositionstart' }]);
		expect(view.edytor.composition.phase).toBe('live');
		await imeStep(view, 'か', '');
		await dispatchComposition(view.editor, [{ type: 'compositionend', data: '日' }]);
		await flushDomUpdates();
		expect(lines(view)).toEqual(['paragraph:日', 'divider:', 'paragraph:after']);
		expect(view.edytor.composition.host).toBeNull();
		await undo(view.editor);
		await flushDomUpdates();
		expect(lines(view)).toEqual([
			'paragraph:firstx',
			'paragraph:before',
			'divider:',
			'paragraph:after'
		]);
	});

	it('over two selected list items: one list item holds the commit (selection.mdx)', async () => {
		const view = await render([
			p('first'),
			{
				id: 'L',
				type: 'unordered-list',
				children: ['i1', 'i2', 'i3'].map((id) => ({
					id,
					type: 'list-item',
					content: [{ text: id }]
				}))
			}
		]);
		await composeEarlier(view);
		view.edytor.selection.selectBlocks(get(view, 'i1'), get(view, 'i2'));
		await flushDomUpdates();
		await compose(view, ['か'], '日');
		const list = view.edytor.value.children![1];
		expect(
			list.children!.map(
				(item) =>
					`${item.type}:${(item.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('')}`
			)
		).toEqual(['list-item:日', 'list-item:i3']);
	});
});

describe('EW-06 — Escape over a lone selected divider leaves for a shown line', () => {
	const selectDivider = async (view: View) => {
		await caretIn(view, 'after', 0);
		await key('Backspace');
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['d']);
		await key('Escape');
	};

	it('the caret goes to the start of the next line; typing lands there', async () => {
		const view = await render(seed());
		await selectDivider(view);
		expect(view.edytor.selection.selectedBlocks.size).toBe(0);
		expect(caret(view)).toEqual(['after', 0, true]);
		await type(view.editor, 'Z');
		expect(lines(view)).toEqual([
			'paragraph:first',
			'paragraph:before',
			'divider:',
			'paragraph:Zafter'
		]);
	});

	it('Enter after Escape splits the next line at its start, not the divider', async () => {
		const view = await render(seed());
		await selectDivider(view);
		await key('Enter');
		await type(view.editor, 'E');
		expect(lines(view)).toEqual([
			'paragraph:first',
			'paragraph:before',
			'divider:',
			'paragraph:',
			'paragraph:Eafter'
		]);
	});

	it('a paste after Escape lands in the next line', async () => {
		const view = await render(seed());
		await selectDivider(view);
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertFromPaste', text: 'P' });
		expect(lines(view)).toEqual([
			'paragraph:first',
			'paragraph:before',
			'divider:',
			'paragraph:Pafter'
		]);
	});

	it('a divider that ends the document: the caret goes to the end of the line before it', async () => {
		const view = await render([p('first'), p('before'), divider('d')]);
		view.edytor.selection.selectBlocks(get(view, 'd'));
		await flushDomUpdates();
		await key('Escape');
		expect(caret(view)).toEqual(['before', 6, true]);
		await type(view.editor, 'Z');
		expect(lines(view)).toEqual(['paragraph:first', 'paragraph:beforeZ', 'divider:']);
	});
});

describe('EW-08 — onDeleteSelectedBlocks names the selected blocks, never an emptied container', () => {
	it('the only item of a list: the hook names the item; the emptied list goes too, named by effect.removes', async () => {
		const view = await render([
			p('a'),
			{
				id: 'L',
				type: 'unordered-list',
				children: [{ id: 'i', type: 'list-item', content: [{ text: 'i' }] }]
			},
			p('z')
		]);
		view.edytor.selection.selectBlocks(get(view, 'i'));
		await flushDomUpdates();
		await key('Backspace');
		expect(hooked).toEqual([['i']]);
		expect(lines(view)).toEqual(['paragraph:a', 'paragraph:z']);
		expect(removes.flat().sort()).toEqual(['L', 'i']);
	});

	it('every line of a code block: the hook names the lines; the code block (an island) stays', async () => {
		const view = await render([
			p('a'),
			{
				id: 'C',
				type: 'code',
				children: [
					{ id: 'l1', type: 'codeLine', content: [{ text: 'one' }] },
					{ id: 'l2', type: 'codeLine', content: [{ text: 'two' }] }
				]
			},
			p('z')
		]);
		view.edytor.selection.selectBlocks(get(view, 'l1'), get(view, 'l2'));
		await flushDomUpdates();
		await key('Backspace');
		expect(hooked).toEqual([['l1', 'l2']]);
		expect(view.edytor.idToBlock.get('C')?.isInTree).toBe(true);
	});
});

describe('EW-09 — Enter over a selected image puts the caret at the end of its caption', () => {
	const image: JSONBlock = {
		id: 'img',
		type: 'image',
		data: { src: 'https://example.com/a.png' },
		content: [{ text: 'cap' }]
	};

	it('typing right after Enter goes into the caption; a second Enter adds the line', async () => {
		const view = await render([p('a'), image, p('z')]);
		view.edytor.selection.selectBlocks(get(view, 'img'));
		await flushDomUpdates();
		await key('Enter');
		expect(caret(view)).toEqual(['img', 3, true]);
		await type(view.editor, 'x');
		expect(lines(view)).toEqual(['paragraph:a', 'image:capx', 'paragraph:z']);
		await key('Enter');
		await type(view.editor, 'n');
		expect(lines(view)).toEqual(['paragraph:a', 'image:capx', 'paragraph:n', 'paragraph:z']);
	});

	it('Escape over a selected image leaves for the end of its caption too', async () => {
		const view = await render([p('a'), image, p('z')]);
		view.edytor.selection.selectBlocks(get(view, 'img'));
		await flushDomUpdates();
		await key('Escape');
		expect(caret(view)).toEqual(['img', 3, true]);
	});
});

describe('SW14-ime-1 — the render leaves the IME’s range alone until the first preview', () => {
	it('compositionstart over f[irs]t: the host still shows first, the DOM range still covers irs', async () => {
		const view = await render([p('first'), p('z')]);
		const text = get(view, 'first').firstText!;
		await setNativeSelection(view.edytor, text, 1, text, 4);
		await dispatchComposition(view.editor, [{ type: 'compositionstart' }]);
		expect(text.node!.textContent).toBe('first');
		const selection = document.getSelection()!;
		expect([
			selection.anchorOffset,
			selection.focusOffset,
			selection.anchorNode?.textContent
		]).toEqual([1, 4, 'first']);
		await imeStep(view, 'に', '');
		await dispatchComposition(view.editor, [{ type: 'compositionend', data: '日' }]);
		await flushDomUpdates();
		expect(lines(view)).toEqual(['paragraph:f日t', 'paragraph:z']);
	});
});

describe('SW14-keys-1 — no key puts the caret in a lone selected divider’s phantom text', () => {
	it.each([
		['Home', {}],
		['End', {}],
		['Home', { shiftKey: true }],
		['End', { shiftKey: true }],
		['b', { ctrlKey: true }],
		['e', { ctrlKey: true }],
		['h', { ctrlKey: true, shiftKey: true }]
	] as const)('%s %o keeps the divider selected; typing then replaces it', async (name, mods) => {
		const view = await render(seed());
		await caretIn(view, 'after', 0);
		await key('Backspace');
		await key(name, mods);
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['d']);
		await type(view.editor, 'Z');
		expect(lines(view)).toEqual([
			'paragraph:first',
			'paragraph:before',
			'paragraph:Z',
			'paragraph:after'
		]);
	});

	it('Mod+B over selected paragraphs bolds them and keeps them selected', async () => {
		const view = await render(seed());
		view.edytor.selection.selectBlocks(get(view, 'first'), get(view, 'before'));
		await flushDomUpdates();
		await key('b', { ctrlKey: true });
		expect(view.edytor.value.children?.slice(0, 2).map((block) => block.content)).toEqual([
			[{ text: 'first', marks: { bold: true } }],
			[{ text: 'before', marks: { bold: true } }]
		]);
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['first', 'before']);
	});
});

describe('SW14-docs-1 — the block menu’s Escape over an image returns the caret to its caption', () => {
	it('the caret goes to the start of the caption; a divider stays selected', async () => {
		const view = await render([
			p('a'),
			{
				id: 'img',
				type: 'image',
				data: { src: 'https://example.com/a.png' },
				content: [{ text: 'cap' }]
			},
			divider('d'),
			p('z')
		]);
		const escape = async (id: string) => {
			const block = get(view, id);
			view.editor.dispatchEvent(
				new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
			);
			await flushDomUpdates();
			await dispatchDomKeyDown(
				document.querySelector<HTMLInputElement>('[aria-label="Search actions"]')!,
				{ key: 'Escape' }
			);
		};
		await escape('img');
		expect(caret(view)).toEqual(['img', 0, true]);
		await escape('d');
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['d']);
	});
});

describe('SW14-keys-2 — Enter over a lone divider whose new line is refused keeps the divider selected', () => {
	it('nothing changes and the caret never lands in the divider', async () => {
		const view = await render(seed());
		await caretIn(view, 'after', 0);
		await key('Backspace');
		lock = true;
		await key('Enter');
		lock = false;
		expect([...view.edytor.selection.selectedBlocks].map((b) => b.id)).toEqual(['d']);
		await type(view.editor, 'Z');
		expect(lines(view)).toEqual([
			'paragraph:first',
			'paragraph:before',
			'paragraph:Z',
			'paragraph:after'
		]);
	});
});
