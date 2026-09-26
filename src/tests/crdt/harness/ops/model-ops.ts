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
import { bindModel } from '../../../../lib/crdt/index.js';
import {
	bindText,
	DEAD,
	canonKey,
	cmpStamp,
	intervalAt,
	isMergeClaim,
	isSliceRecord,
	ownerAt
} from '../../../../lib/crdt/text/model.js';
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
 * silently passing. `dead` chain ends are legitimate (deleted ancestor →
 * hidden-with-subtree, MV06b); a 'dead' verdict against a parent that is
 * NOT actually `del`-flagged is itself counted as expected so the
 * discrepancy surfaces rather than being absorbed.
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
			const dp = own.ownerOf(pl.parent);
			if (dp === DEAD) {
				// Deleted/unintegrated ancestor — legitimate hiding only when the
				// parent really is gone or `del`-flagged; a DEAD verdict on a
				// live parent is an ownership bug, so keep the block expected.
				const prec = blocks.get(pl.parent);
				if (prec === undefined || prec.deleted) legitimatelyHidden = true;
				break;
			}
			if (seen.has(dp)) break; // composed display cycle → still expected
			seen.add(dp);
			cur = dp;
		}
		if (!legitimatelyHidden) expected.add(id);
	}
	return expected;
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
};

const atomRows = (text: unknown): AtomRow[] => {
	const atoms: AtomRow[] = [];
	let pos = 0;
	let formats: Record<string, unknown> | undefined;
	let formatsKey = '';
	for (let it = (text as { _start?: never })._start; it !== null; it = it.right) {
		if (it.deleted) continue;
		const countable = it.content.isCountable ? it.content.isCountable() : true;
		if (!countable) {
			// Live ContentFormat marker — fold into mark state (COW).
			const key = it.content.key;
			if (typeof key === 'string') {
				formats = { ...formats };
				if (it.content.value == null) delete formats[key];
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
					? canonKey({ id: v.getAttr('id'), type: v.getAttr('type'), data: v.getAttr('data') })
					: '',
				...(inline ? { inlineId: v.getAttr('id') as string } : {})
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
				c: it.id.client,
				k: it.id.clock + j,
				ch: typeof v === 'string' ? v : '\0',
				deleted: true,
				pos: -1,
				marksKey: '',
				marksObj: undefined,
				payload: inline
					? canonKey({ id: v.getAttr('id'), type: v.getAttr('type'), data: v.getAttr('data') })
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

/**
 * Strict-oracle classify (WU3): for each tracked atom, where it ended up in
 * the converged state on `peer`. The per-atom verdict distinguishes the
 * three outcomes the plan requires the oracle to separate — explicit
 * deletion (`tombstoned`, `dead-owner`), owner-move (`moved`) and actual
 * loss (`uncovered`, `gone`, `unreachable`). Positions resolve through
 * `ownerAt` on the ownership intervals, so a claim held by a merged-away
 * block still counts as claimed-by-its-owner (atoms route, they do not die).
 *
 * `context` supplies the schedule-side causal expectations (gate-F1 F3 —
 * {@link TagClassifyContext}): a foreign visible owner that no recorded
 * split/merge produced, or one that already owned the atoms at insert
 * time, classifies `stolen` rather than `moved`. With no context the
 * verdict stays `moved` (callers without schedule information get the
 * pre-F3 semantics).
 */
/**
 * Replicates `computeOwners`' walk for ONE block, collecting the traversed
 * merge-claim stamps — the physical route from `id`'s slice list to its
 * display owner. Returns the resolved owner (same verdict as
 * `ownerOf(id)`), the claim stamps in order, and — when the chain dies —
 * the block id it died at (`end`).
 */
const ownerChain = (
	blocks: Map<
		BlockId,
		{ deleted: boolean; entries: { payload: unknown; stamp: { c: number; k: number } }[] }
	>,
	id: BlockId
): { owner: BlockId | typeof DEAD; route: StampKey[]; end?: BlockId } => {
	// claimsOn[X] = live `{m:X}` entries held by LIVE blocks (mirrors
	// computeOwners — a claim on a del-flagged list is inert).
	const claimsOn = new Map<BlockId, { claimer: BlockId; stamp: { c: number; k: number } }[]>();
	for (const [holderId, rec] of blocks) {
		if (rec.deleted) continue;
		for (const e of rec.entries) {
			if (!isMergeClaim(e.payload)) continue;
			const list = claimsOn.get(e.payload.m) ?? [];
			list.push({ claimer: holderId, stamp: e.stamp });
			claimsOn.set(e.payload.m, list);
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
			// Claim cycle — the max-stamp edge among members wins (computeOwners
			// parity): its claimer keeps its own list.
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
	// Index every atom of every backing text once for this classify call.
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
	// Claim stamp → the block whose `slices` list physically holds it (the
	// winning claim is always a live entry).
	const holderOf = new Map<StampKey, BlockId>();
	for (const [holderId, rec] of blocks) {
		for (const e of rec.entries) holderOf.set(stampKey(e.stamp), holderId);
	}
	// Dead-held slice records covering `pos` of `textId` — an unowned
	// position under such coverage is hidden by its holder's delete (R3:
	// a deleted block's records keep winning what they display).
	const deadCoverage = (textId: string, pos: number): BlockId[] => {
		const text = blocks.get(textId)?.content;
		if (!text) return [];
		const holders: BlockId[] = [];
		for (const [holderId, rec] of blocks) {
			if (own.ownerOf(holderId) !== DEAD) continue;
			for (const e of rec.entries) {
				if (!isSliceRecord(e.payload) || e.payload.t !== textId) continue;
				const r = own.resolvedRange(e, text);
				if (r !== null && r[0] <= pos && pos < r[1]) holders.push(holderId);
			}
		}
		return holders;
	};
	// Store-level lookup for atoms the item walk did not find: a GC struct
	// is a tombstone whose content was compacted — still a legit deletion.
	// A live Item outside every content text, a Skip (not integrated), or no
	// struct at all is genuinely gone.
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
	// U5: an atom's ownership is authorized iff its winning claim record AND
	// every merge claim on its holder→owner route carry a stamp the executed
	// schedule wrote (`authorizedClaims`); pseudo claims are exempt.
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
		const iv = intervalAt(own.intervals.get(found.textId), found.pos);
		if (iv === undefined) {
			const holders = deadCoverage(found.textId, found.pos);
			return holders.length > 0
				? ({
						kind: 'dead-owner',
						holders,
						marks: found.marks,
						marksObj: found.marksObj,
						payload: found.payload
					} as AtomFate)
				: ({ kind: 'uncovered' } as AtomFate);
		}
		const owner = iv.owner;
		const via = stampKey(iv.claim.stamp);
		// The pseudo self-slice of a legacy record belongs to the text's own
		// block; every real claim resolves to its physical holder.
		const holder = holderOf.get(via) ?? found.textId;
		const route = holder === owner ? [] : ownerChain(blocks, holder).route;
		const detail = {
			via,
			route,
			marks: found.marks,
			marksObj: found.marksObj,
			payload: found.payload
		};
		// Claim-authorization precedes owner shape: an atom routed through a
		// claim the schedule never wrote is a steal even when the owner looks
		// familiar (R6b — an injected merge into a recorded split destination).
		if (!authorized(via, route)) return { kind: 'stolen', owner, ...detail } as AtomFate;
		if (owner === target) return { kind: 'present', ...detail } as AtomFate;
		// A live owner that is legitimately hidden (deleted or under a
		// deleted ancestor) took the atoms down with it — same contract as
		// `dead-owner`. One that SHOULD be projected but is not is the
		// `unreachable-block` invariant, kept distinct.
		if (!expected.has(owner))
			return { kind: 'dead-owner', holders: [owner], ...detail } as AtomFate;
		if (!projectedIds.has(owner)) {
			return { kind: 'unreachable', owner, ...detail } as AtomFate;
		}
		// `moved` vs `stolen` (gate-F1 F3): the owner is visible and live,
		// so the atoms SURVIVED — but surviving under a foreign block is
		// legitimate only when the schedule's causal operations explain the
		// transfer. An owner that already claimed the atoms at insert time
		// (`insertOwners`) is the ownership-steal signature: the insert
		// itself was misrouted, so persisting under it is a steal, not a
		// move. With `authorizedClaims` the claim-path check above has
		// already decided authorization; `legitOwners` (the pre-U5
		// destination-name check) applies only when no stamp set was given.
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
 * display depends on — its own item plus the claim stamps of every slice
 * record covering it on this replica (any holder, live or dead; a covering
 * record on a dead holder still explains the atom's coverage history).
 * The runner intersects these with the ids observed-destroyed by lossy
 * reloads to decide whether a hard fate is convergent-loss or a defect.
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
	// Index every atom of the home text once (positions for coverage lookup).
	const positions = new Map<string, number>();
	if (text) {
		for (const a of atomRows(text)) {
			if (!a.deleted) positions.set(`${a.c}:${a.k}`, a.pos);
		}
	}
	// Every slice-record entry covering `pos` of `textId`, any holder.
	const coveringStamps = (pos: number): { c: number; k: number }[] => {
		if (!text) return [];
		const stamps: { c: number; k: number }[] = [];
		for (const [, rec] of blocks) {
			for (const e of rec.entries) {
				if (!isSliceRecord(e.payload) || e.payload.t !== textId) continue;
				const r = own.resolvedRange(e, text);
				if (r !== null && r[0] <= pos && pos < r[1]) stamps.push(e.stamp);
			}
		}
		return stamps;
	};
	return atoms.map((a) => {
		const pos = positions.get(`${a.c}:${a.k}`);
		return pos === undefined ? [] : coveringStamps(pos);
	});
};

// ── operation-intent oracle (hardening U5) ────────────────────────────
//
// The runner snapshots the replicated mutation surface around every
// scheduled op (`captureOpState` pre/post) and checks the diff against the
// envelope the op's KIND and resolved target allow (`opTarget` supplies
// the surface: displayed atoms, reachable backing texts, claim-bearing
// holders, display children). `deadCause` explains per-holder why a
// `dead-owner` atom's coverage died so the barrier can verify the schedule
// authorized it.

/** Snapshot the full mutation surface — atoms, claims, block state. */
export const captureOpState = (peer: Peer): OpState => {
	const blocks = M.collectBlocks(peer.doc);
	const atoms: OpState['atoms'] = new Map();
	const claims: OpState['claims'] = new Map();
	const blocksOut: OpState['blocks'] = new Map();
	for (const [id, rec] of blocks) {
		for (const a of atomRows(rec.content ?? { _start: null })) {
			atoms.set(atomKey(a), {
				text: id,
				live: !a.deleted,
				marks: a.marksKey,
				marksObj: a.marksObj,
				payload: a.payload
			});
		}
		// EVERY slices item — tombstoned included: a claim dying is a state
		// change the envelope must authorize.
		for (
			let it = (rec.slicesNode as { _start?: never } | undefined)?._start ?? null;
			it !== null;
			it = it.right
		) {
			const countable = it.content.isCountable ? it.content.isCountable() : true;
			if (!countable) continue;
			const arr = it.content.getContent();
			const n = Math.min(arr.length, it.length);
			for (let j = 0; j < n; j++) {
				const payload = arr[j];
				const kind = isSliceRecord(payload) ? 'slice' : isMergeClaim(payload) ? 'merge' : 'other';
				claims.set(`${it.id.client}:${it.id.clock + j}`, {
					holder: id,
					kind,
					t: isSliceRecord(payload) ? payload.t : undefined,
					m: isMergeClaim(payload) ? payload.m : undefined,
					live: !it.deleted
				});
			}
		}
		// The items carrying live delete marks (stamps kept for loss correlation).
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
			deleted: rec.deleted,
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
 * peer's current replicated state. `null` when `id` is not visible (the
 * op must then produce an empty diff — the adapters refuse non-visible
 * targets without mutating).
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
	// Every holder whose slice list may carry claims routing to `id` —
	// `owner(h) === id` covers `id` itself plus merged-away holders.
	const holders = new Set<BlockId>();
	for (const hid of blocks.keys()) if (own.ownerOf(hid) === id) holders.add(hid);
	const children = new Set<BlockId>(
		M.childrenOf(blocks, placements, own, id).map((k: { id: BlockId }) => k.id)
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
	const chain = ownerChain(blocks, id);
	if (chain.owner === DEAD) return { kind: 'claim', chain: chain.route, end: chain.end ?? id };
	// Live and self-owned — hidden by placement ancestry: walk display
	// parents to the first dead ancestor.
	const own = T.computeOwnership(doc, blocks);
	const placements = M.resolvePlacements(blocks, own.ownerOf);
	let cur: BlockId = id;
	const seen = new Set<BlockId>([id]);
	for (;;) {
		const pl = placements.get(cur);
		if (pl === undefined || pl.parent === null) return { kind: 'live' };
		const dp = own.ownerOf(pl.parent);
		if (dp === DEAD) return { kind: 'ancestor', root: pl.parent };
		if (seen.has(dp)) return { kind: 'live' }; // display cycle → not dead
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
