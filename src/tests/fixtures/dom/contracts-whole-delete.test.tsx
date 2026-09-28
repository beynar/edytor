/** @jsxImportSource ../../jsx */
/**
 * `del.range.whole-doc` (2026-09-28 follow-up) through the real command
 * dispatch on mounted editors: a text range over the whole document,
 * deleted by Backspace, Delete or a cut, keeps its head block — id, type and
 * data — emptied, with the caret in it; no block is written. Two peers doing
 * it concurrently converge to that one block. One undo step restores
 * everything. Expected values are the contract's, hand-written.
 */
import { describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { Y } from '$lib/crdt/engine.js';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	assertCanonicalTree,
	canonicalTree,
	dispatchCut,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection,
	type CanonicalBlock
} from '../../dom/test.utils.js';

type Peer = Awaited<ReturnType<typeof renderDomEdytor>>;

const seed = (
	<root>
		<heading level="h2">
			ti<mention></mention>tle
		</heading>
		<paragraph>body</paragraph>
		<ordered-list>
			<list-item>one</list-item>
		</ordered-list>
	</root>
);

const flat = (
	<root>
		<paragraph>alpha</paragraph>
		<paragraph>beta</paragraph>
		<paragraph>gamma</paragraph>
	</root>
);

const run = async (edytor: Edytor, inputType: string, data: string | null = null) => {
	runBeforeInputCommand(
		edytor,
		attemptOf(edytor, { inputType, data, dataTransfer: null, cancelable: true })
	);
	await flushDomUpdates();
};

/** Select from the first text's start to the last text's end (reversed: from the end). */
const selectAllText = async (edytor: Edytor, reversed = false) => {
	const first = edytor.root!.firstEditableText!;
	const last = edytor.root!.lastEditableText!;
	await setNativeSelection(edytor, first, 0, last, last.stringContent.length, { reversed });
	expect(edytor.selection.state.isCollapsed).toBe(false);
};

const caret = (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	return { block: startText?.parent.id, offset: yStart, collapsed: isCollapsed };
};

const replicaOf = async (peer: Peer, fixture = flat) => {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer.edytor.doc));
	return renderDomEdytor(fixture, { doc, autoSelectFixture: false });
};

const deliver = async (from: Peer, to: Peer) => {
	Y.applyUpdate(
		to.edytor.doc,
		Y.encodeStateAsUpdate(from.edytor.doc, Y.encodeStateVector(to.edytor.doc))
	);
	await flushDomUpdates();
	await tick();
	await flushDomUpdates();
};

const undo = async (peer: Peer) => {
	await dispatchDomKeyDown(peer.editor, { key: 'z', code: 'KeyZ', metaKey: true });
	await flushDomUpdates();
};

const p = (text: string, id?: string): CanonicalBlock => ({
	type: 'paragraph',
	...(id ? { id } : {}),
	...(text === '' ? {} : { content: [{ text }] })
});

describe('del.range.whole-doc — the head is kept, emptied', () => {
	for (const [label, inputType, reversed] of [
		['Backspace', 'deleteContentBackward', false],
		['Delete', 'deleteContentForward', false],
		['Backspace over a reversed selection', 'deleteContentBackward', true]
	] as const) {
		it(`${label}: the heading stays a heading with its id and data; its atom and the other blocks go`, async () => {
			const peer = await renderDomEdytor(seed, { autoSelectFixture: false });
			const { edytor } = peer;
			const before = canonicalTree(edytor, true);
			const head = edytor.root!.children[0]!;
			await selectAllText(edytor, reversed);
			await run(edytor, inputType);
			assertCanonicalTree(edytor, [{ type: 'heading', id: head.id, data: { level: 'h2' } }]);
			expect(caret(edytor)).toEqual({ block: head.id, offset: 0, collapsed: true });
			// Typing lands in the kept heading.
			await run(edytor, 'insertText', 'X');
			assertCanonicalTree(edytor, [
				{ type: 'heading', id: head.id, data: { level: 'h2' }, content: [{ text: 'X' }] }
			]);
			// One undo step for the typing, one for the delete: everything is back.
			await undo(peer);
			await undo(peer);
			expect(canonicalTree(edytor, true)).toEqual(before);
		});
	}

	it('one undo step restores the whole document', async () => {
		const peer = await renderDomEdytor(seed, { autoSelectFixture: false });
		const before = canonicalTree(peer.edytor, true);
		await selectAllText(peer.edytor);
		await run(peer.edytor, 'deleteContentBackward');
		expect(peer.edytor.value.children).toHaveLength(1);
		await undo(peer);
		expect(canonicalTree(peer.edytor, true)).toEqual(before);
	});

	it('a cut of the whole document keeps the head too', async () => {
		const { edytor, editor } = await renderDomEdytor(flat, { autoSelectFixture: false });
		const head = edytor.root!.children[0]!.id;
		await selectAllText(edytor);
		await dispatchCut(editor);
		await flushDomUpdates();
		assertCanonicalTree(edytor, [p('', head)]);
		expect(caret(edytor)).toEqual({ block: head, offset: 0, collapsed: true });
	});

	it('a nested head keeps its list: the first item stays, emptied', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<ordered-list>
					<list-item>one</list-item>
					<list-item>two</list-item>
				</ordered-list>
				<paragraph>after</paragraph>
			</root>,
			{ autoSelectFixture: false }
		);
		const list = edytor.root!.children[0]!;
		const item = list.children[0]!.id;
		await selectAllText(edytor);
		await run(edytor, 'deleteContentBackward');
		assertCanonicalTree(edytor, [
			{ type: 'ordered-list', id: list.id, children: [{ type: 'list-item', id: item }] }
		]);
		expect(caret(edytor)).toEqual({ block: item, offset: 0, collapsed: true });
	});

	it('two peers delete the whole document concurrently: one empty block, the head, carets in it', async () => {
		const a = await renderDomEdytor(flat, { autoSelectFixture: false });
		const b = await replicaOf(a);
		const head = a.edytor.root!.children[0]!.id;
		await selectAllText(a.edytor);
		await run(a.edytor, 'deleteContentBackward');
		await selectAllText(b.edytor, true);
		await run(b.edytor, 'deleteContentForward');
		await deliver(a, b);
		await deliver(b, a);
		for (const peer of [a, b]) {
			assertCanonicalTree(peer.edytor, [p('', head)]);
			expect(peer.edytor.value.children).toHaveLength(1);
			expect(caret(peer.edytor)).toEqual({ block: head, offset: 0, collapsed: true });
		}
		// Typing reaches the other peer in the same block.
		await run(a.edytor, 'insertText', 'Z');
		await deliver(a, b);
		for (const peer of [a, b]) assertCanonicalTree(peer.edytor, [p('Z', head)]);
	});

	it('both peers undo: the document comes back once, after the second undo', async () => {
		const a = await renderDomEdytor(flat, { autoSelectFixture: false });
		const b = await replicaOf(a);
		const before = canonicalTree(a.edytor, true);
		await selectAllText(a.edytor);
		await run(a.edytor, 'deleteContentBackward');
		await selectAllText(b.edytor);
		await run(b.edytor, 'deleteContentBackward');
		await deliver(a, b);
		await deliver(b, a);
		await undo(a);
		await deliver(a, b);
		for (const peer of [a, b]) expect(peer.edytor.value.children).toHaveLength(1);
		await undo(b);
		await deliver(b, a);
		for (const peer of [a, b]) expect(canonicalTree(peer.edytor, true)).toEqual(before);
	});
});
