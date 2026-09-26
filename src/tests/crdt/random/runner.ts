/**
 * Executes a generated {@link Schedule} on a fresh PeerSet through the
 * `CrdtOps` adapter, then asserts the corpus's hard invariant (engine-level
 * convergence after full sync) and classifies semantic violations into known
 * missing-semantics evidence vs unknown failures.
 *
 * Violation classes (all *convergent but semantically wrong* — the corpus's
 * job is proving which ones remain):
 *
 * - `duplicate-placement` / `duplicate-inline` — one logical id materialized
 *   twice. Expected under copy-move: concurrent moves of one block produce two
 *   surviving copies (pending MV02).
 * - `resurrected-delete` — a deleted logical id reappears in the final state.
 *   Expected under copy-move: a peer's move-clone survives a concurrent delete
 *   (pending MV06).
 * - `lost-identity` — a block's engine identity changed (copy semantics
 *   recreate items; pending MV03+).
 * - `lost-edit` — REAL loss only (WU3 strict oracle): a tracked insert's
 *   atoms are live but covered by NO claim (coverage hole), or vanished
 *   without any observed loss event, or the insert reported success and
 *   wrote no atoms at all. Hard failure on every adapter.
 * - `moved-edit` — the tag's atoms display under a different visible block
 *   than the insert's target: a legal owner-move (a concurrent split/merge
 *   won the contested range the insert landed in). Evidence.
 * - `stolen-edit` — the tag's atoms display under a different visible
 *   block whose claim the schedule's causal operations do NOT explain
 *   (gate-F1 F3): the owner already claimed the atoms at insert time, or
 *   no recorded split/merge produced it. Hard failure on every adapter —
 *   it is the strict-lane name for an ownership steal/misparenting.
 * - `deleted-legit` — no tag atom is displayed anywhere and every atom is
 *   either tombstoned (explicit `deleteText`/`removeInline`) or covered
 *   only by deleted/hidden holders (died with its owner). Evidence.
 * - `convergent-loss` — the schedule observably destroyed data (a snapshot
 *   reload regressed a peer's state vector — e.g. reloading the STALE seed
 *   persist — or dropped pending state) AND the outcome is exactly what
 *   convergent semantics predict: post-barrier pending residue whose deps
 *   died on every replica, or a resurrected delete whose delete update was
 *   lost. Correct CRDT behavior under deliberate environment loss —
 *   evidence. Gate-F1 F4 tightened the ATOM-fate arm: a hard-on-every-
 *   replica fate is excused only when the atom's own id or one of its
 *   coverage deps lands inside the id-ranges an observed reload actually
 *   destroyed (or the post-barrier stranded set) — an unrelated lossy
 *   reload elsewhere in the run no longer licenses it. In a run with NO
 *   loss events the same states are sync defects → `divergence`/
 *   `resurrected-delete` stay hard.
 *   (Renamed from `unrecoverable-loss` — the old name read like a failure
 *   when the semantics are correct.)
 * - `cycle` — a logical block id appears as its own ancestor. Under copy-move
 *   this is the pending-MV05 failure mode (concurrent A-under-B / B-under-A
 *   produces nested copies). Expected evidence under the copy adapter; a hard
 *   failure once an adapter preserves identity (`preservesIdentityOnMove`).
 * - `upstream-engine-crash` — an exception thrown from vendored-engine
 *   internal machinery (transaction cleanup / delete-set iteration / struct
 *   integration) while processing a *legal* update stream. On the raw
 *   diagnostic adapter it stays evidence (vendored rc.26 robustness gap,
 *   seeds 86/140 repros); on the production-model adapters NO crash is
 *   tolerated — an engine stack frame does not justify accepting it —
 *   so it is a hard failure there.
 * - `unrequested-effect` (U5) — an executed op changed replicated state
 *   outside its intent envelope: atoms tombstoned/revived outside the
 *   authorized range, claims written/removed outside the authorized
 *   holders, blocks created/deleted/moved the op did not name, mark keys
 *   outside the requested set, inline payloads rewritten. Hard failure —
 *   this is the op-level half of the R6 fix: the oracle no longer waits
 *   for the barrier to notice damage an op was never asked to cause.
 * - `mutated-edit` (U5) — a tracked atom's mark map or inline payload at
 *   the barrier differs from its birth state AND from every value an
 *   authorized op wrote for that key — an unrequested content mutation
 *   that survived convergence. Hard failure.
 * - `unreachable-block` — a live, not-legitimately-hidden registry block is
 *   absent from the projection (or vice versa: a projected block that
 *   should be hidden). Reported by `checkStructurallyValid` when the
 *   adapter exposes `expectedProjectedIds`; the silent-loss class the
 *   composed display-parent-cycle fix exists to eliminate. Never expected
 *   → hard failure on every adapter that provides the oracle.
 * - `crash` / `divergence` / `unknown` — never expected → hard failure.
 *
 * OPERATION INTENT (U5, review §R6): adapters exposing `captureOpState` +
 * `opTarget` + `deadCause` run under per-op authorization — before each
 * doc op the runner resolves the target on the executing peer, snapshots
 * the mutation surface (every atom with marks/payload fingerprints, every
 * claim item live or dead, every block's del flag + placements), executes,
 * snapshots again, and rejects any diff outside the op's envelope. The
 * run-global `legitOwners`/sawLoss permissions are replaced by ledgered
 * facts: a tombstone is legit only if a recorded delete covered that atom;
 * a moved atom's winning claim + merge-claim route must consist of stamps
 * the schedule actually wrote (`authorizedClaims`); a `dead-owner` holder
 * must explain its death through a recorded del flag or authorized claim
 * chain; marks/payloads must equal the birth fingerprint or a value a
 * mark op wrote. `undo`/`redo` ops are bounded to the union of effects
 * the executing peer's own ops produced (history scope), and resurrection
 * is excused only when the delete's own item stamp was destroyed by an
 * observed loss.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import * as decoding from 'lib0-v14/decoding';
import { createPeerSet, type PeerSet, type Peer, type SeedUpdate } from '../harness/peer-set.js';
import type {
	CrdtOps,
	OpState,
	OpTarget,
	ProjectedBlock,
	ProjectedDoc,
	StampKey,
	TagClassifyContext
} from '../harness/ops/crdt-ops.js';
import { canonKey } from '../../../lib/crdt/text/model.js';
import { sanitizeWireString } from '../../../lib/utils/json.js';
import {
	checkStructurallyValid,
	findFirstDiff,
	snapshotIdentities,
	diffIdentities
} from '../harness/assert/convergence.js';
import type { Schedule, Step, DocOp, NetOp } from './generator.js';

export type RunResult = {
	ok: boolean;
	failure?: string;
	/**
	 * HARD classes observed — every class not in {@link expectedViolations}
	 * for this adapter. Empty means the seed passed (evidence may still be
	 * non-empty: classified-legit outcomes are reported, not gated).
	 */
	violations: string[];
	/** Legit classified classes observed — reported, never gated. */
	evidence: string[];
	lostEdits: string[];
	lostIdentities: string[];
	/**
	 * Per-tag oracle detail for the strict lane: `tag → verdict`, where the
	 * verdict is `present` / `moved-edit` / `stolen-edit` / `deleted-legit` /
	 * `convergent-loss` / `lost-edit` / `unreachable-block` and, for
	 * `moved-edit`/`stolen-edit`, the owning block(s). Persisted in
	 * failure artifacts so a real-loss finding is inspectable without
	 * re-running.
	 */
	tagVerdicts: Record<string, string>;
	/**
	 * Op-level intent violations (U5): one line per detected unrequested
	 * effect — `step N <kind>: <what changed outside the envelope>`.
	 * Populated even when the run later aborts, so failure artifacts carry
	 * the causal detail.
	 */
	intentViolations: string[];
	/** Scheduled doc-op counts by kind + `net:<action>` for net ops. */
	opCounts: Record<string, number>;
	/** Doc ops skipped before the adapter call (unresolvable target). */
	skippedOps: number;
	/** undo/redo ops executed (history coverage accounting). */
	historyOps: number;
	stepCount: number;
};

/**
 * Violation classes that are EXPECTED evidence for a given adapter — the
 * legit set. Anything observed outside this set is a hard failure. Copy
 * semantics make the structural classes reachable; an identity-preserving
 * adapter (U03+) cannot produce them, so they harden the moment the real
 * model is plugged in.
 *
 * WU3 strict gate: adapters exposing the atom oracle (`classifyTagAtoms`)
 * get only the *classified-legit* classes — `moved-edit`, `deleted-legit`
 * and `convergent-loss`. `lost-edit` is NOT legit there: it now means
 * actual loss, and an engine-crash frame no longer excuses a crash either
 * (`upstream-engine-crash` is legit only on the raw diagnostic adapter,
 * which exists precisely to surface the vendored robustness findings).
 */
export const expectedViolations = (ops: CrdtOps): Set<string> => {
	const s = new Set<string>(['convergent-loss']);
	if (ops.classifyTagAtoms) {
		s.add('moved-edit');
		s.add('deleted-legit');
	} else {
		// Legacy block-text check: a random later delete can erase the tag —
		// the class is evidence, never a proof on its own.
		s.add('lost-edit');
	}
	if (!ops.preservesIdentityOnMove) {
		s.add('duplicate-placement');
		s.add('resurrected-delete');
		s.add('cycle');
	}
	if (!ops.preservesIdentityOnMove || !ops.preservesIdentityOnSplitMerge) {
		s.add('lost-identity');
		// `duplicate-inline`: the copy adapter duplicates atom ids on
		// overlapping split/merge; the U04 slice-claim model gives every atom
		// exactly one winning record, so it is a HARD failure there.
		s.add('duplicate-inline');
	}
	if (!ops.classifyTagAtoms) s.add('upstream-engine-crash');
	return s;
};

/** Engine-cleanup/internals frames — a crash here is upstream's, not the adapter's. */
const ENGINE_INTERNAL_CRASH =
	/cleanupTransactions|cleanupYTextAfterTransaction|tryMerge|tryToMergeWithLefts|findIndexSS|findIndexCleanStart|iterateStructs|integrateStructs|readAndApplyDeleteSet|applyUpdateV2/;

/** True iff a (client, clock) item exists integrated on at least one replica. */
const unionCovers = (peers: Peer[], client: number, clock: number): boolean =>
	peers.some((p) => p.doc.store.getClock(client) > clock);

/**
 * Decode a store's pendingDs blob (an update carrying 0 structs + an IdSet)
 * into `[client, clockStart, len]` dep ranges.
 */
const pendingDsRanges = (pendingDs: Uint8Array): Array<[number, number, number]> => {
	const dec = new Y.UpdateDecoderV2(decoding.createDecoder(pendingDs));
	decoding.readVarUint(dec.restDecoder); // struct count (always 0)
	const idset = Y.readIdSet(dec);
	const deps: Array<[number, number, number]> = [];
	for (const [client, ranges] of idset.clients) {
		for (const r of ranges.getIds()) deps.push([client, r.clock, r.len]);
	}
	return deps;
};

const pendingDsDeps = (pendingDs: Uint8Array): Array<[number, number]> =>
	pendingDsRanges(pendingDs).map(([c, k]) => [c, k]);

/** An item-id range `(client, [start, start+len))` — half-open clocks. */
type IdRange = { client: number; start: number; len: number };

const inRanges = (ranges: IdRange[], id: { c: number; k: number }): boolean =>
	ranges.some((r) => r.client === id.c && id.k >= r.start && id.k < r.start + r.len);

/**
 * Item-id ranges currently sitting in `p`'s unresolved pending state —
 * the ids a reload would silently discard (`pendingStructs` contents plus
 * `pendingDs` dep targets). Used twice (gate-F1 F4): captured BEFORE each
 * reload into `lostRanges`, and read once at the barrier as the
 * stranded-residue set. Decode failures capture nothing — a state the
 * harness cannot name cannot excuse a hard fate.
 */
const pendingItemRanges = (p: Peer): IdRange[] => {
	const out: IdRange[] = [];
	const ps = p.doc.store.pendingStructs;
	if (ps) {
		try {
			const { inserts } = Y.createContentIdsFromUpdateV2(ps.update);
			for (const [client, ranges] of inserts.clients) {
				for (const r of ranges.getIds()) {
					out.push({ client, start: r.clock, len: r.len });
				}
			}
		} catch {
			// Undecodable pending blob → no ranges captured (conservative).
		}
	}
	const pd = p.doc.store.pendingDs;
	if (pd) {
		try {
			for (const [client, clock, len] of pendingDsRanges(pd)) {
				out.push({ client, start: clock, len });
			}
		} catch {
			// Same conservative rule.
		}
	}
	return out;
};

/**
 * True iff some peer holds pending state that can never resolve — i.e. the
 * run experienced unrecoverable data loss (`sawLoss`: a snapshot reload
 * regressed a state vector or dropped pending items) and post-barrier
 * pending state remains. After `healPeer × n + deliverAll + syncAll('full')
 * + deliverAll`, every item in every store has been offered to every peer,
 * so a still-pending struct is either absent from all stores or stranded
 * behind a transitively destroyed dep — both are correct convergent-loss
 * semantics, not sync defects.
 *
 * `pendingDs` gets the extra `unionCovers` check: a pending-delete range
 * start that IS integrated on some replica should have shipped, integrated
 * on the holder, and consumed the delete — still-pending + covered is
 * suspicious → not explained → false.
 */
const hasDestroyedPendingDeps = (peers: Peer[], sawLoss: boolean): boolean => {
	let sawPendingStructs = false;
	for (const p of peers) {
		if (p.doc.store.pendingStructs) sawPendingStructs = true;
	}
	if (sawPendingStructs) {
		// Pending residue after a barrier in a run with observed loss is
		// transitive destruction; in a lossless run it would be a sync bug.
		return sawLoss;
	}
	let sawPendingDs = false;
	for (const p of peers) {
		const pd = p.doc.store.pendingDs;
		if (!pd) continue;
		sawPendingDs = true;
		for (const [client, clock] of pendingDsDeps(pd)) {
			if (unionCovers(peers, client, clock)) return false;
		}
	}
	return sawPendingDs && sawLoss;
};

/** All inline atom ids inside a projected block (for removeInline targeting). */
const inlineIdsOf = (block: ProjectedBlock | undefined): string[] =>
	(block?.content ?? []).filter((i) => i.kind === 'inline').map((i) => (i as { id: string }).id);

const findProjected = (doc: ProjectedDoc, id: string): ProjectedBlock | undefined => {
	const stack = [...doc.children];
	while (stack.length) {
		const b = stack.pop()!;
		if (b.id === id) return b;
		stack.push(...b.children);
	}
	return undefined;
};

/** Flatten a block's text (atoms omitted). */
const flatText = (block: ProjectedBlock | undefined): string =>
	(block?.content ?? [])
		.filter((i) => i.kind === 'text')
		.map((i) => (i as { text: string }).text)
		.join('');

// ── operation-intent machinery (hardening U5) ─────────────────────────
// Two snapshots per executed doc op (captureOpState pre/post) are diffed
// and checked against the envelope the op's kind + resolved target allow.
// Facts the diffs produce feed the barrier oracle: blessedClaims (stamps
// the schedule lawfully wrote — the authorizedClaims input to
// classifyTagAtoms), recordedTombstones (atoms a scheduled delete covered),
// delOn/delStamps (recorded deletes + the del items' stamps for loss
// correlation), markLedger (per-atom per-key authorized mark values) and
// per-peer history envelopes for undo/redo.

type ClaimRow = {
	holder: string;
	kind: 'slice' | 'merge' | 'other';
	t?: string;
	m?: string;
	live: boolean;
};

type OpDiff = {
	/** absent → present atoms. */
	atomsNew: string[];
	/** live → tombstoned-or-absent atoms. */
	atomsOut: string[];
	/** tombstoned → live atoms (undo/GC restore only). */
	atomsRevived: string[];
	/** live → live atoms whose mark fingerprint changed (+ changed keys). */
	marksChanged: { key: string; text: string; keys: string[] }[];
	/** live → live atoms whose inline payload fingerprint changed. */
	payloadChanged: string[];
	claimsNew: { stamp: string; row: ClaimRow }[];
	claimsRemoved: string[];
	claimsRevived: string[];
	blocksNew: string[];
	blocksGone: string[];
	delSet: { id: string; stamp: string | null }[];
	delCleared: string[];
	placementsChanged: string[];
};

/**
 * What an executed op may lawfully change — every field is an upper bound,
 * never a requirement (a refused/no-op op produces an empty diff, which
 * every envelope accepts).
 */
type IntentEnvelope = {
	/** New atoms: only inside `texts`, and at most `count` when given
	 *  (undefined = unbounded — history ops can't predict copy counts). */
	atomsIn?: { texts: ReadonlySet<string>; count?: number };
	/** Atom keys this op may tombstone/remove. */
	atomsOut?: ReadonlySet<string>;
	/** Atom keys this op may transition either way (history ops). */
	atomAny?: ReadonlySet<string>;
	/** Predicate over newly-live claims (holder + payload shape). */
	claimsWrite?: (row: ClaimRow, stamp: string) => boolean;
	/** Claim stamps that may go live→dead/absent. */
	claimsRemove?: ReadonlySet<string>;
	/** Claim stamps that may transition any direction (history ops). */
	claimsAny?: ReadonlySet<string>;
	blocksCreate?: ReadonlySet<string>;
	blocksRemove?: ReadonlySet<string>;
	delSet?: ReadonlySet<string>;
	delClear?: ReadonlySet<string>;
	/** Either direction (history ops). */
	delAny?: ReadonlySet<string>;
	placements?: ReadonlySet<string>;
	/** atomKey → mark name → authorized canonical post-values (R6: the
	 *  envelope binds key AND value — an authorized name carrying a wrong
	 *  value is still unrequested mutation). */
	marks?: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
	/**
	 * Backing texts where mark changes are a legal SIDE EFFECT — a
	 * positional delete tombstones marker items inside its span, which can
	 * shift the folded marks of same-text atoms outside the range. Only
	 * delete-family ops (and undo, over the peer's touched texts) get this.
	 */
	markTexts?: ReadonlySet<string>;
	/**
	 * Texts the op addressed — NOT a permission, just bookkeeping the
	 * runner folds into the executing peer's history scope (undo/redo of
	 * this op will need them).
	 */
	touchedTexts?: ReadonlySet<string>;
};

/** Key-level diff of two folded mark maps (canonical-value compare). */
const markDiffKeys = (
	a: Record<string, unknown> | undefined,
	b: Record<string, unknown> | undefined
): string[] => {
	const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
	return [...keys].filter((k) => canonKey((a ?? {})[k]) !== canonKey((b ?? {})[k]));
};

const diffStates = (pre: OpState, post: OpState): OpDiff => {
	const d: OpDiff = {
		atomsNew: [],
		atomsOut: [],
		atomsRevived: [],
		marksChanged: [],
		payloadChanged: [],
		claimsNew: [],
		claimsRemoved: [],
		claimsRevived: [],
		blocksNew: [],
		blocksGone: [],
		delSet: [],
		delCleared: [],
		placementsChanged: []
	};
	for (const [k, b] of post.atoms) {
		const a = pre.atoms.get(k);
		if (a === undefined) {
			d.atomsNew.push(k);
			continue;
		}
		if (a.live && !b.live) d.atomsOut.push(k);
		else if (!a.live && b.live) d.atomsRevived.push(k);
		if (a.live && b.live) {
			if (a.marks !== b.marks) {
				d.marksChanged.push({ key: k, text: b.text, keys: markDiffKeys(a.marksObj, b.marksObj) });
			}
			if (a.payload !== b.payload) d.payloadChanged.push(k);
		}
	}
	for (const [k, a] of pre.atoms) {
		if (!post.atoms.has(k) && a.live) d.atomsOut.push(k); // live → absent (item gone)
	}
	for (const [stamp, b] of post.claims) {
		const a = pre.claims.get(stamp);
		if (a === undefined) {
			d.claimsNew.push({ stamp, row: b });
			continue;
		}
		if (a.live && !b.live) d.claimsRemoved.push(stamp);
		else if (!a.live && b.live) d.claimsRevived.push(stamp);
	}
	for (const [stamp, a] of pre.claims) {
		if (!post.claims.has(stamp) && a.live) d.claimsRemoved.push(stamp); // live → absent
	}
	for (const [id, b] of post.blocks) {
		const a = pre.blocks.get(id);
		if (a === undefined) {
			d.blocksNew.push(id);
			continue;
		}
		if (!a.deleted && b.deleted) d.delSet.push({ id, stamp: b.delStamp });
		else if (a.deleted && !b.deleted) d.delCleared.push(id);
		if (a.placements !== b.placements) d.placementsChanged.push(id);
	}
	for (const [id] of pre.blocks) {
		if (!post.blocks.has(id)) d.blocksGone.push(id);
	}
	return d;
};

const checkEnvelope = (diff: OpDiff, env: IntentEnvelope, post: OpState): string[] => {
	const bad: string[] = [];
	for (const k of diff.atomsNew) {
		const text = post.atoms.get(k)?.text;
		const ok =
			env.atomAny?.has(k) ||
			(env.atomsIn !== undefined && text !== undefined && env.atomsIn.texts.has(text));
		if (!ok) bad.push(`wrote atom ${k} in '${text}'`);
	}
	if (env.atomsIn?.count !== undefined && diff.atomsNew.length > env.atomsIn.count) {
		bad.push(`wrote ${diff.atomsNew.length} atoms, intent was ≤${env.atomsIn.count}`);
	}
	for (const k of diff.atomsOut) {
		if (!(env.atomAny?.has(k) || env.atomsOut?.has(k))) bad.push(`tombstoned atom ${k}`);
	}
	for (const k of diff.atomsRevived) {
		if (!env.atomAny?.has(k)) bad.push(`revived atom ${k}`);
	}
	for (const m of diff.marksChanged) {
		const allowed = env.marks?.get(m.key);
		const postMarks = post.atoms.get(m.key)?.marksObj;
		const unauth = m.keys.filter((k) => {
			// Authorized iff the key is in the op's mark map AND the value
			// it ended with is one of the authorized post-values (R6 —
			// `{name}` alone is not a license to write any value).
			const vals = allowed?.get(k);
			return vals === undefined || !vals.has(canonKey(postMarks?.[k]));
		});
		if (unauth.length > 0 && env.markTexts?.has(m.text) !== true) {
			bad.push(`changed marks [${unauth.join('/')}] on atom ${m.key}`);
		}
	}
	for (const k of diff.payloadChanged) bad.push(`mutated inline payload of atom ${k}`);
	for (const c of diff.claimsNew) {
		if (!(env.claimsAny?.has(c.stamp) || env.claimsWrite?.(c.row, c.stamp))) {
			bad.push(`wrote ${c.row.kind} claim ${c.stamp} on '${c.row.holder}'`);
		}
	}
	for (const s of diff.claimsRemoved) {
		if (!(env.claimsAny?.has(s) || env.claimsRemove?.has(s))) bad.push(`removed claim ${s}`);
	}
	for (const s of diff.claimsRevived) {
		if (!env.claimsAny?.has(s)) bad.push(`revived claim ${s}`);
	}
	for (const id of diff.blocksNew) {
		if (!env.blocksCreate?.has(id)) bad.push(`created block '${id}'`);
	}
	for (const id of diff.blocksGone) {
		if (!env.blocksRemove?.has(id)) bad.push(`removed block '${id}'`);
	}
	for (const dd of diff.delSet) {
		if (!(env.delSet?.has(dd.id) || env.delAny?.has(dd.id))) bad.push(`deleted block '${dd.id}'`);
	}
	for (const id of diff.delCleared) {
		if (!(env.delClear?.has(id) || env.delAny?.has(id))) bad.push(`cleared delete on '${id}'`);
	}
	for (const id of diff.placementsChanged) {
		if (!env.placements?.has(id)) bad.push(`reparented block '${id}'`);
	}
	return bad;
};

/** True iff the diff observed zero replicated-state change. */
const diffIsEmpty = (d: OpDiff): boolean =>
	d.atomsNew.length === 0 &&
	d.atomsOut.length === 0 &&
	d.atomsRevived.length === 0 &&
	d.marksChanged.length === 0 &&
	d.payloadChanged.length === 0 &&
	d.claimsNew.length === 0 &&
	d.claimsRemoved.length === 0 &&
	d.claimsRevived.length === 0 &&
	d.blocksNew.length === 0 &&
	d.blocksGone.length === 0 &&
	d.delSet.length === 0 &&
	d.delCleared.length === 0 &&
	d.placementsChanged.length === 0;

/** Compact human-readable summary of a diff (foreign-peer reporting). */
const diffSummary = (d: OpDiff): string[] => {
	const out: string[] = [];
	if (d.atomsNew.length) out.push(`${d.atomsNew.length} atom(s) written`);
	if (d.atomsOut.length) out.push(`${d.atomsOut.length} atom(s) tombstoned`);
	if (d.atomsRevived.length) out.push(`${d.atomsRevived.length} atom(s) revived`);
	if (d.marksChanged.length) out.push(`${d.marksChanged.length} atom(s) re-marked`);
	if (d.payloadChanged.length) out.push(`${d.payloadChanged.length} payload(s) mutated`);
	if (d.claimsNew.length) out.push(`${d.claimsNew.length} claim(s) written`);
	if (d.claimsRemoved.length) out.push(`${d.claimsRemoved.length} claim(s) removed`);
	if (d.claimsRevived.length) out.push(`${d.claimsRevived.length} claim(s) revived`);
	if (d.blocksNew.length) out.push(`blocks ${d.blocksNew.join('/')}`);
	if (d.blocksGone.length) out.push(`blocks gone ${d.blocksGone.join('/')}`);
	if (d.delSet.length) out.push(`deleted ${d.delSet.map((x) => x.id).join('/')}`);
	if (d.delCleared.length) out.push(`undeleted ${d.delCleared.join('/')}`);
	if (d.placementsChanged.length) out.push(`reparented ${d.placementsChanged.join('/')}`);
	return out;
};

/**
 * Undo/redo stack fingerprint (R6s). A `model.undo()` hidden inside a
 * non-history op's exec reverts the op's own writes while leaving an
 * EMPTY doc-state diff (the tombstoned format markers are not atoms), so
 * state diff alone cannot see it. The fingerprint reads stack lengths
 * plus the redo top item's identity: a legit non-history op may PUSH an
 * undo item (its own capture) but must never pop the undo stack, and the
 * redo stack is cleared by capture — it must never grow or swap tops.
 */
const histSnap = (p: Peer) => {
	const um = p.undoManager;
	if (!um) return null;
	return {
		undoLen: um.undoStack.length,
		redoLen: um.redoStack.length,
		redoTop: um.redoStack.length > 0 ? um.redoStack[um.redoStack.length - 1] : null
	};
};

/** Live claim stamps held on any of `holders`' lists (from a pre-state). */
const liveClaimsOf = (pre: OpState, holders: ReadonlySet<string>): Set<string> => {
	const out = new Set<string>();
	for (const [stamp, c] of pre.claims) if (c.live && holders.has(c.holder)) out.add(stamp);
	return out;
};

/** `m` values of live merge claims on `holder`'s list (from a pre-state). */
const mergeTargetsOf = (pre: OpState, holder: string): Set<string> => {
	const out = new Set<string>();
	for (const [, c] of pre.claims) {
		if (c.live && c.holder === holder && c.kind === 'merge' && c.m !== undefined) out.add(c.m);
	}
	return out;
};

/** The effects a peer's history ops (undo/redo) may lawfully touch —
 *  the union of what its own recorded ops wrote or tombstoned. */
type PeerHist = {
	atoms: Set<string>;
	claims: Set<string>;
	texts: Set<string>;
	dels: Set<string>;
	blocks: Set<string>;
	placements: Set<string>;
	marks: Map<string, Set<string>>;
	/** Merge-claim targets (`{m:X}` X values) the peer's ops wrote —
	 *  a redo re-issues the claim under a fresh stamp. */
	mergeTargets: Set<string>;
};

const classifyStructural = (violations: string[]): string[] => {
	const kinds = new Set<string>();
	for (const v of violations) {
		if (v.includes('duplicate placement')) kinds.add('duplicate-placement');
		else if (v.includes('duplicate inline')) kinds.add('duplicate-inline');
		else if (v.includes('malformed-node')) kinds.add('malformed-node');
		else if (v.includes('unreachable-block')) kinds.add('unreachable-block');
		else if (v.includes('cycle')) kinds.add('cycle');
		else kinds.add('unknown');
	}
	return [...kinds];
};

export type RunOpts = {
	/**
	 * Diagnostic hook invoked once after the barrier (or at abort) with the
	 * executed peer set — lets failure triage read authoritative engine
	 * state without re-executing the schedule. Never called on the green
	 * path's hot loop, only once per run.
	 */
	inspectAfter?: (peers: Peer[], projections: ProjectedDoc[] | null) => void;
};

/**
 * Run `schedule` on a fresh peer set. Throws nothing — failures are returned
 * as `ok:false` with a readable `failure` string.
 */
export const runSchedule = (
	schedule: Schedule,
	ops: CrdtOps,
	seed: SeedUpdate,
	opts: RunOpts = {}
): RunResult => {
	// rngSeed pins every minted identity to (seed, peerIndex): peer clientIDs
	// are firstClientId+i with firstClientId = 1+(seed mod 2^20), the seed
	// doc is SEED_DOC_CLIENT_ID, and each doc's rank rand stream is keyed by
	// (seed, peerIndex, reloadGeneration) — a committed schedule replays
	// byte-identically.
	const set = createPeerSet(schedule.peers, seed, { rngSeed: schedule.seed });
	const peers = set.peers;
	const name = (i: number) => peers[i % peers.length].name;
	// Seed-block identities on peer A before any op runs — the reference for
	// the lost-identity check (engine ids differ across peer-set creations).
	const identitiesBefore = snapshotIdentities(peers[0], ops);
	// Evidence tracking. Each successful insertText records its unique tag
	// plus — on adapters exposing the strict oracle — the engine ids of the
	// atoms it wrote, so the barrier can check each atom's fate instead of a
	// flat substring (`atoms: null` = the insert reported success but the
	// tag was found in NO backing text: already the loss signature).
	const insertedTags = new Map<
		string,
		{
			peer: Peer;
			blockId: string;
			textId?: string;
			atoms?: { c: number; k: number }[] | null;
			/** Birth fingerprints per atom (U5): marks/payload at insert time. */
			meta?: { marks: string; marksObj?: Record<string, unknown>; payload: string }[];
			insertOwners?: Set<string>;
		}
	>();
	const deletedIds = new Set<string>();
	// Schedule-side causal context for the strict oracle (gate-F1 F3):
	// every block id a recorded split (`newId`) or merge (`intoId`)
	// produced. A tag's atoms landing under one of these owners is an
	// explainable move; under any other visible owner it is an
	// unexplained transfer → `stolen` (the oracle's `legitOwners` input).
	// LEGACY path only — intent-capable adapters replace this run-global
	// permission with `blessedClaims` (per-claim-stamp authorization).
	const legitOwners = new Set<string>();

	// ── operation-intent ledger (U5) ────────────────────────────────────
	const intentOn = !!(ops.captureOpState && ops.opTarget && ops.deadCause);
	/** Claim stamps the schedule lawfully wrote (seed claims + every
	 *  envelope-approved claim write). The barrier's `authorizedClaims`. */
	const blessedClaims = new Set<StampKey>();
	/** Atom keys a scheduled delete/remove/history op tombstoned. */
	const recordedTombstones = new Set<StampKey>();
	/**
	 * Blocks whose registry record an authorized op DESTROYED (`blocksGone`
	 * — e.g. an undo reverting a block's creation, or GC of an undone
	 * record). Atoms living in such a block's backing text die with it via
	 * parent-cascade on each replica — a tombstone no per-op diff observes
	 * on the atom itself. `dead-owner` is the coverage-level view of the
	 * same event; a GC'd item surfaces as `tombstoned` instead.
	 */
	const goneBlocks = new Set<BlockId>();
	/** Blocks whose del flag is ON per recorded diffs (resurrection check). */
	const delOn = new Set<string>();
	/** Blocks whose del flag was set by an AUTHORIZED op at least once —
	 *  unlike `delOn` this is cumulative: an authorized clear doesn't
	 *  revoke the original delete's legitimacy (redelivery re-asserts it). */
	const delAuthed = new Set<string>();
	/** Block id → stamps of the items that carried its `del` flag. */
	const delStamps = new Map<string, Set<string>>();
	/** Atom key → mark name → authorized canonical values (birth ∪ op-wrote). */
	const markLedger = new Map<string, Map<string, Set<string>>>();
	/**
	 * Backing text → mark name → authorized canonical values (R6 barrier
	 * widening). Marks are carried by MARKER ITEMS inside the shared text —
	 * a setMark on peer A folds onto exactly the atoms A had integrated;
	 * atoms peer C inserted concurrently into the same text pick the marker
	 * up on CONVERGENCE without any op ever diffing them. Per-atom
	 * authorization alone therefore false-positives on legitimate
	 * concurrent pickup; the text-level set is the honest bound — the
	 * per-atom check still runs per op (the executing peer's diff is exact).
	 */
	const textMarkLedger = new Map<string, Map<string, Set<string>>>();
	/**
	 * Atom key → every backing text it has inhabited. Atoms move between
	 * texts on split/merge while keeping their folded marks — a mark
	 * picked up in text T stays lawful after the atom lands in T′.
	 */
	const atomTexts = new Map<string, Set<string>>();
	/** Per-peer union of effects its own ops produced — the undo/redo envelope. */
	const peerHist = new Map<number, PeerHist>();
	/** Op-level intent violations, collected as they happen. */
	const intentViolations: string[] = [];
	const opCounts: Record<string, number> = {};
	let skippedOps = 0;
	let historyOps = 0;
	const violationKinds = new Set<string>();

	const histOf = (peerIdx: number): PeerHist => {
		let h = peerHist.get(peerIdx);
		if (!h) {
			h = {
				atoms: new Set(),
				claims: new Set(),
				texts: new Set(),
				dels: new Set(),
				blocks: new Set(),
				placements: new Set(),
				marks: new Map(),
				mergeTargets: new Set()
			};
			peerHist.set(peerIdx, h);
		}
		return h;
	};

	/** History ops may touch exactly what the peer's own ops touched —
	 *  plus the shapes an undo/redo legitimately produces:
	 *  - `atomsIn` over touched texts: undo resurrects deleted atoms as NEW
	 *    items (redone copies), so their keys are fresh — only the home
	 *    text can be bounded.
	 *  - `claimsWrite` over touched texts/blocks + recorded merge targets:
	 *    the R3 undo-repair writes fresh slice records on the ORIGINAL
	 *    holder's list (any holder that covered the resurrected span —
	 *    unbounded by this peer's writes), and a redo re-issues a merge
	 *    claim under a fresh stamp.
	 */
	const historyEnv = (peerIdx: number): IntentEnvelope => {
		const h = peerHist.get(peerIdx);
		if (!h) return {};
		const claimTexts = new Set([...h.texts, ...h.blocks]);
		return {
			atomAny: h.atoms,
			atomsIn: { texts: h.texts },
			claimsAny: h.claims,
			claimsWrite: (c) =>
				(c.kind === 'slice' && c.t !== undefined && claimTexts.has(c.t)) ||
				(c.kind === 'merge' && c.m !== undefined && h.mergeTargets.has(c.m)),
			delAny: h.dels,
			blocksCreate: h.blocks,
			blocksRemove: h.blocks,
			placements: h.placements,
			markTexts: h.texts,
			// R6 value-binding: an undo/redo may only restore values some
			// authorized op actually wrote (or a birth/baseline value) — the
			// mark ledger holds exactly that set per (atom, name).
			marks: new Map(
				[...h.marks].map(
					([k, names]) =>
						[
							k,
							new Map(
								[...names].map((n) => [n, markLedger.get(k)?.get(n) ?? new Set<string>()] as const)
							)
						] as const
				)
			)
		};
	};

	/** Record an executed op's effects into the run's authorization ledger. */
	const recordEffects = (
		diff: OpDiff,
		env: IntentEnvelope,
		pre: OpState,
		post: OpState,
		peerIdx: number,
		history: boolean
	) => {
		// Only ENVELOPE-authorized tombstones enter the ledger — an atom
		// killed outside the op's range stays unauthorized, so the barrier
		// still reports it even when the per-op flag is somehow missed.
		for (const k of diff.atomsOut) {
			if (env.atomAny?.has(k) || env.atomsOut?.has(k)) recordedTombstones.add(k);
		}
		for (const c of diff.claimsNew) {
			if (env.claimsAny?.has(c.stamp) || env.claimsWrite?.(c.row, c.stamp)) {
				blessedClaims.add(c.stamp);
			}
		}
		for (const dd of diff.delSet) {
			delOn.add(dd.id);
			deletedIds.add(dd.id);
			// Ever-authorized delete: an authorized `del` write stays lawful
			// even after a later authorized undo clears it — delivery of the
			// SAME delete on another replica (or redelivery here) re-asserts
			// the flag without a fresh diff, so the barrier cannot rely on
			// `delOn`'s live view alone.
			if (env.delSet?.has(dd.id) || env.delAny?.has(dd.id)) delAuthed.add(dd.id);
			if (dd.stamp !== null) {
				const s = delStamps.get(dd.id) ?? new Set<string>();
				s.add(dd.stamp);
				delStamps.set(dd.id, s);
			}
		}
		for (const id of diff.delCleared) delOn.delete(id);
		// Authorized record destructions (undo-of-create etc.) — content
		// atoms in the block's text are lawfully dead with it.
		for (const id of diff.blocksGone) {
			if (env.blocksRemove?.has(id) || env.delAny?.has(id)) goneBlocks.add(id);
		}
		// Ledger bookkeeping shared by the per-atom and per-text tables.
		const ledgerAdd = (
			table: Map<string, Map<string, Set<string>>>,
			slot: string,
			name: string,
			v: unknown
		): void => {
			let perKey = table.get(slot);
			if (!perKey) table.set(slot, (perKey = new Map()));
			let vals = perKey.get(name);
			if (!vals) perKey.set(name, (vals = new Set()));
			vals.add(canonKey(v));
		};
		// Authorized marks changes extend the mark ledger — the barrier compares
		// per-key values against this set (concurrent same-key writes merge by
		// accumulating every authorized value). R6: record BOTH endpoints —
		// an undo restoring the pre-value is as lawful as the write itself.
		for (const m of diff.marksChanged) {
			const allowed = env.marks?.get(m.key);
			const sideFx = env.markTexts?.has(m.text) === true;
			const postMarks = post.atoms.get(m.key)?.marksObj;
			const unauth = m.keys.filter((k) => {
				const vals = allowed?.get(k);
				return vals === undefined || !vals.has(canonKey(postMarks?.[k]));
			});
			if (unauth.length > 0 && !sideFx) continue; // violation — not authorized
			const preMarks = pre.atoms.get(m.key)?.marksObj;
			for (const name of m.keys) {
				ledgerAdd(markLedger, m.key, name, preMarks?.[name]);
				ledgerAdd(markLedger, m.key, name, postMarks?.[name]);
				// Same (name, value) is lawful for any atom of this text —
				// concurrent inserts pick the marker up on convergence.
				ledgerAdd(textMarkLedger, m.text, name, preMarks?.[name]);
				ledgerAdd(textMarkLedger, m.text, name, postMarks?.[name]);
			}
		}
		// New atoms seed the ledger with their BIRTH marks — the values a
		// later op (or history op) may lawfully find them carrying. Revived
		// atoms seed the same way: an undo restores the atom WITH its
		// pre-delete marks as fresh items whose marks never appear in
		// `marksChanged` (live→live only).
		for (const k of [...diff.atomsNew, ...diff.atomsRevived]) {
			const row = post.atoms.get(k);
			const mo = row?.marksObj;
			if (mo === undefined) continue;
			for (const [name, v] of Object.entries(mo)) {
				ledgerAdd(markLedger, k, name, v);
				if (row) ledgerAdd(textMarkLedger, row.text, name, v);
			}
		}
		// Track every text each atom inhabits — marks picked up in one text
		// remain lawful after a split moves the atom to a fresh text.
		for (const [k, a] of post.atoms) {
			let texts = atomTexts.get(k);
			if (!texts) atomTexts.set(k, (texts = new Set()));
			texts.add(a.text);
		}
		const h = histOf(peerIdx);
		for (const k of diff.atomsNew) h.atoms.add(k);
		for (const k of diff.atomsOut) h.atoms.add(k);
		for (const k of diff.atomsRevived) h.atoms.add(k);
		for (const c of diff.claimsNew) {
			h.claims.add(c.stamp);
			if (c.row.kind === 'merge' && c.row.m !== undefined) h.mergeTargets.add(c.row.m);
		}
		for (const s of diff.claimsRemoved) h.claims.add(s);
		for (const s of diff.claimsRevived) h.claims.add(s);
		for (const dd of diff.delSet) h.dels.add(dd.id);
		for (const id of diff.delCleared) h.dels.add(id);
		for (const id of diff.blocksNew) h.blocks.add(id);
		for (const id of diff.blocksGone) h.blocks.add(id);
		for (const id of diff.placementsChanged) h.placements.add(id);
		if (env.touchedTexts) for (const t of env.touchedTexts) h.texts.add(t);
		if (env.atomsIn) for (const t of env.atomsIn.texts) h.texts.add(t);
		if (env.markTexts) for (const t of env.markTexts) h.texts.add(t);
		if (env.marks) {
			for (const [k, names] of env.marks) {
				let perKey = h.marks.get(k);
				if (!perKey) h.marks.set(k, (perKey = new Set()));
				for (const n of names.keys()) perKey.add(n);
			}
		}
	};
	// Observed environment loss, split by kind (WU3): `sawPendingDrop` = a
	// reload discarded never-integrated pending items (correct semantics —
	// pending data is not durable); `sawStateRegression` = a reload lost
	// INTEGRATED state (e.g. restoring the stale seed persist — deliberate
	// harness loss, like an operator restoring an old backup). Either one
	// licenses the `convergent-loss` classification at the barrier.
	// `drop`/partitions are not loss: the originator retains its copy.
	let sawPendingDrop = false;
	let sawStateRegression = false;
	// Gate-F1 F4: WHAT the loss destroyed, not just THAT it happened —
	// the item-id ranges a reload actually discarded (pending contents +
	// pendingDs targets captured pre-reload, plus the regressed
	// state-vector ranges). `convergent-loss` at the barrier requires the
	// hard atom's own id or one of its coverage deps to intersect these
	// ranges (or the post-barrier stranded set); an unrelated lossy reload
	// elsewhere in the run excuses nothing.
	const lostRanges: IdRange[] = [];
	let firstError: { step: number; engineInternal: boolean; message: string } | null = null;
	let executed = 0;

	const ids = (peer: Peer) => ops.listBlockIds(peer);
	const resolveId = (peer: Peer, idx: number): string | undefined => {
		const list = ids(peer);
		return list.length === 0 ? undefined : list[idx % list.length];
	};
	const resolveParent = (peer: Peer, idx: number): string | null => {
		const list = ids(peer);
		// idx === list.length → root
		return idx >= list.length ? null : list[idx];
	};

	/** The displayed-atom range an op may touch — mirrors the model's own
	 *  clamp (`at = clamp(offset,0,len)`, `end = min(len, at+max(0,length))`). */
	const atomRange = (tgt: OpTarget, offset: number, length: number): Set<string> => {
		const at = Math.max(0, Math.min(offset, tgt.atoms.length));
		const end = Math.min(tgt.atoms.length, at + Math.max(0, length));
		return new Set(tgt.atoms.slice(at, end).map((a) => a.key));
	};

	/**
	 * Resolve the op's target on the executing peer, build the intent
	 * envelope and the adapter call. `null` = the op is skipped without
	 * running (unresolvable target — same behavior as the legacy path).
	 * A resolved-but-invisible target yields an EMPTY envelope: the op must
	 * produce no state change at all.
	 */
	const planIntent = (
		peer: Peer,
		op: DocOp,
		stepIdx: number,
		pre: OpState
	): {
		env: IntentEnvelope;
		exec: () => unknown;
		history?: boolean;
		after?: (result: unknown, diff: OpDiff, post: OpState) => void;
	} | null => {
		const EMPTY: IntentEnvelope = {};
		switch (op.kind) {
			case 'insertBlock': {
				const parent = resolveParent(peer, stepIdx + (peer.name.charCodeAt(0) % 3));
				const created = new Set([sanitizeWireString(op.id)]);
				return {
					env: {
						blocksCreate: created,
						placements: created,
						// A new block writes only its self-slice record.
						claimsWrite: (c) => created.has(c.holder) && c.kind === 'slice' && c.t === c.holder,
						touchedTexts: created
					},
					exec: () =>
						ops.insertBlock(peer, { parent, index: stepIdx % 5 }, { id: op.id, type: op.type })
				};
			}
			case 'deleteBlock': {
				const id = resolveId(peer, op.idIndex);
				if (id === undefined) return null;
				return { env: { delSet: new Set([id]) }, exec: () => ops.deleteBlock(peer, id) };
			}
			case 'moveBlock': {
				const id = resolveId(peer, op.idIndex);
				if (id === undefined) return null;
				const parent = resolveParent(peer, op.parentIndex);
				return {
					env: { placements: new Set([id]) },
					exec: () => ops.moveBlock(peer, id, { parent, index: op.destIndex })
				};
			}
			case 'nest': {
				const id = resolveId(peer, op.idIndex);
				const parent = resolveId(peer, op.parentIndex);
				if (id === undefined || parent === undefined || parent === id) return null;
				return { env: { placements: new Set([id]) }, exec: () => ops.nestBlock(peer, id, parent) };
			}
			case 'unNest': {
				const id = resolveId(peer, op.idIndex);
				if (id === undefined) return null;
				return { env: { placements: new Set([id]) }, exec: () => ops.unNestBlock(peer, id) };
			}
			case 'split': {
				const id = resolveId(peer, op.idIndex);
				if (id === undefined) return null;
				const tgt = ops.opTarget!(peer, id);
				if (tgt === null)
					return { env: EMPTY, exec: () => ops.splitBlock(peer, id, op.offset, op.newId) };
				const newId = sanitizeWireString(op.newId);
				const mergeMs = mergeTargetsOf(pre, id);
				return {
					env: {
						blocksCreate: new Set([newId]),
						// newId's own placement + the children reparented onto it.
						placements: new Set([newId, ...tgt.children]),
						// Entries on `id`'s list may be tombstoned (moved/cut);
						// writes land on `id` (head materialization) and `newId`
						// (tail records + verbatim merge claims).
						claimsRemove: liveClaimsOf(pre, new Set([id])),
						claimsWrite: (c) =>
							(c.holder === id || c.holder === newId) &&
							(c.kind === 'slice'
								? c.t !== undefined && tgt.texts.has(c.t)
								: c.kind === 'merge'
									? c.m !== undefined && mergeMs.has(c.m)
									: false),
						touchedTexts: new Set([...tgt.texts, newId])
					},
					exec: () => ops.splitBlock(peer, id, op.offset, op.newId)
				};
			}
			case 'merge': {
				const from = resolveId(peer, op.fromIndex);
				const into = resolveId(peer, op.intoIndex);
				if (from === undefined || into === undefined || from === into) return null;
				const tgtFrom = ops.opTarget!(peer, from);
				if (tgtFrom === null) return { env: EMPTY, exec: () => ops.mergeBlocks(peer, from, into) };
				return {
					env: {
						// The merge claim lands on `into`'s list; `from`'s children
						// reparent onto `into`.
						placements: new Set(tgtFrom.children),
						claimsWrite: (c) => c.holder === into && c.kind === 'merge' && c.m === from,
						touchedTexts: tgtFrom.texts
					},
					exec: () => ops.mergeBlocks(peer, from, into)
				};
			}
			case 'insertText': {
				const id = resolveId(peer, op.idIndex);
				if (id === undefined) return null;
				const tgt = ops.opTarget!(peer, id);
				const env: IntentEnvelope =
					tgt === null
						? EMPTY
						: {
								atomsIn: { texts: tgt.texts, count: op.text.length },
								// Boundary claims land on a holder routing to `id`
								// (its own list included) and target reachable texts.
								claimsWrite: (c) =>
									tgt.holders.has(c.holder) &&
									c.kind === 'slice' &&
									c.t !== undefined &&
									tgt.texts.has(c.t),
								claimsRemove: liveClaimsOf(pre, tgt.holders),
								touchedTexts: tgt.texts
							};
				return {
					env,
					exec: () => ops.insertText(peer, id, op.offset, op.text),
					after: (ok, diff, post) => {
						if (!ok) return;
						// Strict-oracle adapters pin the atoms now; `null` means
						// the insert returned success but wrote nothing findable.
						// `onlyNew` rejects coincidental same-substring assemblies
						// built from stale fragments of other inserts — the tag's
						// atoms are exactly the ones THIS op wrote.
						const located = ops.locateTagAtoms?.(peer, op.tag, new Set(diff.atomsNew)) ?? null;
						const atoms = ops.locateTagAtoms ? (located?.atoms ?? null) : undefined;
						// F3 insert-time steal check — unchanged: a correct insert
						// owns its atoms locally at birth.
						let insertOwners: Set<string> | undefined;
						if (ops.classifyTagAtoms && atoms) {
							const owners = new Set(
								ops
									.classifyTagAtoms(peer, id, atoms)
									.flatMap((f) => (f.kind === 'moved' ? [f.owner] : []))
							);
							if (owners.size > 0) insertOwners = owners;
						}
						// R6o position binding: `atomsIn` bounds WHICH text and
						// how many atoms the op writes — not WHERE they land. The
						// request was "insert at display offset `op.offset`"
						// (clamped like the model's own clamp), so the tag's
						// atoms must occupy exactly [at, at+n) of the target's
						// post-op display, in order.
						if (tgt !== null && atoms != null && atoms.length > 0 && ops.opTarget) {
							const postTgt = ops.opTarget(peer, id);
							if (postTgt !== null) {
								const at = Math.max(0, Math.min(op.offset, tgt.atoms.length));
								const want = atoms.map((a) => `${a.c}:${a.k}`);
								const got = postTgt.atoms.slice(at, at + want.length).map((x) => x.key);
								if (want.join(',') !== got.join(',')) {
									violationKinds.add('unrequested-effect');
									intentViolations.push(
										`step ${stepIdx} insertText: tag atoms landed outside the requested window [${at},${at + want.length}) of '${id}'`
									);
								}
							}
						}
						insertedTags.set(op.tag, {
							peer,
							blockId: id,
							...(ops.locateTagAtoms
								? { textId: located?.textId, atoms, meta: located?.meta }
								: {}),
							...(insertOwners ? { insertOwners } : {})
						});
					}
				};
			}
			case 'deleteText': {
				const id = resolveId(peer, op.idIndex);
				if (id === undefined) return null;
				const tgt = ops.opTarget!(peer, id);
				const env: IntentEnvelope =
					tgt === null
						? EMPTY
						: {
								// Exactly the displayed atoms in [offset, offset+length)
								// may tombstone — nothing else.
								atomsOut: atomRange(tgt, op.offset, op.length),
								// Deleting a marker inside the range legitimately shifts
								// folded marks of surviving same-text atoms.
								markTexts: tgt.texts,
								touchedTexts: tgt.texts
							};
				return { env, exec: () => ops.deleteText(peer, id, op.offset, op.length) };
			}
			case 'setMark':
			case 'unsetMark': {
				const id = resolveId(peer, op.idIndex);
				if (id === undefined) return null;
				const tgt = ops.opTarget!(peer, id);
				const env: IntentEnvelope =
					tgt === null
						? EMPTY
						: {
								// Marks only — no ownership change, no deletion, no
								// claims. Exactly `op.name` may change on the ranged
								// atoms, and only to the REQUESTED post-value (R6):
								// `true` for setMark, absent (`canonKey` 'null') for
								// unsetMark — a wrong value on the authorized key is a
								// violation.
								marks: new Map(
									[...atomRange(tgt, op.offset, op.length)].map(
										(k) =>
											[
												k,
												new Map([
													[op.name, new Set([canonKey(op.kind === 'setMark' ? true : null)])]
												])
											] as const
									)
								),
								touchedTexts: tgt.texts
							};
				const exec =
					op.kind === 'setMark'
						? () => ops.setMark(peer, id, op.offset, op.length, op.name, true)
						: () => ops.unsetMark(peer, id, op.offset, op.length, op.name);
				return { env, exec };
			}
			case 'insertInline': {
				const id = resolveId(peer, op.idIndex);
				if (id === undefined) return null;
				const tgt = ops.opTarget!(peer, id);
				const env: IntentEnvelope =
					tgt === null
						? EMPTY
						: {
								atomsIn: { texts: tgt.texts, count: 1 },
								claimsWrite: (c) =>
									tgt.holders.has(c.holder) &&
									c.kind === 'slice' &&
									c.t !== undefined &&
									tgt.texts.has(c.t),
								claimsRemove: liveClaimsOf(pre, tgt.holders),
								touchedTexts: tgt.texts
							};
				return {
					env,
					exec: () =>
						ops.insertInline(peer, id, op.offset, {
							id: op.atomId,
							type: 'mention',
							data: { tag: op.atomId }
						}),
					after: (ok, diff, post) => {
						if (!ok || !ops.classifyTagAtoms) return;
						// The written atom = the single new atom with a payload.
						const key = diff.atomsNew.find((k) => post.atoms.get(k)?.payload);
						const row = key === undefined ? undefined : post.atoms.get(key);
						if (key === undefined || row === undefined) return;
						const [c, k] = key.split(':').map(Number);
						const atoms = [{ c, k }];
						const owners = new Set(
							ops
								.classifyTagAtoms(peer, id, atoms)
								.flatMap((f) => (f.kind === 'moved' ? [f.owner] : []))
						);
						// R6o position binding: the atom must display at exactly
						// the requested (clamped) offset of the target.
						if (tgt !== null && ops.opTarget) {
							const postTgt = ops.opTarget(peer, id);
							const at = Math.max(0, Math.min(op.offset, tgt.atoms.length));
							if (postTgt !== null && postTgt.atoms[at]?.key !== key) {
								violationKinds.add('unrequested-effect');
								intentViolations.push(
									`step ${stepIdx} insertInline: atom ${key} landed outside the requested position ${at} of '${id}'`
								);
							}
						}
						insertedTags.set(op.atomId, {
							peer,
							blockId: id,
							textId: row.text,
							atoms,
							meta: [{ marks: row.marks, marksObj: row.marksObj, payload: row.payload }],
							...(owners.size > 0 ? { insertOwners: owners } : {})
						});
					}
				};
			}
			case 'removeInline': {
				const id = resolveId(peer, op.idIndex);
				if (id === undefined) return null;
				const block = findProjected(ops.project(peer), id);
				const inlines = inlineIdsOf(block);
				if (inlines.length === 0) return null;
				const picked = inlines[op.inlineIndex % inlines.length];
				const tgt = ops.opTarget!(peer, id);
				const atom = tgt?.atoms.find((a) => a.inlineId === picked)?.key;
				const env: IntentEnvelope =
					tgt === null
						? EMPTY
						: {
								atomsOut: new Set(atom === undefined ? [] : [atom]),
								markTexts: tgt.texts,
								touchedTexts: tgt.texts
							};
				return { env, exec: () => ops.removeInline(peer, id, picked) };
			}
			case 'undo':
				if (!ops.undo) return null;
				return {
					env: historyEnv(peer.index),
					history: true,
					exec: () => {
						ops.trackHistory?.(peer);
						ops.undo!(peer);
					}
				};
			case 'redo':
				if (!ops.redo) return null;
				return {
					env: historyEnv(peer.index),
					history: true,
					exec: () => {
						ops.trackHistory?.(peer);
						ops.redo!(peer);
					}
				};
		}
	};

	/** Legacy dispatch — adapters without the intent surface keep the
	 *  pre-U5 behavior (run-global `legitOwners` / `deletedIds` recording). */
	const runDocOpLegacy = (peer: Peer, op: DocOp, stepIdx: number) => {
		switch (op.kind) {
			case 'insertBlock':
				ops.insertBlock(
					peer,
					{
						parent: resolveParent(peer, stepIdx + (peer.name.charCodeAt(0) % 3)),
						index: stepIdx % 5
					},
					{ id: op.id, type: op.type }
				);
				break;
			case 'deleteBlock': {
				const id = resolveId(peer, op.idIndex);
				if (id !== undefined && ops.deleteBlock(peer, id)) deletedIds.add(id);
				break;
			}
			case 'moveBlock': {
				const id = resolveId(peer, op.idIndex);
				const parent = resolveParent(peer, op.parentIndex);
				if (id !== undefined) ops.moveBlock(peer, id, { parent, index: op.destIndex });
				break;
			}
			case 'nest': {
				const id = resolveId(peer, op.idIndex);
				const parent = resolveId(peer, op.parentIndex);
				if (id !== undefined && parent !== undefined && parent !== id)
					ops.nestBlock(peer, id, parent);
				break;
			}
			case 'unNest': {
				const id = resolveId(peer, op.idIndex);
				if (id !== undefined) ops.unNestBlock(peer, id);
				break;
			}
			case 'split': {
				const id = resolveId(peer, op.idIndex);
				if (id !== undefined && ops.splitBlock(peer, id, op.offset, op.newId))
					legitOwners.add(op.newId);
				break;
			}
			case 'merge': {
				const from = resolveId(peer, op.fromIndex);
				const into = resolveId(peer, op.intoIndex);
				if (from !== undefined && into !== undefined && from !== into)
					if (ops.mergeBlocks(peer, from, into)) legitOwners.add(into);
				break;
			}
			case 'insertText': {
				const id = resolveId(peer, op.idIndex);
				if (id !== undefined && ops.insertText(peer, id, op.offset, op.text)) {
					const located = ops.locateTagAtoms?.(peer, op.tag) ?? null;
					const atoms = ops.locateTagAtoms ? (located?.atoms ?? null) : undefined;
					let insertOwners: Set<string> | undefined;
					if (ops.classifyTagAtoms && atoms) {
						const owners = new Set(
							ops
								.classifyTagAtoms(peer, id, atoms)
								.flatMap((f) => (f.kind === 'moved' ? [f.owner] : []))
						);
						if (owners.size > 0) insertOwners = owners;
					}
					insertedTags.set(op.tag, {
						peer,
						blockId: id,
						...(ops.locateTagAtoms ? { textId: located?.textId, atoms, meta: located?.meta } : {}),
						...(insertOwners ? { insertOwners } : {})
					});
				}
				break;
			}
			case 'deleteText': {
				const id = resolveId(peer, op.idIndex);
				if (id !== undefined) ops.deleteText(peer, id, op.offset, op.length);
				break;
			}
			case 'setMark': {
				const id = resolveId(peer, op.idIndex);
				if (id !== undefined) ops.setMark(peer, id, op.offset, op.length, op.name, true);
				break;
			}
			case 'unsetMark': {
				const id = resolveId(peer, op.idIndex);
				if (id !== undefined) ops.unsetMark(peer, id, op.offset, op.length, op.name);
				break;
			}
			case 'insertInline': {
				const id = resolveId(peer, op.idIndex);
				if (id !== undefined)
					ops.insertInline(peer, id, op.offset, {
						id: op.atomId,
						type: 'mention',
						data: { tag: op.atomId }
					});
				break;
			}
			case 'removeInline': {
				const id = resolveId(peer, op.idIndex);
				if (id === undefined) break;
				const block = findProjected(ops.project(peer), id);
				const inlines = inlineIdsOf(block);
				if (inlines.length > 0)
					ops.removeInline(peer, id, inlines[op.inlineIndex % inlines.length]);
				break;
			}
			case 'undo':
				ops.undo?.(peer);
				break;
			case 'redo':
				ops.redo?.(peer);
				break;
		}
	};

	const runDocOp = (peer: Peer, op: DocOp, stepIdx: number) => {
		opCounts[op.kind] = (opCounts[op.kind] ?? 0) + 1;
		if (op.kind === 'undo' || op.kind === 'redo') historyOps++;
		if (!intentOn) {
			runDocOpLegacy(peer, op, stepIdx);
			return;
		}
		// Intent path: snapshot EVERY peer before/after (R6) — the op runs on
		// `peer` alone and net delivery is the only legal cross-peer channel,
		// so a diff on any other replica is an unrequested effect. This also
		// covers ops returning falsy while still mutating a foreign doc.
		const preAll = peers.map((p) => ops.captureOpState!(p));
		const plan = planIntent(peer, op, stepIdx, preAll[peer.index]);
		if (plan === null) {
			skippedOps++;
			return;
		}
		// History stacks: snapshot only for non-history ops — declared
		// undo/redo legitimately pop/push, everything else must leave the
		// stacks' pop-side untouched (see histSnap).
		const histPre = plan.history === true ? null : peers.map(histSnap);
		const result = plan.exec();
		const post = ops.captureOpState!(peer);
		const pre = preAll[peer.index];
		const diff = diffStates(pre, post);
		const bad = checkEnvelope(diff, plan.env, post);
		for (const p of peers) {
			if (p === peer) continue;
			const fd = diffStates(preAll[p.index], ops.captureOpState!(p));
			const parts = diffSummary(fd);
			if (parts.length > 0) bad.push(`foreign peer ${p.name} changed (${parts.join('; ')})`);
		}
		// A non-history op reporting refusal must produce an EMPTY local
		// diff — mutating while returning falsy is the same class of lie.
		if (plan.history !== true && !result && !diffIsEmpty(diff)) {
			bad.push('reported refusal (falsy) but mutated local state');
		}
		if (histPre !== null) {
			// Hidden-history detection (R6s): the executing peer may grow
			// undoStack (its own capture) but never shrink it, and the redo
			// stack must not grow or swap tops — either means `undo`/`redo`
			// ran inside the op. Foreign peers' stacks must not move at all.
			const hp = histPre[peer.index];
			const hq = histSnap(peer);
			if (hp !== null && hq !== null) {
				if (hq.undoLen < hp.undoLen) {
					bad.push('popped undo-stack item(s) inside a non-history op');
				}
				if (
					hq.redoLen > hp.redoLen ||
					(hp.redoTop !== null && hq.redoTop !== null && hq.redoTop !== hp.redoTop)
				) {
					bad.push('pushed/swapped redo-stack item(s) inside a non-history op');
				}
			}
			for (const p of peers) {
				if (p === peer) continue;
				const fp = histPre[p.index];
				const fq = histSnap(p);
				if (
					fp !== null &&
					fq !== null &&
					(fp.undoLen !== fq.undoLen || fp.redoLen !== fq.redoLen || fp.redoTop !== fq.redoTop)
				) {
					bad.push(`foreign peer ${p.name} history stack churned`);
				}
			}
		}
		if (bad.length > 0) {
			violationKinds.add('unrequested-effect');
			intentViolations.push(`step ${stepIdx} ${op.kind}: ${bad.slice(0, 8).join('; ')}`);
		}
		recordEffects(diff, plan.env, pre, post, peer.index, plan.history === true);
		plan.after?.(result, diff, post);
	};

	const runNetOp = (op: NetOp) => {
		const a = name(op.a);
		const b = name(op.b);
		switch (op.action) {
			case 'deliver':
				set.deliver(a, b);
				break;
			case 'deliverReverse':
				set.deliver(a, b, { reverse: true });
				break;
			case 'duplicate':
				set.deliver(a, b, { times: 2 });
				break;
			case 'batch':
				set.deliver(a, b, { batch: true });
				break;
			case 'deliverAll':
				set.deliverAll();
				break;
			case 'drop':
				set.dropQueued(a, b);
				break;
			case 'partition':
				set.partition(a, b);
				break;
			case 'heal':
				set.heal(a, b);
				break;
			case 'isolate':
				set.isolate(a);
				break;
			case 'healPeer':
				set.healPeer(a);
				break;
			case 'syncSV':
				set.syncPeer(a, b);
				break;
			case 'syncFull':
				set.syncPeerFull(a, b);
				break;
			case 'persist':
				set.peer(a).persist();
				break;
			case 'reloadSnap':
			case 'reloadLog': {
				const p = set.peer(a);
				const before = new Map(Y.decodeStateVector(p.stateVector()));
				const hadPending = p.doc.store.pendingStructs != null || p.doc.store.pendingDs != null;
				// F4: capture WHICH items the pending drop destroys — the ids
				// are gone the moment `reload` swaps the doc.
				const droppedPending = pendingItemRanges(p);
				p.reload(op.action === 'reloadSnap' ? 'snapshot' : 'log');
				const after = new Map(Y.decodeStateVector(p.stateVector()));
				// Two independent loss channels, tracked separately (WU3):
				// pending items dropped (never durable — correct semantics)
				// AND integrated state regressed (deliberate stale-snapshot
				// restore — a harness-injected loss, not an engine defect).
				if (hadPending) sawPendingDrop = true;
				lostRanges.push(...droppedPending);
				for (const [client, clock] of before) {
					const afterClock = after.get(client) ?? 0;
					if (afterClock < clock) {
						sawStateRegression = true;
						// The regressed tail is the destroyed range.
						lostRanges.push({ client, start: afterClock, len: clock - afterClock });
					}
				}
				break;
			}
		}
	};

	// U5 baseline: every claim item present at seed time is authorized —
	// the schedule never wrote them, but they ARE the state ops build on.
	// Baseline del flags seed delOn/delStamps the same way; baseline atoms
	// seed the mark ledger (birth values an undo may lawfully restore) and
	// already-dead atoms count as recorded tombstones.
	if (intentOn) {
		const base = ops.captureOpState!(peers[0]);
		for (const stamp of base.claims.keys()) blessedClaims.add(stamp);
		for (const [id, b] of base.blocks) {
			if (b.deleted) {
				delOn.add(id);
				delAuthed.add(id);
				if (b.delStamp !== null) delStamps.set(id, new Set([b.delStamp]));
			}
		}
		for (const [k, a] of base.atoms) {
			if (!a.live) recordedTombstones.add(k);
			let texts = atomTexts.get(k);
			if (!texts) atomTexts.set(k, (texts = new Set()));
			texts.add(a.text);
			if (a.marksObj) {
				let perKey = markLedger.get(k);
				if (!perKey) markLedger.set(k, (perKey = new Map()));
				let perText = textMarkLedger.get(a.text);
				if (!perText) textMarkLedger.set(a.text, (perText = new Map()));
				for (const [n, v] of Object.entries(a.marksObj)) {
					let vals = perKey.get(n);
					if (!vals) perKey.set(n, (vals = new Set()));
					vals.add(canonKey(v));
					let tvals = perText.get(n);
					if (!tvals) perText.set(n, (tvals = new Set()));
					tvals.add(canonKey(v));
				}
			}
		}
		// History ops need tracking attached BEFORE the first op runs — an
		// undo can only revert transactions that were already tracked.
		const hasHistory = schedule.steps.some((s) => s.op.kind === 'undo' || s.op.kind === 'redo');
		if (hasHistory && ops.trackHistory) for (const p of peers) ops.trackHistory(p);
	}

	for (let i = 0; i < schedule.steps.length; i++) {
		const step: Step = schedule.steps[i];
		try {
			const peer = peers[step.peer % peers.length];
			if (step.op.kind === 'net') {
				opCounts[`net:${step.op.action}`] = (opCounts[`net:${step.op.action}`] ?? 0) + 1;
				runNetOp(step.op);
			} else runDocOp(peer, step.op, i);
			executed++;
		} catch (err) {
			firstError = {
				step: i,
				engineInternal: err instanceof Error && ENGINE_INTERNAL_CRASH.test(err.stack ?? ''),
				message:
					err instanceof Error
						? `${err.message}\n${(err.stack ?? '').split('\n').slice(1, 6).join('\n')}`
						: String(err)
			};
			break;
		}
	}

	const sawLoss = sawPendingDrop || sawStateRegression;

	// Split observed classes into the legit set (evidence) vs hard failures
	// (violations) for THIS adapter — the partition that used to live in the
	// caller now happens here, so `violations` is always the gate list.
	const partition = (kinds: Iterable<string>): { violations: string[]; evidence: string[] } => {
		const legit = expectedViolations(ops);
		const violations: string[] = [];
		const evidence: string[] = [];
		for (const k of kinds) (legit.has(k) ? evidence : violations).push(k);
		return { violations: violations.sort(), evidence: evidence.sort() };
	};
	const aborted = (failure: string, kind: string): RunResult => {
		opts.inspectAfter?.(peers, null);
		return {
			ok: false,
			failure,
			...partition([kind]),
			lostEdits: [],
			lostIdentities: [],
			tagVerdicts: {},
			intentViolations,
			opCounts,
			skippedOps,
			historyOps,
			stepCount: executed
		};
	};

	if (firstError) {
		// A throw inside vendored-engine cleanup/integration machinery on a
		// legal update stream is an upstream robustness finding — recorded as
		// evidence with the persisted repro on the raw diagnostic adapter;
		// on the strict adapters `upstream-engine-crash` is NOT in the legit
		// set, so the same frame lands in `violations` and fails the seed.
		const kind = firstError.engineInternal ? 'upstream-engine-crash' : 'crash';
		return aborted(`step ${firstError.step} threw: ${firstError.message}`, kind);
	}

	// ── barrier: heal everything, flush, full sync ───────────────────────
	// Same crash classification as the step loop: engine-cleanup throws during
	// the flush are upstream findings on raw, hard failures on strict.
	try {
		for (const p of peers) set.healPeer(p.name);
		set.deliverAll();
		set.syncAll('full');
		set.deliverAll();
	} catch (err) {
		const engineInternal = err instanceof Error && ENGINE_INTERNAL_CRASH.test(err.stack ?? '');
		const kind = engineInternal ? 'upstream-engine-crash' : 'crash';
		const msg =
			err instanceof Error
				? `${err.message}\n${(err.stack ?? '').split('\n').slice(1, 6).join('\n')}`
				: String(err);
		return aborted(`barrier threw: ${msg}`, kind);
	}

	// Hard invariant: every replica's canonical projection is identical, and
	// decoded state vectors agree — UNLESS the divergence is explained by
	// pending state whose dependencies were destroyed on every replica
	// (convergent-loss is correct CRDT semantics, recorded as evidence).
	const projections = peers.map((p) => ops.project(p));
	const divergenceFailure = (detail: string): RunResult | null => {
		if (hasDestroyedPendingDeps(peers, sawLoss)) {
			violationKinds.add('convergent-loss');
			return null;
		}
		return {
			ok: false,
			failure: detail,
			violations: ['divergence'],
			evidence: [],
			lostEdits: [],
			lostIdentities: [],
			tagVerdicts: {},
			intentViolations,
			opCounts,
			skippedOps,
			historyOps,
			stepCount: executed
		};
	};
	for (let i = 1; i < projections.length; i++) {
		const diff = findFirstDiff(projections[0], projections[i]);
		if (diff) {
			const res = divergenceFailure(`divergence ${peers[0].name} vs ${peers[i].name}: ${diff}`);
			if (res) return res;
			break;
		}
	}
	const sv0 = new Map(Y.decodeStateVector(peers[0].stateVector()));
	for (let i = 1; i < peers.length; i++) {
		const svi = new Map(Y.decodeStateVector(peers[i].stateVector()));
		if (svi.size !== sv0.size || [...svi].some(([k, v]) => sv0.get(k) !== v)) {
			const res = divergenceFailure(`state-vector divergence ${peers[0].name} vs ${peers[i].name}`);
			if (res) return res;
			break;
		}
	}

	// Structural validity → classified evidence (or hard fail on unknowns).
	for (const p of peers) {
		for (const kind of classifyStructural(checkStructurallyValid(p, ops).violations)) {
			violationKinds.add(kind);
		}
	}

	// F4 loss-correlation state, computed once for the whole barrier: the
	// item ids stranded in pending state NOW (post heal+deliverAll+syncAll
	// — residue whose deps died on every replica) and the ranges destroyed
	// by observed reloads earlier in the run. A hard atom fate is
	// `convergent-loss` only when its own id or one of its coverage/owner
	// deps lands in either set — never on the bare fact that loss occurred.
	const strandedRanges = peers.flatMap((p) => pendingItemRanges(p));
	const depGone = (id: { c: number; k: number }): boolean =>
		inRanges(lostRanges, id) || inRanges(strandedRanges, id);
	const keyDepGone = (key: StampKey): boolean => {
		const [c, k] = key.split(':').map(Number);
		return depGone({ c, k });
	};

	/**
	 * R6 dead-owner causality: a `dead-owner` holder's coverage died with it —
	 * legit only when the schedule produced the death. `del` requires the del
	 * flag in `delOn` (a recorded delete, or baseline-seeded); `ancestor`
	 * defers to the dead display ancestor's own cause; `claim` requires every
	 * merge-claim stamp on the route to be schedule-written (`blessedClaims`)
	 * AND the chain's dead end explained. `absent`/`live` explain nothing.
	 */
	const explainDead = (id: string, depth: number): boolean => {
		if (depth > 8 || !ops.deadCause) return false;
		const c = ops.deadCause(peers[0], id);
		switch (c.kind) {
			case 'del':
				return delAuthed.has(id);
			case 'ancestor':
				return explainDead(c.root, depth + 1);
			case 'claim':
				return c.chain.every((s) => blessedClaims.has(s)) && explainDead(c.end, depth + 1);
			default:
				return false;
		}
	};

	/**
	 * R6 mutated-edit: a surviving atom's marks/payload at the barrier vs the
	 * values it may lawfully carry — every key of (birth ∪ current) must hold
	 * a ledgered value (mark ops record both endpoints; births and the
	 * baseline seed the ledger), and the payload must equal its birth
	 * fingerprint (no op may rewrite an inline payload — `payloadChanged` is
	 * already a per-op violation; this catches drift the op-diff missed).
	 */
	const atomMutated = (
		ctx: {
			atoms?: { c: number; k: number }[] | null;
			meta?: { marks: string; marksObj?: Record<string, unknown>; payload: string }[];
		},
		f: { marksObj?: Record<string, unknown>; payload?: string },
		i: number
	): boolean => {
		if (f.marksObj === undefined && f.payload === undefined) return false;
		const key = `${ctx.atoms![i].c}:${ctx.atoms![i].k}`;
		const meta = ctx.meta?.[i];
		const cur = f.marksObj;
		const keys = new Set([...Object.keys(meta?.marksObj ?? {}), ...Object.keys(cur ?? {})]);
		const texts = atomTexts.get(key);
		for (const name of keys) {
			const canon = canonKey(cur?.[name]);
			// Per-atom ledger: values an op actually wrote ON this atom (plus
			// birth/baseline). Falls back to the per-text ledger: a marker
			// written on a remote peer folds onto atoms it never saw — they
			// were inserted concurrently into the same backing text — and
			// follows them when a later split moves them to a new text.
			if (markLedger.get(key)?.get(name)?.has(canon) === true) continue;
			let textOk = false;
			if (texts !== undefined) {
				for (const t of texts) {
					if (textMarkLedger.get(t)?.get(name)?.has(canon) === true) {
						textOk = true;
						break;
					}
				}
			}
			if (!textOk) return true;
		}
		return meta !== undefined && f.payload !== undefined && f.payload !== meta.payload;
	};

	// Resurrected deletes: a logically deleted id visible in the final
	// state. U5: the excuse is correlated — the delete is explained only
	// when EVERY del-item stamp recorded for this id was destroyed or
	// stranded by an observed loss (`delStamps` ∩ lostRanges/stranded).
	// A lossy reload elsewhere in the run licenses nothing. The legacy
	// path (no intent surface) keeps the coarse sawLoss behavior — the
	// copy adapter's resurrection is expected evidence anyway.
	const finalIds = new Set<string>();
	for (const b of collectBlocks(projections[0])) finalIds.add(b.id);
	// `delOn` shrinks when an authorized op (undo) clears the flag, but a
	// delivered delete can re-assert it between diffs — the honest
	// "should be dead now" set is the flag's ACTUAL state at the barrier
	// (peers[0] final op-state), unioned with the diffed view.
	// `deletedIds` keeps the legacy historical set for non-intent adapters.
	const deletedNow = intentOn
		? (() => {
				const on = new Set(delOn);
				const fin = ops.captureOpState!(peers[0]);
				for (const [id, b] of fin.blocks) if (b.deleted) on.add(id);
				return on;
			})()
		: deletedIds;
	for (const id of deletedNow) {
		if (!finalIds.has(id)) continue;
		let explained = sawLoss;
		if (intentOn) {
			const stamps = delStamps.get(id);
			explained =
				stamps !== undefined && stamps.size > 0 ? [...stamps].every((s) => keyDepGone(s)) : sawLoss; // no stamp captured → can't disprove
		}
		violationKinds.add(explained ? 'convergent-loss' : 'resurrected-delete');
	}

	// ── Lost-edit oracle (WU3) ──────────────────────────────────────────
	// Adapters with the atom oracle get per-atom verdicts: the runner
	// recorded each tag's atom ids at insert time and `classifyTagAtoms`
	// reports where every atom ended — present under the target, moved to
	// another visible owner, STOLEN by an unexplained owner (gate-F1 F3),
	// tombstoned, dead-owner coverage, uncovered, unreachable, or gone.
	// Only actual loss is `lost-edit`; the legit classes are evidence.
	// Adapters without the oracle keep the legacy block-text substring
	// check (evidence there, never a proof).
	const lostEdits: string[] = [];
	const tagVerdicts: Record<string, string> = {};
	for (const [tag, ctx] of insertedTags) {
		if (ctx.atoms === undefined || !ops.classifyTagAtoms) {
			// Legacy path (raw adapter): block deleted → payload died with it.
			const block = findProjected(projections[0], ctx.blockId);
			if (block !== undefined && !flatText(block).includes(tag)) {
				lostEdits.push(tag);
				tagVerdicts[tag] = 'lost-edit(legacy substring)';
				violationKinds.add('lost-edit');
			}
			continue;
		}
		if (ctx.atoms === null) {
			// insertText reported success yet the tag was in NO backing text —
			// the write never happened. Real loss, not a classification call.
			lostEdits.push(tag);
			tagVerdicts[tag] = 'lost-edit(insert wrote no atoms)';
			violationKinds.add('lost-edit');
			continue;
		}
		// Per-tag legit-owner set: the schedule's recorded split/merge
		// products PLUS the atoms' home block (`textId` — the natural owner
		// of its own backing text, which reclaims the atoms whenever a
		// claim holding them dissolves — e.g. the claiming block is
		// concurrently deleted; gate-F1 seed-46 class) and the insert
		// target itself. An owner outside this set has no causal
		// explanation at all → `stolen`.
		// U5: on intent-capable adapters `authorizedClaims` REPLACES
		// `legitOwners` — destination-name evidence is gone; an ownership
		// path is legit iff every claim stamp on it (winning record + each
		// route merge claim) is one the executed schedule wrote (seed
		// claims + envelope-approved op writes, all minted items keyed by
		// their global `client:clock` so remote-delivered claims carry the
		// originating op's authorization).
		const oracleCtx: TagClassifyContext = intentOn
			? { authorizedClaims: blessedClaims, insertOwners: ctx.insertOwners }
			: {
					legitOwners: (() => {
						const legit = new Set(legitOwners);
						legit.add(ctx.blockId);
						if (ctx.textId) legit.add(ctx.textId);
						return legit;
					})(),
					insertOwners: ctx.insertOwners
				};
		const fates = ops.classifyTagAtoms(peers[0], ctx.blockId, ctx.atoms, oracleCtx);
		const has = (k: string) => fates.some((f) => f.kind === k);
		// Worst-first verdict. An atom reported hard (`uncovered`, `gone`,
		// `unreachable`) on peer A is NOT automatically lost: a deleteSet
		// applies on receipt while each struct waits on its deps — under a
		// lossy schedule the covering record can be stranded in
		// `pendingStructs` on some replicas and integrated on others.
		// Cross-replica check: a soft fate on ANY peer proves the write
		// exists → pending-destroyed → convergent-loss. An atom hard on
		// EVERY replica is a real defect — UNLESS the atom's own id or one
		// of its coverage deps is among the ids an observed reload actually
		// destroyed or left stranded (F4: correlated, not run-global).
		const HARD = new Set(['uncovered', 'gone', 'unreachable']);
		let verdict: string;
		const hardIdx = fates.map((f, i) => (HARD.has(f.kind) ? i : -1)).filter((i) => i >= 0);
		if (hardIdx.length > 0) {
			const altFates = peers
				.slice(1)
				.map((p) => ops.classifyTagAtoms!(p, ctx.blockId, ctx.atoms, oracleCtx));
			const stillHard = hardIdx.filter((i) => altFates.every((ff) => HARD.has(ff[i].kind)));
			if (stillHard.length === 0) {
				verdict = 'convergent-loss';
			} else {
				// Coverage deps per atom across all replicas (the records
				// whose destruction would produce exactly this fate).
				const depSets = ops.tagAtomDeps
					? peers.map((p) => ops.tagAtomDeps!(p, ctx.textId ?? ctx.blockId, ctx.atoms!))
					: undefined;
				const explained = stillHard.map(
					(i) => depGone(ctx.atoms![i]) || (depSets?.some((ds) => ds[i]?.some(depGone)) ?? false)
				);
				if (explained.every(Boolean)) {
					verdict = 'convergent-loss';
				} else {
					const bad = stillHard.filter((_, j) => !explained[j]);
					verdict = bad.some((i) => fates[i].kind === 'unreachable')
						? 'unreachable-block'
						: 'lost-edit';
				}
			}
		} else if (
			ctx.atoms!.some(
				(a, i) =>
					fates[i].kind === 'tombstoned' &&
					!recordedTombstones.has(`${a.c}:${a.k}`) &&
					!(ctx.textId !== undefined && goneBlocks.has(ctx.textId))
			)
		) {
			// R6: a tombstoned atom is legit only when a recorded delete op
			// covered it — a kill no scheduled op authorized is loss, not
			// deletion (`recordedTombstones` is consumed here, not just kept).
			// A second lawful path: the atom's home text's RECORD was
			// destroyed by an authorized op (e.g. undo reverting the split
			// that created it) — the atom's items die by parent-cascade on
			// integration, which surfaces as `tombstoned`, not `dead-owner`.
			verdict = 'lost-edit';
		} else if (
			fates.some(
				(f) => f.kind === 'dead-owner' && !(f.holders ?? []).every((h) => explainDead(h, 0))
			)
		) {
			// R6: dead-owner coverage is legit only when EVERY covering
			// holder's death is explained by a recorded del flag or an
			// authorized claim chain — unexplained dead coverage is loss.
			verdict = 'lost-edit';
		} else if (ctx.atoms!.some((_, i) => atomMutated(ctx, fates[i], i))) {
			// R6: a surviving atom whose marks/payload carry a value no
			// authorized op wrote (nor its birth fingerprint) was silently
			// mutated under convergence.
			verdict = 'mutated-edit';
		} else if (has('stolen')) verdict = 'stolen-edit';
		else if (has('moved')) verdict = 'moved-edit';
		else if (has('present')) verdict = 'present';
		else verdict = 'deleted-legit';
		const detail = fates
			.map((f) =>
				f.kind === 'moved' || f.kind === 'unreachable' || f.kind === 'stolen'
					? `${f.kind}:${f.owner}`
					: f.kind
			)
			.join(',');
		tagVerdicts[tag] = `${verdict} [${detail}]`;
		if (verdict === 'lost-edit') {
			lostEdits.push(tag);
			violationKinds.add('lost-edit');
		} else if (verdict === 'unreachable-block' || verdict === 'stolen-edit') {
			violationKinds.add(verdict);
		} else if (verdict !== 'present') {
			violationKinds.add(verdict);
		}
	}

	// Lost identities among surviving seed-era blocks (compare on peer A).
	const seedIds = collectBlocks(projections[0]).map((b) => b.id);
	const after = snapshotIdentities(peers[0], ops);
	const diff = diffIdentities(identitiesBefore, after);
	const lostIdentities = diff.lost.filter((id) => seedIds.includes(id));
	if (lostIdentities.length > 0) violationKinds.add('lost-identity');

	// Partition every observed class into legit evidence vs hard violations.
	const split = partition(violationKinds);
	opts.inspectAfter?.(peers, projections);
	if (split.violations.length > 0) {
		return {
			ok: false,
			failure: `unclassified violation(s): ${split.violations.join(', ')}`,
			violations: split.violations,
			evidence: split.evidence,
			lostEdits,
			lostIdentities,
			tagVerdicts,
			intentViolations,
			opCounts,
			skippedOps,
			historyOps,
			stepCount: executed
		};
	}

	return {
		ok: true,
		violations: [],
		evidence: split.evidence,
		lostEdits,
		lostIdentities,
		tagVerdicts,
		intentViolations,
		opCounts,
		skippedOps,
		historyOps,
		stepCount: executed
	};
};

const collectBlocks = (doc: ProjectedDoc): ProjectedBlock[] => {
	const out: ProjectedBlock[] = [];
	const walk = (bs: ProjectedBlock[]) => {
		for (const b of bs) {
			out.push(b);
			walk(b.children);
		}
	};
	walk(doc.children);
	return out;
};
