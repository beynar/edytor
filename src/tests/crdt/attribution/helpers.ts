/**
 * Shared probes for the U2 attribution tests — reach through the
 * document surface to the content node's item sequence, the actor
 * dictionary, and the bytes of any legacy `a/` records.
 */
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import type {
	CreateDocumentOptions,
	DocumentActor,
	EdytorDocument
} from '../../../lib/crdt/document.js';
import { createDocument } from '../../../lib/crdt/document.js';
import { SCHEMA_NAME, SCHEMA_VERSION } from '../../../lib/crdt/edytor-doc.js';
import { jsonBlockToSpec } from '../../../lib/utils/json.js';
import type { EngineDoc, EngineNode, YDoc } from '../../../lib/crdt/engine-api.js';
import type { JSONDoc } from '../../../lib/utils/json.js';
import { blockNodeOf } from '../../../lib/crdt/placement/model.js';

export const docValue = (text = 'hello'): JSONDoc => ({
	children: [{ type: 'paragraph', content: [{ text }] }]
});

export const firstBlock = (document: EdytorDocument) => document.facade.project().children[0]!;

/**
 * A document whose `value` content is authored by `actor` (createdBy,
 * contributors, lastChangedBy). The document's own seed carries no
 * attribution stamp (R13, §2.1 "Seeds", D-3), so authored fixture content
 * is inserted through the facade's attributed ops into a stamped doc, and
 * the document then hydrates it.
 */
export const authoredDocument = (
	value: JSONDoc,
	actor: DocumentActor,
	options: Omit<CreateDocumentOptions, 'actor' | 'value'> = {}
): EdytorDocument => {
	const document = createDocument({ ...options, actor });
	const meta = (document.doc as unknown as EngineDoc).get('meta');
	meta.setAttr('v', SCHEMA_VERSION);
	meta.setAttr('schema', SCHEMA_NAME);
	value.children.forEach((block, index) =>
		document.facade.insertBlock({ parent: null, index }, jsonBlockToSpec(block))
	);
	document.sync();
	return document;
};

/** The block's backing `content` node (physical sequence: atoms, markers, inlines). */
export const contentNodeOf = (document: EdytorDocument, blockId: string): EngineNode => {
	const block = blockNodeOf(document.doc as unknown as EngineDoc, blockId);
	if (block === null) throw new Error(`no block node for ${blockId}`);
	return block.getAttr('content') as EngineNode;
};

export type ItemLike = {
	id: { client: number; clock: number };
	length: number;
	deleted: boolean;
	countable: boolean;
	right: ItemLike | null;
};

/** Live sequence items of a content node, in order. */
export const itemsOf = (content: EngineNode): ItemLike[] => {
	const items: ItemLike[] = [];
	let it = (content as unknown as { _start: ItemLike | null })._start;
	while (it !== null) {
		if (it.countable && !it.deleted) items.push(it);
		it = it.right;
	}
	return items;
};

/** All record keys on the doc's attribution root matching `prefix` (default `a/`). */
export const recordKeys = (document: EdytorDocument, prefix = 'a/'): string[] => {
	const root = document.doc.get('attribution');
	const out: string[] = [];
	for (const key of root.attrKeys()) {
		if (key.startsWith(prefix)) out.push(key);
	}
	return out;
};

/** The bytes of the attribution record `key` (`undefined` when absent or not bytes). */
export const recordBytes = (document: EdytorDocument, key: string): Uint8Array | undefined => {
	const value = document.doc.get('attribution').getAttr(key);
	return value instanceof Uint8Array ? value : undefined;
};

/**
 * Write a legacy `a/` record the way a pre-U2 build's capture pipeline did:
 * an immutable byte payload under `a/<nonce>/<seq>` on the `attribution`
 * root. Nothing reads the payload any more (the engine's content-map codec
 * went with `attribution.legacy()`), so the tests stand in bytes of their
 * own ({@link legacyRecordFor}) and check they travel verbatim.
 */
export const writeLegacyRecord = (
	doc: YDoc,
	key: string,
	bytes: Uint8Array,
	origin: unknown = 'test-legacy'
): void => {
	doc.transact(() => {
		doc.get('attribution').setAttr(key, bytes);
	}, origin);
};

/** A stand-in legacy payload naming `actor` over `items` (an opaque byte string). */
export const legacyRecordFor = (
	items: readonly { id: { client: number; clock: number }; length: number }[],
	actor: string,
	side: 'inserts' | 'deletes' = 'inserts'
): Uint8Array =>
	new TextEncoder().encode(
		JSON.stringify({
			side,
			actor,
			items: items.map((it) => [it.id.client, it.id.clock, it.length])
		})
	);

/** Engine `applyUpdate` on a raw doc, under an explicit origin. */
export const applyUpdate = (doc: YDoc, update: Uint8Array, origin: unknown = 'test'): void => {
	Y.applyUpdate(doc, update, origin);
};

/**
 * Live-update wiring between two documents — each `update` is applied to
 * the peer under `conn` so an echo never re-applies. Returns the
 * unsubscribe; symmetric, deterministic, synchronous delivery.
 */
export const wireDocs = (a: EdytorDocument, b: EdytorDocument): (() => void) => {
	const conn = Symbol('conn');
	const fa = (u: Uint8Array, origin: unknown) => {
		if (origin !== conn) applyUpdate(b.doc, u, conn);
	};
	const fb = (u: Uint8Array, origin: unknown) => {
		if (origin !== conn) applyUpdate(a.doc, u, conn);
	};
	a.doc.on('update', fa);
	b.doc.on('update', fb);
	return () => {
		a.doc.off('update', fa);
		b.doc.off('update', fb);
	};
};
