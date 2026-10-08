/**
 * arch-v2 phase 2 P1.2 — deletion and structural keys from the native
 * review's browser probes (`review-probes/browser/delete.probe.ts`),
 * re-targeted at arch-v2's test route. Real keyboard input on every engine.
 *
 * Expected values come from docs/editor-delete-contract.md (`del.unit.*`,
 * `del.caret.one-command`, `del.range.whole-doc`, `del.range.replace`,
 * `del.merge.backward-head`) and plan F-D4, never from running arch-v2.
 */
import { expect, test } from './editorTest';
import { b, caret, domSelection, domTexts, model, open, selection, texts } from './probe-helpers';

/**
 * The word-delete chord is the HOST platform's (the engine maps keys to
 * editing commands by OS, whatever the emulated device's user agent says).
 */
const WORD_BACKSPACE = process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace';

/** Record the input types the engine delivers, so a row cannot pass on the wrong command. */
const recordInputTypes = (page: import('@playwright/test').Page) =>
	page.evaluate(() => {
		const w = window as Window & { __p1InputTypes?: string[] };
		w.__p1InputTypes = [];
		document.addEventListener(
			'beforeinput',
			(e) => w.__p1InputTypes!.push((e as InputEvent).inputType),
			true
		);
	});
const inputTypes = (page: import('@playwright/test').Page) =>
	page.evaluate(() => (window as Window & { __p1InputTypes?: string[] }).__p1InputTypes ?? []);

const ATOM = [
	b('a', ['ab', { atom: 'mention' }, 'cd']),
	b('w', ['foo ', { atom: 'mention' }, 'bar'])
];

test.describe('P1 — word delete over an inline atom (review-probes/delete, del.unit)', () => {
	test('word delete right after an atom deletes the atom as one unit; `foo` survives', async ({
		page
	}) => {
		await open(page, ATOM);
		await caret(page, 'w', 5); // foo ⟨m⟩|bar
		await recordInputTypes(page);
		await page.keyboard.press(WORD_BACKSPACE);
		await expect.poll(async () => (await texts(page))[1]).not.toContain('⟨mention⟩');
		const after = await texts(page);
		expect(['foo bar', 'foobar']).toContain(after[1]);
		expect(after[0]).toBe('ab⟨mention⟩cd');
		expect(await domTexts(page)).toEqual(after);
		expect(await inputTypes(page)).toEqual(['deleteWordBackward']);
	});

	test('word delete at the text end after an atom deletes only the word', async ({ page }) => {
		await open(page, ATOM);
		await caret(page, 'w', 8); // foo ⟨m⟩bar|
		await recordInputTypes(page);
		await page.keyboard.press(WORD_BACKSPACE);
		await expect.poll(() => texts(page)).toEqual(['ab⟨mention⟩cd', 'foo ⟨mention⟩']);
		await expect.poll(() => selection(page)).toMatchObject({ range: 'w@5-w@5', collapsed: true });
		expect(await domTexts(page)).toEqual(['ab⟨mention⟩cd', 'foo ⟨mention⟩']);
		expect((await domSelection(page))?.dom).toBe('w@5->w@5');
		expect(await inputTypes(page)).toEqual(['deleteWordBackward']);
	});
});

/**
 * DIVERGENCE (pinned): the native probe presses select-all once. arch-v2's
 * `mod+a` is a ladder (session/bindings.ts, `hotkeys.spec.ts`,
 * `structural-keys.spec.ts`): the block's text, then the block, then every
 * block — so "select all" is three presses here, and typing over the
 * whole-document block selection places the run in the first slot
 * (`flow.slot`).
 */
test.describe('P1 — select-all then type (review-probes/delete, flow.slot)', () => {
	test('select-all (the ladder) then one character leaves one block holding it, caret after it', async ({
		page
	}) => {
		await open(page, [b('b0', 'first'), b('b1', 'note'), b('b2', 'tail')]);
		await caret(page, 'b1', 2);
		for (let i = 0; i < 3; i++) await page.keyboard.press('ControlOrMeta+a');
		await expect
			.poll(() =>
				page.evaluate(
					() => (window as Window & { __EDYTOR__?: any }).__EDYTOR__.selection.selectedBlocks.size
				)
			)
			.toBe(3);
		await page.keyboard.type('Z');
		await expect.poll(() => texts(page)).toEqual(['Z']);
		expect(await domTexts(page)).toEqual(['Z']);
		const id = (await model(page))[0].id;
		await expect
			.poll(() => selection(page))
			.toMatchObject({ range: `${id}@1-${id}@1`, collapsed: true });
		expect((await domSelection(page))?.dom).toBe(`${id}@1->${id}@1`);
	});
});

const li = (id: string, text: string, children?: unknown[]) =>
	b(id, text, { type: 'list-item', children });
const LIST = [
	b('p', 'para'),
	b('ul', '', {
		type: 'unordered-list',
		children: [li('l1', 'one', [li('l2', 'two')]), li('l3', 'item')]
	})
];

test.describe('P1 — list items (review-probes/delete, F-D4)', () => {
	for (const [where, offset, expected, caretOffset] of [
		['end', 4, ['item', ''], 0],
		['middle', 2, ['it', 'em'], 0],
		['start', 0, ['', 'item'], 0]
	] as const) {
		test(`Enter at the ${where} of a list item creates list items; the caret is in the second`, async ({
			page
		}) => {
			await open(page, LIST);
			await caret(page, 'l3', offset);
			await page.keyboard.press('Enter');
			await expect.poll(async () => (await model(page)).length).toBe(6);
			const rows = await model(page);
			const [first, second] = rows.slice(-2);
			expect([first.text, second.text]).toEqual([...expected]);
			expect([first.type, second.type], 'both halves are list items').toEqual([
				'list-item',
				'list-item'
			]);
			expect([first.depth, second.depth]).toEqual([1, 1]);
			await expect
				.poll(() => selection(page))
				.toMatchObject({
					range: `${second.id}@${caretOffset}-${second.id}@${caretOffset}`,
					collapsed: true
				});
		});
	}

	test('Backspace at the start of a nested list item unnests or merges — never a no-op', async ({
		page
	}) => {
		await open(page, LIST);
		const before = (await model(page)).map((r) => `${r.depth}:${r.id}:${r.type}:${r.text}`);
		expect(before).toEqual([
			'0:p:paragraph:para',
			'0:ul:unordered-list:',
			'1:l1:list-item:one',
			'2:l2:list-item:two',
			'1:l3:list-item:item'
		]);
		await caret(page, 'l2', 0);
		await page.keyboard.press('Backspace');
		await expect
			.poll(async () => (await model(page)).map((r) => `${r.depth}:${r.id}:${r.type}:${r.text}`))
			.not.toEqual(before);
		const after = (await model(page)).map((r) => `${r.depth}:${r.id}:${r.type}:${r.text}`);
		const unnested = after.includes('1:l2:list-item:two');
		const merged =
			after.includes('1:l1:list-item:onetwo') && !after.some((r) => r.includes(':l2:'));
		expect(unnested || merged, after.join(' | ')).toBe(true);
		expect(await domTexts(page)).toEqual((await model(page)).map((r) => r.text));
	});
});
