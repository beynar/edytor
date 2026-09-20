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
 * - `lost-edit` — a uniquely tagged text insert is absent from its target
 *   block's final text while the block survives. Expected under copy
 *   split/merge, which recreate suffix items and strand concurrent edits
 *   (pending TX01/TX03). Note: a later random delete can also erase the tag —
 *   the class is recorded as evidence, not a proof.
 * - `cycle` — a logical block id appears as its own ancestor. Under copy-move
 *   this is the pending-MV05 failure mode (concurrent A-under-B / B-under-A
 *   produces nested copies). Expected evidence under the copy adapter; a hard
 *   failure once an adapter preserves identity (`preservesIdentityOnMove`).
 * - `unrecoverable-loss` — the schedule actually destroyed data (a snapshot
 *   reload regressed a peer's state vector, or dropped pending state) AND
 *   some peer still holds pendingStructs/pendingDs after the heal+full-sync
 *   barrier — i.e. items whose dependencies were destroyed on every replica.
 *   Post-barrier pending state means the dep either exists nowhere or was
 *   shipped and stranded behind a destroyed dep of its own: both are
 *   correct CRDT behavior (convergent data loss). In a run with NO loss
 *   events, pending residue post-barrier is a sync defect → `divergence`
 *   stays a hard failure.
 * - `upstream-engine-crash` — an exception thrown from vendored-engine
 *   internal machinery (transaction cleanup / delete-set iteration / struct
 *   integration) while processing a *legal* update stream. Empirically these
 *   fire under schedules with lossy reloads: delete sets referencing items
 *   destroyed on the receiving replica crash `findIndexSS` /
 *   `iterateStructsByIdSet` instead of staying pending. Evidence for U07 —
 *   vendored rc.26 robustness gap, with persisted repro artifacts.
 * - `unreachable-block` — a live, not-legitimately-hidden registry block is
 *   absent from the projection (or vice versa: a projected block that
 *   should be hidden). Reported by `checkStructurallyValid` when the
 *   adapter exposes `expectedProjectedIds`; the silent-loss class the
 *   composed display-parent-cycle fix exists to eliminate. Never expected
 *   → hard failure on every adapter that provides the oracle.
 * - `crash` / `divergence` / `unknown` — never expected → hard failure.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import * as decoding from 'lib0-v14/decoding';
import { createPeerSet, type PeerSet, type Peer, type SeedUpdate } from '../harness/peer-set.js';
import type { CrdtOps, ProjectedBlock, ProjectedDoc } from '../harness/ops/crdt-ops.js';
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
	/** classified semantic-violation kinds found in the converged state */
	violations: string[];
	lostEdits: string[];
	lostIdentities: string[];
	stepCount: number;
};

/**
 * Violation classes that are expected evidence for a given adapter. Copy
 * semantics make the structural classes reachable; an identity-preserving
 * adapter (U03+) cannot produce them, so they become hard failures the moment
 * the real model is plugged in — nothing here weakens the future gate.
 * `lost-edit` stays expected on any adapter: a random later delete can
 * legitimately erase a tag — it is evidence, never a proof on its own.
 */
export const expectedViolations = (ops: CrdtOps): Set<string> => {
	const s = new Set<string>(['lost-edit', 'unrecoverable-loss', 'upstream-engine-crash']);
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
 * into `[client, clockStart]` dep entries.
 */
const pendingDsDeps = (pendingDs: Uint8Array): Array<[number, number]> => {
	const dec = new Y.UpdateDecoderV2(decoding.createDecoder(pendingDs));
	decoding.readVarUint(dec.restDecoder); // struct count (always 0)
	const idset = Y.readIdSet(dec);
	const deps: Array<[number, number]> = [];
	for (const [client, ranges] of idset.clients) {
		for (const r of ranges.getIds()) deps.push([client, r.clock]);
	}
	return deps;
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

/**
 * Run `schedule` on a fresh peer set. Throws nothing — failures are returned
 * as `ok:false` with a readable `failure` string.
 */
export const runSchedule = (schedule: Schedule, ops: CrdtOps, seed: SeedUpdate): RunResult => {
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
	// Evidence tracking
	const insertedTags = new Map<string, { peer: Peer; blockId: string }>();
	const deletedIds = new Set<string>();
	// True once any peer observably LOSES state — a snapshot reload that
	// regresses the doc's state vector, or a reload that drops pending
	// (unintegrated) items. `drop`/partitions are not loss: the originator
	// retains its copy and resyncs. Only observed loss licenses the
	// `unrecoverable-loss` classification at the barrier.
	let sawLoss = false;
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

	const runDocOp = (peer: Peer, op: DocOp, stepIdx: number) => {
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
				if (id !== undefined) ops.splitBlock(peer, id, op.offset, op.newId);
				break;
			}
			case 'merge': {
				const from = resolveId(peer, op.fromIndex);
				const into = resolveId(peer, op.intoIndex);
				if (from !== undefined && into !== undefined && from !== into)
					ops.mergeBlocks(peer, from, into);
				break;
			}
			case 'insertText': {
				const id = resolveId(peer, op.idIndex);
				if (id !== undefined && ops.insertText(peer, id, op.offset, op.text)) {
					insertedTags.set(op.tag, { peer, blockId: id });
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
		}
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
				p.reload(op.action === 'reloadSnap' ? 'snapshot' : 'log');
				const after = new Map(Y.decodeStateVector(p.stateVector()));
				// Loss = integrated state regressed (a client clock shrank or a
				// client vanished) or pending items were dropped by the reload.
				if (hadPending) sawLoss = true;
				else {
					for (const [client, clock] of before) {
						if ((after.get(client) ?? 0) < clock) {
							sawLoss = true;
							break;
						}
					}
				}
				break;
			}
		}
	};

	for (let i = 0; i < schedule.steps.length; i++) {
		const step: Step = schedule.steps[i];
		try {
			const peer = peers[step.peer % peers.length];
			if (step.op.kind === 'net') runNetOp(step.op);
			else runDocOp(peer, step.op, i);
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

	if (firstError) {
		// A throw inside vendored-engine cleanup/integration machinery on a
		// legal update stream is an upstream robustness finding — recorded as
		// evidence with the persisted repro — never an adapter pass. Throws
		// from the adapter's own ops (bad input, e.g. an unclamped retain)
		// stay hard failures.
		const kind = firstError.engineInternal ? 'upstream-engine-crash' : 'crash';
		return {
			ok: false,
			failure: `step ${firstError.step} threw: ${firstError.message}`,
			violations: [kind],
			lostEdits: [],
			lostIdentities: [],
			stepCount: executed
		};
	}

	// ── barrier: heal everything, flush, full sync ───────────────────────
	// Same crash classification as the step loop: engine-cleanup throws during
	// the flush are upstream findings, not adapter failures.
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
		return {
			ok: false,
			failure: `barrier threw: ${msg}`,
			violations: [kind],
			lostEdits: [],
			lostIdentities: [],
			stepCount: executed
		};
	}

	// Hard invariant: every replica's canonical projection is identical, and
	// decoded state vectors agree — UNLESS the divergence is explained by
	// pending state whose dependencies were destroyed on every replica
	// (unrecoverable-loss is correct CRDT semantics, recorded as evidence).
	const projections = peers.map((p) => ops.project(p));
	const violationKinds = new Set<string>();
	const divergenceFailure = (detail: string): RunResult | null => {
		if (hasDestroyedPendingDeps(peers, sawLoss)) {
			violationKinds.add('unrecoverable-loss');
			return null;
		}
		return {
			ok: false,
			failure: detail,
			violations: ['divergence'],
			lostEdits: [],
			lostIdentities: [],
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

	// Resurrected deletes: a logically deleted id visible in the final state.
	// Under OBSERVED loss (`sawLoss` — a snapshot reload regressed a state
	// vector or dropped pending items) a resurrection is convergent-loss
	// semantics: the delete update may be gone from every replica, which is
	// correct CRDT behavior, classified as unrecoverable-loss instead.
	const finalIds = new Set<string>();
	for (const b of collectBlocks(projections[0])) finalIds.add(b.id);
	for (const id of deletedIds) {
		if (finalIds.has(id)) {
			violationKinds.add(sawLoss ? 'unrecoverable-loss' : 'resurrected-delete');
		}
	}

	// Lost edits: a unique insert tag missing from a still-live target block.
	const lostEdits: string[] = [];
	for (const [tag, ctx] of insertedTags) {
		// Converged state: projections[0] speaks for every peer.
		const block = findProjected(projections[0], ctx.blockId);
		if (block === undefined) continue; // block deleted → payload died with it
		if (!flatText(block).includes(tag)) lostEdits.push(tag);
	}
	if (lostEdits.length > 0) violationKinds.add('lost-edit');

	// Lost identities among surviving seed-era blocks (compare on peer A).
	const seedIds = collectBlocks(projections[0]).map((b) => b.id);
	const after = snapshotIdentities(peers[0], ops);
	const diff = diffIdentities(identitiesBefore, after);
	const lostIdentities = diff.lost.filter((id) => seedIds.includes(id));
	if (lostIdentities.length > 0) violationKinds.add('lost-identity');

	const unknown = [...violationKinds].filter((k) => !expectedViolations(ops).has(k));
	if (unknown.length > 0) {
		return {
			ok: false,
			failure: `unclassified violation(s): ${unknown.join(', ')}`,
			violations: [...violationKinds],
			lostEdits,
			lostIdentities,
			stepCount: executed
		};
	}

	return {
		ok: true,
		violations: [...violationKinds].sort(),
		lostEdits,
		lostIdentities,
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
