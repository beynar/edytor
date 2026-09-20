/**
 * Seeded random-op schedule generator for the CRDT corpus (U02 §5).
 *
 * A schedule is a deterministic list of steps: `{peer, op}`. Ops reference
 * target blocks by INDEX into the executing peer's live projection
 * (`idIndex % ids.length`) so a schedule stays meaningful as replicas
 * diverge — the peer's own view decides which block an op touches.
 *
 * Network events are interleaved in the same stream, so connectivity is part
 * of the seed: partitions, heals, partial deliveries, duplicates, drops,
 * reloads and both sync modes.
 */
import { int, pick, bool, alpha, mulberry32, type Rng } from '../harness/rng.js';
import type { BlockId } from '../harness/ops/crdt-ops.js';

export type DocOp =
	| { kind: 'insertBlock'; id: BlockId; type: string }
	| { kind: 'deleteBlock'; idIndex: number }
	| { kind: 'moveBlock'; idIndex: number; parentIndex: number; destIndex: number }
	| { kind: 'nest'; idIndex: number; parentIndex: number }
	| { kind: 'unNest'; idIndex: number }
	| { kind: 'split'; idIndex: number; offset: number; newId: BlockId }
	| { kind: 'merge'; fromIndex: number; intoIndex: number }
	| { kind: 'insertText'; idIndex: number; offset: number; text: string; tag: string }
	| { kind: 'deleteText'; idIndex: number; offset: number; length: number }
	| { kind: 'setMark'; idIndex: number; offset: number; length: number; name: string }
	| { kind: 'unsetMark'; idIndex: number; offset: number; length: number; name: string }
	| { kind: 'insertInline'; idIndex: number; offset: number; atomId: string }
	| { kind: 'removeInline'; idIndex: number; inlineIndex: number };

export type NetOp = {
	kind: 'net';
	action:
		| 'deliver'
		| 'deliverReverse'
		| 'duplicate'
		| 'batch'
		| 'deliverAll'
		| 'drop'
		| 'partition'
		| 'heal'
		| 'isolate'
		| 'healPeer'
		| 'syncSV'
		| 'syncFull'
		| 'persist'
		| 'reloadSnap'
		| 'reloadLog';
	/** peer indexes for directed edge ops (a→b); only `a` used for isolate etc. */
	a: number;
	b: number;
};

export type Step = { peer: number; op: DocOp | NetOp };

export type Schedule = {
	seed: number;
	peers: number;
	steps: Step[];
};

const MARKS = ['bold', 'italic', 'underline', 'code'];
const BLOCK_TYPES = ['paragraph', 'list', 'quote'];
const INLINE_TYPES = ['mention', 'chip'];

/** Weighted pick of a document op. */
const genDocOp = (rng: Rng, seed: number, seq: number): DocOp => {
	const roll = int(rng, 0, 99);
	if (roll < 24) {
		// 24% insert text (unique tag lets the runner detect lost edits)
		return {
			kind: 'insertText',
			idIndex: int(rng, 0, 7),
			offset: int(rng, 0, 20),
			text: `µ${seed}x${seq}`,
			tag: `µ${seed}x${seq}`
		};
	}
	if (roll < 33) {
		return {
			kind: 'deleteText',
			idIndex: int(rng, 0, 7),
			offset: int(rng, 0, 20),
			length: int(rng, 1, 5)
		};
	}
	if (roll < 42) {
		return {
			kind: 'setMark',
			idIndex: int(rng, 0, 7),
			offset: int(rng, 0, 15),
			length: int(rng, 1, 8),
			name: pick(rng, MARKS)
		};
	}
	if (roll < 46) {
		return {
			kind: 'unsetMark',
			idIndex: int(rng, 0, 7),
			offset: int(rng, 0, 15),
			length: int(rng, 1, 8),
			name: pick(rng, MARKS)
		};
	}
	if (roll < 52) {
		return {
			kind: 'insertInline',
			idIndex: int(rng, 0, 7),
			offset: int(rng, 0, 10),
			atomId: `in${seed}-${seq}`
		};
	}
	if (roll < 55) {
		return { kind: 'removeInline', idIndex: int(rng, 0, 7), inlineIndex: int(rng, 0, 4) };
	}
	if (roll < 64) {
		return { kind: 'insertBlock', id: `s${seed}-${seq}`, type: pick(rng, BLOCK_TYPES) };
	}
	if (roll < 70) {
		return { kind: 'deleteBlock', idIndex: int(rng, 0, 7) };
	}
	if (roll < 80) {
		return {
			kind: 'moveBlock',
			idIndex: int(rng, 0, 7),
			parentIndex: int(rng, 0, 7), // resolves over ids + root slot
			destIndex: int(rng, 0, 6)
		};
	}
	if (roll < 84) {
		return { kind: 'nest', idIndex: int(rng, 0, 7), parentIndex: int(rng, 0, 7) };
	}
	if (roll < 87) {
		return { kind: 'unNest', idIndex: int(rng, 0, 7) };
	}
	if (roll < 93) {
		return {
			kind: 'split',
			idIndex: int(rng, 0, 7),
			offset: int(rng, 0, 15),
			newId: `sp${seed}-${seq}`
		};
	}
	return { kind: 'merge', fromIndex: int(rng, 0, 7), intoIndex: int(rng, 0, 7) };
};

const NET_ACTIONS: NetOp['action'][] = [
	'deliver',
	'deliver',
	'deliverReverse',
	'duplicate',
	'batch',
	'deliverAll',
	'deliverAll',
	'drop',
	'partition',
	'heal',
	'heal',
	'isolate',
	'healPeer',
	'syncSV',
	'syncSV',
	'syncFull',
	'persist',
	'reloadSnap',
	'reloadLog'
];

/**
 * Generate a `ops`-step schedule for `peers` peers. Roughly a quarter of the
 * steps are network events; the rest are document ops spread over the peers.
 */
export const generateSchedule = (seed: number, peers = 3, ops = 200): Schedule => {
	const rng = mulberry32(seed);
	const steps: Step[] = [];
	for (let i = 0; i < ops; i++) {
		const peer = int(rng, 0, peers - 1);
		// ~27% network event, else a document op
		if (bool(rng, 0.27)) {
			const a = int(rng, 0, peers - 1);
			let b = int(rng, 0, peers - 1);
			if (b === a) b = (b + 1) % peers;
			steps.push({ peer, op: { kind: 'net', action: pick(rng, NET_ACTIONS), a, b } });
		} else {
			steps.push({ peer, op: genDocOp(rng, seed, i) });
		}
	}
	return { seed, peers, steps };
};

/**
 * The bounded CI corpus: fixed seeds so a regression always maps to a
 * committed number. ≥100 per the plan's coverage target.
 */
export const CORPUS_SEEDS: number[] = Array.from({ length: 150 }, (_, i) => i + 1);
