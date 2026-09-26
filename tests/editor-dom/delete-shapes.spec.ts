import { expect, test, type Page } from './editorTest';

import {
	dispatchBeforeInput,
	expectSelection,
	readJsonByTestId,
	readSelection,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

/**
 * Golden delete-shape pins — every delete surface the DST oracle models,
 * exercised through the real input path and asserted against the EXACT
 * serialized document (`edytor.value`), not just visible text. These are
 * the contract `tests/editor-dst/deleteOracle.ts` encodes: if a shape
 * changes semantics, this spec and the oracle must move together.
 */

type JsonDoc = {
	children: Array<{
		type: string;
		id?: string;
		data?: Record<string, unknown>;
		content?: Array<
			| { text: string; marks?: Record<string, unknown> }
			| { type: string; id?: string; data?: Record<string, unknown> }
		>;
		children?: JsonDoc['children'];
	}>;
};

const gotoDoc = async (page: Page, document: JsonDoc) => {
	const query = new URLSearchParams({ scenario: 'dst', dst: JSON.stringify(document) });
	await page.goto(`/test/dom?${query}`);
	await waitForEditorReady(page, { requireRuntime: true });
};

const readDoc = (page: Page) => readJsonByTestId<JsonDoc>(page, 'value');

/** Serialized children minus ids — shape assertions don't care about id stability. */
const contentOf = async (page: Page, index: number) => {
	const doc = await readDoc(page);
	return doc.children[index]?.content;
};

const textOf = async (page: Page, index: number) => {
	const content = await contentOf(page, index);
	return content?.map((part) => ('text' in part ? part.text : '')).join('') ?? '';
};

test.describe('golden delete shapes — same text', () => {
	test('collapsed backspace removes the grapheme before the caret', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'hello' }] }]
		});
		await setSelectionByTextIndex(page, 0, 3);
		await page.keyboard.press('Backspace');
		await expect.poll(() => textOf(page, 0)).toBe('helo');
		await expectSelection(page, { yStart: 2, yEnd: 2, isCollapsed: true });
		issues.assertClean();
	});

	test('collapsed forward delete removes the grapheme after the caret', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'hello' }] }]
		});
		await setSelectionByTextIndex(page, 0, 1);
		await page.keyboard.press('Delete');
		await expect.poll(() => textOf(page, 0)).toBe('hllo');
		await expectSelection(page, { yStart: 1, yEnd: 1, isCollapsed: true });
		issues.assertClean();
	});

	test('in-text range delete splices exactly the selected span', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'hello' }] }]
		});
		await setSelectionByTextIndex(page, 0, 1, 0, 4);
		await page.keyboard.press('Backspace');
		await expect.poll(() => textOf(page, 0)).toBe('ho');
		issues.assertClean();
	});

	test('range delete inside marked runs keeps the surviving marks', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{
					type: 'paragraph',
					id: 'a',
					content: [
						{ text: 'ab', marks: { bold: true } },
						{ text: 'cd', marks: { italic: true } },
						{ text: 'ef' }
					]
				}
			]
		});
		// Delete 'c' — the italic run's head. Survivors keep their marks.
		await setSelectionByTextIndex(page, 0, 2, 0, 3);
		await page.keyboard.press('Backspace');
		await expect
			.poll(() => contentOf(page, 0))
			.toEqual([
				{ text: 'ab', marks: { bold: true } },
				{ text: 'd', marks: { italic: true } },
				{ text: 'ef' }
			]);
		issues.assertClean();
	});
});

test.describe('golden delete shapes — cross-block', () => {
	test('backspace at a block start merges into the previous block', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{ type: 'paragraph', id: 'a', content: [{ text: 'hello' }] },
				{ type: 'paragraph', id: 'b', content: [{ text: 'world' }] }
			]
		});
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Backspace');
		await expect
			.poll(async () => (await readDoc(page)).children)
			.toEqual([{ type: 'paragraph', id: 'a', data: {}, content: [{ text: 'helloworld' }] }]);
		await expectSelection(page, { yStart: 5, yEnd: 5, isCollapsed: true });
		issues.assertClean();
	});

	test('forward delete at a block end pulls in the next block', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{ type: 'paragraph', id: 'a', content: [{ text: 'hello' }] },
				{ type: 'paragraph', id: 'b', content: [{ text: 'world' }] }
			]
		});
		await setSelectionByTextIndex(page, 0, 5);
		await page.keyboard.press('Delete');
		await expect
			.poll(async () => (await readDoc(page)).children)
			.toEqual([{ type: 'paragraph', id: 'a', data: {}, content: [{ text: 'helloworld' }] }]);
		issues.assertClean();
	});

	test('merge preserves per-side marks at the seam', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{ type: 'paragraph', id: 'a', content: [{ text: 'ab', marks: { bold: true } }] },
				{ type: 'paragraph', id: 'b', content: [{ text: 'cd' }] }
			]
		});
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Backspace');
		await expect
			.poll(() => contentOf(page, 0))
			.toEqual([{ text: 'ab', marks: { bold: true } }, { text: 'cd' }]);
		issues.assertClean();
	});

	test('range delete spanning a whole middle block removes it', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{ type: 'paragraph', id: 'a', content: [{ text: 'aaAA' }] },
				{ type: 'paragraph', id: 'b', content: [{ text: 'bbbb' }] },
				{ type: 'paragraph', id: 'c', content: [{ text: 'CCcc' }] }
			]
		});
		// From inside 'aaAA' (offset 2) into 'CCcc' (offset 2) — b dies whole.
		await setSelectionByTextIndex(page, 0, 2, 2, 2);
		await page.keyboard.press('Backspace');
		await expect
			.poll(async () => (await readDoc(page)).children)
			.toEqual([{ type: 'paragraph', id: 'a', data: {}, content: [{ text: 'aacc' }] }]);
		issues.assertClean();
	});

	test('range delete into a nested child hoists the kept tail', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{
					type: 'ordered-list',
					id: 'list',
					children: [
						{ type: 'list-item', id: 'i0', content: [{ text: 'first' }] },
						{ type: 'list-item', id: 'i1', content: [{ text: 'second' }] }
					]
				},
				{ type: 'paragraph', id: 'p', content: [{ text: 'tail' }] }
			]
		});
		// From inside 'first' into 'tail' — the middle sibling dies, the
		// kept end tail merges into the start block, the list survives.
		await setSelectionByTextIndex(page, 0, 2, 2, 2);
		await page.keyboard.press('Backspace');
		const doc = await readDoc(page);
		expect(doc.children).toEqual([
			{
				type: 'ordered-list',
				id: 'list',
				data: {},
				children: [{ type: 'list-item', id: 'i0', data: {}, content: [{ text: 'fiil' }] }]
			}
		]);
		issues.assertClean();
	});
});

test.describe('golden delete shapes — boundaries', () => {
	test('backspace at a text-part start removes the previous inline atom', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{
					type: 'paragraph',
					id: 'a',
					content: [{ text: 'x' }, { type: 'mention', id: 'm1', data: {} }, { text: 'y' }]
				}
			]
		});
		// Rendered texts: 'x' is index 0, 'y' is index 1 — caret before 'y'.
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Backspace');
		await expect.poll(() => contentOf(page, 0)).toEqual([{ text: 'xy' }]);
		issues.assertClean();
	});

	test('forward delete at a text-part end removes the next inline atom', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{
					type: 'paragraph',
					id: 'a',
					content: [{ text: 'x' }, { type: 'mention', id: 'm1', data: {} }, { text: 'y' }]
				}
			]
		});
		await setSelectionByTextIndex(page, 0, 1);
		await page.keyboard.press('Delete');
		await expect.poll(() => contentOf(page, 0)).toEqual([{ text: 'xy' }]);
		issues.assertClean();
	});

	test('backspace before a void block selects it instead of merging', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{ type: 'paragraph', id: 'a', content: [{ text: 'before' }] },
				{ type: 'divider', id: 'd' },
				{ type: 'paragraph', id: 'b', content: [{ text: 'after' }] }
			]
		});
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Backspace');
		// The divider is selected, nothing is deleted.
		const doc = await readDoc(page);
		expect(doc.children.map((b) => b.type)).toEqual(['paragraph', 'divider', 'paragraph']);
		await expectSelection(page, { selectedBlockPaths: [[1]] });
		issues.assertClean();
	});

	test('backspace at the start of a sole island child selects the island', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{ type: 'paragraph', id: 'a', content: [{ text: 'before' }] },
				{
					type: 'code',
					id: 'island',
					children: [{ type: 'codeLine', id: 'cl', content: [{ text: 'let x' }] }]
				},
				{ type: 'paragraph', id: 'b', content: [{ text: 'after' }] }
			]
		});
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Backspace');
		const doc = await readDoc(page);
		expect(doc.children.map((b) => b.type)).toEqual(['paragraph', 'code', 'paragraph']);
		await expectSelection(page, { selectedBlockPaths: [[1]] });
		issues.assertClean();
	});
});

test.describe('golden delete shapes — word and line', () => {
	test('deleteWordBackward removes the word before the caret', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'hello world' }] }]
		});
		await setSelectionByTextIndex(page, 0, 11);
		const prevented = await dispatchBeforeInput(page, { inputType: 'deleteWordBackward' });
		expect(prevented).toBe(true);
		await expect.poll(() => textOf(page, 0)).toBe('hello ');
		issues.assertClean();
	});

	test('deleteWordForward removes the word after the caret', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'hello world' }] }]
		});
		await setSelectionByTextIndex(page, 0, 0);
		const prevented = await dispatchBeforeInput(page, { inputType: 'deleteWordForward' });
		expect(prevented).toBe(true);
		await expect.poll(() => textOf(page, 0)).toBe(' world');
		issues.assertClean();
	});

	test('deleteSoftLineBackward removes to the soft-line start', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'one\ntwo' }] }]
		});
		// Caret between 'w' and 'o' of 'two' — soft-line delete stops at '\n'.
		await setSelectionByTextIndex(page, 0, 6);
		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteSoftLineBackward',
			targetRange: { startIndex: 0, startOffset: 4, endOffset: 6 }
		});
		expect(prevented).toBe(true);
		await expect.poll(() => textOf(page, 0)).toBe('one\no');
		issues.assertClean();
	});

	test('deleteHardLineBackward removes the whole line across soft breaks', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'one\ntwo' }] }]
		});
		await setSelectionByTextIndex(page, 0, 6);
		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteHardLineBackward',
			targetRange: { startIndex: 0, startOffset: 0, endOffset: 6 }
		});
		expect(prevented).toBe(true);
		await expect.poll(() => textOf(page, 0)).toBe('o');
		issues.assertClean();
	});
});

test.describe('golden delete shapes — edges', () => {
	test('backspace at the very start of the document is a legal no-op', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'hello' }] }]
		});
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press('Backspace');
		await expect.poll(() => textOf(page, 0)).toBe('hello');
		issues.assertClean();
	});

	test('backspace on an empty first block is a legal no-op', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{ type: 'paragraph', id: 'a', content: [{ text: '' }] },
				{ type: 'paragraph', id: 'b', content: [{ text: 'x' }] }
			]
		});
		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press('Backspace');
		const doc = await readDoc(page);
		// Engine contract: the empty first block has no merge target — both
		// blocks survive unchanged.
		expect(doc.children.map((b) => b.id)).toEqual(['a', 'b']);
		issues.assertClean();
	});

	test('backspace on an empty non-first block removes it', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [
				{ type: 'paragraph', id: 'a', content: [{ text: 'x' }] },
				{ type: 'paragraph', id: 'b', content: [{ text: '' }] },
				{ type: 'paragraph', id: 'c', content: [{ text: 'y' }] }
			]
		});
		await setSelectionByTextIndex(page, 1, 0);
		await page.keyboard.press('Backspace');
		const doc = await readDoc(page);
		expect(doc.children).toEqual([
			{ type: 'paragraph', id: 'a', data: {}, content: [{ text: 'x' }] },
			{ type: 'paragraph', id: 'c', data: {}, content: [{ text: 'y' }] }
		]);
		issues.assertClean();
	});

	test('deleteByCut removes the selected span through the cut path', async ({ page }) => {
		const issues = trackPageIssues(page);
		await gotoDoc(page, {
			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'hello world' }] }]
		});
		await setSelectionByTextIndex(page, 0, 0, 0, 6);
		const prevented = await dispatchBeforeInput(page, {
			inputType: 'deleteByCut',
			targetRange: { startIndex: 0, startOffset: 0, endOffset: 6 }
		});
		expect(prevented).toBe(true);
		await expect.poll(() => textOf(page, 0)).toBe('world');
		issues.assertClean();
	});
});
