/** @jsxImportSource ../../jsx */
/**
 * The page and the session's history (`hist.release.end`), and a view that
 * only reads (`attr.binding.first-write`), in a mounted editor:
 *
 * - P-L1 — a `pagehide` the back/forward cache keeps nothing of ends the
 *   history: its steps go, one release record names this writer, and the
 *   release is written before the providers leave (the page-leave `transport`
 *   phase), whatever order they subscribed in;
 * - P-L2 — a `pagehide` of a page the cache keeps (`persisted`) releases
 *   nothing: the steps stay, and undo restores the deleted block;
 * - P-L3 — a tab that only lost its network (`offline`) releases nothing:
 *   undo still restores;
 * - P-L4 — a view that only reads (focus, carets, arrow keys) writes
 *   nothing: the stored document stays byte-identical, and the page's
 *   leaving writes nothing either.
 *
 * Expected values come from the contract rows, never from running the code.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import { loadDocument } from '$lib/crdt/index.js';
import { releasesOf } from '$lib/crdt/purge.js';
import { onPageLeave } from '$lib/crdt/providers/room.js';
import { asEngineDoc } from '$lib/crdt/structs.js';
import {
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor,
	setNativeSelection
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const ids = (edytor: Edytor) => edytor.value.children.map((block) => block.id);
const releases = (edytor: Edytor) => releasesOf(asEngineDoc(edytor.document.doc));

const pagehide = (persisted: boolean) =>
	window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted }));

/** A view of two paragraphs whose second one it deleted (one undo step); their ids. */
const deleted = async () => {
	const rendered = await renderDomEdytor(
		<root>
			<paragraph>first|</paragraph>
			<paragraph>second</paragraph>
		</root>
	);
	const [a, b] = ids(rendered.edytor);
	rendered.edytor.deleteBlocks([b!]);
	await flushDomUpdates();
	expect(ids(rendered.edytor)).toEqual([a]);
	expect(rendered.edytor.undoManager.undoStack.length).toBe(1);
	return { ...rendered, a: a!, b: b! };
};

describe('the page leaving ends the session’s history (hist.release.end)', () => {
	it('P-L1: a pagehide the cache keeps nothing of releases, before the providers leave', async () => {
		// A provider's departure: the `transport` phase, subscribed before the view.
		let view: Edytor | null = null;
		const seen: { at: Map<number, number> | null } = { at: null };
		const off = onPageLeave(() => (seen.at = view && releases(view)), 'transport');
		const { edytor, a } = await deleted();
		view = edytor;
		const writer = edytor.document.clientID;
		try {
			pagehide(false);
		} finally {
			off();
		}
		expect([...releases(edytor).keys()]).toEqual([writer]);
		expect([...(seen.at?.keys() ?? [])]).toEqual([writer]);
		expect(edytor.document.history.undoStack.length).toBe(0);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(ids(edytor)).toEqual([a]);
	});

	it('P-L2: a pagehide of a page the back/forward cache keeps releases nothing', async () => {
		const { edytor, a, b } = await deleted();
		pagehide(true);
		expect(releases(edytor).size).toBe(0);
		expect(edytor.undoManager.undoStack.length).toBe(1);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(ids(edytor)).toEqual([a, b]);
	});

	it('P-L3: a tab that only lost its network releases nothing', async () => {
		const { edytor, a, b } = await deleted();
		window.dispatchEvent(new Event('offline'));
		window.dispatchEvent(new Event('online'));
		expect(releases(edytor).size).toBe(0);
		edytor.historyUndo();
		await flushDomUpdates();
		expect(ids(edytor)).toEqual([a, b]);
	});
});

describe('a view that only reads writes nothing (attr.binding.first-write)', () => {
	it('P-L4: carets and arrow keys leave the stored document byte-identical, and so does leaving', async () => {
		const fixture = (
			<root>
				<paragraph>first</paragraph>
				<paragraph>second</paragraph>
			</root>
		);
		const writer = await renderDomEdytor(fixture);
		writer.edytor.insertText(ids(writer.edytor)[0]!, 5, '!');
		const stored = writer.edytor.document.encode();
		writer.unmount();
		document.body.innerHTML = '';
		const reference = loadDocument(stored).encode();
		const viewer = loadDocument(stored, { actor: { id: 'viewer' } });
		const { edytor, editor } = await renderDomEdytor(fixture, {
			document: viewer,
			autoSelectFixture: false
		});
		const [first, second] = edytor.root!.children;
		await setNativeSelection(edytor, first!.firstText, 2);
		await dispatchDomKeyDown(editor, { key: 'ArrowDown' });
		await setNativeSelection(edytor, second!.firstText, 0, second!.firstText, 3);
		await dispatchDomKeyDown(editor, { key: 'ArrowRight' });
		await flushDomUpdates();
		pagehide(false);
		const doc = edytor.document.doc;
		expect(doc.store.clients.has(edytor.document.clientID)).toBe(false);
		expect(edytor.document.attribution.actorOf(edytor.document.clientID)).toBeUndefined();
		expect(edytor.document.encode()).toEqual(reference);
	});
});
