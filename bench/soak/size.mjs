#!/usr/bin/env node
/**
 * What a soak document's stored size is made of (WU-16). Dev-only.
 *
 *   node bench/soak/size.mjs [--replicas 8] [--edits 4000] [--mix soak|insert]
 *     [--without split,merge] [--sync 25] [--seed 1]
 *     [--out bench/results/soak-size-<mix>.json]
 *
 * In memory, no room: `--replicas` headless documents seeded with the
 * soak's document run `--edits` edits of the soak's mix (`edits.mjs`; the
 * `insert` mix only types; `--without` leaves edit kinds out), a random
 * replica each, and exchange what they
 * wrote every `--sync` edits. Then {@link measure} reads the converged
 * document as the room stores it (`encodeStateAsUpdateV2`, the size
 * `metrics().documentBytes` reports) against:
 *
 * - the same JSON seeded fresh (what the visible content costs);
 * - the document after the room's purge at a horizon of now
 *   (`crdt.doc.purge`, everything deleted so far past the horizon: the
 *   most a shorter `EDYTOR_PURGE_AFTER_DAYS` could give back);
 * - a census of its structs: items live and deleted, deleted items that
 *   still hold their content, map entries, clients.
 *
 * `run.mjs` runs {@link measure} on every soak's final document too
 * (`report.size`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEngine } from './engine.mjs';
import { Writer, prng, seedValue } from './edits.mjs';

/** The origin of the purge's transaction, tracked by no history (as the room's). */
const PURGE = Symbol('soak-size-purge');

/** The structs of `doc`, by kind, with their content kinds and lengths. */
const census = (doc) => {
	const out = {
		clients: doc.store.clients.size,
		structs: 0,
		gc: 0,
		items: { live: 0, deleted: 0, deletedKeepingContent: 0, mapEntries: 0, sequence: 0 },
		/** Per content kind: items and their summed length, live and deleted. */
		content: {},
		/** Live text items and the characters they hold. */
		text: { items: 0, chars: 0 },
		/** Map entries by key family (`d/` data leaves, `del.` delete marks, …), live and deleted. */
		keys: {}
	};
	for (const structs of doc.store.clients.values()) {
		for (const struct of structs) {
			out.structs++;
			const content = struct.content;
			if (!content) {
				out.gc++;
				continue;
			}
			const kind = content.constructor.name;
			const row = (out.content[kind] ??= { live: 0, deleted: 0, liveLength: 0, deletedLength: 0 });
			if (struct.deleted) {
				out.items.deleted++;
				row.deleted++;
				row.deletedLength += struct.length;
				if (kind !== 'ContentDeleted') out.items.deletedKeepingContent++;
			} else {
				out.items.live++;
				row.live++;
				row.liveLength += struct.length;
				if (kind === 'ContentString') {
					out.text.items++;
					out.text.chars += struct.length;
				}
			}
			if (struct.parentSub != null) {
				out.items.mapEntries++;
				const family = /^[^/.#~0-9]*[/.#~]?/.exec(struct.parentSub)[0] || struct.parentSub;
				const keys = (out.keys[family] ??= { live: 0, deleted: 0 });
				keys[struct.deleted ? 'deleted' : 'live']++;
			} else out.items.sequence++;
		}
	}
	return out;
};

/**
 * The stored size of the document `update` encodes (a v1 update, as
 * `document.encode()`), against a fresh seed of its JSON and its purge at
 * a horizon of now, with its census (before and after the purge).
 */
export const measure = ({ E, Y, crdt }, update) => {
	const loaded = E.loadDocument(update, { semantics: E.defaultSemantics });
	try {
		const { doc, facade } = loaded;
		const json = facade.toJSON();
		const chars = (blocks) =>
			blocks.reduce(
				(n, b) =>
					n +
					(b.content ?? []).reduce((m, p) => m + (p.text?.length ?? 1), 0) +
					chars(b.children ?? []),
				0
			);
		const count = (blocks) => blocks.reduce((n, b) => n + 1 + count(b.children ?? []), 0);
		const stored = Y.encodeStateAsUpdateV2(doc).length;
		const before = census(doc);
		const fresh = E.createDocument({ value: json, semantics: E.defaultSemantics });
		const freshBytes = Y.encodeStateAsUpdateV2(fresh.doc).length;
		fresh.destroy();
		let report = null;
		facade.transact(() => {
			report = crdt.doc.purge(doc, facade, { at: Date.now(), sv: Y.encodeStateVector(doc) });
		}, PURGE);
		const purged = Y.encodeStateAsUpdateV2(doc).length;
		return {
			blocks: count(json.children),
			chars: chars(json.children),
			stored,
			fresh: freshBytes,
			purged,
			purge: report,
			census: before,
			censusAfterPurge: census(doc)
		};
	} finally {
		loaded.destroy();
	}
};

const main = async () => {
	const args = process.argv.slice(2);
	const option = (name, fallback) => {
		const at = args.indexOf(`--${name}`);
		if (at === -1) return fallback;
		return typeof fallback === 'number' ? Number(args[at + 1]) : args[at + 1];
	};
	const config = {
		replicas: option('replicas', 8),
		edits: option('edits', 4000),
		mix: option('mix', 'soak'),
		without: option('without', '').split(',').filter(Boolean),
		sync: option('sync', 25),
		seed: option('seed', 1)
	};
	const engine = await loadEngine();
	const { E, Y } = engine;
	const REMOTE = Symbol('soak-size-remote');
	const random = prng(config.seed);
	const value = seedValue();
	const replicas = Array.from({ length: config.replicas }, (_, i) => {
		const document = E.createDocument({
			value,
			actor: { id: `u${i}` },
			semantics: E.defaultSemantics
		});
		/** A virtual clock: each of the replica's edits takes the soak's 2.5 s (0.4 a second). */
		let clock = 0;
		return {
			document,
			tick: () => (clock += 2500),
			writer: new Writer({
				now: () => clock,
				document,
				random: prng(config.seed * 1000 + i),
				user: `u${i}`,
				mix: config.mix,
				without: config.without
			})
		};
	});
	const sync = () => {
		for (const to of replicas)
			for (const from of replicas) {
				if (from === to) continue;
				const diff = Y.encodeStateAsUpdate(from.document.doc, Y.encodeStateVector(to.document.doc));
				Y.applyUpdate(to.document.doc, diff, REMOTE);
			}
	};
	const ops = {};
	let applied = 0;
	for (let n = 0; n < config.edits; n++) {
		const replica = replicas[Math.floor(random() * replicas.length)];
		replica.tick();
		const { kind, status } = replica.writer.op();
		ops[`${kind}:${status}`] = (ops[`${kind}:${status}`] ?? 0) + 1;
		if (status === 'applied') applied++;
		if ((n + 1) % config.sync === 0) sync();
	}
	sync();
	const reference = JSON.stringify(replicas[0].document.facade.toJSON());
	const converged = replicas.every((r) => JSON.stringify(r.document.facade.toJSON()) === reference);
	const size = measure(engine, replicas[0].document.encode());
	const result = {
		config,
		converged,
		applied,
		ops,
		...size,
		bytesPerEdit: Math.round(((size.stored - size.fresh) / applied) * 10) / 10,
		purgedBytesPerEdit: Math.round(((size.purged - size.fresh) / applied) * 10) / 10
	};
	for (const r of replicas) r.document.destroy();
	const out = option(
		'out',
		fileURLToPath(new URL(`../results/soak-size-${config.mix}.json`, import.meta.url))
	);
	mkdirSync(fileURLToPath(new URL('../results/', import.meta.url)), { recursive: true });
	writeFileSync(out, JSON.stringify(result, null, '\t'));
	const kb = (b) => `${(b / 1024).toFixed(1)} KiB`;
	console.log(
		`${config.mix}: ${applied} edits, ${size.blocks} blocks, ${size.chars} characters; stored ${kb(size.stored)}, fresh seed ${kb(size.fresh)}, purged at now ${kb(size.purged)}; ${result.bytesPerEdit} B an edit over the seed, ${result.purgedBytesPerEdit} after the purge; converged ${converged}`
	);
	console.log(JSON.stringify({ census: size.census, purge: size.purge }, null, 2));
	console.log(`report: ${out}`);
	if (!converged) process.exitCode = 1;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
