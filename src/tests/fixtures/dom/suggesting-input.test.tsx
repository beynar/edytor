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
	flushDomUpdates,
	renderDomEdytor
} from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

/** The pending runs the text draws: their kinds and text. */
const runs = (editor: HTMLElement) =>
	[...editor.querySelectorAll('[data-edytor-suggested-run]')].map((n) => [
		n.getAttribute('data-edytor-suggested-run'),
		n.textContent
	]);
const changes = (edytor: Edytor) => edytor.facade.suggest.changes().map((c) => [c.kind, c.text]);
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
			</root>
		);
		edytor.suggestions.suggesting = true;
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '!' });
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '?' });
		expect(shown(edytor)).toEqual(['Hello world!?']);
		// Drawn in the text, as a mark is (`sugg.view.runs`).
		await flushDomUpdates();
		expect(runs(editor)).toEqual([['insert', '!?']]);
		// Backspace over its own pending text deletes it; over "d" it proposes:
		// the "d" stays, struck, and the caret goes before it.
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		await dispatchDomBeforeInput(editor, { inputType: 'deleteContentBackward' });
		expect(shown(edytor)).toEqual(['Hello world']);
		expect(edytor.selection.caret?.offset).toBe(10);
		await flushDomUpdates();
		expect(runs(editor)).toEqual([['delete', 'd']]);
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

	it('a paste of several lines is the suggestion’s blocks', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>One|</paragraph>
			</root>
		);
		edytor.suggestions.suggesting = true;
		await dispatchPaste(editor, 'two\nthree');
		expect(shown(edytor)).toEqual(['Onetwo', 'three']);
		expect(changes(edytor)).toEqual([
			['insert', 'two'],
			['split', 'three']
		]);
		expect(base(edytor)).toEqual(['One']);
	});
});
