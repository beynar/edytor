/**
 * Shared suggestions (`src/lib/crdt/doc/suggest.ts`, `sugg.*` in
 * `docs/editor-delete-contract.md`): a suggestion lives in the document, and
 * every replica sees and reviews it.
 *
 * Expected values come from the rules: an insertion is its writer's text,
 * a deletion an id list its writer wrote (YP31), a decision writes what
 * changes — the text that goes is the decider's hold, the text that stays a
 * settled id list.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument, loadDocument } from '../../../lib/crdt/index.js';
import type { EdytorDocument } from '../../../lib/crdt/document.js';
import type { SuggestedChange } from '../../../lib/crdt/doc/suggest.js';

const value = {
	children: [{ id: 'p1', type: 'paragraph', content: [{ text: 'The quick brown fox' }] }]
};
const peer = (actor: string, v: object = value) =>
	createDocument({ value: v, actor: { id: actor } });
/** Deliver everything `from` has that `to` lacks. */
const deliver = (from: EdytorDocument, to: EdytorDocument) =>
	Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), 'remote');
const meshSync = (...docs: EdytorDocument[]) => {
	for (const a of docs) for (const b of docs) if (a !== b) deliver(a, b);
};
const S = (d: EdytorDocument) => d.facade.suggest;
const text = (d: EdytorDocument, id = 'p1') => d.facade.blockText(id);
const insert = (d: EdytorDocument, s: string, offset: number, t: string, block = 'p1') =>
	S(d).apply(s, d.facade.prepare.insertText(block, offset, t)).result;
const erase = (d: EdytorDocument, s: string, offset: number, length: number, block = 'p1') =>
	S(d).apply(s, d.facade.prepare.deleteText(block, offset, length)).result;
const accept = (d: EdytorDocument, changes: readonly SuggestedChange[]) =>
	S(d).run(S(d).decide(changes, true));
const reject = (d: EdytorDocument, changes: readonly SuggestedChange[]) =>
	S(d).run(S(d).decide(changes, false));
/** The changes as a reviewer reads them: kind, text, author, offset. */
const review = (d: EdytorDocument) =>
	S(d)
		.changes()
		.map((c) => [
			c.kind,
			c.text,
			S(d)
				.records()
				.find((r) => r.id === c.suggestion)?.by,
			c.offset
		]);
const kinds = (d: EdytorDocument, kind: SuggestedChange['kind']) =>
	S(d)
		.changes()
		.filter((c) => c.kind === kind);

describe('shared suggestions (sugg.*)', () => {
	it('a suggestion is in the document: another replica reads it with its author; nothing is deleted yet', () => {
		const ana = peer('ana');
		const ben = peer('ben');
		const s = S(ana).open({ label: 'AI', via: 'ai' });
		insert(ana, s, 4, 'very ');
		erase(ana, s, 15, 6); // "brown "
		// As shown: the insertion shows, the deletion still shows (struck by the view).
		expect(text(ana)).toBe('The very quick brown fox');
		meshSync(ana, ben);
		expect(text(ben)).toBe('The very quick brown fox');
		expect(review(ben)).toEqual([
			['insert', 'very ', 'ana', 4],
			['delete', 'brown ', 'ana', 15]
		]);
		const [record] = S(ben).records();
		expect(record).toMatchObject({ id: s, by: 'ana', label: 'AI', via: 'ai' });
		// The writer is bound to its author like any replica, by itself.
		expect(ben.attribution.actorOf(record!.writer)).toBe('ana');
		// `toJSON` leaves the pending suggestions out; asked, it shows them.
		const plain = (d: EdytorDocument, o?: { suggestions: boolean }) =>
			(d.toJSON(o).children[0]!.content as { text: string }[]).map((t) => t.text).join('');
		expect(plain(ben)).toBe('The quick brown fox');
		expect(plain(ben, { suggestions: true })).toBe('The very quick brown fox');
	});

	it('accept the insertion, reject the deletion; concurrent typing inside both converges', () => {
		const ana = peer('ana');
		const ben = peer('ben');
		const cy = peer('cy');
		const s = S(ana).open();
		insert(ana, s, 4, 'very ');
		erase(ana, s, 15, 6);
		meshSync(ana, ben, cy);
		// Concurrently: ben types inside the insertion, cy inside the proposed
		// deletion, ana goes on suggesting at the end of her insertion.
		ben.facade.insertText('p1', 6, 'XX'); // "veXXry"
		cy.facade.insertText('p1', 18, 'YY'); // "broYYwn"
		insert(ana, s, 9, 'very ');
		meshSync(ana, ben, cy);
		const expected = 'The veXXry very quick broYYwn fox';
		for (const d of [ana, ben, cy]) expect(text(d)).toBe(expected);
		// The peers' text is theirs: never part of ana's insertion or deletion.
		for (const d of [ana, ben, cy])
			expect(review(d)).toEqual([
				['insert', 've', 'ana', 4],
				['insert', 'ry very ', 'ana', 8],
				['delete', 'bro', 'ana', 22],
				['delete', 'wn ', 'ana', 27]
			]);
		// ben accepts the insertion (both runs), cy rejects the deletion, concurrently.
		accept(ben, kinds(ben, 'insert'));
		reject(cy, kinds(cy, 'delete'));
		meshSync(ana, ben, cy);
		for (const d of [ana, ben, cy]) {
			expect(text(d)).toBe(expected);
			expect(review(d)).toEqual([]);
		}
	});

	it('two reviewers decide one change at once: the text that one of them takes goes (sugg.decide.concurrent)', () => {
		const ana = peer('ana');
		const ben = peer('ben');
		const cy = peer('cy');
		const s = S(ana).open();
		insert(ana, s, 4, 'very ');
		erase(ana, s, 15, 6);
		meshSync(ana, ben, cy);
		// The insertion: ben accepts (a settle), cy rejects (a hold): it goes.
		accept(ben, kinds(ben, 'insert'));
		reject(cy, kinds(cy, 'insert'));
		// The deletion: ben rejects (a settle), cy accepts (a hold): it goes.
		reject(ben, kinds(ben, 'delete'));
		accept(cy, kinds(cy, 'delete'));
		meshSync(ana, ben, cy);
		for (const d of [ana, ben, cy]) {
			expect(text(d)).toBe('The quick fox');
			expect(review(d)).toEqual([]);
		}
		// Each reviewer's own undo takes back only their step.
		cy.history.undo();
		expect(text(cy)).toBe('The very quick brown fox');
		expect(review(cy)).toEqual([]);
	});

	it('accepting a deletion holds exactly what the suggester saw: text typed inside it later stays', () => {
		const ana = peer('ana');
		const cy = peer('cy');
		const s = S(ana).open();
		erase(ana, s, 10, 6); // "brown "
		meshSync(ana, cy);
		cy.facade.insertText('p1', 13, 'YY'); // "broYYwn"
		meshSync(ana, cy);
		accept(ana, S(ana).changes());
		meshSync(ana, cy);
		for (const d of [ana, cy]) expect(text(d)).toBe('The quick YYfox');
	});

	it("rejecting an insertion hides only the suggester's text; a peer's text typed inside it stays", () => {
		const ana = peer('ana');
		const ben = peer('ben');
		const s = S(ana).open();
		insert(ana, s, 4, 'very ');
		meshSync(ana, ben);
		ben.facade.insertText('p1', 6, 'XX');
		meshSync(ana, ben);
		reject(ben, S(ben).changes());
		meshSync(ana, ben);
		for (const d of [ana, ben]) {
			expect(text(d)).toBe('The XXquick brown fox');
			expect(review(d)).toEqual([]);
		}
	});

	it('deleting its own pending text deletes it; deleting other text proposes', () => {
		const ana = peer('ana');
		const s = S(ana).open();
		insert(ana, s, 4, 'very ');
		// "ry q": its own "ry " goes, the "q" of the text it did not write is proposed.
		erase(ana, s, 6, 4);
		expect(text(ana)).toBe('The vequick brown fox');
		expect(review(ana)).toEqual([
			['insert', 've', 'ana', 4],
			['delete', 'q', 'ana', 6]
		]);
	});

	it('a reload keeps every suggestion and decision', () => {
		const ana = peer('ana');
		const s = S(ana).open({ label: 'AI' });
		insert(ana, s, 4, 'very ');
		erase(ana, s, 15, 6);
		accept(ana, [S(ana).changes()[0]!]);
		const again = loadDocument(ana.encode(), { actor: { id: 'ana' } });
		again.sync();
		expect(again.facade.blockText('p1')).toBe('The very quick brown fox');
		expect(review(again)).toEqual([['delete', 'brown ', 'ana', 15]]);
		expect(S(again).records()[0]).toMatchObject({ id: s, by: 'ana', label: 'AI' });
	});

	it("a suggestion over a suggestion: ben proposes deleting part of ana's insertion", () => {
		const ana = peer('ana');
		const ben = peer('ben');
		const s = S(ana).open();
		insert(ana, s, 4, 'very ');
		meshSync(ana, ben);
		const t = S(ben).open();
		erase(ben, t, 4, 2); // "ve" of ana's insertion
		meshSync(ana, ben);
		expect(review(ana)).toEqual([
			['insert', 'very ', 'ana', 4],
			['delete', 've', 'ben', 4]
		]);
		// Rejecting ana's insertion leaves ben's proposal nothing it names to show.
		reject(ana, kinds(ana, 'insert'));
		expect(text(ana)).toBe('The quick brown fox');
		expect(review(ana)).toEqual([]);
	});

	it('undo of an accept makes the change pending again (one step of the reviewer)', () => {
		const ana = peer('ana');
		const ben = peer('ben');
		const s = S(ana).open();
		erase(ana, s, 10, 6);
		meshSync(ana, ben);
		ben.history.stopCapturing();
		accept(ben, S(ben).changes());
		expect(text(ben)).toBe('The quick fox');
		ben.history.undo();
		expect(text(ben)).toBe('The quick brown fox');
		expect(review(ben)).toEqual([['delete', 'brown ', 'ana', 10]]);
		// An accepted insertion's undo too: the settled list goes, the text is pending again.
		const t = S(ana).open();
		insert(ana, t, 0, 'Oh, ');
		meshSync(ana, ben);
		ben.history.stopCapturing();
		accept(ben, kinds(ben, 'insert'));
		expect(kinds(ben, 'insert')).toEqual([]);
		ben.history.undo();
		expect(kinds(ben, 'insert').map((c) => c.text)).toEqual(['Oh, ']);
	});

	it("the suggester's own undo withdraws what it suggested; its redo suggests it again (sugg.history.writer)", () => {
		const ana = peer('ana');
		const s = S(ana).open();
		ana.history.stopCapturing();
		erase(ana, s, 10, 6);
		ana.history.stopCapturing();
		insert(ana, s, 4, 'very ');
		expect(
			S(ana)
				.changes()
				.map((c) => c.kind)
		).toEqual(['insert', 'delete']);
		ana.history.undo();
		expect(
			S(ana)
				.changes()
				.map((c) => c.kind)
		).toEqual(['delete']);
		ana.history.undo();
		expect(S(ana).changes()).toEqual([]);
		expect(text(ana)).toBe('The quick brown fox');
		// The redo writes under the writer again: still a proposal, never a decision.
		ana.history.redo();
		ana.history.redo();
		expect(review(ana)).toEqual([
			['insert', 'very ', 'ana', 4],
			['delete', 'brown ', 'ana', 15]
		]);
	});

	it('the author withdraws a suggestion: nothing of it is pending, the text is as before', () => {
		const ana = peer('ana');
		const s = S(ana).open();
		insert(ana, s, 4, 'very ');
		erase(ana, s, 15, 6);
		S(ana).withdraw(s, S(ana).records()[0]!.writer);
		expect(text(ana)).toBe('The quick brown fox');
		expect(S(ana).changes()).toEqual([]);
	});
});

describe('block suggestions (sugg.block.*)', () => {
	const two = {
		children: [
			{ id: 'p1', type: 'paragraph', content: [{ text: 'Hello world' }] },
			{ id: 'p2', type: 'paragraph', content: [{ text: 'Second' }] }
		]
	};
	const ids = (d: EdytorDocument, o?: { suggestions: boolean }) =>
		d.toJSON(o).children.map((b) => b.id);

	it('blocks an AI proposes are one change each: reject one, accept the other', () => {
		const ana = peer('ana');
		const ben = peer('ben');
		const s = S(ana).open({ label: 'AI', via: 'ai' });
		const plan = ana.facade.prepare.insertBlocks({ parent: null, index: 1 }, [
			{ id: 'h', type: 'heading', data: { level: 'h2' }, content: [{ text: 'Next steps' }] },
			{ id: 't', type: 'paragraph', content: [{ text: 'Book the review' }] }
		]);
		expect(S(ana).apply(s, plan).result.status).toBe('applied');
		meshSync(ana, ben);
		expect(review(ben)).toEqual([
			['block', 'Next steps', 'ana', 0],
			['block', 'Book the review', 'ana', 0]
		]);
		expect(ids(ben)).toEqual(['p1']);
		expect(ids(ben, { suggestions: true })).toEqual(['p1', 'h', 't']);
		const [heading, todo] = S(ben).changes();
		reject(ben, [heading!]);
		accept(ben, [todo!]);
		meshSync(ana, ben);
		for (const d of [ana, ben]) {
			expect(ids(d)).toEqual(['p1', 't']);
			expect(review(d)).toEqual([]);
		}
	});

	it('a split is a block of its own: rejected, the block joins the one it was split from', () => {
		const ana = peer('ana', two);
		const ben = peer('ben', two);
		const s = S(ana).open();
		const split = ana.facade.prepare.splitBlock('p1', 5, 'n1');
		expect(S(ana).apply(s, split).result.status).toBe('applied');
		insert(ana, s, 0, 'big ', 'n1');
		meshSync(ana, ben);
		expect(ids(ben, { suggestions: true })).toEqual(['p1', 'n1', 'p2']);
		expect(
			S(ben)
				.changes()
				.map((c) => [c.kind, c.block, c.text])
		).toEqual([['split', 'n1', 'big  world']]);
		// Without the suggestion: one block, its text as before.
		expect(ben.toJSON().children.map((b) => [b.id, b.content])).toEqual([
			['p1', [{ text: 'Hello world' }]],
			['p2', [{ text: 'Second' }]]
		]);
		reject(ben, S(ben).changes());
		meshSync(ana, ben);
		for (const d of [ana, ben]) {
			expect(ids(d, { suggestions: true })).toEqual(['p1', 'p2']);
			expect(text(d)).toBe('Hello world');
			expect(review(d)).toEqual([]);
		}
	});

	it('a merge, a retype, a data change or a format is refused, nothing written (sugg.refused)', () => {
		const ana = peer('ana', two);
		const s = S(ana).open();
		const before = ana.encode();
		const P = ana.facade.prepare;
		for (const plan of [
			P.setBlockType('p1', 'heading'),
			P.patchData('p1', [{ path: ['level'], value: 'h2' }]),
			P.formatRange('p1', 0, 5, { bold: true }),
			P.mergeBlocks('p2', 'p1'),
			P.moveBlocks(['p2'], { parent: null, index: 0 })
		])
			expect(S(ana).apply(s, plan).result).toMatchObject({
				status: 'refused',
				reason: 'suggesting'
			});
		expect(ana.encode()).toEqual(before);
		expect(review(ana)).toEqual([]);
	});

	it("on its author's own pending block they are written: a retype, a format, a merge back", () => {
		const ana = peer('ana', two);
		const s = S(ana).open();
		const P = ana.facade.prepare;
		S(ana).apply(s, P.splitBlock('p1', 5, 'n1'));
		insert(ana, s, 0, 'big', 'n1');
		for (const plan of [
			P.setBlockType('n1', 'heading'),
			P.formatRange('n1', 0, 3, { bold: true }),
			P.mergeBlocks('n1', 'p1')
		])
			expect(S(ana).apply(s, plan).result.status).toBe('applied');
		expect(ids(ana, { suggestions: true })).toEqual(['p1', 'p2']);
	});

	it('a block deletion that promotes children is proposed whole; accepted, they take its place', () => {
		const list = {
			children: [
				{
					id: 'l',
					type: 'bulletedList',
					content: [{ text: 'item' }],
					children: [{ id: 'c', type: 'bulletedList', content: [{ text: 'nested' }] }]
				}
			]
		};
		const ana = peer('ana', list);
		const before = ana.facade.prepare.deleteBlock('l');
		const s = S(ana).open();
		expect(S(ana).apply(s, before).result.status).toBe('applied');
		expect(ids(ana, { suggestions: true })).toEqual(['l']);
		expect(kinds(ana, 'remove').map((c) => c.block)).toEqual(['l']);
		accept(ana, S(ana).changes());
		expect(ids(ana)).toEqual(['c']);
		expect(S(ana).changes()).toEqual([]);
	});

	it('a block delete is proposed; rejected, the block stays and nothing is pending', () => {
		const ana = peer('ana', two);
		const s = S(ana).open();
		expect(S(ana).apply(s, ana.facade.prepare.deleteBlock('p2')).result.status).toBe('applied');
		expect(ids(ana)).toEqual(['p1', 'p2']);
		expect(
			S(ana)
				.changes()
				.map((c) => [c.kind, c.block, c.text])
		).toEqual([['remove', 'p2', 'Second']]);
		reject(ana, S(ana).changes());
		expect(ids(ana)).toEqual(['p1', 'p2']);
		expect(S(ana).changes()).toEqual([]);
		// Proposed again (a settled unit stays settled in its record: another one) and accepted: the block goes.
		S(ana).apply(S(ana).open(), ana.facade.prepare.deleteBlock('p2'));
		accept(ana, S(ana).changes());
		expect(ids(ana)).toEqual(['p1']);
	});
});

describe('AI suggestions (sugg.ai.*)', () => {
	it('a rewrite is a deletion and an insertion of one suggestion; streaming chunks reach the peer as they come', () => {
		const ana = peer('ana');
		const ben = peer('ben');
		const s = S(ana).open({ label: 'AI', via: 'ai' });
		erase(ana, s, 0, 19);
		meshSync(ana, ben);
		const answer = ['A fast', ' auburn', ' fox.'];
		let at = 19;
		for (const [i, chunk] of answer.entries()) {
			insert(ana, s, at, chunk);
			at += chunk.length;
			meshSync(ana, ben);
			// The peer sees the answer so far, as it streams.
			expect(kinds(ben, 'insert').map((c) => c.text)).toEqual([answer.slice(0, i + 1).join('')]);
		}
		expect(review(ben)).toEqual([
			['delete', 'The quick brown fox', 'ana', 0],
			['insert', 'A fast auburn fox.', 'ana', 19]
		]);
		accept(ben, S(ben).changes());
		meshSync(ana, ben);
		for (const d of [ana, ben]) expect(text(d)).toBe('A fast auburn fox.');
	});
});

describe('the cost of suggestions (sugg.scale)', () => {
	const doc = (blocks: number) =>
		peer('ana', {
			children: Array.from({ length: blocks }, (_, i) => ({
				id: `p${i}`,
				type: 'paragraph',
				content: [{ text: `block ${i} text` }]
			}))
		});
	/** The work one suggested keystroke and one proposed Backspace cost, read through the pending changes. */
	const keystroke = (blocks: number) => {
		const d = doc(blocks);
		const s = S(d).open();
		insert(d, s, 0, 'x', 'p1');
		void S(d).changes();
		const { debug } = S(d);
		const before = { ...debug };
		insert(d, s, 1, 'y', 'p1');
		void S(d).changes();
		erase(d, s, 3, 1, 'p1');
		void S(d).changes();
		return { computes: debug.computes - before.computes, units: debug.units - before.units };
	};

	it('a keystroke in a suggestion costs the same at 5,000 blocks as at 1,000', () => {
		expect(keystroke(5_000)).toEqual(keystroke(1_000));
	});

	it('a document with no suggestion reads nothing for them', () => {
		const d = doc(1_000);
		const { debug } = S(d);
		d.facade.insertText('p3', 0, 'hello');
		void S(d).changes();
		void d.toJSON();
		expect(debug).toEqual({ computes: 0, units: 0 });
	});
});

describe('stored bytes (printed for the design, `docs/archive/shared-suggestions/design.md` §9.3)', () => {
	const long = (n: number) => ({
		children: [{ id: 'p1', type: 'paragraph', content: [{ text: 'y'.repeat(n) }] }]
	});
	it('reports what a suggested character, a proposed deletion, a suggestion and a decision cost', () => {
		const rows: Record<string, unknown> = {};
		for (const n of [100, 1000]) {
			// Typed one by one at the end: plainly, and as one suggestion.
			const plain = peer('ana', long(10));
			const p0 = plain.encode().length;
			for (let i = 0; i < n; i++) plain.facade.insertText('p1', 10 + i, 'x');
			const sug = peer('ana', long(10));
			const s = S(sug).open({ at: 0 });
			const s0 = sug.encode().length;
			for (let i = 0; i < n; i++) insert(sug, s, 10 + i, 'x');
			// Backspaced one by one from the end: plainly, and proposed.
			const plainDel = peer('ana', long(n + 10));
			const d0 = plainDel.encode().length;
			for (let i = 0; i < n; i++) plainDel.facade.deleteText('p1', n + 9 - i, 1);
			const sugDel = peer('ana', long(n + 10));
			const t = S(sugDel).open({ at: 0 });
			const t0 = sugDel.encode().length;
			for (let i = 0; i < n; i++) erase(sugDel, t, n + 9 - i, 1);
			rows[`type ${n}`] = {
				plain: +((plain.encode().length - p0) / n).toFixed(3),
				suggested: +((sug.encode().length - s0) / n).toFixed(3)
			};
			rows[`backspace ${n}`] = {
				plain: +((plainDel.encode().length - d0) / n).toFixed(3),
				proposed: +((sugDel.encode().length - t0) / n).toFixed(3)
			};
		}
		// A suggestion's fixed cost: its first (record, binding, a new client), and another of the same writer.
		{
			const d = peer('ana', long(10));
			const b0 = d.encode().length;
			const s = S(d).open({ at: 0 });
			insert(d, s, 0, 'x');
			const first = d.encode().length - b0;
			const writer = S(d).records()[0]!.writer;
			const b1 = d.encode().length;
			const t = S(d).open({ at: 0, writer });
			insert(d, t, 5, 'x');
			rows.suggestion = { first: first - 1, another: d.encode().length - b1 - 1 };
		}
		// Decisions on a 1,000-character insertion and a 1,000-character deletion.
		{
			const d = peer('ana', long(1000));
			const s = S(d).open({ at: 0 });
			insert(d, s, 1000, 'x'.repeat(1000));
			erase(d, s, 0, 1000);
			const [del, ins] = S(d).changes();
			const at = (f: () => void) => {
				const before = d.encode().length;
				f();
				return d.encode().length - before;
			};
			const copy = () => loadDocument(d.encode(), { actor: { id: 'ben' } });
			const decide = (change: SuggestedChange, yes: boolean) => {
				const c = copy();
				c.sync();
				// The reviewer has written before: its binding is not the decision's.
				c.attribution.setProfile({ name: 'Ben' });
				const before = c.encode().length;
				S(c).run(
					S(c).decide(
						[
							S(c)
								.changes()
								.find((x) => x.kind === change.kind)!
						],
						yes
					)
				);
				return c.encode().length - before;
			};
			rows.decision = {
				acceptInsertion: decide(ins!, true),
				rejectInsertion: decide(ins!, false),
				acceptDeletion: decide(del!, true),
				rejectDeletion: decide(del!, false)
			};
			void at;
		}
		process.stdout.write(`\nSTORED ${JSON.stringify(rows)}\n`);
		expect(Object.keys(rows)).toHaveLength(6);
	});
});
