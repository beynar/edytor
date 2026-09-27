/**
 * U8b probe — shared-backing fanout measurement.
 *
 * Replicates the browser bench `shared-100k-50blocks` fixture in Node:
 * one 100k-char formatted text split into 50 sibling blocks of ~2k chars
 * each (all siblings slice the SAME backing text). Per keystroke we count:
 *
 *   - `runsView.debug.recomputes` delta — run recomputes (flatten+readRange)
 *   - `runsView.debug.itemsWalked` delta — sequence items stepped over
 *   - `change.content.size` — blocks whose runs actually changed (Text
 *     wrappers that would re-render)
 *
 * Baseline comparator: 50 blocks × 2000 chars on SEPARATE backing texts.
 */
// @ts-nocheck -- probe: vendored engine is plain JS, structurally accessed.
import { describe, expect, it } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';

const E = bindEdytorDoc(Y);

const newDoc = (clientID = 7) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	return doc;
};

const sharedRun = (i) => ({
	kind: 'text',
	text: 'x'.repeat(200),
	marks:
		i % 4 === 0
			? { bold: true }
			: i % 4 === 1
				? { italic: true }
				: i % 4 === 2
					? { bold: true, italic: true }
					: undefined
});

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};

const summarize = (label, rows) => {
	const col = (k) => median(rows.map((r) => r[k]));
	console.log(
		`  ${label}: keystroke p50 ${col('ms').toFixed(3)}ms · recomputes ${col('recomputes')} · ` +
			`itemsWalked ${col('walked')} · docChangeContent ${col('rendered')}`
	);
};

/** Describe transaction.changed for diagnostics. */
const describeChanged = (tr) => {
	const out = [];
	for (const [type, subs] of tr.changed ?? []) {
		const item = type._item;
		out.push({
			name: type.name,
			parentSub: item?.parentSub ?? null,
			parentName: item?.parent?.name ?? null,
			subs: [...subs]
		});
	}
	return out;
};

const measureKeystrokes = (ed, doc, target, n = 24) => {
	const rows = [];
	let lastChange = null;
	const off = ed.onChange((c) => (lastChange = c));
	let off2 = 1000;
	for (let i = 0; i < n; i++) {
		const r0 = ed.runsView.debug.recomputes;
		const w0 = ed.runsView.debug.itemsWalked;
		const t0 = performance.now();
		ed.insertText(target, off2++, 'x');
		const ms = performance.now() - t0;
		rows.push({
			ms,
			recomputes: ed.runsView.debug.recomputes - r0,
			walked: ed.runsView.debug.itemsWalked - w0,
			rendered: lastChange?.content?.size ?? 0
		});
	}
	off();
	return rows;
};

describe('U8b shared-backing fanout', () => {
	it('shared backing: 50 blocks / 100k chars — keystroke fanout', () => {
		const doc = newDoc();
		E.init(doc, {
			content: [
				{
					id: 'b0',
					type: 'paragraph',
					content: Array.from({ length: 500 }, (_, i) => sharedRun(i))
				}
			]
		});
		const ed = E.create(doc);
		// split into 50 siblings × ~2000 chars on ONE backing text
		let head = 'b0';
		for (let s = 1; s < 50; s++) {
			expect(ed.splitBlock(head, 2000, `s${s}`).status).toBe('applied');
			head = `s${s}`;
		}
		const ids = ['b0', ...Array.from({ length: 49 }, (_, i) => `s${i + 1}`)];
		expect(ed.listBlockIds().length).toBe(50);
		// Prime the run cache for every block (mounted state).
		for (const id of ids) ed.runs(id);

		// Inspect what ONE keystroke writes (changed map + insertSet size).
		doc.transact((tr) => {
			ed.insertText('s25', 999, 'x');
			console.log('keystroke changed map:', JSON.stringify(describeChanged(tr)));
			console.log(
				'insertSet clients:',
				[...(tr.insertSet?.clients?.entries() ?? [])]
					.map(
						([c, r]) =>
							`${c}:${r
								.getIds()
								.map((x) => `${x.clock}+${x.len}`)
								.join(',')}`
					)
					.join(' ')
			);
			console.log(
				'deleteSet clients:',
				[...(tr.deleteSet?.clients?.entries() ?? [])]
					.map(
						([c, r]) =>
							`${c}:${r
								.getIds()
								.map((x) => `${x.clock}+${x.len}`)
								.join(',')}`
					)
					.join(' ')
			);
		});

		ed.runsView.debug.reset();
		const rows = measureKeystrokes(ed, doc, 's25');
		summarize('shared-100k-50blocks', rows);
		expect(rows.every((r) => r.rendered <= 2)).toBe(true);
	});

	it('separate backings: 50 blocks × 2000 chars — keystroke fanout (baseline)', () => {
		const doc = newDoc();
		E.init(doc, {
			content: Array.from({ length: 50 }, (_, b) => ({
				id: `b${b}`,
				type: 'paragraph',
				content: Array.from({ length: 10 }, (_, i) => sharedRun(i + b))
			}))
		});
		const ed = E.create(doc);
		for (const id of ed.listBlockIds()) ed.runs(id);
		ed.runsView.debug.reset();
		const rows = measureKeystrokes(ed, doc, 'b25');
		summarize('separate-50x2k', rows);
	});

	it('shared backing: formatRange fanout', () => {
		const doc = newDoc();
		E.init(doc, {
			content: [
				{
					id: 'b0',
					type: 'paragraph',
					content: Array.from({ length: 500 }, (_, i) => sharedRun(i))
				}
			]
		});
		const ed = E.create(doc);
		let head = 'b0';
		for (let s = 1; s < 50; s++) {
			ed.splitBlock(head, 2000, `s${s}`);
			head = `s${s}`;
		}
		for (const id of ed.listBlockIds()) ed.runs(id);
		doc.transact((tr) => {
			ed.formatRange('s10', 5, 25, { bold: true });
			console.log('formatRange changed map:', JSON.stringify(describeChanged(tr)));
		});
		ed.runsView.debug.reset();
		const rows = [];
		let lastChange = null;
		const off = ed.onChange((c) => (lastChange = c));
		for (let i = 0; i < 12; i++) {
			const r0 = ed.runsView.debug.recomputes;
			const w0 = ed.runsView.debug.itemsWalked;
			const t0 = performance.now();
			ed.formatRange('s10', 5, 25, { bold: i % 2 === 0 });
			const ms = performance.now() - t0;
			rows.push({
				ms,
				recomputes: ed.runsView.debug.recomputes - r0,
				walked: ed.runsView.debug.itemsWalked - w0,
				rendered: lastChange?.content?.size ?? 0
			});
		}
		off();
		summarize('shared-formatRange-s10', rows);
	});
});
