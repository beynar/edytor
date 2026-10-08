#!/usr/bin/env node
/**
 * What compacting stale blocks would give back (a measurement, not a
 * feature). Dev-only.
 *
 *   node bench/soak/compact.mjs [--replicas 8] [--edits 8000] [--seed 1]
 *     [--shares 0.25,0.5,0.75,1] [--out bench/results/soak-compact.json]
 *
 * Builds the soak's converged multi-writer document (`size.mjs`'s
 * `generate`), then, for each share of its blocks taken as stale (the
 * blocks least recently changed, by the replica edit that last touched
 * them), on a fresh copy of the document:
 *
 * 1. rewrites each stale block's content in place, one transaction: its
 *    text deleted, then the same runs inserted again with their marks
 *    (inline atoms kept where they are: a block holding one keeps its
 *    text around it as is);
 * 2. purges at a horizon of now (`crdt.doc.purge`): what the rewrite
 *    deleted goes, as the room's purge would once the horizon passes it.
 *
 * Reports the stored size (`encodeStateAsUpdateV2`, what the room's quota
 * counts, and gzipped, what it writes) against the document as it is, the
 * purge alone, and the same JSON seeded fresh (the floor), and checks that
 * every compaction keeps the document's JSON.
 */
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEngine } from './engine.mjs';
import { generate, measure } from './size.mjs';

const PURGE = Symbol('soak-compact-purge');
const MODE = process.argv.includes('--mode')
	? process.argv[process.argv.indexOf('--mode') + 1]
	: 'text';
const COMPACT = Symbol('soak-compact');

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	if (at === -1) return fallback;
	return typeof fallback === 'number' ? Number(args[at + 1]) : args[at + 1];
};
const config = {
	replicas: option('replicas', 8),
	edits: option('edits', 8000),
	seed: option('seed', 1),
	shares: option('shares', '0.25,0.5,0.75,1').split(',').map(Number)
};

const engine = await loadEngine();
const { E, Y, crdt } = engine;
const sizes = (doc) => {
	const v2 = Y.encodeStateAsUpdateV2(doc);
	return { stored: v2.length, gzipped: gzipSync(v2).length };
};

const { document, documents, converged, applied } = generate(engine, {
	replicas: config.replicas,
	edits: config.edits,
	seed: config.seed
});
const update = document.encode();

/** Every block id, deepest first within a parent, in document order. */
const blockIds = (facade) => facade.order();

/**
 * Staleness: the order blocks were last changed, from the struct clocks of
 * their text (a block's newest text item, by client and clock, is its last
 * edit); blocks with no text item rank oldest.
 */
const lastTouched = (doc, facade) => {
	const order = new Map();
	let tick = 0;
	// The update's structs in the order they were integrated approximate time:
	// walk every client's structs and number each block by its newest item.
	const stamps = [];
	for (const [client, structs] of doc.store.clients)
		for (const struct of structs)
			if (struct.content && !struct.deleted) stamps.push([client, struct]);
	for (const [, struct] of stamps) {
		for (let t = struct.parent; t; t = t._item?.parent) {
			const id = t._item?.parentSub;
			if (typeof id === 'string' && facade.hasBlock(id)) {
				order.set(id, Math.max(order.get(id) ?? 0, struct.id.clock + tick));
				break;
			}
		}
		tick += 0;
	}
	return order;
};

const compact = (share) => {
	const loaded = E.loadDocument(update, { semantics: E.defaultSemantics });
	try {
		const { doc, facade } = loaded;
		const json = JSON.stringify(facade.toJSON());
		const touched = lastTouched(doc, facade);
		const ids = blockIds(facade)
			.slice()
			.sort((a, b) => (touched.get(a) ?? -1) - (touched.get(b) ?? -1));
		const stale = ids.slice(0, Math.round(ids.length * share));
		let rewritten = 0;
		let skipped = 0;
		facade.transact(() => {
			for (const id of stale) {
				const items = facade.contentItems(id);
				if (!items.length) continue;
				if (items.some((item) => item.kind !== 'text')) {
					skipped++;
					continue;
				}
				if (MODE === 'text') {
					const length = facade.displayLength(id);
					if (!length) continue;
					facade.deleteText(id, 0, length);
					let at = 0;
					for (const item of items) {
						facade.insertText(id, at, item.text, item.marks);
						at += item.text.length;
					}
				} else if (MODE === 'reinsert') {
					// Upper bound of a fresh stream (measurement only: the id changes): a leaf
					// block deleted and inserted again where it stood, fresh.
					if (facade.childrenIds(id).length) {
						skipped++;
						continue;
					}
					const position = facade.positionOf(id);
					const type = facade.blockTypeOf(id);
					const data = facade.blockDataOf(id) ?? {};
					if (!position || !type) continue;
					facade.deleteBlock(id);
					const fresh = { id: `${id}~c`, type, data, content: items };
					if (facade.insertBlock(position, fresh).status !== 'applied') skipped++;
				} else {
					// The whole content replaced: `setBlock` writes it as new content.
					const result = facade.setBlock(id, { content: items });
					if (result.status !== 'applied') {
						skipped++;
						continue;
					}
				}
				rewritten++;
			}
		}, COMPACT);
		const strip = (text) => text.replace(/~c"/g, '"');
		const kept = strip(JSON.stringify(facade.toJSON())) === json;
		facade.transact(() => {
			crdt.doc.purge(doc, facade, { at: Date.now(), sv: Y.encodeStateVector(doc) });
		}, PURGE);
		const detail =
			share === 1 && process.argv.includes('--detail')
				? measure(engine, Y.encodeStateAsUpdate(doc)).bytesAfterPurge.top
				: undefined;
		return {
			share,
			stale: stale.length,
			rewritten,
			skipped,
			keptJson: kept,
			...sizes(doc),
			detail
		};
	} finally {
		loaded.destroy();
	}
};

const baseline = (() => {
	const loaded = E.loadDocument(update, { semantics: E.defaultSemantics });
	try {
		const { doc, facade } = loaded;
		const json = facade.toJSON();
		const asIs = sizes(doc);
		const fresh = E.createDocument({ value: json, semantics: E.defaultSemantics });
		const floor = sizes(fresh.doc);
		fresh.destroy();
		facade.transact(() => {
			crdt.doc.purge(doc, facade, { at: Date.now(), sv: Y.encodeStateVector(doc) });
		}, PURGE);
		return { blocks: facade.order().length, asIs, purged: sizes(doc), fresh: floor };
	} finally {
		loaded.destroy();
	}
})();

const results = config.shares.map(compact);
for (const d of documents) d.destroy();

const kb = (b) => `${(b / 1024).toFixed(1)} KiB`;
const pct = (b) => `${Math.round((1 - b / baseline.asIs.stored) * 100)}%`;
console.log(
	`${applied} edits, ${baseline.blocks} blocks, converged ${converged}\n` +
		`as is      ${kb(baseline.asIs.stored)} (gzip ${kb(baseline.asIs.gzipped)})\n` +
		`purge only ${kb(baseline.purged.stored)} (gzip ${kb(baseline.purged.gzipped)}), -${pct(baseline.purged.stored)}\n` +
		`fresh seed ${kb(baseline.fresh.stored)} (gzip ${kb(baseline.fresh.gzipped)}), -${pct(baseline.fresh.stored)} (the floor)`
);
for (const r of results)
	console.log(
		`compact ${Math.round(r.share * 100)}% stale: ${r.rewritten} rewritten, ${r.skipped} skipped (atoms); ${kb(r.stored)} (gzip ${kb(r.gzipped)}), -${pct(r.stored)}; JSON kept ${r.keptJson}`
	);
const out = option('out', fileURLToPath(new URL('../results/soak-compact.json', import.meta.url)));
mkdirSync(fileURLToPath(new URL('../results/', import.meta.url)), { recursive: true });
writeFileSync(out, JSON.stringify({ config, applied, converged, baseline, results }, null, '\t'));
console.log(`report: ${out}`);
