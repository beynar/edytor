/**
 * KaTeX from a CDN, the equation plugin's default, on a server (no
 * document): nothing loads and nothing throws; the equation's source shows.
 * The browser rows are `src/tests/fixtures/dom/equation-cdn.test.tsx`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const { importUrl } = vi.hoisted(() => ({ importUrl: vi.fn() }));
vi.mock('$lib/plugins/equation/importUrl.js', () => ({ importUrl }));

import { KATEX_CDN, KATEX_VERSION, cdnKatex } from '$lib/plugins/equation/katex.js';
import { EquationRenderer } from '$lib/plugins/equation/equation.svelte.js';

describe('katex.cdn on a server', () => {
	it('the default loader fetches nothing without a document', async () => {
		await expect(cdnKatex()()).rejects.toThrow(/browser/);
		expect(importUrl).not.toHaveBeenCalled();
	});

	it('a renderer draws nothing and never calls its loader', () => {
		const load = vi.fn(cdnKatex());
		const renderer = new EquationRenderer(load, undefined);
		expect(renderer.draw('x^2', true)).toBeNull();
		expect(load).not.toHaveBeenCalled();
		expect(renderer.mathml('x^2', false)).toContain('<annotation encoding="application/x-tex">x^2');
	});

	it('the CDN is jsDelivr at the exact version edytor is tested with', () => {
		const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
			devDependencies: Record<string, string>;
		};
		expect(KATEX_VERSION).toBe(manifest.devDependencies.katex);
		expect(KATEX_CDN).toBe(`https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/`);
	});
});
