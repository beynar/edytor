/**
 * A document's re-seed (`room.reseed.*`): the cut, and the rebase of an
 * offline client's edits, against the CRDT merge they would have had with
 * no re-seed.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument, loadDocument } from '../../../lib/crdt/index.js';
import type { EdytorDocument } from '../../../lib/crdt/document.js';
import {
	cutDocument,
	decodeCut,
	encodeCut,
	rebaseOnto,
	type Replica
} from '../../../lib/crdt/reseed.js';
import type { JSONDoc } from '../../../lib/utils/json.js';

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
const seed = (json: JSONDoc) => {
	const d = createDocument({ value: json, actor: { id: 'room' } });
	d.doc.clientID = 9000;
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
	const report = (epoch.doc as never as { transact: (f: () => unknown) => unknown }).transact(() =>
		rebaseOnto(epoch, decodeCut(encodeCut(cut)), s.offline.encode(), scratch)
	);
	return { want: oracle.toJSON(), got: epoch.facade.toJSON(), report };
};

describe('the cut (room.reseed.cut)', () => {
	it('seeds the same document with fresh identities, its attribution kept', () => {
		const s = setup(value('alpha', 'beta'));
		s.online.facade.insertText('b0', 5, '!');
		const { document, cut } = cutDocument(asReplica(s.online), seed);
		expect(document.facade.toJSON()).toEqual(s.online.toJSON());
		expect(document.facade.blockAttribution('b0')).toEqual(s.online.facade.blockAttribution('b0'));
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
});
