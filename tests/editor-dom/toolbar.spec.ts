import { expect, test } from './editorTest';
import type { Page } from '@playwright/test';

import {
	expectSelection,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

type SerializedText = {
	text: string;
	marks?: Record<string, unknown>;
};

type SerializedValue = {
	children: Array<{
		type: string;
		content?: SerializedText[];
	}>;
};

const readFirstText = async (page: Page) => {
	const value = await readJsonByTestId<SerializedValue>(page, 'value');
	const text = value.children[0]?.content?.[0];
	if (!text) {
		throw new Error('Expected first text content in serialized value');
	}
	return text;
};

test.describe('browser toolbar and link editing', () => {
	test('formats and edits selected text through the toolbar', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 4);

		await expect(page.getByTestId('selection-toolbar')).toBeVisible();
		await page.getByTestId('toolbar-bold').click();
		await expect.poll(async () => (await readFirstText(page)).marks).toMatchObject({ bold: true });
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 4,
			isCollapsed: false
		});

		await page.getByTestId('toolbar-link-input').fill('https://example.com');
		await page.getByTestId('toolbar-link-apply').click();
		await expect
			.poll(async () => (await readFirstText(page)).marks)
			.toMatchObject({ bold: true, link: { href: 'https://example.com' } });

		await page.getByTestId('toolbar-link-input').fill('https://edited.example');
		await page.getByTestId('toolbar-link-apply').click();
		await expect
			.poll(async () => (await readFirstText(page)).marks)
			.toMatchObject({ bold: true, link: { href: 'https://edited.example' } });

		await page.getByTestId('toolbar-link-remove').click();
		await expect.poll(async () => (await readFirstText(page)).marks).toEqual({ bold: true });
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 4,
			isCollapsed: false
		});

		issues.assertClean();
	});
});
