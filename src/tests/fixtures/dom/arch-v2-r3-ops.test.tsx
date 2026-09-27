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
 *   report naming only the touched blocks, and the command (document work, the
 *   view's patch) inside a jsdom budget. The key-to-frame time is measured in
 *   the browser (`tests/editor-dom/r3-ops.spec.ts`; jsdom's DOM removal is not
 *   the product's); the compare pass the row also counts is R6's.
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
 * projections inside a transaction, and the seam repairs it ran.
 */
const meter = (edytor: Edytor) => {
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
		stop() {
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

const now = () => performance.now();
/**
 * The command's budget in jsdom under the parallel lane (2–3× the browser's
 * cost); the row's < 100 ms key-to-frame bound is held in the browser
 * (`tests/editor-dom/r3-ops.spec.ts`).
 */
const JSDOM_BUDGET = 200;

describe('F-O5 (end to end) — 1,000 paragraphs through the mounted editor', () => {
	row(
		'range delete p0@1 → p999@1: one report, no whole-tree projection, command inside the budget',
		async () => {
			const { edytor } = await many(1000);
			const first = edytor.root!.children[0]!.firstText!;
			const last = edytor.root!.children[999]!.firstText!;
			await setNativeSelection(edytor, first, 1, last, 1);
			const m = meter(edytor);
			const t0 = now();
			const done = backspace(edytor);
			const ms = now() - t0;
			await done;
			m.stop();
			await flushDomUpdates();

			expect(texts(edytor)).toEqual(['paragraph 999']);
			expect(edytor.selection.state.startText?.stringContent).toBe('paragraph 999');
			expect(edytor.selection.state.yStart).toBe(1);
			expect(m.reports).toHaveLength(1);
			expect(m.projections).toBe(0);
			expect(ms).toBeLessThan(JSDOM_BUDGET);
		},
		60_000
	);

	row(
		'selected-block delete of 999 blocks: one report, no whole-tree projection, command inside the budget',
		async () => {
			const { edytor } = await many(1000);
			edytor.selection.selectBlocks(...edytor.root!.children.slice(1));
			await flushDomUpdates();
			const m = meter(edytor);
			const key = new KeyboardEvent('keydown', {
				key: 'Backspace',
				code: 'Backspace',
				bubbles: true,
				cancelable: true
			});
			const t0 = now();
			document.dispatchEvent(key);
			const ms = now() - t0;
			m.stop();
			await flushDomUpdates();

			expect(key.defaultPrevented).toBe(true);
			expect(texts(edytor)).toEqual(['paragraph 0']);
			expect(m.reports).toHaveLength(1);
			expect(m.projections).toBe(0);
			expect(ms).toBeLessThan(JSDOM_BUDGET);
		},
		60_000
	);

	row(
		'2,000 inserts in one transaction: one report naming one block, linear, no projection',
		async () => {
			const { edytor } = await many(1000);
			const text = edytor.root!.children[500]!.firstText!;
			// R4: text handles read the index's runs, which walk the block's
			// uncommitted items mid-transaction (the index's cost, D9/D12): the
			// view's own work is the time outside those reads.
			const { facade } = edytor;
			const runs = facade.runs;
			let indexReads = 0;
			facade.runs = (id) => {
				const t0 = now();
				try {
					return runs(id);
				} finally {
					indexReads += now() - t0;
				}
			};
			const run = (n: number, from: number) => {
				indexReads = 0;
				const t0 = now();
				edytor.transact(() => {
					for (let i = 0; i < n; i++)
						text.insertText({ value: 'x', start: from + i, end: from + i });
				});
				return now() - t0 - indexReads;
			};
			run(50, 0); // warm
			const m = meter(edytor);
			const small = run(500, 50);
			const large = run(2000, 550);
			m.stop();
			facade.runs = runs;
			await flushDomUpdates();

			expect(texts(edytor)[500]).toBe('x'.repeat(2550) + 'paragraph 500');
			expect(m.reports).toHaveLength(2);
			expect(m.reports.map(named)).toEqual([1, 1]);
			expect(m.projections).toBe(0);
			// Linear in transaction size: four times the inserts, about four
			// times the time (quadratic would be sixteen).
			expect(large).toBeLessThan(small * 8 + 20);
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
