/**
 * A document's re-seed (`room.reseed.*`): the cut, and the rebase of an
 * offline client's edits, against the CRDT merge they would have had with
 * no re-seed.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument, loadDocument } from '../../../lib/crdt/index.js';
import type { EdytorDocument } from '../../../lib/crdt/document.js';
import { suggestionsOf, type SuggestFacade } from '../../../lib/crdt/doc/suggest.js';
import {
	cutDocument,
	decodeCut,
	decodeMerged,
	encodeCut,
	encodeMerged,
	rebaseOnto,
	type Merged,
	type Replica
} from '../../../lib/crdt/reseed.js';
import type { JSONDoc } from '../../../lib/utils/json.js';
import type { EngineDoc } from '../../../lib/crdt/engine-api.js';

const value = (...texts: string[]): JSONDoc => ({
	children: texts.map((text, i) => ({ id: `b${i}`, type: 'paragraph', content: [{ text }] }))
});

/** A document seeded with `json`, then two replicas of it: the offline one and the online one. */
const setup = (json: JSONDoc) => {
	const origin = createDocument({ value: json, actor: { id: 'seed' } });
	origin.doc.clientID = 500;
	const replica = (actor: string, clientID: number) => {
		const d = loadDocument(origin.encode(), { actor: { id: actor } });
		d.sync();
		d.doc.clientID = clientID;
		return d;
	};
	return { replica, offline: replica('ana', 1000), online: replica('ben', 2000) };
};

const asReplica = (d: EdytorDocument): Replica => ({
	doc: d.doc as never,
	facade: d.facade as never
});
// Each epoch's seed writes under a client id of its own, as the room's (a random one) does.
let seeds = 0;
const seed = (json: JSONDoc) => {
	const d = createDocument({ value: json, actor: { id: 'room' } });
	d.doc.clientID = 9000 + 10 * seeds++;
	return asReplica(d);
};
const scratch = (update: Uint8Array) => {
	const d = loadDocument(update, { actor: { id: 'room' } });
	d.sync();
	d.doc.clientID = 9001;
	return asReplica(d);
};

/** The texts of a document's blocks, by id. */
const texts = (json: JSONDoc) =>
	Object.fromEntries(
		json.children.map((b) => [
			b.id,
			(b.content ?? []).map((c) => ('text' in c ? c.text : '□')).join('')
		])
	);

/** What the CRDT gives when the two simply merge, and what the rebase gives after a re-seed at the online state. */
const both = (s: ReturnType<typeof setup>, after?: (epoch: Replica) => void) => {
	const oracle = s.replica('oracle', 4000);
	Y.applyUpdate(oracle.doc, s.online.encode(), 'remote');
	Y.applyUpdate(oracle.doc, s.offline.encode(), 'remote');
	const { document: epoch, cut } = cutDocument(asReplica(s.online), seed);
	after?.(epoch);
	const report = (epoch.doc as never as { transact: (f: () => unknown) => unknown }).transact(
		() => rebaseOnto(epoch, [decodeCut(encodeCut(cut))], s.offline.encode(), scratch).report
	);
	return { want: oracle.toJSON(), got: epoch.facade.toJSON(), report };
};

describe('the cut (room.reseed.cut)', () => {
	it('seeds the same document with fresh identities, its attribution kept', () => {
		const s = setup(value('alpha', 'beta'));
		s.online.attribution.setProfile({ name: 'Ben', color: '#c00' });
		// Typing and deleting leaves structure the content does not need.
		for (let i = 0; i < 20; i++) {
			s.online.facade.insertText('b1', 0, `word${i} `);
			s.online.facade.deleteText('b1', 0, `word${i} `.length);
		}
		s.online.facade.insertText('b0', 5, '!');
		const { document, cut } = cutDocument(asReplica(s.online), seed);
		expect(document.facade.toJSON()).toEqual(s.online.toJSON());
		expect(document.facade.blockAttribution('b0')).toEqual(s.online.facade.blockAttribution('b0'));
		// The actors' profiles (names, colors) come along.
		const profiles = (doc: unknown) => {
			const root = (doc as EngineDoc).get('attribution');
			return Object.fromEntries(
				[...root.attrKeys()].filter((k) => k.startsWith('u/')).map((k) => [k, root.getAttr(k)])
			);
		};
		expect(profiles(document.doc)).toMatchObject(profiles(s.online.doc));
		expect(Object.keys(profiles(s.online.doc))).toContain('u/ben');
		expect(Y.encodeStateAsUpdate(document.doc as never).byteLength).toBeLessThan(
			s.online.encode().byteLength
		);
		expect(decodeCut(encodeCut(cut))).toEqual(cut);
	});
});

describe('the rebase (room.reseed.rebase)', () => {
	it('has nothing to merge from a client that wrote nothing since the cut', () => {
		const s = setup(value('alpha'));
		s.online.facade.insertText('b0', 0, 'x');
		Y.applyUpdate(s.offline.doc, s.online.encode(), 'remote');
		expect(both(s).report).toEqual({ status: 'noop' });
	});

	it('merges offline typing and deleting with online typing in the same block', () => {
		const s = setup(value('the quick fox'));
		s.offline.facade.insertText('b0', 4, 'very ');
		s.offline.facade.deleteText('b0', 10, 3);
		s.online.facade.insertText('b0', 13, ' jumps');
		const { want, got } = both(s);
		expect(texts(got)).toEqual(texts(want));
	});

	it('repeated text: the deleted copy is the one each side deleted', () => {
		const s = setup(value('aa aa aa'));
		s.offline.facade.deleteText('b0', 0, 1);
		s.online.facade.deleteText('b0', 3, 1);
		s.online.facade.insertText('b0', 8, ' a');
		const { want, got } = both(s);
		expect(texts(got)).toEqual(texts(want));
	});

	it('online splits and merges keep the offline typing in its block', () => {
		const s = setup(value('first line', 'second line'));
		s.offline.facade.insertText('b0', 5, ' one');
		s.offline.facade.insertText('b1', 6, ' two');
		s.online.facade.splitBlock('b0', 5, 'n0');
		s.online.facade.mergeBackward('b1');
		const { want, got } = both(s);
		expect(texts(got)).toEqual(texts(want));
	});

	it('offline structure: a split, a new block and a delete', () => {
		const s = setup(value('alpha beta', 'gamma', 'delta'));
		s.offline.facade.splitBlock('b0', 5, 'n1');
		s.offline.facade.insertBlocks({ parent: null, index: 3 }, [
			{ id: 'n2', type: 'paragraph', content: [{ text: 'new' }] }
		]);
		s.offline.facade.deleteBlock('b2');
		s.online.facade.insertText('b1', 5, '!');
		const { want, got } = both(s);
		expect(got.children.map((b) => b.id)).toEqual(want.children.map((b) => b.id));
		expect(texts(got)).toEqual(texts(want));
	});

	it('online edits made after the cut stay', () => {
		const s = setup(value('alpha'));
		s.offline.facade.insertText('b0', 0, '>');
		const { got } = both(s, (epoch) => {
			epoch.facade.apply(epoch.facade.prepare.insertText('b0', 5, ' later'));
		});
		expect(texts(got)).toEqual({ b0: '>alpha later' });
	});

	it('a client offline since before the others wrote: only its own edits are new', () => {
		const s = setup(value('one', 'two'));
		s.online.facade.insertText('b1', 3, ' and three');
		s.offline.facade.insertText('b0', 3, '!');
		const { want, got } = both(s);
		expect(texts(got)).toEqual(texts(want));
	});

	it('a second upload of the same edits (another tab) merges nothing twice', () => {
		const s = setup(value('alpha'));
		s.offline.facade.insertText('b0', 5, ' beta');
		const { document: epoch, cut } = cutDocument(asReplica(s.online), seed);
		const tx = (f: () => unknown) =>
			(epoch.doc as never as { transact: (f: () => unknown) => unknown }).transact(f);
		let merged: ReturnType<typeof rebaseOnto>['merged'] | undefined;
		tx(() => (merged = rebaseOnto(epoch, [cut], s.offline.encode(), scratch).merged));
		let again: ReturnType<typeof rebaseOnto>['report'] | undefined;
		tx(() => (again = rebaseOnto(epoch, [cut], s.offline.encode(), scratch, merged).report));
		expect(again).toEqual({ status: 'noop' });
		expect(texts(epoch.facade.toJSON())).toEqual({ b0: 'alpha beta' });
	});

	it('a client two re-seeds behind: the cuts read down to its epoch', () => {
		const s = setup(value('one two'));
		s.offline.facade.insertText('b0', 3, ' and a half');
		s.online.facade.insertText('b0', 7, ' three');
		const first = cutDocument(asReplica(s.online), seed);
		first.document.facade.apply(first.document.facade.prepare.insertText('b0', 13, ' four'));
		const second = cutDocument(first.document, seed);
		const epoch = second.document;
		(epoch.doc as never as { transact: (f: () => unknown) => unknown }).transact(() =>
			rebaseOnto(epoch, [first.cut, second.cut], s.offline.encode(), scratch)
		);
		expect(texts(epoch.facade.toJSON())).toEqual({ b0: 'one and a half two three four' });
	});
});

/** Rebase `upload` onto `epoch` in one transaction: the report and what it merged. */
const rebase = (
	epoch: Replica,
	cuts: Parameters<typeof rebaseOnto>[1],
	upload: Uint8Array,
	merged?: Merged
) =>
	(epoch.doc as never as { transact: <R>(f: () => R) => R }).transact(() =>
		rebaseOnto(epoch, cuts, upload, scratch, merged && decodeMerged(encodeMerged(merged)))
	);
const pending = (r: Replica) =>
	suggestionsOf(r.facade as unknown as SuggestFacade).changes().length;

describe('what a rebase merges and drops (room.reseed.rebase, room.reseed.suggestions)', () => {
	it('pending suggestions at the cut: offline typing lands where it was typed', () => {
		const s = setup(value('The quick brown fox'));
		const shared = suggestionsOf(s.online.facade as unknown as SuggestFacade);
		shared.apply(
			shared.open({ label: 'AI', via: 'ai' }),
			s.online.facade.prepare.insertText('b0', 4, 'very ')
		);
		s.offline.facade.insertText('b0', 9, 'X');
		const { document: epoch, cut } = cutDocument(asReplica(s.online), seed);
		// The cut drops the pending suggestion, and reads its map from the same view.
		expect(texts(epoch.facade.toJSON())).toEqual({ b0: 'The quick brown fox' });
		rebase(epoch, [cut], s.offline.encode());
		expect(texts(epoch.facade.toJSON())).toEqual({ b0: 'The quickX brown fox' });
	});

	it("a client's pending suggestions are dropped, never accepted", () => {
		const s = setup(value('The quick brown fox'));
		const shared = suggestionsOf(s.offline.facade as unknown as SuggestFacade);
		const writer = shared.open({ label: 'AI', via: 'ai' });
		shared.apply(writer, s.offline.facade.prepare.insertText('b0', 4, 'very '));
		shared.apply(writer, s.offline.facade.prepare.deleteText('b0', 15, 4));
		s.offline.facade.insertText('b0', 0, '>');
		const { document: epoch, cut } = cutDocument(asReplica(s.online), seed);
		rebase(epoch, [cut], s.offline.encode());
		expect(texts(epoch.facade.toJSON({ suggestions: true }))).toEqual({
			b0: '>The quick brown fox'
		});
		expect(pending(epoch)).toBe(0);
	});

	it("offline data, marks and an atom's data reach the new epoch", () => {
		const s = setup({
			children: [
				{ id: 'b0', type: 'paragraph', content: [{ text: 'alpha beta' }] },
				{
					id: 'b1',
					type: 'paragraph',
					content: [
						{ text: 'hi ' },
						{ id: 'm1', type: 'mention', data: { u: 'x' } },
						{ text: ' there' }
					]
				}
			]
		} as JSONDoc);
		s.offline.facade.patchData('b0', [{ path: ['color'], value: 'red' }]);
		s.offline.facade.formatRange('b0', 0, 5, { bold: true });
		s.offline.facade.patchData({ block: 'b1', atom: 'm1' }, [{ path: ['u'], value: 'y' }]);
		const { want, got } = both(s);
		expect(got).toEqual(want);
	});

	it('a rebased insertion is written once', () => {
		const s = setup(value('alpha'));
		const typed = ' ' + 'x'.repeat(2000);
		s.offline.facade.insertText('b0', 5, typed);
		const { document: epoch, cut } = cutDocument(asReplica(s.online), seed);
		const sv = Y.encodeStateVector(epoch.doc as never);
		rebase(epoch, [cut], s.offline.encode());
		const { structs } = Y.decodeUpdate(Y.encodeStateAsUpdate(epoch.doc as never, sv));
		const written = structs.reduce((n, struct) => n + struct.length, 0);
		expect(texts(epoch.facade.toJSON())).toEqual({ b0: 'alpha' + typed });
		// The text once, and the block's attribution: never the text deleted and written again.
		expect(written).toBeLessThan(typed.length + 50);
	});

	it("a second tab's edits that build on the first tab's still find them", () => {
		const s = setup(value('alpha'));
		s.offline.facade.insertText('b0', 5, ' beta');
		// Another tab opened from the same local copy, typing after the first tab's text.
		const tab = loadDocument(s.offline.encode(), { actor: { id: 'ana' } });
		tab.sync();
		tab.doc.clientID = 1001;
		tab.facade.insertText('b0', 10, ' gamma');
		const { document: epoch, cut } = cutDocument(asReplica(s.online), seed);
		const first = rebase(epoch, [cut], s.offline.encode());
		const second = rebase(epoch, [cut], tab.encode(), first.merged);
		expect(second.report.status).toBe('applied');
		expect(texts(epoch.facade.toJSON())).toEqual({ b0: 'alpha beta gamma' });
	});

	it('and after another re-seed: the merged map reads down the cuts', () => {
		const s = setup(value('alpha'));
		s.offline.facade.insertText('b0', 5, ' beta');
		const tab = loadDocument(s.offline.encode(), { actor: { id: 'ana' } });
		tab.sync();
		tab.doc.clientID = 1001;
		tab.facade.insertText('b0', 10, ' gamma');
		const one = cutDocument(asReplica(s.online), seed);
		const first = rebase(one.document, [one.cut], s.offline.encode());
		const two = cutDocument(one.document, seed);
		rebase(two.document, [one.cut, two.cut], tab.encode(), first.merged);
		expect(texts(two.document.facade.toJSON())).toEqual({ b0: 'alpha beta gamma' });
	});

	/** Another device of the same user: its own replica of the document before the re-seed. */
	const device = (s: ReturnType<typeof setup>, clientID: number) => s.replica('ana', clientID);
	/** The CRDT's merge of `docs` with the online side: what the rebases must give. */
	const oracle = (s: ReturnType<typeof setup>, ...docs: EdytorDocument[]) => {
		const o = s.replica('oracle', 4000);
		for (const d of [s.online, ...docs]) Y.applyUpdate(o.doc, d.encode(), 'remote');
		return o.toJSON();
	};

	it("an atom whose data changed keeps its identity: another device's typing beside it stays beside it", () => {
		const s = setup({
			children: [
				{
					id: 'b0',
					type: 'paragraph',
					content: [
						{ text: 'hi ' },
						{ id: 'm1', type: 'mention', data: { u: 'x' } },
						{ text: ' there' }
					]
				}
			]
		} as JSONDoc);
		s.offline.facade.patchData({ block: 'b0', atom: 'm1' }, [{ path: ['u'], value: 'y' }]);
		const other = device(s, 1001);
		other.facade.insertText('b0', 4, 'Q');
		const { document: epoch, cut } = cutDocument(asReplica(s.online), seed);
		const first = rebase(epoch, [cut], s.offline.encode());
		rebase(epoch, [cut], other.encode(), first.merged);
		expect(epoch.facade.toJSON()).toEqual(oracle(s, s.offline, other));
	});

	it("a word deleted and typed again on one device: another device's typing after it stays after it", () => {
		const s = setup(value('say hello now'));
		s.offline.facade.deleteText('b0', 4, 5);
		s.offline.facade.insertText('b0', 4, 'hello');
		const other = device(s, 1001);
		other.facade.insertText('b0', 9, '!');
		const { document: epoch, cut } = cutDocument(asReplica(s.online), seed);
		const first = rebase(epoch, [cut], s.offline.encode());
		rebase(epoch, [cut], other.encode(), first.merged);
		expect(texts(epoch.facade.toJSON())).toEqual(texts(oracle(s, s.offline, other)));
	});

	it('text typed after the cut is written once into the shadow', () => {
		const s = setup(value('alpha'));
		s.offline.facade.insertText('b0', 0, '>');
		const { document: epoch, cut } = cutDocument(asReplica(s.online), seed);
		const later = ' ' + 'y'.repeat(500);
		epoch.facade.apply(epoch.facade.prepare.insertText('b0', 5, later));
		let shadow: Replica | undefined;
		(epoch.doc as never as { transact: <R>(f: () => R) => R }).transact(() =>
			rebaseOnto(epoch, [cut], s.offline.encode(), (update) => (shadow = scratch(update)))
		);
		const { structs } = Y.decodeUpdate(Y.encodeStateAsUpdate(shadow!.doc as never));
		const written = structs
			.filter((struct) => struct.id.client === 9001)
			.reduce((n, struct) => n + struct.length, 0);
		expect(texts(epoch.facade.toJSON())).toEqual({ b0: '>alpha' + later });
		expect(written).toBeLessThan(later.length + 50);
	});

	it('a character one side deleted and typed again, the other side deleted: the typed one stays', () => {
		const s = setup(value('abc'));
		s.online.facade.deleteText('b0', 1, 1);
		s.online.facade.insertText('b0', 1, 'b');
		s.offline.facade.deleteText('b0', 1, 1);
		const { want, got } = both(s);
		expect(texts(want)).toEqual({ b0: 'abc' });
		expect(texts(got)).toEqual(texts(want));
	});

	it('and typed again after the cut: the typed one stays', () => {
		const s = setup(value('abc'));
		s.offline.facade.deleteText('b0', 1, 1);
		const { got } = both(s, (epoch) => {
			epoch.facade.apply(epoch.facade.prepare.deleteText('b0', 1, 1));
			epoch.facade.apply(epoch.facade.prepare.insertText('b0', 1, 'b'));
		});
		expect(texts(got)).toEqual({ b0: 'abc' });
	});
});
