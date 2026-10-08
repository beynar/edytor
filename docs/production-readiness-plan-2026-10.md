# Edytor: adversarial review and production plan (2026-10-07)

Reviewed version: `0.1.0-next.31` (HEAD `57fc756`). Out of scope by decision: document-level
HTML/Markdown export and import (review findings F6 and DOC-13 are set aside and appear nowhere
below).

This document has two parts:

1. **The review**: what ten agents found, what survived verification, and how far Edytor is
   from production.
2. **The plan**: every unit of work, with scope, files, acceptance criteria, effort,
   dependencies and the lanes that can run in parallel.

---

## Part 1: The review

### Method

Five reviewers each took one dimension and were told to look for reasons Edytor is not
production ready, citing evidence (file:line, a command, a reproduced failure). Each report then
went to an adversarial verifier. The verifier re-ran the evidence, marked every finding
confirmed, partly, refuted or unverifiable, corrected severities and re-scored. All agents were
read-only. Scores are out of 100, where 85+ means production ready for that dimension.

### Scores

| Dimension                               | Reviewer | Verified | Verdict                                                                                                             |
| --------------------------------------- | -------: | -------: | ------------------------------------------------------------------------------------------------------------------- |
| Features                                |       52 |   **54** | Collaboration and server are ahead of most open-source editors. Content features are thin for a Notion-like product |
| Bugs, robustness, security, performance |       60 |   **58** | Strong engine and tests, with one confirmed stored XSS and room memory limits that do not hold                      |
| Code cleanliness and maintainability    |       52 |   **55** | Clean line by line but not team-scalable: giant closures, a view-side import cycle, ticket ids, no CI tests         |
| Documentation                           |       72 |   **68** | Large and mostly accurate, but stale install facts, no license and no API reference                                 |
| API simplicity                          |       54 |   **56** | Hello-world is simpler than Tiptap, but the public surface is very large and internals leak                         |
| **Overall**                             |          | **≈ 58** | **Not production ready yet**                                                                                        |

Verification outcome: of 65 findings, **none was refuted outright**. Two were partly wrong:
the claim that "GitHub master holds 0.0.11" was false (only a docs sentence says it), and the
fork already supports `keepReplaced` per document. Severities moved both ways:

- Raised: the missing license, to blocker.
- Lowered: tables, from blocker to major; CI, from blocker to major; AGENTS.md density, the
  timing asserts and ticket ids, from major to minor.

### What is already strong

- **Collaboration and server.** It ships a Durable Object room with:
  - authorization, read-only sockets, quotas, a validate hook and compaction;
  - store-before-ack saved state, chunked frames, hibernation, metrics and logs;
  - version history (two slots a day, restore, undo restore) and a 30-day purge;
  - cross-document moves and per-block locks.

  Offline-first IndexedDB, prefetch, cross-tab sync and throttled presence are also included.
  Few open-source editors ship this.

- **Editing engine.** CRDT operations are flat with document size: a keystroke takes 0.02 to
  0.04 ms, and a split about 0.14 ms, from 1k to 20k blocks. Moves, splits and merges keep
  identity under concurrency. Read-time layout and promotion rules mean every replica and the
  room display the same thing.
- **Notion-grade chrome.** Slash menu, + menu, block menu, toolbar, lazy handles with nested
  drag and drop, columns, markdown shortcuts, a custom drag preview, and IME and mobile drift
  handling.
- **Verification culture.**
  - 470 test files, about 221k LOC of tests and 4,159 unit tests.
  - Fuzz corpora with named invariants, and index self-checks after every fold.
  - Oracles independent of production code.
  - Real-browser lanes in Chromium, Firefox and WebKit, plus mobile and CDP IME.
- **Architecture enforced by tooling.** The Worker-safety lint and bundle check, the host-writer
  lint rule, and a timer census. The single-owner claims the reviewers checked hold: one
  MutationObserver, and one DOM-selection writer plus its named exceptions.
- **Code hygiene.** Almost no duplication or dead code, strict TypeScript, and only 23 `any`.
- **Docs.** Accurate imports (all 99 names exist), 68 type-checked fences, a candid
  limitations page, and a complete `<Edytor>` props table.

### Confirmed findings (verified severity)

#### Blockers

| ID     | Finding                                                                                                                                                                                                     | Evidence                                                                                                                                                     | Fix effort |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| R1     | **Stored XSS in links**: `sanitizeLinkHref` lets `'\u0001javascript:…'` through. It strips only `\t\n\r` and `.trim()`, so the input looks scheme-less, and browsers drop C0 controls and run `javascript:` | `plugins/richtext/richTextOperations.ts:57-71`; reproduced in node and in a readonly jsdom view; the same function guards render, HTML paste and the toolbar | 2 h        |
| DOC-05 | **No license**: no LICENSE file and no `license` field, while the README shows an MIT badge; `npm view edytor@next license` is empty                                                                        | repo root, `package.json`                                                                                                                                    | 10 min     |

#### Major

**Security and robustness (room)**

- **R2: the room's memory sits far below its quota.** Heap is about 33× the encoded size: 2k
  short blocks take 22 MB and 10k take 109 MB. The default `maxDocumentBytes` is 64 MiB and the
  isolate has 128 MB, so a document of about 10k blocks crash-loops the room
  (`cloudflare/DocumentRoom.ts:180`).
- **R3: presence is unbounded.** `messageAwareness` and `messageQueryAwareness` skip the rate
  bucket (`allow()` is called only in `onSync`) and have no size cap. The room fans every entry
  out to every socket, and read-only sockets may send presence (`DocumentRoom.ts:3798-3804`,
  `4324-4398`).
- **R4: chunk buffering can pin memory.** The per-socket chunk reader buffers about twice
  `maxInboundFrameBytes` (64 MiB) before any read-only or rate check. One viewer can run the
  room out of memory (`DocumentRoom.ts:3826-3848`, `crdt/providers/room.ts:130-163`).
- **R5: no revocation.** A live socket keeps its access after permissions change or its token
  expires. There is no `closeUser`/`setAccess` (`cloudflare/routeDocumentSocket.ts:86-112`).

**Code and process**

- **CC-01: no tests in CI.** `.github/workflows/publish.yml` runs lint, check and check:worker
  on a tag only. No push or PR runs a test.
- **CC-02: giant closures.**
  - `bindEdytorDoc` is about 2,800 lines (`crdt/edytor-doc.ts:738-3541`).
  - `bindRuns` is about 2,400 (`crdt/text/runs.ts:421-2818`).
  - `AttachedDocument` is about 3,070 (`cloudflare/DocumentRoom.ts:1325-4399`).
  - `EdytorSelection` is 1,337 lines and `Edytor` 872.
- **CC-03: the view contexts form one import cycle.** It spans 33 to 35 files across session,
  surface, events, selection, block, text, clipboard and collaboration, and session calls the
  surface (`session/composition.svelte.ts:63,381,585`, `session/bindings.ts:12`). Only the CRDT
  boundary is lint-enforced.
- **CC-06: the Yjs fork changes engine semantics.** It carries semantic patches (P11 to P14)
  over an upstream release candidate, sets a class-wide `Y.Doc.keepReplaced`, and reaches engine
  privates through 85 `as unknown as` and 52 `as never` casts.

**API**

- **API-01: the root entry exports 268 names**, among them wire codecs, decoders, generation
  records and raw provider classes (`export * from './crdt/index.js'`, `src/lib/index.ts:58`).
- **API-02: internals are public.** `Edytor` has 82 public members and `EdytorSelection` 60,
  including IME, focus and gesture plumbing. There are no `@internal` tags and no
  `stripInternal`.
- **API-03: triggers need internals.** Trigger and input-rule plugins must use
  `dispatcher.lead`, `facade.prepare`, `segStart` and `yStart`, two coordinate systems (the
  emoji example in `plugins/operations.mdx:140-162`).
- **API-04: a readonly view never connects to its room**, even after it becomes editable
  (`components/Edytor.svelte:242`).
- **API-05: block roles must be declared twice**, once in the plugin and once in the room
  semantics. There is no merge helper, and the obvious spread drops the bundled rules.

**Features**

- **F1: no table block.** Pasted HTML tables are flattened to one paragraph per cell.
- **F2: no media beyond images.** No video, audio, file, bookmark, embed or equation; the HTML
  import drops iframe, video, audio and math.
- **F3: the image block is half-done.** It always renders `alt=""`, has no resize or alignment,
  and does nothing with pasted or dropped files even when `upload` is set; a bare `<img>` is
  dropped on paste.
- **F4: no inline atom ships.** The mention plugin is a debug placeholder, unexported but listed
  in the demo route, and there is no trigger framework (the `/` trigger is hard-coded).
- **F5: no comments.** Only a `comment:<id>` mark recipe exists.
- **F7: accessibility.**
  - The textbox cannot get an accessible name: `aria-*` props are swallowed into snippets.
  - Menus have no `aria-activedescendant`, `aria-controls` or `aria-expanded` anywhere.
  - Handles are labelled with raw kind ids.
- **F8: no i18n.** Every chrome string is hard-coded English, and `richTextPlugin` has no
  factory.

**Docs**

- **DOC-01: install facts contradict each other.** The landing and installation pages say "not
  on npm yet" and point to a tarball that is not given, while npm `next` is `0.1.0-next.31`.
- **DOC-02: the README promises markdown shortcuts with `<Edytor />` alone**, but they need
  `markdownShortcutsPlugin`. It also says to add block handles, which come by default.
- **DOC-04: no generated API reference.** About 54 internal members are reachable but
  undocumented.

#### Minor (grouped)

- **Security:**
  - R6: attribution profiles (`u/`) and client bindings (`c/`) are written by clients and never
    checked against the authenticated user, and presence names can be spoofed.
  - R7: the docs recommend cookie auth with no Origin or CSRF guidance; the routers have no
    `allowedOrigins`.
- **Performance:**
  - R8: whole-array data assignment is O(n·m) (an LCS table): 6k items take 2.1 s and 163 MB.
  - R10: no virtualization, and `content-visibility` is opt-in only.
- **API:**
  - API-06: a headless `createDocument` checks no roles, while the room defaults to
    `defaultSemantics`.
  - API-07: `prevent()` throws an unexported `PreventionError`, so a `try/catch` in a hook
    swallows it.
  - API-08: the `onAfterOperation` payload type does not narrow (a non-distributive `Omit`).
  - API-09: four undo paths, and `edytor.history.undo()` bypasses the readonly admission. Two
    write paths, two block JSON shapes, three result channels.
  - API-10: `npm i edytor` installs 0.0.11 (`latest`).
  - API-11: two different `attachDocument` and two `moveBlocks`.
  - API-12: non-reactive handles and three reactivity models; `onChange` serializes the whole
    document on every commit.
  - API-13: naming (`hotKeys` vs `hotkeys`, `doc` used five ways, `value`/`onChange` types,
    deprecated aliases).
  - API-14: snippet overrides are untyped, so a typo registers a phantom kind.
  - API-15: ticket codes and typos in public JSDoc.
- **Features:**
  - F9: code highlights JSX only.
  - F10: no block colours, toggle headings, page block or table of contents.
  - F11: no Mod+K, no autolink, no way to open a link while editing.
  - F12: suggestions are single-view and ephemeral, and version history has no UI.
  - F13: no find and replace.
  - F14: no per-block `dir=auto`.
  - F15: no keyboard column resize, and no native text drag-move.
- **Code:**
  - CC-04: about 500 to 630 ticket ids in comments, and the P-number namespaces collide between
    AGENTS.md and UPSTREAM.md.
  - CC-05/R9: wall-clock asserts in the gate lanes.
  - CC-07: AGENTS.md is 103 KB, with one 11,202-character line.
  - CC-08: compatibility layers kept before 1.0.
  - CC-09: lint disables most hygiene rules and is not type-aware.
  - CC-10: unused devDependencies and stale UPSTREAM.md rows.
  - CC-11: bus factor of one (479 commits in five weeks, nearly all AI co-authored).
- **Docs:**
  - DOC-03: the getting-started examples use the editable SSR path the SvelteKit page calls
    untested.
  - DOC-06: "GitHub master holds 0.0.11".
  - DOC-07: the room has five alarm tasks, but the history page lists four.
  - DOC-08: limitations says history is "in your KV namespace".
  - DOC-09: spec-like walls of text, 49 lines over 1,000 characters.
  - DOC-10: the migration page is full of internal ids.
  - DOC-11: no browser-support matrix.
  - DOC-12: no localization story.
  - DOC-14: some unchecked fences do not compile.

### How far from production

"Production ready" has three different targets. Each one includes the previous.

| Target                                           | What it means                                                               | What stands in the way                                                                                                                                        | Effort                                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **P0: safe to ship at all**                      | No known vulnerability, legally usable, install docs true                   | R1, DOC-05, DOC-01/02/06, API-10                                                                                                                              | **1 day**                                                                                   |
| **P1: production collaborative-editing library** | Teams build their own product on the engine, chrome and room                | Room hardening (R2 to R5, R6, R7), CI (CC-01, CC-05), public API curation (API-01 to API-09), readonly sync, accessibility basics, API reference, a soak test | **3 to 4 weeks** of focused work, about 2 weeks of calendar time with 3 to 4 parallel lanes |
| **P2: Notion-like product parity**               | A team can ship a Notion-like editor without building core content features | Tables, media and embeds, image completion, trigger framework with mentions, comments, i18n, code languages, link UX, history UI                              | **2 to 3 more months** of effort, about 5 to 6 weeks of calendar time with 4 lanes          |
| **P3: maintainable by a team**                   | People who did not write it can change it safely                            | Split the giant closures, break the import cycle, replace ticket ids, restructure AGENTS.md, fork hygiene, prune compatibility layers                         | **3 to 4 weeks**, partly in parallel with P2                                                |

Bottom line: **about 1 day to P0, 2 weeks of calendar time to P1, and 2 to 3 months to a
1.0 that covers P2 and P3.** The limitations page itself notes there is no production track
record yet. Only a soak test (WU-16) and real users remove that.

---

## Part 2: The plan

### Conventions

- **WU-nn** is one unit of work: one owner, one PR or one release `next.N`.
- **Effort** is in engineer-days (d) of focused work, including tests and docs.
- **Files** lists the main files touched. Two units that share files cannot run at the same time
  without a merge plan. The conflict matrix below makes this explicit.
- **Done when** is the acceptance gate. Every unit also follows the house rules:
  - tests first (red before the fix);
  - every affected lane green;
  - the site doc and `reference/migration.mdx` updated in the same change;
  - a version bump appended to `site/scripts/served-versions.txt` when the packed code changes.
- **Decision** marks something the maintainer must decide before or while the unit starts.

### Decisions needed up front

| #   | Decision                                    | Default proposal                                                                                                                       | Blocks |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D1  | License                                     | MIT, as the README badge already claims                                                                                                | WU-02  |
| D2  | When `latest` moves to 0.1.x                | Deprecate 0.0.11 now; move `latest` at 1.0-rc                                                                                          | WU-03  |
| D3  | Readonly views connect to their room        | Yes: a readonly view attaches its sync, and the room sends it updates only                                                             | WU-11  |
| D4  | Headless `createDocument` default semantics | `defaultSemantics` by default, `semantics: {}` to opt out                                                                              | WU-12  |
| D5  | Attribution trust model                     | The room binds `c/<client>` to the verified user and refuses writes to another user's `u/`                                             | WU-07  |
| D6  | Where comment threads live                  | Thread bodies in the room's SQLite behind an RPC/HTTP route; the document holds only anchor marks                                      | WU-34  |
| D7  | Table model                                 | A layout-like container (`table` → `row` → `cell`, cell a text island), with row/column ranks as data                                  | WU-30  |
| D8  | Supported pre-release formats at 1.0        | Keep the v13 import and generation 5; drop next.6 atomic leaves, next.22 containers and next.23 alarm rows behind a one-shot migration | WU-44  |
| D9  | CI budget                                   | Unit, crdt, dom and do on every push; Playwright Chromium on PR; Firefox, WebKit, mobile and DST nightly                               | WU-08  |

### Units of work

#### Wave 0: P0 blockers (day 1, one person, in order)

**WU-01: link sanitizer XSS (R1)**

- Scope:
  - Rewrite `sanitizeLinkHref`: strip every C0 control and space at both ends and tab, CR and
    LF anywhere.
  - Then parse with `new URL(value, 'https://invalid.invalid/')`.
  - Allow `http:`, `https:`, `mailto:` and `tel:`, and relative results that stay on the base.
  - Apply the same hardening to `safeImageSrc`.
- Files: `plugins/richtext/richTextOperations.ts`, `plugins/image/*` (`safeImageSrc`).
- Tests:
  - A unit table of payloads (`\u0000` to `\u001f` plus `javascript:`, `java\tscript:`,
    `JAVASCRIPT:`, entity forms).
  - jsdom: render, readonly render, HTML paste, toolbar link panel, the URL-over-selection
    paste.
  - A Playwright row asserting no `href` with a script scheme.
- Docs: rich-text "Values are sanitized"; migration ("Security fix").
- Effort: 0.5 d. Release `next.32` at once.

**WU-02: license (DOC-05, decision D1)**

- Scope: add `LICENSE`, set `"license"` in `package.json`, include it in the packed tarball,
  check it in `tests/packed-consumer/run.sh`.
- Effort: 0.1 d.

**WU-03: install truth (DOC-01, DOC-02, DOC-06, API-10, decision D2)**

- Scope:
  - Delete the stale "not on npm" sentences (`docs/index.mdx:22`,
    `getting-started/index.mdx:12`).
  - Fix the README feature line (markdown shortcuts need `markdownShortcutsPlugin`; handles
    come by default).
  - Replace `server/quick-start.mdx:183` with a link to `site/room` on GitHub.
  - Run `npm deprecate edytor@0.0.11 "use edytor@next"`.
  - Add those phrasings to `docs-drift.test.ts`.
- Effort: 0.3 d.

#### Wave 1: P1 library hardening (weeks 1 and 2, five parallel lanes)

**Lane R: room security and limits** (`src/lib/cloudflare/**`, `crdt/providers/room.ts`)

**WU-04: memory limits that hold (R2, R4)**

- Scope:
  - Measure heap per encoded byte in workerd (`tests/do`), not only in node.
  - Set the default `maxDocumentBytes` from it, about 2 to 3 MB encoded for 128 MB.
  - Lower `maxInboundFrameBytes` to a few MiB.
  - Add a room-wide cap on buffered chunk bytes across sockets.
  - Refuse chunk sequences from read-only sockets.
  - Assemble chunks into a preallocated buffer (no parts plus copy).
  - Close over-cap sequences with `4413`.
- Tests: `tests/do` rows for the cap, a read-only chunk refused, concurrent sequences, a
  document past the new default refused with `4413` while the room stays up.
- Docs: `server/room.mdx` (the real ratio and ceiling), troubleshooting, migration (a lower
  default is a behaviour change).
- Effort: 2 d.
- Outcome (deviations, decided): the heap was measured in Node (`bench/room-memory.mjs`), not
  in workerd, which reports no heap size; workerd's pointer compression makes the Node figures
  an upper bound. A sequence past the per-socket frame quota closes `4413`; one past the
  room-wide buffer cap (`maxBufferedBytes`) closes `1011` `room busy` instead, which the
  provider redials: the cap is shared by every socket, so the sender did nothing wrong and a
  final close would stop an honest client for good.

**WU-05: presence quota (R3)**

- Scope: cap the size of a presence entry (for example 16 KB, an option); count presence and
  query messages in the token bucket (or a second bucket); coalesce the broadcast once per tick.
  Read-only sockets keep presence, within the caps.
- Tests: `tests/do` for oversize presence (refused or ignored, with a `refusals` entry), presence
  flood rate-limited, query flood rate-limited, coalescing (N updates in one tick give one
  broadcast).
- Effort: 1 d.
- Outcome (deviation, decided): the broadcast is coalesced only past the rate (the newest held
  entry released in one frame with the others due), not once per tick: a per-tick flush needs a
  timer, which keeps a Durable Object from hibernating. Within the rate each entry is relayed at
  once (a view publishes at most every 50 ms). A burst past the rate is logged once.

**WU-06: revocation and token expiry (R5)**

- Scope:
  - RPC `closeUser(userId, code?)` and `setAccess(userId, 'write' | 'read' | 'none')`, walking
    `ctx.getWebSockets()` attachments.
  - An optional `expiresAt` in the authorize result, stored in the attachment; the room closes
    with `4401` when it passes, checked at each frame and on the alarm.
  - Downgrading to read-only sends the read-only notice.
- Tests: `tests/do` for revoke closing every socket of the user, a downgrade refusing the next
  write and keeping the socket, expiry closing with `4401` and the provider redialing.
- Docs: `server/authorization.mdx` (a "Revoking access" section).
- Effort: 1.5 d.

**WU-07: attribution trust and Origin (R6, R7, decision D5)**

- Scope:
  - The room checks `c/<clientID>` bindings against the socket's verified user, refuses writes
    to another user's `u/` profile (strip, a `forged` refusal), and overwrites presence `user`
    fields with the verified identity.
  - Add an `allowedOrigins` option to `routeDocumentSocket` and `routeDocumentHistory`.
- Tests: `tests/do` for a forged `c/` binding stripped, a forged profile write stripped, an
  Origin refused (`4403` for a socket, `403` for a history POST).
- Docs: authorization (the trust model, a cookie and SameSite warning).
- Effort: 1.5 d.

**Lane C: CI and test hygiene** (`.github/**`, timing asserts in `src/tests/**`)

**WU-08: CI that tests (CC-01, decision D9)**

- Scope:
  - `.github/workflows/ci.yml` on push and PR: install with the pnpm cache, then `check`,
    `lint`, `check:worker`, `check:docs`, `vitest --run`, `test:crdt`, `test:dom`, `test:do`,
    and both typechecks.
  - Playwright Chromium on PR, sharded.
  - A nightly workflow for Firefox, WebKit, mobile, CDP and DST.
  - Branch protection on `master` requiring the PR job.
  - `publish.yml` requires the CI run of the tagged commit.
- Effort: 1.5 d (plus fixing whatever is red on shared runners).
- Status (2026-10-07): done in the tree, except branch protection. `ci.yml`, `nightly.yml` and
  the gated `publish.yml` are in; only the pull request run's gate job is named `CI passed` (a
  push run's is `CI passed (push)`), so a push run, which skips Chromium, cannot satisfy the
  required check. **Pending:** a maintainer must create the `master` ruleset that
  CONTRIBUTING.md ("CI and branch protection") specifies; until then nothing blocks a direct
  push. `src/tests/ci-gates.test.ts` keeps the workflows and CONTRIBUTING.md in step.

**WU-09: deterministic gates (CC-05, R9)**

- Scope:
  - Replace wall-clock asserts in gate lanes with operation-count budgets (items walked,
    folds, reports), as `range-cursor.test.ts` does. Known files:
    `crdt/arch-v2/d6-range-delete.test.ts:553-574` and
    `fixtures/dom/arch-v2-r3-ops.test.tsx:163,191`. Grep for `performance.now()` with
    `toBeLessThan`.
  - Move absolute timings to `bench:crdt`.
  - Fix or quarantine the named flakes (seed-73 command-schedules, the R2 format flake) and
    delete WebKit `retries: 1` once they are stable.
- Effort: 1.5 d.
- Status (2026-10-07): done. The gate rows count the index's work (`runsView.debug`: `folds`,
  `foldedPairs`, `foldedStructs`, `recomputes`, `itemsWalked`); timings are `pnpm bench:scale`;
  seed-73 is fixed and no Playwright project retries. Residual races are named, not masked:
  `sel.key.before-adoption` in `docs/editor-delete-contract.md` (a key before the click's
  `selectionchange`). **Follow-up:** remote admission, engine integration, the undo manager and
  encode/load scaling are checked only by `bench:scale`, which fails nothing; a deterministic
  count for one of them (the structs or ranges admission visits) would put them back in a gate.

**Lane A: public API curation** (`src/lib/index.ts`, `edytor.svelte.ts`, `selection/selection.svelte.ts`, `plugins.ts`, `package.json` exports)

Run these in order; they touch the same files.

**WU-10: entry points and internals (API-01, API-02, DOC-04)**

- Scope:
  - Replace `export *` in `src/lib/index.ts` with an explicit, curated list.
  - Move coordinator and wire internals (section 8 of `crdt/index.ts`, generation records,
    codecs, raw provider classes) to a new subpath `edytor/protocol`, and keep `edytor/crdt`
    for the engine.
  - Turn plumbing members of `Edytor`, `EdytorSelection` and `Block` into `#private`, or mark
    them `@internal` and enable `stripInternal` in the package build.
  - Add an API-extractor (or `tsc --declaration` diff) report checked in CI, so the surface
    cannot grow by accident.
  - Update the room's and the tests' imports.
- Done when: the root exports fewer than about 120 names; no plumbing member appears in the
  emitted `.d.ts`; packed-consumer strict `tsc` passes; the docs' 99 imported names still
  resolve.
- Docs: a new "API reference" generated with TypeDoc for the four entry points, linked from
  Reference; migration (the removed and moved names).
- Effort: 3 d.

**WU-11: readonly views sync their room (API-04, decision D3)**

- Scope: `<Edytor readonly server room>` attaches its sync; the provider is read-only aware (it
  sends nothing it does not own, as it already does for read-only sockets); flipping `readonly`
  keeps the connection.
- Files: `components/Edytor.svelte:242`, `crdt/providers/websocket.ts` (if needed).
- Tests: a jsdom row (a readonly view receives a peer's edit); a `test:hosted` row through the
  room in Miniflare.
- Docs: readonly.mdx, collaboration/index.mdx ("A readonly view connects nothing" becomes "a
  live viewer").
- Effort: 1 d.

**WU-12: one source of truth for roles (API-05, API-06, decision D4)**

- Scope:
  - Export `mergeSemantics(...)` and make `semanticsOf` accept plugin kind records.
  - Export the bundled kind tables.
  - Make `defaultSemantics` the headless `createDocument` default.
  - Add a dev-time check: the client advertises a semantics hash in its hello frame and the
    room logs a mismatch.
- Effort: 1.5 d.

**WU-13: command and history surface (API-07, API-08, API-09)**

- Scope:
  - A non-throwing `prevent` (record and return) with `PreventionError`/`isPrevention` exported
    for the transition.
  - A distributive `Omit` for `onAfterOperation`.
  - Make `edytor.history` and `undoManager` private (`historyUndo`/`historyRedo` stay the
    API), so readonly can no longer be bypassed.
  - Move the facade behind `edytor.document.facade` as the explicit raw path, accepting
    `JSONBlock`.
  - Return a uniform `CommandResult { status, value }` from handle mutators.
- Tests: a type test for narrowing; a jsdom row where readonly cannot rewind through any public
  path.
- Effort: 2.5 d.

**WU-14: naming and papercuts (API-11, API-13, API-14, API-15)**

- Scope:
  - Rename `hotKeys` to `hotkeys` (keeping an alias for one release).
  - Rename the cloudflare `attachDocument` to `attachRoom` and the cross-room move to
    `moveBlocksBetweenRooms` (deprecated aliases for one release).
  - Make `value` and `onChange` the same type.
  - A DEV warning for snippet overrides naming no kind or mark.
  - Strip ticket codes from exported JSDoc with a lint rule, and fix the void/island JSDoc.
- Effort: 1.5 d.

**WU-15: a first-class trigger/input-rule API (API-03)**

- Scope:
  - Add `inputRules: [{ find: RegExp, replace(match, ctx) }]` and
    `triggers: [{ char, items(query), onPick }]` fields on plugins, built on `dispatcher.lead`
    and `caret`.
  - A public caret in block offsets (`{ block, offset }`); `yStart` and `segStart` disappear
    from the docs.
  - Port `markdownShortcuts` and the emoji docs example to it.
- Depends on WU-10 (the public surface) and feeds WU-24 (mentions).
- Effort: 3 d.

**Lane S: scale evidence**

**WU-16: room soak and fault test (production evidence)**

- Scope:
  - A load harness (Node or k6) with 50 to 100 websocket clients typing, splitting, moving,
    presence at 20/s, reconnect churn and offline replay, against a deployed staging room for
    4 to 8 hours.
  - Fault injection: hibernation, eviction (`ctx.abort`), storage errors, a forced compaction
    during traffic.
  - Measure p50/p99 ack latency, memory, compaction time and convergence (every client's JSON
    equal at the end).
- Done when: no divergence, no crash loop, memory under 70 % of the isolate, numbers recorded
  in `server/room.mdx` and the ledger.
- Depends on WU-04 and WU-05.
- Effort: 4 d.
- Outcome (deviations, decided): the harness is `bench/soak/` (`run.mjs`, `clients.mjs` worker
  threads of real `createDocument` + `WebsocketProvider` clients, `server.mjs` Miniflare,
  `worker.ts`/`local.ts` the shipped room as `SoakRoom` with fault routes, `wrangler.jsonc` for
  staging; `pnpm soak`, `pnpm soak:smoke`). The run was local (Miniflare on a shared M4 Pro
  laptop), 50 clients for 20 minutes, not 4 to 8 hours on staging: the staging recipe is in
  `server/room.mdx` (Load). Faults: hibernation and eviction (`workerd:unsafe`), `ctx.abort()`,
  2 s storage outages (a trigger failing update appends), 30 s failing compactions, forced
  compactions. Presence is 20 Hz while a client drags (10 % of its time) plus one per edit; all
  clients at 20 Hz was run apart (2 minutes). Heap is read in workerd through its inspector
  (`Runtime.getHeapUsage` after `HeapProfiler.collectGarbage`), which WU-04 could not.
  - Numbers (`bench/results/soak-wu16-20min.json`): 22,457 edits; ack p50 3.8 ms, p99 329 ms,
    p99.9 2.9 s, max 36 s (a writer's 1011 backoff after a storage outage); p99 32 ms in the
    median fault-free 10 s window; 33 offline replays, max 334 ms; compactions p50 16 ms, max
    34 ms; live heap 34 MB at 1.69 MB stored (18 bytes a byte), 127 MB before collection after
    an outage's rebuilds; 12 restarts, all injected; converged (50 clients, the room, a joiner,
    the reloaded room). Near the quota (`soak-wu16-near-quota.json`, 1.93 MB): 33 MB live idle,
    52 MB while 50 clients caught up after an eviction, under 70 % of 128 MB.
  - No divergence and no crash loop: nothing to fix in an owner. Findings left open: (1) stored
    size follows edits (70 to 80 bytes an edit; 1.7 MB stored for 20,000 visible characters),
    so a busy document reaches the 2 MiB default in days: a quota sizing or purge-cadence
    decision, documented in `server/room.mdx`; (2) presence fan-out is quadratic: 50 clients at
    20 Hz (35,000 frames a second) saturate the room's core (ack p99 19 s, one eviction under
    load, still converged; `soak-wu16-presence-worst.json`); (3) during a storage outage every
    failing frame rebuilds the document from its rows (`fault` → `rebuild`), so an outage costs
    rows × frames of CPU and garbage, and writers whose redials all failed back off for up to
    30 s. Candidates for WU-42 (room split) or a later room unit.

**WU-17: client scale profile (R10, R8)**

- Scope:
  - Profile Chromium at 5k and 10k blocks: mount, Enter, paste, move, scroll.
  - Decide whether `--edytor-block-visibility: auto` becomes the default, or windowed
    rendering of top-level blocks.
  - Make `crdt/data.ts` `common()` linear: trim the common prefix and suffix, then use
    positional pairing or a Myers diff past a bound.
- Tests: bench rows for both; an op-count assert for `arrange` at 6k items.
- Effort: 3 d (more if windowing is chosen).

**Lane D: docs and onboarding** (`site/content/**`, README; no `src/lib` changes)

**WU-18: onboarding truth (DOC-03, DOC-07, DOC-08, DOC-11, DOC-14)**

- Scope:
  - Make the quick start mount client-only, or test editable SSR and say so.
  - A "Platform support" page (engines, minimum versions, mobile and IME status).
  - Fix the room-internals facts (five alarm tasks, the tables) in one shared table.
  - Correct the "history in KV" sentence on the limitations page.
  - Add `check` to every complete fence (target 150+ of 213).
- Effort: 2 d.

**WU-19: readability pass (DOC-09, DOC-10)**

- Scope:
  - Lead each page with the common case; move edge cases into tables and callouts.
  - Rewrite concurrent-editing as Alice/Bob tables.
  - Split `migration.mdx` into a user changelog (breaking, new, fixed per release, no
    internal ids) and a "v13 import" guide.
  - Add a lint in `docs-drift` for lines over 1,200 characters outside tables.
- Effort: 3 d. It can start at once; re-touch pages that WU-10 to WU-15 change at the end.

**WU-20: localization and limits story (DOC-12, F12 docs)**

- Scope: document the label path (WU-28 adds the options); list what is not provided (tables
  and comments until they ship). Short.
- Effort: 0.5 d, after WU-28.

#### Wave 2: P2 product features, independent of the engine (weeks 2 to 5, four lanes)

These live mostly in `src/lib/plugins/**` and add new plugins, so they parallelize well.

**Lane F1: media**

**WU-21: image completion (F3)**

- Scope:
  - The image plugin claims file paste and drop when `upload` is set (one undo step, a
    placeholder while uploading).
  - Parse a bare `<img>` in the HTML import.
  - `data.alt` with an alt field.
  - Width and alignment data with resize handles in the overlay (Notion).
- Tests: jsdom paste and drop of a file, `<img>` import, alt rendered; Playwright resize.
- Effort: 4 d.

**WU-22: embeds and files (F2)**

- Scope:
  - New plugins:
    - `bookmark`: URL unfurl through an app-supplied `unfurl(url)`.
    - `embed`: allowlisted iframe providers such as YouTube, Figma and Loom, sanitized.
    - `file`: attachment through `upload`.
    - `video` and `audio`.
  - All void kinds following the image pattern; pasting a bare URL on an empty line offers
    "Embed / Bookmark / Link" (Notion).
  - The HTML import maps iframe, video and audio when a plugin claims them.
- Security: iframe `sandbox`, provider allowlist, no `srcdoc`.
- Effort: 6 d.

**WU-23: equation (F2)**

- Scope: a block and inline equation with KaTeX, lazy-loaded.
- Effort: 3 d (optional for P2).

**Lane F2: inline atoms, links, code**

**WU-24: trigger UI and mentions (F4)**

- Depends on WU-15.
- Scope:
  - Generalize the slash menu controller into a trigger suggestion controller (anchor
    tracking, IME, keyboard ownership).
  - Ship `mention` (people: an app-supplied `items(query)`) and `pageLink` (an app-supplied
    page search) atoms, exported and documented.
  - Remove the debug mention from the demo route.
- Effort: 5 d.

**WU-25: link UX (F11)**

- Scope: Mod+K opens the toolbar link panel; autolink a typed URL on space and a pasted URL at
  a caret (one undo step, undo gives the plain text); a link hover card with open, edit and
  remove; Mod+click opens.
- Effort: 2.5 d.

**WU-26: code languages (F9)**

- Scope: `data.language`, a picker in the header, lazily loaded grammars, the label from the
  language, keeping `transformText` tokens.
- Effort: 2.5 d.

**Lane F3: accessibility and i18n** (touches every chrome plugin's markup: keep it one lane)

**WU-27: accessibility (F7, F15)**

- Scope:
  - Forward `aria-label`, `aria-labelledby`, `aria-describedby` and `id` props to the root
    textbox.
  - While a menu is open: `aria-expanded`, `aria-controls` and `aria-activedescendant` on the
    host for the slash, + and block menus, and on the toolbar.
  - Human labels on handles (from the kind's preset label).
  - Keyboard resize on a focusable column band (arrows, Shift for bigger steps).
  - The image chrome from the keyboard: since WU-21 a selected image block shows its toolbar
    without the pointer, but no key moves focus into it (alignment, alt text) and the resize
    handles take no keys (arrows to resize, as the column band).
  - Live-region announcements for block moves and deletes.
  - An axe run in Playwright plus a manual VoiceOver and NVDA pass recorded in the docs.
- Effort: 5 d.

**WU-28: i18n (F8)**

- Scope:
  - A `labels` (dictionary) option on the toolbar, slash menu, block menu, image, code and
    handles.
  - A `createRichTextPlugin({ labels, keywords })` factory, with `richTextPlugin` as the
    English instance.
  - Localized slash keywords; one exported `Labels` type; an `fr` example in the docs.
- Effort: 3.5 d.

**WU-29: bidi (F14)**

- Scope: `dir="auto"` on text elements, a bidi caret and selection check in Playwright (Hebrew
  and Arabic mixed with English).
- Effort: 1.5 d.

#### Wave 3: P2 features that touch the engine or the room (weeks 4 to 8)

Schedule these after the closure splits (WU-40, WU-41) or coordinate with them. See the
conflict matrix.

**WU-30: tables (F1, decision D7)**

- Scope:
  - New roles in `crdt/semantics.ts`: `table` (a container of `row`), `row` (a container of
    `cell`), `cell` (a text island, one or more lines).
  - Index display rules: no empty row, every row with the column count, padding cells at read
    time.
  - Operations: insert and delete a row or column (one plan each, ranks as data, `exitRanks`
    discipline), move a row or column, merge-free cells.
  - Keys: Tab and Shift+Tab between cells, arrows across cells, Enter in a cell (new line in
    the cell), Backspace at a cell start (stays).
  - Block menu: add a row or column before or after, delete, header row toggle. Column resize
    reuses the columns band.
  - HTML import and export of `table`, `tr`, `td`, `th` (the clipboard only; document export
    is out of scope).
  - Concurrency: contract rows `table.*` (concurrent row insert and column delete, a cell edit
    racing a row delete). The fuzz gets a `table-shape` invariant.
- Tests: contract rows first, a crdt corpus adapter with tables, jsdom keys, Playwright in
  three engines.
- Effort: 15 to 20 d. The largest single unit; can be split into model (8 d), view and keys
  (5 d), menus and clipboard (3 d), fuzz (2 d).

**WU-31: block colours and toggle headings (F10)**

- Scope: `data.color`/`data.background` on any text block with a block-menu "Color" submenu
  (Notion palette, theme tokens); toggle heading kinds (a heading role with the toggle
  container); Turn into rows.
- Effort: 3 d.

**WU-32: page block and table of contents (F10)**

- Scope: a `page` void kind linking to another room (data: page id, title cache), building on
  cross-document moves; a `toc` kind listing the document's headings live.
- Effort: 3 d.

**WU-33: find and replace (F13)**

- Scope: a search plugin over the facade's text streams, overlay highlights, Mod+F (opt-in),
  replace one or all as one command and one undo step, hidden bodies skipped or revealed.
- Effort: 3 d.

**WU-34: comments (F5, decision D6)**

- Scope:
  - Room: a `comments` table, RPC and HTTP routes (`list`, `add`, `reply`, `resolve`,
    `reopen`, `delete`) authorized like history, broadcast of thread changes over the socket
    (a new message type).
  - Client: a `comment:<id>` mark (exists as a recipe), a comments plugin with a highlight, a
    sidebar in the overlay, a composer, resolve and reopen.
  - Anchors survive splits, merges, copy and paste (a comment mark is not copied by default,
    as in Notion).
  - Hooks for notifications.
- Effort: 12 to 15 d (room 4, client 6, concurrency and clipboard rules 2 to 3).

**WU-35: version history UI (F12)**

- Scope: a history panel component (a list of slots with editors and times), a read-only
  preview of a version (a second `<Edytor readonly>` over `?key=` JSON), a block-level diff
  highlight against the live document, Restore and Undo restore buttons.
- Depends on WU-11.
- Effort: 5 d.

**WU-36: persistent multi-user suggestions (F12)**

- Scope: suggestions stored as document data (a `suggest:<id>` subtree or marks) visible to
  every view, accept or reject by anyone with write access, attribution.
- Effort: 8 to 10 d (optional for P2; decide after WU-34, which shares the anchoring problem).

**WU-37: native text drag-move (F15)**

- Scope: dragging a selected text range moves it as one `replaceRange` plus `insertFlow`
  command (copy with Alt), with three-engine Playwright rows.
- Effort: 3 d (optional).

#### Wave 4: P3 maintainability (weeks 2 to 6, one or two people; serialized against engine work)

**WU-40: split `bindEdytorDoc` (CC-02)**

- Scope: move the `prepare.*` families (delete, flow, layout, data, history, moves) of
  `crdt/edytor-doc.ts` into modules taking an explicit context object; the facade becomes
  wiring. No behaviour change.
- Done when: the oracle suites, fuzz and every lane are green, with no file over about 800
  lines in `crdt/` outside the vendor.
- Effort: 4 d.

**WU-41: split `bindRuns` (CC-02)**

- Scope: split `crdt/text/runs.ts` into fold, claims, placement maintenance, layout rules and
  self-checks.
- Effort: 3 d.

**WU-42: split `AttachedDocument` (CC-02)**

- Scope: split `cloudflare/DocumentRoom.ts` into storage and compaction, admission
  (frames, quotas, forged writes), scheduler (alarm tasks), history and purge, moves, and
  presence.
- Do it after Lane R (WU-04 to WU-07), which edits the same class.
- Effort: 4 d.

**WU-43: break the view import cycle (CC-03)**

- Scope:
  - Assign `selection/`, `block/`, `text/` and `clipboard/` to contexts in AGENTS.md.
  - Add an eslint import-direction rule: session must not import surface, events or
    components.
  - Invert the session-to-surface calls (`composition` → `projector.park`, `surface.flush`;
    `bindings` → `beforeInputCommands`) through ports injected by the composition root.
- Done when: the dependency check (the reviewers' Tarjan script, added to `scripts/`) reports no
  cycle crossing contexts.
- Effort: 4 d.

**WU-44: ticket ids, AGENTS.md, compatibility layers (CC-04, CC-07, CC-08, decision D8)**

- Scope:
  - Replace ticket ids in `src/lib` comments with contract-row names or prose.
  - Prefix fork patches (`YP11`) to end the P-number collision.
  - Rename checkpoint-named tests by behaviour.
  - Move `docs/` history (ledger, reviews) to an `archive/` folder or branch.
  - Restructure AGENTS.md into a 2-to-3-page overview (contexts, the owners table, where to
    fix, lanes) plus topic files (room and protocol, data model, selection, layouts).
  - Drop the pre-release formats D8 retires, behind a one-shot migration; remove the
    deprecated aliases.
- Effort: 5 d. Mostly mechanical and can be split per directory, but it touches many files:
  run it last in each area.

**WU-45: lint, dependencies, fork hygiene (CC-06, CC-09, CC-10)**

- Scope:
  - Typed eslint for `crdt/providers` and `cloudflare` (`no-floating-promises`), and
    `no-unused-vars`/`noUnusedLocals`.
  - Add `.claude` to `.prettierignore`.
  - Remove the unused devDependencies (`y-indexeddb`, `y-websocket`, `svelte-inspect-value`,
    `type-fest`; `y-protocols` if unused) and fix the stale UPSTREAM.md rows.
  - Fork: export typed internal accessors from the vendored dts instead of the 137 casts; set
    `keepReplaced` per document instead of `Y.Doc.keepReplaced ??=`; add a scheduled job that
    diffs and tests against new `@y/y` tags.
- Effort: 3.5 d.

**WU-46: reactivity model (API-12)**

- Scope: handle getters read through the cell (as `data` already does), so `{block.type}`
  stays live; an `onChange` variant receiving the `DocChange` report, or debounced, so it no
  longer exports the whole document on every commit.
- Effort: 2.5 d. It touches `block/block.svelte.ts` and `edytor.svelte.ts`; sequence it after
  Lane A.

#### Wave 5: 1.0 release candidate

**WU-50: freeze and release**

- Scope:
  - An API freeze (the WU-10 report becomes the 1.0 contract).
  - The full lane set, including WU-16's soak re-run, green on the RC.
  - `latest` moves to `1.0.0-rc.1` (D2), the 0.0.11 deprecation stands, and the changelog
    from WU-19.
  - Limitations page refreshed.
- Effort: 2 d.

### Conflict matrix (who cannot run at the same time)

| Files or area                                                                       | Units touching it                                   | Rule                                                                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare/DocumentRoom.ts`                                                        | WU-04, 05, 06, 07, 34 (room part), 42               | Lane R first (one person, in order), then WU-42; WU-34's room part after WU-42                                                          |
| `crdt/edytor-doc.ts`, `crdt/text/runs.ts`, `crdt/semantics.ts`                      | WU-30, 31 (toggle heading role), 40, 41, 12         | WU-12 first (small), then WU-40/41, then WU-30. If tables must start earlier, start WU-30 on a branch and rebase after the splits       |
| `src/lib/index.ts`, `edytor.svelte.ts`, `selection.svelte.ts`, `plugins.ts`         | WU-10, 13, 14, 15, 46, 43                           | Lane A in order (WU-10 → 13 → 14 → 15), then WU-46 and WU-43                                                                            |
| Chrome plugin markup (`slashMenu`, `blockMenu`, `toolbar`, `blockHandles`, `image`) | WU-21, 24, 25, 27, 28                               | WU-27 and WU-28 together in one lane; WU-24 (slash controller generalization) before WU-27's slash part, or rebase; WU-21 owns `image/` |
| `site/content/**`                                                                   | every unit (docs in the same change), WU-18, 19, 20 | WU-19 rewrites prose: run it early, and let later units edit the new pages                                                              |
| `.github/**`, gate tests                                                            | WU-08, 09                                           | Lane C alone                                                                                                                            |

### Parallel schedule (four to five people or agent lanes)

```
Week        1        2        3        4        5        6        7        8
P0      [WU-01..03]
Lane R  [WU-04][05][06][07]        [WU-42 split room][WU-34 room part]
Lane C  [WU-08 CI][WU-09]
Lane A     [WU-10][WU-11][12][WU-13][14][WU-15]  [WU-46]
Lane S           [WU-16 soak][WU-17 profile]
Lane D  [WU-18][WU-19 readability.......][WU-20]
Lane F1          [WU-21 image][WU-22 embeds.....][WU-23]
Lane F2                          [WU-24 mentions][WU-25][WU-26]
Lane F3          [WU-27 a11y.......][WU-28 i18n][WU-29]
Lane E                  [WU-40 split doc][WU-41 runs][WU-30 tables...............]
Lane E2                                [WU-43 cycle][WU-31][WU-32][WU-33]
Lane X                                          [WU-34 comments client.....][WU-35 history UI]
Lane M                                                [WU-44][WU-45]   [WU-50 RC]
```

- **End of week 2: P1 reached** (Lanes R, C, A up to WU-13, S, D). Release a `next.N`
  announced as "production-capable library".
- **End of week 8: P2 and P3 reached**, apart from the optional WU-23, WU-36 and WU-37. That
  leads to 1.0-rc.

### Effort totals (engineer-days, excluding optional units)

| Wave                  | Units                   |                                                           Effort |
| --------------------- | ----------------------- | ---------------------------------------------------------------: |
| 0: P0                 | WU-01 to 03             |                                                                1 |
| 1: P1                 | WU-04 to 19             |                                                               34 |
| 2: P2 independent     | WU-21, 22, 24 to 29, 20 |                                                               30 |
| 3: P2 engine and room | WU-30 to 35             |                                                         41 to 49 |
| 4: P3                 | WU-40 to 46             |                                                               26 |
| 5: RC                 | WU-50                   |                                                                2 |
| **Total**             |                         | **≈ 134 to 142 d** (optional WU-23, 36, 37 add about 14 to 16 d) |

With five parallel lanes, that is about eight weeks of calendar time. Agent lanes compress the
mechanical units (WU-44, WU-45, WU-19, the splits). They do not compress the decisions, the
soak test or the manual accessibility pass.

### Per-unit checklist (copy into each PR)

- [ ] Contract row or test written first and seen red
- [ ] Fix in the owner named by AGENTS.md (no second writer, flag, timer or retry)
- [ ] Lanes: `check`, `lint`, `check:worker` (when `crdt` or `cloudflare` was touched), `check:docs`, unit, `test:crdt`, `test:dom`, `test:do` (room), Playwright in three engines (view), DST (input)
- [ ] Site docs and `reference/migration.mdx` updated; `docs-drift` passes
- [ ] Version bumped and appended to `served-versions.txt` when the packed code changes
- [ ] Scores re-checked on the dimension touched (focused review: only what the unit changed)
