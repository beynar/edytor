# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: editor-dom/delete-shapes.spec.ts >> golden delete shapes — word and line >> deleteSoftLineBackward removes to the soft-line start
- Location: tests/editor-dom/delete-shapes.spec.ts:319:2

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

- Expected  - 1
+ Received  + 0

- one
  o

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]: dst
  - textbox [ref=e6]:
    - paragraph [ref=e8]:
      - generic [ref=e9]: o
  - generic [ref=e10]: "{\"type\":\"root\",\"children\":[{\"type\":\"paragraph\",\"id\":\"a\",\"data\":{},\"content\":[{\"text\":\"o\"}]}]}"
  - generic [ref=e11]: "{\"startBlockPath\":[0],\"endBlockPath\":[0],\"startTextPath\":[0,0],\"endTextPath\":[0,0],\"yStart\":0,\"yEnd\":0,\"isCollapsed\":true,\"selectedBlockPaths\":[],\"focusedBlockPaths\":[[0]]}"
```

# Test source

```ts
  231 | 		await setSelectionByTextIndex(page, 1, 0);
  232 | 		await page.keyboard.press('Backspace');
  233 | 		await expect.poll(() => contentOf(page, 0)).toEqual([{ text: 'xy' }]);
  234 | 		issues.assertClean();
  235 | 	});
  236 | 
  237 | 	test('forward delete at a text-part end removes the next inline atom', async ({ page }) => {
  238 | 		const issues = trackPageIssues(page);
  239 | 		await gotoDoc(page, {
  240 | 			children: [
  241 | 				{
  242 | 					type: 'paragraph',
  243 | 					id: 'a',
  244 | 					content: [{ text: 'x' }, { type: 'mention', id: 'm1', data: {} }, { text: 'y' }]
  245 | 				}
  246 | 			]
  247 | 		});
  248 | 		await setSelectionByTextIndex(page, 0, 1);
  249 | 		await page.keyboard.press('Delete');
  250 | 		await expect.poll(() => contentOf(page, 0)).toEqual([{ text: 'xy' }]);
  251 | 		issues.assertClean();
  252 | 	});
  253 | 
  254 | 	test('backspace before a void block selects it instead of merging', async ({ page }) => {
  255 | 		const issues = trackPageIssues(page);
  256 | 		await gotoDoc(page, {
  257 | 			children: [
  258 | 				{ type: 'paragraph', id: 'a', content: [{ text: 'before' }] },
  259 | 				{ type: 'divider', id: 'd' },
  260 | 				{ type: 'paragraph', id: 'b', content: [{ text: 'after' }] }
  261 | 			]
  262 | 		});
  263 | 		await setSelectionByTextIndex(page, 1, 0);
  264 | 		await page.keyboard.press('Backspace');
  265 | 		// The divider is selected, nothing is deleted.
  266 | 		const doc = await readDoc(page);
  267 | 		expect(doc.children.map((b) => b.type)).toEqual(['paragraph', 'divider', 'paragraph']);
  268 | 		await expectSelection(page, { selectedBlockPaths: [[1]] });
  269 | 		issues.assertClean();
  270 | 	});
  271 | 
  272 | 	test('backspace at the start of a sole island child selects the island', async ({ page }) => {
  273 | 		const issues = trackPageIssues(page);
  274 | 		await gotoDoc(page, {
  275 | 			children: [
  276 | 				{ type: 'paragraph', id: 'a', content: [{ text: 'before' }] },
  277 | 				{
  278 | 					type: 'code',
  279 | 					id: 'island',
  280 | 					children: [{ type: 'codeLine', id: 'cl', content: [{ text: 'let x' }] }]
  281 | 				},
  282 | 				{ type: 'paragraph', id: 'b', content: [{ text: 'after' }] }
  283 | 			]
  284 | 		});
  285 | 		await setSelectionByTextIndex(page, 1, 0);
  286 | 		await page.keyboard.press('Backspace');
  287 | 		const doc = await readDoc(page);
  288 | 		expect(doc.children.map((b) => b.type)).toEqual(['paragraph', 'code', 'paragraph']);
  289 | 		await expectSelection(page, { selectedBlockPaths: [[1]] });
  290 | 		issues.assertClean();
  291 | 	});
  292 | });
  293 | 
  294 | test.describe('golden delete shapes — word and line', () => {
  295 | 	test('deleteWordBackward removes the word before the caret', async ({ page }) => {
  296 | 		const issues = trackPageIssues(page);
  297 | 		await gotoDoc(page, {
  298 | 			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'hello world' }] }]
  299 | 		});
  300 | 		await setSelectionByTextIndex(page, 0, 11);
  301 | 		const prevented = await dispatchBeforeInput(page, { inputType: 'deleteWordBackward' });
  302 | 		expect(prevented).toBe(true);
  303 | 		await expect.poll(() => textOf(page, 0)).toBe('hello ');
  304 | 		issues.assertClean();
  305 | 	});
  306 | 
  307 | 	test('deleteWordForward removes the word after the caret', async ({ page }) => {
  308 | 		const issues = trackPageIssues(page);
  309 | 		await gotoDoc(page, {
  310 | 			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'hello world' }] }]
  311 | 		});
  312 | 		await setSelectionByTextIndex(page, 0, 0);
  313 | 		const prevented = await dispatchBeforeInput(page, { inputType: 'deleteWordForward' });
  314 | 		expect(prevented).toBe(true);
  315 | 		await expect.poll(() => textOf(page, 0)).toBe(' world');
  316 | 		issues.assertClean();
  317 | 	});
  318 | 
  319 | 	test('deleteSoftLineBackward removes to the soft-line start', async ({ page }) => {
  320 | 		const issues = trackPageIssues(page);
  321 | 		await gotoDoc(page, {
  322 | 			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'one\ntwo' }] }]
  323 | 		});
  324 | 		// Caret between 'w' and 'o' of 'two' — soft-line delete stops at '\n'.
  325 | 		await setSelectionByTextIndex(page, 0, 6);
  326 | 		const prevented = await dispatchBeforeInput(page, {
  327 | 			inputType: 'deleteSoftLineBackward',
  328 | 			targetRange: { startIndex: 0, startOffset: 4, endOffset: 6 }
  329 | 		});
  330 | 		expect(prevented).toBe(true);
> 331 | 		await expect.poll(() => textOf(page, 0)).toBe('one\no');
      |   ^ Error: expect(received).toBe(expected) // Object.is equality
  332 | 		issues.assertClean();
  333 | 	});
  334 | 
  335 | 	test('deleteHardLineBackward removes the whole line across soft breaks', async ({ page }) => {
  336 | 		const issues = trackPageIssues(page);
  337 | 		await gotoDoc(page, {
  338 | 			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'one\ntwo' }] }]
  339 | 		});
  340 | 		await setSelectionByTextIndex(page, 0, 6);
  341 | 		const prevented = await dispatchBeforeInput(page, {
  342 | 			inputType: 'deleteHardLineBackward',
  343 | 			targetRange: { startIndex: 0, startOffset: 0, endOffset: 6 }
  344 | 		});
  345 | 		expect(prevented).toBe(true);
  346 | 		await expect.poll(() => textOf(page, 0)).toBe('o');
  347 | 		issues.assertClean();
  348 | 	});
  349 | });
  350 | 
  351 | test.describe('golden delete shapes — edges', () => {
  352 | 	test('backspace at the very start of the document is a legal no-op', async ({ page }) => {
  353 | 		const issues = trackPageIssues(page);
  354 | 		await gotoDoc(page, {
  355 | 			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'hello' }] }]
  356 | 		});
  357 | 		await setSelectionByTextIndex(page, 0, 0);
  358 | 		await page.keyboard.press('Backspace');
  359 | 		await expect.poll(() => textOf(page, 0)).toBe('hello');
  360 | 		issues.assertClean();
  361 | 	});
  362 | 
  363 | 	test('backspace on an empty first block is a legal no-op', async ({ page }) => {
  364 | 		const issues = trackPageIssues(page);
  365 | 		await gotoDoc(page, {
  366 | 			children: [
  367 | 				{ type: 'paragraph', id: 'a', content: [{ text: '' }] },
  368 | 				{ type: 'paragraph', id: 'b', content: [{ text: 'x' }] }
  369 | 			]
  370 | 		});
  371 | 		await setSelectionByTextIndex(page, 0, 0);
  372 | 		await page.keyboard.press('Backspace');
  373 | 		const doc = await readDoc(page);
  374 | 		// Engine contract: the empty first block has no merge target — both
  375 | 		// blocks survive unchanged.
  376 | 		expect(doc.children.map((b) => b.id)).toEqual(['a', 'b']);
  377 | 		issues.assertClean();
  378 | 	});
  379 | 
  380 | 	test('backspace on an empty non-first block removes it', async ({ page }) => {
  381 | 		const issues = trackPageIssues(page);
  382 | 		await gotoDoc(page, {
  383 | 			children: [
  384 | 				{ type: 'paragraph', id: 'a', content: [{ text: 'x' }] },
  385 | 				{ type: 'paragraph', id: 'b', content: [{ text: '' }] },
  386 | 				{ type: 'paragraph', id: 'c', content: [{ text: 'y' }] }
  387 | 			]
  388 | 		});
  389 | 		await setSelectionByTextIndex(page, 1, 0);
  390 | 		await page.keyboard.press('Backspace');
  391 | 		const doc = await readDoc(page);
  392 | 		expect(doc.children).toEqual([
  393 | 			{ type: 'paragraph', id: 'a', data: {}, content: [{ text: 'x' }] },
  394 | 			{ type: 'paragraph', id: 'c', data: {}, content: [{ text: 'y' }] }
  395 | 		]);
  396 | 		issues.assertClean();
  397 | 	});
  398 | 
  399 | 	test('deleteByCut removes the selected span through the cut path', async ({ page }) => {
  400 | 		const issues = trackPageIssues(page);
  401 | 		await gotoDoc(page, {
  402 | 			children: [{ type: 'paragraph', id: 'a', content: [{ text: 'hello world' }] }]
  403 | 		});
  404 | 		await setSelectionByTextIndex(page, 0, 0, 0, 6);
  405 | 		const prevented = await dispatchBeforeInput(page, {
  406 | 			inputType: 'deleteByCut',
  407 | 			targetRange: { startIndex: 0, startOffset: 0, endOffset: 6 }
  408 | 		});
  409 | 		expect(prevented).toBe(true);
  410 | 		await expect.poll(() => textOf(page, 0)).toBe('world');
  411 | 		issues.assertClean();
  412 | 	});
  413 | });
  414 | 
```