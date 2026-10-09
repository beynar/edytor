/**
 * The render's own markers stay few on a real page (`render.markers`; the
 * jsdom row `render-markers.test.tsx` holds each bundled kind's ceiling):
 * the comments and empty text nodes Svelte leaves as anchors, which the
 * browser walks when it recomputes the editing host's text after a
 * keystroke. Counted inside the host of `/test/large` (paragraphs, headings,
 * list items, bold runs) and of the demo page (every bundled kind), per
 * block; the ceilings are the counts measured after the markers were
 * reduced. The counts are annotations too.
 */
import { expect, test, type Page } from './editorTest';

type Markers = { blocks: number; comments: number; emptyTexts: number; whitespace: number };

/** The host's blocks, comments, empty text nodes and whitespace-only text nodes. */
const markersOf = (page: Page, host: string) =>
	page.locator(host).evaluate((root): Markers => {
		const markers = { blocks: 0, comments: 0, emptyTexts: 0, whitespace: 0 };
		markers.blocks = root.querySelectorAll('[data-edytor-block="true"]').length;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node.nodeType === Node.COMMENT_NODE) markers.comments++;
			else if ((node as Text).data === '') markers.emptyTexts++;
			// Whitespace between tags (a text's own spaces are content).
			else if (!(node as Text).data.trim() && !node.parentElement?.closest('[data-edytor-text]'))
				markers.whitespace++;
		}
		return markers;
	});

const report = (name: string, markers: Markers) => {
	const per = (count: number) => (count / markers.blocks).toFixed(2);
	test.info().annotations.push({
		type: name,
		description:
			`${markers.blocks} blocks: ${per(markers.comments)} comments, ` +
			`${per(markers.emptyTexts)} empty text nodes, ${per(markers.whitespace)} whitespace ` +
			`text nodes per block (${markers.comments} / ${markers.emptyTexts} / ${markers.whitespace})`
	});
};

test.describe('render markers (render.markers)', () => {
	test('a long page: at most its ceiling of markers per block', async ({ page }) => {
		await page.goto('/test/large?blocks=1000');
		await page.waitForFunction(() => '__large' in window, null, { timeout: 60_000 });
		const markers = await markersOf(page, 'main > [data-edytor]');
		report('/test/large', markers);
		expect(markers.blocks).toBe(1000);
		expect(markers.comments / markers.blocks).toBeLessThanOrEqual(CEILING.large.comments);
		expect(markers.emptyTexts / markers.blocks).toBeLessThanOrEqual(CEILING.large.emptyTexts);
		expect(markers.whitespace).toBe(0);
	});

	test('the demo page: at most its ceiling of markers per block', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('[data-edytor-id="page-code-line"]')).toBeVisible();
		const markers = await markersOf(page, '[data-edytor]');
		report('demo', markers);
		expect(markers.comments / markers.blocks).toBeLessThanOrEqual(CEILING.demo.comments);
		expect(markers.emptyTexts / markers.blocks).toBeLessThanOrEqual(CEILING.demo.emptyTexts);
	});
});

/**
 * Per block, measured after the reduction (before it: 23.6 comments and 9.7
 * empty text nodes on the long page, 23.4 and 10.2 on the demo, and a
 * whitespace node per block).
 */
const CEILING = {
	large: { comments: 9.4, emptyTexts: 1.4 },
	demo: { comments: 10.2, emptyTexts: 2.7 }
};
