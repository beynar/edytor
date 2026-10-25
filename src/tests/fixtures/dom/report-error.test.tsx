/** @jsxImportSource ../../jsx */
/**
 * An async input handler's failure goes to the platform's `reportError`,
 * read only when a handler fails: a test DOM without it (happy-dom) types
 * normally (the wrapper in `edytor.svelte.ts`, `#withUserInput`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchDomBeforeInput, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

const original = globalThis.reportError;
afterEach(() => {
	globalThis.reportError = original;
	document.body.innerHTML = '';
});

describe('an input handler without the platform reportError', () => {
	it('typing works and no handler throws', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>ab|</paragraph>
			</root>
		);
		// A listener's throw reaches the window as an uncaught error.
		const uncaught: unknown[] = [];
		window.addEventListener('error', (event) => {
			uncaught.push(event.error);
			event.preventDefault();
		});
		// @ts-expect-error -- a DOM emulation that has none
		delete globalThis.reportError;
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'c' });
		await flushDomUpdates();
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: 'd' });
		await flushDomUpdates();
		expect(edytor.value.children?.[0]?.content).toEqual([{ text: 'abcd' }]);
		expect(uncaught).toEqual([]);
	});
});
