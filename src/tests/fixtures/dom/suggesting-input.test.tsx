/** @jsxImportSource ../../jsx */
/**
 * Suggesting mode under real input (`sugg.*`, site `editor/suggestions`):
 * the browser's own occurrences — `beforeinput` typing and deletes, an
 * input method's composition, a paste — reach the document as the view's
 * suggestion, never as a direct write, because each one is a dispatcher
 * write (`Dispatcher.write` hands it to `suggestions.written`). Expected
 * values come from the design (`docs/archive/shared-suggestions/design.md`
 * §3), never from a run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import {
	dispatchComposition,
	dispatchDomBeforeInput,
	dispatchPaste,
	defaultPlugins,
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';
import { suggestionsOf } from '$lib/crdt/doc/suggest.js';
import {
	createSharedSuggestionsPlugin,
	sharedSuggestionsController
} from '$lib/plugins/suggestions/shared.svelte.js';

/** The views here list the shared suggestions plugin. */
const options = () => ({ plugins: [...defaultPlugins, createSharedSuggestionsPlugin()] });
const suggesting = (edytor: Edytor) => (sharedSuggestionsController(edytor)!.suggesting = true);

afterEach(() => {
	document.body.innerHTML = '';
});

const changes = (edytor: Edytor) =>
	suggestionsOf(edytor.facade)
		.changes()
		.map((c) => [c.kind, c.text]);
const shown = (edytor: Edytor) => edytor.root!.children.map((b) => edytor.facade.blockText(b.id));
const base = (edytor: Edytor) =>
	edytor.facade
		.toJSON()
		.children.map((b) => (b.content ?? []).map((r) => ('text' in r ? r.text : '')).join(''));

describe('suggesting mode under the browser’s input', () => {
	it('typed text, a Backspace over others’ text and a composition are one suggestion', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>Hello world|</paragraph>
			</root>,
			options()
		);
		suggesting(edytor);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '?' });
		expect(shown(edytor)).toEqual(['Hello world!?']);
		// Backspace over its own pending text deletes it; over "d" it proposes:
		// the "d" stays, struck, and the caret goes before it.
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(shown(edytor)).toEqual(['Hello world']);
		expect(edytor.selection.caret?.offset).toBe(10);
		// An input method's composition at the caret (before the "d").
		await dispatchComposition(editor, [
			{ type: 'compositionstart' },
			{ type: 'beforeinput', inputType: 'insertCompositionText', data: 'に' },
			{ type: 'compositionend', data: 'に' }
		]);
		await flushDomUpdates();
		expect(shown(edytor)).toEqual(['Hello worlにd']);
		expect(changes(edytor)).toEqual([
			['insert', 'に'],
			['delete', 'd']
		]);
		expect(edytor.suggestions.list.filter((s) => s.shared)).toHaveLength(1);
		// The document without them is as it was.
		expect(base(edytor)).toEqual(['Hello world']);
	});

	it('typing or pasting over a selection: the deletion is proposed, the insertion lands after it', async () => {
		const typed = await renderDomEdytor(
			<root>
				<paragraph>Hel|lo wo|rld</paragraph>
			</root>,
			options()
		);
		suggesting(typed.edytor);
		await dispatchDomBeforeInput(typed.editor, { inputType: 'insertText', data: 'X' });
		expect(shown(typed.edytor)).toEqual(['Hello woXrld']);
		expect(typed.edytor.selection.caret?.offset).toBe(9);
		expect(changes(typed.edytor)).toEqual([
			['delete', 'lo wo'],
			['insert', 'X']
		]);
		document.body.innerHTML = '';
		const pasted = await renderDomEdytor(
			<root>
				<paragraph>Hel|lo wo|rld</paragraph>
			</root>,
			options()
		);
		suggesting(pasted.edytor);
		await dispatchPaste(pasted.editor, 'P\nQ');
		expect(shown(pasted.edytor)).toEqual(['Hello woP', 'Qrld']);
		expect(changes(pasted.edytor)).toEqual([
			['delete', 'lo wo'],
			['insert', 'P'],
			['split', 'Qrld']
		]);
		expect(base(pasted.edytor)).toEqual(['Hello world']);
	});

	it('a paste of several lines is the suggestion’s blocks', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
			</root>,
			options()
		);
		suggesting(edytor);
		await dispatchPaste(editor, 'two\nthree');
		expect(shown(edytor)).toEqual(['Onetwo', 'three']);
		expect(changes(edytor)).toEqual([
			['insert', 'two'],
			['split', 'three']
		]);
		expect(base(edytor)).toEqual(['One']);
	});
});
