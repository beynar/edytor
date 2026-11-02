/** @jsxImportSource ../../jsx */
/**
 * A commit that replaces a text's runs renders once (`dom.render.before`):
 * the old runs' text nodes give way to the new ones before the observer
 * compares, so it never reads a half-written render back as typed text.
 * Svelte's async mode (`experimental.async`, which an app may turn on) writes
 * a flush's structure (its marks and runs) before any `$effect.pre`; this
 * file runs in that mode too (`pnpm test:dom:async`). The truth check after
 * each row holds the DOM to the model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import { richTextOperations } from '$lib/plugins/richtext/richTextOperations.js';
import { flushDomUpdates, renderDomEdytor, setNativeSelection } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
});

const mount = (text: string) =>
	renderDomEdytor(<root></root>, {
		value: { children: [{ id: 'p', type: 'paragraph', content: [{ text }] }] }
	});
const content = (edytor: Edytor) => edytor.value.children?.[0]?.content;
const shown = (edytor: Edytor) => edytor.root!.children[0]!.firstText!.node!.textContent;

describe('dom.render.before — a commit that replaces a text’s runs renders once', () => {
	it('bold over the last word', async () => {
		const { edytor } = await mount('hello world');
		await setNativeSelection(edytor, edytor.root!.children[0]!.firstText!, 6, undefined, 11);
		richTextOperations(edytor).setMarkAtRange('bold');
		await flushDomUpdates();
		expect(content(edytor)).toEqual([{ text: 'hello ' }, { text: 'world', marks: { bold: true } }]);
		expect(shown(edytor)).toBe('hello world');
	});

	it('bold over a middle word: the rest of the line stays', async () => {
		const { edytor } = await mount('hello world again');
		await setNativeSelection(edytor, edytor.root!.children[0]!.firstText!, 6, undefined, 11);
		richTextOperations(edytor).setMarkAtRange('bold');
		await flushDomUpdates();
		expect(content(edytor)).toEqual([
			{ text: 'hello ' },
			{ text: 'world', marks: { bold: true } },
			{ text: ' again' }
		]);
		expect(shown(edytor)).toBe('hello world again');
	});

	it('a link over a middle range', async () => {
		const { edytor } = await mount('see docs here');
		await setNativeSelection(edytor, edytor.root!.children[0]!.firstText!, 4, undefined, 8);
		richTextOperations(edytor).setLinkAtRange({ href: 'https://example.com' });
		await flushDomUpdates();
		expect(content(edytor)).toEqual([
			{ text: 'see ' },
			{ text: 'docs', marks: { link: { href: 'https://example.com' } } },
			{ text: ' here' }
		]);
		expect(shown(edytor)).toBe('see docs here');
	});

	it('insertFlow of one line of several runs after a text keeps their order', async () => {
		const { edytor } = await mount('Start: ');
		edytor.insertFlow(
			{ block: 'p', offset: 7 },
			{
				lines: [
					{
						id: 'line',
						content: [
							{ kind: 'text', text: 'bold', marks: { bold: true } },
							{ kind: 'text', text: ' and ' },
							{ kind: 'inline', id: 'm1', type: 'mention', data: {} }
						]
					}
				]
			}
		);
		await flushDomUpdates();
		expect(
			(content(edytor) ?? []).map((part) => ('text' in part ? part.text : `@${part.type}`))
		).toEqual(['Start: ', 'bold', ' and ', '@mention']);
		expect(edytor.root!.children[0]!.node!.textContent).toContain('Start: bold and');
	});
});
