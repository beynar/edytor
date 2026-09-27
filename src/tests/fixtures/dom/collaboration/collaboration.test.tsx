/** @jsxImportSource ../../../jsx */
import { describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/svelte';

import { flushDomUpdates, renderDomEdytor, setNativeSelection } from '../../../dom/test.utils.js';

const input = (
	<root>
		<paragraph>Hello world</paragraph>
	</root>
);

const remoteClientId = 4242;

const publishRemoteSelectionFromLocalSelection = async (
	edytor: Awaited<ReturnType<typeof renderDomEdytor>>['edytor'],
	user = { name: 'Ada', color: '#dc2626' }
) => {
	const selections = edytor.awareness.getLocalState()?.selections;
	if (!selections) {
		throw new Error('Expected local awareness selection before publishing remote state');
	}

	edytor.awareness.states.set(remoteClientId, { user, selections });
	edytor.awareness.emit('change', [{ added: [remoteClientId], updated: [], removed: [] }, 'test']);
	edytor.awareness.emit('update', [{ added: [remoteClientId], updated: [], removed: [] }, 'test']);
	await flushDomUpdates();
};

describe('collaboration remote presence rendering', () => {
	it('renders a remote cursor from awareness selection state', async () => {
		const { container, edytor } = await renderDomEdytor(input, {
			autoSelectFixture: false
		});
		const text = edytor.root!.children[0]!.firstText;

		await setNativeSelection(edytor, text, 5);
		await publishRemoteSelectionFromLocalSelection(edytor);

		await waitFor(() => {
			expect(container.querySelector('[data-edytor-remote-cursor]')).toBeInstanceOf(HTMLElement);
		});
		const cursor = container.querySelector('[data-edytor-remote-cursor]');
		expect(cursor?.getAttribute('data-client-id')).toBe(String(remoteClientId));
		expect(container.querySelector('[data-edytor-remote-cursor-label]')?.textContent).toBe('Ada');
	});

	it('renders and removes a remote expanded selection when awareness changes', async () => {
		const { container, edytor } = await renderDomEdytor(input, {
			autoSelectFixture: false
		});
		const text = edytor.root!.children[0]!.firstText;

		await setNativeSelection(edytor, text, 0, text, 5);
		await publishRemoteSelectionFromLocalSelection(edytor);

		await waitFor(() => {
			expect(container.querySelector('[data-edytor-remote-selection]')).toBeInstanceOf(HTMLElement);
		});

		edytor.awareness.states.delete(remoteClientId);
		edytor.awareness.emit('change', [
			{ added: [], updated: [], removed: [remoteClientId] },
			'test'
		]);
		edytor.awareness.emit('update', [
			{ added: [], updated: [], removed: [remoteClientId] },
			'test'
		]);
		await flushDomUpdates();

		await waitFor(() => {
			expect(container.querySelector('[data-edytor-remote-cursor]')).toBeNull();
			expect(container.querySelector('[data-edytor-remote-selection]')).toBeNull();
		});
	});

	it('publishes selection endpoints as JSON-safe backing-text anchors', async () => {
		const { edytor } = await renderDomEdytor(input, { autoSelectFixture: false });
		const text = edytor.root!.children[0]!.firstText;

		await setNativeSelection(edytor, text, 5);
		const selections = edytor.awareness.getLocalState()?.selections as Record<
			string,
			{
				start: { b: string; a: { i: { c: number; k: number } | null; a: number } };
				end: { b: string; a: { i: { c: number; k: number } | null; a: number } };
				collapsed: boolean;
				reversed: boolean;
			}
		>;
		const [selection] = Object.values(selections);

		// Wire shape: {b: backing-block-id, a: {i: {c,k}|null, a: assoc}}.
		expect(typeof selection.start.b).toBe('string');
		expect(typeof selection.start.a.a).toBe('number');
		expect(
			selection.start.a.i === null ||
				(typeof selection.start.a.i.c === 'number' && typeof selection.start.a.i.k === 'number')
		).toBe(true);
		expect(selection.start.b).toBe(selection.end.b);
		// Collapsed caret → left affinity (a < 0) on both endpoints.
		expect(selection.start.a.a).toBeLessThan(0);
		expect(selection.end.a.a).toBeLessThan(0);
		// Anchors survive JSON round-trip and resolve to the caret offset.
		const revived = JSON.parse(JSON.stringify(selection.start));
		const resolved = edytor.selection.resolveTextAnchor(revived);
		expect(resolved?.text.id).toBe(text.id);
		expect(resolved?.offset).toBe(5);
		// D-16: anchors only — no numeric/text-id compatibility fields.
		expect(selection).toEqual({
			start: selection.start,
			end: selection.end,
			collapsed: true,
			reversed: false,
			t: expect.any(Number)
		});
	});

	it('a remote caret anchor follows a local insert before its position', async () => {
		const { container, edytor } = await renderDomEdytor(input, {
			autoSelectFixture: false
		});
		const text = edytor.root!.children[0]!.firstText;

		await setNativeSelection(edytor, text, 5);
		await publishRemoteSelectionFromLocalSelection(edytor);
		const [remoteSel] = Object.values(
			edytor.awareness.states.get(remoteClientId)?.selections as Record<
				string,
				{ start: Parameters<typeof edytor.selection.resolveTextAnchor>[0] }
			>
		);
		expect(remoteSel?.start).toBeTruthy();

		// A local edit in front of the remote caret shifts its anchor —
		// the remote cursor must keep rendering at the shifted position.
		text.insertAt(0, 'XX');
		await flushDomUpdates();

		const resolved = edytor.selection.resolveTextAnchor(remoteSel.start);
		expect(resolved?.offset).toBe(7);
		await waitFor(() => {
			expect(container.querySelector('[data-edytor-remote-cursor]')).toBeInstanceOf(HTMLElement);
		});
	});

	it('ignores malformed anchor payloads and legacy fields (D-16: no id/offset fallback)', async () => {
		const { container, edytor } = await renderDomEdytor(input, {
			autoSelectFixture: false
		});
		const text = edytor.root!.children[0]!.firstText;

		await setNativeSelection(edytor, text, 4);
		// A v13-shaped RelativePosition payload is NOT a TextAnchor —
		// isTextAnchor rejects it; the retired text-id/offset fields and the
		// legacy `selection` field are not read.
		const legacy = {
			start: { type: { client: 1, clock: 2 }, item: { client: 3, clock: 4 }, assoc: 0 },
			end: { type: { client: 1, clock: 2 }, item: { client: 3, clock: 4 }, assoc: 0 },
			startTextId: text.id,
			endTextId: text.id,
			yStart: 4,
			yEnd: 4,
			isCollapsed: true,
			isReversed: false
		};
		edytor.awareness.states.set(remoteClientId, {
			user: { name: 'Eve', color: '#0ea5e9' },
			selection: legacy,
			selections: { 'view-1': legacy }
		});
		edytor.awareness.emit('change', [
			{ added: [remoteClientId], updated: [], removed: [] },
			'test'
		]);
		edytor.awareness.emit('update', [
			{ added: [remoteClientId], updated: [], removed: [] },
			'test'
		]);
		await flushDomUpdates();

		expect(container.querySelector('[data-edytor-remote-cursor]')).toBeNull();
	});

	it('drops a remote selection whose payload cannot resolve at all', async () => {
		const { container, edytor } = await renderDomEdytor(input, {
			autoSelectFixture: false
		});
		const text = edytor.root!.children[0]!.firstText;

		await setNativeSelection(edytor, text, 4);
		// Garbage anchors + unknown ids → nothing resolvable → no render.
		edytor.awareness.states.set(remoteClientId, {
			user: { name: 'Mallory', color: '#0ea5e9' },
			selections: {
				'view-1': {
					start: { b: 123, a: 'nope' },
					end: { b: 'nonexistent-block', a: { i: null, a: -1 } },
					collapsed: true,
					reversed: false
				}
			}
		});
		edytor.awareness.emit('change', [
			{ added: [remoteClientId], updated: [], removed: [] },
			'test'
		]);
		edytor.awareness.emit('update', [
			{ added: [remoteClientId], updated: [], removed: [] },
			'test'
		]);
		await flushDomUpdates();

		expect(container.querySelector('[data-edytor-remote-cursor]')).toBeNull();
		expect(container.querySelector('[data-edytor-remote-selection]')).toBeNull();
	});

	it('clears the published local selection when the editor is destroyed', async () => {
		const { edytor } = await renderDomEdytor(input, { autoSelectFixture: false });
		const text = edytor.root!.children[0]!.firstText;

		await setNativeSelection(edytor, text, 3);
		// U5 — presence is per-view: the entry lives under `selections`
		// (D-16: no legacy `selection` mirror).
		expect(Object.keys(edytor.awareness.getLocalState()?.selections ?? {})).toHaveLength(1);
		expect(edytor.awareness.getLocalState()?.selection).toBeUndefined();

		// A live view's selection-layer teardown (the {#key} remount path)
		// keeps its presence — the view still owns the slot.
		edytor.selection.destroy();
		expect(Object.keys(edytor.awareness.getLocalState()?.selections ?? {})).toHaveLength(1);

		// Real editor teardown drops the dead view's caret (edytor.destroyed
		// is set before selection.destroy() runs).
		edytor.destroy();
		expect(edytor.awareness.getLocalState()?.selections).toBeUndefined();
	});
});
