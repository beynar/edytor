# Cross-Browser Editor Confidence

This note captures the current evidence-backed direction for making Edytor reliable across current Chromium, Firefox, and WebKit browsers.

For execution tracking, use `docs/archive/cross-browser-worklog.md` before starting a
new browser-hardening slice. That file lists completed coverage, do-not-repeat
boundaries, verification already run, and the next queue.

## Sources Checked

- Slate, via DeepWiki: `ianstormtaylor/slate`
- ProseMirror, via DeepWiki: `ProseMirror/prosemirror-view`, `ProseMirror/prosemirror-state`, `ProseMirror/prosemirror-model`
- Lexical, via DeepWiki: `facebook/lexical`
- Svedit, via DeepWiki and public docs: `michael/svedit`, `svedit.dev`

## Patterns To Copy

1. Run browser-owned behavior in real browsers.
   Slate and Lexical rely on Playwright-style E2E coverage across Chromium, Firefox, and WebKit. Model tests are not enough for native selection, composition, clipboard, and contenteditable quirks.

2. Keep the model authoritative, but accept browser input reality.
   ProseMirror and Lexical both treat unexpected DOM/input changes as a real integration surface. ProseMirror uses DOM observation and DOM-change parsing; Lexical reconciles DOM mutations back to editor state.

3. Treat composition as a state machine.
   IME sequences differ by browser. Tests must cover intermediate composition updates, final data delivered on `compositionend`, selection after commit, marked text, inline boundaries, and history behavior.

4. Selection mapping needs both directions.
   Mature editors test DOM selection to model selection and model selection back to DOM selection. Inline/void boundaries, reversed ranges, nested content, element-node anchors, and multi-range Firefox behavior are separate risks.

5. Clipboard needs layered formats.
   Slate, ProseMirror, Lexical, and Svedit all preserve internal editor structure for same-editor copy/paste and use HTML/plain text as external formats. Edytor already follows this direction.

6. Void and island nodes are browser bug magnets.
   ProseMirror and Slate both carry special handling for non-editable nodes, inline leaves, spacer/cursor wrappers, and selection near uneditable content.

7. Structural key fallback must keep the keydown-time selection.
   Slate, Lexical, ProseMirror, and Svedit all route Enter/Backspace/Delete through semantic editor commands when `beforeinput` is absent or unreliable. Native DOM selection may drift before the delayed repair runs, so fallback commands must use the selection observed at the key event, not whatever the browser leaves behind after mutating `contenteditable`.

## Edytor Changes From This Pass

- Playwright now runs browser specs against Chromium, Firefox, and WebKit.
- Composition finalization now treats `compositionend.data` as authoritative when it differs from the last intermediate `insertCompositionText` value.
- Browser composition specs now cover intermediate IME replacement and final data delivered only on `compositionend`.
- Late composition `input` events after `compositionend` now repair browser DOM drift from the model. This matches the Firefox/Lexical-style ordering risk where final composition has already committed but a delayed native input event still mutates the editable DOM.
- Android Chrome Backspace immediately after `compositionend` is now locked by a mobile regression. If Chrome reports non-cancelable `deleteContentBackward` but performs no native deletion, Edytor's fallback deletes the committed character and restores the caret; mobile WebKit does not run this Android-specific fallback.
- Element-node caret positions around non-editable inline blocks now normalize to the correct neighboring text sentinel instead of leaking DOM child offsets into Yjs text offsets.
- IME composition from element-node carets before and after non-editable inline mentions is now covered in Chromium, Firefox, and WebKit, including a compositionend-only commit path.
- `insertReplacementText` now stays native only for single-text replacements. Cross-text and cross-block replacement is handled by Edytor's model command, matching the Svedit/Slate lesson that opaque browser replacement must not own structural selections.
- ShadowRoot selection reads now support `Selection.getComposedRanges()` when `ShadowRoot.getSelection()` is unavailable, matching the ProseMirror/Slate pattern for Safari/WebKit and Firefox shadow-root selection gaps.
- ShadowRoot `beforeinput` now treats `getTargetRanges()` as the event-time selection source when native selection APIs are unavailable or stale. This matches the ProseMirror/Slate/Lexical pattern of syncing model selection from target ranges before controlled insertion.
- ShadowRoot IME composition now preserves final committed text and caret placement when preview text arrives through `beforeinput.getTargetRanges()` and `compositionend.data` changes the committed length.
- Safari-shaped final `beforeinput.insertFromComposition` before a later `compositionend` is now treated as the composition commit boundary. Edytor clears composing state immediately, restores the caret after the committed text, and the later `compositionend` is duplicate-free across Chromium, Firefox, and WebKit.
- Browser fallback specs now cover missing-`beforeinput` text insertion and whole text-wrapper DOM replacement, matching the Slate/Svedit/ProseMirror/Lexical pattern that direct browser DOM mutations must be reconciled back into the model with caret restoration.
- Browser fallback specs now cover direct `characterData` mutation of an existing managed text node without any useful `beforeinput` or `input` event, matching the Lexical/ProseMirror/Svedit DOM-observer and text-diff pattern.
- Browser fallback specs now cover direct `characterData` mutation inside rendered mark wrappers, preserving mark attributes and caret placement without relying on browser formatting behavior.
- Deletion-only `characterData` mutations inside rendered mark wrappers now preserve pending insertion marks when the deleted range had one uniform mark set. This follows the ProseMirror/Svedit/Lexical pattern that formatted ranges should shrink without losing insertion formatting at the deletion boundary.
- Browser-created child-list text-node splits inside rendered mark wrappers are repaired from the model when logical text content is unchanged. This follows ProseMirror/Lexical/Slate/Svedit by treating DOM node boundaries as browser drift, not as editor state.
- WebKit/Safari `span.Apple-converted-space` DOM wrappers are normalized to logical spaces before text reconciliation. This follows ProseMirror's converted-space handling and the broader Slate/Lexical/Svedit rule that browser whitespace wrappers are integration drift, not model truth.
- Chrome-style nested inline mark DOM drift around links is repaired from the model even when logical text content is unchanged. This follows ProseMirror's fix for Chrome flipping `<a>` mark nesting on decorated text and Lexical's policy of undoing unrecognized DOM mutations from authoritative editor state.
- Native `formatRemove` events with `beforeinput.getTargetRanges()` now have coverage across mixed marks and inline atoms. The command uses the event-time target range even when cached selection is stale, removes marks from selected text, preserves inline mentions, and restores the selected model range across Chromium, Firefox, and WebKit.
- Composition events from nested native controls inside void blocks are ignored by Edytor's composition state machine. This mirrors Slate's nested input/textarea guard and keeps native-control IME ownership separate from the editor surface.
- ShadowRoot clipboard specs now cover same-editor internal copy/paste after web-component-style embedding.
- Mobile non-cancelable structural delete now keeps void image boundaries atomic: backspace after an image selects the image instead of merging paragraph text into the caption, and delete at the caption end does not pull the following paragraph into the void block.
- Mobile non-cancelable `insertParagraph` now has an explicit repair path for native DOM drift. The model command remains authoritative, unmanaged browser-created paragraphs are flushed, and the nested parent-with-children Enter behavior keeps the caret in the emptied parent block.
- Mobile non-cancelable `insertLineBreak` now follows the same model-owned repair path. The model inserts exactly one soft break, unmanaged browser-created `<br>` nodes are removed, and final caret placement is restored after the async command finishes.
- Mobile non-cancelable `insertFromPaste` is now locked by a regression test. The model inserts the plain-text clipboard payload once, browser-created duplicate DOM paste drift is discarded by the controlled rerender path, and the caret remains after the inserted content.
- Real Chromium clipboard permissions now have a smoke test for native copy/paste shortcuts. Synthetic `ClipboardEvent` tests remain the source of semantic coverage; the native smoke verifies that browser-provided `clipboardData` reaches Edytor through actual keyboard copy/paste when Playwright can grant reliable clipboard permissions.
- Suppressed input fallback repair is now split by drift type: text drift refreshes from the model and keeps mutation reconciliation suppressed, while structural Enter/soft-break drift allows unmanaged DOM cleanup and restores the model selection after the command completes.
- Firefox native multi-range selections are now normalized to one continuous Edytor model range and the browser selection is collapsed to that same combined range before the next edit. This follows the Slate/ProseMirror policy: Edytor does not expose multiple disjoint model ranges, so native multi-range selection must be reduced to one coherent editable selection instead of letting Firefox type into only one native range.
- Mobile non-cancelable block-boundary Backspace/Delete now has a regression for native DOM merge drift after the model-owned merge command. The command remains authoritative, browser-created duplicate merged text is discarded, and the caret stays at the join boundary.
- Missing-`beforeinput` structural Backspace now falls back from `keydown` to the same model-owned delete command if no real `beforeinput` arrives. The next native `input` and observed mutations are suppressed during that fallback so browser-created block merges cannot be reconciled into duplicate model content.
- Missing-`beforeinput` structural Delete and parent-with-children Enter now have the same browser regression coverage. The keydown fallback restores the keydown-time selection before dispatching the model-owned command, which fixes WebKit drifting the live selection into browser-created DOM before Edytor repairs the model.
- Missing-`beforeinput` Shift+Enter now has desktop browser coverage. The model inserts exactly one soft break, browser-created unmanaged `<br>` drift is cleaned, and the caret lands after the newline in Chromium, Firefox, and WebKit.
- Suppressed DOM mutation batches are now delayed rather than discarded. That keeps browser-created unmanaged structural nodes repairable after the model command runs, while still avoiding text reconciliation from transient native mutations.
- Selected-block Backspace/Delete now stays model-owned when no `beforeinput` arrives and browser DOM drift removes a live survivor block. Deleted Yjs-backed wrappers are no longer restored from mutation repair, selected-block state is cleared before removal, and caret restoration is retried after DOM repair.
- Ranged Backspace/Delete across inline mentions now has desktop missing-`beforeinput` coverage. A native range spanning text, an inline mention, and text deletes through the model, ignores browser-mutated text/inline DOM drift, merges the surrounding text, and restores a collapsed caret in Chromium, Firefox, and WebKit.
- Browser-specific skips and divergent expected values now use explicit quirk IDs through `tests/editor-dom/browserExpectations.ts`, matching the Slate/Lexical/ProseMirror pattern of documenting engine-specific behavior locally instead of hiding it in raw browser-name conditionals.
- Mobile IME composition after `historyUndo` and `historyRedo` is now covered in mobile Chromium and mobile WebKit. The next composition commit uses the restored model caret instead of stale DOM or stale composition state.
- Mobile selected-block Backspace/Delete now stays model-owned for non-cancelable `beforeinput` in mobile Chromium and mobile WebKit, even when the browser removes a live survivor block from the DOM after the model deletion.
- Mobile soft breaks now have Chromium/WebKit coverage after history undo/redo, inside marked text, and at inline mention boundaries. The model inserts exactly one newline, preserves mark context, maps inline-boundary carets to editable text, and removes browser-created `<br>` drift.
- Mobile IME composition now mirrors desktop marked-text and inline-boundary coverage in mobile Chromium and mobile WebKit. Accented composition inside bold text preserves marks, and element-node carets before/after inline mentions normalize to neighboring editable text.
- Programmatic editor root focus now has a browser gate across Chromium, Firefox, and WebKit. After an external element owns focus, direct `edytor.node.focus()` restores the cached model selection before the next input instead of relying on a browser `selectionchange`.
- Structural paragraph-split history now has real browser hotkey coverage. Pressing Enter, undoing, and redoing restores both the split block shape and caret placement across Chromium, Firefox, and WebKit.
- Code island boundaries now have real browser Backspace/Delete coverage. Backspace at the first code line and Delete at the last code line keep the isolated code block from merging with surrounding root paragraphs across Chromium, Firefox, and WebKit.
- Physical Shift+Tab now follows the same model-owned command pattern as Tab. It prevents native focus traversal, unnests nested blocks through `unNestBlock()`, and restores caret or selected-block state on the newly unnested block across Chromium, Firefox, and WebKit.
- Empty-block placeholder selection now has direct browser coverage inspired by Lexical's Chrome empty-block selection workaround. A native range around the empty placeholder/zero-width text is followed by a real pointer click into another block and a typed character; Chromium, Firefox, and WebKit all keep the edit in the clicked block and leave the empty block empty.
- Late `compositionend.data` after external blur now has browser coverage inspired by Svedit's focus-before-commit guard and the composition-state cleanup patterns in Slate, Lexical, and ProseMirror. After Edytor's dangling-composition cleanup runs, a delayed stale IME payload is ignored and the next fresh caret edit still works across Chromium, Firefox, and WebKit.
- Partial inside/outside `beforeinput.getTargetRanges()` values are now rejected before mutating model state. This follows Slate/Lexical's root-containment checks and Svedit's canvas containment guard: a target range with one endpoint inside Edytor and one endpoint in external DOM is prevented, leaves the document unchanged, and preserves the previous valid model selection across Chromium, Firefox, and WebKit.
- Cross-text `deleteContentForward` target ranges at block boundaries now stay model-owned. Edytor rejects the unsafe browser range, prevents the event, and routes Delete through the semantic forward-merge command with the caret restored at the join boundary across Chromium, Firefox, and WebKit.
- Android-style active composition DOM mutation without `beforeinput` now has browser coverage. A composing DOM/input drift commits once, clears composing state, restores the caret, and a later duplicate `compositionend` is ignored across Chromium, Firefox, and WebKit.
- Root-route Shift+Tab now covers a paragraph created by real editing and containing a soft break. Reverse-tab key aliases route through the model-owned unnest command, and Tab/Shift+Tab suppress native DOM drift while the structural command runs.
- Root-route structural hotkeys now repair stale editable-root DOM by remounting
  the contenteditable shell from the live model after the model-owned command.
  This specifically covers the WebKit case where the model has the newly
  unnested root sibling but the visible DOM drops it after native
  contenteditable drift.

## Remaining Cross-Browser Gaps

- Keep extending the `input`/DOM-change fallback for structural non-cancelable or missing `beforeinput` paths beyond Enter, Delete, Backspace, Shift+Enter, selected-block deletion, inline-range deletion, plain paste, block merges, late composition input, and Android post-composition Backspace.
- Add richer Firefox multi-range selection tests if table/cell selection becomes a first-class feature.
- Add real browser clipboard-permission coverage for Firefox/WebKit only when the Playwright/browser permission model is stable enough to avoid false negatives.
