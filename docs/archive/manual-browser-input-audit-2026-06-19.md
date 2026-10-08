# Manual Browser Input Audit - 2026-06-19

Target: `http://localhost:5173/`

Method:

- Used the in-app browser against the real demo board.
- Reloaded the page before each scenario.
- Read visible DOM state, block nesting, selection state, inline blocks, marks, and console errors after each interaction.
- Did not patch runtime code during this audit.

Baseline board:

- Root paragraph content: `hello`, mention inline block, `World`, mention inline block, `Prout`.
- The first paragraph owns nested children: `One` -> `Two`.
- A code block follows the paragraph tree.

Important limitation:

- Raw coordinate clicks through the in-app browser did not focus the editor reliably. Those no-op attempts are treated as browser-control limitations, not editor findings.
- Locator-based browser clicks did focus the editor and produced repeatable editor behavior.

## Confirmed Weird Behavior

### 1. Clicking non-first text segments routes typing to the first text

Scenario:

- Reload.
- Click the `World` text segment.
- Type `C`.

Expected:

- `World` becomes `CWorld` or `WorldC`, depending on click offset.

Observed:

- The parent first text became `Chello`.
- `World` stayed unchanged.

Why this matters:

- This is the same class of bug as editing around inline nodes feeling unstable. The visible click target and the model insertion target disagree.

### 2. Clicking nested child text routes typing to the parent first text

Scenario:

- Reload.
- Click nested child `One`.
- Type `N`.

Expected:

- Nested child becomes `NOne` or `OneN`.

Observed:

- Parent first text became `Nhello`.
- Nested child `One` stayed unchanged.

Scenario:

- Reload.
- Click deeply nested child `Two`.
- Type `D`.

Observed:

- Parent first text became `Dhello`.
- Deep child `Two` stayed unchanged.

Why this matters:

- Nested block editing is not trustworthy from the demo surface. The click/selection resolver appears to collapse back to the first editable text.

### 3. Clicking the code line routes typing to the parent paragraph

Scenario:

- Reload.
- Click the code line.
- Type `K`.

Expected:

- Code line changes.

Observed:

- Parent first paragraph became `Khello`.
- Code line stayed unchanged.

Why this matters:

- Plugin/island editing surfaces are not independently focusable from the demo board.

### 4. Enter after clicking nested `One` splits the parent, not the nested child

Scenario:

- Reload.
- Click nested child `One`.
- Press `End`.
- Press `Enter`.

Expected:

- Nested `One` splits, or Enter applies at the nested child caret.

Observed:

- Parent content split at the end of `Prout`.
- A new empty paragraph was created at root level and kept `One` -> `Two` as children.

Why this matters:

- This is consistent with the click target bug: the editor thinks the caret is in the parent content, not in the nested child.

### 5. Undo/redo after text insertion corrupts inline content

Scenario:

- Reload.
- Click first text.
- Type `U`.
- Press `Meta+Z`.
- Press `Meta+Shift+Z`.

Expected:

- Final content returns to the insertion state while preserving inline mentions and surrounding text.

Observed final visible content:

- `Uhello One Two html Copy console.log("hello")`

Lost after redo:

- Both mention inline blocks.
- `World`.
- `Prout`.

Why this matters:

- This is a severe history/DOM refresh bug. Redo restores an incomplete content fragment and drops inline siblings.

### 6. Keyboard range selection did not extend from the caret

Scenario:

- Reload.
- Click first text.
- Press `Home`.
- Press `Shift+ArrowRight` twice.
- Press `Meta+B`.

Expected:

- Two characters selected or marked.

Observed:

- Selection stayed collapsed at `hello` offset `0`.
- Marks and content did not change.

Why this matters:

- Keyboard range creation from the demo surface appears broken or not mapped into the editor selection state.

### 7. Double-click plus mark toggle did not toggle the selected word

Scenario:

- Reload.
- Double-click `hello`.
- Press `Meta+B`.

Expected:

- `hello` toggles bold off, or selection state clearly preserves/toggles the word range.

Observed:

- Selection collapsed at `hello` offset `0`.
- `hello` remained bold.

Why this matters:

- Native word selection is not surviving into the mark hotkey path on this surface.

### 8. `@` mention insertion has suspicious caret aftermath

Scenario:

- Reload.
- Click first text.
- Type `@`.

Expected:

- A mention inline block is inserted at the caret and the caret lands in a predictable trailing text position.

Observed:

- A new mention appears before `hello`.
- A zero-width placeholder appears before it.
- Selection reports collapsed at `hello` offset `0`, not clearly after the inserted mention.

Why this matters:

- The content mutation mostly works, but caret aftermath looks wrong.

## Behavior That Looked Correct Or Mostly Correct

### Enter at end of parent content with children

Scenario:

- Reload.
- Click first text.
- Press `End`.
- Press `Enter`.

Observed:

- Parent content became its own paragraph: `hello [mention] World [mention] Prout`.
- A new empty paragraph appeared below it.
- Nested children `One` -> `Two` moved under the empty paragraph.
- Caret landed in the empty paragraph placeholder.

Assessment:

- This matches the requested Notion-like behavior for adding an empty paragraph before existing nested children.

### Enter at start of first paragraph

Scenario:

- Reload.
- Click first text.
- Press `Home`.
- Press `Enter`.

Observed:

- An empty paragraph was inserted before the original first paragraph.
- Original content and children stayed under the second paragraph.
- Selection reported at `hello` offset `0`, not inside the empty paragraph.

Assessment:

- Structure looks correct.
- Caret aftermath is suspicious and should be verified with a focused browser test.

### Shift+Enter soft break

Scenario:

- Reload.
- Click first text.
- Press `End`.
- Press `Shift+Enter`.

Observed:

- A newline was inserted inside `Prout`.
- No new block was created.
- Inline mentions were preserved.

Assessment:

- Soft break behavior looks correct.

### Backspace at document start

Scenario:

- Reload.
- Click first text.
- Press `Home`.
- Press `Backspace`.

Observed:

- No content changed.
- Caret stayed at the start.

Assessment:

- Correct no-op guard.

### Delete at document start

Scenario:

- Reload.
- Click first text.
- Press `Home`.
- Press `Delete`.

Observed:

- `hello` became `ello`.
- Caret stayed at the start.

Assessment:

- Correct local forward delete.

### Plain text paste at start

Scenario:

- Reload.
- Put `PASTE` in the browser clipboard.
- Click first text.
- Press `Meta+V`.

Observed:

- `PASTE` inserted before `hello`.
- Existing inline mentions and nested children remained.

Assessment:

- Basic plain paste at the first text is working.

### Tab from first paragraph

Scenario:

- Reload.
- Click first text.
- Press `Tab`.

Observed:

- No content or nesting changed.

Assessment:

- Not necessarily a bug unless Tab is intended to nest from a caret. It should be clarified and locked by test.

### Double-space auto-dot

Scenario:

- Reload.
- Click first text.
- Type `aa  `.

Observed:

- Visible text became `aa hello...`.
- Selection text node contained `aa  `.
- No auto-dot appeared.

Assessment:

- This audit did not reproduce the extra-dot/deletion issue. It may require a different caret position or browser-native typing path.

## Highest Priority Fix Targets

1. Fix DOM selection mapping for clicks on later text segments, nested blocks, and plugin/code lines.
2. Fix undo/redo restoration that drops inline blocks and surrounding text after a text insertion.
3. Fix native word/range selection preservation before mark hotkeys.
4. Verify caret aftermath for Enter at start and mention insertion.
5. Add browser regressions for every confirmed failure above before patching runtime.

## Console Errors

No console errors were observed during the successful locator-driven scenarios.
