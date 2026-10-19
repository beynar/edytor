import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './editorTest';
import { modKey, waitForEditorReady } from './helpers';

/**
 * Suggestions (AI) in real browsers (site `editor/suggestions`): the preview
 * is shown, inert and non-editable; the default bar and keys accept, discard
 * and retry; a stream leaves the user's typing and caret alone. The jsdom
 * rows are `src/tests/fixtures/dom/suggestions.test.tsx`.
 */

const children = [
	{ id: 'a', type: 'paragraph', content: [{ text: 'Alpha' }] },
	{ id: 'b', type: 'paragraph', content: [{ text: 'Beta' }] },
	{ id: 'c', type: 'paragraph', content: [{ text: 'Gamma' }] }
];

const open = async (page: Page, blocks: unknown[] = children) => {
	await page.goto(
		`/test/dom?scenario=dst&dst=${encodeURIComponent(JSON.stringify({ children: blocks }))}`
	);
	await waitForEditorReady(page, { requireRuntime: true });
	await page.addStyleTag({
		content: readFileSync(new URL('../../src/lib/themes/notion.css', import.meta.url), 'utf8')
	});
	await page.locator('[data-edytor]').evaluate((node) => node.classList.add('edytor-notion'));
};

/** Run `body` in the page with the view (`__EDYTOR__`). */
const inPage = <T, A>(page: Page, body: (edytor: any, arg: A) => T, arg?: A) =>
	page.evaluate(
		([source, value]) => {
			const edytor = (window as unknown as { __EDYTOR__: any }).__EDYTOR__;
			return new Function('edytor', 'arg', `return (${source})(edytor, arg)`)(edytor, value);
		},
		[body.toString(), arg] as const
	) as Promise<T>;

/** The root blocks' texts. */
const texts = (page: Page) =>
	inPage(page, (edytor) =>
		edytor.value.children.map((block: any) =>
			(block.content ?? []).map((part: any) => part.text ?? '@').join('')
		)
	);

const clickText = async (page: Page, id: string, at: 'end' | 'start' = 'end') => {
	const text = page.locator(`[data-edytor-id="${id}"][data-edytor-block] [data-edytor-text]`);
	const box = (await text.boundingBox())!;
	await page.mouse.click(at === 'end' ? box.x + box.width - 1 : box.x + 1, box.y + box.height / 2);
};

test.describe('suggestions', () => {
	test('Ask AI on an empty line: the preview stands in its place; typing there unfolds it', async ({
		page
	}) => {
		await open(page, [children[0], { id: 'e', type: 'paragraph', content: [] }, children[2]]);
		const line = page.locator('[data-edytor-id="e"][data-edytor-block]');
		const before = (await line.boundingBox())!;
		await page.mouse.click(before.x + 4, before.y + before.height / 2);
		await expect
			.poll(() => inPage(page, (edytor) => edytor.selection.textRange().startText?.parent?.id))
			.toBe('e');
		await inPage(page, (edytor) =>
			edytor.suggestions.add({ replace: ['e'] }, [
				{ type: 'paragraph', content: [{ text: 'Drafted' }] }
			])
		);
		const preview = page.locator('[data-edytor-suggestion]');
		await expect(preview).toBeVisible();
		await expect(line).toHaveAttribute('data-edytor-suggestion-replaced', 'empty');
		expect((await line.boundingBox())?.height ?? 0).toBe(0);
		// The preview's text sits about where the empty line was (its tint pads it).
		const drafted = (await preview.getByText('Drafted').boundingBox())!;
		expect(Math.abs(drafted.y - before.y)).toBeLessThan(16);
		// The caret stayed in the folded line: typing there unfolds it, struck through.
		await page.keyboard.type('x');
		await expect(line).toHaveAttribute('data-edytor-suggestion-replaced', '');
		expect((await line.boundingBox())!.height).toBeGreaterThan(10);
		await page.keyboard.press(`${modKey}+Enter`);
		await expect(preview).toHaveCount(0);
		expect(await texts(page)).toEqual(['Alpha', 'Drafted', 'Gamma']);
	});

	test('the preview is visible and non-editable; a click in it places no caret there', async ({
		page
	}) => {
		await open(page);
		await clickText(page, 'b');
		await inPage(page, (edytor) => edytor.suggestions.add({ after: 'a' }, 'Proposed text'));
		const preview = page.locator('[data-edytor-suggestion]');
		await expect(preview).toBeVisible();
		await expect(preview).toHaveAttribute('contenteditable', 'false');
		await expect(preview).toContainText('Proposed text');
		// Following blocks move down: the preview sits between a and b.
		const [a, p, b] = await Promise.all(
			['[data-edytor-id="a"]', '[data-edytor-suggestion]', '[data-edytor-id="b"]'].map(
				async (selector) => (await page.locator(selector).first().boundingBox())!.y
			)
		);
		expect(a).toBeLessThan(p);
		expect(p).toBeLessThan(b);

		await preview.click();
		const inside = await page.evaluate(() => {
			const selection = document.getSelection();
			const preview = document.querySelector('[data-edytor-suggestion]')!;
			return Boolean(selection?.anchorNode && preview.contains(selection.anchorNode));
		});
		expect(inside).toBe(false);
		await page.keyboard.type('x');
		await expect.poll(() => texts(page)).toEqual(['Alpha', 'Betax', 'Gamma']);
		await expect(preview).toContainText('Proposed text');
	});

	test("the bar's Try again, Accept and Discard work", async ({ page }) => {
		await open(page);
		await clickText(page, 'c');
		await inPage(page, (edytor) => {
			(window as any).__retried = 0;
			edytor.suggestions.add({ after: 'a' }, 'First draft', {
				onRetry: (s: any) => {
					(window as any).__retried++;
					s.update('Second draft');
					s.done();
				}
			});
		});
		const bar = page.locator('[data-edytor-suggestion-bar]');
		await expect(bar).toBeVisible();
		await bar.locator('[data-edytor-suggestion-retry]').click();
		await expect(page.locator('[data-edytor-suggestion]')).toContainText('Second draft');
		expect(await page.evaluate(() => (window as any).__retried)).toBe(1);
		await bar.locator('[data-edytor-suggestion-accept]').click();
		await expect.poll(() => texts(page)).toEqual(['Alpha', 'Second draft', 'Beta', 'Gamma']);
		await expect(bar).toHaveCount(0);
		// The caret ends the accepted content: typing goes there.
		await page.keyboard.type('!');
		await expect.poll(() => texts(page)).toEqual(['Alpha', 'Second draft!', 'Beta', 'Gamma']);

		await inPage(page, (edytor) => edytor.suggestions.add({ after: 'b' }, 'Nope'));
		await expect(bar.locator('[data-edytor-suggestion-retry]')).toHaveCount(0);
		await bar.locator('[data-edytor-suggestion-discard]').click();
		await expect(page.locator('[data-edytor-suggestion]')).toHaveCount(0);
		expect(await texts(page)).toEqual(['Alpha', 'Second draft!', 'Beta', 'Gamma']);
	});

	test("a table in the preview lays its cells out as the document's does (`table.*`)", async ({
		page
	}) => {
		await page.goto('/test/dom?scenario=table');
		await waitForEditorReady(page, { requireRuntime: true });
		const cell = (column: string) => ({
			type: 'tableCell',
			data: { column },
			content: [{ text: column }]
		});
		await inPage(page, (edytor, arg) => edytor.suggestions.add({ after: 'Z' }, arg), [
			{
				type: 'table',
				data: { columns: [{ id: 'x1' }, { id: 'x2' }] },
				children: [
					{ type: 'tableRow', children: [cell('x1'), cell('x2')] },
					{ type: 'tableRow', children: [cell('x1'), cell('x2')] }
				]
			}
		]);
		/** Each row's cells' boxes, in the table `root` holds. */
		const rows = (root: string) =>
			page.locator(`${root} [data-edytor-table-row]`).evaluateAll((rows) =>
				rows.map((row) =>
					[...row.querySelectorAll('[data-edytor-table-cell]')].map((cell) => {
						const box = cell.getBoundingClientRect();
						return { top: Math.round(box.top), left: Math.round(box.left) };
					})
				)
			);
		const sideBySide = async (root: string) => {
			const boxes = await rows(root);
			expect(boxes).toHaveLength(2);
			for (const [first, second] of boxes as { top: number; left: number }[][]) {
				expect(second!.top).toBe(first!.top);
				expect(second!.left).toBeGreaterThan(first!.left);
			}
		};
		await sideBySide('[data-edytor-suggestion]');
		await page.locator('[data-edytor-suggestion-bar] [data-edytor-suggestion-accept]').click();
		await expect(page.locator('[data-edytor-suggestion]')).toHaveCount(0);
		await expect(page.locator('[data-edytor-type="table"]')).toHaveCount(2);
		await sideBySide('[data-edytor-type="table"]:not([data-edytor-id="T"])');
	});

	test('Mod+Enter accepts and Escape discards the latest suggestion', async ({ page }) => {
		await open(page);
		await clickText(page, 'b');
		await inPage(page, (edytor) => edytor.suggestions.add({ after: 'b' }, 'By keyboard'));
		await page.keyboard.press(`${modKey}+Enter`);
		await expect.poll(() => texts(page)).toEqual(['Alpha', 'Beta', 'By keyboard', 'Gamma']);
		await inPage(page, (edytor) => edytor.suggestions.add({ after: 'a' }, 'Dismissed'));
		await expect(page.locator('[data-edytor-suggestion]')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.locator('[data-edytor-suggestion]')).toHaveCount(0);
		expect(await texts(page)).toEqual(['Alpha', 'Beta', 'By keyboard', 'Gamma']);
	});

	test('typing elsewhere while it streams leaves the stream alone', async ({ page }) => {
		await open(page);
		await clickText(page, 'c');
		await inPage(page, (edytor) => {
			const s = edytor.suggestions.add({ after: 'a' });
			let n = 0;
			const timer = setInterval(() => {
				s.append(`w${n} `);
				if (++n === 20) {
					clearInterval(timer);
					s.done();
				}
			}, 15);
		});
		await page.keyboard.type('typing', { delay: 25 });
		await expect
			.poll(() => inPage(page, (edytor) => edytor.suggestions.list[0]?.status))
			.toBe('ready');
		const streamed = Array.from({ length: 20 }, (_, n) => `w${n} `).join('');
		await expect(page.locator('[data-edytor-suggestion]')).toHaveText(streamed.trim(), {
			useInnerText: true
		});
		expect(await texts(page)).toEqual(['Alpha', 'Beta', 'Gammatyping']);
	});

	test('30 streamed updates leak no DOM and keep the caret', async ({ page }) => {
		await open(page);
		await clickText(page, 'b', 'start');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await inPage(page, async (edytor) => {
			const s = edytor.suggestions.add({ after: 'a' });
			for (let i = 1; i <= 30; i++) {
				s.update(i % 3 ? `${'word '.repeat(i)}` : `${'word '.repeat(i)}\n\nnext ${i}`);
				await new Promise((resolve) => requestAnimationFrame(resolve));
			}
			s.update('Final answer');
			s.done();
		});
		await expect(page.locator('[data-edytor-suggestion]')).toHaveCount(1);
		await expect(page.locator('[data-edytor-suggestion] [data-edytor-block]')).toHaveCount(1);
		await expect(page.locator('[data-edytor-suggestion]')).toHaveText('Final answer');
		await page.keyboard.type('Z');
		await expect.poll(() => texts(page)).toEqual(['Alpha', 'BeZta', 'Gamma']);
	});
});

test.describe('suggesting mode (sugg.view.runs)', () => {
	/** The pending runs drawn in the text (`insert`, `delete`), with a size. */
	const rects = (page: Page, layer: 'insert' | 'delete') =>
		page
			.locator(`[data-edytor-block] [data-edytor-suggested-run~='${layer}']`)
			.evaluateAll((nodes) =>
				nodes.filter((n) => n.getBoundingClientRect().width > 0).map((n) => n.textContent)
			);

	test('typed text and a Backspace over others’ text are shown as the suggestion’s runs; the value is without them', async ({
		page
	}) => {
		await open(page);
		await clickText(page, 'a');
		await inPage(page, (edytor) => (edytor.suggestions.suggesting = true));
		await page.keyboard.type(' one');
		await expect(page.locator('[data-edytor-id="a"][data-edytor-block]')).toHaveText('Alpha one');
		await expect.poll(async () => (await rects(page, 'insert')).length).toBeGreaterThan(0);
		// Backspace past its own text proposes deleting "a": it stays, struck, and the caret goes before it.
		for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
		await expect(page.locator('[data-edytor-id="a"][data-edytor-block]')).toHaveText('Alpha');
		await expect.poll(async () => (await rects(page, 'delete')).length).toBeGreaterThan(0);
		await page.keyboard.type('!');
		await expect(page.locator('[data-edytor-id="a"][data-edytor-block]')).toHaveText('Alph!a');
		expect(
			await inPage(page, (edytor) =>
				edytor.facade.suggest.changes().map((c: any) => [c.kind, c.text])
			)
		).toEqual([
			['insert', '!'],
			['delete', 'a']
		]);
		// The value is the document without its pending suggestions.
		expect(await texts(page)).toEqual(['Alpha', 'Beta', 'Gamma']);
		// Accepted: the text is the document's, nothing is marked.
		await inPage(page, (edytor) => edytor.suggestions.acceptAll());
		await expect(page.locator('[data-edytor-id="a"][data-edytor-block]')).toHaveText('Alph!');
		expect(await texts(page)).toEqual(['Alph!', 'Beta', 'Gamma']);
		await expect.poll(async () => (await rects(page, 'insert')).length).toBe(0);
		await expect.poll(async () => (await rects(page, 'delete')).length).toBe(0);
	});

	test('a move, and a merge, are refused while the view suggests, and said', async ({ page }) => {
		await open(page);
		await clickText(page, 'b');
		await inPage(page, (edytor) => (edytor.suggestions.suggesting = true));
		// Backspace at a block's start would merge it: refused, and said.
		await page.keyboard.press('Home');
		await page.keyboard.press('Backspace');
		await expect(page.locator('[data-edytor-live]')).toContainText('Only text and blocks');
		expect(await texts(page)).toEqual(['Alpha', 'Beta', 'Gamma']);
		const moved = await inPage(page, (edytor) =>
			edytor.move({ blocks: [edytor.idToBlock.get('b')], direction: 'up' }).map((b: any) => b.id)
		);
		expect(moved).toEqual([]);
		expect(await texts(page)).toEqual(['Alpha', 'Beta', 'Gamma']);
		expect(await inPage(page, (edytor) => edytor.facade.suggest.changes().length)).toBe(0);
	});
});
