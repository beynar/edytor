/**
 * Deterministic command-peer harness — the piece the handoff calls "the
 * deterministic command simulator": REAL mounted editors running REAL
 * `runBeforeInputCommand` commands, with every entropy source and every
 * transport decision under harness control.
 *
 * Controlled sources:
 * - `doc.clientID`      — PeerSet counter (`firstClientId + index`)
 * - rank minting        — `setDocRand(doc, set.randFor(index, gen))`
 * - block/text ids      — `installDeterministicIds` seeds
 *   `crypto.getRandomValues` (the `id()` mint in src/lib/utils.ts)
 * - actor identity      — `attachDocument(doc, {actor: {id}})`; no
 *   `crypto.randomUUID()` anonymous actors
 * - wall clock          — `vclock` mocks `lib0-v14/time` for UndoManager
 *   capture windows (import 'vclock.js' in the spec file)
 * - transport           — explicit per-edge queues on PeerSet: updates are
 *   enqueued by the doc listener, delivered only by `deliver`/`deliverAll`
 *   (partition/heal/drop/batch/reverse are scheduler decisions, traced)
 * - scheduler record    — `set.trace` records every decision; `traceDigest`
 *   is the run's fingerprint.
 *
 * - timers               — `installTimerAccounting` wraps `setTimeout`/
 *   `clearTimeout`: every scheduled editor callback is counted, and
 *   `quiesce` drains the queue until the count is provably zero — real
 *   "nothing pending remains" evidence, not a microtask flush that hopes
 *   later callbacks don't exist.
 *
 * Honest boundary: timer callbacks run on real jsdom timers in
 * registration order — deterministic for a fixed program (proven by the
 * fresh-process fingerprint) — but wall-time is not controlled, only
 * accounted. The claim covers update bytes, identities, delivery order,
 * timer quiescence, and final semantic state.
 */
import { vi } from 'vitest';

import { attachDocument, type EdytorDocument } from '$lib/crdt/document.js';
import { setDocRand } from '$lib/crdt/rand.js';
import { Y } from '$lib/crdt/engine.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import type { JSONDoc } from '$lib/utils/json.js';
import {
	SEED_DOC_CLIENT_ID,
	createPeerSet,
	type Peer,
	type PeerSet,
	type PeerSetOpts
} from '../../crdt/harness/peer-set.js';
import { mulberry32 } from '../../crdt/harness/rng.js';
import { RenderedNode } from '../../jsx/types.js';
import {
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection,
	type CanonicalBlock,
	canonicalTree
} from '../../dom/test.utils.js';

export { flushDomUpdates, setNativeSelection };

export type CommandPeer = {
	peer: Peer;
	edytor: Edytor;
	document: EdytorDocument;
	unmount: () => void;
};

/**
 * Seed `crypto.getRandomValues` — the entropy source behind the `id()`
 * mint used by every new block/text/inline wrapper. One shared stream
 * (keyed by rngSeed) keeps the interleaved draw order deterministic.
 */
export const installDeterministicIds = (rngSeed: number) => {
	const rng = mulberry32((rngSeed ^ 0x1d5eed) >>> 0);
	const spy = vi
		.spyOn(globalThis.crypto, 'getRandomValues')
		.mockImplementation(<T extends ArrayBufferView>(array: T): T => {
			const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
			for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rng() * 256);
			return array;
		});
	return () => spy.mockRestore();
};

/**
 * Build `n` mounted editors over `value`: one seed document (pinned
 * clientID + rand + deterministic actor) is serialized once inside
 * `createPeerSet`, every peer hydrates from those bytes, then a real
 * `Edytor` mounts on each peer's doc through `attachDocument` with a
 * deterministic actor.
 */
export const createCommandPeers = async (
	value: JSONDoc,
	n: number,
	opts: PeerSetOpts & { undoCaptureTimeout?: number } = {}
): Promise<{ set: PeerSet; peers: CommandPeer[] }> => {
	const seed = (seedDoc: InstanceType<typeof Y.Doc>) => {
		const document = attachDocument(seedDoc as never, {
			actor: { id: 'seed-actor' },
			semantics: { defaultType: 'paragraph' }
		});
		document.sync(value);
	};
	const set = createPeerSet(n, seed as never, opts);
	// Mount peers in declaration order — attach writes actor-dictionary
	// records, and that write order is part of the deterministic program.
	const peers: CommandPeer[] = [];
	for (const peer of set.peers) {
		const document = attachDocument(peer.doc as never, {
			actor: { id: `actor-${peer.name}` },
			semantics: { defaultType: 'paragraph' },
			...(opts.undoCaptureTimeout !== undefined
				? { history: { captureTimeout: opts.undoCaptureTimeout } }
				: {})
		});
		const rendered = await renderDomEdytor(new RenderedNode(value), {
			document,
			autoSelectFixture: false
		});
		peers.push({ peer, edytor: rendered.edytor, document, unmount: rendered.unmount });
	}
	return { set, peers };
};

/** Real command dispatch — the same `runBeforeInputCommand` the DOM pipeline calls. */
export const runCommand = (edytor: Edytor, inputType: string, data: string | null = null) =>
	runBeforeInputCommand(
		edytor,
		attemptOf(edytor, {
			inputType,
			data,
			dataTransfer: null,
			cancelable: true
		})
	);

/** The first text of the `i`th top-level block — selection shorthand. */
export const at = (peer: CommandPeer, i: number) => peer.edytor.root!.children[i]!.firstText;

/**
 * Account for every timer the mounted editors schedule. Each registered
 * `setTimeout` is tracked with its DELAY CLASS, not an absolute fire
 * time: a settlement callback is any callback scheduled with delay <=
 * horizon, wherever it lands on the wall clock. A fixed wall-clock
 * deadline lets a callback scheduled by another callback near the
 * deadline's edge slip past it and get reported as "settled" — classing
 * by delay closes that hole: a short callback's short re-schedule is
 * itself in-horizon and must drain before quiescence is claimed.
 * Timers beyond the horizon (multi-second persistence/policy windows)
 * are out-of-scope for a step's settlement but are NOT hidden: their
 * count is returned so the caller can record exactly what remained
 * scheduled rather than silently dropping it.
 */
export const SETTLEMENT_HORIZON_MS = 250;
export const installTimerAccounting = (horizonMs = SETTLEMENT_HORIZON_MS, maxRounds = 4_000) => {
	const realSet = globalThis.setTimeout;
	const realClear = globalThis.clearTimeout;
	const realRaf = globalThis.requestAnimationFrame?.bind(globalThis);
	const realCaf = globalThis.cancelAnimationFrame?.bind(globalThis);
	const pendingDelay = new Map<ReturnType<typeof setTimeout>, number>();
	const pendingRaf = new Set<number>();
	const setSpy = vi
		.spyOn(globalThis, 'setTimeout')
		.mockImplementation((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
			if (typeof callback !== 'function') return realSet.call(globalThis, callback, ms);
			const fn = callback as (...args: unknown[]) => void;
			const id = realSet.call(
				globalThis,
				() => {
					pendingDelay.delete(id);
					fn(...args);
				},
				ms
			);
			pendingDelay.set(id, ms ?? 0);
			return id;
		});
	const clearSpy = vi
		.spyOn(globalThis, 'clearTimeout')
		.mockImplementation((id?: ReturnType<typeof setTimeout>) => {
			if (id !== undefined) pendingDelay.delete(id);
			return realClear.call(globalThis, id);
		});
	// rAF is a separate queue from setTimeout — a callback waiting on a
	// frame (~16ms, settlement-class by construction) would otherwise
	// escape accounting entirely. When the environment provides it,
	// track it the same way; every pending frame is in-horizon.
	const rafSpy =
		realRaf === undefined
			? null
			: vi
					.spyOn(globalThis, 'requestAnimationFrame')
					.mockImplementation((callback: FrameRequestCallback) => {
						const id = realRaf((timestamp) => {
							pendingRaf.delete(id);
							callback(timestamp);
						});
						pendingRaf.add(id);
						return id;
					});
	const cafSpy =
		realCaf === undefined
			? null
			: vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id?: number) => {
					if (id !== undefined) pendingRaf.delete(id);
					return realCaf(id as number);
				});
	const inHorizonDelays = () => [...pendingDelay.values()].filter((d) => d <= horizonMs);
	// Count of callbacks that must fire before settlement is truthfully
	// claimed — timers classed in-horizon plus every pending frame.
	const outstanding = () => inHorizonDelays().length + pendingRaf.size;
	return {
		pending: () => pendingDelay.size + pendingRaf.size,
		inHorizon: outstanding,
		/**
		 * Drain until NO settlement-class callback remains — including
		 * callbacks scheduled by callbacks AND callbacks scheduled
		 * through arbitrary finite microtask chains. Every inspection is
		 * preceded by a REAL task boundary: `µt → µt → setTimeout(cb, 10)`
		 * registers its timer only after the whole microtask chain drains,
		 * which a promise checkpoint cannot wait for — its own
		 * continuation is queued before the chain's tail. Throws past the
		 * bound (honest non-quiescence). Returns the still-pending
		 * out-of-horizon count — evidence the caller must record, not
		 * discard.
		 */
		quiesce: async (): Promise<number> => {
			for (let i = 0; ; i++) {
				// Cross a REAL task boundary before every inspection: a
				// macrotask runs only after the microtask queue is fully
				// drained, including finite chains queued inside microtasks
				// (`µt → µt → setTimeout`). A bare `await Promise.resolve()`
				// is NOT a boundary — its continuation is itself a microtask
				// queued AHEAD of work chained off still-pending microtasks,
				// so it inspects the map before the chain's timer registers.
				// The boundary timer bypasses the accounting spy (`realSet`)
				// so quiesce's own wait is never counted as pending work.
				await new Promise((resolve) => realSet.call(globalThis, resolve, 0));
				const remaining = outstanding();
				if (remaining === 0) {
					return pendingDelay.size;
				}
				if (i >= maxRounds) {
					throw new Error(
						`quiescence not reached — ${remaining} settlement-class callbacks ` +
							`(${inHorizonDelays().length} timers, ${pendingRaf.size} frames) ` +
							`still pending after the drain bound`
					);
				}
				// Wait just past the earliest due in-horizon callback; a
				// pending frame waits one frame interval. New in-horizon
				// arrivals — including timers registered by microtasks the
				// just-fired callbacks queued — are picked up by the next
				// round's task boundary.
				const soonest = Math.min(...inHorizonDelays(), pendingRaf.size > 0 ? 17 : Infinity);
				await new Promise((resolve) =>
					realSet.call(globalThis, resolve, Number.isFinite(soonest) ? soonest + 1 : 18)
				);
			}
		},
		restore: () => {
			setSpy.mockRestore();
			clearSpy.mockRestore();
			rafSpy?.mockRestore();
			cafSpy?.mockRestore();
		}
	};
};

/** Canonical semantic signature of a peer — the deterministic result record. */
export const peerSignature = (peer: CommandPeer): CanonicalBlock[] =>
	canonicalTree(peer.edytor, true);
