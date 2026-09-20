/**
 * Equivalent document models for the two engines under comparison.
 *
 * v14 (vendored, unmodified): `doc.get('content')` root `Y.Node`; a block is
 * `Y.Node('block')` with attrs `id`/`type` plus node-valued `content` (text +
 * inline atoms) and `children` (child blocks). Moves are expressed as a
 * *placement attribute update* (`placement = {parent, index}`) — the payload
 * is never re-encoded; this is the v14 primitive the plan's move design
 * targets (see docs/crdt-v14-implementation-plan.md §4 "Movement semantics").
 *
 * v13 (npm yjs@13.6.30): `doc.getArray('content')`; a block is `Y.Map` with
 * `content` `Y.Text` and `children` `Y.Array`. v13 has no placement concept —
 * moving is delete + reinsert of a deep copy (what the current editor does),
 * which re-encodes the whole payload and loses concurrent edits to it.
 */
import * as Y13 from 'yjs';
import * as Y14 from '../../src/lib/crdt/vendor/yjs/src/index.js';

export const ROOT = 'content';

// ── v14 ────────────────────────────────────────────────────────────────────

export const newDoc14 = () => new Y14.Doc();

export const insertBlock14 = (doc, parent, index, spec) => {
	doc.transact(() => {
		const block = new Y14.Node('block');
		block.setAttr('id', spec.id);
		block.setAttr('type', spec.type ?? 'paragraph');
		const content = new Y14.Node('content');
		const children = new Y14.Node('children');
		block.setAttr('content', content);
		block.setAttr('children', children);
		let clen = 0;
		for (const item of spec.content ?? []) {
			content.insert(clen, item.text, item.marks);
			clen += item.text.length;
		}
		const container = parent === null ? doc.get(ROOT) : parent.getAttr('children');
		container.insert(index, [block]);
	});
	return doc.get(ROOT).get(index) ?? null;
};

/** v14 placement-attribute move: an attribute write, payload untouched. */
export const moveByPlacement14 = (doc, block, dest) => {
	doc.transact(() => {
		block.setAttr('placement', dest);
	});
};

// ── v14 U03 placement model (mirrors src/lib/crdt/placement/model.ts) ────────
// The real model is TypeScript; this bench replicates its exact wire shape —
// what `writePlacement` emits — so the byte counts are faithful without a
// TS build step. Registry = doc.get('blocks'); each block node carries
// id/type/data/content/at; a move is ONE atomic `{p, r}` attr write under
// key `seq.clientID` on the block's `at` map, plus tombstoning of candidates
// below the top-2.

export const newPlacementDoc14 = () => new Y14.Doc();

export const insertModelBlock14 = (doc, spec) => {
	doc.transact(() => {
		const block = new Y14.Node('block');
		block.setAttr('id', spec.id);
		block.setAttr('type', spec.type ?? 'paragraph');
		const content = new Y14.Node('content');
		const slices = new Y14.Node('slices');
		const at = new Y14.Node('at');
		block.setAttr('content', content);
		block.setAttr('slices', slices);
		block.setAttr('at', at);
		let clen = 0;
		for (const item of spec.content ?? []) {
			content.insert(clen, item.text, item.marks);
			clen += item.text.length;
		}
		// U04: the block owns its whole backing text by default — B/E sentinels.
		slices.insert(0, [{ t: spec.id, s: { i: null, a: -1 }, e: { i: null, a: 0 } }]);
		at.setAttr(`1.${doc.clientID}`, { p: spec.parent ?? null, r: spec.rank ?? 'a0' });
		doc.get('blocks').setAttr(spec.id, block);
	});
	return doc.get('blocks').getAttr(spec.id);
};

/**
 * One real `moveBlock` placement write: seq = localMax+1, candidate kept
 * (top-2 compaction tombstones the rest — identical to `writePlacement`).
 */
export const moveByModel14 = (doc, id, dest, rank) => {
	const block = doc.get('blocks').getAttr(id);
	const at = block.getAttr('at');
	doc.transact(() => {
		let maxSeq = 0;
		const keys = [];
		at.forEachAttr((v, key) => {
			keys.push(key);
			const seq = Number(key.slice(0, key.indexOf('.')));
			if (seq > maxSeq) maxSeq = seq;
		});
		keys.sort((a, b) => {
			const [sa, ca] = a.split('.').map(Number);
			const [sb, cb] = b.split('.').map(Number);
			return sb - sa || cb - ca;
		});
		for (const k of keys.slice(2)) at.deleteAttr(k);
		at.setAttr(`${maxSeq + 1}.${doc.clientID}`, { p: dest.parent, r: rank });
	});
};

/**
 * U04 anchor encoding — the JSON form `splitSlices` writes into slice
 * records: B/E sentinels at the ends, `{i:{c,k},a}` bound to an item
 * otherwise (`createRelativePositionFromTypeIndex` + `relativePositionToJSON`,
 * mapped to the record's `{i:{c,k}|null,a}` shape).
 */
export const anchorAt14 = (content, index) => {
	if (index <= 0) return { i: null, a: -1 };
	if (index >= content.length) return { i: null, a: 0 };
	const rpos = Y14.createRelativePositionFromTypeIndex(content, index, 0);
	const json = Y14.relativePositionToJSON(rpos);
	return {
		i: json.item ? { c: json.item.client, k: json.item.clock } : null,
		a: json.assoc ?? 0
	};
};

/**
 * One real U04 `splitBlock` on a canonical block (single self-record):
 * tombstone the covering record, insert the anchored head record, create the
 * sibling with its materialized tail record + placement — the backing text
 * is NEVER re-encoded. Mirrors `splitSlices`/`splitBlock` in
 * src/lib/crdt for the common case (seam inside a plain self-slice).
 */
export const splitModelBlock14 = (doc, id, offset, newId, rank = 's1') => {
	const block = doc.get('blocks').getAttr(id);
	const content = block.getAttr('content');
	const slices = block.getAttr('slices');
	doc.transact(() => {
		const anchor = anchorAt14(content, offset);
		slices.delete(0, 1);
		slices.insert(0, [{ t: id, s: { i: null, a: -1 }, e: anchor }]);
		const sibling = new Y14.Node('block');
		sibling.setAttr('id', newId);
		sibling.setAttr('type', block.getAttr('type'));
		sibling.setAttr('content', new Y14.Node('content'));
		const sSlices = new Y14.Node('slices');
		sibling.setAttr('slices', sSlices);
		const sAt = new Y14.Node('at');
		sibling.setAttr('at', sAt);
		sSlices.insert(0, [{ t: id, s: anchor, e: { i: null, a: 0 }, g: 1 }]);
		sAt.setAttr(`1.${doc.clientID}`, { p: null, r: rank });
		doc.get('blocks').setAttr(newId, sibling);
	});
};

/**
 * One real U04 `mergeBlocks` on a childless source: ONE `{m:from}` claim item
 * appended to the destination's slice list — the source's atoms stay in its
 * backing text and are displayed through the live claim.
 */
export const mergeModelBlocks14 = (doc, fromId, intoId) => {
	const into = doc.get('blocks').getAttr(intoId);
	const slices = into.getAttr('slices');
	doc.transact(() => {
		slices.insert(slices.length, [{ m: fromId }]);
	});
};

/** Get the i-th top-level block node. */
export const blockAt14 = (doc, i) => {
	let found = null;
	let n = 0;
	doc.get(ROOT).forEach((c) => {
		if (n === i) found = c;
		n++;
	});
	return found;
};

// ── v13 ────────────────────────────────────────────────────────────────────

export const newDoc13 = () => new Y13.Doc();

export const insertBlock13 = (doc, index, spec) => {
	const root = doc.getArray(ROOT);
	doc.transact(() => {
		const block = new Y13.Map();
		block.set('id', spec.id);
		block.set('type', spec.type ?? 'paragraph');
		const content = new Y13.Text();
		let clen = 0;
		for (const item of spec.content ?? []) {
			content.insert(clen, item.text, item.marks);
			clen += item.text.length;
		}
		block.set('content', content);
		block.set('children', new Y13.Array());
		root.insert(index, [block]);
	});
};

/**
 * v13 copy-move: serialize the block to JSON, delete the original, rebuild a
 * fresh subtree at the destination. This is what today's editor effectively
 * does — the update re-encodes the payload and any concurrent edit to the
 * original is lost (NOT correctness-equivalent to a placement update).
 */
export const moveByCopy13 = (doc, fromIndex, toIndex) => {
	const root = doc.getArray(ROOT);
	doc.transact(() => {
		const spec = root.get(fromIndex).toJSON();
		root.delete(fromIndex, 1);
		const block = new Y13.Map();
		block.set('id', spec.id);
		block.set('type', spec.type);
		const content = new Y13.Text();
		content.insert(0, spec.content, spec.marks);
		block.set('content', content);
		block.set('children', new Y13.Array());
		root.insert(toIndex, [block]);
	});
};

/**
 * v13 copy-split: the tail text is copied into a fresh Y.Text on a new
 * Y.Map — re-encodes the whole tail (and loses concurrent edits to it).
 */
export const splitByCopy13 = (doc, index, offset, newId) => {
	const root = doc.getArray(ROOT);
	doc.transact(() => {
		const src = root.get(index);
		const content = src.get('content');
		const tail = content.toString().slice(offset);
		content.delete(offset, content.length - offset);
		const block = new Y13.Map();
		block.set('id', newId);
		block.set('type', src.get('type'));
		const t = new Y13.Text();
		t.insert(0, tail);
		block.set('content', t);
		block.set('children', new Y13.Array());
		root.insert(index + 1, [block]);
	});
};

/** v13 copy-merge: append the source text into the destination, drop the source. */
export const mergeByCopy13 = (doc, fromIndex, intoIndex) => {
	const root = doc.getArray(ROOT);
	doc.transact(() => {
		const from = root.get(fromIndex);
		const into = root.get(intoIndex);
		const t = into.get('content');
		t.insert(t.length, from.get('content').toString());
		root.delete(fromIndex, 1);
	});
};

/** Sum of update bytes emitted during `fn` — the replicated payload size. */
export const captureUpdateBytes = (doc, fn) => {
	let bytes = 0;
	const onUpdate = (update) => {
		bytes += update.byteLength;
	};
	doc.on('update', onUpdate);
	try {
		fn();
	} finally {
		doc.off('update', onUpdate);
	}
	return bytes;
};
