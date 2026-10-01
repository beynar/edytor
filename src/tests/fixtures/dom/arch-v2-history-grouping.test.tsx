/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — undo grouping must not depend on timing (R7, O31, D36; DST seeds 8
 * and 19, `cross-browser-history-divergence`). The policy table coalesces an
 * insertion with the step before it within `captureTimeout`; that window may
 * only fuse an insertion that CONTINUES the step: one that starts where the
 * step left this view's selection. An insertion after the caret moved — a
 * click, an arrow key, a foreign change adopted elsewhere — starts its own
 * step however soon it follows.
 *
 * - H-G1 — type `a` @5 of `hello world`, move the caret to @0, type `b`: two
 *   steps, whether `b` comes 100 ms or 900 ms after `a`; one undo removes
 *   only `b`.
 * - H-G2 — type `a` @5, move the caret to @0, then a foreign script rewrites
 *   the text (no input event, adopted by the observer): two steps at once
 *   and 900 ms later.
 * - H-G3 (guard) — typing `a` then `b` at the caret `a` left, at once:
 *   one step (typing still coalesces).
 * - H-G4 — type `a` @5, then a foreign script inserts `!` right at the caret
 *   `a` left (no input event: no occurrence owns it): the foreign change is
 *   its own step, at once and 900 ms later — only a user's own insertion
 *   continues a step.
 *
 * - H-G5 (UW-16) — type `a` @5, then a menu action on the block: Duplicate
 *   and Turn into (block menu), Turn into (toolbar), `+`, Remove (of the next
 *   block). The action is its own step, at once and 900 ms later: one undo
 *   leaves `helloa world` as it was typed. NW-06: `+` on an empty paragraph
 *   (it only types `/` there, opening the slash menu) is its own step too.
 * - H-G6 (UW-16) — a markdown or slash conversion inside the capture window
 *   is its own step: `say **b**` then undo gives the typed `say **b*` back as
 *   text, `## ` then undo a paragraph `##`, `hi /h2` + Enter then undo a
 *   paragraph `hi /h2`.
 * - H-G7 (UW-16) — block commands called directly (no user command around
 *   them) cut by the table, one step each; one `edytor.transact` around two
 *   of them is one step. NW-06: so do direct `markText`, `addChildBlock` and
 *   an atom's `patchData` (outside a user command only an insertion continues);
 *   `run('format')` around two `markText` calls is one step. RW-12: `run`
 *   with a kind the table does not list (`myConvert`) cuts like a bare
 *   operation: its `setBlock` after typing is its own step.
 *
 * The pause is simulated on the undo manager's clock: `lastChange` (a plain
 * field, plan §1.1) moves back by the pause; the rows themselves run well
 * inside `captureTimeout`.
 * Expected values come from the policy rows, never from running the code.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
import {
	canonicalTree,
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

/** `ms` pass on the undo manager's clock since its last change. */
const pause = (edytor: Edytor, ms: number) => {
	edytor.undoManager.lastChange -= ms;
};

const plainText = (edytor: Edytor) =>
	(edytor.value.children?.[0]?.content ?? [])
		.map((part) => ('text' in part ? part.text : '@'))
		.join('');

const mount = async () => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>hello| world</paragraph>
		</root>
	);
	rendered.edytor.undoManager.stopCapturing();
	return rendered;
};

/** A user places the caret (a pointer gesture, then the native selection). */
const click = async (edytor: Edytor, editor: HTMLElement, offset: number) => {
	editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
	await setNativeSelection(edytor, edytor.root!.children[0]!.firstText!, offset);
	await flushDomUpdates();
};

const type = async (editor: HTMLElement, data: string) => {
	await dispatchDomBeforeInput(editor, { inputType: 'insertText', data });
	await flushDomUpdates();
};

describe('undo grouping does not depend on timing (R7, O31)', () => {
	for (const ms of [0, 900]) {
		it(`H-G1: an insertion after the caret moved is its own step (${ms} ms later)`, async () => {
			const { edytor, editor } = await mount();
			await type(editor, 'a');
			expect(plainText(edytor)).toBe('helloa world');
			await click(edytor, editor, 0);
			pause(edytor, ms);
			await type(editor, 'b');
			expect(plainText(edytor)).toBe('bhelloa world');
			expect(edytor.undoManager.undoStack.length).toBe(2);
			edytor.historyUndo();
			await flushDomUpdates();
			expect(plainText(edytor)).toBe('helloa world');
		});

		it(`H-G2: a foreign change adopted after the caret moved is its own step (${ms} ms later)`, async () => {
			const { edytor, editor } = await mount();
			await type(editor, 'a');
			await click(edytor, editor, 0);
			pause(edytor, ms);
			const text = editor.querySelector('[data-edytor-text="true"]')!;
			const leaf = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode() as Text;
			leaf.data = `${leaf.data}!`;
			await flushDomUpdates();
			expect(plainText(edytor)).toBe('helloa world!');
			expect(edytor.undoManager.undoStack.length).toBe(2);
			edytor.historyUndo();
			await flushDomUpdates();
			expect(plainText(edytor)).toBe('helloa world');
		});
	}

	for (const ms of [0, 900]) {
		it(`H-G4: a foreign change at the caret typing left is its own step (${ms} ms later)`, async () => {
			const { edytor, editor } = await mount();
			await type(editor, 'a');
			pause(edytor, ms);
			const text = editor.querySelector('[data-edytor-text="true"]')!;
			const leaf = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode() as Text;
			leaf.data = `${leaf.data.slice(0, 6)}!${leaf.data.slice(6)}`;
			await flushDomUpdates();
			expect(plainText(edytor)).toBe('helloa! world');
			expect(edytor.undoManager.undoStack.length).toBe(2);
			edytor.historyUndo();
			await flushDomUpdates();
			expect(plainText(edytor)).toBe('helloa world');
		});
	}

	it('H-G3: typing at the caret the last insertion left coalesces', async () => {
		const { edytor, editor } = await mount();
		await type(editor, 'a');
		await type(editor, 'b');
		expect(plainText(edytor)).toBe('helloab world');
		expect(edytor.undoManager.undoStack.length).toBe(1);
	});
});

/** One block per line: its kind and its text. */
const blocks = (edytor: Edytor) =>
	canonicalTree(edytor).map(({ type, data, content }) => ({
		type,
		...(data && { data }),
		text: (content ?? []).map((part) => ('text' in part ? part.text : '@')).join('')
	}));

const press = async (element: Element) => {
	element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await flushDomUpdates();
};

const menuOn = async (edytor: Edytor, editor: HTMLElement, index: number) => {
	const block = edytor.root!.children[index]!;
	editor.dispatchEvent(
		new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor: block.node } })
	);
	await flushDomUpdates();
};

const turnInto = (label: string) =>
	[...document.querySelectorAll('[aria-label="Turn into"] button')].find(
		(button) => button.textContent === label
	)!;

const typed = { type: 'paragraph', text: 'helloa world' };
const next = { type: 'paragraph', text: 'two' };

/** Menu actions after typing `a` @5 of `hello world` (then `two`): the action alone, and what undo leaves. */
const actions: [string, (edytor: Edytor, editor: HTMLElement) => Promise<void>, unknown[]][] = [
	[
		'Duplicate (block menu)',
		async (edytor, editor) => {
			await menuOn(edytor, editor, 0);
			await press(document.querySelector('[data-testid="block-menu-duplicate"]')!);
		},
		[typed, typed, next]
	],
	[
		'Turn into (block menu)',
		async (edytor, editor) => {
			await menuOn(edytor, editor, 0);
			await press(document.querySelector('[data-testid="block-menu-turn"]')!);
			await press(turnInto('Heading 2'));
		},
		[{ type: 'heading', data: { level: 'h2' }, text: 'helloa world' }, next]
	],
	[
		'Turn into (toolbar)',
		async (edytor) => {
			const text = edytor.root!.children[0]!.firstText!;
			edytor.selection.setAtRange(text, 0, text, 6);
			await flushDomUpdates();
			await press(document.querySelector('.toolbar-type')!);
			await press(turnInto('Quote'));
		},
		[{ type: 'quote', text: 'helloa world' }, next]
	],
	[
		'+',
		async () => {
			await press(document.querySelector('[data-testid="block-add"]')!);
		},
		// No slash menu: the `+` adds the empty block at once.
		[typed, { type: 'paragraph', text: '' }, next]
	],
	[
		'Remove (block menu)',
		async (edytor, editor) => {
			await menuOn(edytor, editor, 1);
			await press(document.querySelector('[data-testid="block-menu-delete"]')!);
		},
		[typed]
	]
];

describe('a menu action after typing is its own step (UW-16)', () => {
	for (const [name, act, after] of actions)
		for (const ms of [0, 900]) {
			it(`H-G5: ${name} (${ms} ms later)`, async () => {
				const { edytor, editor } = await renderDomEdytor(
					<root>
						<paragraph>hello| world</paragraph>
						<paragraph>two</paragraph>
					</root>,
					{ plugins: [richTextPlugin, mentionPlugin, blockMenuPlugin, toolbarPlugin] }
				);
				edytor.undoManager.stopCapturing();
				await type(editor, 'a');
				pause(edytor, ms);
				await act(edytor, editor);
				expect(blocks(edytor)).toEqual(after);
				expect(edytor.undoManager.undoStack.length).toBe(2);
				edytor.historyUndo();
				await flushDomUpdates();
				expect(blocks(edytor)).toEqual([typed, next]);
				expect(edytor.undoManager.undoStack.length).toBe(1);
			});
		}
});

const conversions: Plugin[] = [
	richTextPlugin,
	mentionPlugin,
	markdownShortcutsPlugin,
	slashMenuPlugin
];

const typeAll = async (editor: HTMLElement, value: string) => {
	for (const data of value) await type(editor, data);
};

describe('`+` on an empty paragraph after typing is its own step (NW-06)', () => {
	for (const ms of [0, 900]) {
		it(`H-G5: + then a picked kind converts the empty paragraph as its own step (${ms} ms later)`, async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>hello| world</paragraph>
					<paragraph></paragraph>
				</root>,
				{ plugins: [richTextPlugin, mentionPlugin, blockMenuPlugin, slashMenuPlugin] }
			);
			edytor.undoManager.stopCapturing();
			await type(editor, 'a');
			pause(edytor, ms);
			await press(document.querySelectorAll('[data-testid="block-add"]')[1]!);
			// Nothing is added until a row is picked.
			expect(blocks(edytor)).toEqual([typed, { type: 'paragraph', text: '' }]);
			expect(edytor.undoManager.undoStack.length).toBe(1);
			const row = [...document.querySelectorAll('[data-testid="slash-menu-item"]')].find(
				(item) => item.textContent === 'Heading 1'
			)!;
			await press(row);
			expect(blocks(edytor)).toEqual([typed, { type: 'heading', data: { level: 'h1' }, text: '' }]);
			expect(edytor.undoManager.undoStack.length).toBe(2);
			edytor.historyUndo();
			await flushDomUpdates();
			expect(blocks(edytor)).toEqual([typed, { type: 'paragraph', text: '' }]);
			expect(edytor.undoManager.undoStack.length).toBe(1);
		});
	}
});

describe('a conversion inside the capture window is its own step (UW-16)', () => {
	const mountEmpty = async () => {
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: conversions }
		);
		rendered.edytor.undoManager.stopCapturing();
		return rendered;
	};

	it('H-G6: `say **b**` then undo gives the typed markers back as text', async () => {
		const { edytor, editor } = await mountEmpty();
		await typeAll(editor, 'say **b**');
		expect(canonicalTree(edytor)[0]!.content).toEqual([
			{ text: 'say ' },
			{ text: 'b', marks: { bold: true } }
		]);
		expect(edytor.undoManager.undoStack.length).toBe(2);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(blocks(edytor)).toEqual([{ type: 'paragraph', text: 'say **b*' }]);
		expect(edytor.undoManager.undoStack.length).toBe(1);
	});

	it('H-G6: `## ` then undo gives a paragraph `##`', async () => {
		const { edytor, editor } = await mountEmpty();
		await typeAll(editor, '## ');
		expect(blocks(edytor)).toEqual([{ type: 'heading', data: { level: 'h2' }, text: '' }]);
		expect(edytor.undoManager.undoStack.length).toBe(2);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(blocks(edytor)).toEqual([{ type: 'paragraph', text: '##' }]);
		expect(edytor.undoManager.undoStack.length).toBe(1);
	});

	it('H-G6: `hi /h2` + Enter then undo gives a paragraph `hi /h2`', async () => {
		const { edytor, editor } = await mountEmpty();
		await typeAll(editor, 'hi /h2');
		await dispatchDomKeyDown(editor, { key: 'Enter' });
		await flushDomUpdates();
		expect(blocks(edytor)).toEqual([{ type: 'heading', data: { level: 'h2' }, text: 'hi ' }]);
		expect(edytor.undoManager.undoStack.length).toBe(2);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(blocks(edytor)).toEqual([{ type: 'paragraph', text: 'hi /h2' }]);
		expect(edytor.undoManager.undoStack.length).toBe(1);
	});
});

describe('direct block commands follow the table (UW-16)', () => {
	it('H-G7: each is one step; one `edytor.transact` makes them one', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>hello| world</paragraph>
				<paragraph>two</paragraph>
			</root>
		);
		edytor.undoManager.stopCapturing();
		await type(editor, 'a');
		const [first, second] = edytor.root!.children;
		first!.insertBlockAfter({ block: { type: 'paragraph', content: [{ text: 'x' }] } });
		second!.removeBlock();
		expect(edytor.undoManager.undoStack.length).toBe(3);
		edytor.transact(() => {
			first!.insertBlockAfter({ block: { type: 'paragraph', content: [{ text: 'y' }] } });
			first!.setBlock({ value: { type: 'quote' } });
		});
		await flushDomUpdates();
		expect(blocks(edytor)).toEqual([
			{ type: 'quote', text: 'helloa world' },
			{ type: 'paragraph', text: 'y' },
			{ type: 'paragraph', text: 'x' }
		]);
		expect(edytor.undoManager.undoStack.length).toBe(4);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(blocks(edytor)).toEqual([typed, { type: 'paragraph', text: 'x' }]);
	});

	it('H-G7 (NW-06): direct markText, addChildBlock and an atom patchData each start a step', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>
					hello| world
					<mention />
				</paragraph>
			</root>
		);
		edytor.undoManager.stopCapturing();
		await type(editor, 'a');
		const block = edytor.root!.children[0]!;
		const atom = edytor.value.children![0]!.content!.find((part) => !('text' in part)) as {
			id: string;
		};
		block.firstText!.markText({ mark: 'bold', start: 0, end: 5 });
		expect(edytor.undoManager.undoStack.length).toBe(2);
		block.addChildBlock({ block: { type: 'paragraph', content: [{ text: 'c' }] }, index: 0 });
		expect(edytor.undoManager.undoStack.length).toBe(3);
		block.patchData({ atom: atom.id, ops: [{ path: ['name'], value: 'x' }] });
		expect(edytor.undoManager.undoStack.length).toBe(4);
		for (let i = 0; i < 3; i++) edytor.historyUndo();
		await flushDomUpdates();
		expect(canonicalTree(edytor)).toEqual([
			{
				type: 'paragraph',
				content: [{ text: 'helloa world' }, { type: 'mention', data: {} }]
			}
		]);
	});

	it('H-G7 (NW-06): `run("format")` around two markText calls is one step', async () => {
		const { edytor, editor } = await mount();
		await type(editor, 'a');
		const text = edytor.root!.children[0]!.firstText!;
		edytor.dispatcher.run('format', () => {
			text.markText({ mark: 'bold', start: 0, end: 2 });
			text.markText({ mark: 'italic', start: 3, end: 5 });
		});
		expect(edytor.undoManager.undoStack.length).toBe(2);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(canonicalTree(edytor)[0]!.content).toEqual([{ text: 'helloa world' }]);
	});

	it('H-G7 (RW-12): `run` with a kind the table does not list is its own step', async () => {
		const { edytor, editor } = await mount();
		await type(editor, 'a');
		const block = edytor.root!.children[0]!;
		edytor.dispatcher.run('myConvert', () => block.setBlock({ value: { type: 'quote' } }));
		expect(edytor.undoManager.undoStack.length).toBe(2);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(blocks(edytor)).toEqual([typed]);
	});
});
