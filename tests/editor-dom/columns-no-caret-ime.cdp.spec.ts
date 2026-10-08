import { openIme } from './cdp';
import { expect, test } from './editorTest';
import { trackPageIssues } from './helpers';
import {
	FULL,
	TEXTS,
	frames,
	openDoc,
	reachGrip,
	resize,
	textBox,
	texts,
	valueKind,
	walk
} from './columnsPaths';

/**
 * Columns, the round-5 review (2026-10-04), issue 2: an IME with no target
 * writes nothing (Notion: typing with no caret does nothing). Chromium's real
 * IME path (`Input.imeSetComposition` / `Input.insertText`): it composes at the
 * caret the browser parked at the host's start; the session refuses, its
 * write is restored, and a press then composes where it placed the caret.
 */

/** A human IME pace between updates. */
const PACE_MS = 40;

const paths = [
	[
		'a block dropped, Mod+Z',
		async (page: import('@playwright/test').Page) => {
			const at = await reachGrip(page, 'Z', 5);
			await page.mouse.down();
			const p = await textBox(page, 'P');
			await walk(page, at, { x: p.x + 8, y: p.y + 2 }, 6);
			await page.mouse.up();
			await expect.poll(() => texts(page)).not.toEqual(TEXTS);
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => texts(page)).toEqual(TEXTS);
		}
	],
	[
		'a resize, Mod+Z',
		async (page: import('@playwright/test').Page) => {
			await resize(page, -50);
			await page.keyboard.press('ControlOrMeta+z');
		}
	]
] as const;

for (const [label, run] of paths)
	test(`${label}, then an IME composes あ: nothing is written; after a click it composes there`, async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await openDoc(page, FULL);
		await run(page);
		await frames(page);
		expect(await valueKind(page)).toBe('none');
		const ime = await openIme(page);
		for (const step of ['a', 'あ']) {
			await ime.compose(step);
			await page.waitForTimeout(PACE_MS);
		}
		await ime.commit('あ');
		await frames(page);
		await expect.poll(() => texts(page)).toEqual(TEXTS);
		expect(await valueKind(page)).toBe('none');
		// What the screen shows is the document: the IME's write is gone.
		await expect
			.poll(() => page.locator('[data-edytor-id="P"] [data-edytor-text="true"]').textContent())
			.toBe('before');
		// A plain key after it writes nothing either.
		await page.keyboard.press('j');
		await frames(page);
		expect(await texts(page)).toEqual(TEXTS);
		// A click places the caret: the IME composes there.
		const b = await textBox(page, 'B');
		await page.mouse.move(b.x + b.width - 8, b.y + b.height / 2 - 4);
		await page.mouse.click(b.x + b.width - 1, b.y + b.height / 2);
		for (const step of ['k', 'か']) {
			await ime.compose(step);
			await page.waitForTimeout(PACE_MS);
		}
		await ime.commit('か');
		await expect
			.poll(() => texts(page))
			.toEqual(TEXTS.map((t) => (t === 'right one' ? 'right oneか' : t)));
		await ime.detach();
		issues.assertClean();
	});
