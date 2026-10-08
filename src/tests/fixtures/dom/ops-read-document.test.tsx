/** @jsxImportSource ../../jsx */
/**
 * arch-v2 — checkpoint R3 rows (dom lane): operations stop calling
 * `flushMirror` (plan §2.4 "Render cells"; §4.4; §5 L16; §8 F-O5 and the
 * `sel.ride.*` rows of `docs/editor-delete-contract.md`; §9.3 R3).
 *
 * - F-O5 (end to end) — a range delete and a selected-block delete over 1,000
 *   paragraphs, and 2,000 inserts in one transaction, through the mounted
 *   editor: one change report per transaction, no whole-document projection
 *   while the command runs (operations read and write only the document), the
 *   report naming only the touched blocks, and the command's index work
 *   (folds, their input, recomputes, the view's reads) linear in what it
 *   touches: counted, never timed (CC-05). The key-to-frame time is measured
 *   in the browser (`tests/editor-dom/large-delete-linear-work.spec.ts`; jsdom's DOM removal is
 *   not the product's); the compare pass the row also counts is R6's.
 * - Operations never read the mirror mid-transaction: typing, Enter, a merge,
 *   a paste, Tab and a format each make one change report and no whole-tree
 *   projection (reader-runtime-model headline 1: 16 op sites ran a full
 *   `project()` + whole-tree reconcile inside the transaction).
 * - `sel.ride.insert` / `sel.ride.merge` with the mirror patched only at the
 *   commit: the caret rides several writes of one local transaction and a
 *   peer's merge; the seam repair runs once per commit, never per operation
 *   inside a transaction.
 *
 * Expected values come from the plan rows and the contract, never from
 * running the code.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { DocChange } from '$lib/crdt/index.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

/** Red on the reference (`arch-v2/ref-r3`); green since R3. */
const row = it;
/** Green on the reference: a regression guard. */
const pin = it;

/**
 * What one stretch of work cost the view: change reports, whole-document
 * projections inside a transaction, the seam repairs it ran, and the index's
 * work (`work`: its fold passes, their input, the blocks it recomputed).
 */
const meter = (edytor: Edytor) => {
	const { debug } = edytor.facade.runsView;
	const counted = () => ({
		folds: debug.folds,
		pairs: debug.foldedPairs,
		structs: debug.foldedStructs,
		recomputes: debug.recomputes
	});
	debug.reset();
	let work: ReturnType<typeof counted> | null = null;
	const reports: DocChange[] = [];
	const off = edytor.facade.onChange((change) => reports.push(change));
	let projections = 0;
	const project = edytor.facade.project;
	edytor.facade.project = ((...args: Parameters<typeof project>) => {
		// A whole-document projection inside a transaction: an operation read
		// the mirror mid-transaction (the test harness's cell comparison runs
		// between commands and is not counted).
		if (edytor.doc._transaction) projections++;
		return project(...args);
	}) as typeof project;
	let seams = 0;
	let inTransaction = 0;
	const selection = edytor.selection;
	const seam = selection.restoreDeadSelectionEndpoints;
	selection.restoreDeadSelectionEndpoints = ((...args: Parameters<typeof seam>) => {
		seams++;
		if (edytor.doc._transaction) inTransaction++;
		return seam(...args);
	}) as typeof seam;
	return {
		reports,
		get projections() {
			return projections;
		},
		get seams() {
			return seams;
		},
		/** Seam repairs run while a transaction was still open. */
		get seamsInTransaction() {
			return inTransaction;
		},
		get work() {
			return work ?? counted();
		},
		stop() {
			work = counted();
			off();
			edytor.facade.project = project;
			selection.restoreDeadSelectionEndpoints = seam;
		}
	};
};

const backspace = (edytor: Edytor) =>
	runBeforeInputCommand(
		edytor,
		attemptOf(edytor, {
			inputType: 'deleteContentBackward',
			data: null,
			dataTransfer: null,
			cancelable: true
		})
	);

const paragraphs = (n: number) => ({
	children: Array.from({ length: n }, (_, i) => ({
		id: `p${i}`,
		type: 'paragraph',
		content: [{ text: `paragraph ${i}` }]
	}))
});

const many = (n: number) =>
	renderDomEdytor(
		<root>
			<paragraph>x</paragraph>
		</root>,
		{ value: paragraphs(n), autoSelectFixture: false }
	);

const texts = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((b) =>
		(b.content ?? []).map((p) => ('text' in p ? p.text : '@')).join('')
	);

/** The ids one report names — the size of the view's patch. */
const named = (change: DocChange) =>
	new Set([
		...change.removed,
		...change.added.keys(),
		...change.content.keys(),
		...change.meta.keys(),
		...change.moved
	]).size;

/**
 * Ten times the blocks: the same number of folds and recomputes (only the
 * blocks the command keeps render again), at most eleven times the folds'
 * input (quadratic work would be a hundred times).
 */
const linear = (
	small: ReturnType<typeof meter>['work'],
	large: ReturnType<typeof meter>['work']
) => {
	expect(small.pairs).toBeGreaterThan(0);
	expect(large.folds, 'folds').toBeLessThanOrEqual(small.folds);
	expect(large.recomputes, 'recomputes').toBeLessThanOrEqual(small.recomputes);
	expect(large.pairs, 'folded pairs').toBeLessThanOrEqual(11 * small.pairs);
	expect(large.structs, 'folded structs').toBeLessThanOrEqual(11 * small.structs);
};

describe('F-O5 (end to end) — 1,000 paragraphs through the mounted editor', () => {
	/** `n` paragraphs; `keep` keeps the editor mounted (one editor answers the document's keys). */
	const rangeDelete = async (n: number, keep = false) => {
		const { edytor, unmount } = await many(n);
		const first = edytor.root!.children[0]!.firstText!;
		const last = edytor.root!.children[n - 1]!.firstText!;
		await setNativeSelection(edytor, first, 1, last, 1);
		const m = meter(edytor);
		await backspace(edytor);
		m.stop();
		await flushDomUpdates();

		expect(texts(edytor)).toEqual([`paragraph ${n - 1}`]);
		expect(edytor.selection.state.startText?.stringContent).toBe(`paragraph ${n - 1}`);
		expect(edytor.selection.state.yStart).toBe(1);
		if (!keep) unmount();
		return m;
	};

	row(
		'range delete p0@1 → p999@1: one report, no whole-tree projection, work linear in the blocks removed',
		async () => {
			const small = await rangeDelete(100);
			const m = await rangeDelete(1000, true);
			expect(m.reports).toHaveLength(1);
			// p1…p999 removed, the head's content (del.range.flat: the tail joins the head).
			expect(named(m.reports[0]!)).toBe(1000);
			expect(m.projections).toBe(0);
			linear(small.work, m.work);
		},
		60_000
	);

	const blockDelete = async (n: number, keep = false) => {
		const { edytor, unmount } = await many(n);
		edytor.selection.selectBlocks(...edytor.root!.children.slice(1));
		await flushDomUpdates();
		const m = meter(edytor);
		const key = new KeyboardEvent('keydown', {
			key: 'Backspace',
			code: 'Backspace',
			bubbles: true,
			cancelable: true
		});
		document.dispatchEvent(key);
		m.stop();
		await flushDomUpdates();

		expect(key.defaultPrevented).toBe(true);
		expect(texts(edytor)).toEqual(['paragraph 0']);
		if (!keep) unmount();
		return m;
	};

	row(
		'selected-block delete of 999 blocks: one report, no whole-tree projection, work linear in the blocks removed',
		async () => {
			const small = await blockDelete(100);
			const m = await blockDelete(1000, true);
			expect(m.reports).toHaveLength(1);
			// p1…p999 removed, nothing else.
			expect(named(m.reports[0]!)).toBe(999);
			expect(m.projections).toBe(0);
			linear(small.work, m.work);
		},
		60_000
	);

	row(
		'2,000 inserts in one transaction: one report naming one block, linear, no projection',
		async () => {
			const { edytor } = await many(1000);
			const text = edytor.root!.children[500]!.firstText!;
			// The view reads the index's runs once per insert at most: count them.
			const { facade } = edytor;
			const runs = facade.runs;
			let reads = 0;
			facade.runs = (id) => (reads++, runs(id));
			const run = (n: number, from: number) => {
				const m = meter(edytor);
				reads = 0;
				edytor.transact(() => {
					for (let i = 0; i < n; i++)
						text.insertText({ value: 'x', start: from + i, end: from + i });
				});
				m.stop();
				return { m, reads };
			};
			run(50, 0); // warm
			const small = run(500, 50);
			const large = run(2000, 550);
			facade.runs = runs;
			await flushDomUpdates();

			expect(texts(edytor)[500]).toBe('x'.repeat(2550) + 'paragraph 500');
			for (const { m } of [small, large]) {
				expect(m.reports).toHaveLength(1);
				expect(m.reports.map(named)).toEqual([1]);
				expect(m.projections).toBe(0);
			}
			// Linear in transaction size: four times the inserts, at most about
			// four times the reads and the folded writes (quadratic would be sixteen).
			expect(small.reads).toBeGreaterThan(0);
			expect(large.reads).toBeLessThanOrEqual(4 * small.reads + 8);
			expect(large.m.work.folds).toBeLessThanOrEqual(4 * small.m.work.folds + 8);
			expect(large.m.work.structs).toBeLessThanOrEqual(4 * small.m.work.structs + 8);
			expect(large.m.work.pairs).toBeLessThanOrEqual(4 * small.m.work.pairs + 8);
		},
		60_000
	);
});

describe('operations never read the mirror mid-transaction', () => {
	const fixture = () =>
		renderDomEdytor(
			<root>
				<paragraph>alpha</paragraph>
				<paragraph>be|ta</paragraph>
				<paragraph>gamma</paragraph>
			</root>
		);

	row('typing: one report, no whole-tree projection', async () => {
		const { edytor, editor } = await fixture();
		const m = meter(edytor);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'X' });
		m.stop();
		expect(texts(edytor)).toEqual(['alpha', 'beXta', 'gamma']);
		expect(m.reports).toHaveLength(1);
		expect(m.projections).toBe(0);
	});

	row('Enter (split): one report, no whole-tree projection, caret in the new block', async () => {
		const { edytor, editor } = await fixture();
		const m = meter(edytor);
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		m.stop();
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['alpha', 'be', 'ta', 'gamma']);
		expect(m.reports).toHaveLength(1);
		expect(m.projections).toBe(0);
		expect(edytor.selection.state.startText?.stringContent).toBe('ta');
		expect(edytor.selection.state.yStart).toBe(0);
	});

	row('Backspace at a block start (merge): one report, no projection', async () => {
		const { edytor, editor } = await fixture();
		await setNativeSelection(edytor, edytor.root!.children[1]!.firstText, 0);
		const m = meter(edytor);
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		m.stop();
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['alphabeta', 'gamma']);
		expect(m.reports).toHaveLength(1);
		expect(m.projections).toBe(0);
		expect(edytor.selection.state.startText?.stringContent).toBe('alphabeta');
		expect(edytor.selection.state.yStart).toBe(5);
	});

	row('a multi-line paste: one report, no projection, caret after the pasted text', async () => {
		const { edytor, editor } = await fixture();
		const m = meter(edytor);
		await dispatchDomBeforeInput(editor, {
			inputType: 'insertFromPaste',
			text: 'one\ntwo\nthree'
		});
		m.stop();
		await flushDomUpdates();
		expect(texts(edytor)).toEqual(['alpha', 'beone', 'two', 'threeta', 'gamma']);
		expect(m.reports).toHaveLength(1);
		expect(m.projections).toBe(0);
		expect(edytor.selection.state.startText?.stringContent).toBe('threeta');
		expect(edytor.selection.state.yStart).toBe(5);
	});

	row('Tab (nest): one report, no projection', async () => {
		const { edytor } = await fixture();
		const m = meter(edytor);
		await dispatchDomKeyDown(document, { key: 'Tab', code: 'Tab' });
		m.stop();
		await flushDomUpdates();
		expect(edytor.root!.children.map((b) => b.id)).toHaveLength(2);
		expect(edytor.root!.children[0]!.children[0]!.firstText?.stringContent).toBe('beta');
		expect(m.reports).toHaveLength(1);
		expect(m.projections).toBe(0);
	});

	pin('a format over a range: one report, no projection', async () => {
		const { edytor } = await fixture();
		const text = edytor.root!.children[0]!.firstText!;
		await setNativeSelection(edytor, text, 1, text, 4);
		const m = meter(edytor);
		text.markText({ mark: 'bold', start: 1, end: 4, toggle: true });
		m.stop();
		expect(edytor.value.children?.[0]?.content).toEqual([
			{ text: 'a' },
			{ text: 'lph', marks: { bold: true } },
			{ text: 'a' }
		]);
		expect(m.reports).toHaveLength(1);
		expect(m.projections).toBe(0);
	});
});

/** A peer on a replica of the mounted document; `push` delivers its writes. */
const peer = (edytor: Edytor) => {
	const remoteDoc = new Y.Doc();
	Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(edytor.doc));
	const remote = attachDocument(remoteDoc);
	return {
		facade: remote.facade,
		push: () =>
			Y.applyUpdate(edytor.doc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(edytor.doc)))
	};
};

describe('sel.ride.* with the mirror patched at the commit', () => {
	pin('sel.ride.insert: the caret rides every write of one local transaction', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello world</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const block = edytor.root!.children[0]!;
		await setNativeSelection(edytor, block.firstText, 5);
		const m = meter(edytor);
		edytor.transact(() => {
			block.firstText!.insertText({ value: 'A', start: 0, end: 0 });
			block.firstText!.insertText({ value: 'BC', start: 0, end: 0 });
		});
		m.stop();

		const { startText, yStart, isCollapsed } = edytor.selection.state;
		expect(texts(edytor)).toEqual(['BCAHello world']);
		expect(startText).toBe(edytor.root!.children[0]!.firstText);
		expect(startText?.stringContent).toBe('BCAHello world');
		expect([yStart, isCollapsed]).toEqual([8, true]);
		expect(m.reports).toHaveLength(1);
		expect(m.seamsInTransaction).toBe(0);
	});

	pin(
		'sel.ride.insert: a peer insert before the caret shifts it; at it, the caret stays',
		async () => {
			const { edytor } = await renderDomEdytor(
				<root>
					<paragraph>Hello world</paragraph>
				</root>,
				{ autoSelectFixture: false }
			);
			const block = edytor.root!.children[0]!;
			await setNativeSelection(edytor, block.firstText, 5);
			const remote = peer(edytor);
			remote.facade.insertText(block.id, 0, 'Say ');
			remote.facade.insertText(block.id, 9, 'X');
			remote.push();

			const { startText, yStart } = edytor.selection.state;
			expect(texts(edytor)).toEqual(['Say HelloX world']);
			expect(startText).toBe(edytor.root!.children[0]!.firstText);
			expect(yStart).toBe(9);
			await flushDomUpdates();
			expect(edytor.selection.state.yStart).toBe(9);
		}
	);

	pin('sel.ride.merge: a peer merges the caret block away; the caret lands at 5 + 2', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>alpha</paragraph>
				<paragraph>beta</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const [alpha, beta] = edytor.root!.children;
		await setNativeSelection(edytor, beta!.firstText, 2);
		const remote = peer(edytor);
		remote.facade.mergeBackward(beta!.id);
		remote.push();

		const { startText, yStart } = edytor.selection.state;
		expect(texts(edytor)).toEqual(['alphabeta']);
		expect(startText).toBe(alpha!.firstText);
		expect(yStart).toBe(7);
		await flushDomUpdates();
		expect(edytor.selection.state.startText?.stringContent).toBe('alphabeta');
		expect(edytor.selection.state.yStart).toBe(7);
	});

	row(
		'sel.ride.merge: a local merge and a write in one transaction; the seam runs once',
		async () => {
			const { edytor } = await renderDomEdytor(
				<root>
					<paragraph>alpha</paragraph>
					<paragraph>beta</paragraph>
				</root>,
				{ autoSelectFixture: false }
			);
			const [alpha, beta] = edytor.root!.children;
			await setNativeSelection(edytor, beta!.firstText, 2);
			const m = meter(edytor);
			edytor.transact(() => {
				beta!.mergeBlockBackward();
				alpha!.firstText!.insertText({ value: '>', start: 0, end: 0 });
			});
			m.stop();

			const { startText, yStart } = edytor.selection.state;
			expect(texts(edytor)).toEqual(['>alphabeta']);
			expect(startText).toBe(edytor.root!.children[0]!.firstText);
			expect(yStart).toBe(8);
			expect(m.reports).toHaveLength(1);
			expect(m.seamsInTransaction).toBe(0);
			expect(m.seams).toBeLessThanOrEqual(1);
		}
	);
});
