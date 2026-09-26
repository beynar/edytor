/** @jsxImportSource ../../../jsx */
/**
 * U5/F3 DOM probes — `<Edytor {document} {sync}>` attaches the provider to
 * the DOCUMENT's lifetime (via `document.attachSync`), not the component's:
 *
 * - unmounting the sync-carrying view must not kill the provider while
 *   sibling views stay mounted;
 * - a second view carrying the SAME sync factory dedupes (one provider);
 * - `document.destroy()` releases the provider even after every view is
 *   gone;
 * - a view-owned document (no `document` prop) keeps the legacy
 *   component-lifetime teardown.
 */
import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

import EdytorHarness from '../../../dom/EdytorHarness.svelte';
import { flushDomUpdates, renderDomEdytor } from '../../../dom/test.utils.js';
import { createDocument } from '$lib/crdt/index.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { EdytorSync } from '$lib/collaboration/index.js';
import type { JSONDoc } from '$lib/utils/json.js';

const input = (
	<root>
		<paragraph>Hello world</paragraph>
	</root>
);

const value = input.value as JSONDoc;

const countingSync = (counts: { attach: number; cleanup: number }): EdytorSync => {
	return (payload) => {
		counts.attach++;
		payload.synced();
		return () => {
			counts.cleanup++;
		};
	};
};

describe('document-lifetime sync for injected documents', () => {
	it('attaches the provider to the document — view unmount does not kill it', async () => {
		const document = createDocument();
		const counts = { attach: 0, cleanup: 0 };
		const sync = countingSync(counts);

		const rendered = await renderDomEdytor(input, { document, sync });
		expect(counts.attach).toBe(1);
		expect(rendered.edytor.synced).toBe(true);
		expect(rendered.edytor.document).toBe(document);
		expect(rendered.edytor.awareness).toBe(document.awareness);
		expect(rendered.container.querySelector('[data-edytor]')).toBeInstanceOf(HTMLElement);

		rendered.unmount();
		await flushDomUpdates();

		// The view is gone — the provider stays: it belongs to the document.
		expect(rendered.edytor.destroyed).toBe(true);
		expect(document.destroyed).toBe(false);
		expect(counts.cleanup).toBe(0);

		document.destroy();
		expect(counts.cleanup).toBe(1);
	});

	it('unmounting the sync-carrying view keeps the provider for siblings', async () => {
		const document = createDocument();
		const counts = { attach: 0, cleanup: 0 };
		const sync = countingSync(counts);

		const carrier = await renderDomEdytor(input, { document, sync });
		const sibling = await renderDomEdytor(input, { document });
		expect(counts.attach).toBe(1);

		carrier.unmount();
		await flushDomUpdates();

		expect(counts.cleanup).toBe(0); // the F3 fix — siblings keep the provider
		expect(sibling.edytor.destroyed).toBe(false);
		expect(sibling.edytor.awareness.getLocalState()).not.toBeNull();

		document.destroy();
		expect(counts.cleanup).toBe(1);
		sibling.unmount();
	});

	it('two views carrying the same sync factory attach ONE provider', async () => {
		const document = createDocument();
		const counts = { attach: 0, cleanup: 0 };
		let reportSynced: (() => void) | null = null;
		const sync: EdytorSync = (payload) => {
			counts.attach++;
			reportSynced = payload.synced as () => void;
			return () => {
				counts.cleanup++;
			};
		};

		let edytorA: Edytor | undefined;
		let edytorB: Edytor | undefined;
		const a = render(EdytorHarness, {
			props: {
				value,
				plugins: [richTextPlugin],
				document,
				sync,
				onReady: (edytor: Edytor) => {
					edytorA = edytor;
				}
			}
		});
		const b = render(EdytorHarness, {
			props: {
				value,
				plugins: [richTextPlugin],
				document,
				sync,
				onReady: (edytor: Edytor) => {
					edytorB = edytor;
				}
			}
		});

		expect(counts.attach).toBe(1); // second identical attach deduped
		expect(edytorA!.synced).toBe(false); // both views wait on the provider
		expect(edytorB!.synced).toBe(false);

		reportSynced!();
		await tick();
		await waitFor(() => {
			expect(edytorA!.synced).toBe(true);
			expect(edytorB!.synced).toBe(true);
		});
		expect(a.container.querySelector('[data-edytor]')).toBeInstanceOf(HTMLElement);
		expect(b.container.querySelector('[data-edytor]')).toBeInstanceOf(HTMLElement);
		// Both views share the one document awareness.
		expect(edytorA!.awareness).toBe(document.awareness);
		expect(edytorB!.awareness).toBe(document.awareness);

		a.unmount();
		b.unmount();
		await flushDomUpdates();
		expect(counts.cleanup).toBe(0); // still document-lifetime
		document.destroy();
		expect(counts.cleanup).toBe(1);
	});

	it('a view-owned document keeps component-lifetime sync teardown', async () => {
		const counts = { attach: 0, cleanup: 0 };
		const sync = countingSync(counts);

		const rendered = await renderDomEdytor(input, { sync });
		expect(counts.attach).toBe(1);
		expect(rendered.edytor.ownsDocument).toBe(true);

		rendered.unmount();
		await flushDomUpdates();
		expect(counts.cleanup).toBe(1); // unmount tears the provider down — legacy
	});

	it('a view-owned document still seeds after the provider reports terminal `failed`', async () => {
		// The owned path must not skip the `failed` contract: a terminal
		// provider failure settles the document's pending claim and hands
		// the decision back to this view — pending must not latch forever.
		let reportFailed: ((error: unknown, provider: unknown) => void) | null = null;
		const counts = { attach: 0, cleanup: 0 };
		const sync: EdytorSync = (payload) => {
			counts.attach++;
			reportFailed = payload.failed ?? null;
			return () => {
				counts.cleanup++;
			};
		};

		// Mount directly — `renderDomEdytor` waits for readiness, which a
		// never-syncing provider would deadlock.
		let edytor: Edytor | undefined;
		const rendered = render(EdytorHarness, {
			props: {
				value,
				plugins: [richTextPlugin],
				sync,
				onReady: (instance: Edytor) => {
					edytor = instance;
				}
			}
		});
		expect(counts.attach).toBe(1);
		expect(edytor!.ownsDocument).toBe(true);
		expect(edytor!.synced).toBe(false); // the provider owns the decision
		expect(edytor!.document.syncPending).toBe(true);

		reportFailed!(new Error('refused'), null);
		await waitFor(() => {
			// `syncFailed && !syncPending` → the view's readiness path
			// decides: the document seeds and the view syncs.
			expect(edytor!.synced).toBe(true);
		});
		expect(edytor!.document.syncFailed).toBe(true);
		expect(edytor!.document.syncPending).toBe(false);
		expect(edytor!.document.ready).toBe(true);
		expect(rendered.container.querySelector('[data-edytor]')).toBeInstanceOf(HTMLElement);

		rendered.unmount();
		await flushDomUpdates();
		expect(counts.cleanup).toBe(1);
	});

	it('an already-ready injected document still syncs a late-mounted sync-carrying view', async () => {
		// A ready document + `sync` prop must not wedge the view: the
		// readiness listener resolves on `document.ready` immediately and
		// the provider attach dedupes/decides nothing further.
		const document = createDocument({ value });
		const counts = { attach: 0, cleanup: 0 };
		const sync = countingSync(counts);

		const rendered = await renderDomEdytor(input, { document, sync });
		expect(counts.attach).toBe(1); // attach still registers the provider
		expect(rendered.edytor.synced).toBe(true);
		expect(rendered.container.querySelector('[data-edytor]')).toBeInstanceOf(HTMLElement);

		rendered.unmount();
		document.destroy();
		expect(counts.cleanup).toBe(1);
	});
});
