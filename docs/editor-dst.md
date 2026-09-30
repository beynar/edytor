# Deterministic browser input simulation

Edytor's DST harness explores browser editing state with reproducible generated documents, selections, and trusted keyboard actions. One schedule runs in lockstep through Playwright's Chromium, Firefox, and WebKit engines. After every action, the harness checks each engine locally and compares their semantic results.

This follows the useful core of deterministic simulation testing described by [TigerBeetle's VOPR](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md) and [FoundationDB Simulation](https://apple.github.io/foundationdb/testing.html): production code runs under a deterministic seed, invariants are checked continuously, and a failure carries enough state to replay and minimize it. The harness does not virtualize browser time or browser internals, so it is deterministic at the generated schedule boundary rather than a complete browser simulator.

Playwright is the outer runner because its [projects and browser support](https://playwright.dev/docs/test-projects) cover Chromium, Firefox, and WebKit and its keyboard API goes through browser automation rather than dispatching application-created `InputEvent` objects. Vitest Browser Mode also uses a browser provider, but its [Playwright provider](https://vitest.dev/config/browser/playwright) shares one page across tests in a file and isolates at file scope. Edytor needs independent contexts, lockstep engines, failure attachments, and replay control, which fit Playwright directly.

The harness builds a filtered temporary source snapshot and starts its preview on port 4183. It does not reuse another server or share `.svelte-kit` with a running development process. The snapshot excludes Git metadata, generated output, artifacts, dependencies, and root `.env` files; it symlinks the installed `node_modules`. The temporary directory is deleted when the preview exits.

The browser engines are interoperability proxies. Playwright Chromium is not every released Chrome build, its Firefox is the Playwright-compatible Firefox build, and WebKit is not the shipping Safari application. The harness catches engine-level editing differences locally. Final Safari-product qualification still requires Safari on macOS or a remote real-device service.

The generated state space includes empty and plain text, dense mark boundaries, inline atoms, nested blocks, Unicode graphemes, void neighbours, multiline rich blocks, structural lists (an item with a paragraph child, a list nested in an item, two lists side by side: every ninth seed, and seed 9 in both default lanes), and mixed generated documents. The delete oracle models the container rule: a list's first item lifts out, Delete above a list pulls its first item up, a last item outdents after it, a plain block shed or rescued into a list becomes its item, and a list emptied by a key or a range goes. Selection descriptors cover text ranges, inline or block nodes, one block's contents, ranges rooted at block boundaries, and the whole editor document. A preserve descriptor retains the browser selection from the preceding action. The forced action cycle uses preservation for programs such as type → undo → redo, toggle mark → type, Enter → type, movement → extended movement, and repeated deletion.

Each action uses Playwright's trusted browser input path: typing, direct Unicode text input, backward or forward deletion, paragraph or soft breaks, mark shortcuts, horizontal movement, undo, or redo. Structural ranges are installed through the DOM Range and Selection APIs and then passed through Edytor's real `selectionchange` bridge before the trusted action.

Every step checks:

- block/content normalization, unique identities, valid strings, and live selection bounds;
- serialized block order/type, inline identities, and logical text against the live wrappers, then the live wrappers against the actual marked DOM projection;
- selection presence, selection kind, forward or reversed direction, and model/native endpoint parity, including DOM element-boundary equivalents;
- absence of page and console errors;
- the action-specific trusted event class;
- a semantic effect when insertion, deletion, structural input, range formatting, movement, undo, or redo has a defined effect;
- undo and redo stack availability, depth changes, immediate round-trip values, and cross-engine stack parity;
- full document preservation for navigation and structure/text preservation for formatting;
- semantic and selection agreement across Chromium, Firefox, and WebKit.

The schedule stores selector entropy rather than fixed indexes and offsets. Selectors resolve against the current text, nodes, and blocks before each action, so generated actions remain valid after earlier splits, merges, and deletions. Schema v2 records structural and preserved selections. Schema v3 adds trusted word/vertical navigation, nest/unnest, pointer input, and synthetic composition/clipboard/drop. Schema v4 adds `foreignMutation` steps — deterministic adversarial DOM damage (foreign attribute writes, owned-attribute removal, managed-element removal, identical-value and adopting type-overs, foreign element injection) executed through `page.evaluate` with no input events, so the mutation observer's heal/restore/settle paths run as the system under test. Schema v5 splits `lineDelete` (⌘⌫) from `wordDelete` (⌥⌫): line delete generates only on darwin, has no forward chord, and replays off-platform as `unsupported-action`; upgraded v4 artifacts keep their original chord meaning (darwin `wordDelete` backward replays as the line delete it always was). Failure replay upgrades schema v1–v4 artifacts deterministically, honoring the recorded `environment.platform`.

Deletion **intent** is asserted separately from effect: a `wordDelete`/`lineDelete` chord must deliver a `delete*` beforeinput of the same unit family (`deleteWordBackward` for ⌥⌫, the soft/hard-line family for ⌘⌫), or the step fails `delete-intent-mismatch`. Three narrow carve-outs are legal: non-text selections (the hotkey path dispatches no beforeinput), WebKit's suppressed beforeinput on a provable no-op, and a live non-collapsed selection — every engine degrades ⌥⌫/⌘⌫ over a range to `deleteContent*` (the selection is the unit), so generic content deletion is the correct family there. The same gate runs in the collaboration lane via `collab-runner.ts`.

Foreign-mutation steps carry their own oracle rules: payloads outside an editable island must heal without touching the model; injected text inside a text element and non-identical type-overs may be adopted like browser-owned input; tagged foreign elements must never survive reconciliation; and a `domRepairSignature` (block type attributes, mark projection, foreign residue) is compared across engines so repair divergence is surfaced rather than hidden.

Selection parity is checked in UTF-16 offsets against the live DOM. Because a model offset can legally sit inside a grapheme cluster (between surrogate-pair halves, inside a ZWJ sequence) while the DOM physically snaps such endpoints to a cluster boundary — with the snap direction and timing engine-dependent — a mid-cluster model endpoint is accepted when the native endpoint rests at the raw offset or either edge of the enclosing cluster.

Semantic comparison removes only structural block and inline IDs. IDs stored in block data, inline data, or mark payloads remain significant. Anonymous attribution actor IDs differ between independent engine documents, so the oracle alpha-renames actor IDs only inside `insert`, `delete`, and per-mark `format` attribution lists. It preserves actor reuse and attribution topology. Empty attribution lists and adjacent equivalent text runs are normalized as representation details.

Run the bounded corpus (solo + collaboration specs):

```sh
pnpm test:dst
```

Run a single lane:

```sh
pnpm test:dst:solo      # single-document cross-engine DST
pnpm test:dst:collab    # multi-context collaboration DST
```

Run a wider sweep (expands BOTH lanes — solo seeds/steps and collab seeds/steps/peers):

```sh
pnpm test:dst:extensive
```

Its collaboration half is green. Its solo half has two open, deterministic product failures (2026-09-30, reproduced on the wave-10 commit): seed 17 at step 43, where Firefox leaves a second block element after `insertText` over a reversed cross-block range (`dom-block-count`), and seed 98 at step 12, where ArrowRight collapses a reversed range over mixed Hebrew and Latin text to its end in Chromium and to its visual right edge in Firefox (`cross-browser-selection-divergence`).

Target seeds and schedule length:

```sh
DST_SEEDS=37 pnpm test:dst
DST_SEEDS=1,7,42 DST_STEPS=100 pnpm test:dst
DST_SEEDS=100-500 DST_STEPS=200 pnpm test:dst
```

On failure, the test writes a durable artifact under `.artifacts/editor-dst/` before minimization and attaches it as `dst-failure.json`. It contains the Git commit, dirty flag, SHA-256 content hash, engine versions, original schedule, snapshots immediately before and after the failing action, event evidence, undo/redo depths, and a compact history of every completed step.

The minimizer keeps candidates only when they reproduce the same fingerprint: failure code, engine pair, action kind, selection kind, and normalized mismatch path or subtype. It excludes concrete text, IDs, and offsets so reduction can remove irrelevant setup without drifting to another defect. Minimization has a 40-attempt and 90-second default budget; the artifact records whether it reached a fixed point, the attempt limit, or the time limit. Change the time budget with `DST_SHRINK_BUDGET_MS`.

The collaboration lane (`tests/editor-dst/collab-{generator,runner}.ts`, `editor-collab-dst.spec.ts`) drives 2–3 independent browser **contexts** against a local opaque WebSocket relay: held-delivery windows (requiring ≥2 distinct _authoring_ peers — own-client clock growth, not just scheduled actions), partitions verified on both state-vector and provider-update channels (a delete-only leak moves no insertion clock), reconnects, reloads, and a Node reference document fed only provenance-tagged authored updates. Failure artifacts carry a `failureFingerprint` (code, action/selection shape, acting/failing peer, subtype) the minimizer must preserve — a `delete-result-mismatch` cannot shrink into a timeout or a different defect.

Passive-selection invariants hold across **every** delivery boundary, not just edit steps: selection baselines (dump + provider-update count) are captured before each net op (`hold`/`release`/`latency`/`dropNext`/`disconnect`/`reconnect`/`killRoom`/`healBarrier`), and after the op a peer that had a text selection must still have one (of the same collapsed-ness), a peer that received nothing must not have moved, and a single delivered frame gets exact joint-shape replay. `reload` resets its baseline explicitly — the reloaded peer's pre-reload selection is not compared, but other peers must not move. Multi-frame deliveries check presence/shape invariants; exact position replay is a stated scope limit for chained multi-apply recovery.

Dump inventories are derived independently of the selection's own claims: live text content is enumerated per block's `content` (lengths and liveness), ownership comes from containing-block traversal (`textOwners`), each part's _claimed_ `parent.id` rides separately (`textClaims`) and must equal containment for every live part — selected or not — and per-part mount state (`textMounted`) distinguishes a container's never-rendered phantom slot from editable text. A selected endpoint whose text is dead, owned by a different block, shorter than claimed, or unmounted at a settled barrier fails the step.

```sh
COLLAB_DST_SEEDS=1-8 COLLAB_DST_STEPS=40 COLLAB_DST_PEERS=3 pnpm test:dst:collab
COLLAB_DST_REPLAY=/absolute/path/to/artifact.json pnpm test:dst:collab
```

Pinned rows: each bare schedule in `tests/editor-dst/replays/` (a failure's `minimized.schedule`, kept once its fix landed) replays on every collab run except a `COLLAB_DST_REPLAY` one. The two `collab-seed-18-*` rows pin the dead-endpoint seam: the passive peer's expected caret comes from the dead block's replicated slot (`facade.slotOf`), not the pre-edit tree, so a promoted child that fills the slot and a climb to the parent's content end are both the contract. The collab minimizer's switch is `COLLAB_DST_SHRINK=0`, not `DST_SHRINK`.

Replay an artifact with:

```sh
DST_REPLAY=/absolute/path/to/dst-failure.json pnpm test:dst
```

Set `DST_SHRINK=0` while debugging if the first failing prefix is enough and minimization would be distracting.

## The headless command lane (distinct layer)

`src/tests/fixtures/dom/command-{programs,simulation,canary}.test.tsx` (the
`pnpm test:dom` jsdom lane) sits between the CRDT-primitive harness and this
browser DST: real mounted `Edytor` instances, real `runBeforeInputCommand`
dispatch on model-derived snapshots, deterministic peer delivery through
actual `Y.encodeStateAsUpdate`/`Y.applyUpdate`, and real relative-anchor
selection recovery. Expectations are hand-authored from
`docs/editor-delete-contract.md` — replica agreement is checked but never
counts as the semantic oracle.

Honest limits of that layer (browser-owned, not faked): grapheme-cluster
deletion (native `targetRange` derivation), visual soft-line discovery
(layout), focus/composition/painted carets. A synthetic collapsed delete
is UTF-16 unit semantics. Reversed selections are expressible in jsdom
via `Selection.setBaseAndExtent` and are covered by golden programs.

The CRDT replica harness (`src/tests/crdt/harness/`) additionally records a
deterministic event trace (`PeerSet.trace` — every enqueue, withheld or
applied delivery, partition, heal, persist, reload incarnation, and
transact boundary with its authored-update bytes) and supports a virtual
clock (`vclock.ts` mocks `lib0-v14/time`, so undo `captureTimeout`
coalescing is tested at the deadline without sleeps).
`determinism.test.ts` proves identical event traces and FNV-1a
fingerprints across repeated runs and fresh `vitest run` processes, and
that one injected authored edit changes the fingerprint.

The [Input Events specification](https://w3c.github.io/input-events/) explicitly notes that browsers differ and can be buggy around rich-text editing. Synthetic event fixtures remain useful for otherwise unreachable mobile, IME, and fallback branches. They do not replace this harness: script-created events have `isTrusted=false`, while DST exercises the browser's own input path and records the events it actually emits.
