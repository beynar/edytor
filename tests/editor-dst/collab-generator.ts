import type { JSONDoc } from '../../src/lib/utils/json.js';
import { int, mulberry32, pick, type Rng } from '../../src/tests/crdt/harness/rng.js';
import { shapeDocument, type DstAction, type DstSelectionSelector } from './generator.js';

export const COLLAB_SCHEMA_VERSION = 1;

/**
 * Network/delivery ops the runner executes BETWEEN edit steps. Every op is
 * written to tolerate replay under minimization — a `release` with an
 * empty queue, a `reconnect` on a connected peer, a `healBarrier` with
 * nothing in flight are all no-ops, so any subsequence of a schedule stays
 * runnable.
 *
 * - `hold`/`release` drive the opaque relay's room-wide queue — while
 *   held, frames from ANY member buffer (genuine N-way concurrency);
 *   release can permute and duplicate the held batch.
 * - `dropNext` spends a per-room drop budget on forwarded frames.
 * - `latency` sets per-room delivery delay (0 clears).
 * - `disconnect`/`reconnect`/`reload` act on ONE peer: provider-level
 *   disconnect is deterministic (no auto-reconnect races an offline
 *   edit); reload remounts the whole page — the fresh doc must heal via
 *   SyncStep1/2 re-handshake.
 * - `killRoom` destroys every socket in the room; provider backoff
 *   (`wsbackoff`) then re-connects — a server-side blip.
 * - `healBarrier` is an explicit full-convergence assert point: every
 *   CONNECTED peer must reach identical canonical state (block ids,
 *   structure, text, marks, attribution, lineage) and equal the
 *   runner's reference document built from captured updates.
 */
export type CollabNetOp =
	| { kind: 'hold' }
	| { kind: 'release'; permute: boolean; duplicates: number }
	| { kind: 'dropNext'; count: number }
	| { kind: 'latency'; ms: number }
	| { kind: 'disconnect'; peer: number }
	| { kind: 'reconnect'; peer: number }
	| { kind: 'reload'; peer: number }
	| { kind: 'killRoom' }
	| { kind: 'healBarrier' };

/**
 * Collab-only selector extensions. `peerCaretBlock` resolves on the
 * ACTING peer to the block currently containing ANOTHER peer's caret —
 * the runner reads that peer's live selection state, so episodes can pin
 * "peer B deletes the block peer A's caret sits inside". Single-doc
 * schedules never see it (the runner resolves it before `resolveSelection`
 * in `runner.ts` runs).
 */
export type CollabSelectionSelector =
	| DstSelectionSelector
	| { kind: 'peerCaretBlock'; peer: number };

export type CollabStep =
	| {
			kind: 'edit';
			peer: number;
			selection: CollabSelectionSelector;
			action: DstAction;
	  }
	| { kind: 'net'; op: CollabNetOp };

export type CollabSchedule = {
	schemaVersion: typeof COLLAB_SCHEMA_VERSION;
	seed: number;
	shape: string;
	peerCount: number;
	lineageDepth: number;
	document: JSONDoc;
	steps: CollabStep[];
};

const INSERT_SAMPLES = ['x', 'Z', ' ', '.', '!', 'ab'] as const;
const UNICODE_INSERT_SAMPLES = ['é', '🙂', 'é', '漢'] as const;
const MARKS = ['bold', 'italic', 'underline', 'code', 'strike'] as const;
const MOVE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'] as const;

/**
 * Edit actions, biased toward model-mutating ops. `type`/`insertText`
 * payloads carry a peer+step marker (`a7·x`) so the intent ledger can
 * prove a delivered edit's characters survived convergence even when a
 * concurrent edit interleaved the insertion point.
 */
const editActionFor = (rng: Rng, peer: number, step: number): DstAction => {
	const roll = int(rng, 0, 99);
	const marker = `${'abc'[peer]}${step}`;
	if (roll < 30) {
		return { kind: 'type', text: `${marker}·${pick(rng, INSERT_SAMPLES)}` };
	}
	if (roll < 42) {
		return {
			kind: 'insertText',
			text: `${marker}·${pick(rng, UNICODE_INSERT_SAMPLES)}`
		};
	}
	if (roll < 54) return { kind: 'backspace' };
	if (roll < 62) return { kind: 'delete' };
	if (roll < 72) return { kind: 'enter' };
	if (roll < 80) return { kind: 'format', mark: pick(rng, MARKS) };
	if (roll < 84) return { kind: 'softBreak' };
	if (roll < 88) {
		return { kind: 'wordDelete', direction: rng() < 0.5 ? 'backward' : 'forward' };
	}
	if (roll < 92) return { kind: 'tab' };
	if (roll < 95) return { kind: 'undo' };
	if (roll < 97) return { kind: 'redo' };
	return { kind: 'move', key: pick(rng, MOVE_KEYS), extend: false };
};

const selectionFor = (rng: Rng): DstSelectionSelector => {
	const roll = int(rng, 0, 99);
	if (roll < 55) {
		return {
			kind: 'text',
			mode: 'collapsed',
			startText: int(rng, 0, 0xffff_ffff),
			startOffset: int(rng, 0, 0xffff_ffff),
			endText: int(rng, 0, 0xffff_ffff),
			endOffset: int(rng, 0, 0xffff_ffff),
			reversed: false
		};
	}
	if (roll < 85) {
		return {
			kind: 'text',
			mode: 'within-text',
			startText: int(rng, 0, 0xffff_ffff),
			startOffset: int(rng, 0, 0xffff_ffff),
			endText: int(rng, 0, 0xffff_ffff),
			endOffset: int(rng, 0, 0xffff_ffff),
			reversed: false
		};
	}
	if (roll < 93) {
		return {
			kind: 'text',
			mode: 'cross-text',
			startText: int(rng, 0, 0xffff_ffff),
			startOffset: int(rng, 0, 0xffff_ffff),
			endText: int(rng, 0, 0xffff_ffff),
			endOffset: int(rng, 0, 0xffff_ffff),
			reversed: false
		};
	}
	if (roll < 97) return { kind: 'block', index: int(rng, 0, 0xffff_ffff), reversed: false };
	return { kind: 'document', reversed: false };
};

const net = (op: CollabNetOp): CollabStep => ({ kind: 'net', op });

const edit = (rng: Rng, peer: number, step: number): CollabStep => ({
	kind: 'edit',
	peer,
	selection: selectionFor(rng),
	action: editActionFor(rng, peer, step)
});

const otherPeer = (rng: Rng, peer: number, peerCount: number): number =>
	peerCount < 2 ? peer : (peer + 1 + int(rng, 0, peerCount - 2)) % peerCount;

/**
 * One network episode — a bounded window of deliberate delivery faults
 * ending in a heal barrier. Episodes are the unit of genuine concurrency:
 * inside `hold` every peer edits blind (the sequence interleaves forced
 * per-peer edits while frames buffer); inside `disconnect` one peer
 * forks while the rest keep syncing — both sides get a guaranteed edit
 * so partition coverage never depends on the rng landing there.
 */
const netEpisodeFor = (rng: Rng, peerCount: number, stepBase: number): CollabStep[] => {
	const roll = int(rng, 0, 99);
	const peer = int(rng, 0, peerCount - 1);
	const other = otherPeer(rng, peer, peerCount);
	/**
	 * Edits while delivery is held. The first two are pinned to DISTINCT
	 * peers (`peer`, then `other`) AND to `type` actions — a random action
	 * can no-op (backspace on an empty doc, a move, an undo with an empty
	 * stack), which would make "two peers edited" a lie. `type` always
	 * writes the unique peer+step marker, so each pinned edit provably
	 * authors an update — the runner independently asserts both own-client
	 * clocks advanced during the window. Remaining edits stay random.
	 */
	const editsWhileBlind = (count: number) =>
		Array.from({ length: count }, (_, index) => {
			const pinned = index === 0 ? peer : index === 1 ? other : int(rng, 0, peerCount - 1);
			if (index < 2) {
				return {
					kind: 'edit' as const,
					peer: pinned,
					// Collapsed text selection ONLY — a block/document/node
					// selection could resolve onto a void block where a keypress
					// is preventDefault'd, silently un-authoring the pinned edit.
					// A text caret + `type` cannot no-op: the marker is always
					// written, so the runner's own-clock assertion is guaranteed.
					selection: {
						kind: 'text' as const,
						mode: 'collapsed' as const,
						startText: int(rng, 0, 0xffff_ffff),
						startOffset: int(rng, 0, 0xffff_ffff),
						endText: 0,
						endOffset: 0,
						reversed: false
					},
					action: {
						kind: 'type' as const,
						text: `${'abc'[pinned]}${stepBase + index}·${pick(rng, INSERT_SAMPLES)}`
					}
				};
			}
			return edit(rng, pinned, stepBase + index);
		});
	if (roll < 22) {
		return [
			net({ kind: 'hold' }),
			...editsWhileBlind(int(rng, 2, peerCount + 1)),
			net({ kind: 'release', permute: false, duplicates: 1 }),
			net({ kind: 'healBarrier' })
		];
	}
	if (roll < 38) {
		return [
			net({ kind: 'hold' }),
			...editsWhileBlind(int(rng, 2, peerCount + 1)),
			net({ kind: 'release', permute: true, duplicates: int(rng, 2, 3) }),
			net({ kind: 'healBarrier' })
		];
	}
	if (roll < 52) {
		return [
			net({ kind: 'disconnect', peer }),
			edit(rng, peer, stepBase),
			edit(rng, other, stepBase + 1),
			net({ kind: 'reconnect', peer }),
			net({ kind: 'healBarrier' })
		];
	}
	if (roll < 62) {
		return [
			net({ kind: 'disconnect', peer }),
			edit(rng, peer, stepBase),
			edit(rng, other, stepBase + 1),
			net({ kind: 'reload', peer }),
			net({ kind: 'healBarrier' })
		];
	}
	if (roll < 74) {
		return [
			net({ kind: 'dropNext', count: int(rng, 1, 2) }),
			edit(rng, peer, stepBase),
			net({ kind: 'healBarrier' })
		];
	}
	if (roll < 86) {
		return [
			net({ kind: 'latency', ms: int(rng, 40, 150) }),
			edit(rng, peer, stepBase),
			edit(rng, other, stepBase + 1),
			net({ kind: 'latency', ms: 0 }),
			net({ kind: 'healBarrier' })
		];
	}
	if (roll < 94) {
		return [net({ kind: 'killRoom' }), edit(rng, peer, stepBase), net({ kind: 'healBarrier' })];
	}
	if (roll < 97) {
		// Remote-caret-under-delete: peer A plants a collapsed caret via a
		// guaranteed-authoring `type`; peer B block-selects the block that
		// caret sits inside and deletes it. The middle `healBarrier` forces
		// the delete to land on A before A types again — the follow-up
		// `preserve`+`type` then proves A's recovered caret is live and
		// usable, and the barrier's selection-sanity check bounds it.
		const marker = `${'abc'[peer]}${stepBase}`;
		return [
			{
				kind: 'edit',
				peer,
				selection: {
					kind: 'text',
					mode: 'collapsed',
					startText: int(rng, 0, 0xffff_ffff),
					startOffset: int(rng, 0, 0xffff_ffff),
					endText: 0,
					endOffset: 0,
					reversed: false
				},
				action: { kind: 'type', text: `${marker}·${pick(rng, INSERT_SAMPLES)}` }
			},
			{
				kind: 'edit',
				peer: other,
				selection: { kind: 'peerCaretBlock', peer },
				action: { kind: 'delete' }
			},
			net({ kind: 'healBarrier' }),
			{
				kind: 'edit',
				peer,
				selection: { kind: 'preserve' },
				action: { kind: 'type', text: `${marker}·r·${pick(rng, INSERT_SAMPLES)}` }
			},
			net({ kind: 'healBarrier' })
		];
	}
	return [net({ kind: 'healBarrier' })];
};

/**
 * Interleaved edit/net schedule. Roughly 3-in-4 steps are edits; every
 * ~8th step injects a network episode. To keep episode shapes intact
 * under minimization the runner treats all net ops as optional no-ops —
 * a schedule sliced anywhere still runs.
 *
 * The FIRST steps are always connected edits so every peer's provider is
 * proven synced before faults begin; the LAST step is always a
 * healBarrier so every schedule ends at a full-convergence assertion.
 */
export const generateCollabSchedule = (
	seed: number,
	stepCount: number,
	peerCount: number,
	lineageDepth = 5
): CollabSchedule => {
	const rng = mulberry32(seed * 0x9e3779b1 + peerCount * 0x85ebca6b + 1);
	const { shape, document } = shapeDocument(seed, rng);
	const steps: CollabStep[] = [];
	let step = 0;
	while (steps.length < stepCount) {
		// ~1-in-4 boundary injects a network episode (episodes count as
		// multiple steps toward the budget but stay atomic in the stream).
		if (step > 0 && step % 4 === 0 && int(rng, 0, 2) === 0) {
			steps.push(...netEpisodeFor(rng, peerCount, step));
			step++;
			continue;
		}
		steps.push(edit(rng, int(rng, 0, peerCount - 1), step));
		step++;
	}
	steps.push({ kind: 'net', op: { kind: 'healBarrier' } });
	return {
		schemaVersion: COLLAB_SCHEMA_VERSION,
		seed,
		shape,
		peerCount,
		lineageDepth,
		document,
		steps
	};
};
