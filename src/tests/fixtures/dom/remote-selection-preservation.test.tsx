/** @jsxImportSource ../../../jsx */
import { describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/svelte';

import { Y } from '$lib/crdt/engine.js';
import { attachDocument } from '$lib/crdt/document.js';
import { flushDomUpdates, renderDomEdytor, setNativeSelection } from '../../dom/test.utils.js';
import type { Edytor } from '$lib/edytor.svelte.js';

const input = (
	<root>
		<paragraph>Hello world</paragraph>
	</root>
);

const twoBlocks = (
	<root>
		<paragraph>First</paragraph>
		<paragraph>Second</paragraph>
	</root>
);

/**
 * Simulate a remote peer: attach a headless EdytorDocument to a second
 * engine doc synced from the mounted editor's doc, write through its
 * facade, then applyUpdate the delta back — a genuine remote-origin
 * transaction on the mounted editor's side (`change.origin` differs from
 * the view's own transaction, so the remote-restore paths run).
 */
const createRemotePeer = async (edytor: Edytor) => {
	const localDoc = edytor.doc;
	const remoteDoc = new Y.Doc();
	Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc));
	const remote = attachDocument(remoteDoc);
	const push = async () => {
		const update = Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(localDoc));
		Y.applyUpdate(localDoc, update);
		await flushDomUpdates();
	};
	return { remote, remoteDoc, push };
};

describe('remote edits vs local selection', () => {
	it('collapsed caret rides a remote insert before it', async () => {
		const { edytor } = await renderDomEdytor(input, { autoSelectFixture: false });
		const text = edytor.root!.children[0]!.firstText;
		await setNativeSelection(edytor, text, 5);
		expect(edytor.selection.state.yStart).toBe(5);
		expect(edytor.selection.state.isCollapsed).toBe(true);

		const { remote, push } = await createRemotePeer(edytor);
		remote.facade.insertText(edytor.root!.children[0]!.id, 0, 'Say ');
		await push();

		await waitFor(() => expect(edytor.selection.state.yStart).toBe(9));
		expect(edytor.selection.state.isCollapsed).toBe(true);
		expect(window.getSelection()?.isCollapsed).toBe(true);
	});

	it('remote insert AT the caret lands after it (left affinity)', async () => {
		const { edytor } = await renderDomEdytor(input, { autoSelectFixture: false });
		const text = edytor.root!.children[0]!.firstText;
		await setNativeSelection(edytor, text, 5);

		const { remote, push } = await createRemotePeer(edytor);
		remote.facade.insertText(edytor.root!.children[0]!.id, 5, 'X');
		await push();

		// Collapsed carets bind 'left' — the remote 'X' lands after the caret.
		await waitFor(() => expect(edytor.selection.state.yStart).toBe(5));
		expect(
			edytor.value.children?.[0]?.content?.map((p) => ('text' in p ? p.text : '')).join('')
		).toBe('HelloX world');
	});

	it('non-collapsed local selection rides remote inserts on BOTH endpoints', async () => {
		const { edytor } = await renderDomEdytor(input, { autoSelectFixture: false });
		const text = edytor.root!.children[0]!.firstText;
		await setNativeSelection(edytor, text, 2, text, 8);
		expect(edytor.selection.state.isCollapsed).toBe(false);
		expect(edytor.selection.state.yStart).toBe(2);
		expect(edytor.selection.state.yEnd).toBe(8);

		const { remote, push } = await createRemotePeer(edytor);
		remote.facade.insertText(edytor.root!.children[0]!.id, 0, 'Say ');
		await push();

		// 'llo wor' stays selected — both anchors shifted +4. Before the
		// `endPosition` anchor existed the START rode but `yEnd` stayed
		// stale at 8.
		await waitFor(() => expect(edytor.selection.state.yEnd).toBe(12));
		expect(edytor.selection.state.isCollapsed).toBe(false);
		expect(edytor.selection.state.yStart).toBe(6);
	});

	it('a remote insert inside the END text shifts only the range end', async () => {
		const { edytor } = await renderDomEdytor(twoBlocks, { autoSelectFixture: false });
		const [start, end] = [edytor.root!.children[0]!.firstText, edytor.root!.children[1]!.firstText];
		await setNativeSelection(edytor, start, 2, end, 4);
		expect(edytor.selection.state.isCollapsed).toBe(false);

		const { remote, push } = await createRemotePeer(edytor);
		// Insert inside the end text BEFORE the end offset — only `yEnd` rides.
		remote.facade.insertText(edytor.root!.children[1]!.id, 0, 'New ');
		await push();

		await waitFor(() => expect(edytor.selection.state.yEnd).toBe(8));
		expect(edytor.selection.state.yStart).toBe(2);
		expect(edytor.selection.state.isCollapsed).toBe(false);
	});

	it('collapsed caret rides a remote delete covering its atom', async () => {
		const { edytor } = await renderDomEdytor(input, { autoSelectFixture: false });
		const text = edytor.root!.children[0]!.firstText;
		await setNativeSelection(edytor, text, 5);

		const { remote, push } = await createRemotePeer(edytor);
		// Delete the first 6 chars — the caret's bound atom is inside.
		remote.facade.deleteText(edytor.root!.children[0]!.id, 0, 6);
		await push();

		// Caret's atoms are gone → lands at the deletion seam (offset 0).
		await waitFor(() => expect(edytor.selection.state.yStart).toBe(0));
	});

	it('remote delete of the caret block lands at the deletion seam', async () => {
		const { edytor } = await renderDomEdytor(twoBlocks, { autoSelectFixture: false });
		const text = edytor.root!.children[1]!.firstText;
		await setNativeSelection(edytor, text, 3);

		const { remote, push } = await createRemotePeer(edytor);
		remote.facade.deleteBlock(edytor.root!.children[1]!.id);
		await push();
		await waitFor(() => expect(edytor.selection.state.startText?._live).toBe(true));

		// The dead wrapper is abandoned for the sibling seam: last block
		// deleted → caret at the previous sibling's end ('First'.length).
		expect(edytor.selection.state.startText?.parent?._live).toBe(true);
		expect(edytor.selection.state.yStart).toBe('First'.length);
	});

	it('remote delete of the FIRST block lands the caret at the next block start', async () => {
		const { edytor } = await renderDomEdytor(twoBlocks, { autoSelectFixture: false });
		const text = edytor.root!.children[0]!.firstText;
		await setNativeSelection(edytor, text, 3);

		const { remote, push } = await createRemotePeer(edytor);
		remote.facade.deleteBlock(edytor.root!.children[0]!.id);
		await push();
		await waitFor(() => expect(edytor.selection.state.startText?._live).toBe(true));

		// The block that slid into slot 0 is 'Second' — caret at its start.
		expect(edytor.selection.state.startText?.stringContent).toBe('Second');
		expect(edytor.selection.state.yStart).toBe(0);
	});

	it('caret survives a remote mark applied over it (segment split)', async () => {
		const { edytor } = await renderDomEdytor(input, { autoSelectFixture: false });
		const text = edytor.root!.children[0]!.firstText;
		await setNativeSelection(edytor, text, 5);

		const { remote, push } = await createRemotePeer(edytor);
		// Bold 'o w' (offsets 4..7) — the caret at 5 lands inside the marked run.
		remote.facade.setMark(edytor.root!.children[0]!.id, 4, 3, 'bold', true);
		await push();

		await waitFor(() => expect(edytor.selection.state.startText?._live).toBe(true));
		expect(edytor.selection.state.yStart).toBe(5);
	});

	it('caret follows atoms when a remote merge absorbs its block', async () => {
		const { edytor } = await renderDomEdytor(twoBlocks, { autoSelectFixture: false });
		const text = edytor.root!.children[1]!.firstText;
		await setNativeSelection(edytor, text, 3);

		const { remote, push } = await createRemotePeer(edytor);
		const [a, b] = [edytor.root!.children[0]!.id, edytor.root!.children[1]!.id];
		remote.facade.mergeBlocks(b, a);
		await push();

		await waitFor(() => expect(edytor.root!.children.length).toBe(1));
		// 'Second' merged into 'First' → caret's atoms claimed → offset 5+3=8.
		expect(edytor.selection.state.startText?._live).toBe(true);
		expect(edytor.selection.state.startText?.stringContent).toBe('FirstSecond');
		expect(edytor.selection.state.yStart).toBe(8);
	});
});
