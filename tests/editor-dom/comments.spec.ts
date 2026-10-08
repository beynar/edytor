import { expect, test, type Page } from './editorTest';
import { trackPageIssues } from './helpers';

/**
 * Comments (site `plugins/comments`) in real browsers, Notion's flow
 * (`src/routes/test/comments`, threads in a memory client as `ada`):
 *
 * - a double-click selects a word, the toolbar's Comment button opens a
 *   card beside the text with its field focused, Enter posts it; the word is
 *   then highlighted and the card sits at its height, right of the text;
 * - a click in the highlighted text makes its thread active; a reply;
 *   Resolve takes the highlight and the card away;
 * - another user's reply arrives live;
 * - on a narrow screen the active card sits under its text;
 * - the default HTTP client posts the thread to the comments route.
 */

const open = async (page: Page, query = '') => {
	await page.goto(`/test/comments${query ? `?${query}` : ''}`);
	await expect(page.locator('[data-edytor-id="a"]')).toBeVisible();
};

/** The box of `word` in block `id`'s text (viewport coordinates). */
const wordBox = (page: Page, id: string, word: string) =>
	page.evaluate(
		({ id, word }) => {
			const block = document.querySelector(`[data-edytor-id="${id}"]`)!;
			const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const at = node.textContent!.indexOf(word);
				if (at < 0) continue;
				const range = document.createRange();
				range.setStart(node, at);
				range.setEnd(node, at + word.length);
				const { x, y, width, height } = range.getBoundingClientRect();
				return { x, y, width, height };
			}
			throw new Error(`no ${word} in ${id}`);
		},
		{ id, word }
	);

/** Double-click `word` (a selection of it), then press the toolbar's Comment button. */
const startOn = async (page: Page, id: string, word: string) => {
	const box = await wordBox(page, id, word);
	await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
	await page.getByTestId('toolbar-comment').click();
	const field = page.locator('[data-edytor-comment-new] textarea');
	await expect(field).toBeFocused();
	return field;
};

const post = async (page: Page, id: string, word: string, body: string) => {
	const field = await startOn(page, id, word);
	await page.keyboard.type(body);
	await page.keyboard.press('Enter');
	await expect(page.locator('[data-edytor-comment-new]')).toHaveCount(0);
	const mark = page.locator('[data-edytor-mark^="comment:"]', { hasText: word });
	await expect(mark).toHaveCount(1);
	const thread = (await mark.getAttribute('data-edytor-mark'))!.slice('comment:'.length);
	return { field, thread, mark, card: page.locator(`[data-edytor-comment-card="${thread}"]`) };
};

const background = (page: Page, thread: string) =>
	page
		.locator(`[data-edytor-mark="comment:${thread}"]`)
		.evaluate((node) => getComputedStyle(node).backgroundColor);

test.describe('comments', () => {
	test('Comment on a selected word: a card beside it, the word highlighted once posted', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		await open(page);
		const field = await startOn(page, 'a', 'quick');
		await expect(page.locator('[data-edytor-comment-new] [data-edytor-comment-quote]')).toHaveText(
			'quick'
		);
		// The draft's text is highlighted before it is posted.
		await expect(page.locator('[data-edytor-comment-draft]')).toHaveCount(1);
		await field.pressSequentially('Is this the right word?');
		await page.keyboard.press('Enter');
		const mark = page.locator('[data-edytor-mark^="comment:"]');
		await expect(mark).toHaveText('quick');
		const thread = (await mark.getAttribute('data-edytor-mark'))!.slice('comment:'.length);
		const card = page.locator(`[data-edytor-comment-card="${thread}"]`);
		await expect(card).toBeVisible();
		await expect(card.locator('[data-edytor-comment-body]')).toHaveText('Is this the right word?');
		await expect(card.locator('[data-edytor-comment-author]')).toHaveText('Ada Lovelace');
		// Highlighted, and the card beside the text at its height (Notion's margin).
		expect(await background(page, thread)).not.toBe('rgba(0, 0, 0, 0)');
		const [word, editor] = [
			(await mark.boundingBox())!,
			(await page.locator('[data-edytor]').first().boundingBox())!
		];
		// (The card glides into place.)
		await expect.poll(async () => Math.abs((await card.boundingBox())!.y - word.y)).toBeLessThan(8);
		expect((await card.boundingBox())!.x).toBeGreaterThanOrEqual(editor.x + editor.width);
		issues.assertClean();
	});

	test('a click in the text makes its thread active; reply, then Resolve', async ({ page }) => {
		await open(page);
		const { thread, card } = await post(page, 'a', 'brown', 'First');
		// The caret elsewhere: no active thread.
		const elsewhere = await wordBox(page, 'c', 'last');
		await page.mouse.click(elsewhere.x + 2, elsewhere.y + elsewhere.height / 2);
		await expect(card).not.toHaveAttribute('data-active');
		const word = await wordBox(page, 'a', 'brown');
		await page.mouse.click(word.x + word.width / 2, word.y + word.height / 2);
		await expect(card).toHaveAttribute('data-active', 'true');
		const reply = card.locator('[data-edytor-comment-reply]');
		await reply.click();
		await page.keyboard.type('A reply');
		await page.keyboard.press('Enter');
		await expect(card.locator('[data-edytor-comment-body]')).toHaveText(['First', 'A reply']);
		await card.locator('[data-edytor-comment-resolve]').click();
		await expect(card).toHaveCount(0);
		expect(await background(page, thread)).toBe('rgba(0, 0, 0, 0)');
		await expect(page.locator('[data-edytor-comments-toggle]')).toHaveText('Resolved (1)');
	});

	test('another user’s reply arrives live', async ({ page }) => {
		await open(page);
		const { thread, card } = await post(page, 'a', 'fox', 'Mine');
		await page.evaluate(
			(thread) =>
				(
					window as unknown as {
						__COMMENTS__: { bob: { send(request: unknown): Promise<unknown> } };
					}
				).__COMMENTS__.bob.send({ op: 'reply', thread, body: 'From Bob' }),
			thread
		);
		await expect(card.locator('[data-edytor-comment-author]')).toHaveText(['Ada Lovelace', 'Bob']);
		// Bob's comment is not Ada's to delete.
		await expect(card.locator('[data-edytor-comment-delete]')).toHaveCount(1);
		expect(
			await page.evaluate(
				() => (window as unknown as { __COMMENTS__: { heard: unknown[] } }).__COMMENTS__.heard
			)
		).toEqual([
			{ type: 'added', own: true },
			{ type: 'replied', own: false }
		]);
	});

	test('on a narrow screen the active card sits under its text', async ({ page }) => {
		await page.setViewportSize({ width: 480, height: 800 });
		await open(page);
		const field = await startOn(page, 'b', 'second');
		const [word, box] = [
			await wordBox(page, 'b', 'second'),
			(await page.locator('[data-edytor-comment-new]').boundingBox())!
		];
		expect(box.y).toBeGreaterThan(word.y + word.height - 1);
		expect(box.x + box.width).toBeLessThanOrEqual(480);
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-edytor-comment-new]')).toHaveCount(0);
		await expect(field).toHaveCount(0);
	});

	test('the default HTTP client posts the thread to the comments route', async ({ page }) => {
		const posted: unknown[] = [];
		await page.route('**/test-comments-api/doc**', async (route) => {
			const request = route.request();
			expect(new URL(request.url()).searchParams.get('token')).toBe('secret');
			if (request.method() === 'GET') return route.fulfill({ json: { seq: 0, threads: [] } });
			const body = request.postDataJSON() as { thread: string; body: string; quote: string };
			posted.push(body);
			const comment = { id: 'c1', author: 'ada', body: body.body, createdAt: Date.now() };
			const thread = {
				id: body.thread,
				block: 'a',
				quote: body.quote,
				createdBy: 'ada',
				createdAt: comment.createdAt,
				resolved: null,
				comments: [comment],
				rev: 1
			};
			return route.fulfill({
				json: {
					status: 'applied',
					change: { type: 'added', thread, comment, user: 'ada', at: comment.createdAt, seq: 1 }
				}
			});
		});
		await open(page, 'client=http');
		const { card } = await post(page, 'a', 'jumps', 'Over HTTP');
		await expect(card.locator('[data-edytor-comment-body]')).toHaveText('Over HTTP');
		expect(posted).toEqual([
			expect.objectContaining({ op: 'add', body: 'Over HTTP', quote: 'jumps', block: 'a' })
		]);
	});
});
