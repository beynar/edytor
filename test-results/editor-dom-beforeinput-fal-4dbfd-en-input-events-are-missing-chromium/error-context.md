# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: editor-dom/beforeinput-fallback.spec.ts >> browser beforeinput fallback behavior >> reconciles full text wrapper replacement when input events are missing
- Location: tests/editor-dom/beforeinput-fallback.spec.ts:422:2

# Error details

```
Error: expect(received).toMatchObject(expected)

- Expected  - 2
+ Received  + 2

@@ -4,8 +4,8 @@
    ],
    "isCollapsed": true,
    "startBlockPath": Array [
      1,
    ],
-   "yEnd": 9,
-   "yStart": 9,
+   "yEnd": 0,
+   "yStart": 0,
  }

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]: basic
  - textbox [ref=e6]:
    - paragraph [ref=e8]:
      - generic [ref=e9]: lead
    - paragraph [ref=e11]:
      - generic [ref=e12]: corrected
    - paragraph [ref=e14]:
      - button "Write something here ..." [ref=e15]
  - generic [ref=e16]: "{\"type\":\"root\",\"children\":[{\"type\":\"paragraph\",\"id\":\"b_tQOcp6SgQP\",\"data\":{},\"content\":[{\"text\":\"lead\"}]},{\"type\":\"paragraph\",\"id\":\"b_hyPQzUqqLE\",\"data\":{},\"content\":[{\"text\":\"corrected\"}]},{\"type\":\"paragraph\",\"id\":\"b_pCNEuLgsPZ\",\"data\":{}}]}"
  - generic [ref=e17]: "{\"startBlockPath\":[1],\"endBlockPath\":[1],\"startTextPath\":[1,0],\"endTextPath\":[1,0],\"yStart\":0,\"yEnd\":0,\"isCollapsed\":true,\"selectedBlockPaths\":[],\"focusedBlockPaths\":[[1]]}"
```

# Test source

```ts
  117 | 	await expect(page.locator('[data-edytor-block="true"]').first()).toBeVisible();
  118 | 	if (!options.requireRuntime) {
  119 | 		return;
  120 | 	}
  121 | 
  122 | 	await expect
  123 | 		.poll(() =>
  124 | 			page.evaluate(() => {
  125 | 				const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
  126 | 				return Boolean(edytor?.synced && edytor.root);
  127 | 			})
  128 | 		)
  129 | 		.toBe(true);
  130 | };
  131 | 
  132 | export const gotoEditorRoute = async (
  133 | 	page: Page,
  134 | 	path: string,
  135 | 	options: { requireRuntime?: boolean } = {}
  136 | ) => {
  137 | 	const response = await page.request.get(path);
  138 | 	const isOk = response.ok();
  139 | 	const status = response.status();
  140 | 	const statusText = response.statusText();
  141 | 	await response.dispose();
  142 | 
  143 | 	if (!isOk) {
  144 | 		throw new Error(`Failed to load editor route "${path}": ${status} ${statusText}`);
  145 | 	}
  146 | 
  147 | 	await page.goto(path, { waitUntil: 'domcontentloaded' });
  148 | 	await waitForEditorReady(page, options);
  149 | };
  150 | 
  151 | export const getTextLocators = (page: Page) => page.locator('[data-edytor-text="true"]');
  152 | 
  153 | export const getBlockLocators = (page: Page) => page.locator('[data-edytor-block="true"]');
  154 | 
  155 | export const getPlaceholderLocators = (page: Page) =>
  156 | 	page.locator('[data-edytor-text-placeholder]:visible');
  157 | 
  158 | export const readSelection = (page: Page) =>
  159 | 	page.evaluate(() => {
  160 | 		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
  161 | 		if (!edytor) {
  162 | 			return {
  163 | 				startBlockPath: null,
  164 | 				endBlockPath: null,
  165 | 				startTextPath: null,
  166 | 				endTextPath: null,
  167 | 				yStart: 0,
  168 | 				yEnd: 0,
  169 | 				isCollapsed: true,
  170 | 				isReversed: false,
  171 | 				selectedBlockPaths: [],
  172 | 				focusedBlockPaths: []
  173 | 			};
  174 | 		}
  175 | 
  176 | 		const getPartPath = (part: any) => {
  177 | 			const index = part.parent.content.findIndex((candidate: any) => candidate.id === part.id);
  178 | 			return [...part.parent.path, index === -1 ? part.index : index];
  179 | 		};
  180 | 
  181 | 		return {
  182 | 			startBlockPath: edytor.selection.state.startBlock?.path ?? null,
  183 | 			endBlockPath: edytor.selection.state.endBlock?.path ?? null,
  184 | 			startTextPath: edytor.selection.state.startText
  185 | 				? getPartPath(edytor.selection.state.startText)
  186 | 				: null,
  187 | 			endTextPath: edytor.selection.state.endText
  188 | 				? getPartPath(edytor.selection.state.endText)
  189 | 				: null,
  190 | 			yStart: edytor.selection.state.yStart,
  191 | 			yEnd: edytor.selection.state.yEnd,
  192 | 			isCollapsed: edytor.selection.state.isCollapsed,
  193 | 			isReversed: edytor.selection.state.isReversed,
  194 | 			selectedBlockPaths: Array.from(edytor.selection.selectedBlocks).map(
  195 | 				(block: any) => block.path
  196 | 			),
  197 | 			focusedBlockPaths: Array.from(edytor.selection.focusedBlocks).map((block: any) => block.path)
  198 | 		};
  199 | 	});
  200 | 
  201 | export const readSelectedInlineBlockState = (page: Page) =>
  202 | 	page.evaluate(() => {
  203 | 		const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
  204 | 		const selected = Array.from(edytor?.selection.selectedInlineBlock ?? []);
  205 | 		const deletionTarget = edytor?.selection.inlineBlockDeletionTarget ?? null;
  206 | 		return {
  207 | 			selectedCount: selected.length,
  208 | 			deletionTargetType: deletionTarget?.type ?? null
  209 | 		};
  210 | 	});
  211 | 
  212 | export const expectSelection = async (
  213 | 	page: Page,
  214 | 	expected: Record<string, unknown>,
  215 | 	message?: string
  216 | ) => {
> 217 | 	await expect.poll(async () => readSelection(page), { message }).toMatchObject(expected);
      |  ^ Error: expect(received).toMatchObject(expected)
  218 | };
  219 | 
  220 | const setSelectionByTextIndexDirection = async (
  221 | 	page: Page,
  222 | 	startIndex: number,
  223 | 	startOffset: number,
  224 | 	endIndex: number,
  225 | 	endOffset: number,
  226 | 	direction: 'forward' | 'backward'
  227 | ) => {
  228 | 	await page.evaluate(
  229 | 		([fromIndex, fromOffset, toIndex, toOffset, selectionDirection]) => {
  230 | 			const getEditorQueryRoot = () =>
  231 | 				document.querySelector<HTMLElement>('[data-edytor]')?.getRootNode() ??
  232 | 				document.querySelector<HTMLElement>('[data-testid="shadow-editor-host"]')?.shadowRoot ??
  233 | 				document;
  234 | 			const queryRoot = getEditorQueryRoot() as Document | ShadowRoot;
  235 | 			const texts = Array.from(
  236 | 				queryRoot.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')
  237 | 			);
  238 | 			const start = texts[fromIndex];
  239 | 			const end = texts[toIndex];
  240 | 
  241 | 			if (!start || !end) {
  242 | 				throw new Error(`Missing text node at index ${fromIndex} or ${toIndex}`);
  243 | 			}
  244 | 			const resolveLeaf = (node: HTMLElement, offset: number) => {
  245 | 				const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  246 | 				let current = walker.nextNode();
  247 | 				let currentOffset = 0;
  248 | 				while (current) {
  249 | 					const length = current.textContent?.length ?? 0;
  250 | 					const endOffset = currentOffset + length;
  251 | 					if (offset >= currentOffset && offset <= endOffset) {
  252 | 						return {
  253 | 							node: current,
  254 | 							offset: offset - currentOffset
  255 | 						};
  256 | 					}
  257 | 					currentOffset = endOffset;
  258 | 					current = walker.nextNode();
  259 | 				}
  260 | 				return {
  261 | 					node,
  262 | 					offset: Math.min(offset, node.childNodes.length)
  263 | 				};
  264 | 			};
  265 | 
  266 | 			const startLeaf = resolveLeaf(start, fromOffset);
  267 | 			const endLeaf = resolveLeaf(end, toOffset);
  268 | 			const selectionRoot = start.getRootNode();
  269 | 			const shadowSelection =
  270 | 				selectionRoot instanceof ShadowRoot && typeof selectionRoot.getSelection === 'function'
  271 | 					? selectionRoot.getSelection()
  272 | 					: null;
  273 | 			const range = document.createRange();
  274 | 			range.setStart(startLeaf.node, startLeaf.offset);
  275 | 			range.setEnd(endLeaf.node, endLeaf.offset);
  276 | 
  277 | 			let selection =
  278 | 				shadowSelection ?? (selectionRoot instanceof ShadowRoot ? null : window.getSelection());
  279 | 			if (!selection && selectionRoot instanceof ShadowRoot) {
  280 | 				const composedRange =
  281 | 					typeof StaticRange === 'function'
  282 | 						? new StaticRange({
  283 | 								startContainer: startLeaf.node,
  284 | 								startOffset: startLeaf.offset,
  285 | 								endContainer: endLeaf.node,
  286 | 								endOffset: endLeaf.offset
  287 | 							})
  288 | 						: {
  289 | 								startContainer: startLeaf.node,
  290 | 								startOffset: startLeaf.offset,
  291 | 								endContainer: endLeaf.node,
  292 | 								endOffset: endLeaf.offset
  293 | 							};
  294 | 				const fakeSelection = {
  295 | 					anchorNode: null,
  296 | 					anchorOffset: 0,
  297 | 					focusNode: null,
  298 | 					focusOffset: 0,
  299 | 					isCollapsed: range.collapsed,
  300 | 					rangeCount: 0,
  301 | 					addRange: () => {},
  302 | 					getComposedRanges: ({ shadowRoots }: GetComposedRangesOptions = {}) =>
  303 | 						shadowRoots?.includes(selectionRoot) ? [composedRange] : [],
  304 | 					removeAllRanges: () => {},
  305 | 					toString: () => range.toString()
  306 | 				} as unknown as Selection;
  307 | 
  308 | 				Object.defineProperty(window, 'getSelection', {
  309 | 					value: () => fakeSelection,
  310 | 					configurable: true
  311 | 				});
  312 | 				Object.defineProperty(document, 'getSelection', {
  313 | 					value: () => fakeSelection,
  314 | 					configurable: true
  315 | 				});
  316 | 				selection = fakeSelection;
  317 | 			}
```