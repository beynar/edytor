/** @jsxImportSource ../../jsx */
/**
 * Wave 12 (`docs/archive/reviews/2026-09-30-rescore-9.md`), plugin hooks and dev
 * warnings: code-line Tab and Shift+Tab over several lines skip a vetoed
 * line only (CW-02); every gesture that removes a block selection runs
 * `onDeleteSelectedBlocks` (CW-04); a divider mounts without a Svelte dev
 * warning (CW-05); Backspace after a trailing soft break runs as a command
 * `onBeforeOperation` sees (SW12-hooks-1). Expected states are hand-authored.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { mentionPlugin } from '../../atMention.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
import { insertEdytorClipboardFragment } from '$lib/clipboard/insertClipboardFragment.js';
import {
	dispatchClipboardPaste,
	dispatchComposition,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	dispatchPaste,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

const render = (plugins: Plugin[], children: JSONBlock[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [richTextPlugin, mentionPlugin, codePlugin, ...plugins], value: { children } }
	);
type View = Awaited<ReturnType<typeof render>>;

const p = (id: string): JSONBlock => ({ id, type: 'paragraph', content: [{ text: id }] });
const get = ({ edytor }: View, id: string) => edytor.idToBlock.get(id)!;
const status = (view: View) => view.edytor.dispatcher.last?.status;
const shape = ({ edytor }: View) => {
	const show = (b: JSONBlock): unknown => {
		const own = (b.content ?? []).map((part) => ('text' in part ? part.text : '@')).join('');
		const line = `${b.type} "${own}"`;
		return b.children?.length ? [line, b.children.map(show)] : line;
	};
	return (edytor.value.children ?? []).map(show);
};

describe('Code-line Tab over several lines skips a vetoed line only (CW-02)', () => {
	const veto: Plugin = () => ({
		onBeforeOperation: ({ block, prevent }) => {
			if ((block as { data?: { locked?: boolean } })?.data?.locked) prevent();
		}
	});
	const line = (id: string, text: string, locked = false): JSONBlock => ({
		id,
		type: 'codeLine',
		content: [{ text }],
		...(locked ? { data: { locked: true } } : {})
	});
	const code = (lines: JSONBlock[]): JSONBlock[] => [{ id: 'code', type: 'code', children: lines }];
	const selectAll = async (view: View) => {
		view.edytor.selection.setAtRange(get(view, 'l1').firstText!, 1, get(view, 'l3').firstText!, 2);
		await flushDomUpdates();
	};
	const lines = (view: View) =>
		get(view, 'code').children.map((l) => l.firstText?.stringContent ?? '');

	it('Tab indents l1 and l3, keeps the locked l2, and reports applied', async () => {
		const view = await render(
			[veto],
			code([line('l1', 'one'), line('l2', 'two', true), line('l3', 'three')])
		);
		await selectAll(view);
		await dispatchDomKeyDown(document, { key: 'Tab' });
		expect(lines(view)).toEqual(['\tone', 'two', '\tthree']);
		expect(status(view)).toBe('applied');
		// The selection keeps its characters on the lines that moved.
		const { yStart, yEnd } = view.edytor.selection.state;
		expect([yStart, yEnd]).toEqual([2, 3]);
	});

	it('Shift+Tab dedents l1 and l3, keeps the locked l2, and reports applied', async () => {
		const view = await render(
			[veto],
			code([line('l1', '\tone'), line('l2', '\ttwo', true), line('l3', '\tthree')])
		);
		await selectAll(view);
		await dispatchDomKeyDown(document, { key: 'Tab', shiftKey: true });
		expect(lines(view)).toEqual(['one', '\ttwo', 'three']);
		expect(status(view)).toBe('applied');
		// One undo step restores both lines.
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(lines(view)).toEqual(['\tone', '\ttwo', '\tthree']);
	});

	it('every line vetoed: nothing changes, and it reports refused', async () => {
		const view = await render([veto], code([line('l1', 'one', true), line('l3', 'three', true)]));
		await selectAll(view);
		await dispatchDomKeyDown(document, { key: 'Tab' });
		expect(lines(view)).toEqual(['one', 'three']);
		expect(status(view)).toBe('refused');
	});
});

describe('Every gesture that removes a block selection runs onDeleteSelectedBlocks (CW-04)', () => {
	const keeping: Plugin = () => ({ onDeleteSelectedBlocks: ({ prevent }) => prevent() });
	const seed = () => [p('a'), p('b'), p('c')];
	const unchanged = ['paragraph "a"', 'paragraph "b"', 'paragraph "c"'];
	const selectAB = async (view: View) => {
		view.edytor.selection.selectBlocks(get(view, 'a'), get(view, 'b'));
		await flushDomUpdates();
	};

	it('typing keeps the blocks', async () => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertText', data: 'x' });
		expect(shape(view)).toEqual(unchanged);
		expect(status(view)).toBe('refused');
	});

	it('a printable key (the keydown deadline) keeps the blocks', async () => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await dispatchDomKeyDown(document, { key: 'x' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await flushDomUpdates();
		expect(shape(view)).toEqual(unchanged);
	});

	it('Enter keeps the blocks', async () => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertParagraph' });
		expect(shape(view)).toEqual(unchanged);
	});

	it('Shift+Enter keeps the blocks', async () => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertLineBreak' });
		expect(shape(view)).toEqual(unchanged);
	});

	it('a plain-text paste keeps the blocks', async () => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await dispatchPaste(view.editor, 'zz');
		expect(shape(view)).toEqual(unchanged);
	});

	it('an HTML paste keeps the blocks', async () => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await dispatchClipboardPaste(view.editor, { 'text/html': '<p>zz</p>', 'text/plain': 'zz' });
		expect(shape(view)).toEqual(unchanged);
	});

	it('insertEdytorClipboardFragment keeps the blocks', async () => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await insertEdytorClipboardFragment(view.edytor, {
			kind: 'content',
			content: [{ text: 'zz' }]
		} as never);
		await flushDomUpdates();
		expect(shape(view)).toEqual(unchanged);
	});

	it('a composition keeps the blocks', async () => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await dispatchComposition(view.editor, [
			{ type: 'compositionstart', data: '' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'x' },
			{ type: 'compositionend', data: 'x' }
		] as never);
		await flushDomUpdates();
		expect(shape(view)).toEqual(unchanged);
	});

	it('Backspace keeps them and reports refused (the reference)', async () => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await dispatchDomKeyDown(document, { key: 'Backspace' });
		expect(shape(view)).toEqual(unchanged);
		expect(status(view)).toBe('refused');
	});

	it('Enter over a selected divider removes nothing: the hook does not run, a line goes after it', async () => {
		const seen: string[][] = [];
		const watching: Plugin = () => ({
			onDeleteSelectedBlocks: ({ selectedBlocks, prevent }) => {
				seen.push(selectedBlocks.map((b) => b.id));
				prevent();
			}
		});
		const view = await render([watching], [p('a'), { id: 'd', type: 'divider' }, p('c')]);
		view.edytor.selection.selectBlocks(get(view, 'd'));
		await flushDomUpdates();
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertParagraph' });
		expect(seen).toEqual([]);
		expect(shape(view)).toEqual(['paragraph "a"', 'divider ""', 'paragraph ""', 'paragraph "c"']);
	});

	it('the hook sees the blocks typing replaces, and without prevent() they go', async () => {
		const seen: string[][] = [];
		const watching: Plugin = () => ({
			onDeleteSelectedBlocks: ({ selectedBlocks }) => {
				seen.push(selectedBlocks.map((b) => b.id));
			}
		});
		const view = await render([watching], seed());
		await selectAB(view);
		await dispatchDomBeforeInput(view.editor, { inputType: 'insertText', data: 'x' });
		expect(seen).toEqual([['a', 'b']]);
		expect(shape(view)).toEqual(['paragraph "x"', 'paragraph "c"']);
	});

	it('the hook sees the blocks a paste replaces', async () => {
		const seen: string[][] = [];
		const watching: Plugin = () => ({
			onDeleteSelectedBlocks: ({ selectedBlocks }) => {
				seen.push(selectedBlocks.map((b) => b.id));
			}
		});
		const view = await render([watching], seed());
		await selectAB(view);
		await dispatchPaste(view.editor, 'zz');
		expect(seen).toEqual([['a', 'b']]);
		expect(shape(view)).toEqual(['paragraph "zz"', 'paragraph "c"']);
	});
});

describe('A divider mounts without a Svelte dev warning (CW-05)', () => {
	it('two dividers log no console.warn', async () => {
		const warn = vi.spyOn(console, 'warn');
		const view = await render(
			[],
			[p('a'), { id: 'd1', type: 'divider' }, p('b'), { id: 'd2', type: 'divider' }]
		);
		expect(view.editor.querySelectorAll('hr')).toHaveLength(2);
		expect(warn).not.toHaveBeenCalled();
	});
});

describe('Sweep: Backspace after a trailing soft break is a command hooks see (SW12-hooks-1)', () => {
	const seen: string[] = [];
	const vetoAll: Plugin = () => ({
		onBeforeOperation: ({ operation, prevent }) => {
			seen.push(operation);
			prevent();
		}
	});
	const soft = (): JSONBlock[] => [{ id: 'a', type: 'paragraph', content: [{ text: 'ab\n' }] }];

	it('Backspace after a trailing soft break is a command a plugin can veto', async () => {
		seen.length = 0;
		const view = await render([vetoAll], soft());
		view.edytor.selection.setAtTextOffset(get(view, 'a').firstText!, 3);
		await flushDomUpdates();
		await dispatchDomBeforeInput(view.editor, { inputType: 'deleteContentBackward' });
		expect(get(view, 'a').firstText?.stringContent).toBe('ab\n');
		expect(seen.length).toBeGreaterThan(0);
		expect(status(view)).toBe('refused');
	});

	it('without a veto it deletes the break, as one undo step', async () => {
		const view = await render([], soft());
		view.edytor.selection.setAtTextOffset(get(view, 'a').firstText!, 3);
		await flushDomUpdates();
		await dispatchDomBeforeInput(view.editor, { inputType: 'deleteContentBackward' });
		expect(get(view, 'a').firstText?.stringContent).toBe('ab');
		expect(view.edytor.selection.state.yStart).toBe(2);
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(get(view, 'a').firstText?.stringContent).toBe('ab\n');
	});
});

describe('Word and line deletes over a block selection delete the blocks (DR-rest-1)', () => {
	const keeping: Plugin = () => ({ onDeleteSelectedBlocks: ({ prevent }) => prevent() });
	const seed = () => [p('a'), p('b'), p('c')];
	const unchanged = ['paragraph "a"', 'paragraph "b"', 'paragraph "c"'];
	const selectAB = async (view: View) => {
		view.edytor.selection.selectBlocks(get(view, 'a'), get(view, 'b'));
		await flushDomUpdates();
	};
	const parentKid = (): JSONBlock[] => [
		{ id: 'P', type: 'paragraph', content: [{ text: 'parent' }], children: [p('K')] },
		p('c')
	];

	it.each([
		'deleteWordBackward',
		'deleteWordForward',
		'deleteSoftLineBackward',
		'deleteSoftLineForward',
		'deleteHardLineBackward',
		'deleteHardLineForward',
		'deleteEntireSoftLine',
		'deleteContent'
	])('a %s beforeinput runs the hook, keeps the blocks and reports refused', async (inputType) => {
		const view = await render([keeping], seed());
		await selectAB(view);
		await dispatchDomBeforeInput(view.editor, { inputType });
		expect(shape(view)).toEqual(unchanged);
		expect(status(view)).toBe('refused');
	});

	it.each([
		{ key: 'Backspace', altKey: true },
		{ key: 'Backspace', ctrlKey: true },
		{ key: 'Backspace', metaKey: true },
		{ key: 'Delete', altKey: true },
		{ key: 'Delete', ctrlKey: true },
		{ key: 'Delete', metaKey: true }
	])('the %o chord (no beforeinput: Firefox, WebKit) runs the hook', async (chord) => {
		const view = await render([keeping], seed());
		await selectAB(view);
		const { defaultPrevented } = await dispatchDomKeyDown(document, chord);
		expect(defaultPrevented).toBe(true);
		expect(shape(view)).toEqual(unchanged);
		expect(status(view)).toBe('refused');
	});

	it('without a hook, a word delete removes the blocks as Backspace does', async () => {
		const view = await render([], seed());
		await selectAB(view);
		await dispatchDomBeforeInput(view.editor, { inputType: 'deleteWordBackward' });
		expect(shape(view)).toEqual(['paragraph "c"']);
		expect(view.edytor.selection.selectedBlocks.size).toBe(0);
	});

	it('a selected parent alone: Alt+Backspace removes it and promotes its child, as Backspace does', async () => {
		for (const chord of [{ key: 'Backspace' }, { key: 'Backspace', altKey: true }]) {
			const view = await render([], parentKid());
			view.edytor.selection.selectBlocks(get(view, 'P'));
			await flushDomUpdates();
			await dispatchDomKeyDown(document, chord);
			expect(shape(view)).toEqual(['paragraph "K"', 'paragraph "c"']);
			document.body.innerHTML = '';
		}
	});

	it('a selected parent alone: a deleteSoftLineBackward beforeinput promotes its child', async () => {
		const view = await render([], parentKid());
		view.edytor.selection.selectBlocks(get(view, 'P'));
		await flushDomUpdates();
		await dispatchDomBeforeInput(view.editor, { inputType: 'deleteSoftLineBackward' });
		expect(shape(view)).toEqual(['paragraph "K"', 'paragraph "c"']);
	});

	it.each([
		{ key: 'Backspace', shiftKey: true },
		{ key: 'Delete', shiftKey: true }
	])(
		'the %o chord is left to the browser at its keydown (Shift+Delete is the Windows cut); its delete runs the hook',
		async (chord) => {
			const view = await render([keeping], seed());
			await selectAB(view);
			const { defaultPrevented } = await dispatchDomKeyDown(document, chord);
			expect(defaultPrevented).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 0));
			await flushDomUpdates();
			expect(shape(view)).toEqual(unchanged);
			expect(status(view)).toBe('refused');
		}
	);

	it('without a block selection Alt+Backspace stays the browser word delete', async () => {
		const view = await render([keeping], seed());
		view.edytor.selection.setAtTextOffset(get(view, 'a').firstText!, 1);
		await flushDomUpdates();
		const { defaultPrevented } = await dispatchDomKeyDown(document, {
			key: 'Backspace',
			altKey: true
		});
		expect(defaultPrevented).toBe(false);
		expect(shape(view)).toEqual(unchanged);
	});
});
