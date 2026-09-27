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
 * U2 headless command bridge — the deletion-collaboration handoff requires
 * real production commands (not CRDT primitives, not a second editor) to run
 * against deterministic peers. Two `Edytor` instances mount the same encoded
 * seed document — a true replica, not a re-seeded twin — and updates travel
 * through `Y.encodeStateAsUpdate`/`Y.applyUpdate`, so merge, claim-release,
 * relative-anchor selection recovery, and mirror flush all execute for real.
 *
 * Semantic expectations are hand-authored from the deletion contract, never
 * copied from observed output: "head keeps prefix + swallows tail suffix",
 * "interior blocks die", "caret lands at the deletion seam".
 */

const seed = (
	<root>
		<paragraph>alpha</paragraph>
		<paragraph>beta</paragraph>
	</root>
);

const nestedSeed = (
	<root>
		<paragraph>alpha</paragraph>
		<ordered-list>
			<list-item>beta</list-item>
		</ordered-list>
		<paragraph>omega</paragraph>
	</root>
);

const nestedSeedWithTail = (
	<root>
		<paragraph>alpha</paragraph>
		<ordered-list>
			<list-item>beta</list-item>
		</ordered-list>
		<paragraph>omega</paragraph>
		<paragraph>tail</paragraph>
	</root>
);

type MountedPeer = Awaited<ReturnType<typeof renderDomEdytor>>;

/** Mount a second editor on a doc hydrated from the first peer's update stream. */
const mountReplicaPeer = async (
	peer: MountedPeer,
	fixture: Parameters<typeof renderDomEdytor>[0]
) => {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer.edytor.doc));
	return renderDomEdytor(fixture, { doc, autoSelectFixture: false });
};

/** Deliver every update `from` has that `to` is missing — the deterministic transport. */
const deliver = async (from: MountedPeer, to: MountedPeer) => {
	Y.applyUpdate(
		to.edytor.doc,
		Y.encodeStateAsUpdate(from.edytor.doc, Y.encodeStateVector(to.edytor.doc))
	);
	await flushDomUpdates();
	await tick();
};

/** Real command dispatch: the same `runBeforeInputCommand` the DOM pipeline calls. */
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

/** A paragraph literal — the canonical assertion compares the full
 * recursive tree (type, marks, inline parts, descendants), so anything
 * the shorthand omits would still fail if production produced it. */
const p = (text: string, extra: Partial<CanonicalBlock> = {}): CanonicalBlock => ({
	type: 'paragraph',
	...(text === '' ? {} : { content: [{ text }] }),
	...extra
});

const selectionInfo = (edytor: Edytor) => {
	const s = edytor.selection.state;
	return {
		text: s.startText?.stringContent,
		yStart: s.yStart,
		yEnd: s.yEnd,
		live: s.startText?._live === true
	};
};

describe('headless command simulation (U2)', () => {
	it('a remote insert inside B\u2019s caret text, before the caret, moves the caret', async () => {
		// Review reproduction: `alpha-bravo`, B caret at 7; A inserts 5
		// UTF-16 units at offset 2 — the caret's contract position is 12.
		// The browser collab lane observed B staying at the stale 7.
		const a = await renderDomEdytor(
			<root>
				<paragraph>alpha-bravo</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const b = await mountReplicaPeer(
			a,
			<root>
				<paragraph>alpha-bravo</paragraph>
			</root>
		);
		await setNativeSelection(b.edytor, b.edytor.root!.children[0]!.firstText, 7);
		await setNativeSelection(a.edytor, a.edytor.root!.children[0]!.firstText, 2);
		await runCommand(a.edytor, 'insertText', 'XXXXX');
		await flushDomUpdates();
		await deliver(a, b);
		await flushDomUpdates();
		await waitFor(() => {
			expect(selectionInfo(b.edytor).live).toBe(true);
		});
		expect(selectionInfo(b.edytor)).toEqual({
			text: 'alXXXXXpha-bravo',
			yStart: 12,
			yEnd: 12,
			live: true
		});
	});

	it('a remote mark-split inside B\u2019s caret text still re-anchors the caret', async () => {
		// Marks split a text part into new wrappers — the caret's stored
		// wrapper can be REPLACED underneath it. The contract position must
		// still be derived from the anchor, not the stale absolute offset.
		const a = await renderDomEdytor(
			<root>
				<paragraph>alpha-bravo</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const b = await mountReplicaPeer(
			a,
			<root>
				<paragraph>alpha-bravo</paragraph>
			</root>
		);
		await setNativeSelection(b.edytor, b.edytor.root!.children[0]!.firstText, 7);
		// A formats [0,4) as bold — splitting the text part before the caret.
		a.edytor.root!.children[0]!.firstText.formatAt(0, 4, { bold: {} });
		await flushDomUpdates();
		await deliver(a, b);
		await flushDomUpdates();
		await waitFor(() => {
			expect(selectionInfo(b.edytor).live).toBe(true);
		});
		// The caret's contract position is offset 7 inside the surviving
		// tail run ("-bravo" keeps its logical offsets), on a live text.
		expect(selectionInfo(b.edytor).yStart).toBe(7);
		expect(selectionInfo(b.edytor).live).toBe(true);
	});

	it('a remote insert racing B\u2019s own deferred caret writes still lands at the shifted offset', async () => {
		// Collab reproduction shape: B just ran its own backspace (caret
		// writes schedule deferred reasserts + post-delete recordings),
		// then A's remote insert lands inside B's caret text BEFORE B's
		// deferred callbacks flush. The stale callbacks must not rewrite
		// the anchor-resolved position.
		const a = await renderDomEdytor(
			<root>
				<paragraph>alpha-bravo</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const b = await mountReplicaPeer(
			a,
			<root>
				<paragraph>alpha-bravo</paragraph>
			</root>
		);
		await setNativeSelection(b.edytor, b.edytor.root!.children[0]!.firstText, 8);
		await runCommand(b.edytor, 'deleteContentBackward');
		// B's caret is now at 7 in 'alpha-bavo' (backspace at 8 removes the
		// 'r' at index 7). Deliver A's insert at offset 2 in the SAME
		// flush window — before B's [0,30] reasserts.
		await setNativeSelection(a.edytor, a.edytor.root!.children[0]!.firstText, 2);
		await runCommand(a.edytor, 'insertText', 'XXXXX');
		await deliver(a, b);
		await flushDomUpdates();
		await waitFor(() => {
			expect(selectionInfo(b.edytor).live).toBe(true);
		});
		expect(selectionInfo(b.edytor)).toEqual({
			text: 'alXXXXXpha-bavo',
			yStart: 12,
			yEnd: 12,
			live: true
		});
	});

	it('replicas hydrate from the shared seed — identical block identities', async () => {
		const a = await renderDomEdytor(seed, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, seed);

		// Full JSON equality: same ids, same structure — B is A's replica.
		expect(b.edytor.value).toEqual(a.edytor.value);
	});

	it('A merges beta backward while B holds a caret inside it — B rides the merge and types at the seam', async () => {
		const a = await renderDomEdytor(seed, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, seed);

		// B parks its caret inside 'beta' at offset 2 (between 'e' and 't').
		const betaB = b.edytor.root!.children[1]!.firstText;
		await setNativeSelection(b.edytor, betaB, 2, betaB, 2);
		expect(selectionInfo(b.edytor)).toEqual({ text: 'beta', yStart: 2, yEnd: 2, live: true });

		// A backspaces at beta's head — the real deleteBackward merge command.
		const betaA = a.edytor.root!.children[1]!.firstText;
		await setNativeSelection(a.edytor, betaA, 0, betaA, 0);
		await runCommand(a.edytor, 'deleteContentBackward');
		await flushDomUpdates();

		// Hand-authored contract: head 'alpha' swallows tail 'beta' wholesale.
		assertCanonicalTree(a.edytor, [p('alphabeta')]);

		await deliver(a, b);
		assertCanonicalTree(b.edytor, [p('alphabeta')]);

		// B's caret's atoms were claimed by the merge: beta@2 → alphabeta@(5+2).
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(selectionInfo(b.edytor)).toEqual({
			text: 'alphabeta',
			yStart: 7,
			yEnd: 7,
			live: true
		});

		// Real follow-up input at the recovered caret — 'alphabe' + 'X' + 'ta'.
		await runCommand(b.edytor, 'insertText', 'X');
		await flushDomUpdates();
		assertCanonicalTree(b.edytor, [p('alphabeXta')]);
		expect(selectionInfo(b.edytor).yStart).toBe(8);

		// The follow-up mutation reaches the collaborator.
		await deliver(b, a);
		assertCanonicalTree(a.edytor, [p('alphabeXta')]);
	});

	it('adjacent-block append keeps B’s split-start caret in its own block (F1)', async () => {
		// Review reproduction: alphaHello → split → alpha / Hello sharing
		// one backing; B's caret at Hello@0 carries the -2 seam anchor.
		// A's append into alpha inserts a FOREIGN atom exactly at the seam
		// gap — the caret must still resolve into Hello's stream.
		const fixture = (
			<root>
				<paragraph>alphaHello</paragraph>
			</root>
		);
		const a = await renderDomEdytor(fixture, { autoSelectFixture: false });
		const src = a.edytor.root!.children[0]!.firstText;
		await setNativeSelection(a.edytor, src, 5, src, 5);
		await runCommand(a.edytor, 'insertParagraph');
		await flushDomUpdates();
		assertCanonicalTree(a.edytor, [p('alpha'), p('Hello')]);

		const b = await mountReplicaPeer(a, fixture);

		const helloB = b.edytor.root!.children[1]!.firstText;
		await setNativeSelection(b.edytor, helloB, 0, helloB, 0);
		expect(selectionInfo(b.edytor)).toEqual({ text: 'Hello', yStart: 0, yEnd: 0, live: true });

		// A appends X to alpha — the seam gap's right-side atom is now
		// alpha-owned.
		const alphaA = a.edytor.root!.children[0]!.firstText;
		await setNativeSelection(a.edytor, alphaA, 5, alphaA, 5);
		await runCommand(a.edytor, 'insertText', 'X');
		await flushDomUpdates();
		assertCanonicalTree(a.edytor, [p('alphaX'), p('Hello')]);
		await deliver(a, b);
		assertCanonicalTree(b.edytor, [p('alphaX'), p('Hello')]);

		// B's caret stays at Hello@0 — not alphaX@5.
		expect(selectionInfo(b.edytor)).toEqual({ text: 'Hello', yStart: 0, yEnd: 0, live: true });

		// Typing produces alphaX / ZHello, not alphaZX / Hello.
		await runCommand(b.edytor, 'insertText', 'Z');
		await flushDomUpdates();
		assertCanonicalTree(b.edytor, [p('alphaX'), p('ZHello')]);
		await deliver(b, a);
		assertCanonicalTree(a.edytor, [p('alphaX'), p('ZHello')]);
	});

	it('remote whole-document deletion recovers B’s caret onto the mounting replacement (F2)', async () => {
		// A deletes EVERYTHING; normalization mints a fresh empty paragraph
		// on both sides. On B the paragraph's text wrapper exists in the
		// model before its DOM node mounts — the dead-endpoint recovery that
		// ran inside flushMirror found no mounted editable text and armed
		// the post-mount retry instead of leaving the caret on dead beta.
		const a = await renderDomEdytor(seed, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, seed);

		const betaB = b.edytor.root!.children[1]!.firstText;
		await setNativeSelection(b.edytor, betaB, 2, betaB, 2);
		expect(selectionInfo(b.edytor)).toEqual({ text: 'beta', yStart: 2, yEnd: 2, live: true });

		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			0,
			a.edytor.root!.children[1]!.firstText,
			4
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		await flushDomUpdates();
		assertCanonicalTree(a.edytor, [p('')]);

		await deliver(a, b);
		assertCanonicalTree(b.edytor, [p('')]);

		// The replacement paragraph is mounted AND the selection owns a
		// live endpoint on it — no 80ms grace period required.
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(selectionInfo(b.edytor)).toEqual({ text: '', yStart: 0, yEnd: 0, live: true });

		// Follow-up input reaches the replacement paragraph.
		await runCommand(b.edytor, 'insertText', 'Z');
		await flushDomUpdates();
		assertCanonicalTree(b.edytor, [p('Z')]);
		await deliver(b, a);
		assertCanonicalTree(a.edytor, [p('Z')]);
	});

	it('A deletes the block holding B’s caret — B recovers to the deletion seam', async () => {
		const a = await renderDomEdytor(seed, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, seed);

		// B's caret lives in the first block.
		const alphaB = b.edytor.root!.children[0]!.firstText;
		await setNativeSelection(b.edytor, alphaB, 2, alphaB, 2);

		// A range-deletes [alpha@0 → beta@1]: alpha dies, beta loses its head.
		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			0,
			a.edytor.root!.children[1]!.firstText,
			1
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		await flushDomUpdates();

		// Contract: head empty-prefix dies; tail keeps suffix 'eta'.
		assertCanonicalTree(a.edytor, [p('eta')]);

		await deliver(a, b);
		assertCanonicalTree(b.edytor, [p('eta')]);

		// B's caret block is dead → lands at the seam it occupied: the sibling
		// now at index 0, at its start.
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(selectionInfo(b.edytor)).toEqual({ text: 'eta', yStart: 0, yEnd: 0, live: true });

		await runCommand(b.edytor, 'insertText', 'Z');
		await flushDomUpdates();
		assertCanonicalTree(b.edytor, [p('Zeta')]);
		await deliver(b, a);
		assertCanonicalTree(a.edytor, [p('Zeta')]);
	});

	it('deleting a nested subtree holding B’s caret lands at the vacated slot’s seam — and typing works', async () => {
		const a = await renderDomEdytor(nestedSeed, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, nestedSeed);

		// B's caret sits inside the nested list-item.
		const betaB = b.edytor.root!.children[1]!.children[0]!.firstText;
		await setNativeSelection(b.edytor, betaB, 2, betaB, 2);

		// A deletes [alpha@0 → beta@4]: the entire list subtree + alpha die.
		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			0,
			a.edytor.root!.children[1]!.children[0]!.firstText,
			4
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		await flushDomUpdates();
		assertCanonicalTree(a.edytor, [p('omega')]);

		await deliver(a, b);
		assertCanonicalTree(b.edytor, [p('omega')]);

		// Contract (sel.seam.nested-subtree): the dead chain climbs to the
		// topmost dead child of the live root (the list, index 1); the next
		// surviving sibling in the PREVIOUS ordering is 'omega', so B lands
		// at its first text @0. Landing on the root's phantom content text
		// would silently swallow the next input.
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(selectionInfo(b.edytor)).toEqual({ text: 'omega', yStart: 0, yEnd: 0, live: true });

		// The recovered caret must accept real input — the defect this
		// regression pins produced a dead caret at root@0.
		await runCommand(b.edytor, 'insertText', 'Z');
		await flushDomUpdates();
		assertCanonicalTree(b.edytor, [p('Zomega')]);
		await deliver(b, a);
		assertCanonicalTree(a.edytor, [p('Zomega')]);
	});

	it('seam uses previous-ordering neighbors, not a stale index into the shortened array', async () => {
		const a = await renderDomEdytor(nestedSeedWithTail, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, nestedSeedWithTail);

		// B's caret sits inside the nested list-item.
		const betaB = b.edytor.root!.children[1]!.children[0]!.firstText;
		await setNativeSelection(b.edytor, betaB, 2, betaB, 2);

		// A deletes [alpha@0 → beta@4]: the list subtree + alpha die,
		// leaving [omega, tail].
		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			0,
			a.edytor.root!.children[1]!.children[0]!.firstText,
			4
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		await flushDomUpdates();
		assertCanonicalTree(a.edytor, [p('omega'), p('tail')]);

		await deliver(a, b);
		assertCanonicalTree(b.edytor, [p('omega'), p('tail')]);

		// The list vacated slot 1 — but applying index 1 to the SHORTENED
		// array [omega, tail] would land in 'tail', skipping 'omega'. The
		// seam is the next surviving sibling in the PREVIOUS ordering:
		// omega (old index 2) → first text @0.
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(selectionInfo(b.edytor)).toEqual({ text: 'omega', yStart: 0, yEnd: 0, live: true });

		await runCommand(b.edytor, 'insertText', 'Z');
		await flushDomUpdates();
		assertCanonicalTree(b.edytor, [p('Zomega'), p('tail')]);
		await deliver(b, a);
		assertCanonicalTree(a.edytor, [p('Zomega'), p('tail')]);
	});

	it('seam must land on an EDITABLE text — a list-container neighbor hides the caret in its unrendered text', async () => {
		const listNeighborSeed = (
			<root>
				<paragraph>alpha</paragraph>
				<ordered-list>
					<list-item>beta</list-item>
				</ordered-list>
				<ordered-list>
					<list-item>gamma</list-item>
				</ordered-list>
				<paragraph>tail</paragraph>
			</root>
		);
		const a = await renderDomEdytor(listNeighborSeed, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, listNeighborSeed);

		const betaB = b.edytor.root!.children[1]!.children[0]!.firstText;
		await setNativeSelection(b.edytor, betaB, 2, betaB, 2);

		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			0,
			a.edytor.root!.children[1]!.children[0]!.firstText,
			4
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		await flushDomUpdates();
		const remaining = [
			{
				type: 'ordered-list',
				children: [{ type: 'list-item', content: [{ text: 'gamma' }] }]
			},
			p('tail')
		];
		assertCanonicalTree(a.edytor, remaining);
		await deliver(a, b);
		assertCanonicalTree(b.edytor, remaining);

		// The forward surviving sibling is the list CONTAINER — its own
		// first text is an unrendered phantom (container content slot). The
		// seam's editable destination is its first editable leaf: gamma @0.
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(selectionInfo(b.edytor)).toEqual({ text: 'gamma', yStart: 0, yEnd: 0, live: true });

		// Proof the destination is editable — typing must produce visible
		// content inside gamma, not hidden container text.
		await runCommand(b.edytor, 'insertText', 'Z');
		await flushDomUpdates();
		const typed = [
			{
				type: 'ordered-list',
				children: [{ type: 'list-item', content: [{ text: 'Zgamma' }] }]
			},
			p('tail')
		];
		assertCanonicalTree(b.edytor, typed);
		await deliver(b, a);
		assertCanonicalTree(a.edytor, typed);
	});

	it('seam skips a non-editable forward neighbor — a divider keeps walking to the next editable text', async () => {
		const dividerSeed = (
			<root>
				<paragraph>alpha</paragraph>
				<ordered-list>
					<list-item>beta</list-item>
				</ordered-list>
				<divider />
				<paragraph>tail</paragraph>
			</root>
		);
		const a = await renderDomEdytor(dividerSeed, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, dividerSeed);

		const betaB = b.edytor.root!.children[1]!.children[0]!.firstText;
		await setNativeSelection(b.edytor, betaB, 2, betaB, 2);

		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			0,
			a.edytor.root!.children[1]!.children[0]!.firstText,
			4
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		await flushDomUpdates();
		const remaining = [{ type: 'divider' }, p('tail')];
		assertCanonicalTree(a.edytor, remaining);
		await deliver(a, b);
		assertCanonicalTree(b.edytor, remaining);

		// The forward neighbor is a void divider — no editable text. The
		// seam keeps walking forward to the next editable text: tail @0.
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(selectionInfo(b.edytor)).toEqual({ text: 'tail', yStart: 0, yEnd: 0, live: true });

		await runCommand(b.edytor, 'insertText', 'Z');
		await flushDomUpdates();
		assertCanonicalTree(b.edytor, [{ type: 'divider' }, p('Ztail')]);
	});

	it('seam descends past a non-editable FIRST child — list(divider, gamma) lands in gamma', async () => {
		const nestedDividerSeed = (
			<root>
				<paragraph>alpha</paragraph>
				<ordered-list>
					<list-item>beta</list-item>
				</ordered-list>
				<ordered-list>
					<divider />
					<list-item>gamma</list-item>
				</ordered-list>
				<paragraph>tail</paragraph>
			</root>
		);
		const a = await renderDomEdytor(nestedDividerSeed, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, nestedDividerSeed);

		const betaB = b.edytor.root!.children[1]!.children[0]!.firstText;
		await setNativeSelection(b.edytor, betaB, 2, betaB, 2);

		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			0,
			a.edytor.root!.children[1]!.children[0]!.firstText,
			4
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		await flushDomUpdates();
		const remaining = [
			{
				type: 'ordered-list',
				children: [{ type: 'divider' }, { type: 'list-item', content: [{ text: 'gamma' }] }]
			},
			p('tail')
		];
		assertCanonicalTree(a.edytor, remaining);
		await deliver(a, b);
		assertCanonicalTree(b.edytor, remaining);

		// The surviving forward sibling's first child is a divider —
		// `firstEditableText` must continue to gamma, not stop at the
		// noneditable child (or the container's own phantom slot).
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(selectionInfo(b.edytor)).toEqual({ text: 'gamma', yStart: 0, yEnd: 0, live: true });

		await runCommand(b.edytor, 'insertText', 'Z');
		await flushDomUpdates();
		assertCanonicalTree(b.edytor, [
			{
				type: 'ordered-list',
				children: [{ type: 'divider' }, { type: 'list-item', content: [{ text: 'Zgamma' }] }]
			},
			p('tail')
		]);
	});

	it('backward seam descends past a non-editable LAST child — list(alpha, divider) lands in alpha', async () => {
		const backwardSeed = (
			<root>
				<ordered-list>
					<list-item>alpha</list-item>
					<divider />
				</ordered-list>
				<ordered-list>
					<list-item>beta</list-item>
				</ordered-list>
			</root>
		);
		const a = await renderDomEdytor(backwardSeed, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, backwardSeed);

		const betaB = b.edytor.root!.children[1]!.children[0]!.firstText;
		await setNativeSelection(b.edytor, betaB, 2, betaB, 2);

		// A removes the whole list(beta) subtree — beta is the LAST block,
		// so the seam has no forward candidate and must walk backward into
		// list(alpha, divider), skipping its trailing void child.
		a.edytor.facade.deleteBlock(a.edytor.root!.children[1]!.id);
		await flushDomUpdates();
		const remaining = [
			{
				type: 'ordered-list',
				children: [{ type: 'list-item', content: [{ text: 'alpha' }] }, { type: 'divider' }]
			}
		];
		assertCanonicalTree(a.edytor, remaining);
		await deliver(a, b);
		assertCanonicalTree(b.edytor, remaining);

		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(selectionInfo(b.edytor)).toEqual({ text: 'alpha', yStart: 5, yEnd: 5, live: true });

		await runCommand(b.edytor, 'insertText', 'Z');
		await flushDomUpdates();
		await deliver(b, a);
		assertCanonicalTree(a.edytor, [
			{
				type: 'ordered-list',
				children: [{ type: 'list-item', content: [{ text: 'alphaZ' }] }, { type: 'divider' }]
			}
		]);
	});
});

describe('multi-user command programs (U8 headless)', () => {
	const three = (
		<root>
			<paragraph>aa</paragraph>
			<paragraph>bb</paragraph>
			<paragraph>cc</paragraph>
		</root>
	);

	it('held concurrent edits: B types inside a block A deletes — delete wins, caret lands at the seam', async () => {
		const a = await renderDomEdytor(three, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, three);

		// A deletes 'bb' via the interior range [aa@end → cc@0].
		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			2,
			a.edytor.root!.children[2]!.firstText,
			0
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		// B, unaware, types 'X' into 'bb' — a genuine authored concurrent edit.
		const bbB = b.edytor.root!.children[1]!.firstText;
		await setNativeSelection(b.edytor, bbB, 1, bbB, 1);
		await runCommand(b.edytor, 'insertText', 'X');
		assertCanonicalTree(b.edytor, [p('aa'), p('bXb'), p('cc')]);

		// Exchange both ways (held window then heal).
		await deliver(a, b);
		await deliver(b, a);
		await deliver(a, b);

		// Contract (delete-wins): the dead block takes concurrent unseen
		// inserts with it — B's 'X' does not survive. Both replicas agree on
		// the INDEPENDENTLY SPECIFIED result, not just on each other.
		assertCanonicalTree(a.edytor, [p('aa'), p('cc')]);
		assertCanonicalTree(b.edytor, [p('aa'), p('cc')]);

		// B's caret was inside the dead block → seam = the sibling that slid
		// into its slot ('cc'@0), and B can keep typing there.
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(selectionInfo(b.edytor)).toEqual({ text: 'cc', yStart: 0, yEnd: 0, live: true });
		await runCommand(b.edytor, 'insertText', 'Y');
		await flushDomUpdates();
		assertCanonicalTree(b.edytor, [p('aa'), p('Ycc')]);
		await deliver(b, a);
		assertCanonicalTree(a.edytor, [p('aa'), p('Ycc')]);
	});

	it('A undoes its delete after B edits a survivor — actor-local undo, remote edit kept', async () => {
		const a = await renderDomEdytor(three, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, three);

		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			2,
			a.edytor.root!.children[2]!.firstText,
			0
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		await deliver(a, b);
		assertCanonicalTree(b.edytor, [p('aa'), p('cc')]);

		// B edits the survivor.
		const ccB = b.edytor.root!.children[1]!.firstText;
		await setNativeSelection(b.edytor, ccB, 2, ccB, 2);
		await runCommand(b.edytor, 'insertText', '!');
		await deliver(b, a);
		assertCanonicalTree(a.edytor, [p('aa'), p('cc!')]);

		// A's undo restores exactly A's deleted block; B's remote edit stands.
		a.edytor.undoManager.undo();
		await flushDomUpdates();
		await tick();
		assertCanonicalTree(a.edytor, [p('aa'), p('bb'), p('cc!')]);
		await deliver(a, b);
		assertCanonicalTree(b.edytor, [p('aa'), p('bb'), p('cc!')]);
	});

	it('disjoint held deletes converge to the intersection of survivors', async () => {
		const a = await renderDomEdytor(three, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, three);

		// A deletes 'bb' (interior), B deletes 'cc' — both while partitioned.
		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			2,
			a.edytor.root!.children[2]!.firstText,
			0
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		await setNativeSelection(
			b.edytor,
			b.edytor.root!.children[1]!.firstText,
			2,
			b.edytor.root!.children[2]!.firstText,
			2
		);
		await runCommand(b.edytor, 'deleteContentBackward');
		assertCanonicalTree(a.edytor, [p('aa'), p('cc')]);
		assertCanonicalTree(b.edytor, [p('aa'), p('bb')]);

		// Heal: the converged document keeps only 'aa' — the intersection.
		await deliver(a, b);
		await deliver(b, a);
		await deliver(a, b);
		assertCanonicalTree(a.edytor, [p('aa')]);
		assertCanonicalTree(b.edytor, [p('aa')]);
	});

	it('late join: C mounts from the post-delete update stream and edits normally', async () => {
		const a = await renderDomEdytor(three, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, three);

		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			1,
			a.edytor.root!.children[2]!.firstText,
			1
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		await deliver(a, b);
		assertCanonicalTree(b.edytor, [p('ac')]);

		// C joins now: a fresh replica of A's current state — no fixture
		// reseed, no shared history replay beyond the update bytes.
		const c = await mountReplicaPeer(a, three);
		expect(c.edytor.value).toEqual(a.edytor.value);
		assertCanonicalTree(c.edytor, [p('ac')]);

		const acC = c.edytor.root!.children[0]!.firstText;
		await setNativeSelection(c.edytor, acC, 1, acC, 1);
		await runCommand(c.edytor, 'insertText', 'Z');
		await flushDomUpdates();
		assertCanonicalTree(c.edytor, [p('aZc')]);
		await deliver(c, a);
		await deliver(c, b);
		assertCanonicalTree(a.edytor, [p('aZc')]);
		assertCanonicalTree(b.edytor, [p('aZc')]);
	});

	it('three peers: A deletes the block B sits in while C holds a survivor caret', async () => {
		const a = await renderDomEdytor(three, { autoSelectFixture: false });
		const b = await mountReplicaPeer(a, three);
		const c = await mountReplicaPeer(a, three);

		// B's caret in 'bb'; C's caret in 'cc'.
		await setNativeSelection(
			b.edytor,
			b.edytor.root!.children[1]!.firstText,
			1,
			b.edytor.root!.children[1]!.firstText,
			1
		);
		await setNativeSelection(
			c.edytor,
			c.edytor.root!.children[2]!.firstText,
			1,
			c.edytor.root!.children[2]!.firstText,
			1
		);

		await setNativeSelection(
			a.edytor,
			a.edytor.root!.children[0]!.firstText,
			2,
			a.edytor.root!.children[2]!.firstText,
			0
		);
		await runCommand(a.edytor, 'deleteContentBackward');
		await deliver(a, b);
		await deliver(a, c);

		// B (affected): dead block → seam at 'cc'@0.
		await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
		expect(selectionInfo(b.edytor)).toEqual({ text: 'cc', yStart: 0, yEnd: 0, live: true });
		// C (unaffected): its caret rides untouched at 'cc'@1 — different users
		// correctly hold different selections.
		expect(selectionInfo(c.edytor)).toEqual({ text: 'cc', yStart: 1, yEnd: 1, live: true });

		// Both keep editing from their own recovered positions.
		await runCommand(b.edytor, 'insertText', 'B');
		await runCommand(c.edytor, 'insertText', 'C');
		await flushDomUpdates();
		await deliver(b, a);
		await deliver(c, a);
		await deliver(a, b);
		await deliver(a, c);
		// B typed at 0 → 'B'; C typed at 1 → 'BCcc' ordering depends on
		// delivery; semantic content must contain both authored chars.
		const finalA = (canonicalTree(a.edytor) ?? [])
			.map((block) =>
				(block.content ?? []).map((part) => ('text' in part ? part.text : '')).join('')
			)
			.join('|');
		expect(finalA).toContain('B');
		expect(finalA).toContain('C');
		expect(canonicalTree(b.edytor, true)).toEqual(canonicalTree(a.edytor, true));
		expect(canonicalTree(c.edytor, true)).toEqual(canonicalTree(a.edytor, true));
	});

	// The pinned three-peer program: B owns a selection, A deletes its
	// destination and C edits unrelated content WHILE B's delivery is
	// held, then the held updates release in different legal orders.
	// Whatever the order, unrelated content survives and B's caret lands
	// at the deletion seam — then B can keep typing there.
	describe.each([
		['A-then-C', ['a', 'c']],
		['C-then-A', ['c', 'a']]
	] as const)('release order %s', (_label, order) => {
		it('B’s caret reaches the seam and C’s unrelated edit survives', async () => {
			const a = await renderDomEdytor(three, { autoSelectFixture: false });
			const b = await mountReplicaPeer(a, three);
			const c = await mountReplicaPeer(a, three);

			// B's caret inside 'bb' — the block A is about to delete.
			await setNativeSelection(
				b.edytor,
				b.edytor.root!.children[1]!.firstText,
				1,
				b.edytor.root!.children[1]!.firstText,
				1
			);

			// Held window: A deletes 'bb' (interior range aa@end → cc@0);
			// C types into 'cc' — unrelated content B must not lose.
			await setNativeSelection(
				a.edytor,
				a.edytor.root!.children[0]!.firstText,
				2,
				a.edytor.root!.children[2]!.firstText,
				0
			);
			await runCommand(a.edytor, 'deleteContentBackward');
			await setNativeSelection(
				c.edytor,
				c.edytor.root!.children[2]!.firstText,
				2,
				c.edytor.root!.children[2]!.firstText,
				2
			);
			await runCommand(c.edytor, 'insertText', 'X');
			await flushDomUpdates();

			// Release in the parameterized order — B receives each update
			// stream while blind to the other writer.
			for (const who of order) {
				await deliver(who === 'a' ? a : c, b);
				await flushDomUpdates();
			}
			// B then sees the remaining converged state.
			await deliver(a, b);
			await deliver(c, b);
			await flushDomUpdates();

			// Unrelated content survives; B's dead block recovered to the
			// seam — the surviving forward sibling's start ('cc…'@0).
			assertCanonicalTree(b.edytor, [p('aa'), p('ccX')]);
			await waitFor(() => expect(b.edytor.selection.state.startText?._live).toBe(true));
			expect(selectionInfo(b.edytor)).toEqual({
				text: 'ccX',
				yStart: 0,
				yEnd: 0,
				live: true
			});

			// B continues at the recovered destination without a reset.
			await runCommand(b.edytor, 'insertText', 'Z');
			await flushDomUpdates();
			assertCanonicalTree(b.edytor, [p('aa'), p('ZccX')]);
		});
	});
});
