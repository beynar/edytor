/** @jsxImportSource ../../jsx */
/**
 * KaTeX from a CDN, the equation plugin's default (`katex` absent): the
 * first equation drawn in a browser imports KaTeX's module from jsDelivr
 * (`KATEX_CDN`, the exact `KATEX_VERSION`) and adds its stylesheet to the
 * page's head, once whatever the views; the equations draw once both
 * settled. A URL names another copy, `false` loads nothing, a loader
 * (`() => import('katex')`) is the app's own. A failed load leaves the
 * source showing and throws nothing; a later view tries again.
 *
 * The network is stood in for (`importUrl`): a module URL ending in
 * `katex.mjs` is the installed KaTeX, one holding `fail` rejects; a
 * stylesheet settles when the row fires its `load`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { importUrl } = vi.hoisted(() => ({
	importUrl: vi.fn(async (url: string) => {
		if (url.includes('fail') || !url.endsWith('/katex.mjs')) throw new Error(`offline: ${url}`);
		return import('katex');
	})
}));
vi.mock('$lib/plugins/equation/importUrl.js', () => ({ importUrl }));

import type { JSONBlock } from '$lib/utils/json.js';
import type { Plugin } from '$lib/plugins.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { createEquationPlugin } from '$lib/plugins/equation/EquationPlugin.svelte';
import { KATEX_CDN, cdnKatex } from '$lib/plugins/equation/katex.js';
import { flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

afterEach(() => {
	document.body.innerHTML = '';
	importUrl.mockClear();
});

const equation: JSONBlock = { id: 'e', type: 'equation', data: { expression: 'x^2' } };

const mount = (plugins: Plugin[]) =>
	renderDomEdytor(
		<root>
			<paragraph>|</paragraph>
		</root>,
		{ plugins: [...plugins, richTextPlugin], value: { children: [equation] } }
	);

/** The stylesheets the loader added for `href`. */
const links = (href: string) =>
	[...document.head.querySelectorAll<HTMLLinkElement>('link[data-edytor-katex]')].filter(
		(link) => link.getAttribute('href') === href
	);

/** The browser loaded the stylesheet at `href` (jsdom fetches none). */
const loadStylesheet = async (href: string) => {
	await vi.waitFor(() => expect(links(href)).toHaveLength(1));
	links(href)[0]!.dispatchEvent(new Event('load'));
};

const source = () =>
	document.querySelector('[data-edytor-equation] [data-edytor-equation-source]')?.textContent;

const drawn = async () => {
	await vi.waitFor(() => {
		if (!document.querySelector('[data-edytor-equation] .katex')) throw new Error('not drawn yet');
	});
	await flushDomUpdates();
};

describe('katex.cdn: the loader', () => {
	it('imports katex.mjs and adds katex.min.css once, then resolves KaTeX', async () => {
		const base = 'https://cdn.example.test/katex/a/';
		const load = cdnKatex(base);
		const first = load();
		const second = cdnKatex(base)();
		await loadStylesheet(`${base}katex.min.css`);
		const [katex, again] = await Promise.all([first, second]);
		expect(katex).toBe(again);
		expect(typeof (katex as { renderToString?: unknown }).renderToString).toBe('function');
		expect(importUrl.mock.calls).toEqual([[`${base}katex.mjs`]]);
		expect(links(`${base}katex.min.css`)).toHaveLength(1);
		expect(links(`${base}katex.min.css`)[0]!.rel).toBe('stylesheet');
		expect(links(`${base}katex.min.css`)[0]!.parentNode).toBe(document.head);
	});

	it('waits for the stylesheet: KaTeX is not given before it settled (a failed one too)', async () => {
		const base = 'https://cdn.example.test/katex/b/';
		let resolved = false;
		const pending = cdnKatex(base)().then(() => (resolved = true));
		await vi.waitFor(() => expect(importUrl).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(resolved).toBe(false);
		links(`${base}katex.min.css`)[0]!.dispatchEvent(new Event('error'));
		await pending;
		expect(resolved).toBe(true);
	});

	it('a base without its final slash gets one', async () => {
		const base = 'https://cdn.example.test/katex/c';
		const pending = cdnKatex(base)();
		await loadStylesheet(`${base}/katex.min.css`);
		await pending;
		expect(importUrl.mock.calls).toEqual([[`${base}/katex.mjs`]]);
	});

	it('a failed import rejects and is forgotten: the next call tries again', async () => {
		const base = 'https://cdn.example.test/fail/';
		const first = cdnKatex(base)();
		links(`${base}katex.min.css`)[0]?.dispatchEvent(new Event('load'));
		await expect(first).rejects.toThrow(/offline/);
		const second = cdnKatex(base)();
		await expect(second).rejects.toThrow(/offline/);
		expect(importUrl).toHaveBeenCalledTimes(2);
		// The stylesheet is added once still.
		expect(links(`${base}katex.min.css`)).toHaveLength(1);
	});
});

describe('katex.cdn: the plugin', () => {
	it('a CDN that fails leaves the source showing and throws nothing', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await mount([createEquationPlugin({ katex: 'https://cdn.example.test/fail/' })]);
			await vi.waitFor(() => expect(errors).toHaveBeenCalled());
			await flushDomUpdates();
			expect(source()).toBe('x^2');
			expect(document.querySelector('.katex')).toBeNull();
			expect(String(errors.mock.calls[0]?.[0])).toContain('KaTeX failed to load');
		} finally {
			errors.mockRestore();
		}
	});

	it('by default an equation shows its source, then draws with KaTeX from jsDelivr', async () => {
		await mount([createEquationPlugin()]);
		await flushDomUpdates();
		expect(source()).toBe('x^2');
		await loadStylesheet(`${KATEX_CDN}katex.min.css`);
		await drawn();
		expect(importUrl.mock.calls).toEqual([[`${KATEX_CDN}katex.mjs`]]);
	});

	it('two views load KaTeX once', async () => {
		await mount([createEquationPlugin()]);
		await mount([createEquationPlugin()]);
		await vi.waitFor(() => expect(document.querySelectorAll('.katex').length).toBe(2));
		// The previous row's load is the page's: no import, no second stylesheet.
		expect(importUrl).not.toHaveBeenCalled();
		expect(links(`${KATEX_CDN}katex.min.css`)).toHaveLength(1);
	});

	it('a URL names another copy of KaTeX', async () => {
		const base = 'https://cdn.example.test/katex/d/';
		await mount([createEquationPlugin({ katex: base })]);
		await loadStylesheet(`${base}katex.min.css`);
		await drawn();
		expect(importUrl.mock.calls).toEqual([[`${base}katex.mjs`]]);
	});

	it('false loads nothing: the source shows', async () => {
		const before = document.head.querySelectorAll('link').length;
		await mount([createEquationPlugin({ katex: false })]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await flushDomUpdates();
		expect(source()).toBe('x^2');
		expect(importUrl).not.toHaveBeenCalled();
		expect(document.head.querySelectorAll('link').length).toBe(before);
	});

	it("an app's own loader is used as it is, with no stylesheet added", async () => {
		const before = document.head.querySelectorAll('link').length;
		const own = vi.fn(() => import('katex'));
		await mount([createEquationPlugin({ katex: own })]);
		await drawn();
		expect(own).toHaveBeenCalledTimes(1);
		expect(importUrl).not.toHaveBeenCalled();
		expect(document.head.querySelectorAll('link').length).toBe(before);
	});
});
