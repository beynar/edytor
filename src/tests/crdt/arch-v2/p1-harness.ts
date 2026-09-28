/**
 * arch-v2 phase 2 P1 — the replica harness the ported review probes run on.
 *
 * The native branch's review probes (`review-probes/*.test.ts`) drive their
 * engine's `BoundaryDocument` (ops that return an operation, `receive`,
 * `pending`/`refused` outcomes). This harness gives the same probes the
 * arch-v2 surface instead: every replica is a real `EdytorDocument`
 * (`loadDocument` of one seed), every edit goes through `document.facade`
 * (`prepare`/`apply`), undo/redo through `document.history`, and remote
 * delivery through the sync protocol's admission (`crdt.sync.applyRemote`,
 * the inbound path the providers use). What the native probes call a
 * *refusal* is here an inbound update the admission gate reports as a
 * problem or cannot apply; what they call *pending* is an update the engine
 * holds back (`store.pendingStructs`/`pendingDs`) after everything was
 * delivered.
 *
 * Nothing here decides an expected value: the probes' literal expectations
 * come from `docs/editor-delete-contract.md` and plan §8.
 */
// @ts-nocheck -- tests drive the vendored engine and the facade through untyped fixtures.
import { Y } from '../../../lib/crdt/engine.js';
import { bindCrdt, createDocument, loadDocument } from '../../../lib/crdt/index.js';
import { setDocRand } from '../../../lib/crdt/rand.js';
import { mulberry32 } from '../harness/rng.js';

export const crdt = bindCrdt(Y);

/** Transport origin for remote updates — like a provider, never a tracked origin. */
export const REMOTE = Object.freeze({ p1: 'remote' });

/** Seed block, native-probe shaped: `{ id, text, children? }`. */
export type SeedBlock = {
	id: string;
	text?: string;
	type?: string;
	data?: Record<string, unknown>;
	/** Raw JSON content (inline atoms); `text` otherwise. */
	content?: unknown[];
	children?: SeedBlock[];
};

const jsonBlock = (s: SeedBlock) => ({
	id: s.id,
	type: s.type ?? 'paragraph',
	...(s.data ? { data: s.data } : {}),
	content: s.content ?? (s.text ? [{ text: s.text }] : []),
	...(s.children?.length ? { children: s.children.map(jsonBlock) } : {})
});

/** One seed update every replica loads (shared identities for seeded content). */
export const seedUpdate = (seeds: readonly SeedBlock[], semantics?: unknown): Uint8Array => {
	const document = createDocument({ value: { children: seeds.map(jsonBlock) }, semantics });
	const bytes = document.encode();
	document.destroy();
	return bytes;
};

export type Replica = ReturnType<typeof replica>;

/**
 * A replica: a document loaded from `seed`, a fixed client id, a
 * deterministic rank stream, and the log of every update it authored.
 */
export const replica = (
	name: string,
	seed: Uint8Array,
	clientID: number,
	opts: { semantics?: unknown; salt?: number } = {}
) => {
	const document = loadDocument(seed, {
		actor: { id: name },
		history: { captureTimeout: 0 },
		semantics: opts.semantics
	});
	const doc = document.doc;
	doc.clientID = clientID;
	setDocRand(doc, mulberry32(clientID * 7919 + (opts.salt ?? 0)));
	const log: Uint8Array[] = [];
	const problems: string[] = [];
	doc.on('update', (update: Uint8Array, origin: unknown) => {
		if (origin !== REMOTE) log.push(update);
	});
	const ed = document.facade;
	const r = {
		name,
		document,
		doc,
		ed,
		log,
		/** Admission problems and unapplied updates seen on receive (the native "refused"). */
		problems,
		/** Deliver one update through the providers' inbound admission. */
		receive(update: Uint8Array) {
			const { applied, problem } = crdt.sync.applyRemote(doc, update, REMOTE);
			if (problem !== null) problems.push(`${name}: admission problem ${JSON.stringify(problem)}`);
			else if (!applied) problems.push(`${name}: update not applied`);
		},
		receiveAll(updates: readonly Uint8Array[]) {
			for (const u of updates) r.receive(u);
		},
		/** The updates `fn` authored (one per transaction). */
		capture(fn: () => unknown): Uint8Array[] {
			const from = log.length;
			fn();
			return log.slice(from);
		},
		undo: () => document.history.undo(),
		redo: () => document.history.redo(),
		/** Updates the engine holds back (missing dependencies). */
		pending: () => doc.store.pendingStructs !== null || doc.store.pendingDs !== null,
		canonical: () => JSON.stringify(ed.toJSON()),
		tree: () => tree(ed),
		texts: () => ed.order().map((id: string) => ed.blockText(id)),
		destroy: () => document.destroy()
	};
	return r;
};

/** Native-probe style readable tree: `id:"text"[children]`, inline atoms as `⟨type⟩`. */
export const tree = (ed): string => {
	const show = (b): string => {
		const text = (b.content ?? [])
			.map((c) => (c.text !== undefined ? c.text : `⟨${c.type}⟩`))
			.join('');
		const kids = b.children?.length ? `[${b.children.map(show).join(',')}]` : '';
		return `${b.id}:${JSON.stringify(text)}${kids}`;
	};
	return ed.toJSON().children.map(show).join(' ');
};

/** Every visible character's text, document order. */
export const allText = (ed): string =>
	ed
		.order()
		.map((id: string) => ed.blockText(id))
		.join('');

/** Deliver every update of every replica to every other replica, `rounds` times. */
export const syncAll = (reps: Replica[], rounds = 1) => {
	for (let k = 0; k < rounds; k++) {
		for (const to of reps) {
			for (const from of reps) {
				if (to !== from) to.receiveAll(from.log);
			}
		}
	}
};

/**
 * Exchange updates until nobody authors anything new. A remote update can
 * make a replica write on its own: the engine's formatting cleanup
 * (`cleanupYTextAfterTransaction`) deletes format items made redundant by a
 * remote change, in a separate local transaction whose outcome depends on
 * the order updates arrived in. Those writes are ordinary updates a provider
 * broadcasts (their origin is not the transport's), so convergence is only
 * defined once they have propagated too — every replica, the passive
 * observers included, takes part.
 */
export const quiesce = (reps: Replica[], limit = 8) => {
	for (let k = 0; k < limit; k++) {
		const before = reps.reduce((n, r) => n + r.log.length, 0);
		syncAll(reps);
		if (reps.reduce((n, r) => n + r.log.length, 0) === before) return;
	}
	throw new Error(`no quiescence after ${limit} rounds`);
};

/** A fresh document built from `r`'s bytes alone (the binary reload of §8). */
export const reloadCanonical = (r: Replica): string => {
	const fresh = loadDocument(Y.encodeStateAsUpdate(r.doc), { actor: { id: `${r.name}-reload` } });
	const out = JSON.stringify(fresh.facade.toJSON());
	fresh.destroy();
	return out;
};

/**
 * Structural well-formedness, checked test-side on the projection: every
 * block id appears once, every visible character's identity once.
 */
export const wellFormed = (ed): string[] => {
	const problems: string[] = [];
	const ids = new Set<string>();
	const atoms = new Set<string>();
	const visit = (b, parent: string | null) => {
		if (ids.has(b.id)) problems.push(`duplicate block ${b.id}`);
		ids.add(b.id);
		if (ed.parentOf(b.id) !== parent)
			problems.push(`parent of ${b.id}: ${ed.parentOf(b.id)} != ${parent}`);
		const len = ed.displayLength(b.id);
		for (let k = 0; k < len; k++) {
			const a = ed.anchorAt(b.id, k, 'right');
			const key = a?.a?.i ? `${a.a.i.c}:${a.a.i.k}` : null;
			if (key === null) continue;
			if (atoms.has(key)) problems.push(`duplicate atom ${key} (in ${b.id}@${k})`);
			atoms.add(key);
		}
		for (const c of b.children ?? []) visit(c, b.id);
	};
	for (const b of ed.toJSON().children) visit(b, null);
	const order = ed.order();
	if (order.length !== ids.size || new Set(order).size !== order.length) {
		problems.push(`order has ${order.length} ids, tree has ${ids.size}`);
	}
	return problems;
};

/** All permutations (small inputs only). */
export const permutations = <T>(xs: T[]): T[][] =>
	xs.length <= 1
		? [xs]
		: xs.flatMap((x, i) =>
				permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])
			);

/** Client-id assignments per replica count (≥ 3 each; plan §8 multi-replica rule). */
export const CLIENT_IDS: Record<number, number[][]> = {
	1: [[11], [900], [55]],
	2: [
		[20, 30],
		[30, 20],
		[7, 100]
	],
	3: [
		[20, 30, 40],
		[40, 30, 20],
		[30, 40, 20]
	]
};

export type Outcome = {
	/** Canonical JSON of every replica, every observer, every reload — one value when converged. */
	results: Set<string>;
	problems: string[];
	/** Replica 0 after convergence. */
	ed: Replica['ed'];
	reps: Replica[];
};

/**
 * The §8 multi-replica rule for one scenario: run `program` on fresh
 * replicas for each client-id assignment, deliver everything both ways
 * (twice — duplicates), feed an observer in both orders (each update twice),
 * reload every replica from bytes, and collect every canonical value.
 * `program` receives the replicas and returns nothing; it may deliver
 * selectively itself (offline windows, held updates).
 */
export const converge = (
	seeds: readonly SeedBlock[],
	count: number,
	program: (reps: Replica[]) => void,
	opts: { semantics?: unknown; assignments?: number[][] } = {}
): Outcome[] => {
	const seed = seedUpdate(seeds, opts.semantics);
	const outcomes: Outcome[] = [];
	for (const ids of opts.assignments ?? CLIENT_IDS[count] ?? CLIENT_IDS[3]) {
		const reps = ids
			.slice(0, count)
			.map((cid, i) => replica(String.fromCharCode(65 + i), seed, cid, opts));
		program(reps);
		const all = reps.flatMap((r) => r.log);
		const results = new Set<string>();
		const problems: string[] = [];
		const observers = [all, [...all].reverse()].map((order, i) => {
			const obs = replica(`observer${i}`, seed, 998 + i, opts);
			for (const u of order) {
				obs.receive(u);
				obs.receive(u);
			}
			if (obs.pending()) problems.push(`${obs.name}: pending after full delivery`);
			return obs;
		});
		quiesce([...reps, ...observers]);
		for (const obs of observers) {
			problems.push(...obs.problems);
			results.add(obs.canonical());
			obs.destroy();
		}
		for (const r of reps) {
			if (r.pending()) problems.push(`${r.name}: pending after full delivery`);
			problems.push(...r.problems);
			problems.push(...wellFormed(r.ed).map((p) => `${r.name}: ${p}`));
			results.add(r.canonical());
			results.add(reloadCanonical(r));
		}
		outcomes.push({ results, problems, ed: reps[0].ed, reps });
	}
	return outcomes;
};
