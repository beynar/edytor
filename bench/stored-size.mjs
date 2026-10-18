#!/usr/bin/env node
/**
 * What a stored edytor document is made of (the storage diet). Dev-only.
 *
 *   node bench/stored-size.mjs [--only typed,history,typed5k,history5k,churn]
 *     [--json bench/results/stored-size.json] [--kinds 18]
 *
 * Builds seeded, deterministic documents through the document's own
 * operations (the facade, the document's history, one replica per session),
 * then reads each one as the room, the browser store and a history version
 * keep it: `encodeStateAsUpdate` (raw) and its gzip (`packed`, what the
 * stores write). Randomness (client ids, nonces, block ids) and the clock
 * (the history's capture window) are seeded, so a run on two trees builds
 * the same edits.
 *
 * Workloads:
 * - `typed`: 1,000 paragraphs of about 300 characters typed at the end in
 *   runs of 8–40 characters (a few runs marked, a few typos erased in their
 *   step), Enter at each end; one session.
 * - `history`: `typed`, then ten sessions (a fresh replica each, as a page
 *   load) doing 200 Enters at random offsets, 100 block moves, 100 deletes
 *   of 5–20 characters, 50 block deletes and 5 undos.
 * - `typed5k` / `history5k`: the same at 5,000 paragraphs (five times the
 *   history).
 * - `churn`: `typed`, then four rounds of writing about 500 paragraphs and
 *   deleting half of the document (block deletes, cross-block range deletes
 *   and word deletes), a session each; read before and after the room's
 *   purge at a horizon of now.
 *
 * For each document: raw and gzip bytes, per block; the update's columns
 * (the engine's one encoding: nine column encoders and the rest, YP17); the
 * delete set; and what each kind of struct costs, by ablation: the update
 * written again without that kind's structs (marginal bytes, raw, with the
 * columns they sit in). The kinds' marginals do not sum to the total (the
 * columns' run-length codes interact); the residual is printed.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const req = createRequire(`${root}package.json`);

// ── seeded randomness and clock, before the engine loads ─────────────
const mulberry = (seed) => () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
let entropy = mulberry(1);
/** Reseed every source of randomness (client ids, nonces, ids) and the clock. */
const reseed = (seed) => {
	entropy = mulberry(seed);
	clock = 1_760_000_000_000;
};
Math.random = () => entropy();
globalThis.crypto.getRandomValues = (array) => {
	for (let i = 0; i < array.length; i++) {
		const r = Math.floor(entropy() * 2 ** 32);
		array[i] = array.BYTES_PER_ELEMENT === 4 ? r : r & ((1 << (array.BYTES_PER_ELEMENT * 8)) - 1);
	}
	return array;
};
globalThis.crypto.randomUUID = () =>
	'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () =>
		Math.floor(entropy() * 16).toString(16)
	);
let clock = 1_760_000_000_000;
Date.now = () => clock;
/** Advance the virtual clock (the history's capture window reads it). */
export const wait = (ms) => (clock += ms);

const vitestDir = req.resolve('vitest/package.json').replace(/\/package\.json$/, '');
const { createJiti } = await import(req.resolve('jiti', { paths: [vitestDir] }));
const jiti = createJiti(import.meta.url);
const { Y } = await jiti.import(`${root}src/lib/crdt/engine.js`);
const E = await jiti.import(`${root}src/lib/crdt/index.ts`);
const { packed } = await jiti.import(`${root}src/lib/crdt/storage.ts`);
const encoding = await jiti.import(req.resolve('lib0-v14/encoding'));
const crdt = E.bindCrdt(Y);
export { E, Y, crdt, encoding, packed };
const PURGE = Symbol('stored-size-purge');

// ── arguments ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? fallback : args[at + 1];
};
const only = option('only', 'typed,history,typed5k,history5k,views,updates,churn').split(',');
const topKinds = Number(option('kinds', 24));
const timing = args.includes('--time');
const heapToo = args.includes('--heap') && typeof globalThis.gc === 'function';

// ── a seeded writer ───────────────────────────────────────────────────
const WORDS =
	'the of and to in is that for it as was with be by on not he this are or his from at which but have an they you were her she there one all we their been has would when if no will more so who can said out up other into what some time could them these only new about than its first also two any like over may such after most then made people years even those many through back where much before because good how know just state very well each way between work year without own last same while still might under both however part never place since system think point long another great again around world small used number high every down off case early life old government fact public history order found days large group rather'.split(
		' '
	);
const ALPHABET = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict';

class Writer {
	constructor(seed) {
		this.random = mulberry(seed);
	}
	int(lo, hi) {
		return lo + Math.floor(this.random() * (hi - lo + 1));
	}
	pick(xs) {
		return xs[Math.floor(this.random() * xs.length)];
	}
	chance(p) {
		return this.random() < p;
	}
	/** A block id as the view mints one (`b_` and ten characters). */
	blockId() {
		let t = '';
		for (let i = 0; i < 10; i++) t += ALPHABET[61 & Math.floor(this.random() * 256)];
		return `b_${t}`;
	}
	/** About `length` characters of prose. */
	prose(length) {
		let out = '';
		let sentence = 0;
		while (out.length < length) {
			let w = this.pick(WORDS);
			if (sentence === 0) w = w[0].toUpperCase() + w.slice(1);
			sentence++;
			out += w;
			if (sentence > this.int(6, 16)) {
				out += this.chance(0.1) ? '? ' : '. ';
				sentence = 0;
			} else out += this.chance(0.08) ? ', ' : ' ';
		}
		return out.slice(0, length);
	}
}

const ok = (r, what) => {
	if (r && r.status === 'refused') throw new Error(`${what} refused: ${JSON.stringify(r)}`);
	return r;
};

/** Type `text` at the end of `id` in runs of 8–40 characters (marks and typos as a user's). */
const typeInto = (doc, w, id, text) => {
	const f = doc.facade;
	for (let at = 0; at < text.length; ) {
		const run = text.slice(at, at + w.int(8, 40));
		const end = f.displayLength(id);
		const marked = w.random();
		const marks =
			marked < 0.04
				? { bold: true }
				: marked < 0.06
					? { italic: true }
					: marked < 0.07
						? { link: `https://example.com/${w.blockId()}` }
						: undefined;
		ok(f.insertText(id, end, run, marks), 'insertText');
		at += run.length;
		if (w.chance(0.05)) {
			// A typo erased at once (the same history step: removed, never held).
			wait(150);
			const n = Math.min(w.int(1, 3), f.displayLength(id));
			ok(f.deleteText(id, f.displayLength(id) - n, n), 'typo');
			ok(f.insertText(id, f.displayLength(id), run.slice(-n), marks), 'retype');
		}
		wait(w.int(600, 2500));
	}
};

/** A fresh replica of `doc` (a page load), in its own session. */
const reload = (doc, user) => {
	const update = doc.encode();
	doc.destroy();
	const next = E.loadDocument(update, { actor: { id: user } });
	next.history; // the view's history attaches at load
	return next;
};

/** Visible top-level blocks in order. */
const order = (doc) => doc.facade.childrenIds(null);

/** `n` paragraphs typed into a new document, Enter after each. */
export const typedDocument = (n, seed = 7) => {
	reseed(seed);
	const w = new Writer(seed);
	const doc = E.createDocument({ actor: { id: 'alice' } });
	doc.sync({ children: [{ id: w.blockId(), type: 'paragraph' }] });
	doc.history;
	let id = order(doc)[0];
	for (let i = 0; i < n; i++) {
		typeInto(doc, w, id, w.prose(w.int(200, 400)));
		if (i === n - 1) break;
		const next = w.blockId();
		ok(doc.facade.splitBlock(id, doc.facade.displayLength(id), next), 'Enter');
		id = next;
		wait(w.int(800, 4000));
	}
	return doc;
};

/** The edit history: `scale` × (200 Enters, 100 moves, 100 deletes of 5–20 characters, 50 block deletes, 5 undos), over ten sessions. */
export const editHistory = (doc, scale = 1, seed = 11) => {
	const w = new Writer(seed);
	const ops = [
		...Array(200 * scale).fill('enter'),
		...Array(100 * scale).fill('move'),
		...Array(100 * scale).fill('word'),
		...Array(50 * scale).fill('block'),
		...Array(5).fill('undo')
	];
	for (let i = ops.length - 1; i > 0; i--) {
		const j = Math.floor(w.random() * (i + 1));
		[ops[i], ops[j]] = [ops[j], ops[i]];
	}
	const sessions = 10;
	const per = Math.ceil(ops.length / sessions);
	const users = ['alice', 'bob', 'carol'];
	for (let s = 0; s < sessions; s++) {
		doc = reload(doc, users[s % users.length]);
		const f = doc.facade;
		for (const op of ops.slice(s * per, (s + 1) * per)) {
			wait(w.int(3000, 20000));
			const blocks = order(doc);
			const id = w.pick(blocks);
			const len = f.displayLength(id);
			if (op === 'enter') {
				ok(f.splitBlock(id, w.int(0, len), w.blockId()), 'Enter');
				const tail = w.pick(order(doc));
				typeInto(doc, w, tail, w.prose(w.int(10, 60)));
			} else if (op === 'move') {
				const to = w.int(0, blocks.length - 1);
				ok(f.moveBlocks([id], { parent: null, index: to }), 'move');
			} else if (op === 'word') {
				if (len < 25) continue;
				const n = w.int(5, 20);
				ok(f.deleteText(id, w.int(0, len - n), n), 'word delete');
			} else if (op === 'block') {
				if (blocks.length < 3) continue;
				ok(f.deleteBlock(id), 'block delete');
			} else doc.history.undo();
		}
	}
	return doc;
};

/** Write and delete half of the document, `rounds` times, a session each. */
export const churn = (doc, rounds = 4, seed = 13) => {
	const w = new Writer(seed);
	for (let r = 0; r < rounds; r++) {
		doc = reload(doc, r % 2 ? 'bob' : 'alice');
		const f = doc.facade;
		// Write about 500 paragraphs, in runs of 5–20 after random blocks.
		for (let written = 0; written < 500; ) {
			let id = w.pick(order(doc));
			const run = w.int(5, 20);
			for (let i = 0; i < run; i++) {
				const next = w.blockId();
				ok(f.splitBlock(id, f.displayLength(id), next), 'Enter');
				typeInto(doc, w, next, w.prose(w.int(150, 350)));
				id = next;
				wait(w.int(800, 4000));
			}
			written += run;
		}
		// Delete half: block deletes, cross-block range deletes and word deletes.
		const target = Math.floor(order(doc).length / 2);
		while (order(doc).length > target) {
			wait(w.int(2000, 10000));
			const blocks = order(doc);
			const roll = w.random();
			if (roll < 0.5) ok(f.deleteBlock(w.pick(blocks)), 'block delete');
			else if (roll < 0.85) {
				const at = w.int(0, blocks.length - 12);
				const from = blocks[at];
				const to = blocks[at + w.int(2, 10)];
				ok(
					f.deleteRange(
						{ block: from, offset: w.int(0, f.displayLength(from)) },
						{ block: to, offset: w.int(0, f.displayLength(to)) }
					),
					'range delete'
				);
			} else {
				for (let k = 0; k < 10; k++) {
					const id = w.pick(blocks);
					const len = f.displayLength(id);
					if (len < 25) continue;
					const n = w.int(5, 20);
					ok(f.deleteText(id, w.int(0, len - n), n), 'word delete');
				}
			}
		}
	}
	return doc;
};

// ── the analysis ──────────────────────────────────────────────────────
const COLUMNS = [
	'keyClock',
	'client',
	'leftClock',
	'rightClock',
	'info',
	'string',
	'parentInfo',
	'typeRef',
	'len',
	'rest'
];

/** The byte length of each column of an update (`UpdateEncoder#toUint8Array`'s layout). */
export const columnsOf = (update) => {
	let pos = 0;
	const varUint = () => {
		let n = 0;
		let mult = 1;
		for (;;) {
			const b = update[pos++];
			n += (b & 0x7f) * mult;
			mult *= 128;
			if (b < 0x80) return n;
		}
	};
	varUint(); // feature flag
	const out = {};
	for (const name of COLUMNS.slice(0, -1)) {
		const start = pos;
		const len = varUint();
		pos += len;
		out[name] = pos - start;
	}
	out.rest = update.length - pos;
	return out;
};

/** The root name of each root node of `doc`. */
export const rootsOf = (doc) => {
	const out = new Map();
	for (const [name, node] of doc.share) out.set(node, name);
	return out;
};

const family = (key) => {
	const m = /^(d\/|del\.|wd\.|k\/|c\/|u\/|b\/)/.exec(key);
	return m ? m[1] : key;
};

/** What `struct` is, for the breakdown. */
export const kindOf = (roots, struct) => {
	const content = struct.content;
	if (content === undefined) return 'GC (collected ranges)';
	const parent = struct.parent;
	const rootName = roots.get(parent);
	const nodeName = rootName === undefined ? parent?.name : null;
	const ctor = content.constructor.name;
	const removed = ctor === 'ContentDeleted';
	let state = '';
	if (struct.deleted && !removed) {
		if (struct.holds > 0) state = ' (held)';
		else if (struct.gone) state = ' (deleted, content kept)';
	}
	if (removed) state = ' (removed)';
	if (struct.parentSub !== null) {
		const key = struct.parentSub;
		if (rootName === 'blocks') return `registry entry${state}`;
		if (rootName === 'blockattr') return `attribution record entry (b/)${state}`;
		if (rootName === 'attribution') return `actor dictionary (${family(key)})${state}`;
		if (rootName !== undefined) return `root ${rootName}.${family(key)}${state}`;
		if (nodeName === 'block') return `block.${family(key)}${state}`;
		if (nodeName === 'brec') return `attribution record.${family(key)}${state}`;
		if (nodeName === 'inline') return `atom.${family(key)}${state}`;
		return `${nodeName}.${family(key)}${state}`;
	}
	if (ctor === 'ContentHold') return `hold record${state}`;
	if (ctor === 'ContentMove') return `move record${state}`;
	const value = ctor === 'ContentAny' ? content.arr[0] : undefined;
	const where = rootName ?? nodeName;
	if (where === 'content') {
		if (ctor === 'ContentString') return `text${state}`;
		if (ctor === 'ContentFormat') return `mark${state}`;
		if (ctor === 'ContentType') return `atom${state}`;
		if (value && typeof value === 'object' && 's' in value) return `boundary${state}`;
		if (value && typeof value === 'object' && 'm' in value) return `claim${state}`;
		if (removed) return 'text or units (removed)';
		return `content ${ctor}${state}`;
	}
	if (where === 'textdel') return `hold record${state}`;
	if (where === 'blocks' || where === 'block') {
		if (value && typeof value === 'object' && 'b' in value) return `home slot${state}`;
		if (value && typeof value === 'object' && 'p' in value) return `data slot${state}`;
		if (removed) return 'slot (removed)';
	}
	return `${where}[] ${ctor}${state}`;
};

/** Write `doc`'s structs (those `keep` takes) and, when `ds`, its delete set: the update's encoder. */
export const writeFiltered = (doc, keep, ds = true) => {
	const encoder = new Y.UpdateEncoder();
	const clients = [...doc.store.clients.entries()].sort((a, b) => b[0] - a[0]);
	const lists = clients
		.map(([client, structs]) => [client, structs.filter(keep)])
		.filter(([, s]) => s.length > 0);
	encoding.writeVarUint(encoder.restEncoder, lists.length);
	for (const [client, structs] of lists) {
		encoding.writeVarUint(encoder.restEncoder, structs.length);
		encoder.writeClient(client);
		encoding.writeVarUint(encoder.restEncoder, structs[0].id.clock);
		for (const struct of structs) struct.write(encoder, 0, 0);
	}
	if (ds) Y.writeIdSet(encoder, doc.store.ds);
	else encoding.writeVarUint(encoder.restEncoder, 0);
	return encoder.toUint8Array();
};

const visibleCount = (blocks) => blocks.reduce((n, b) => n + 1 + visibleCount(b.children ?? []), 0);
const visibleChars = (blocks) =>
	blocks.reduce(
		(n, b) =>
			n +
			(b.content ?? []).reduce((m, p) => m + (p.text?.length ?? 1), 0) +
			visibleChars(b.children ?? []),
		0
	);

/** Everything about one stored document. */
export const analyze = async (doc, label) => {
	const update = doc.encode();
	const json = doc.facade.toJSON();
	const blocks = visibleCount(json.children);
	const chars = visibleChars(json.children);
	const gz = await packed(update);
	const roots = rootsOf(doc.doc);
	const all = writeFiltered(doc.doc, () => true);
	const noDs = writeFiltered(doc.doc, () => true, false);
	const kinds = new Map();
	for (const structs of doc.doc.store.clients.values())
		for (const s of structs) {
			const k = kindOf(roots, s);
			const row = kinds.get(k) ?? { structs: 0, length: 0, chars: 0 };
			row.structs++;
			row.length += s.length;
			if (s.content?.constructor.name === 'ContentString') row.chars += s.content.str.length;
			kinds.set(k, row);
		}
	const fullColumns = columnsOf(all);
	const allGzip = gzipSync(all).length;
	const rows = [];
	for (const [kind, row] of kinds) {
		const without = writeFiltered(doc.doc, (s) => kindOf(roots, s) !== kind);
		const cols = columnsOf(without);
		const delta = {};
		for (const c of COLUMNS) {
			const d = fullColumns[c] - cols[c];
			if (d !== 0) delta[c] = d;
		}
		rows.push({
			kind,
			...row,
			bytes: all.length - without.length,
			gzip: allGzip - gzipSync(without).length,
			columns: delta
		});
	}
	rows.sort((a, b) => b.bytes - a.bytes);
	const fresh = E.createDocument({ value: json, actor: { id: 'alice' } });
	const freshBytes = fresh.encode().length;
	const freshGz = (await packed(fresh.encode())).length;
	fresh.destroy();
	let ranges = 0;
	for (const r of doc.doc.store.ds.clients.values()) ranges += r.getIds().length;
	const extra = {};
	if (timing) {
		const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
		const times = (n, f) =>
			Array.from({ length: n }, () => {
				const t = performance.now();
				f();
				return performance.now() - t;
			});
		extra.encodeMs = round2(med(times(9, () => doc.encode())));
		extra.loadMs = round2(med(times(5, () => E.loadDocument(update).destroy())));
	}
	if (heapToo) {
		globalThis.gc();
		globalThis.gc();
		const h0 = process.memoryUsage().heapUsed;
		const loaded = E.loadDocument(update);
		loaded.facade.toJSON();
		globalThis.gc();
		globalThis.gc();
		extra.heapMB = round2((process.memoryUsage().heapUsed - h0) / 1048576);
		loaded.destroy();
	}
	return {
		...extra,
		label,
		blocks,
		chars,
		clients: doc.doc.store.clients.size,
		raw: update.length,
		gzip: gz.length,
		perBlock: round(update.length / blocks),
		gzipPerBlock: round(gz.length / blocks),
		fresh: freshBytes,
		freshGzip: freshGz,
		columns: columnsOf(update),
		deleteSet: { bytes: all.length - noDs.length, clients: doc.doc.store.ds.clients.size, ranges },
		kinds: rows
	};
};

const round = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

export const purgeNow = (doc) => {
	let report;
	doc.facade.transact(() => {
		report = crdt.doc.purge(doc.doc, doc.facade, {
			at: Date.now(),
			sv: Y.encodeStateVector(doc.doc)
		});
	}, PURGE);
	// What the room stores after the purge: the state as a fresh load reads it.
	const purged = E.loadDocument(doc.encode());
	doc.destroy();
	return { purged, report };
};

const print = (r) => {
	const pad = (s, n) => String(s).padEnd(n);
	const num = (s, n) => String(s).padStart(n);
	console.log(
		`\n## ${r.label}: ${r.blocks} blocks, ${r.chars} characters, ${r.clients} clients — raw ${r.raw} B (${r.perBlock} B/block), gzip ${r.gzip} B (${r.gzipPerBlock} B/block); the same JSON seeded fresh: ${r.fresh} B raw, ${r.freshGzip} B gzip`
	);
	if (r.encodeMs !== undefined || r.heapMB !== undefined)
		console.log(
			`encode ${r.encodeMs ?? '-'} ms, load ${r.loadMs ?? '-'} ms, heap after load ${r.heapMB ?? '-'} MB`
		);
	console.log(
		`columns: ${COLUMNS.map((c) => `${c} ${r.columns[c]}`).join(', ')}; delete set ${r.deleteSet.bytes} B (${r.deleteSet.ranges} ranges, ${r.deleteSet.clients} clients)`
	);
	let sum = 0;
	console.log(
		`${pad('kind', 46)} ${num('structs', 8)} ${num('length', 8)} ${num('bytes', 8)} ${num('%', 6)} ${num('gzip', 7)} ${num('%', 6)}  columns`
	);
	for (const k of r.kinds.slice(0, topKinds)) {
		sum += k.bytes;
		console.log(
			`${pad(k.kind, 46)} ${num(k.structs, 8)} ${num(k.length, 8)} ${num(k.bytes, 8)} ${num(round((k.bytes / r.raw) * 100), 6)} ${num(k.gzip, 7)} ${num(round((k.gzip / r.gzip) * 100), 6)}  ${Object.entries(
				k.columns
			)
				.map(([c, b]) => `${c} ${b}`)
				.join(', ')}`
		);
	}
	const rest = r.kinds.slice(topKinds).reduce((n, k) => n + k.bytes, 0);
	if (rest) console.log(`${pad('(other kinds)', 46)} ${num('', 8)} ${num('', 8)} ${num(rest, 8)}`);
	console.log(
		`residual (header bytes, run-length interactions, delete set): ${r.raw - sum - rest} B`
	);
};

/** The update one operation sends (its transaction's `update` event), for each kind of edit. */
export const updateSizes = (seed = 17) => {
	const w = new Writer(seed);
	let doc = typedDocument(1000);
	doc = reload(doc, 'bob');
	const f = doc.facade;
	const sizes = {};
	const capture = (name, op) => {
		let bytes = 0;
		const on = (u) => (bytes += u.length);
		doc.doc.on('update', on);
		wait(5000);
		op();
		doc.doc.off('update', on);
		(sizes[name] ??= []).push(bytes);
	};
	for (let i = 0; i < 20; i++) {
		const blocks = order(doc);
		const id = w.pick(blocks);
		const len = f.displayLength(id);
		capture('keystroke', () => ok(f.insertText(id, w.int(0, len), 'k'), 'keystroke'));
		capture('Enter', () =>
			ok(f.splitBlock(id, w.int(0, f.displayLength(id)), w.blockId()), 'Enter')
		);
		const other = w.pick(order(doc));
		const olen = f.displayLength(other);
		if (olen > 12)
			capture('bold a word', () =>
				ok(f.formatRange(other, w.int(0, olen - 10), 8, { bold: true }), 'bold')
			);
		if (olen > 25)
			capture('delete a word', () => ok(f.deleteText(other, w.int(0, olen - 12), 10), 'word'));
		capture('undo', () => doc.history.undo());
		const moved = w.pick(order(doc));
		capture('move a block', () =>
			ok(f.moveBlocks([moved], { parent: null, index: w.int(0, order(doc).length - 1) }), 'move')
		);
		capture('delete a block', () => ok(f.deleteBlock(w.pick(order(doc))), 'block delete'));
	}
	doc.destroy();
	const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
	return Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, med(v)]));
};

/** What view-only page loads add: `n` sessions that attach a replica and write nothing. */
export const viewOnly = (n = 200) => {
	let doc = typedDocument(1000);
	const before = doc.encode().length;
	for (let i = 0; i < n; i++) doc = reload(doc, `viewer${i % 20}`);
	return { doc, before };
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
	const results = [];
	const run = async (name, build) => {
		if (!only.includes(name)) return;
		const t0 = performance.now();
		const docs = build();
		for (const [label, doc] of docs) {
			const r = await analyze(doc, label);
			results.push(r);
			print(r);
		}
		for (const [, doc] of docs) doc.destroy();
		console.log(`(${name}: ${Math.round(performance.now() - t0)} ms)`);
	};

	await run('typed', () => [['typed: 1,000 typed paragraphs', typedDocument(1000)]]);
	await run('history', () => [
		['history: typed, then the edit history', editHistory(typedDocument(1000), 1)]
	]);
	await run('typed5k', () => [['typed5k: 5,000 typed paragraphs', typedDocument(5000)]]);
	await run('history5k', () => [
		['history5k: 5,000 typed, then five times the history', editHistory(typedDocument(5000), 5)]
	]);
	if (only.includes('updates')) {
		const sizes = updateSizes();
		results.push({ label: 'updates', sizes });
		console.log(
			`\n## one operation's update (median of 20, bytes): ${Object.entries(sizes)
				.map(([k, v]) => `${k} ${v}`)
				.join(', ')}`
		);
	}
	await run('views', () => {
		const { doc, before } = viewOnly();
		console.log(
			`(views: 200 view-only page loads added ${doc.encode().length - before} B, ${round((doc.encode().length - before) / 200)} B a load)`
		);
		return [['views: typed, then 200 view-only page loads', doc]];
	});
	await run('churn', () => {
		const before = churn(typedDocument(1000), 4);
		const copy = E.loadDocument(before.encode());
		const shown = JSON.stringify(copy.facade.toJSON());
		const { purged } = purgeNow(copy);
		if (JSON.stringify(purged.facade.toJSON()) !== shown) {
			const ids = (json) => new Set(JSON.parse(json).children.map((b) => b.id));
			const was = ids(shown);
			const now = ids(JSON.stringify(purged.facade.toJSON()));
			const added = [...now].filter((id) => !was.has(id));
			const lost = [...was].filter((id) => !now.has(id));
			console.log(
				`WARNING: the purge changed the visible document (+${added.length} −${lost.length} top-level blocks): ${added.slice(0, 5).join(' ')}`
			);
			globalThis.purgeDiff = { added, lost, before: copy };
		}
		return [
			['churn: typed, then four rounds of writing and deleting half', before],
			['churn, after the purge at a horizon of now', purged]
		];
	});

	const out = option('json', null);
	if (out) {
		mkdirSync(fileURLToPath(new URL('./results/', import.meta.url)), { recursive: true });
		writeFileSync(out, JSON.stringify(results, null, '\t'));
		console.log(`\nreport: ${out}`);
	}
}
