import { expect, test, type Page } from './editorTest';

import {
	expectSelection,
	getPlaceholderLocators,
	getTextLocators,
	modKey,
	readJsonByTestId,
	setSelectionByTextIndex,
	trackPageIssues,
	waitForEditorReady
} from './helpers';

const replaceManagedTextNodeWithBrowserWrapper = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, value, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const replacement = document.createElement('span');
		replacement.dataset.testBrowserReplacement = 'true';
		replacement.textContent = value;
		text.replaceWith(replacement);

		const leaf = replacement.firstChild ?? replacement;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, Math.min(caretOffset, leaf.textContent?.length ?? 0));
		} else {
			range.setStart(replacement, Math.min(caretOffset, replacement.childNodes.length));
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		replacement.parentElement?.focus();
	}, payload);
};

const insertBrowserWrapperInsideManagedText = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, value, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const wrapper = document.createElement('span');
		wrapper.dataset.testBrowserNestedWrapper = 'true';
		wrapper.textContent = value;
		text.append(wrapper);

		const leaf = wrapper.firstChild ?? wrapper;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, Math.min(caretOffset, leaf.textContent?.length ?? 0));
		} else {
			range.setStart(wrapper, Math.min(caretOffset, wrapper.childNodes.length));
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const insertWebKitConvertedSpaceInsideManagedText = async (
	page: Page,
	payload: {
		textIndex: number;
	}
) => {
	await page.evaluate(({ textIndex }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const convertedSpace = document.createElement('span');
		convertedSpace.className = 'Apple-converted-space';
		convertedSpace.dataset.testConvertedSpace = 'true';
		convertedSpace.textContent = '\u00A0';
		text.append(convertedSpace);

		const leaf = convertedSpace.firstChild ?? convertedSpace;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, leaf.textContent?.length ?? 0);
		} else {
			range.setStart(convertedSpace, convertedSpace.childNodes.length);
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const wrapManagedTextContentWithBrowserWrapper = async (
	page: Page,
	payload: {
		textIndex: number;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const wrapper = document.createElement('span');
		wrapper.dataset.testBrowserNoopWrapper = 'true';
		while (text.firstChild) {
			wrapper.append(text.firstChild);
		}
		text.append(wrapper);

		const leaf = wrapper.firstChild ?? wrapper;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, Math.min(caretOffset, leaf.textContent?.length ?? 0));
		} else {
			range.setStart(wrapper, Math.min(caretOffset, wrapper.childNodes.length));
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const insertBrowserManagedMarkCloneInsideManagedText = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, value, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const mark = document.createElement('span');
		mark.dataset.edytorMark = 'bold';
		mark.dataset.testBrowserManagedMarkClone = 'true';
		const bold = document.createElement('b');
		bold.textContent = value;
		mark.append(bold);
		text.append(mark);

		const leaf = bold.firstChild ?? bold;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, Math.min(caretOffset, leaf.textContent?.length ?? 0));
		} else {
			range.setStart(bold, Math.min(caretOffset, bold.childNodes.length));
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const flipLinkBoldDomNestingInsideManagedText = async (
	page: Page,
	payload: {
		textIndex: number;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const boldMark = text.querySelector<HTMLElement>('[data-edytor-mark="bold"]');
		const linkMark = text.querySelector<HTMLElement>('[data-edytor-mark="link"]');
		if (!linkMark || !boldMark) {
			throw new Error('Missing nested link/bold mark DOM');
		}

		const flippedLink = document.createElement('span');
		flippedLink.dataset.edytorMark = 'link';
		flippedLink.dataset.testBrowserFlippedLinkBold = 'true';
		const anchor = document.createElement('a');
		anchor.href = 'https://example.com/';
		anchor.target = '_blank';
		const flippedBold = document.createElement('span');
		flippedBold.dataset.edytorMark = 'bold';
		const bold = document.createElement('b');
		bold.textContent = 'Link';
		flippedBold.append(bold);
		anchor.append(flippedBold);
		flippedLink.append(anchor);
		boldMark.replaceWith(flippedLink);

		const leaf = bold.firstChild ?? bold;
		const range = document.createRange();
		if (leaf.nodeType === Node.TEXT_NODE) {
			range.setStart(leaf, Math.min(caretOffset, leaf.textContent?.length ?? 0));
		} else {
			range.setStart(bold, Math.min(caretOffset, bold.childNodes.length));
		}
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const readFirstText = async (page: Page) => {
	const value = await readJsonByTestId<{
		children: Array<{ content?: Array<{ text: string }> }>;
	}>(page, 'value');
	return value.children[0]?.content?.[0]?.text;
};

const replaceManagedTextCharacterData = async (
	page: Page,
	payload: {
		textIndex: number;
		value: string;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, value, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const textNodes: Text[] = [];
		const collectTextNodes = (node: Node) => {
			for (const child of node.childNodes) {
				if (child.nodeType === Node.TEXT_NODE && child.textContent !== '\u200B') {
					textNodes.push(child as Text);
					continue;
				}
				collectTextNodes(child);
			}
		};
		collectTextNodes(text);

		const textNode = textNodes.find((node) => node.textContent && node.textContent.length > 0);
		if (!textNode) {
			throw new Error(`Missing text node in managed text at index ${textIndex}`);
		}

		textNode.data = value;
		const range = document.createRange();
		range.setStart(textNode, Math.min(caretOffset, textNode.data.length));
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
	}, payload);
};

const splitManagedTextDomTextNode = async (
	page: Page,
	payload: {
		textIndex: number;
		splitOffset: number;
		caretOffset: number;
	}
) => {
	await page.evaluate(({ textIndex, splitOffset, caretOffset }) => {
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const text = texts[textIndex];
		if (!text) {
			throw new Error(`Missing managed text at index ${textIndex}`);
		}

		const textNodes: Text[] = [];
		const collectTextNodes = (node: Node) => {
			for (const child of node.childNodes) {
				if (child.nodeType === Node.TEXT_NODE && child.textContent !== '\u200B') {
					textNodes.push(child as Text);
					continue;
				}
				collectTextNodes(child);
			}
		};
		collectTextNodes(text);

		const textNode = textNodes.find((node) => node.textContent && node.textContent.length > 0);
		if (!textNode) {
			throw new Error(`Missing text node in managed text at index ${textIndex}`);
		}

		const nextTextNode = textNode.splitText(Math.min(splitOffset, textNode.data.length));
		const range = document.createRange();
		range.setStart(nextTextNode, Math.min(caretOffset, nextTextNode.data.length));
		range.collapse(true);

		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		text.focus();
		document.dispatchEvent(new Event('selectionchange'));
	}, payload);
};

const readFirstMarkTextNodeCount = async (page: Page) =>
	page
		.locator('[data-edytor-mark="bold"]')
		.first()
		.evaluate((mark) => {
			let count = 0;
			const walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT);
			let current = walker.nextNode();
			while (current) {
				if ((current.textContent ?? '').length > 0) {
					count += 1;
				}
				current = walker.nextNode();
			}
			return count;
		});

test.describe('browser DOM mutation reconciliation', () => {
	test('does not restore a mark wrapper removed by undo', async ({ page }) => {
		const issues = trackPageIssues(page);
		const document = {
			children: [
				{
					type: 'paragraph',
					id: 'newline-block',
					content: [{ text: '\n' }]
				}
			]
		};
		const query = new URLSearchParams({
			scenario: 'dst',
			dst: JSON.stringify(document)
		});

		await page.goto(`/test/dom?${query}`);
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 0, 0, 1);
		await page.keyboard.press(`${modKey}+U`);
		await expect(page.locator('[data-edytor-mark="underline"]')).toHaveCount(1);

		await setSelectionByTextIndex(page, 0, 0);
		await page.keyboard.press(`${modKey}+Z`);

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{ text: string; marks?: Record<string, unknown> }>;
					}>;
				}>(page, 'value');
				const domText = await getTextLocators(page)
					.first()
					.evaluate((node) => {
						const clone = node.cloneNode(true) as HTMLElement;
						clone.querySelector('[data-edytor-trailing-newline]')?.remove();
						return clone.textContent ?? '';
					});

				return {
					content: value.children[0]?.content,
					domText,
					underlineCount: await page.locator('[data-edytor-mark="underline"]').count()
				};
			})
			.toEqual({
				content: [{ text: '\n' }],
				domText: '\n',
				underlineCount: 0
			});

		issues.assertClean();
	});

	test('restores a removed wrapper when repeated instances of the mark remain live', async ({
		page
	}) => {
		const issues = trackPageIssues(page);
		const document = {
			children: [
				{
					type: 'paragraph',
					id: 'repeated-mark-block',
					content: [
						{ text: 'A', marks: { bold: true } },
						{ text: '-' },
						{ text: 'B', marks: { bold: true } }
					]
				}
			]
		};
		const query = new URLSearchParams({
			scenario: 'dst',
			dst: JSON.stringify(document)
		});

		await page.goto(`/test/dom?${query}`);
		await waitForEditorReady(page, { requireRuntime: true });
		await expect(page.locator('[data-edytor-mark="bold"]')).toHaveCount(2);

		await page
			.locator('[data-edytor-mark="bold"]')
			.first()
			.evaluate((mark) => mark.remove());

		await expect(page.locator('[data-edytor-mark="bold"]')).toHaveCount(2);
		await expect(getTextLocators(page).first()).toContainText('A-B');

		issues.assertClean();
	});

	test('does not restore stale managed nodes during a Svelte-owned text remount', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page, { requireRuntime: true });

		await page.evaluate(() => {
			const edytor = (
				window as Window & {
					__EDYTOR__?: {
						root?: { children?: Array<{ firstText?: { refreshFromModel: () => void } }> };
					};
				}
			).__EDYTOR__;
			const text = edytor?.root?.children?.[0]?.firstText;
			if (!text) {
				throw new Error('Missing first text');
			}

			text.refreshFromModel();
		});

		await expect(getTextLocators(page)).toHaveCount(2);
		await expect
			.poll(() => page.locator('[data-edytor-type="paragraph"]').first().locator('p').textContent())
			.toBe('Alpha beta');

		issues.assertClean();
	});

	test('keeps live text mapping after mark remount and clear', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page, { requireRuntime: true });
		await setSelectionByTextIndex(page, 0, 0, 0, 5);
		await page.keyboard.press(`${modKey}+B`);

		await page.evaluate(() => {
			const edytor = (window as Window & { __EDYTOR__?: { clear: () => void } }).__EDYTOR__;
			if (!edytor) {
				throw new Error('Missing test editor runtime');
			}
			edytor.clear();
		});

		const texts = getTextLocators(page);
		await expect(texts).toHaveCount(1);
		await getPlaceholderLocators(page).first().click();
		await page.keyboard.type('a');

		await expect(texts.first()).toContainText('a');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles characterData-only browser text mutations without an input event', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await replaceManagedTextCharacterData(page, {
			textIndex: 0,
			value: 'leads',
			caretOffset: 5
		});

		await expect.poll(() => readFirstText(page)).toBe('leads');
		await expect(getTextLocators(page).first()).toHaveText('leads');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('preserves marks during marked characterData-only browser text mutations', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 5);

		await replaceManagedTextCharacterData(page, {
			textIndex: 0,
			value: 'Alphas',
			caretOffset: 6
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{
							text: string;
							marks?: Record<string, unknown>;
						}>;
					}>;
				}>(page, 'value');

				return value.children[0]?.content?.map((part) => ({
					text: part.text,
					marks: part.marks ?? null
				}));
			})
			.toEqual([
				{ text: 'Alphas', marks: { bold: true } },
				{ text: ' beta', marks: null }
			]);

		await expect(page.locator('[data-edytor-mark="bold"]').first()).toHaveText('Alphas');
		await expect(getTextLocators(page).first()).toHaveText('Alphas beta');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('preserves deleted mark context after deletion-only characterData mutations', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 5);

		await replaceManagedTextCharacterData(page, {
			textIndex: 0,
			value: '',
			caretOffset: 0
		});

		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 0,
			yEnd: 0,
			isCollapsed: true
		});

		await page.keyboard.type('Z');

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{
							text: string;
							marks?: Record<string, unknown>;
						}>;
					}>;
				}>(page, 'value');

				return value.children[0]?.content?.map((part) => ({
					text: part.text,
					marks: part.marks ?? null
				}));
			})
			.toEqual([
				{ text: 'Z', marks: { bold: true } },
				{ text: ' beta', marks: null }
			]);

		await expect(page.locator('[data-edytor-mark="bold"]').first()).toHaveText('Z');
		await expect(getTextLocators(page).first()).toHaveText('Z beta');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 1,
			yEnd: 1,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs browser-created text-node splits inside marked DOM', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await splitManagedTextDomTextNode(page, {
			textIndex: 0,
			splitOffset: 2,
			caretOffset: 2
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{
							text: string;
							marks?: Record<string, unknown>;
						}>;
					}>;
				}>(page, 'value');

				return {
					content: value.children[0]?.content?.map((part) => ({
						text: part.text,
						marks: part.marks ?? null
					})),
					markTextNodeCount: await readFirstMarkTextNodeCount(page)
				};
			})
			.toEqual({
				content: [
					{ text: 'Alpha', marks: { bold: true } },
					{ text: ' beta', marks: null }
				],
				markTextNodeCount: 1
			});

		await expect(page.locator('[data-edytor-mark="bold"]').first()).toHaveText('Alpha');
		await expect(getTextLocators(page).first()).toHaveText('Alpha beta');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('repairs browser-flipped nested link and bold mark DOM from the model', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=links');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 0, 0, 4);
		await page.keyboard.press(`${modKey}+B`);
		await setSelectionByTextIndex(page, 0, 4);

		await flipLinkBoldDomNestingInsideManagedText(page, {
			textIndex: 0,
			caretOffset: 4
		});

		await expect
			.poll(async () => {
				const value = await readJsonByTestId<{
					children: Array<{
						content?: Array<{
							text: string;
							marks?: Record<string, unknown>;
						}>;
					}>;
				}>(page, 'value');

				return {
					content: value.children[0]?.content?.map((part) => ({
						text: part.text,
						marks: part.marks ?? null
					})),
					flippedDomCount: await page.locator('[data-test-browser-flipped-link-bold]').count(),
					canonicalLinkText: await page.locator('[data-edytor-mark="link"] a').textContent(),
					boldMarkCount: await page.locator('[data-edytor-mark="bold"]').count(),
					linkMarkCount: await page.locator('[data-edytor-mark="link"]').count()
				};
			})
			.toEqual({
				content: [
					{
						text: 'Link',
						marks: {
							link: { href: 'https://example.com', target: '_blank' },
							bold: true
						}
					},
					{ text: ' tail', marks: null }
				],
				flippedDomCount: 0,
				canonicalLinkText: 'Link',
				boldMarkCount: 1,
				linkMarkCount: 1
			});
		await expect(page.locator('[data-edytor-mark="bold"] [data-edytor-mark="link"] a')).toHaveText(
			'Link'
		);
		await expect(getTextLocators(page).first()).toHaveText('Link tail');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles text when the browser replaces a managed text wrapper', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await replaceManagedTextNodeWithBrowserWrapper(page, {
			textIndex: 0,
			value: 'lead!',
			caretOffset: 5
		});

		await expect.poll(() => readFirstText(page)).toBe('lead!');
		await expect(page.locator('[data-test-browser-replacement]')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles text when the browser inserts an unmanaged wrapper inside managed text', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await insertBrowserWrapperInsideManagedText(page, {
			textIndex: 0,
			value: '!',
			caretOffset: 1
		});

		await expect.poll(() => readFirstText(page)).toBe('lead!');
		await expect(page.locator('[data-test-browser-nested-wrapper]')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('normalizes WebKit converted-space wrappers to logical spaces', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await insertWebKitConvertedSpaceInsideManagedText(page, {
			textIndex: 0
		});

		await expect.poll(() => readFirstText(page)).toBe('lead ');
		await expect(page.locator('[data-test-converted-space]')).toHaveCount(0);
		await expect(getTextLocators(page).first()).toHaveText('lead ');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 5,
			yEnd: 5,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('remounts stale browser-cloned managed mark DOM from the model', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await insertBrowserManagedMarkCloneInsideManagedText(page, {
			textIndex: 0,
			value: 'lead',
			caretOffset: 4
		});

		await expect.poll(() => readFirstText(page)).toBe('lead');
		await expect(page.locator('[data-test-browser-managed-mark-clone]')).toHaveCount(0);
		await expect(getTextLocators(page).first()).toHaveText('lead');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('removes browser wrappers that do not change managed text content', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await wrapManagedTextContentWithBrowserWrapper(page, {
			textIndex: 0,
			caretOffset: 4
		});

		await expect.poll(() => readFirstText(page)).toBe('lead');
		await expect(page.locator('[data-test-browser-noop-wrapper]')).toHaveCount(0);
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('heals foreign attribute writes on a managed text element', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await page.evaluate(() => {
			const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
			if (!text) {
				throw new Error('Missing managed text element');
			}
			text.setAttribute('data-gramm', 'true');
			text.setAttribute('class', 'foreign-class');
			text.style.color = 'rgb(255, 0, 0)';
			text.setAttribute('spellcheck', 'false');
		});

		await expect
			.poll(async () => {
				const text = await getTextLocators(page)
					.first()
					.evaluate((node) => ({
						className: node.getAttribute('class'),
						gramm: node.getAttribute('data-gramm'),
						color: node.style.color,
						spellcheck: node.getAttribute('spellcheck'),
						edytorText: node.getAttribute('data-edytor-text'),
						edytorId: node.getAttribute('data-edytor-id'),
						whiteSpace: node.style.whiteSpace
					}));
				return text;
			})
			.toEqual({
				className: null,
				gramm: null,
				color: '',
				spellcheck: null,
				edytorText: 'true',
				edytorId: expect.any(String),
				whiteSpace: 'break-spaces'
			});

		await expect.poll(() => readFirstText(page)).toBe('lead');
		await expect(getTextLocators(page).first()).toHaveText('lead');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('restores edytor-owned attributes removed from a managed text element', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		// Stash the element before stripping its identifying attributes — the
		// healing is in-place (the bound element keeps its node identity), so
		// the stashed reference stays valid to assert on.
		await page.evaluate(() => {
			const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
			if (!text) {
				throw new Error('Missing managed text element');
			}
			(window as Window & { __STRIPPED_TEXT__?: HTMLElement }).__STRIPPED_TEXT__ = text;
			text.removeAttribute('data-edytor-id');
			text.removeAttribute('data-edytor-text');
			text.removeAttribute('data-edytor-text-empty');
		});

		await expect
			.poll(async () =>
				page.evaluate(() => {
					const element = (window as Window & { __STRIPPED_TEXT__?: HTMLElement })
						.__STRIPPED_TEXT__;
					if (!element) {
						return null;
					}
					return {
						edytorText: element.getAttribute('data-edytor-text'),
						edytorId: element.getAttribute('data-edytor-id'),
						empty: element.getAttribute('data-edytor-text-empty')
					};
				})
			)
			.toEqual({
				edytorText: 'true',
				edytorId: expect.any(String),
				empty: 'false'
			});

		await expect.poll(() => readFirstText(page)).toBe('lead');
		issues.assertClean();
	});

	test('heals foreign overwrites of owned attributes on a managed block element', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await page.evaluate(() => {
			const block = document.querySelector<HTMLElement>('[data-edytor-block="true"]');
			if (!block) {
				throw new Error('Missing managed block element');
			}
			block.setAttribute('data-edytor-type', 'quote');
			block.removeAttribute('data-edytor-block');
		});

		await expect
			.poll(async () =>
				getTextLocators(page)
					.first()
					.evaluate((text) => {
						const block = text.closest<HTMLElement>('[data-edytor-block]');
						return {
							type: block?.getAttribute('data-edytor-type'),
							block: block?.getAttribute('data-edytor-block'),
							id: block?.getAttribute('data-edytor-id')
						};
					})
			)
			.toEqual({ type: 'paragraph', block: 'true', id: expect.any(String) });

		await expect.poll(() => readFirstText(page)).toBe('lead');
		issues.assertClean();
	});

	test('rebuilds mark DOM after a foreign attribute removal on a mark element', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=marks');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 5);

		await page.evaluate(() => {
			const mark = document.querySelector<HTMLElement>('[data-edytor-mark="bold"]');
			if (!mark) {
				throw new Error('Missing managed mark element');
			}
			mark.removeAttribute('data-edytor-mark');
			mark.setAttribute('data-gramm', 'true');
		});

		await expect(page.locator('[data-edytor-mark="bold"]')).toHaveCount(1);
		await expect(page.locator('[data-gramm]')).toHaveCount(0);
		await expect(getTextLocators(page).first()).toHaveText('Alpha beta');
		await expect(page.locator('[data-edytor-mark="bold"]').first()).toHaveText('Alpha');

		issues.assertClean();
	});

	test('reconciles identical-value characterData type-over rewrites', async ({ page }) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		// Mobile keyboards (GBoard, iOS autocorrect) rewrite a text node with
		// the SAME value after a selection replacement. The MutationObserver
		// must still reconcile the text (the write is evidence of input, and
		// the model must not drift when the node lives inside a managed
		// wrapper). The characterData write collapses the DOM caret, so the
		// selection is re-established the way the keyboard does.
		await page.evaluate(() => {
			const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
			const textNode = Array.from(text?.childNodes ?? []).find(
				(node) => node.nodeType === Node.TEXT_NODE
			);
			if (!text || !textNode) {
				throw new Error('Missing managed text node');
			}
			// The identical-value rewrite IS the point: mobile keyboards
			// type-over a node with the same text, producing characterData
			// records with value === oldValue.
			const currentValue = textNode.data;
			textNode.data = currentValue;
			const range = document.createRange();
			range.setStart(textNode, 4);
			range.collapse(true);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		});

		await expect.poll(() => readFirstText(page)).toBe('lead');
		await expect(getTextLocators(page).first()).toHaveText('lead');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 4,
			yEnd: 4,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('reconciles a second browser-owned beforeinput write without an intervening input', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		// macOS autocorrect / Lexical's unprocessedBeforeInputData: the
		// browser fires beforeinput + writes the DOM, but the matching input
		// event never arrives. A second browser-owned beforeinput then
		// replaces browserOwnedInputTarget; the single trailing input event
		// must still reconcile BOTH writes into the model. No synthetic
		// selectionchange is dispatched — real browsers fire it async
		// between tasks; a synchronous in-task dispatch trips the editor's
		// ignore-guards and is not what the platform produces.
		await page.evaluate(() => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]');
			const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
			const textNode = Array.from(text?.childNodes ?? []).find(
				(node) => node.nodeType === Node.TEXT_NODE
			) as Text | undefined;
			if (!editor || !text || !textNode) {
				throw new Error('Missing managed text node');
			}

			const fireBeforeInput = (data: string, offset: number) => {
				const range = document.createRange();
				range.setStart(textNode, offset);
				range.collapse(true);
				const selection = window.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);

				const event = new Event('beforeinput', {
					bubbles: true,
					cancelable: false
				}) as InputEvent;
				Object.defineProperties(event, {
					inputType: { value: 'insertText', configurable: true },
					data: { value: data, configurable: true },
					dataTransfer: { value: null, configurable: true },
					getTargetRanges: {
						value: () => [
							typeof StaticRange === 'function'
								? new StaticRange({
										startContainer: textNode,
										startOffset: offset,
										endContainer: textNode,
										endOffset: offset
									})
								: {
										startContainer: textNode,
										startOffset: offset,
										endContainer: textNode,
										endOffset: offset
									}
						],
						configurable: true
					}
				});
				editor.dispatchEvent(event);
			};

			// Write #1 — browser-owned, no input event follows.
			fireBeforeInput('x', 4);
			textNode.data = `${textNode.data}x`;
			const range1 = document.createRange();
			range1.setStart(textNode, 5);
			range1.collapse(true);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range1);

			// Write #2 — browser-owned, replaces the recorded target.
			fireBeforeInput('y', 5);
			textNode.data = `${textNode.data}y`;
			const range2 = document.createRange();
			range2.setStart(textNode, 6);
			range2.collapse(true);
			selection?.removeAllRanges();
			selection?.addRange(range2);

			// A single input event arrives for the second write only.
			const input =
				typeof InputEvent === 'function'
					? new InputEvent('input', {
							bubbles: true,
							inputType: 'insertText',
							data: 'y'
						})
					: (new Event('input', { bubbles: true }) as InputEvent);
			text.dispatchEvent(input);
		});

		await expect.poll(() => readFirstText(page)).toBe('leadxy');
		await expect(getTextLocators(page).first()).toHaveText('leadxy');
		await expectSelection(page, {
			startBlockPath: [0],
			endBlockPath: [0],
			yStart: 6,
			yEnd: 6,
			isCollapsed: true
		});

		issues.assertClean();
	});

	test('bounds mutation repair when a foreign writer fights the heals', async ({ page }) => {
		const issues = trackPageIssues(page, {
			ignoreConsoleErrors: [/mutation repair|MutationObserver|runaway|bounded/i]
		});

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await page.evaluate(() => {
			const text = document.querySelector<HTMLElement>('[data-edytor-text="true"]');
			if (!text) {
				throw new Error('Missing managed text element');
			}
			const browserWindow = window as Window & { __EDYTOR_FOREIGN_WRITES__?: number };
			browserWindow.__EDYTOR_FOREIGN_WRITES__ = 0;
			// An adversarial extension re-mutates the attribute on every batch —
			// the classic observer ping-pong. The editor's repair must bound
			// itself instead of trading microtasks forever.
			const fighter = new MutationObserver(() => {
				if (!text.isConnected || (browserWindow.__EDYTOR_FOREIGN_WRITES__ ?? 0) >= 500) {
					fighter.disconnect();
					return;
				}
				browserWindow.__EDYTOR_FOREIGN_WRITES__ =
					(browserWindow.__EDYTOR_FOREIGN_WRITES__ ?? 0) + 1;
				text.setAttribute('data-gramm', String(browserWindow.__EDYTOR_FOREIGN_WRITES__));
			});
			fighter.observe(text, { attributes: true });
			text.setAttribute('data-gramm', '0');
		});

		// The page must stay responsive (evaluate returns) and the model must
		// remain intact — whether the last foreign write survived is a heal
		// detail, not corruption.
		await expect.poll(() => readFirstText(page)).toBe('lead');

		await page.evaluate(() => {
			const browserWindow = window as Window & { __EDYTOR_FOREIGN_WRITES__?: number };
			return browserWindow.__EDYTOR_FOREIGN_WRITES__;
		});

		// After the fighter exhausts itself, the editor still edits normally.
		await page.keyboard.type('!');
		await expect.poll(() => readFirstText(page)).toBe('lead!');

		issues.assertClean();
	});

	test('restores the DOM caret after a foreign contenteditable removal blurs the root', async ({
		page
	}) => {
		const issues = trackPageIssues(page);

		await page.goto('/test/dom?scenario=basic&empty=last');
		await waitForEditorReady(page);
		await setSelectionByTextIndex(page, 0, 4);

		await page.evaluate(() => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]');
			if (!editor) {
				throw new Error('Missing editor root');
			}
			editor.removeAttribute('contenteditable');
		});

		// The owned attribute heals back — and on engines whose blur drops
		// the DOM selection in a task AFTER the mutation flush (Chromium),
		// the observer's deferred restore re-applies the model caret once
		// the browser's own clear has run.
		await expect
			.poll(() =>
				page.evaluate(() =>
					document.querySelector<HTMLElement>('[data-edytor]')?.getAttribute('contenteditable')
				)
			)
			.toBe('true');

		// A native range must exist inside the editor and agree with the
		// model caret — a dropped selection that only the model remembers
		// leaves the surface dead to the next browser input.
		await expect
			.poll(() =>
				page.evaluate(() => {
					const editor = document.querySelector<HTMLElement>('[data-edytor]');
					const selection = window.getSelection();
					const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
					if (!editor || !selection || selection.rangeCount === 0 || !edytor) {
						return null;
					}
					const range = selection.getRangeAt(0);
					if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
						return null;
					}
					const text = editor.querySelector<HTMLElement>('[data-edytor-text="true"]');
					if (!text) return null;
					const measure = document.createRange();
					measure.selectNodeContents(text);
					measure.setEnd(range.startContainer, range.startOffset);
					const domOffset = measure.cloneContents().textContent?.length ?? -1;
					return {
						domOffset,
						yStart: edytor.selection.state.yStart,
						isCollapsed: selection.isCollapsed
					};
				})
			)
			.toEqual({
				domOffset: expect.any(Number),
				yStart: expect.any(Number),
				isCollapsed: true
			});

		const caret = await page.evaluate(() => {
			const editor = document.querySelector<HTMLElement>('[data-edytor]');
			const selection = window.getSelection();
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			const range = selection!.getRangeAt(0);
			const text = editor!.querySelector<HTMLElement>('[data-edytor-text="true"]')!;
			const measure = document.createRange();
			measure.selectNodeContents(text);
			measure.setEnd(range.startContainer, range.startOffset);
			return {
				domOffset: measure.cloneContents().textContent?.length ?? -1,
				yStart: edytor.selection.state.yStart
			};
		});
		expect(caret.domOffset).toBe(caret.yStart);

		// The editor is editable again — the next keystroke lands.
		await page.keyboard.type('!');
		await expect.poll(() => readFirstText(page)).toContain('!');

		issues.assertClean();
	});
});
