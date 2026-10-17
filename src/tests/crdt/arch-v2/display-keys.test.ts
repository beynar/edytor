/**
 * The index's order keys are local to one replica (`placement/keys.ts`: a
 * key between a slot's sequence neighbours, minted when the slot is placed),
 * so a children list may compare keys of ONE key space only. A block shown
 * under its parent's claim owner — the parent merged away (`del.merge.*`),
 * or a child promoted out of a block deleted inside it
 * (`del.blocks.promote`) — is keyed in the owner's claimed space
 * (`claimedRank`: the owner's own children first, then by the claims down
 * to the block's parent), whatever the hops. Two replicas that folded the
 * same writes in different orders agree on the list; a key of the merged
 * block's sequence compared with the owner's own children's would not.
 *
 * Expected values come from the display rules, never from running code.
 */
// @ts-nocheck -- tests drive the vendored engine JS directly (excluded lane).
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { view as modelView } from '../../../lib/crdt/placement/model.js';
import { childrenIndex, displaySlotOf } from '../../../lib/crdt/placement/display.js';

const E = bindEdytorDoc(Y);
const p = (id: string, text: string, children?: unknown[]) => ({
	id,
	type: 'paragraph',
	content: [{ kind: 'text', text }],
	...(children ? { children } : {})
});
const make = (clientID: number) => {
	const doc = new Y.Doc();
	doc.clientID = clientID;
	const ed = E.create(doc, { actor: () => ({ id: 'alice' }) });
	return { doc, ed };
};
const kids = (doc, parent: string) => {
	const v = modelView(doc);
	return (childrenIndex(v.placements, v.own).get(parent) ?? []).map((s) => s.id);
};
const keyOf = (doc, id: string) => {
	const v = modelView(doc);
	return displaySlotOf(v.own, v.placements, v.placements.get(id), id);
};

describe('display keys: one key space per children list', () => {
	it('a child promoted out of a deleted block of a merged-away block follows the owner’s own children, on a replica fed in any order', () => {
		// O [b] and X [D [c]]; X merges into O (its children show after b), then D is
		// deleted: c takes D's place — under O, after b, on every replica.
		const { doc: a, ed } = make(7);
		const updates: Uint8Array[] = [];
		a.on('update', (u) => updates.push(u));
		ed.init({ content: [p('O', 'o', [p('b', 'b')]), p('X', 'x', [p('D', 'd', [p('c', 'c')])])] });
		expect(ed.apply(ed.prepare.mergeBlocks('X', 'O')).status).toBe('applied');
		expect(kids(a, 'O')).toEqual(['b', 'D']);
		expect(ed.apply(ed.prepare.deleteBlock('D', { keepChildren: true })).status).toBe('applied');
		expect(kids(a, 'O')).toEqual(['b', 'c']);
		// The promoted child is keyed in O's claimed space, like D was.
		expect(keyOf(a, 'c')).toMatchObject({ parent: 'O' });
		expect(keyOf(a, 'c').rank.startsWith('~')).toBe(true);
		expect(keyOf(a, 'b').rank < keyOf(a, 'c').rank).toBe(true);
		// A replica that takes the writes last first (each waits for its
		// dependencies, then all fold together) reads the same list.
		const b = new Y.Doc();
		b.clientID = 8;
		E.create(b, { actor: () => ({ id: 'bob' }) });
		for (const u of [...updates].reverse()) Y.applyUpdate(b, u, 'remote');
		expect(b.store.pendingStructs).toBeNull();
		expect(kids(b, 'O')).toEqual(['b', 'c']);
		expect(keyOf(b, 'c').rank.startsWith('~')).toBe(true);
		expect(Y.encodeStateVector(b)).toEqual(Y.encodeStateVector(a));
	});
});
