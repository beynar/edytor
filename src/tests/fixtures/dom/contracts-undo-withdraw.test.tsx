/** @jsxImportSource ../../jsx */
/**
 * Contract `hist.undo.withdraw` (2026-09-28, "preserve content the user did
 * not remove") through mounted views: two editors on one replicated
 * document, real commands, the user's Undo key. Undoing a block's creation
 * removes only the undoer's contributions — the block (Enter at a line's end
 * creates one) stays while it holds another author's text, and that author's
 * caret stays with it; undoing a split (Enter inside a line) brings the
 * tail's text, another author's typing included, back into the source line,
 * and the caret rides its characters. Expected trees and carets are
 * hand-written from the contract.
 */
import { describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { Y } from '$lib/crdt/engine.js';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	assertCanonicalTree,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection,
	type CanonicalBlock
} from '../../dom/test.utils.js';

type Peer = Awaited<ReturnType<typeof renderDomEdytor>>;

const seed = (
	<root>
		<paragraph>alpha</paragraph>
		<paragraph>beta</paragraph>
	</root>
);

const replicaOf = async (peer: Peer) => {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer.edytor.doc));
	return renderDomEdytor(seed, { doc, autoSelectFixture: false });
};

const deliver = async (from: Peer, to: Peer) => {
	Y.applyUpdate(
		to.edytor.doc,
		Y.encodeStateAsUpdate(from.edytor.doc, Y.encodeStateVector(to.edytor.doc))
	);
	await flushDomUpdates();
	await tick();
};

const run = async (edytor: Edytor, inputType: string, data: string | null = null) => {
	runBeforeInputCommand(
		edytor,
		attemptOf(edytor, { inputType, data, dataTransfer: null, cancelable: true })
	);
	await flushDomUpdates();
};

const undo = (peer: Peer) =>
	dispatchDomKeyDown(peer.editor, { key: 'z', code: 'KeyZ', metaKey: true });

const p = (text: string): CanonicalBlock => ({
	type: 'paragraph',
	...(text === '' ? {} : { content: [{ text }] })
});

const caret = (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	return {
		block: startText?.parent.id,
		offset: yStart,
		collapsed: isCollapsed,
		live: startText?.isInDocument === true
	};
};

describe('hist.undo.withdraw — through two mounted views', () => {
	it('A adds a block, B types in it, A undoes: the block stays with B’s text and B’s caret', async () => {
		const a = await renderDomEdytor(seed, { autoSelectFixture: false });
		const b = await replicaOf(a);
		a.edytor.root!.children[0]!.insertBlockAfter({ block: { id: 'n', type: 'paragraph' } });
		await flushDomUpdates();
		await deliver(a, b);
		const n = b.edytor.idToBlock.get('n')!;
		await setNativeSelection(b.edytor, n.firstText!, 0);
		await run(b.edytor, 'insertText', 'hey');
		await deliver(b, a);
		await undo(a);
		await deliver(a, b);
		for (const peer of [a, b]) assertCanonicalTree(peer.edytor, [p('alpha'), p('hey'), p('beta')]);
		expect(caret(b.edytor)).toEqual({ block: 'n', offset: 3, collapsed: true, live: true });
	});

	it('control: nothing foreign in it, A’s undo removes the added block', async () => {
		const a = await renderDomEdytor(seed, { autoSelectFixture: false });
		const b = await replicaOf(a);
		a.edytor.root!.children[0]!.insertBlockAfter({ block: { id: 'n', type: 'paragraph' } });
		await flushDomUpdates();
		await deliver(a, b);
		await undo(a);
		await deliver(a, b);
		for (const peer of [a, b]) assertCanonicalTree(peer.edytor, [p('alpha'), p('beta')]);
	});

	it('A presses Enter at the end (a new block), B types in it, A undoes: the line stays with B’s text', async () => {
		const a = await renderDomEdytor(seed, { autoSelectFixture: false });
		const b = await replicaOf(a);
		await setNativeSelection(a.edytor, a.edytor.root!.children[0]!.firstText!, 5);
		await run(a.edytor, 'insertParagraph');
		await deliver(a, b);
		const line = b.edytor.root!.children[1]!;
		await setNativeSelection(b.edytor, line.firstText!, 0);
		await run(b.edytor, 'insertText', 'new');
		await deliver(b, a);
		await undo(a);
		await deliver(a, b);
		for (const peer of [a, b]) assertCanonicalTree(peer.edytor, [p('alpha'), p('new'), p('beta')]);
		expect(caret(b.edytor)).toEqual({ block: line.id, offset: 3, collapsed: true, live: true });
	});

	it('A splits a line (Enter inside), B types in the tail, A undoes: B’s text rides back into the line, the caret with it', async () => {
		const a = await renderDomEdytor(seed, { autoSelectFixture: false });
		const b = await replicaOf(a);
		await setNativeSelection(a.edytor, a.edytor.root!.children[0]!.firstText!, 2);
		await run(a.edytor, 'insertParagraph');
		await deliver(a, b);
		const tail = b.edytor.root!.children[1]!;
		await setNativeSelection(b.edytor, tail.firstText!, 0);
		await run(b.edytor, 'insertText', 'X');
		await deliver(b, a);
		for (const peer of [a, b]) assertCanonicalTree(peer.edytor, [p('al'), p('Xpha'), p('beta')]);
		await undo(a);
		await deliver(a, b);
		for (const peer of [a, b]) assertCanonicalTree(peer.edytor, [p('alXpha'), p('beta')]);
		expect(caret(b.edytor)).toEqual({
			block: b.edytor.root!.children[0]!.id,
			offset: 3,
			collapsed: true,
			live: true
		});
	});
});
