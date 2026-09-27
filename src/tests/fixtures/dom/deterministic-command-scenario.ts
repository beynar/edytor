/**
 * The deterministic command scenario — ONE fixed program shared by the
 * in-process determinism spec and the fresh-process probe. It exercises
 * every class the handoff requires on REAL mounted editors:
 *
 * 1. remote delete kills the block holding B's caret → real
 *    dead-endpoint recovery to the sibling seam, then a real follow-up
 *    insert at that recovered position;
 * 2. partition → concurrent inserts → heal → converge;
 * 3. virtual-time undo windows (`vclock` drives `UndoManager`'s
 *    captureTimeout — two inserts split by >800 ms must undo separately);
 * 4. persist → rebuild a third editor from the snapshot bytes → same
 *    semantic signature.
 *
 * Every scheduler decision lands in `set.trace` (command intent,
 * enqueue/deliver content hashes, partition/heal/persist), so
 * `serializeTrace` is the execution fingerprint and the canonical
 * signatures are the semantic fingerprint.
 */
import { waitFor } from '@testing-library/svelte';

import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import type { JSONDoc } from '$lib/utils/json.js';
import { vclock } from '../../crdt/harness/vclock.js';
import { serializeTrace } from '../../crdt/harness/trace.js';
import { RenderedNode } from '../../jsx/types.js';
import {
	renderDomEdytor,
	setNativeSelection,
	flushDomUpdates,
	canonicalTree,
	blockIdMap,
	type CanonicalBlock
} from '../../dom/test.utils.js';
import {
	createCommandPeers,
	installDeterministicIds,
	installTimerAccounting,
	runCommand,
	at,
	type CommandPeer
} from './command-peer-set.js';

export const COMMAND_SEED: JSONDoc = {
	children: [
		{ type: 'paragraph', id: 'cp-alpha', content: [{ text: 'alpha' }] },
		{ type: 'paragraph', id: 'cp-bravo', content: [{ text: 'bravo' }] },
		{ type: 'paragraph', id: 'cp-charlie', content: [{ text: 'charlie' }] },
		{ type: 'paragraph', id: 'cp-delta', content: [{ text: 'delta' }] }
	]
};

export type PeerSignature = { tree: CanonicalBlock[]; ids: Record<string, string> };

export type CommandScenarioResult = {
	/** Canonical scheduler record — every decision + content hash. */
	trace: string;
	/** Semantic signatures per peer (structure + block identity). */
	signatures: Record<string, PeerSignature>;
	/** Selection evidence: where each named caret landed. */
	selections: Record<string, { text?: string; yStart?: number; yEnd?: number; live: boolean }>;
	/** Post-undo document state — proves two separate capture windows ran. */
	afterUndo: CanonicalBlock[];
};

export const signatureOf = (peer: CommandPeer): PeerSignature => ({
	tree: canonicalTree(peer.edytor, true),
	ids: Object.fromEntries(blockIdMap(peer.edytor))
});

const selectionOf = (peer: CommandPeer) => {
	const s = peer.edytor.selection.state;
	return {
		text: s.startText?.stringContent,
		yStart: s.yStart,
		yEnd: s.yEnd,
		live: s.startText?.isInDocument === true
	};
};

export const runCommandScenario = async (): Promise<
	CommandScenarioResult & { peers: CommandPeer[]; unmountAll: () => void }
> => {
	vclock.set(1_000);
	const restoreIds = installDeterministicIds(7);
	const timers = installTimerAccounting();
	const { set, peers } = await createCommandPeers(COMMAND_SEED, 2, {
		rngSeed: 7,
		undoCaptureTimeout: 800
	});
	set.clock = () => vclock.now;
	const [A, B] = peers;
	const unmounted: Array<() => void> = peers.map((p) => p.unmount);

	/** Drain editor timers to a PROVEN settlement queue and record it —
	 * a step may only be asserted complete once no in-horizon callback
	 * remains scheduled; out-of-horizon (suppression/blur) timers are
	 * counted in the trace, not silenced. */
	const quiesce = async () => {
		// The beyond-horizon count is intentionally NOT traced: whether a
		// long suppression timer happens to be registered at drain time is
		// wall-time dependent and would make identical programs diverge.
		// What IS deterministic evidence: zero in-horizon callbacks remain.
		await timers.quiesce();
		set.record({ kind: 'command', a: 'sched', d: `quiesce settled` });
	};

	/** Record the scheduled action's intent — the semantic half of the trace. */
	const cmd = (peer: CommandPeer, inputType: string, selection: string, data?: string) => {
		set.record({
			kind: 'command',
			a: peer.peer.name,
			d: `${inputType} ${selection}${data != null ? ` "${data}"` : ''}`
		});
		runCommand(peer.edytor, inputType, data ?? null);
	};

	try {
		// ── 1 · B parks its caret inside 'bravo'@2 — the interior block A kills.
		await setNativeSelection(B.edytor, at(B, 1), 2);

		// ── 2 · A deletes [alpha@2 → charlie@0]: 'bravo' dies, 'al' keeps
		// its prefix, 'charlie' is untouched at its boundary.
		await setNativeSelection(A.edytor, at(A, 0), 2, at(A, 2), 0);
		cmd(A, 'deleteContentBackward', '[p0@2,p2@0]');
		await flushDomUpdates();
		await quiesce();

		// ── 3 · Deliver A→B. B's caret sat in the killed block — dead-endpoint
		// repair must land it on the seam (the sibling that slid into slot 1).
		set.deliver('A', 'B');
		await flushDomUpdates();
		await quiesce();
		if (!B.edytor.selection.state.startText?.isInDocument) {
			throw new Error('B caret did not recover to live text');
		}
		// The recovered seam position — captured BEFORE the follow-up insert
		// so the record proves where the caret actually landed.
		const seamB = selectionOf(B);

		// ── 4 · B types at the recovered caret — the continuation input the
		// old root@0 fallback silently swallowed.
		cmd(B, 'insertText', 'seam', 'X');
		await flushDomUpdates();
		await quiesce();

		// ── 5 · Partition: concurrent inserts, then heal + converge.
		set.partition('A', 'B');
		await setNativeSelection(A.edytor, at(A, 2), 0);
		cmd(A, 'insertText', 'p2@0', 'Q');
		await setNativeSelection(B.edytor, at(B, 0), 2);
		cmd(B, 'insertText', 'p0@end', '!');
		await flushDomUpdates();
		set.heal('A', 'B');
		set.deliverAll();
		await flushDomUpdates();
		await quiesce();

		// ── 6 · Virtual-time undo windows on A: two inserts >800 ms apart must
		// be separate capture windows — undo reverts only the second.
		await setNativeSelection(A.edytor, at(A, 2), 'Qdelta'.length);
		vclock.advance(1_000);
		cmd(A, 'insertText', 'p2@end', '1');
		vclock.advance(2_000); // > captureTimeout → new window
		cmd(A, 'insertText', 'p2@end', '2');
		await flushDomUpdates();
		await quiesce();
		set.record({ kind: 'command', a: 'A', d: 'undo' });
		A.edytor.historyUndo();
		await flushDomUpdates();
		const afterUndo = canonicalTree(A.edytor, true);
		set.deliverAll();
		await flushDomUpdates();
		await quiesce();

		// ── 7 · B persists; a THIRD editor rebuilds from the snapshot bytes
		// through the real mount path — same signature or persistence lies.
		set.peer('B').persist();
		const docC = new Y.Doc();
		Y.applyUpdate(docC, set.peer('B').persisted!);
		const documentC = attachDocument(docC as never, {
			actor: { id: 'actor-C' },
			semantics: { defaultType: 'paragraph' }
		});
		const renderedC = await renderDomEdytor(new RenderedNode(COMMAND_SEED), {
			document: documentC,
			autoSelectFixture: false
		});
		unmounted.push(renderedC.unmount);
		const signatureC: PeerSignature = {
			tree: canonicalTree(renderedC.edytor, true),
			ids: Object.fromEntries(blockIdMap(renderedC.edytor))
		};

		return {
			trace: serializeTrace(set.trace),
			signatures: { A: signatureOf(A), B: signatureOf(B), C: signatureC },
			selections: { seamB },
			afterUndo,
			peers,
			unmountAll: () => unmounted.forEach((u) => u())
		};
	} catch (err) {
		for (const u of unmounted) u();
		restoreIds();
		timers.restore();
		throw err;
	} finally {
		restoreIds();
		timers.restore();
	}
};
