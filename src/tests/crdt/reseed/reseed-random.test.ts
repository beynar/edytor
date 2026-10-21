/**
 * A document's re-seed under random edits (`room.reseed.text`,
 * `room.reseed.residue`): per seed, a base document; an offline replica
 * and an online one each make up to `CRDT_OPS` random edits from it on the
 * same few blocks; the room re-seeds at the online state (and the online
 * side may write on the new document before the offline one returns); the
 * offline replica's whole document is rebased onto it. The oracle is what
 * the CRDT gives when the two simply merge, with no re-seed.
 *
 * - Text edits only (typing, deleting, formatting) on both sides: every
 *   character the CRDT shows shows, in its block, and nothing else
 *   (`room.reseed.text`; the order of two inserts made at one place at once
 *   and a mark's edge can differ).
 * - With blocks split, merged, moved, inserted and deleted too: the
 *   characters that differ from the CRDT stay a small share (the residue,
 *   `room.reseed.residue`: both sides restructured the same blocks, and the
 *   CRDT's outcome then depends on the old document's structure history).
 *
 * Every character typed is unique (`RESEED_TEXT=words`: words of a small
 * dictionary). `CRDT_SEEDS` (`1-1000`) and `CRDT_OPS` widen it.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument, loadDocument } from '../../../lib/crdt/index.js';
import type { EdytorDocument } from '../../../lib/crdt/document.js';
import { setDocRand } from '../../../lib/crdt/rand.js';
import {
	cutDocument,
	decodeCut,
	encodeCut,
	rebaseOnto,
	type Replica
} from '../../../lib/crdt/reseed.js';
import type { JSONBlock, JSONDoc } from '../../../lib/utils/json.js';
import { bool, int, mulberry32, pick, type Rng } from '../harness/rng.js';

const seedsOf = (raw: string | undefined, fallback: number[]): number[] => {
	if (!raw) return fallback;
	const out: number[] = [];
	for (const part of raw.split(',')) {
		const [a, b] = part.split('-').map(Number);
		for (let s = a!; s <= (b ?? a!); s++) out.push(s);
	}
	return out;
};
const SEEDS = seedsOf(
	process.env.CRDT_SEEDS,
	Array.from({ length: 120 }, (_, i) => i + 1)
);
const OPS = Number(process.env.CRDT_OPS ?? 30);
const WORDS = process.env.RESEED_TEXT === 'words';
const DICTIONARY = ['the', 'a', 'and', 'of', 'to', 'in', 'is', 'it', 'that', 'we', 'text', 'page'];

type Mix = 'text' | 'structure';

/** A fresh text of `n` characters: unique ones (CJK from U+4E00), or words. */
const textGen = (rng: Rng) => {
	let next = 0x4e00;
	return (n: number) => {
		if (!WORDS) return Array.from({ length: n }, () => String.fromCharCode(next++)).join('');
		let out = '';
		while (out.length < n) out += pick(rng, DICTIONARY) + ' ';
		return out.slice(0, n);
	};
};

/** One random edit of `d`; `structure` adds splits, merges, moves, inserts and deletes of blocks a third of the time. */
const edit = (
	rng: Rng,
	d: EdytorDocument,
	mix: Mix,
	text: (n: number) => string,
	fresh: () => string
) => {
	const f = d.facade;
	const ids = f.order().filter((id) => f.displayLength(id) >= 0);
	if (ids.length === 0) {
		f.insertBlocks({ parent: null, index: 0 }, [
			{ id: fresh(), type: 'paragraph', content: [{ text: text(3) }] }
		]);
		return;
	}
	const b = pick(rng, ids);
	const len = f.displayLength(b);
	const off = int(rng, 0, len);
	const at = Math.min(off, Math.max(0, len - 1));
	if (mix === 'structure' && bool(rng, 1 / 3)) {
		const kind = int(rng, 0, 4);
		if (kind === 0) f.splitBlock(b, off, fresh());
		else if (kind === 1) f.mergeBackward(b);
		else if (kind === 2)
			f.moveBlocks([b], { parent: null, index: int(rng, 0, f.childrenIds(null).length) });
		else if (kind === 3)
			f.insertBlocks(
				{ parent: f.parentOf(b), index: f.childrenIds(f.parentOf(b)).indexOf(b) + 1 },
				[{ id: fresh(), type: 'paragraph', content: [{ text: text(int(rng, 0, 5)) }] }]
			);
		else f.deleteBlock(b);
		return;
	}
	const kind = int(rng, 0, 9);
	if (kind < 5) f.insertText(b, off, text(int(rng, 1, 6)));
	else if (kind < 8 && len > 0) f.deleteText(b, at, int(rng, 1, Math.min(4, len - at)));
	else if (kind === 8 && len > 0)
		f.formatRange(b, at, int(rng, 1, len - at), { bold: bool(rng, 0.7) ? true : null });
	else f.patchData(b, [{ path: ['color'], value: pick(rng, ['red', 'blue']) }]);
};

const asReplica = (d: EdytorDocument): Replica => ({
	doc: d.doc as never,
	facade: d.facade as never
});

/** Each block's text with its parent, depth first. */
const flatten = (doc: JSONDoc) => {
	const out: { id: string; parent: string | null; text: string }[] = [];
	const walk = (blocks: JSONBlock[], parent: string | null) => {
		for (const b of blocks) {
			out.push({
				id: b.id!,
				parent,
				text: (b.content ?? []).map((c) => ('text' in c ? c.text : '□')).join('')
			});
			walk(b.children ?? [], b.id!);
		}
	};
	walk(doc.children, null);
	return out;
};
const count = (s: string) => {
	const m = new Map<string, number>();
	for (const ch of s) m.set(ch, (m.get(ch) ?? 0) + 1);
	return m;
};

/** Characters the oracle shows that the result lacks, the reverse, and (unique text) those in another block. */
const score = (want: JSONDoc, got: JSONDoc) => {
	const [w, g] = [flatten(want), flatten(got)];
	const [wc, gc] = [count(w.map((b) => b.text).join('')), count(g.map((b) => b.text).join(''))];
	let [lost, extra, elsewhere, duplicated] = [0, 0, 0, 0];
	for (const [ch, n] of wc) lost += Math.max(0, n - (gc.get(ch) ?? 0));
	for (const [ch, n] of gc) extra += Math.max(0, n - (wc.get(ch) ?? 0));
	if (!WORDS) for (const n of gc.values()) duplicated += n - 1;
	if (!WORDS) {
		const home = new Map<string, string>();
		for (const b of g) for (const ch of b.text) home.set(ch, b.id);
		for (const b of w)
			for (const ch of b.text) if (home.has(ch) && home.get(ch) !== b.id) elsewhere++;
	}
	return { chars: [...wc.values()].reduce((a, b) => a + b, 0), lost, extra, elsewhere, duplicated };
};

const run = (seed: number, mix: Mix) => {
	const rng = mulberry32(seed);
	const text = textGen(rng);
	let n = 0;
	const fresh = () => `n${seed}x${n++}`;
	const value: JSONDoc = {
		children: Array.from({ length: int(rng, 3, 8) }, (_, i) => ({
			id: `b${i}`,
			type: 'paragraph',
			content: [{ text: text(int(rng, 0, 20)) }]
		}))
	};
	const origin = createDocument({ value, actor: { id: 'seed' } });
	origin.doc.clientID = 500;
	const replica = (actor: string, clientID: number) => {
		const d = loadDocument(origin.encode(), { actor: { id: actor } });
		d.sync();
		d.doc.clientID = clientID;
		setDocRand(d.doc as never, mulberry32(seed * 7 + clientID));
		return d;
	};
	const [offline, online] = [replica('ana', 1000), replica('ben', 2000)];
	const trace = (who: string, d: EdytorDocument) => {
		const before = JSON.stringify(flatten(d.toJSON()));
		edit(rng, d, mix, text, fresh);
		if (process.env.RESEED_SEED)
			console.log(
				who,
				before === JSON.stringify(flatten(d.toJSON())) ? '(no change)' : show(d.toJSON())
			);
	};
	for (let k = 0, m = int(rng, 1, OPS); k < m; k++) trace('R', offline);
	for (let k = 0, m = int(rng, 0, OPS); k < m; k++) trace('O', online);
	const oracle = replica('oracle', 4000);
	Y.applyUpdate(oracle.doc, online.encode(), 'remote');
	Y.applyUpdate(oracle.doc, offline.encode(), 'remote');
	const { document: epoch, cut } = cutDocument(asReplica(online), (json) => {
		const d = createDocument({ value: json, actor: { id: 'room' } });
		d.doc.clientID = 9000;
		return asReplica(d);
	});
	(epoch.doc as never as { transact: (f: () => unknown) => unknown }).transact(() =>
		rebaseOnto(epoch, decodeCut(encodeCut(cut)), offline.encode(), (update) => {
			const d = loadDocument(update, { actor: { id: 'room' } });
			d.sync();
			d.doc.clientID = 9001;
			return asReplica(d);
		})
	);
	if (process.env.RESEED_SEED)
		console.log('WANT', show(oracle.toJSON()), '\nGOT ', show(epoch.facade.toJSON()));
	return score(oracle.toJSON(), epoch.facade.toJSON());
};
const show = (doc: JSONDoc) =>
	flatten(doc)
		.map(
			(b) =>
				`${b.parent ? '  ' : ''}${b.id}:${[...b.text].map((c) => (WORDS ? c : (c.charCodeAt(0) - 0x4e00).toString(36))).join('.')}`
		)
		.join(' | ');

const total = (mix: Mix) => {
	const sum = { chars: 0, lost: 0, extra: 0, elsewhere: 0, duplicated: 0, seeds: 0 };
	for (const seed of SEEDS) {
		const s = run(seed, mix);
		if (process.env.RESEED_REPORT && s.lost + s.extra > 0)
			console.log('seed', seed, JSON.stringify(s));
		for (const k of ['chars', 'lost', 'extra', 'elsewhere', 'duplicated'] as const) sum[k] += s[k];
		if (s.lost + s.extra + s.elsewhere > 0) sum.seeds++;
	}
	return sum;
};

describe('re-seed under random edits (room.reseed.*)', () => {
	it.skipIf(!process.env.RESEED_SEED)('one seed', () => {
		console.log(
			run(Number(process.env.RESEED_SEED), (process.env.RESEED_MIX ?? 'structure') as Mix)
		);
	});

	it('text edits on both sides: every character the CRDT shows, in its block, nothing else', () => {
		const sum = total('text');
		expect({
			lost: sum.lost,
			extra: sum.extra,
			elsewhere: sum.elsewhere,
			duplicated: sum.duplicated
		}).toEqual({
			lost: 0,
			extra: 0,
			elsewhere: 0,
			duplicated: 0
		});
	});

	it('structure too: the residue stays small', () => {
		const sum = total('structure');
		if (process.env.RESEED_REPORT) console.log('residue', sum);
		// Measured on the default seeds: 1.3 % of the characters, in 17 % of them (a regression bound).
		expect(sum.lost + sum.extra).toBeLessThan(sum.chars * 0.02);
		expect(sum.seeds).toBeLessThan(SEEDS.length / 4);
		expect(sum.duplicated).toBe(0);
	});
});
