# Transformation To-Do

This list is the working backlog for the JSX/model-layer transformation suite.
It is intentionally split between:

- `Done`: contracts now directly asserted by tests
- `Next`: model-layer gaps still worth closing
- `Outside JSX`: real editor behavior that cannot be proven by the JSX DSL alone

## Done

- `addInlineBlock`
  - middle, start, end, empty text, marked text, between inline blocks
- `removeInlineBlock`
  - middle, boundaries, only inline block, identical-mark merge, wrong index type, out-of-range no-op
- `pushContentIntoBlock`
  - mixed marked text + inline block append normalization
- `splitBlock`
  - middle, start, end, marks, nested blocks, mentions, whitespace-only, direct path invocation, no-parent no-op
- `mergeBlockBackward`
  - no previous block, empty-first-block forward delegation, marks, inline-leading source, empty target, subtree order
- `mergeBlockForward`
  - no next block, empty current block, subtree preservation, return contract
- `setBlock`
  - type-only, content-only, children-only, data-only, empty content, empty children, mixed inline normalization
- `insertBlockBefore` / `insertBlockAfter`
  - normal insertion, subtree preservation, root no-parent no-op
- `addChildBlock` / `addChildBlocks`
  - empty parent, bulk insert, overflow append, negative clamp
- `removeBlock`
  - root no-op, leaf removal, keep-children flattening, drop-children, inline-content blocks
- `nestBlock` / `unNestBlock`
  - normal nesting, subtree preservation, first-sibling no-op, root-child unnest no-op, sibling order after unnest
- `moveBlock`
  - same-level, nested target, nested-to-root, invalid path, empty path, negative path, self-descendant guard, mark/subtree preservation, caller path immutability
- `deleteContentAtRange` / `deleteContentWithinSelection`
  - same text, mixed text parts, inline-only range, full block content, marks + inline, cross-block merge, boundary-to-boundary, subtree preservation
- plugin-conditioned transforms
  - `void` / `island` nesting guards
  - code-line merge prevention
  - code-line multiline normalization
  - readonly no-op behavior
  - mention-rich structural transforms
- `suggestText` / `acceptSuggestedText`
  - string suggestion contract
  - grouped inline suggestion contract
  - explicit clear/reset contract
  - append + normalize contract for inline-rich suggestions
- inline-block data persistence
  - inline-block `data` survives suggestion acceptance and Yjs-backed reconstruction
- invariant/property pass
  - fixed-seed operation sequences
  - root/content structural invariants

## Next

- selection aftermath depth
  - for destructive transforms, add more direct assertions around returned cursor targets where runtime exposes them

## Outside JSX

- DOM selection mapping and native range anchoring
- `beforeinput` orchestration
- IME / composition behavior
- browser hotkeys and keyboard routing
- attachment hooks and rendered-node behavior
- clipboard / paste / HTML input behavior in the live editor
- drag-and-drop interaction
- collaboration/persistence behavior across Yjs providers

## Exit Rule

The JSX transformation suite is “saturated enough” when every remaining known gap is in `Outside JSX`, not `Next`.
