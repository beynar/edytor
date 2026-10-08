/**
 * Test-only renderer and id-map builders (UPSTREAM.md YP8).
 *
 * YP8 pruned the engine's concrete renderers (`AttributionsRenderer`,
 * `DiffRenderer`, `SnapshotRenderer`) and the content-id helpers edytor never
 * calls. The renderer PLUMBING stays (`useRenderer`, `toDelta({renderer})`,
 * `RangeCursor`'s renderer-aware splitting, `text/model.ts`'s `plain()`
 * guard), so the tests that prove edytor's behaviour under an active renderer
 * install this one: a port of upstream's `AttributionsRenderer` current-state
 * path (MIT, Kevin Jahns), side-correct like the retired patch YP6 — live items
 * read `inserts`, tombstones read `deletes`, a covered tombstone renders with
 * its length.
 */
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { AttributedContent } from '../../../lib/crdt/vendor/yjs/src/utils/renderer-helpers.js';

/** Every id range of every struct in `doc` (deleted and gc'd included). */
export const allIds = (doc) => {
	const set = Y.createIdSet();
	doc.store.clients.forEach((structs, client) => {
		const last = structs[structs.length - 1];
		set.add(client, structs[0].id.clock, last.id.clock + last.length - structs[0].id.clock);
	});
	return set;
};

/** An `IdMap` carrying `attrs` over every range of `set`. */
export const idMapOf = (set, attrs) => {
	const map = Y.createIdMap();
	set.forEach((r, client) => map.add(client, r.clock, r.len, attrs));
	return map;
};

/** `{inserts, deletes}` attributing every struct of `doc` now: inserts to `actor`, tombstones to `actor`. */
export const contentMapOfDoc = (doc, actor) =>
	Y.createContentMap(
		idMapOf(allIds(doc), [Y.createContentAttribute('insert', actor)]),
		idMapOf(Y.createDeleteSetFromStructStore(doc.store), [
			Y.createContentAttribute('delete', actor)
		])
	);

const pushPiece = (contents, c, clock, deleted, attrs, shouldRender) => {
	if (!deleted || attrs != null) {
		contents.push(new AttributedContent(c, clock, deleted, attrs, shouldRender));
	} else if (shouldRender !== 0 && shouldRender !== 3) {
		contents.push(new AttributedContent(c, clock, true, null, shouldRender));
	}
};

/** Current-state attribution renderer over a `ContentMap` (`{inserts, deletes}` IdMaps). */
export class ContentMapRenderer extends Y.AbstractRenderer {
	constructor({ inserts, deletes }) {
		super();
		this.inserts = inserts;
		this.deletes = deletes;
		// Ids that carry an attribution — `YEvent#getDelta` reads it.
		for (const m of [inserts, deletes])
			m.forEach((r, client) => this.attributed.add(client, r.clock, r.len));
	}

	hasItem(item) {
		const side = item.deleted ? this.deletes : this.inserts;
		return side.coveredLength(item.id.client, item.id.clock, item.length) > 0;
	}

	readContent(contents, client, clock, deleted, content, shouldRender) {
		const slice = (deleted ? this.deletes : this.inserts).slice(client, clock, content.getLength());
		let rest = slice.length === 1 ? content : content.copy();
		for (let i = 0; i < slice.length; i++) {
			const c = rest;
			if (i < slice.length - 1) rest = c.splice(slice[i].len);
			pushPiece(contents, c, slice[i].clock, deleted, slice[i].attrs, shouldRender);
		}
	}

	contentLength(item) {
		if (!item.content.isCountable()) return 0;
		const { client, clock } = item.id;
		return item.deleted ? this.deletes.coveredLength(client, clock, item.length) : item.length;
	}
}

/** The items of `node`'s list, tombstones and format items included (was `Y.getNodeChildren`). */
export const nodeItems = (node) => {
	const out = [];
	for (let s = node._start; s !== null; s = s.right) out.push(s);
	return out;
};
