/**
 * arch-v2 — checkpoint S1 rows on the headless view (an `Edytor` over an
 * attached document, no DOM): the command dispatcher (R7, §4.3
 * `session/commands.ts`, D-10, FP-6).
 *
 * - F-M1 — `[a "aa", b "bb", c "cc", d "dd"]`, range a@1 → d@1, an after-hook
 *   throws: `[a "ad"]`, one undo step, the error surfaces.
 * - F-M2 — same range, an extension refuses the `removeBlock` step for `c`
 *   (old-style hook, matched by operation name): the whole range delete is
 *   refused before any write — document unchanged, zero bytes, no undo step.
 * - D-10 — a payload returned for a nested step is ignored with a dev warning;
 *   a payload returned for the command replaces it and the replacement is
 *   prepared again and shown to every hook; `prevent(() => …)` replaces the
 *   command (the view never sees a `PreventionError`); an extension replaces
 *   a command at most once.
 * - Readonly refuses every mutating command: zero writes, zero undo steps; a
 *   read-only document (`document.writable` false) refuses too, before any
 *   write, instead of throwing out of the write funnel.
 *
 * Expected values come from the plan rows, never from running the code.
 */
// @ts-nocheck -- tests drive the view through untyped fixtures.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDocument } from '../../../lib/crdt/index.js';
import { Edytor } from '../../../lib/edytor.svelte.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { PreventionError } from '$lib/utils.js';

/** A hook that throws its veto itself (a `PreventionError`) vetoes as `prevent` does. */
const prevent = (cb?: () => void): never => {
	throw new PreventionError(cb);
};

/** Red on the reference; green since S1. */
const row = test;
/** Green on the reference: a regression guard. */
const pin = test;

const p = (id: string, text: string) => ({ id, type: 'paragraph', content: [{ text }] });
const abcd = () => [p('a', 'aa'), p('b', 'bb'), p('c', 'cc'), p('d', 'dd')];

const view = (plugins = [], { readonly = false, children = abcd() } = {}) => {
	const document = createDocument({ value: { children } });
	const edytor = new Edytor({ document, plugins: [richTextPlugin, ...plugins], readonly });
	let bytes = 0;
	edytor.doc.on('update', (update: Uint8Array) => (bytes += update.byteLength));
	return { document, edytor, bytes: () => bytes, undo: () => document.history.undoStack.length };
};

const texts = (edytor: Edytor) =>
	edytor.facade.toJSON().children.map((b) => [b.id, (b.content ?? []).map((x) => x.text).join('')]);

const text = (edytor: Edytor, id: string) => edytor.idToBlock.get(id)!.firstText!;

/** Select a@1 → d@1 and delete it through the view op. */
const rangeDelete = (edytor: Edytor) =>
	edytor.deleteContentWithinSelection({
		selection: { startText: text(edytor, 'a'), yStart: 1, endText: text(edytor, 'd'), yEnd: 1 }
	});

const ORIGINAL = [
	['a', 'aa'],
	['b', 'bb'],
	['c', 'cc'],
	['d', 'dd']
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe('F-M1 — an after-hook throws', () => {
	pin('[a "ad"], one undo step, the error surfaces', () => {
		const { edytor, document, undo } = view([
			() => ({
				onAfterOperation: () => {
					throw new Error('after-hook failed');
				}
			})
		]);
		expect(() => rangeDelete(edytor)).toThrow('after-hook failed');
		expect(texts(edytor)).toEqual([['a', 'ad']]);
		expect(undo()).toBe(1);
		document.history.undo();
		expect(texts(edytor)).toEqual(ORIGINAL);
	});
});

describe('F-M2 — veto of a nested step', () => {
	row('refusing the removeBlock step for c refuses the whole range delete', () => {
		const { edytor, bytes, undo } = view([
			() => ({
				onBeforeOperation: ({ operation, block }) => {
					if (operation === 'removeBlock' && block.id === 'c') prevent();
				}
			})
		]);
		rangeDelete(edytor);
		expect(texts(edytor)).toEqual(ORIGINAL);
		expect(bytes()).toBe(0);
		expect(undo()).toBe(0);
		expect(edytor.dispatcher.last).toMatchObject({ status: 'refused' });
	});
});

describe('D-10 — hook semantics', () => {
	row('a payload returned for a nested step is ignored, with a dev warning', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { edytor } = view([
			() => ({
				onBeforeOperation: ({ operation, payload }) => {
					if (operation === 'removeBlock') return { ...payload, keepChildren: true };
				}
			})
		]);
		rangeDelete(edytor);
		expect(texts(edytor)).toEqual([['a', 'ad']]);
		expect(warn).toHaveBeenCalled();
		expect(String(warn.mock.calls[0][0])).toMatch(/nested/);
	});

	row('a replaced command is prepared again and shown to every hook', () => {
		const seen: unknown[] = [];
		const { edytor } = view([
			() => ({
				onBeforeOperation: ({ operation, payload }) => {
					if (operation === 'splitBlock' && payload.index === 1) return { ...payload, index: 0 };
				}
			}),
			() => ({
				onBeforeOperation: ({ operation, payload }) => {
					if (operation === 'splitBlock') seen.push(payload.index);
				}
			})
		]);
		const a = edytor.idToBlock.get('a')!;
		a.splitBlock({ index: 1, text: a.firstText! });
		// The split lands at the replaced offset, and the second hook saw the
		// replacement (the command it lets through), not the original.
		expect(texts(edytor)[0]).toEqual(['a', '']);
		expect(seen.at(-1)).toBe(0);
	});

	row('prevent(() => …) replaces the command: the caller sees no PreventionError', () => {
		const ran = vi.fn();
		const { edytor, bytes } = view([
			() => ({
				onBeforeOperation: ({ operation }) => {
					if (operation === 'splitBlock') prevent(ran);
				}
			})
		]);
		const a = edytor.idToBlock.get('a')!;
		expect(() => a.splitBlock({ index: 1, text: a.firstText! })).not.toThrow();
		expect(ran).toHaveBeenCalledTimes(1);
		expect(texts(edytor)).toEqual(ORIGINAL);
		expect(bytes()).toBe(0);
		expect(edytor.dispatcher.last).toMatchObject({ status: 'refused' });
	});

	row('an extension replaces a command at most once (no replacement loop)', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { edytor } = view([
			(editor) => ({
				onBeforeOperation: ({ operation, payload, text: t }) => {
					if (operation === 'insertText' && payload.value === 'x')
						prevent(() => t.insertText({ value: 'x', start: 0, end: 0 }));
				}
			})
		]);
		text(edytor, 'a').insertText({ value: 'x', start: 2, end: 2 });
		expect(texts(edytor)[0]).toEqual(['a', 'xaa']);
		expect(warn).toHaveBeenCalled();
	});
});

describe('readonly refuses every mutating command', () => {
	const blockOps = (edytor: Edytor) => {
		const [a, b, c] = ['a', 'b', 'c'].map((id) => edytor.idToBlock.get(id)!);
		const t = a.firstText!;
		a.addChildBlock({ block: { type: 'paragraph' }, index: 0 });
		a.addChildBlocks({ blocks: [{ type: 'paragraph' }], index: 0 });
		a.insertBlockAfter({ block: { type: 'paragraph' } });
		a.insertBlockBefore({ block: { type: 'paragraph' } });
		a.splitBlock({ index: 1, text: t });
		c.removeBlock({ keepChildren: false });
		b.nestBlock({});
		b.unNestBlock({});
		b.mergeBlockBackward({});
		b.mergeBlockForward({});
		a.setBlock({ value: { type: 'heading' } });
		a.moveBlock({ path: [2] });
		a.moveBlocks({ blocks: [a], path: [2] });
		a.deleteContentAtRange({ start: [0, 0], end: [0, 1] });
		a.addInlineBlock({ index: 1, text: t, block: { type: 'mention', data: {} } });
	};
	const textOps = (edytor: Edytor) => {
		const t = text(edytor, 'a');
		t.insertText({ value: 'x', start: 0, end: 0 });
		t.deleteText({ direction: 'FORWARD', length: 1 });
		t.setText({ value: [{ text: 'zz' }] });
		t.markText({ mark: 'bold', start: 0, end: 1 });
		t.removeMarksFromText({ start: 0, end: 1 });
	};
	const viewOps = (edytor: Edytor) => {
		rangeDelete(edytor);
		edytor.insertFlow({
			flow: { lines: [{ id: 'nx', content: [{ kind: 'text', text: 'x' }] }] },
			target: { block: 'a', offset: 0 }
		});
		edytor.moveBlocks({
			blocks: [edytor.idToBlock.get('a')!],
			target: edytor.idToBlock.get('c')!,
			position: 'after'
		});
	};

	pin('block operations: zero writes, zero undo steps', () => {
		const { edytor, bytes, undo } = view([], { readonly: true });
		blockOps(edytor);
		expect(texts(edytor)).toEqual(ORIGINAL);
		expect([bytes(), undo()]).toEqual([0, 0]);
	});

	row('text operations: zero writes, zero undo steps', () => {
		const { edytor, bytes, undo } = view([], { readonly: true });
		textOps(edytor);
		expect(texts(edytor)).toEqual(ORIGINAL);
		expect([bytes(), undo()]).toEqual([0, 0]);
	});

	pin('view operations (range delete, flow, relative move): zero writes, zero undo steps', () => {
		const { edytor, bytes, undo } = view([], { readonly: true });
		viewOps(edytor);
		expect(texts(edytor)).toEqual(ORIGINAL);
		expect([bytes(), undo()]).toEqual([0, 0]);
	});

	row('a read-only document (writable false) refuses before any write, without throwing', () => {
		const { edytor, document, undo } = view();
		document.doc.transact(() => document.doc.get('meta').setAttr('v', 99));
		expect(document.writable).toBe(false);
		let bytes = 0;
		edytor.doc.on('update', (update: Uint8Array) => (bytes += update.byteLength));
		expect(() => {
			blockOps(edytor);
			textOps(edytor);
			viewOps(edytor);
		}).not.toThrow();
		expect(texts(edytor)).toEqual(ORIGINAL);
		expect([bytes, undo()]).toEqual([0, 0]);
		expect(edytor.dispatcher.last).toMatchObject({ status: 'refused' });
	});
});
