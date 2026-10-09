/** @jsxImportSource ../../jsx */
/**
 * Contract `doc.empty.virtual` (2026-09-28): an emptied document shows a
 * virtual paragraph. When the document has no block (here: two peers
 * concurrently delete its last two blocks), every view shows one local empty
 * paragraph of the default type and places the caret in it; nothing is
 * written for it. The first edit in it (typing, paste, Enter, a block-kind
 * command) creates a real block in the edit's own transaction; a readonly
 * view shows it and cannot create it; a peer's caret in its own virtual
 * paragraph shows in this one. Expected values are the contract's.
 */
import { describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { Y } from '$lib/crdt/engine.js';
import { runBeforeInputCommand } from '$lib/events/beforeInputCommands.js';
import { attemptOf } from '$lib/session/attempt.js';
import { resolvePeerSelection } from '$lib/collaboration/awarenessSelection.js';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	assertCanonicalTree,
	dispatchClipboardPaste,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	type CanonicalBlock
} from '../../dom/test.utils.js';

type Peer = Awaited<ReturnType<typeof renderDomEdytor>>;

const seed = (
	<root>
		<paragraph>alpha</paragraph>
		<paragraph>beta</paragraph>
	</root>
);

const replicaOf = async (peer: Peer, options: Parameters<typeof renderDomEdytor>[1] = {}) => {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer.edytor.doc));
	return renderDomEdytor(seed, { doc, autoSelectFixture: false, ...options });
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

const run = async (edytor: Edytor, inputType: string, data: string | null = null) => {
	runBeforeInputCommand(
		edytor,
		attemptOf(edytor, { inputType, data, dataTransfer: null, cancelable: true })
	);
	await flushDomUpdates();
};

const p = (text: string, type = 'paragraph'): CanonicalBlock => ({
	type,
	...(text === '' ? {} : { content: [{ text }] })
});

/** Two peers on `alpha, beta`; A deletes alpha while B deletes beta; both exchange. */
const emptied = async (options: Parameters<typeof renderDomEdytor>[1] = {}) => {
	const a = await renderDomEdytor(seed, { autoSelectFixture: false, ...options });
	const b = await replicaOf(a, options);
	a.edytor.root!.children[0]!.removeBlock();
	b.edytor.root!.children[1]!.removeBlock();
	await flushDomUpdates();
	await deliver(a, b);
	await deliver(b, a);
	return { a, b };
};

/** The blocks the DOM renders, as `[id, text]` (the empty-text filler left out). */
const shown = (peer: Peer) =>
	Array.from(peer.editor.querySelectorAll<HTMLElement>('[data-edytor-block="true"]')).map(
		(node) => [node.dataset.edytorId, node.textContent?.replace(/\u200b/g, '').trim()]
	);

const registrySize = (peer: Peer) => [...peer.edytor.doc.get('blocks').attrKeys()].length;

const caret = (edytor: Edytor) => {
	const { startText, yStart, isCollapsed } = edytor.selection.state;
	return { block: startText?.parent.id, offset: yStart, collapsed: isCollapsed };
};

describe('doc.empty.virtual — an emptied document shows a virtual paragraph', () => {
	it('both peers show one empty paragraph with the caret in it; nothing is written for it', async () => {
		const { a, b } = await emptied({ placeholder: 'Write…' });
		const sizes = [registrySize(a), registrySize(b)];
		for (const peer of [a, b]) {
			expect(peer.edytor.value.children).toEqual([]);
			const [[vid, text], ...rest] = shown(peer);
			expect(rest).toEqual([]);
			expect(text).toBe('');
			expect(peer.edytor.document.facade.hasBlock(vid!)).toBe(false);
			expect(peer.edytor.root!.children.map((block) => block.id)).toEqual([vid]);
			expect(caret(peer.edytor)).toEqual({ block: vid, offset: 0, collapsed: true });
			const host = peer.editor.querySelector('[data-edytor-text="true"]');
			expect(host?.getAttribute('data-placeholder')).toBe('Write…');
		}
		// Each view's virtual paragraph is its own; neither was written anywhere.
		expect(shown(a)[0]![0]).not.toBe(shown(b)[0]![0]);
		await deliver(a, b);
		await deliver(b, a);
		expect([registrySize(a), registrySize(b)]).toEqual(sizes);
	});

	it('typing creates the block in the same update; the other peer shows it and loses its virtual one', async () => {
		const { a, b } = await emptied();
		const vid = shown(a)[0]![0]!;
		const updates: Uint8Array[] = [];
		a.edytor.doc.on('update', (u: Uint8Array) => updates.push(u));
		await run(a.edytor, 'insertText', 'x');
		expect(updates).toHaveLength(1);
		assertCanonicalTree(a.edytor, [{ ...p('x'), id: vid }]);
		expect(caret(a.edytor)).toEqual({ block: vid, offset: 1, collapsed: true });
		// The real block's text handle holds the element the virtual one showed
		// (the projector displays the caret through it).
		await flushDomUpdates();
		const element = a.editor.querySelector(`[data-edytor-id="${vid}"] [data-edytor-text]`);
		expect(a.edytor.idToBlock.get(vid)!.firstText!.node).toBe(element);
		await deliver(a, b);
		assertCanonicalTree(b.edytor, [{ ...p('x'), id: vid }]);
		expect(shown(b)).toEqual([[vid, 'x']]);
		expect(caret(b.edytor).block).toBe(vid);
	});

	it('both peers type into their own virtual paragraphs: both lines are kept, no empty duplicate', async () => {
		const { a, b } = await emptied();
		await run(a.edytor, 'insertText', 'A');
		await run(b.edytor, 'insertText', 'B');
		await deliver(a, b);
		await deliver(b, a);
		const texts = (peer: Peer) => peer.edytor.value.children!.map((block) => block.content?.[0]);
		expect(texts(a)).toEqual(texts(b));
		expect(
			texts(a)
				?.map((c) => (c as { text: string }).text)
				.sort()
		).toEqual(['A', 'B']);
	});

	it('Enter in it creates it and the next line; the caret goes to the next line', async () => {
		const { a } = await emptied();
		const vid = shown(a)[0]![0]!;
		await run(a.edytor, 'insertParagraph');
		assertCanonicalTree(a.edytor, [{ ...p(''), id: vid }, p('')]);
		expect(caret(a.edytor).block).toBe(a.edytor.root!.children[1]!.id);
	});

	it('a block-kind command creates it with that kind', async () => {
		const { a } = await emptied();
		const vid = shown(a)[0]![0]!;
		a.edytor.root!.children[0]!.setBlock({ value: { type: 'heading', data: { level: 2 } } });
		await flushDomUpdates();
		assertCanonicalTree(a.edytor, [{ type: 'heading', id: vid, data: { level: 2 } }]);
	});

	it('pasting lines creates them, the first one in its place', async () => {
		const { a } = await emptied();
		const vid = shown(a)[0]![0]!;
		await dispatchClipboardPaste(a.editor, { 'text/plain': 'one\ntwo' });
		assertCanonicalTree(a.edytor, [{ ...p('one'), id: vid }, p('two')]);
		expect(caret(a.edytor)).toEqual({
			block: a.edytor.root!.children[1]!.id,
			offset: 3,
			collapsed: true
		});
	});

	it('undoing the typing that created it shows a virtual paragraph again, with the caret', async () => {
		const { a } = await emptied();
		await run(a.edytor, 'insertText', 'x');
		await dispatchDomKeyDown(a.editor, { key: 'z', code: 'KeyZ', metaKey: true });
		await flushDomUpdates();
		expect(a.edytor.value.children).toEqual([]);
		const [[vid], ...rest] = shown(a);
		expect(rest).toEqual([]);
		expect(caret(a.edytor)).toEqual({ block: vid, offset: 0, collapsed: true });
	});

	it('a readonly view shows it and cannot create it', async () => {
		const { a, b } = await emptied();
		const reader = await replicaOf(a, { readonly: true });
		const [[vid, text]] = shown(reader);
		expect(text).toBe('');
		expect(reader.edytor.document.facade.hasBlock(vid!)).toBe(false);
		const before = registrySize(reader);
		await run(reader.edytor, 'insertText', 'x');
		expect(reader.edytor.value.children).toEqual([]);
		expect(registrySize(reader)).toBe(before);
		void b;
	});

	it('a peer’s caret in its own virtual paragraph shows in this one', async () => {
		const { a, b } = await emptied();
		const state = a.edytor.document.awareness.getLocalState();
		const peer = resolvePeerSelection(b.edytor, state);
		if (!peer || 'blocks' in peer) throw new Error('expected a caret');
		expect(peer.collapsed).toBe(true);
		expect(peer.start.text.parent.id).toBe(shown(b)[0]![0]);
		expect(peer.start.offset).toBe(0);
	});

	it('control: a fresh document still seeds its first paragraph (a real block)', async () => {
		const fresh = await renderDomEdytor(seed, {
			value: { children: [] },
			autoSelectFixture: false
		});
		const [first] = fresh.edytor.value.children ?? [];
		expect(first?.type).toBe('paragraph');
		expect(fresh.edytor.document.facade.hasBlock(first!.id!)).toBe(true);
	});
});
