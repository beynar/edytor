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
	const localState = edytor.awareness.getLocalState();
	const selection = localState?.selection;
	if (!selection) {
		throw new Error('Expected local awareness selection before publishing remote state');
	}

	edytor.awareness.states.set(remoteClientId, {
		user,
		selection
	});
	edytor.awareness.emit('change', [{ added: [remoteClientId], updated: [], removed: [] }, 'test']);
	edytor.awareness.emit('update', [{ added: [remoteClientId], updated: [], removed: [] }, 'test']);
	edytor.refreshRemotePresence();
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
		edytor.refreshRemotePresence();
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
		const selection = edytor.awareness.getLocalState()?.selection as {
			start: { b: string; a: { i: { c: number; k: number } | null; a: number } };
			end: { b: string; a: { i: { c: number; k: number } | null; a: number } };
			yStart: number;
			yEnd: number;
		};

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
		// Numeric compatibility fields remain for older peers.
		expect(selection.yStart).toBe(5);
		expect(selection.yEnd).toBe(5);
	});

	it('a remote caret anchor follows a local insert before its position', async () => {
		const { container, edytor } = await renderDomEdytor(input, {
			autoSelectFixture: false
		});
		const text = edytor.root!.children[0]!.firstText;

		await setNativeSelection(edytor, text, 5);
		await publishRemoteSelectionFromLocalSelection(edytor);
		const remoteSel = edytor.awareness.states.get(remoteClientId)?.selection as {
			start: Parameters<typeof edytor.selection.resolveTextAnchor>[0];
		};
		expect(remoteSel?.start).toBeTruthy();

		// A local edit in front of the remote caret shifts its anchor —
		// the remote cursor must keep rendering at the shifted position.
		text.yText.insert(0, 'XX');
		await flushDomUpdates();

		const resolved = edytor.selection.resolveTextAnchor(remoteSel.start);
		expect(resolved?.offset).toBe(7);
		await waitFor(() => {
			expect(container.querySelector('[data-edytor-remote-cursor]')).toBeInstanceOf(HTMLElement);
		});
	});

	it('ignores malformed anchor payloads and falls back to ids/offsets', async () => {
		const { container, edytor } = await renderDomEdytor(input, {
			autoSelectFixture: false
		});
		const text = edytor.root!.children[0]!.firstText;

		await setNativeSelection(edytor, text, 4);
		// A v13-shaped RelativePosition payload is NOT a TextAnchor —
		// isTextAnchor rejects it and the id/offset fallback renders.
		edytor.awareness.states.set(remoteClientId, {
			user: { name: 'Eve', color: '#0ea5e9' },
			selection: {
				start: { type: { client: 1, clock: 2 }, item: { client: 3, clock: 4 }, assoc: 0 },
				end: { type: { client: 1, clock: 2 }, item: { client: 3, clock: 4 }, assoc: 0 },
				startTextId: text.id,
				endTextId: text.id,
				yStart: 4,
				yEnd: 4,
				isCollapsed: true,
				isReversed: false
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
		edytor.refreshRemotePresence();
		await flushDomUpdates();

		await waitFor(() => {
			expect(container.querySelector('[data-edytor-remote-cursor]')).toBeInstanceOf(HTMLElement);
		});
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
			selection: {
				start: { b: 123, a: 'nope' },
				end: { b: 'nonexistent-block', a: { i: null, a: -1 } },
				startTextId: 'nonexistent',
				endTextId: 'nonexistent',
				yStart: 99,
				yEnd: 99,
				isCollapsed: true,
				isReversed: false
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
		edytor.refreshRemotePresence();
		await flushDomUpdates();

		expect(container.querySelector('[data-edytor-remote-cursor]')).toBeNull();
		expect(container.querySelector('[data-edytor-remote-selection]')).toBeNull();
	});

	it('clears the published local selection when the selection layer is destroyed', async () => {
		const { edytor } = await renderDomEdytor(input, { autoSelectFixture: false });
		const text = edytor.root!.children[0]!.firstText;

		await setNativeSelection(edytor, text, 3);
		expect(edytor.awareness.getLocalState()?.selection).toBeTruthy();

		edytor.selection.destroy();
		expect(edytor.awareness.getLocalState()?.selection).toBeUndefined();
	});
});
