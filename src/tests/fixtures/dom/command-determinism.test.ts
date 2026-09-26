// @ts-nocheck
/**
 * Deterministic command simulator — the integrated claim: REAL mounted
 * editors run REAL `runBeforeInputCommand` commands over ONE encoded seed
 * with deterministic clientIDs, rank randomness, block-id minting, actor
 * identities, virtual time (UndoManager windows), and explicit per-edge
 * delivery — and the trace + semantic signatures are the fingerprint.
 *
 * - In-process repeat: the fixed scenario produces identical traces and
 *   identical canonical signatures on a second run — no hidden entropy.
 * - Contract assertions: convergence, exact seam recovery, follow-up
 *   insert, two virtual-time undo windows, snapshot rebuild.
 * - Fresh process: two spawned `vitest run` executions of the probe
 *   produce identical fingerprints.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import '../../crdt/harness/vclock.js';
import { runCommandScenario } from './deterministic-command-scenario.js';
import type { CanonicalBlock } from '../../dom/test.utils.js';

/** The independently specified result — full canonical structure with the
 * seed's pinned block ids. 'bravo' is dead, 'alpha' kept its prefix plus
 * B's remote '!', 'charlie' swallowed B's seam-typed 'X', 'delta' carries
 * A's 'Q' insert and the surviving half of the undo pair. Marks/types/
 * descendants corruption cannot hide behind a flattened string. */
const EXPECTED_TREE: CanonicalBlock[] = [
	{ type: 'paragraph', id: 'cp-alpha', content: [{ text: 'al!' }] },
	{ type: 'paragraph', id: 'cp-charlie', content: [{ text: 'Xcharlie' }] },
	{ type: 'paragraph', id: 'cp-delta', content: [{ text: 'Qdelta1' }] }
];

const texts = (tree: { content?: { text?: string }[] }[]) =>
	tree.map((b) => (b.content ?? []).map((p) => p.text ?? '').join(''));

const runProbe = () => {
	const out = execFileSync(
		'pnpm',
		[
			'exec',
			'vitest',
			'run',
			// Same rationale as the crdt probe: console forwarding is
			// asynchronous and can drop lines; digests go through raw
			// process.stdout anyway, this only guards the channel.
			'--disableConsoleIntercept',
			'--config',
			'vitest.dom.config.ts',
			'src/tests/fixtures/dom/command-determinism-probe.test.ts'
		],
		{
			env: { ...process.env, CMD_TRACE_PROBE: '1' },
			encoding: 'utf8',
			timeout: 300_000
		}
	);
	const trace = out.match(/^TRACE:(.+)$/m)?.[1];
	const proj = out.match(/^PROJ:(.+)$/m)?.[1];
	if (!trace || !proj) {
		throw new Error(`probe output missing digests:\n${out}`);
	}
	return { trace, proj };
};

describe('deterministic command simulator', () => {
	it('the fixed scenario is byte-identical across in-process repeats', async () => {
		const r1 = await runCommandScenario();
		const r2 = await runCommandScenario();
		try {
			expect(r2.trace).toBe(r1.trace);
			expect(r2.signatures).toEqual(r1.signatures);
			expect(r2.selections).toEqual(r1.selections);
			expect(r2.afterUndo).toEqual(r1.afterUndo);
			expect(r1.trace.length).toBeGreaterThan(0);
		} finally {
			r1.unmountAll();
			r2.unmountAll();
		}
	});

	it('converges all peers and rebuilds the same signature from a snapshot', async () => {
		const r = await runCommandScenario();
		try {
			// A authored the deletes/inserts, B received remotely — identical
			// structure AND block identity means real convergence.
			expect(r.signatures.B).toEqual(r.signatures.A);
			// C mounted from B's persisted bytes through the real path.
			expect(r.signatures.C).toEqual(r.signatures.B);
			// The independent expected result: full canonical tree including
			// pinned block ids — convergence alone cannot satisfy it.
			expect(r.signatures.A.tree).toEqual(EXPECTED_TREE);
		} finally {
			r.unmountAll();
		}
	});

	it('recovers the dead-endpoint caret to the seam and accepts follow-up input', async () => {
		const r = await runCommandScenario();
		try {
			// 'bravo' died; the caret landed on the block that slid into
			// slot 1 ('charlie') at its start — live, not phantom root text.
			expect(r.selections.seamB).toEqual({
				text: 'charlie',
				yStart: 0,
				yEnd: 0,
				live: true
			});
			// The 'X' B typed there is in the converged document.
			expect(texts(r.signatures.A.tree)[1]).toBe('Xcharlie');
		} finally {
			r.unmountAll();
		}
	});

	it('virtual time splits UndoManager capture windows at the deadline', async () => {
		const r = await runCommandScenario();
		try {
			// '1' and '2' were typed >800 ms of virtual time apart — undo
			// reverted only '2', leaving 'Qdelta1' (not 'Qdelta').
			expect(texts(r.afterUndo)[2]).toBe('Qdelta1');
		} finally {
			r.unmountAll();
		}
	});

	it('produces identical fingerprints in fresh processes', { timeout: 700_000 }, () => {
		const p1 = runProbe();
		const p2 = runProbe();
		expect(p1).toEqual(p2);
	});
});
