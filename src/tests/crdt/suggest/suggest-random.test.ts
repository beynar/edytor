/**
 * Shared suggestions under concurrency (`sugg.*`): seeded random schedules
 * of three replicas — one suggesting (text, splits, merges, block deletes,
 * retypes, formats; moves refused), two editing and deciding (accept or
 * reject a random pending change) — with undo and redo on every replica,
 * and every update delivered in a random order, some held back and
 * delivered late. After a full sync:
 *
 * - every replica holds the same document, as shown and without its
 *   pending suggestions, and the same pending changes (pending is a
 *   function of the replicated state);
 * - what each replica keeps per block equals a fresh facade's reading of
 *   the same state (the maintained part against a rebuild);
 * - the document without suggestions is the document with every pending
 *   suggestion rejected (the base lens is well formed).
 *
 * `CRDT_SEEDS` (`1-1000`) and `CRDT_OPS` widen it, as for the corpus.
 */
import { describe, expect, it } from 'vitest';
import { Y } from '../../../lib/crdt/engine.js';
import { createDocument, loadDocument } from '../../../lib/crdt/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';
import { setDocRand } from '../../../lib/crdt/rand.js';
import type { EdytorDocument } from '../../../lib/crdt/document.js';
import type { SuggestedChange } from '../../../lib/crdt/doc/suggest.js';
import { alpha, bool, int, mulberry32, pick, shuffled, type Rng } from '../harness/rng.js';

const E = bindEdytorDoc(Y as never);

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
	Array.from({ length: 60 }, (_, i) => i + 1)
);
const OPS = Number(process.env.CRDT_OPS ?? 80);

const VALUE = {
	children: [
		{ id: 'a', type: 'paragraph', content: [{ text: 'alpha beta gamma' }] },
		{ id: 'b', type: 'paragraph', content: [{ text: 'delta epsilon' }] },
		{ id: 'c', type: 'paragraph', content: [{ text: 'zeta eta theta' }] }
	]
};

type Peer = { d: EdytorDocument; outbox: Uint8Array[]; inbox: Uint8Array[] };

const shown = (d: EdytorDocument) => d.toJSON({ suggestions: true });
const describeChange = (c: SuggestedChange) => [
	c.suggestion,
	c.kind,
	c.block,
	c.offset,
	c.length,
	c.text,
	c.op?.op ?? null
];

/** One seeded schedule; answers a transcript line per step (for a failure's message). */
const run = (seed: number) => {
	const rng: Rng = mulberry32(seed);
	const peers: Peer[] = ['ana', 'ben', 'cy'].map((actor, i) => {
		const d = createDocument({ value: VALUE, actor: { id: actor } });
		d.doc.clientID = 1000 + i;
		setDocRand(d.doc as never, mulberry32(seed * 7 + i));
		const peer: Peer = { d, outbox: [], inbox: [] };
		d.doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (origin !== 'remote') peer.outbox.push(update);
		});
		return peer;
	});
	const log: string[] = [];
	const S = (p: Peer) => p.d.facade.suggest;
	const live = (p: Peer) => p.d.facade.order().filter((id) => p.d.facade.displayLength(id) >= 0);
	let record: string | null = null;
	const suggester = peers[0]!;
	let fresh = 0;

	for (let step = 0; step < OPS; step++) {
		const roll = int(rng, 0, 99);
		const p = roll < 45 ? suggester : pick(rng, peers.slice(1));
		const f = p.d.facade;
		const ids = live(p);
		const block = ids.length > 0 ? pick(rng, ids) : null;
		const len = block === null ? 0 : f.displayLength(block);
		p.d.history.stopCapturing();
		if (roll < 4 || (p === suggester && record === null)) {
			record = S(suggester).open({ label: `s${step}` });
			log.push(`${step} open ${record}`);
		} else if (p === suggester && block !== null) {
			// A suggestion: the plan the facade prepares, written as the record.
			const kind = int(rng, 0, 9);
			const offset = int(rng, 0, len);
			const plan =
				kind < 4
					? f.prepare.insertText(block, offset, alpha(rng, int(rng, 1, 4)))
					: kind < 6
						? f.prepare.deleteText(block, Math.min(offset, Math.max(0, len - 1)), int(rng, 1, 3))
						: kind === 6
							? f.prepare.splitBlock(block, offset, `n${seed}x${fresh++}`)
							: kind === 7
								? f.prepare.setBlockType(block, bool(rng) ? 'heading' : 'quote')
								: kind === 8
									? f.prepare.formatRange(block, 0, Math.max(1, Math.min(len, 3)), { bold: true })
									: bool(rng)
										? f.prepare.deleteBlock(block)
										: f.prepare.moveBlocks([block], { parent: null, index: 0 });
			const { result } = S(suggester).apply(record!, plan);
			log.push(`${step} suggest ${kind} ${block}@${offset} → ${result.status}`);
			if (kind === 9 && 'writes' in plan && plan.writes.some((w) => w.op === 'moveBlocks'))
				expect(result.status).toBe('refused');
		} else if (roll < 60 && block !== null) {
			// A plain edit by a reviewer.
			const offset = int(rng, 0, len);
			if (bool(rng)) f.insertText(block, offset, alpha(rng, int(rng, 1, 3)));
			else if (len > 0) f.deleteText(block, Math.min(offset, len - 1), 1);
			log.push(`${step} edit ${peers.indexOf(p)} ${block}@${offset}`);
		} else if (roll < 85) {
			// A decision of a reviewer: one change, or a whole suggestion.
			const changes = S(p).changes();
			if (changes.length > 0) {
				const change = pick(rng, changes);
				const scope = bool(rng, 0.25)
					? changes.filter((c) => c.suggestion === change.suggestion)
					: [change];
				const accept = bool(rng);
				S(p).run(S(p).decide(scope, accept));
				log.push(`${step} ${accept ? 'accept' : 'reject'} ${peers.indexOf(p)} ${scope.length}`);
			}
		} else if (roll < 95) {
			const undo = bool(rng, 0.7);
			if (undo) p.d.history.undo();
			else p.d.history.redo();
			log.push(`${step} ${undo ? 'undo' : 'redo'} ${peers.indexOf(p)}`);
		}
		// The network: each replica's updates go out in a random order, some late.
		for (const from of peers) {
			for (const update of from.outbox.splice(0))
				for (const to of peers) if (to !== from) to.inbox.push(update);
		}
		for (const to of peers) {
			if (!bool(rng, 0.6)) continue;
			const order = shuffled(rng, to.inbox.splice(0));
			const late = order.length > 1 && bool(rng, 0.3) ? order.splice(0, 1) : [];
			for (const update of order) Y.applyUpdate(to.d.doc, update, 'remote');
			to.inbox.push(...late);
		}
	}
	// Heal: everything delivered, then a full state-vector exchange.
	for (const to of peers)
		for (const update of to.inbox.splice(0)) Y.applyUpdate(to.d.doc, update, 'remote');
	for (const a of peers)
		for (const b of peers)
			if (a !== b)
				Y.applyUpdate(
					b.d.doc,
					Y.encodeStateAsUpdate(a.d.doc, Y.encodeStateVector(b.d.doc)),
					'remote'
				);
	return { peers, log };
};

describe('shared suggestions, random schedules (sugg.*)', () => {
	it.each(SEEDS)('seed %i converges, its pending changes a function of the state', (seed) => {
		const { peers, log } = run(seed);
		const context = `seed ${seed}\n${log.join('\n')}`;
		const [first, ...rest] = peers;
		const expected = {
			shown: shown(first!.d),
			base: first!.d.toJSON(),
			changes: first!.d.facade.suggest.changes().map(describeChange)
		};
		for (const p of rest) {
			expect(shown(p.d), context).toEqual(expected.shown);
			expect(p.d.toJSON(), context).toEqual(expected.base);
			expect(p.d.facade.suggest.changes().map(describeChange), context).toEqual(expected.changes);
		}
		for (const p of peers) {
			// What the replica keeps equals a fresh reading of the same state.
			const fresh = E.create(p.d.doc as never).suggest;
			expect(fresh.changes().map(describeChange), context).toEqual(
				p.d.facade.suggest.changes().map(describeChange)
			);
			// The base lens: the document as it would be with every pending suggestion rejected.
			const copy = loadDocument(p.d.encode(), { actor: { id: 'oracle' } });
			copy.sync();
			const all = copy.facade.suggest;
			if (process.env.SUGG_DEBUG)
				console.log(
					'SHOWN',
					JSON.stringify(shown(copy).children.map((b) => [b.id, b.content])),
					'\nCHANGES',
					JSON.stringify(all.changes().map(describeChange))
				);
			all.run(all.decide(all.changes(), false));
			expect(shown(copy), context).toEqual(p.d.toJSON());
			expect(all.changes(), context).toEqual([]);
		}
	});
});
