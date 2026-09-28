/**
 * Contract `del.range.whole-doc` (2026-09-28 follow-up) in real browsers: a
 * text selection over the whole document, deleted, keeps its head block —
 * id and type — emptied, with the caret in it; one undo brings everything
 * back. Across two contexts on one websocket room, both peers deleting the
 * whole document while the room is held converge to that one block (no
 * duplicate empty paragraph). Expected values are the contract's,
 * hand-written.
 */
import { expect, test, type Page } from './editorTest';
import { b, domSelection, mod, model, open, openRoom, selection, setDom } from './p1-helpers';

type EdytorWindow = Window & { __EDYTOR__?: any };

/** The document (not the view's lens): its blocks as written, `[id, text]`. */
const written = (page: Page) =>
	page.evaluate(() =>
		(window as EdytorWindow).__EDYTOR__.document.facade
			.toJSON()
			.children.map((block: { id: string; content?: { text?: string }[] }) => [
				block.id,
				(block.content ?? []).map((c) => c.text ?? '').join('')
			])
	);

/** Select from `first@0` to `last@length` and wait until the value holds it. */
const selectAll = async (
	page: Page,
	first: string,
	last: string,
	length: number,
	reversed = false
) => {
	const [anchor, focus]: [string, number][] = [
		[first, 0],
		[last, length]
	];
	await (reversed ? setDom(page, focus, anchor) : setDom(page, anchor, focus));
	await expect
		.poll(() => selection(page))
		.toMatchObject({ range: `${first}@0-${last}@${length}`, collapsed: false });
};

const caretIn = (page: Page, block: string) =>
	expect.poll(async () => (await domSelection(page))?.dom).toBe(`${block}@0->${block}@0`);

const DOC = [b('h', 'title', { type: 'heading' }), b('p', 'body'), b('z', 'end')];

test.describe('del.range.whole-doc', () => {
	for (const key of ['Backspace', 'Delete'] as const) {
		test(`${key} over the whole document keeps the heading, emptied; one undo restores it all`, async ({
			page
		}) => {
			await open(page, DOC);
			await selectAll(page, 'h', 'z', 3);
			await page.keyboard.press(key);
			await expect.poll(() => written(page)).toEqual([['h', '']]);
			expect(await model(page)).toMatchObject([{ id: 'h', type: 'heading', text: '' }]);
			await caretIn(page, 'h');
			await page.keyboard.press(`${mod}+z`);
			await expect
				.poll(() => written(page))
				.toEqual([
					['h', 'title'],
					['p', 'body'],
					['z', 'end']
				]);
		});
	}

	test('two contexts delete the whole document concurrently: one empty block, the head; typing reaches the other', async ({
		browser,
		baseURL
	}) => {
		const room = await openRoom(browser, baseURL, [
			b('a', 'alpha'),
			b('m', 'mid'),
			b('z', 'omega')
		]);
		try {
			const [one, two] = room.pages as [Page, Page];
			room.relay.hold(room.room);
			await selectAll(one, 'a', 'z', 5);
			await one.keyboard.press('Backspace');
			await selectAll(two, 'a', 'z', 5, true);
			await two.keyboard.press('Delete');
			for (const page of [one, two]) await expect.poll(() => written(page)).toEqual([['a', '']]);
			room.relay.release(room.room);
			// Wait for the exchange: each peer holds the other's writes.
			const clientOf = (page: Page) =>
				page.evaluate(() => (window as EdytorWindow).__EDYTOR__.doc.clientID as number);
			const holds = (page: Page, client: number) =>
				page.evaluate(
					(c) => (window as EdytorWindow).__EDYTOR__.doc.store.clients.has(c) as boolean,
					client
				);
			await expect.poll(async () => holds(one, await clientOf(two))).toBe(true);
			await expect.poll(async () => holds(two, await clientOf(one))).toBe(true);
			// After the exchange each peer still shows exactly one block: the head.
			for (const page of [one, two]) {
				await expect.poll(() => written(page)).toEqual([['a', '']]);
				expect(await model(page)).toMatchObject([{ id: 'a', text: '' }]);
				await caretIn(page, 'a');
			}
			await one.keyboard.type('back');
			for (const page of [one, two])
				await expect.poll(() => written(page)).toEqual([['a', 'back']]);
		} finally {
			await room.close();
		}
	});
});
