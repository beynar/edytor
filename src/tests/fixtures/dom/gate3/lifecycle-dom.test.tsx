/** @jsxImportSource ../../../jsx */
/**
 * GATE-3 DOM probes — mounted-editor lifecycle and observer boundary.
 *
 *  1. `Edytor.attach`'s destroy drains `this.off` AND clears it (gate-3 F3):
 *     every `{#key editorDomRevision}` remount pushes a fresh cleanup batch
 *     onto the same array — pinned: the array always holds exactly one live
 *     batch, so dead closures and detached editor DOM trees never accrete.
 *  2. Unmount clears the published awareness selection (Edytor.destroy
 *     clears the view's own presence key) — the remote-caret cleanup contract.
 *  3. Observer boundary: unmanaged DOM nodes injected inside a managed
 *     text element get reconciled; managed-node removal is repaired.
 */
// @ts-nocheck -- probes touch private fields intentionally.
import { describe, expect, test } from 'vitest';
import { tick } from 'svelte';
import {
	renderDomEdytor,
	flushDomUpdates,
	setNativeSelection,
	textNodeOf
} from '../../../dom/test.utils.js';
import { Awareness } from '$lib/crdt/index.js';

describe('gate3 dom: this.off accumulation across remounts', () => {
	// R7 rewrite (L39): the whole-editor `{#key}` remount is gone; a render
	// re-creates text elements, never the host, so `attach` runs once per
	// mount and its batch never grows.
	test('re-created text elements leave the one off[] batch as it was', async () => {
		const { edytor, unmount } = await renderDomEdytor(
			<root>
				<paragraph>Hello</paragraph>
			</root>
		);
		const offList = (edytor as unknown as { off: (() => void)[] }).off;
		const initialLen = offList.length;
		expect(initialLen).toBeGreaterThan(0);

		for (let i = 0; i < 5; i++) {
			edytor.cells!.remount(edytor.root!.children[0]!.id);
			await tick();
			await flushDomUpdates();
			expect(offList.length).toBe(initialLen);
		}

		unmount();
	});
});

describe('gate3 dom: awareness cleanup on unmount', () => {
	test('unmount removes the published local selection from shared awareness', async () => {
		const awareness = new Awareness(new (await import('$lib/crdt/engine.js')).Y.Doc());
		awareness.setLocalState({ user: { name: 'me' } });
		const rendered = await renderDomEdytor(
			<root>
				<paragraph>Hello</paragraph>
			</root>,
			{ awareness }
		);
		const text = rendered.edytor.root!.children[0]!.firstText;
		await setNativeSelection(rendered.edytor, text, 2);

		expect(awareness.getLocalState()?.selections).toBeDefined();

		rendered.unmount();
		await flushDomUpdates();

		expect(awareness.getLocalState()?.selections).toBeUndefined();
		expect(awareness.getLocalState()?.user).toEqual({ name: 'me' }); // other fields kept
	});
});

describe('gate3 dom: mutation observer boundary', () => {
	// Gate-3 F1 (fixed): an unmanaged element injected inside a managed text
	// element is exempt from `removeAddedUnmanagedNodes` (editable island),
	// so reconcile adopts its text into the model ('HelloROGUE'). The settle
	// pass must then DROP the surplus element — unwrapping it post-adopt
	// materialized a second 'ROGUE' node ('HelloROGUEROGUE'). Pinned: the
	// post-flush invariant `node.textContent === text.stringContent`.
	test('unmanaged element injected inside a managed text element does not duplicate content', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>Hello</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText;
		const node = await textNodeOf(text);

		const rogue = document.createElement('span');
		rogue.textContent = 'ROGUE';
		node.appendChild(rogue);
		await flushDomUpdates();

		// Model adopted the injected text (browser-owned-input fallback —
		// acceptable). The DOM must match it exactly — no stranded node.
		expect(text.stringContent).toBe('HelloROGUE');
		expect(node.textContent).toBe('HelloROGUE');
	});

	// Regression: the same injection nested inside a managed mark element —
	// the wrapper's parent is the mark, not the text node, but the settle
	// pass must still drop it once the model owns the flattened text.
	test('unmanaged element injected inside a MARK inside a text element does not duplicate content', async () => {
		const { edytor } = await renderDomEdytor(
			<root>
				<paragraph>
					Hello <bold>world</bold>
				</paragraph>
			</root>
		);
		const text = edytor.root!.children[0]!.firstText;
		const node = await textNodeOf(text);
		const mark = node.querySelector('[data-edytor-mark]');
		expect(mark).not.toBeNull();

		const rogue = document.createElement('span');
		rogue.textContent = 'ROGUE';
		mark!.appendChild(rogue);
		await flushDomUpdates();

		// 'Hello ' + 'world' + adopted 'ROGUE' — rendered once, not twice.
		expect(text.stringContent).toBe('Hello worldROGUE');
		expect(node.textContent).toBe('Hello worldROGUE');
	});

	// R7 (answer (b), D-25): the block element holds the kind's own markup — a
	// sibling a foreign script adds there stays, and never reaches the model.
	test.fails(
		'unmanaged SIBLING node at block level stays and does not corrupt the model',
		async () => {
			const { edytor, editor } = await renderDomEdytor(
				<root>
					<paragraph>Hello</paragraph>
				</root>
			);
			const block = edytor.root!.children[0]!;
			const blockNode = block.node!;

			const rogue = document.createElement('div');
			rogue.setAttribute('data-rogue', '1');
			rogue.textContent = 'INJECTED';
			blockNode.appendChild(rogue);
			await flushDomUpdates();

			expect(rogue.isConnected).toBe(true);
			expect(block.value.content.map((p) => ('text' in p ? p.text : '')).join('')).toBe('Hello');
		}
	);
});
