/** @jsxImportSource ../../jsx */
/**
 * Native text drag-move inside the editor (Notion, every text editor): a
 * selected text range dragged to another place in the editor moves there —
 * one command (`moveText`: its content placed at the drop point, as a paste
 * places a flow, then the range's deletion; both prepared before any write,
 * so hooks see every step and a refusal writes nothing), one undo step that gives both
 * back; the moved text keeps its marks and atoms, and is selected after the
 * drop. With Alt held at the drop, the text is copied and the range stays.
 * A drop inside the dragged range changes nothing; a readonly view takes no
 * drop. Block-handle drags are not text drags (`drop-beforeinput.spec.ts`,
 * the handles' rows). The browser's real drags are the Playwright rows
 * (`tests/editor-dom/text-drag.spec.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import {
	canonicalTree,
	findDomTextNode,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection,
	textNodeOf
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
	delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
});

const p = (id: string, text: string): JSONBlock => ({ id, type: 'paragraph', content: [{ text }] });

const mount = (children: JSONBlock[], options: { readonly?: boolean; plugins?: Plugin[] } = {}) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{
			plugins: [...(options.plugins ?? []), richTextPlugin],
			readonly: options.readonly,
			value: { children }
		}
	);

/** A DataTransfer as a browser hands one to the drag's events (jsdom has none). */
const transfer = () => {
	const data = new Map<string, string>();
	return {
		data,
		get types() {
			return [...data.keys()];
		},
		files: [] as File[],
		effectAllowed: 'all',
		dropEffect: 'none',
		getData: (type: string) => data.get(type) ?? '',
		setData: (type: string, value: string) => void data.set(type, value),
		clearData: () => data.clear()
	};
};

const dragEvent = (
	type: string,
	dataTransfer: ReturnType<typeof transfer>,
	init: { altKey?: boolean } = {}
) => {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		dataTransfer: { value: dataTransfer },
		clientX: { value: 1 },
		clientY: { value: 1 },
		altKey: { value: init.altKey ?? false }
	});
	return event as DragEvent;
};

type Point = { block: string; offset: number };

/** The DOM position of block offset `offset` in block `id`'s text. */
const domPoint = async (edytor: Edytor, { block, offset }: Point) => {
	const at = edytor.idToBlock.get(block)!.textAtOffset(offset)!;
	return findDomTextNode(await textNodeOf(at.text), at.offset);
};

/**
 * Select `from` to `to`, drag it from inside the range, drop it at `at`
 * (the browser's caret at the drop point). Answers whether the
 * `dragover` enabled the drop.
 */
const drag = async (
	view: Awaited<ReturnType<typeof mount>>,
	[from, to]: [Point, Point],
	at: Point,
	init: { altKey?: boolean } = {}
) => {
	const { edytor, editor } = view;
	const start = edytor.idToBlock.get(from.block)!.textAtOffset(from.offset)!;
	const end = edytor.idToBlock.get(to.block)!.textAtOffset(to.offset)!;
	await setNativeSelection(edytor, start.text, start.offset, end.text, end.offset);
	const source = (await domPoint(edytor, from)).node;
	const target = await domPoint(edytor, at);
	(document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint = () => {
		const range = document.createRange();
		range.setStart(target.node, target.offset);
		return range;
	};
	const data = transfer();
	source.dispatchEvent(dragEvent('dragstart', data));
	const over = dragEvent('dragover', data, init);
	editor.dispatchEvent(over);
	editor.dispatchEvent(dragEvent('drop', data, init));
	source.dispatchEvent(dragEvent('dragend', data));
	await flushDomUpdates();
	return { enabled: over.defaultPrevented, effect: data.dropEffect, data };
};

const texts = (edytor: Edytor) =>
	canonicalTree(edytor).map((block) =>
		(block.content ?? []).map((part) => ('text' in part ? part.text : `[${part.type}]`)).join('')
	);
const selected = (edytor: Edytor) => {
	const { startText, endText, yStart, yEnd, isCollapsed } = edytor.selection.state;
	if (!startText || !endText || isCollapsed) return null;
	return [
		{ block: startText.parent.id, offset: startText.segStart + yStart },
		{ block: endText.parent.id, offset: endText.segStart + yEnd }
	];
};

describe('dragging selected text moves it (one step)', () => {
	it('within a line: the text leaves its place for the drop point, then is selected', async () => {
		const view = await mount([p('a', 'one two three')]);
		const { enabled, effect } = await drag(
			view,
			[
				{ block: 'a', offset: 4 },
				{ block: 'a', offset: 8 }
			],
			{ block: 'a', offset: 13 }
		);
		expect(enabled).toBe(true);
		expect(effect).toBe('move');
		expect(texts(view.edytor)).toEqual(['one threetwo ']);
		expect(selected(view.edytor)).toEqual([
			{ block: 'a', offset: 9 },
			{ block: 'a', offset: 13 }
		]);
	});

	it('to another line, before the range: one undo gives both back', async () => {
		const view = await mount([p('a', 'alpha beta gamma'), p('b', 'delta epsilon')]);
		const steps = view.edytor.undoManager.undoStack.length;
		await drag(
			view,
			[
				{ block: 'b', offset: 6 },
				{ block: 'b', offset: 13 }
			],
			{ block: 'a', offset: 0 }
		);
		expect(texts(view.edytor)).toEqual(['epsilonalpha beta gamma', 'delta ']);
		expect(view.edytor.undoManager.undoStack.length).toBe(steps + 1);
		view.edytor.historyUndo();
		await flushDomUpdates();
		expect(texts(view.edytor)).toEqual(['alpha beta gamma', 'delta epsilon']);
	});

	it('keeps its marks and atoms', async () => {
		const view = await mount([
			{
				id: 'a',
				type: 'paragraph',
				content: [
					{ text: 'x ' },
					{ text: 'bold', marks: { bold: true } },
					{ type: 'widget', data: { n: 1 } },
					{ text: ' y' }
				]
			},
			p('b', 'end')
		]);
		await drag(
			view,
			[
				{ block: 'a', offset: 2 },
				{ block: 'a', offset: 7 }
			],
			{ block: 'b', offset: 3 }
		);
		expect(canonicalTree(view.edytor)).toEqual([
			{ type: 'paragraph', content: [{ text: 'x  y' }] },
			{
				type: 'paragraph',
				content: [
					{ text: 'end' },
					{ text: 'bold', marks: { bold: true } },
					{ type: 'widget', data: { n: 1 } }
				]
			}
		]);
	});

	it('a range across lines moves as lines: its first joins the drop point, its last the text after', async () => {
		const view = await mount([p('a', 'alpha beta gamma'), p('b', 'delta epsilon')]);
		await drag(
			view,
			[
				{ block: 'a', offset: 11 },
				{ block: 'b', offset: 5 }
			],
			{ block: 'a', offset: 0 }
		);
		expect(texts(view.edytor)).toEqual(['gamma', 'deltaalpha beta  epsilon']);
	});

	it('dropped inside the dragged range, nothing changes', async () => {
		const view = await mount([p('a', 'one two three')]);
		const steps = view.edytor.undoManager.undoStack.length;
		await drag(
			view,
			[
				{ block: 'a', offset: 4 },
				{ block: 'a', offset: 8 }
			],
			{ block: 'a', offset: 6 }
		);
		expect(texts(view.edytor)).toEqual(['one two three']);
		expect(view.edytor.undoManager.undoStack.length).toBe(steps);
		// The range stays selected (a press at its edge that the browser takes as a drag).
		expect(selected(view.edytor)).toEqual([
			{ block: 'a', offset: 4 },
			{ block: 'a', offset: 8 }
		]);
	});

	it('dropped at its own start, nothing changes and the range stays selected', async () => {
		const view = await mount([p('a', 'one two'), p('b', 'three four')]);
		await drag(
			view,
			[
				{ block: 'a', offset: 1 },
				{ block: 'b', offset: 3 }
			],
			{ block: 'a', offset: 1 }
		);
		expect(texts(view.edytor)).toEqual(['one two', 'three four']);
		expect(selected(view.edytor)).toEqual([
			{ block: 'a', offset: 1 },
			{ block: 'b', offset: 3 }
		]);
	});

	it('hooks see one moveText command; a veto keeps everything', async () => {
		const seen: string[] = [];
		const veto: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				seen.push(operation);
				if (operation === 'moveText') prevent();
			}
		});
		const view = await mount([p('a', 'one two three')], { plugins: [veto] });
		await drag(
			view,
			[
				{ block: 'a', offset: 0 },
				{ block: 'a', offset: 4 }
			],
			{ block: 'a', offset: 13 }
		);
		expect(seen).toContain('moveText');
		expect(texts(view.edytor)).toEqual(['one two three']);
	});

	it('hooks see its planned steps and effect before any write: the deletion and the placement', async () => {
		const seen: { operation: string; effect?: unknown; text: string[] }[] = [];
		let view: Awaited<ReturnType<typeof mount>> | undefined;
		const watch: Plugin = () => ({
			onBeforeOperation: (change) => {
				const { operation } = change;
				const effect = operation === 'moveText' ? change.effect : undefined;
				seen.push({ operation, effect, text: view ? texts(view.edytor) : [] });
			}
		});
		view = await mount([p('a', 'one two three')], { plugins: [watch] });
		seen.length = 0;
		await drag(
			view,
			[
				{ block: 'a', offset: 0 },
				{ block: 'a', offset: 4 }
			],
			{ block: 'a', offset: 13 }
		);
		const operations = seen.map((s) => s.operation);
		expect(operations[0]).toBe('moveText');
		expect(seen[0]!.effect).toBeDefined();
		expect(operations).toContain('deleteContentAtRange');
		expect(operations).toContain('insertText');
		// Every hook ran before the document changed.
		const steps = seen.slice(0, operations.lastIndexOf('insertText') + 1);
		for (const s of steps) expect(s.text).toEqual(['one two three']);
		expect(texts(view.edytor)).toEqual(['two threeone ']);
	});

	it('a veto of its deletion step keeps everything', async () => {
		const veto: Plugin = () => ({
			onBeforeOperation: ({ operation, prevent }) => {
				if (operation === 'deleteContentAtRange') prevent();
			}
		});
		const view = await mount([p('a', 'one two three')], { plugins: [veto] });
		const steps = view.edytor.undoManager.undoStack.length;
		await drag(
			view,
			[
				{ block: 'a', offset: 0 },
				{ block: 'a', offset: 4 }
			],
			{ block: 'a', offset: 13 }
		);
		expect(texts(view.edytor)).toEqual(['one two three']);
		expect(view.edytor.undoManager.undoStack.length).toBe(steps);
		expect(view.edytor.dispatcher.last).toMatchObject({ operation: 'moveText', status: 'refused' });
	});

	it('a drop the placement refuses writes nothing: the text stays', async () => {
		const view = await mount([p('a', 'one two three'), p('b', 'end')]);
		const { facade } = view.edytor;
		const real = facade.prepare.insertFlow;
		facade.prepare.insertFlow = (...args) => {
			const plan = real(...args);
			return 'writes' in plan ? { status: 'refused', ids: [] } : plan;
		};
		try {
			await drag(
				view,
				[
					{ block: 'a', offset: 0 },
					{ block: 'a', offset: 4 }
				],
				{ block: 'b', offset: 3 }
			);
		} finally {
			facade.prepare.insertFlow = real;
		}
		expect(texts(view.edytor)).toEqual(['one two three', 'end']);
		expect(view.edytor.dispatcher.last).toMatchObject({ operation: 'moveText', status: 'refused' });
	});
});

describe('Alt copies', () => {
	it('the range stays; a copy lands at the drop point, selected', async () => {
		const view = await mount([p('a', 'one two'), p('b', 'end')]);
		const { effect } = await drag(
			view,
			[
				{ block: 'a', offset: 0 },
				{ block: 'a', offset: 3 }
			],
			{ block: 'b', offset: 3 },
			{ altKey: true }
		);
		expect(effect).toBe('copy');
		expect(texts(view.edytor)).toEqual(['one two', 'endone']);
		expect(selected(view.edytor)).toEqual([
			{ block: 'b', offset: 3 },
			{ block: 'b', offset: 6 }
		]);
	});
});

describe('what is not a text move', () => {
	it('a readonly view takes no drop', async () => {
		const view = await mount([p('a', 'one two three')], { readonly: true });
		const { enabled } = await drag(
			view,
			[
				{ block: 'a', offset: 0 },
				{ block: 'a', offset: 4 }
			],
			{ block: 'a', offset: 13 }
		);
		expect(enabled).toBe(false);
		expect(texts(view.edytor)).toEqual(['one two three']);
	});

	it('a drag that starts outside the selected range is not a text drag', async () => {
		const view = await mount([p('a', 'one two three'), p('b', 'end')]);
		const { edytor, editor } = view;
		const text = edytor.idToBlock.get('a')!.textAtOffset(0)!;
		await setNativeSelection(edytor, text.text, 0, text.text, 3);
		// A draggable element of a block's own markup, outside the range.
		const other = (await domPoint(edytor, { block: 'b', offset: 1 })).node.parentElement!;
		const data = transfer();
		other.dispatchEvent(dragEvent('dragstart', data));
		expect(data.getData('text/plain')).toBe('');
		const over = dragEvent('dragover', data);
		editor.dispatchEvent(over);
		editor.dispatchEvent(dragEvent('drop', data));
		other.dispatchEvent(dragEvent('dragend', data));
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['one two three', 'end']);
	});

	it('the drag carries the range as a fragment, for another editor or app', async () => {
		const view = await mount([p('a', 'one two three')]);
		const { data } = await drag(
			view,
			[
				{ block: 'a', offset: 4 },
				{ block: 'a', offset: 7 }
			],
			{ block: 'a', offset: 5 }
		);
		expect(data.getData('text/plain')).toBe('two');
		expect(data.getData('application/x-edytor-fragment')).not.toBe('');
	});
});
