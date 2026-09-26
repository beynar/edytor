/**
 * GATE H adversarial probes — R5 (commit-bound notifications).
 *
 * Pinned tests cover: mid-transaction reads, nested transactions,
 * multi-block commits, change-then-revert, remote+undo.
 *
 * Probed here:
 *
 *  1. A THROWING subscriber aborts flushPending mid-batch — pendingNotify
 *     was already cleared → the remaining blocks' notifications are
 *     dropped for this commit. With no further commit, subscribers stay
 *     stale forever.
 *
 *  2. Undo+repair flicker: the R3 repair runs on 'update' (AFTER
 *     observeDeep's handleEvent → flushPending). A subscriber therefore
 *     observes the UNREPAIRED resurrected state — the exact R3 bug shape —
 *     as a committed notification, then the repaired state. Two commits,
 *     two notifications — but the first carries wrong ownership.
 *
 *  3. Reentrancy: a listener that writes (new transaction) during publish
 *     — the nested commit's own flush must deliver committed state.
 *
 *  4. A subscriber attached mid-transaction gets the committed state.
 */
// @ts-nocheck -- exercises private internals on purpose.
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/index.js';

const E = bindEdytorDoc(Y);
let cid = 600_000;

const flatten = (runs: readonly { kind: string; text?: string }[]) =>
	runs.map((r) => (r.kind === 'text' ? r.text : `#${r.kind}`)).join('');

const seed2 = () => {
	const doc = new Y.Doc();
	doc.clientID = cid++;
	const ed = E.create(doc);
	ed.init({
		content: [
			{ id: 'a', type: 'paragraph', content: [{ kind: 'text', text: 'A' }] },
			{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'B' }] }
		]
	});
	return { doc, ed };
};

describe('gateH-R5 — throwing subscriber starves the rest of the flush batch', () => {
	test('a throwing listener drops later blocks’ notifications for that commit', () => {
		const { doc, ed } = seed2();
		const seenA: string[] = [];
		const seenB: string[] = [];
		let armed = true;
		ed.subscribeBlock('a', (runs) => {
			seenA.push(flatten(runs));
			if (armed) throw new Error('listener bug');
		});
		ed.subscribeBlock('b', (runs) => seenB.push(flatten(runs)));

		// One commit touching both blocks — 'a' publishes first (Map order),
		// its listener throws → 'b' never publishes this commit.
		let threw: unknown = null;
		try {
			ed.transact(() => {
				ed.insertText('a', 1, '1');
				ed.insertText('b', 1, '2');
			});
		} catch (e) {
			threw = e;
		}
		console.log(
			`[r5-throw] threw=${String(threw)} seenA=${JSON.stringify(seenA)} seenB=${JSON.stringify(seenB)}`
		);
		armed = false;
		// 'b' is stale: its subscriber still believes 'B' though the committed
		// state is 'B2' — and a later commit on 'a' does NOT republish it
		// (pendingNotify was cleared before the batch; 'b' is never re-dirtied).
		ed.insertText('a', 2, 'x'); // unrelated commit
		console.log(`[r5-throw] after-next-commit seenB=${JSON.stringify(seenB)}`);
		if (seenB.length === 0) {
			console.log('[r5-throw] CONFIRMED: block b subscriber permanently missed commit');
		}
		// CORRECT behavior: a throwing listener on 'a' must not drop 'b''s
		// committed notification. RED while pendingNotify clears before the
		// publish loop completes (runs.ts:1073-1076).
		expect(seenB, 'b subscriber never received its committed notification').toContain('B2');
	});

	test('a throwing FIRST listener starves LATER listeners of the same block', () => {
		const { ed } = seed2();
		const seen1: string[] = [];
		const seen2: string[] = [];
		let armed = true;
		ed.subscribeBlock('a', () => {
			seen1.push('x');
			if (armed) throw new Error('l1 bug');
		});
		ed.subscribeBlock('a', (runs) => seen2.push(flatten(runs)));
		try {
			ed.insertText('a', 1, '!');
		} catch {
			// listener failure surfaces here — the probe is what happens NEXT
		}
		armed = false;
		ed.insertText('a', 2, '?');
		console.log(`[r5-sameblock] seen1=${seen1.length} seen2=${JSON.stringify(seen2)}`);
		expect(seen2.length).toBeGreaterThan(0); // recovered on next commit
	});
});

describe('gateH-R5 — undo+repair notification shape', () => {
	test('subscriber observes the unrepaired intermediate after undo', () => {
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const ed = E.create(doc);
		ed.init({
			content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] }]
		});
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });

		const seenTail: string[] = [];
		const seenB: string[] = [];
		ed.subscribeBlock('tail', (runs) => seenTail.push(flatten(runs)));
		ed.subscribeBlock('b', (runs) => seenB.push(flatten(runs)));

		ed.block('tail').deleteText(0, 5);
		seenTail.length = 0;
		seenB.length = 0;
		um.undo();
		// Two commits (undo + repair) → each subscriber may see TWO
		// notifications, the FIRST carrying the broken ownership.
		console.log(`[r5-flicker] seenB=${JSON.stringify(seenB)} seenTail=${JSON.stringify(seenTail)}`);
		// Final state must be correct regardless.
		expect(ed.blockText('b')).toBe('hello ');
		expect(ed.blockText('tail')).toBe('world');
		// Report the intermediate shape.
		const flickered = seenB.includes('hello world') || seenTail.filter((s) => s === '').length > 0;
		console.log(`[r5-flicker] broken-intermediate-observed=${flickered}`);
	});
});

describe('gateH-R5 — reentrancy and mid-transaction subscription', () => {
	test('a listener that writes during publish does not corrupt the flush', () => {
		const { ed } = seed2();
		const seen: string[] = [];
		let fired = false;
		ed.subscribeBlock('a', (runs) => {
			seen.push(flatten(runs));
			if (!fired) {
				fired = true;
				// Reentrant write inside the notification — opens a new
				// transaction mid-flush (doc._transaction is null at cleanup).
				ed.insertText('b', 1, 'R');
			}
		});
		ed.insertText('a', 1, '1');
		console.log(`[r5-reentrant] seen=${JSON.stringify(seen)} b=${ed.blockText('b')}`);
		expect(ed.blockText('b')).toBe('BR');
		expect(seen[0]).toBe('A1');
	});

	test('subscribeBlock inside a transaction sees only committed state', () => {
		const { ed } = seed2();
		const seen: string[] = [];
		ed.transact(() => {
			ed.insertText('a', 1, 'X');
			ed.subscribeBlock('a', (runs) => seen.push(flatten(runs)));
			ed.insertText('a', 2, 'Y');
		});
		// The subscriber was primed mid-transaction at 'AX'; committed state
		// is 'AXY' — it must be notified once with the final state (or not at
		// all if 'AX' were the baseline-equal state — it is not).
		console.log(`[r5-midsub] seen=${JSON.stringify(seen)}`);
		expect(seen).toEqual(['AXY']);
	});
});

describe('gateH-R5 — DocChange surface during undo+repair', () => {
	test('onChange ordering around the repair transaction', () => {
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const ed = E.create(doc);
		ed.init({
			content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] }]
		});
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		const changes: {
			origin: string;
			local: boolean;
			added: string[];
			content: [string, string][];
		}[] = [];
		ed.onChange((c: any) =>
			changes.push({
				origin: String(c.origin),
				local: c.local,
				added: [...c.added.keys()],
				content: [...c.content.entries()].map(([k, v]: any) => [
					k,
					v.map((r: any) => (r.kind === 'text' ? r.text : '#')).join('')
				])
			})
		);
		ed.block('tail').deleteText(0, 5);
		changes.length = 0;
		um.undo();
		for (const [i, c] of changes.entries()) {
			console.log(
				`[r5-docchange] #${i} origin=${c.origin.slice(0, 40)} local=${c.local} added=${JSON.stringify(c.added)} content=${JSON.stringify(c.content)}`
			);
		}
		// Final state is correct either way — what matters is whether any
		// DocChange carried the unrepaired ownership or mislabeled origin.
		expect(ed.blockText('tail')).toBe('world');
	});
});
