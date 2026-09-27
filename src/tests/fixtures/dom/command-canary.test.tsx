/** @jsxImportSource ../../../jsx */
import { describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

import { Y } from '$lib/crdt/engine.js';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	assertCanonicalTree,
	canonicalTree,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection,
	type CanonicalBlock
} from '../../dom/test.utils.js';

/**
 * U11 canaries for the headless command lane. Each case mutates the real
 * document through a production operation so the result is genuinely
 * corrupted, then feeds that corrupted state through the SAME oracle the
 * golden programs use (`assertCanonicalTree`) and asserts it rejects the
 * state for the intended reason. A passing control run through the same
 * oracle guards against a tautological "rejects everything" check.
 */

const runCommand = (edytor: Edytor, inputType: string, data: string | null = null) =>
	runBeforeInputCommand(
		edytor,
		attemptOf(edytor, {
			inputType,
			data,
			dataTransfer: null,
			cancelable: true
		})
	);

const p = (text: string, extra: Partial<CanonicalBlock> = {}): CanonicalBlock => ({
	type: 'paragraph',
	...(text === '' ? {} : { content: [{ text }] }),
	...extra
});

const flat = (
	<root>
		<paragraph>aa</paragraph>
		<paragraph>bb</paragraph>
		<paragraph>cc</paragraph>
	</root>
);

const at = (e: Edytor, i: number) => e.root!.children[i]!.firstText;

const mountReplica = async (peer: Awaited<ReturnType<typeof renderDomEdytor>>) => {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer.edytor.doc));
	return renderDomEdytor(flat, { doc, autoSelectFixture: false });
};

describe('command-lane oracle sensitivity (U11)', () => {
	it('rejects one extra deleted character — corrupted state through the real oracle', async () => {
		const { edytor } = await renderDomEdytor(flat, { autoSelectFixture: false });
		await setNativeSelection(edytor, at(edytor, 0), 1, at(edytor, 1), 1);
		await runCommand(edytor, 'deleteContentBackward');
		await flushDomUpdates();

		const contract: CanonicalBlock[] = [p('ab'), p('cc')];
		// Control: the healthy result passes the shared oracle.
		assertCanonicalTree(edytor, contract);

		// Corrupt for real: one more production delete — 'ab' → 'b'.
		await setNativeSelection(edytor, at(edytor, 0), 1, at(edytor, 0), 1);
		await runCommand(edytor, 'deleteContentBackward');
		await flushDomUpdates();
		expect(() => assertCanonicalTree(edytor, contract)).toThrow();
	});

	it('rejects a lost mark on a surviving run', async () => {
		const marked = (
			<root>
				<paragraph>
					ab<bold>cd</bold>ef
				</paragraph>
			</root>
		);
		const { edytor } = await renderDomEdytor(marked, { autoSelectFixture: false });
		const t = edytor.root!.children[0]!.firstText;
		await setNativeSelection(edytor, t, 4, t, 4);
		await runCommand(edytor, 'deleteContentBackward');
		await flushDomUpdates();

		const contract: CanonicalBlock[] = [
			p('', {
				content: [{ text: 'ab' }, { text: 'c', marks: { bold: true } }, { text: 'ef' }]
			})
		];
		// Control: correct output passes.
		assertCanonicalTree(edytor, contract);

		// Corrupt for real: strip the bold mark off the surviving 'c' —
		// the live model keeps one Text ('abcef') with internal mark runs;
		// 'c' sits at offset 2 — via the production format path.
		const text = edytor.root!.children[0]!.firstText;
		expect(text.stringContent).toBe('abcef');
		text.formatAt(2, 1, { bold: null });
		await flushDomUpdates();
		expect(() => assertCanonicalTree(edytor, contract)).toThrow();
	});

	it('rejects a wrong-but-converged result — agreement between peers is not the oracle', async () => {
		const a = await renderDomEdytor(flat, { autoSelectFixture: false });
		const b = await mountReplica(a);

		const contract: CanonicalBlock[] = [p('ab'), p('cc')];
		// Both peers run the identical delete and converge on the contract.
		for (const peer of [a, b]) {
			await setNativeSelection(peer.edytor, at(peer.edytor, 0), 1, at(peer.edytor, 1), 1);
			await runCommand(peer.edytor, 'deleteContentBackward');
		}
		await flushDomUpdates();
		assertCanonicalTree(a.edytor, contract);
		assertCanonicalTree(b.edytor, contract);
		expect(canonicalTree(a.edytor, true)).toEqual(canonicalTree(b.edytor, true));

		// Now corrupt ONLY B (real delete) — the peers stay converged with
		// each other? No: B diverges, and the oracle rejects B's state even
		// though A's identical history proves nothing about it.
		await setNativeSelection(b.edytor, at(b.edytor, 0), 1, at(b.edytor, 0), 1);
		await runCommand(b.edytor, 'deleteContentBackward');
		await flushDomUpdates();
		expect(() => assertCanonicalTree(b.edytor, contract)).toThrow();
		expect(canonicalTree(a.edytor, true)).not.toEqual(canonicalTree(b.edytor, true));
	});

	it('rejects a stale caret bound to a dead wrapper after remote delete', async () => {
		const a = await renderDomEdytor(flat, { autoSelectFixture: false });
		const b = await mountReplica(a);
		await setNativeSelection(b.edytor, at(b.edytor, 1), 1, at(b.edytor, 1), 1);

		// A deletes the block B sits in.
		await setNativeSelection(a.edytor, at(a.edytor, 0), 2, at(a.edytor, 2), 0);
		await runCommand(a.edytor, 'deleteContentBackward');
		Y.applyUpdate(
			b.edytor.doc,
			Y.encodeStateAsUpdate(a.edytor.doc, Y.encodeStateVector(b.edytor.doc))
		);
		await flushDomUpdates();
		await tick();
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));

		// The recovery contract: B's caret lands on the sibling that slid
		// into the dead slot — 'cc'@0, collapsed, on a LIVE text.
		const s = b.edytor.selection.state;
		expect(s.startText?.stringContent).toBe('cc');
		expect(s.yStart).toBe(0);
		expect(s.isCollapsed).toBe(true);
		// And the caret must accept input — a dead-caret defect surfaced as
		// silently dropped typing.
		await runCommand(b.edytor, 'insertText', 'Q');
		await flushDomUpdates();
		assertCanonicalTree(b.edytor, [p('aa'), p('Qcc')]);
	});

	it('a recovered selection left as a range is not a legal seam landing', async () => {
		const a = await renderDomEdytor(flat, { autoSelectFixture: false });
		const b = await mountReplica(a);
		await setNativeSelection(b.edytor, at(b.edytor, 1), 1, at(b.edytor, 1), 1);
		await setNativeSelection(a.edytor, at(a.edytor, 0), 2, at(a.edytor, 2), 0);
		await runCommand(a.edytor, 'deleteContentBackward');
		Y.applyUpdate(
			b.edytor.doc,
			Y.encodeStateAsUpdate(a.edytor.doc, Y.encodeStateVector(b.edytor.doc))
		);
		await flushDomUpdates();
		await tick();
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(b.edytor.selection.state.isCollapsed).toBe(true);
	});
});
