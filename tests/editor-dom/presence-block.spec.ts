import { expect, test } from './editorTest';
import { waitForEditorReady } from './helpers';

/**
 * A peer sharing blocks only (`presence.share: 'block'`) is drawn as a bar
 * beside the block's own row, with its name, never as a caret. The jsdom
 * rows are `src/tests/fixtures/dom/presence-throttle.test.tsx`.
 */
const children = [
	{ id: 'a', type: 'paragraph', content: [{ text: 'Alpha' }] },
	{
		id: 'b',
		type: 'paragraph',
		content: [{ text: 'Beta' }],
		children: [{ id: 'k', type: 'paragraph', content: [{ text: 'Kid' }] }]
	}
];

test('a peer sharing blocks shows as a bar beside the block row', async ({ page }) => {
	await page.goto(`/test/dom?scenario=dst&dst=${encodeURIComponent(JSON.stringify({ children }))}`);
	await waitForEditorReady(page, { requireRuntime: true });
	await page.evaluate(() => {
		const edytor = (window as unknown as { __EDYTOR__: any }).__EDYTOR__;
		edytor.awareness.states.set(4242, {
			user: { name: 'Ada', color: '#e11d48' },
			selections: { 'view-1': { blocks: ['b'], t: 1 } }
		});
		edytor.awareness.emit('change', [{ added: [4242], updated: [], removed: [] }, 'test']);
	});
	const bar = page.locator('[data-edytor-remote-cursor][data-edytor-remote-block]');
	await expect(bar).toBeVisible();
	await expect(page.locator('[data-edytor-remote-cursor-label]')).toHaveText('Ada');
	const row = (await page
		.locator('[data-edytor-id="b"] [data-edytor-text]')
		.first()
		.boundingBox())!;
	const kid = (await page.locator('[data-edytor-id="k"][data-edytor-block]').boundingBox())!;
	const box = (await bar.boundingBox())!;
	// Beside the block, spanning its own row, not its child.
	expect(box.x).toBeLessThan(row.x);
	expect(box.y).toBeLessThanOrEqual(row.y + 1);
	expect(box.y + box.height).toBeGreaterThanOrEqual(row.y + row.height - 1);
	expect(box.y + box.height).toBeLessThanOrEqual(kid.y + 1);
});
