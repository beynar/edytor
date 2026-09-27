/**
 * Test-side introspection of the production stream table (R2) — what the D11
 * spike's `view()` exposed, read from the document's own index: block records
 * (nonce, own text, claims), each backing text's live boundaries and streams,
 * each block's stream, the document order, and the facade's anchor codec.
 */
// @ts-nocheck -- drives the vendored engine JS directly (excluded lane).
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc, bindRuns } from '../../../lib/crdt/index.js';
import { isBoundary, scanText } from '../../../lib/crdt/text/model.js';

const R = bindRuns(Y);
const E = bindEdytorDoc(Y);

export const streamView = (doc) => {
	const v = R.attach(doc).view();
	const texts = new Map();
	const streams = new Map();
	for (const rec of v.blocks.values()) {
		if (!rec.content) continue;
		const row = scanText(rec.id, rec.content);
		const list = v.own.streamsIn(rec.id);
		texts.set(rec.content, { home: rec.id, bounds: row.bounds, streams: list, len: row.len });
		for (const s of list) streams.set(s.block, s);
	}
	return { blocks: v.blocks, own: v.own, order: v.order, texts, streams };
};

export const display = (v, id) => v.own.display(id);

const facades = new WeakMap();
const facadeOf = (doc) => {
	let f = facades.get(doc);
	if (f === undefined) facades.set(doc, (f = E.create(doc)));
	return f;
};

export const anchorAt = (doc, id, offset, side) => facadeOf(doc).anchorAt(id, offset, side);
export const resolveAnchor = (doc, anchor) => facadeOf(doc).resolveAnchor(anchor);
export const runs = (doc, id) => R.attach(doc).runs(id);

/**
 * The display owner of every live content unit of `home`'s text, in order
 * (boundary items skipped; `null` for a unit no displayed stream holds).
 */
export const contentOwners = (doc, home) => {
	const v = streamView(doc);
	const text = v.blocks.get(home)?.content;
	if (!text) return [];
	const out = [];
	let pos = 0;
	for (let it = text._start; it !== null; it = it.right) {
		if (it.deleted || !it.countable) continue;
		for (let j = 0; j < it.length; j++, pos++) {
			if (isBoundary(it.content.arr?.[j])) continue;
			const s = v.own.streamsIn(home).find((x) => x.start <= pos && pos < x.end);
			const owner = s === undefined ? null : v.own.ownerOf(s.block);
			out.push(typeof owner === 'string' ? owner : null);
		}
	}
	return out;
};
