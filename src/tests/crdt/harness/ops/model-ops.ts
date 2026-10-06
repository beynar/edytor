/**
 * `ModelOps` — the `CrdtOps` adapter for the U03 placement model
 * (`src/lib/crdt/placement/model.ts` via `bindModel`).
 *
 * Unlike `RawNodeOps` this adapter preserves engine identity across every
 * structural op: moves, nests, splits and merges write placement candidates —
 * no payload is ever copied or rebuilt. `preservesIdentityOnMove` /
 * `preservesIdentityOnSplitMerge` are therefore true, which turns the copy
 * evidence classes (duplicate placement, resurrected delete, lost identity,
 * cycle) into hard failures under this adapter — exactly what U03 must prove.
 *
 * Adapter contract notes:
 *
 * - `Destination.index` uses final-index semantics (counts the destination's
 *   children after removing the moving block when it is already under that
 *   parent) — identical to the raw adapter and the plan's proposed default.
 * - Every mutating op runs inside `peer.transact` so it carries the peer's
 *   local origin (undo tracking). The model's own `doc.transact` calls then
 *   join that outer transaction.
 * - Ops on unresolvable targets return `false`/`null` without mutating;
 *   a local move into the block's own subtree is rejected the same way.
 * - Deletion is an explicit `del` flag that wins over any concurrent
 *   placement — a deleted block's subtree is hidden with it.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import * as Y from '../../../../lib/crdt/vendor/yjs/src/index.js';
import { bindModel } from '../../../oracles/model-ops.js';
import { clientsOf, structAt } from '../../../../lib/crdt/structs.js';
import { readData } from '../../../../lib/crdt/data.js';
import { bindText, DEAD, canonKey, cmpStamp, isBoundary } from '../../../../lib/crdt/text/model.js';
import type { Peer } from '../peer-set.js';
import type {
	AtomFate,
	BlockId,
	CrdtOps,
	DeadCause,
	OpState,
	OpTarget,
	StampKey,
	TagClassifyContext
} from './crdt-ops.js';

const M = bindModel(Y);
const T = bindText(Y);

/**
 * Registry-completeness oracle (gate-1 finding #3): the set of block ids the
 * projection MUST contain on this peer — every registry entry that is live
 * (`del` unset), self-owned (not merged away) and whose DISPLAY-parent chain
 * (`owner(placementParent)`, the relation `resolvePlacements` keeps acyclic)
 * reaches the root without passing through a deleted ancestor.
 *
 * A block on a cyclic display chain still counts as expected — a composed
 * cycle is the bug being guarded against, not a hiding policy — so a
 * regression that reintroduces it is flagged `unreachable-block` instead of
 * silently passing. A `del`-flagged ancestor hides nothing: its unmarked
 * children take its slot (read-time promotion, UW-08), so the chain goes on
 * through it; only an unintegrated parent ends it (hidden).
 */
export const expectedProjectedIds = (peer: Peer): Set<string> => {
	const doc = peer.doc;
	const blocks = M.collectBlocks(doc);
	const own = T.computeOwnership(doc, blocks);
	const placements = M.resolvePlacements(blocks, own.ownerOf);
	const expected = new Set<string>();
	for (const [id, rec] of blocks) {
		if (rec.deleted || own.hidden(id)) continue;
		let cur = id;
		const seen = new Set<string>([id]);
		let legitimatelyHidden = false;
		for (;;) {
			const pl = placements.get(cur);
			if (pl === undefined || pl.parent === null) break; // reached the root
			let dp = own.ownerOf(pl.parent);
			if (dp === DEAD) {
				// A `del`-flagged holder promotes: walk on from it. A DEAD
				// verdict on a live parent is an ownership bug, so keep the
				// block expected; an unintegrated parent hides it.
				const prec = blocks.get(pl.parent);
				if (prec === undefined) legitimatelyHidden = true;
				if (prec === undefined || !prec.deleted) break;
				dp = pl.parent;
			}
			if (seen.has(dp)) break; // composed display cycle → still expected
			seen.add(dp);
			cur = dp;
		}
		if (!legitimatelyHidden) expected.add(id);
	}
	return expected;
};

/**
 * The `promotion-hidden` oracle input (UW-08): live (unmarked), self-owned
 * blocks with a delete-marked holder on their display-parent chain that the
 * projection does not show — read-time promotion must put them in the
 * holder's slot. `dissolved`: blocks the layout rules hide (`layout.*`: an
 * empty or bare column, a layout showing one column) — their children show.
 */
export const hiddenUnderDeleted = (
	doc: Peer['doc'],
	dissolved: (id: string) => boolean = () => false
): string[] => {
	const blocks = M.collectBlocks(doc);
	const own = T.computeOwnership(doc, blocks);
	const placements = M.resolvePlacements(blocks, own.ownerOf);
	const shown = new Set(M.listBlockIds(doc));
	const out: string[] = [];
	for (const [id, rec] of blocks) {
		if (rec.deleted || own.hidden(id) || shown.has(id) || dissolved(id)) continue;
		const seen = new Set<string>([id]);
		for (let cur = id; ; ) {
			const pl = placements.get(cur);
			if (pl === undefined || pl.parent === null) break;
			const dp = own.ownerOf(pl.parent);
			if (dp === DEAD) {
				if (blocks.get(pl.parent)?.deleted) out.push(id);
				break;
			}
			if (seen.has(dp)) break;
			seen.add(dp);
			cur = dp;
		}
	}
	return out;
};

/**
 * The `sealed-line` oracle input (XW-10): the display owner of each block's
 * stored parent (`DEAD` → `'dead'`), read from the registry once per call.
 */
export const storedParentOf = (doc: Peer['doc']): ((id: string) => string | null) => {
	const blocks = M.collectBlocks(doc);
	const own = T.computeOwnership(doc, blocks);
	const placements = M.resolvePlacements(blocks, own.ownerOf);
	return (id) => {
		const parent = placements.get(id)?.parent ?? null;
		if (parent === null) return null;
		const owner = own.ownerOf(parent);
		return owner === DEAD ? 'dead' : owner;
	};
};

/** The `seed-displacement` oracle input: the engine id of `id`'s registry node. */
export const registryIdentity = (doc: Peer['doc'], id: string): string | null => {
	const item = M.blockNodeOf(doc, id)?._item;
	return item?.id ? `${item.id.client}:${item.id.clock}` : null;
};

/**
 * The `seed-displacement` oracle's causal test: whether registry item
 * `later` was written after `earlier` on its key (its origin chain reaches
 * it — a redo re-creating an undone block), rather than concurrently with it
 * (a seed or a peer racing the key — a displacement).
 */
export const succeeds = (doc: Peer['doc'], later: string, earlier: string): boolean => {
	const clients = clientsOf(doc);
	const [client, clock] = later.split(':').map(Number);
	let id: { client: number; clock: number } | null = { client, clock };
	for (let hops = 0; id !== null && hops < 64; hops++) {
		if (`${id.client}:${id.clock}` === earlier) return true;
		const item = structAt(Y, clients.get(id.client) ?? [], id.clock) as { origin?: typeof id };
		id = item?.origin ?? null;
	}
	return false;
};

const isNodeLike = (v: unknown): v is { getAttr: (k: string) => unknown } =>
	v != null && typeof (v as { getAttr?: unknown }).getAttr === 'function';

/**
 * Per-atom walk of a content node's item list. Returns one entry per atom
 * (`{c,k}` engine id, `ch` for text — non-string payloads contribute a
 * `\0` placeholder that no generated tag can match), with `deleted` marking
 * tombstoned items and `pos` counting LIVE positions only — the same
 * indexing the ownership intervals use.
 *
 * U5: every row also carries canonical fingerprints of the atom's rich
 * state — `marksKey`/`marksObj` = the folded mark map at the atom's
 * position (tombstoned markers don't apply — the same skip the range
 * reader performs), `payload` = an inline atom's `{id,type,data}` canon
 * (`''` for text atoms), `inlineId` when the atom is an inline node.
 */
type AtomRow = {
	c: number;
	k: number;
	ch: string;
	deleted: boolean;
	pos: number;
	marksKey: string;
	marksObj: Record<string, unknown> | undefined;
	payload: string;
	inlineId?: string;
	/** A stream boundary item (R2) — a claim, not content. */
	boundary?: { s: string; n: unknown };
};

const atomRows = (text: unknown): AtomRow[] => {
	const atoms: AtomRow[] = [];
	let pos = 0;
	let formats: Record<string, unknown> | undefined;
	let formatsKey = '';
	let open: Record<string, unknown[][]> = {};
	for (let it = (text as { _start?: never })._start; it !== null; it = it.right) {
		if (it.deleted) continue;
		const countable = it.content.isCountable ? it.content.isCountable() : true;
		if (!countable) {
			// Live ContentFormat marker — fold into mark state (COW).
			const key = it.content.key;
			if (typeof key === 'string') {
				formats = { ...formats };
				const role = key.charCodeAt(0);
				if (role === 1 || role === 2) {
					// H5 paired marks (P13): a start `\u0001mark` opens `[v, l, c, k]`,
					// an end `\u0002mark` closes its own start `[c, k]`; the mark
					// shows the open operation with the greatest `(l, c, k)`.
					const mark = key.slice(1);
					const v = it.content.value as unknown[];
					const ops = (open[mark] ?? []).filter(
						(o) => role === 1 || o[2] !== v[0] || o[3] !== v[1]
					);
					if (role === 1) ops.push(v);
					open = { ...open, [mark]: ops };
					const win = [...ops].sort(
						(a, b) =>
							(b[1] as number) - (a[1] as number) ||
							(b[2] as number) - (a[2] as number) ||
							(b[3] as number) - (a[3] as number)
					)[0];
					if (win === undefined || win[0] == null) delete formats[mark];
					else formats[mark] = win[0];
				} else if (it.content.value == null) delete formats[key];
				else formats[key] = it.content.value;
				formatsKey = canonKey(formats);
			}
			continue;
		}
		const arr = it.content.getContent();
		const n = Math.min(arr.length, it.length);
		for (let j = 0; j < n; j++) {
			const v = arr[j];
			const inline = isNodeLike(v);
			atoms.push({
				c: it.id.client,
				k: it.id.clock + j,
				ch: typeof v === 'string' ? v : '\0',
				deleted: false,
				pos: pos++,
				marksKey: formatsKey,
				marksObj: formats,
				payload: inline
					? canonKey({ id: v.getAttr('id'), type: v.getAttr('type'), data: readData(v) })
					: '',
				...(inline ? { inlineId: v.getAttr('id') as string } : {}),
				...(isBoundary(v) ? { boundary: { s: v.s, n: v.n } } : {})
			});
		}
		pos += it.length - n;
	}
	// Tombstoned items are walked in a second pass — they occupy no live
	// position and tombstoned markers apply to nothing.
	for (let it = (text as { _start?: never })._start; it !== null; it = it.right) {
		if (!it.deleted) continue;
		const countable = it.content.isCountable ? it.content.isCountable() : true;
		if (!countable) continue;
		const arr = it.content.getContent();
		const n = Math.min(arr.length, it.length);
		for (let j = 0; j < n; j++) {
			const v = arr[j];
			const inline = isNodeLike(v);
			atoms.push({
				...(isBoundary(v) ? { boundary: { s: v.s, n: v.n } } : {}),
				c: it.id.client,
				k: it.id.clock + j,
				ch: typeof v === 'string' ? v : '\0',
				deleted: true,
				pos: -1,
				marksKey: '',
				marksObj: undefined,
				payload: inline
					? canonKey({ id: v.getAttr('id'), type: v.getAttr('type'), data: readData(v) })
					: '',
				...(inline ? { inlineId: v.getAttr('id') as string } : {})
			});
		}
	}
	return atoms;
};

const atomKey = (a: { c: number; k: number }): StampKey => `${a.c}:${a.k}`;
const stampKey = (s: { c: number; k: number }): StampKey => `${s.c}:${s.k}`;
const PSEUDO_STAMP: StampKey = '-1:-1';

/**
 * Strict-oracle locate (WU3): which backing text carries `tag`, and the
 * engine ids of its atoms — recorded at insert time so the barrier can
 * check each atom's fate even after the tag's characters are later cut
 * apart by splits, merges or deletes.
 *
 * `onlyNew` (U5 collision fix): the generator's tag space
 * (`µ<seed>x<seq>`) is prefix-shared, so the same substring can occur
 * coincidentally, assembled from surviving FRAGMENTS of other inserts
 * (e.g. "µ26x1"+"49" next to each other spells "µ26x149"). Substring
 * search alone can therefore return atoms the tracked insert never wrote
 * — the oracle would then track and classify the wrong atoms
 * (seed-26 `µ26x149` matched a stale assembly under `b3` while the real
 * atoms sat in the insert's target text → false `stolen-edit`). When the
 * caller supplies the op's `diff.atomsNew` set, only an occurrence
 * composed ENTIRELY of fresh atoms is accepted; if none qualifies the
 * result is `null` — the same "success but no findable atoms" lost-edit
 * signature the oracle already treats as real loss.
 */
export const locateTagAtoms = (
	peer: Peer,
	tag: string,
	onlyNew?: ReadonlySet<StampKey>
): {
	textId: string;
	atoms: { c: number; k: number }[];
	/** Birth fingerprints per atom (U5): marks canon + map / payload canon. */
	meta: { marks: string; marksObj?: Record<string, unknown>; payload: string }[];
} | null => {
	const blocks = M.collectBlocks(peer.doc);
	let first: {
		textId: string;
		atoms: { c: number; k: number }[];
		meta: { marks: string; marksObj?: Record<string, unknown>; payload: string }[];
	} | null = null;
	for (const [id, rec] of blocks) {
		if (!rec.content) continue;
		const atoms = atomRows(rec.content).filter((a) => !a.deleted);
		const hay = atoms.map((a) => a.ch).join('');
		for (let idx = hay.indexOf(tag); idx >= 0; idx = hay.indexOf(tag, idx + 1)) {
			const slice = atoms.slice(idx, idx + tag.length);
			const found = {
				textId: id,
				atoms: slice.map(({ c, k }) => ({ c, k })),
				meta: slice.map(({ marksKey, marksObj, payload }) => ({
					marks: marksKey,
					marksObj,
					payload
				}))
			};
			if (onlyNew === undefined) return found;
			first ??= found;
			if (found.atoms.every((a) => onlyNew.has(`${a.c}:${a.k}`))) return found;
		}
	}
	// No all-fresh occurrence: under `onlyNew` the insert's own atoms never
	// assembled the tag — report nothing rather than borrowing stale atoms.
	return onlyNew === undefined ? first : null;
};

/** The records with their effective claims (`merge.claim.anchor`), as the ownership read them. */
const effective = <R extends { claims: unknown[] }>(
	blocks: Map<BlockId, R>,
	own: ReturnType<typeof T.computeOwnership>
): Map<BlockId, R> =>
	new Map(
		[...blocks].map(([id, rec]) => [
			id,
			{ ...rec, claims: [...(own.claimsOf?.(id) ?? rec.claims)] }
		])
	);

/**
 * Replicates `claimGraph`'s owner walk for ONE block, collecting the traversed
 * merge-claim stamps — the physical route from `id` to its display owner.
 * Returns the resolved owner (same verdict as `ownerOf(id)`), the claim stamps
 * in order, and — when the chain dies — the block id it died at (`end`).
 */
const ownerChain = (
	blocks: Map<
		BlockId,
		{ deleted: boolean; claims: { m: BlockId; stamp: { c: number; k: number } }[] }
	>,
	id: BlockId
): { owner: BlockId | typeof DEAD; route: StampKey[]; end?: BlockId } => {
	// claimsOn[X] = live `{m:X}` claims held by LIVE blocks (a claim on a
	// deleted list is inert).
	const claimsOn = new Map<BlockId, { claimer: BlockId; stamp: { c: number; k: number } }[]>();
	for (const [holderId, rec] of blocks) {
		if (rec.deleted) continue;
		for (const c of rec.claims) {
			const list = claimsOn.get(c.m) ?? [];
			list.push({ claimer: holderId, stamp: c.stamp });
			claimsOn.set(c.m, list);
		}
	}
	const topClaim = (x: BlockId) => {
		const claims = claimsOn.get(x);
		if (!claims || claims.length === 0) return null;
		let best = claims[0];
		for (const c of claims) if (cmpStamp(c.stamp, best.stamp) > 0) best = c;
		return best;
	};
	const route: StampKey[] = [];
	const path: BlockId[] = [];
	let cur = id;
	for (;;) {
		const rec = blocks.get(cur);
		if (!rec || rec.deleted) return { owner: DEAD, route, end: cur };
		if (path.includes(cur)) {
			const cycle = path.slice(path.indexOf(cur));
			let winner: BlockId = cur;
			let winnerStamp: { c: number; k: number } | null = null;
			for (const member of cycle) {
				const top = topClaim(member)!;
				if (winnerStamp === null || cmpStamp(top.stamp, winnerStamp) > 0) {
					winnerStamp = top.stamp;
					winner = top.claimer;
				}
			}
			route.push(stampKey(winnerStamp!));
			return { owner: winner, route };
		}
		const top = topClaim(cur);
		if (top === null) return { owner: cur, route };
		path.push(cur);
		route.push(stampKey(top.stamp));
		cur = top.claimer;
	}
};

/**
 * The stream holding live position `pos` of `home`'s text (R2), and the
 * "claim" that puts it there: the stream's delimiting boundary item, or the
 * pseudo stamp for the head of a block's own text.
 */
const streamAt = (own: ReturnType<typeof T.computeOwnership>, home: BlockId, pos: number) => {
	const s = own.streamsIn(home).find((x) => x.start <= pos && pos < x.end);
	if (s === undefined) return undefined;
	if (s.home === s.block && s.start === 0) return { s, via: PSEUDO_STAMP };
	const boundary = atomRows(s.text).find((a) => !a.deleted && a.pos === s.start - 1);
	return { s, via: boundary === undefined ? PSEUDO_STAMP : atomKey(boundary) };
};

/**
 * Strict-oracle classify (WU3): for each tracked atom, where it ended up in
 * the converged state on `peer`. The per-atom verdict distinguishes the
 * three outcomes the plan requires the oracle to separate — explicit
 * deletion (`tombstoned`, `dead-owner`), owner-move (`moved`) and actual
 * loss (`uncovered`, `gone`, `unreachable`). A position resolves to the
 * stream holding it (R2) and that stream's display owner, so content of a
 * merged-away block still counts as displayed by its owner.
 *
 * `context` supplies the schedule-side causal expectations (gate-F1 F3 —
 * {@link TagClassifyContext}): a foreign visible owner that no recorded
 * split/merge produced, or one that already owned the atoms at insert time,
 * classifies `stolen` rather than `moved`.
 */
export const classifyTagAtoms = (
	peer: Peer,
	target: BlockId,
	atoms: { c: number; k: number }[],
	context?: TagClassifyContext
): AtomFate[] => {
	const doc = peer.doc;
	const blocks = M.collectBlocks(doc);
	const own = T.computeOwnership(doc, blocks);
	const expected = expectedProjectedIds(peer);
	const projectedIds = new Set(M.listBlockIds(doc));
	const index = new Map<
		string,
		{
			textId: string;
			deleted: boolean;
			pos: number;
			marks: string;
			marksObj: Record<string, unknown> | undefined;
			payload: string;
		}
	>();
	for (const [tid, rec] of blocks) {
		if (!rec.content) continue;
		for (const a of atomRows(rec.content)) {
			index.set(atomKey(a), {
				textId: tid,
				deleted: a.deleted,
				pos: a.pos,
				marks: a.marksKey,
				marksObj: a.marksObj,
				payload: a.payload
			});
		}
	}
	// Store-level lookup for atoms the item walk did not find: a GC struct
	// or an item deleted with its text is a legit deletion; a live Item
	// outside every content text, a Skip, or no struct at all is gone.
	const storeFate = (a: { c: number; k: number }): AtomFate => {
		const structs = doc.store.clients.get(a.c);
		if (!structs || structs.length === 0 || a.k >= doc.store.getClock(a.c)) {
			return { kind: 'gone' } as AtomFate;
		}
		const idx = (Y.findIndexSS as (arr: unknown[], clock: number) => number)(structs, a.k);
		const struct = structs[idx];
		if (!struct || struct.id.clock > a.k || a.k >= struct.id.clock + struct.length) {
			return { kind: 'gone' } as AtomFate;
		}
		if (struct instanceof Y.GC || struct.deleted) return { kind: 'tombstoned' } as AtomFate;
		return { kind: 'gone' } as AtomFate;
	};
	// U5: an atom's display is authorized iff its stream's boundary AND every
	// merge claim on the stream block → owner route carry a stamp the executed
	// schedule wrote (`authorizedClaims`); pseudo stamps are exempt.
	const auth = context?.authorizedClaims;
	const authorized = (via: StampKey | undefined, route: StampKey[] | undefined): boolean => {
		if (auth === undefined) return true;
		if (via !== undefined && via !== PSEUDO_STAMP && !auth.has(via)) return false;
		return (route ?? []).every((s) => s === PSEUDO_STAMP || auth.has(s));
	};
	return atoms.map((a) => {
		const found = index.get(atomKey(a));
		if (!found) return storeFate(a);
		if (found.deleted) return { kind: 'tombstoned' } as AtomFate;
		const at = streamAt(own, found.textId, found.pos);
		if (at === undefined) return { kind: 'uncovered' } as AtomFate;
		const chain = ownerChain(effective(blocks, own), at.s.block);
		const owner = chain.owner;
		const fields = { marks: found.marks, marksObj: found.marksObj, payload: found.payload };
		if (owner === DEAD) {
			return { kind: 'dead-owner', holders: [at.s.block], ...fields } as AtomFate;
		}
		const detail = { via: at.via, route: chain.route, ...fields };
		if (!authorized(at.via, chain.route)) return { kind: 'stolen', owner, ...detail } as AtomFate;
		if (owner === target) return { kind: 'present', ...detail } as AtomFate;
		if (!expected.has(owner))
			return { kind: 'dead-owner', holders: [owner], ...fields } as AtomFate;
		if (!projectedIds.has(owner)) return { kind: 'unreachable', owner, ...detail } as AtomFate;
		if (context !== undefined) {
			if (context.insertOwners?.has(owner)) {
				return { kind: 'stolen', owner, ...detail } as AtomFate;
			}
			if (
				context.legitOwners !== undefined &&
				context.authorizedClaims === undefined &&
				!context.legitOwners.has(owner)
			) {
				return { kind: 'stolen', owner, ...detail } as AtomFate;
			}
		}
		return { kind: 'moved', owner, ...detail } as AtomFate;
	});
};

/**
 * Loss-correlation oracle (gate-F1 F4): the engine ids each tracked atom's
 * display depends on — the boundary item that starts its stream (none for a
 * block's own-text head). The runner intersects these with the ids
 * observed-destroyed by lossy reloads.
 */
export const tagAtomDeps = (
	peer: Peer,
	textId: BlockId,
	atoms: { c: number; k: number }[]
): { c: number; k: number }[][] => {
	const doc = peer.doc;
	const blocks = M.collectBlocks(doc);
	const own = T.computeOwnership(doc, blocks);
	const text = blocks.get(textId)?.content;
	const positions = new Map<string, number>();
	if (text) for (const a of atomRows(text)) if (!a.deleted) positions.set(atomKey(a), a.pos);
	return atoms.map((a) => {
		const pos = positions.get(atomKey(a));
		const at = pos === undefined ? undefined : streamAt(own, textId, pos);
		if (at === undefined || at.via === PSEUDO_STAMP) return [];
		const [c, k] = at.via.split(':').map(Number);
		return [{ c, k }];
	});
};

// ── operation-intent oracle (hardening U5) ────────────────────────────
//
// The runner snapshots the replicated mutation surface around every
// scheduled op (`captureOpState` pre/post) and checks the diff against the
// envelope the op's KIND and resolved target allow. Under R2 a stream
// boundary is the claim a split writes: it is reported with the claims
// (`kind: 'slice'`, holder = the block it starts, `t` = its text), never as
// content.

/** Snapshot the full mutation surface — atoms, claims (merge claims and boundaries), block state. */
export const captureOpState = (peer: Peer): OpState => {
	const blocks = M.collectBlocks(peer.doc);
	const atoms: OpState['atoms'] = new Map();
	const claims: OpState['claims'] = new Map();
	const blocksOut: OpState['blocks'] = new Map();
	for (const [id, rec] of blocks) {
		for (const a of atomRows(rec.content ?? { _start: null })) {
			if (a.boundary !== undefined) {
				claims.set(atomKey(a), { holder: a.boundary.s, kind: 'slice', t: id, live: !a.deleted });
				continue;
			}
			atoms.set(atomKey(a), {
				text: id,
				live: !a.deleted,
				marks: a.marksKey,
				marksObj: a.marksObj,
				payload: a.payload
			});
		}
		// EVERY claims item — tombstoned included: a claim dying is a state
		// change the envelope must authorize.
		for (
			let it = (rec.claimsNode as { _start?: never } | undefined)?._start ?? null;
			it !== null;
			it = it.right
		) {
			const countable = it.content.isCountable ? it.content.isCountable() : true;
			if (!countable) continue;
			const arr = it.content.getContent();
			const n = Math.min(arr.length, it.length);
			for (let j = 0; j < n; j++) {
				const payload = arr[j];
				const m = typeof payload?.m === 'string' ? payload.m : undefined;
				claims.set(`${it.id.client}:${it.id.clock + j}`, {
					holder: id,
					kind: m === undefined ? 'other' : 'merge',
					m,
					live: !it.deleted
				});
			}
		}
		const delItems = [
			...((
				rec.node as {
					_map?: Map<string, { deleted: boolean; id: { client: number; clock: number } }>;
				}
			)?._map ?? [])
		]
			.filter(([k, it]) => k.startsWith('del.') && !it.deleted)
			.map(([, it]) => `${it.id.client}:${it.id.clock}`)
			.sort();
		blocksOut.set(id, {
			// Explicit deletion (a live delete mark). A withdrawn block's visibility
			// (`hist.undo.withdraw`) is derived from what it holds, not a delete.
			deleted: delItems.length > 0,
			delStamp: delItems.length > 0 ? delItems.join(',') : null,
			placements: canonKey(
				rec.cands.map((c: { key: string; p: unknown; r: string }) => ({
					key: c.key,
					p: c.p,
					r: c.r
				}))
			)
		});
	}
	return { atoms, claims, blocks: blocksOut };
};

/**
 * The surface an op targeting `id` may address — resolved against THIS
 * peer's current replicated state. `null` when `id` is not visible.
 */
export const opTarget = (peer: Peer, id: BlockId): OpTarget | null => {
	const doc = peer.doc;
	const blocks = M.collectBlocks(doc);
	const own = T.computeOwnership(doc, blocks);
	if (own.hidden(id)) return null;
	const placements = M.resolvePlacements(blocks, own.ownerOf);
	const atoms: OpTarget['atoms'] = [];
	const texts = new Set<BlockId>([id]);
	const rowsByText = new Map<BlockId, AtomRow[]>();
	const rows = (t: BlockId) => {
		let r = rowsByText.get(t);
		if (r === undefined) {
			r = atomRows(blocks.get(t)?.content ?? { _start: null }).filter((a) => !a.deleted);
			rowsByText.set(t, r);
		}
		return r;
	};
	for (const seg of T.flatten(id, blocks, own)) {
		texts.add(seg.t);
		for (const a of rows(seg.t)) {
			if (a.pos >= seg.i0 && a.pos < seg.i1) {
				atoms.push({ key: atomKey(a), ...(a.inlineId ? { inlineId: a.inlineId } : {}) });
			}
		}
	}
	// Every block whose claims route to `id` — `owner(h) === id` — and the
	// lists storing their claims (an anchored claim may be stored on another
	// block's list: `merge.claim.anchor`).
	const holders = new Set<BlockId>();
	for (const hid of blocks.keys()) if (own.ownerOf(hid) === id) holders.add(hid);
	for (const hid of [...holders])
		for (const c of own.claimsOf?.(hid) ?? []) if (c.holder !== undefined) holders.add(c.holder);
	const children = new Set<BlockId>(
		(M.childrenIndex(placements, own).get(id) ?? []).map((k: { id: BlockId }) => k.id)
	);
	return { atoms, texts, holders, children };
};

/**
 * Why `id` is dead/hidden on this replica — the runner evaluates the
 * cause of every `dead-owner` holder against the schedule's recorded
 * deletions and authorized claims.
 */
export const deadCause = (peer: Peer, id: BlockId): DeadCause => {
	const doc = peer.doc;
	const blocks = M.collectBlocks(doc);
	const rec = blocks.get(id);
	if (rec === undefined) return { kind: 'absent' };
	if (rec.deleted) return { kind: 'del' };
	const own = T.computeOwnership(doc, blocks);
	const chain = ownerChain(effective(blocks, own), id);
	if (chain.owner === DEAD) return { kind: 'claim', chain: chain.route, end: chain.end ?? id };
	const placements = M.resolvePlacements(blocks, own.ownerOf);
	let cur: BlockId = id;
	const seen = new Set<BlockId>([id]);
	for (;;) {
		const pl = placements.get(cur);
		if (pl === undefined || pl.parent === null) return { kind: 'live' };
		const dp = own.ownerOf(pl.parent);
		if (dp === DEAD) return { kind: 'ancestor', root: pl.parent };
		if (seen.has(dp)) return { kind: 'live' };
		seen.add(dp);
		cur = dp;
	}
};

/**
 * Attach history tracking for `peer` — a registry-scoped UndoManager with
 * `captureTimeout: 0` (one stack item per op transaction) tracking only the
 * peer's local origin. Idempotent; reload clears `peer.undoManager`, so a
 * post-reload call re-derives it on the new doc.
 */
export const trackHistory = (peer: Peer): void => {
	if (peer.undoManager === null) {
		peer.enableUndo({ scope: M.registryOf(peer.doc), captureTimeout: 0 });
	}
};

export const undo = (peer: Peer): void => {
	peer.undoManager?.undo();
};

export const redo = (peer: Peer): void => {
	peer.undoManager?.redo();
};

export const createModelOps = (): CrdtOps => ({
	name: 'placement-model',
	preservesIdentityOnMove: true,
	preservesIdentityOnSplitMerge: true,

	insertBlock: (peer, dest, spec) => peer.transact(() => M.insertBlock(peer.doc, dest, spec)),
	deleteBlock: (peer, id) => peer.transact(() => M.deleteBlock(peer.doc, id)),
	moveBlock: (peer, id, dest) => peer.transact(() => M.moveBlock(peer.doc, id, dest)),
	moveBlocks: (peer, ids, dest) => peer.transact(() => M.moveBlocks(peer.doc, ids, dest)),
	nestBlock: (peer, id, newParentId) => peer.transact(() => M.nestBlock(peer.doc, id, newParentId)),
	unNestBlock: (peer, id) => peer.transact(() => M.unNestBlock(peer.doc, id)),
	splitBlock: (peer, id, offset, newId) =>
		peer.transact(() => M.splitBlock(peer.doc, id, offset, newId)),
	mergeBlocks: (peer, fromId, intoId) =>
		peer.transact(() => M.mergeBlocks(peer.doc, fromId, intoId)),

	insertText: (peer, id, offset, text, marks) =>
		peer.transact(() => M.insertText(peer.doc, id, offset, text, marks)),
	deleteText: (peer, id, offset, length) =>
		peer.transact(() => M.deleteText(peer.doc, id, offset, length)),
	setMark: (peer, id, offset, length, name, value) =>
		peer.transact(() => M.setMark(peer.doc, id, offset, length, name, value)),
	unsetMark: (peer, id, offset, length, name) =>
		peer.transact(() => M.unsetMark(peer.doc, id, offset, length, name)),
	insertInline: (peer, id, offset, atom) =>
		peer.transact(() => M.insertInline(peer.doc, id, offset, atom)),
	removeInline: (peer, id, inlineId) => peer.transact(() => M.removeInline(peer.doc, id, inlineId)),

	project: (peer) => M.project(peer.doc),
	resolveBlock: (peer, id) => M.resolveBlock(peer.doc, id),
	crdtId: (peer, id) => M.crdtId(peer.doc, id),
	blockText: (peer, id) => M.blockText(peer.doc, id),
	listBlockIds: (peer) => M.listBlockIds(peer.doc),
	positionOf: (peer, id) => M.positionOf(peer.doc, id),
	expectedProjectedIds,
	locateTagAtoms,
	classifyTagAtoms,
	tagAtomDeps,
	captureOpState,
	opTarget,
	deadCause,
	trackHistory,
	undo,
	redo
});

/** The bound model itself, for tests that need internals (ranks, candidates). */
export const model = M;
