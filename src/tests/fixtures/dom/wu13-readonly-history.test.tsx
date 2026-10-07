/** @jsxImportSource ../../jsx */
/**
 * WU-13 (API-09): a readonly view cannot rewind the shared document through
 * any path the view offers. `historyUndo()`/`historyRedo()` are the API and
 * check the dispatcher's admission; the keys and the input intents reach
 * them; the view's history itself (an internal member, out of the
 * published declarations) refuses too, so no path the view holds rewinds.
 */
import { describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	dispatchDomBeforeInput,
	dispatchDomKeyDown,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

const texts = (edytor: Edytor) =>
	(edytor.value.children ?? []).map((block) =>
		(block.content ?? []).map((part) => ('text' in part ? part.text : '')).join('')
	);

const bytesOf = (edytor: Edytor) => {
	let bytes = 0;
	edytor.doc.on('update', (update: Uint8Array) => void (bytes += update.length));
	return () => bytes;
};

describe('WU-13 · a readonly view cannot rewind', () => {
	it('no public path of the view undoes or redoes once it is readonly', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|</paragraph>
			</root>
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'c' });
		await dispatchDomBeforeInput(editor, { inputType: 'insertParagraph' });
		edytor.historyUndo();
		await flushDomUpdates();
		// One step to undo (the typing), one to redo (the paragraph).
		expect(texts(edytor)).toEqual(['abc']);

		edytor.readonly = true;
		await flushDomUpdates();
		const bytes = bytesOf(edytor);

		edytor.historyUndo();
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'undo', status: 'refused' });
		edytor.historyRedo();
		expect(edytor.dispatcher.last).toMatchObject({ operation: 'redo', status: 'refused' });

		await dispatchDomKeyDown(editor, { key: 'z', ctrlKey: true });
		await dispatchDomKeyDown(editor, { key: 'z', metaKey: true });
		await dispatchDomKeyDown(editor, { key: 'z', ctrlKey: true, shiftKey: true });
		await dispatchDomKeyDown(editor, { key: 'y', ctrlKey: true });
		await dispatchDomBeforeInput(editor, { inputType: 'historyUndo' });
		await dispatchDomBeforeInput(editor, { inputType: 'historyRedo' });

		// The view's own history (internal) admits nothing either.
		const internal = edytor as unknown as { history: { undo(): boolean; redo(): boolean } };
		expect(internal.history.undo()).toBe(false);
		expect(internal.history.redo()).toBe(false);

		edytor.clear();
		await flushDomUpdates();

		expect(bytes()).toBe(0);
		expect(texts(edytor)).toEqual(['abc']);

		// Editable again, the same stacks replay.
		edytor.readonly = false;
		await flushDomUpdates();
		edytor.historyUndo();
		expect(texts(edytor)).toEqual(['ab']);
		edytor.historyRedo();
		edytor.historyRedo();
		expect(texts(edytor)).toEqual(['abc', '']);
	});
});
