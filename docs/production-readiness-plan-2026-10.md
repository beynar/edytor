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

## Status after execution (2026-10-08)

The plan was executed in four parallel waves (11, 7, 8 and 1 lanes; each lane implemented,
adversarially reviewed and fixed in its own worktree, then merged and gated on every lane),
released as `0.1.0-next.32` to `0.1.0-next.40`. A second adversarial review (same five
dimensions, a verifier per dimension) re-scored the project at `0.1.0-next.39`:

| Dimension                               | 2026-10-07 (`next.31`) |             2026-10-08 (`next.39`) |
| --------------------------------------- | ---------------------: | ---------------------------------: |
| Features                                |                     54 |                                 76 |
| Bugs, robustness, security, performance |                     58 |                                 70 |
| Code cleanliness and maintainability    |                     55 | 70 (verifier not run: usage limit) |
| Documentation                           |                     68 |                                 71 |
| API simplicity                          |                     56 |                                 67 |
| **Overall**                             |               **≈ 58** |                           **≈ 71** |

Both blockers are fixed (the link XSS, the license). Shipped by release:

| Release      | Contents                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next.32`    | Wave 0: link sanitizer XSS, MIT license, true install docs                                                                                                                                                                                                                                                                                                          |
| `next.34`    | Wave 1: room limits, presence quotas, revocation and expiry, attribution trust; CI on every push; curated public API (`edytor/protocol`, API reports); readonly live viewers, one source of truth for roles; image completion; media plugins; link UX and code languages; accessibility and bidi; find and replace; onboarding docs (`next.33` was never published) |
| `next.36`    | Wave 2: input rules and triggers, mentions and page links; i18n (labels); the room soak harness; block colours, toggle headings, page block, table of contents; engine and room splits; version history panel (`next.35` never published)                                                                                                                           |
| `next.38`    | Wave 3: tables; comments; the import cycle broken; typed lint, reactive handles; the user changelog and docs readability; room performance (presence budget, one rebuild per outage); the CI quarantines fixed at their cause; equations; text drag-move; chrome that follows late layout (`next.37` never published)                                               |
| `next.40`    | Wave 4: ticket ids out of the code, YP fork patches, docs history archived, AGENTS.md overview + `docs/agents/`, retired aliases removed (`next.39` never published)                                                                                                                                                                                                |
| `next.41`    | After the second review: the handles' raw write primitives internal and refused on a readonly view; the Limitations page corrected; checkpoint-named test files renamed                                                                                                                                                                                             |
| `next.42`    | Typing in a table costs the cell (no longer O(cells²)); comment quotas: stored bytes, a request rate per user and per socket, no second snapshot, a body read capped at 64 KiB                                                                                                                                                                                      |
| `next.43`    | API: the types an app names exported (176 reachable-not-exported to 102), single-owner state read-only, `edytor.focus()`; SECURITY.md and issue templates; the plugins index fixed (`next.42` never published: a CI race in the handle alignment row)                                                                                                               |
| `next.44`    | Features: markdown paste makes blocks; pasted and dropped files become image, video, audio or file blocks with upload progress                                                                                                                                                                                                                                      |
| `1.0.0-rc.1` | WU-50: the API frozen (`DocumentOperations`: the document's operations are its own, `document.facade` deprecated; `select(value)`; the dispatcher's plumbing internal; the document vocabulary exported, 176 reachable-not-exported types down to 38); typing on long pages (the handles' near band by binary search); the release candidate under `latest`         |
| `1.0.0-rc.2` | `document.facade` removed (internal); a browsable API reference generated from the published types; the touch chrome tested on both phones; the selection's pointer and the handles' drop indicator split out; the room's import cycle gone; a drag whose release the page never sees ends                                                                          |

The docs site stopped deploying at `next.34` (an invalid front matter in a Wave 2 page); fixed
on `master` after `next.40`, with a docs-drift row guarding it.

### What the second review still finds (to plan next)

Majors, by dimension:

- **API**: ~~public handle methods that write raw bypass readonly~~ (`next.41`); result
  shapes: decided (2026-10-08): handle commands keep their values, `dispatcher.last` is the
  one status channel; ~~176 types reachable but not exported~~ (38 left at `1.0.0-rc.1`:
  engine types under `document.doc`/`history`, and session helpers); ~~mutable public fields
  with one owner~~ (`next.43`); ~~`document.facade` publishing the index~~ (`1.0.0-rc.1`:
  `DocumentOperations`, decided with the maintainer: the operations live on the document).
- **Robustness**: the document lifetime ceiling (≈ 72 stored bytes per edit against a 2 MiB
  quota, `4413` final): decided (2026-10-08), no re-seed for 1.0 (offline edits would not
  merge); the application chooses its maximum document size, the room logs `size` near it
  (`documentWarning`, 0.8); stale-block compaction measured at most −27 %, a re-seed −78 %
  (`docs/design/document-reseed.md`, deferred); ~~comments unbounded, snapshot amplification~~
  (`next.42`); ~~typing in a table O(cells²)~~ (`next.42`); client typing linear in page size
  (no windowing).
- **Features**: ~~markdown paste into blocks~~ (`next.44`); ~~file/video/audio claiming dropped and pasted files
  (with upload progress)~~ (`next.44`); the touch chrome (tested under phone emulation since `1.0.0-rc.1`: handles without hover, grip tap → block menu → Move, `+`, toolbar, all on screen); real devices are the maintainer's.
- **Code**: the view-side classes (`EdytorSelection`, `BlockHandleController`, `Edytor`,
  `EdytorDocument`) not split (after `1.0.0-rc.1`: the selection's pointer handling is its own `SelectionPointer`, 1,658 → 1,353 lines; the handles' drop indicator and geometry are their own modules, 1,320 → 1,056); ~~the room split is a 16-module cycle~~ (after `1.0.0-rc.1`: the room's shared constants and helpers in a leaf, `room/shared.ts`; four small cycles remain, each inside one context); master unprotected; ~~the nightly never run~~ (first runs on Linux failed WebKit's Mac
  keys; on macOS since, green at `1.0.0-rc.1`); ~~about 90 checkpoint-named test files~~ (`next.41`).
- **Docs**: ~~the Limitations page denies shipped features~~ (`next.41`); ~~the plugins
  index's defaults table~~, ~~SECURITY.md and issue templates~~ (`next.43`); no browsable API
  reference (the committed `api/*.api.md` reports are the reviewed surface).

### What only the maintainer can do

- Apply the `master` branch protection ruleset in CONTRIBUTING.md (a required `CI passed`).
- `npm deprecate edytor@0.0.11 "use edytor"`; after `1.0.0-rc.1` moves `latest`, point `next`
  at it too (`npm dist-tag add edytor@1.0.0-rc.1 next`), which tokenless CI publishing cannot.
- Enable GitHub's private vulnerability reporting (SECURITY.md sends reports there).
- The 4 to 8 hour soak against a deployed staging room (`pnpm soak` against it; recipe in
  `server/room` Load), which needs a deploy.
- A manual VoiceOver and NVDA pass, and real iOS/Android keyboards.
- Sign off decision D8's deviation (pre-release stored formats kept).

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
- **CC-06: the Yjs fork changes engine semantics.** It carries semantic patches (YP11 to YP14)
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

| #   | Decision                                    | Default proposal                                                                                                                                                                                                          | Blocks |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D1  | License                                     | MIT, as the README badge already claims                                                                                                                                                                                   | WU-02  |
| D2  | When `latest` moves to 0.1.x                | Deprecate 0.0.11 now; move `latest` at 1.0-rc                                                                                                                                                                             | WU-03  |
| D3  | Readonly views connect to their room        | Yes: a readonly view attaches its sync, and the room sends it updates only                                                                                                                                                | WU-11  |
| D4  | Headless `createDocument` default semantics | `defaultSemantics` by default, `semantics: {}` to opt out                                                                                                                                                                 | WU-12  |
| D5  | Attribution trust model                     | The room binds `c/<client>` to the verified user and refuses writes to another user's `u/`                                                                                                                                | WU-07  |
| D6  | Where comment threads live                  | Thread bodies in the room's SQLite behind an RPC/HTTP route; the document holds only anchor marks                                                                                                                         | WU-34  |
| D7  | Table model                                 | A layout-like container (`table` → `row` → `cell`, cell a text island), with row/column ranks as data                                                                                                                     | WU-30  |
| D8  | Supported pre-release formats at 1.0        | Keep the v13 import and generation 5; drop next.6 atomic leaves, next.22 containers and next.23 alarm rows behind a one-shot migration. Deviation (WU-44, awaiting sign-off): kept until the generation-6 bump, see WU-44 | WU-44  |
| D9  | CI budget                                   | Unit, crdt, dom and do on every push; Playwright Chromium on PR; Firefox, WebKit, mobile and DST nightly                                                                                                                  | WU-08  |

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
    `crdt/arch-v2/range-delete.test.ts:553-574` and
    `fixtures/dom/ops-read-document.test.tsx:163,191`. Grep for `performance.now()` with
    `toBeLessThan`.
  - Move absolute timings to `bench:crdt`.
  - Fix or quarantine the named flakes (seed-73 command-schedules, the R2 format flake) and
    delete WebKit `retries: 1` once they are stable.
- Effort: 1.5 d.
- Status (2026-10-07): done. The gate rows count the index's work (`runsView.debug`: `folds`,
  `foldedPairs`, `foldedStructs`, `recomputes`, `itemsWalked`); timings are `pnpm bench:scale`;
  seed-73 is fixed and no Playwright project retries. Residual races are named, not masked:
  `sel.key.before-adoption` in `docs/editor-delete-contract.md` (a key before the click's
  `selectionchange`). Fixed 2026-10-08: a key after a press reads the DOM first
  (`projector.unobserved()`), and the grip-column row waits for Chromium to deliver each
  drag move; neither row is skipped on CI any more. **Follow-up:** remote admission, engine integration, the undo manager and
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
  - Numbers (`bench/results/soak-wu16-20min.json`, rerun on the final harness): 22,321 edits;
    ack of edits made while connected p50 5.6 ms, p99 691 ms, p99.9 4.1 s, max 57 s; of the
    604 edits made while disconnected (churn, a fault's redial and backoff) p50 880 ms, p99
    4.1 s, max 60 s (the slowest connected one made just after the last reset, acknowledged in
    the final settle; the report does not say why they waited); p99 64 ms in the median
    fault-free 10 s window (`faultFreeWindows`); 24 offline replays, max 241 ms; compactions p50 18 ms, max 44 ms; 12 restarts, all
    injected; converged (50 clients, the room, a joiner, the reloaded room). Sizes in MB of
    10^6 bytes: live heap after a full GC 36 MB at 1.80 MB stored (about 20 bytes a byte;
    about 18 in the near-quota run, `soak-wu16-near-quota.json`: 34 MB at 1.93 MB, 54 MB while
    50 clients caught up after an eviction).
  - Memory gate: met for the live heap after a full GC only (under 70 % of 128 MB in both
    runs). Before collection the heap reached 121 MB (190 MB allocated by V8) right after a
    storage outage, and 92 MB (134 MB allocated) near the quota: past 70 %, and allocated past
    the limit. Miniflare enforces no memory limit, so whether a deployed room rides out that
    peak is unverified.
  - No divergence and no crash loop: nothing to fix in an owner. Findings left open: (1) stored
    size follows edits: 1.77 MB stored, about 72 bytes an edit, for 20,778 characters whose
    JSON seeds fresh in 0.16 MB. Measured (`report.size`, `bench/soak/size.mjs`): no deleted
    item keeps its content and the purge at a horizon of now gives back 5 %, so the growth is
    per-edit CRDT structure that lasts for the document's life (1,537 blocks registered for 400
    shown, 40,000 attribution contributor entries, 15,000 replaced `lastChangedBy` values; in
    memory, 40 bytes an edit for the mix, 20 without Enter and merges, 3 for typing at a
    caret). A busy document reaches the 2 MiB default in days; the remedy documented is to
    raise `EDYTOR_MAX_DOCUMENT_BYTES`, not to shorten the purge. Shrinking the structure
    (re-seeding a document from its JSON, rebasing the snapshot, dropping merged blocks'
    registrations or per-writer contributor entries) is a maintainer decision. (2) presence
    fan-out is quadratic: 50 clients at 20 Hz (35,000 frames a second) saturate the room's core
    (ack p99 19 s, one eviction under load, still converged; `soak-wu16-presence-worst.json`).
    (3) during a storage outage every failing frame rebuilds the document from its rows
    (`fault` → `rebuild`), so an outage costs rows × frames of CPU and garbage, the likely
    source of the heap peak. Candidates for WU-42 (room split) or a later room unit.
  - The near-quota and presence reports predate the final harness (one ack figure for edits
    made while connected, no size measure). The harness forces one offline session and one
    page load in every run, so `pnpm soak:smoke` replays and reloads.
  - The staging Worker (`bench/soak/worker.ts`) refuses every route without `SOAK_TOKEN`
    (`tests/do/soak-worker.test.ts`); operator routes take it as a bearer header, sockets as
    `?token=` (in request logs: Workers Logs stay off in `wrangler.jsonc`).
  - Follow-ups (lane roomperf, the four findings): (1) presence fan-out has a budget
    (`room.presence.fanout`: `maxPresenceFanout`/`EDYTOR_MAX_PRESENCE_FANOUT`, 2,000 frames a
    second over all sockets; past it entries wait per recipient, newest per replica, one frame
    each at a later message, no timer): the presence worst case rerun on the same machine went
    from 5.6 million frames, a saturated core, ack p50 22 ms, p99 16 s, max 28 s
    (`soak-wu16-followup-presence-baseline.json`) to 0.77 million frames, about 35 % of a core,
    p50 3.8 ms, p99 43 ms, max 0.8 s (`soak-wu16-followup-presence-worst.json`). (2) a storage
    outage rebuilds once (`room.storage.outage`: a probe append, rolled back, asks storage before
    a frame that would write; refused frames close `1011` unapplied): 4 rebuilds in the 20-minute
    run instead of one per refused frame (about 50 an outage); the pre-collection heap peak (125
    MB used, 171 MB allocated) came all the same, so it is V8 deferring its major collection, not
    the rebuilds. (3) the stored size per edit is measured by kind of struct (`size.mjs`
    `bytes`; 50 writers: contributor entries 29 %, mark operations 16 %, text 11 %, replaced
    `lastChangedBy` 8 %); the purge now deletes the attribution records of blocks merged away
    before the horizon (`room.purge.merged`, `PurgeReport.merged`), so a purge at a horizon of now
    gives back 17 % of the 20-minute document, from 5 %. Shrinking it while the document is
    edited stays a maintainer decision (see the attribution note below). (4) a client holds about
    30 bytes of heap per stored byte (56 MB at 1.86 MB after a full GC); `bench/soak/heap.mjs`
    shows the engine's struct store is three quarters of it (about 440 bytes a struct: item, id,
    content and its array, the types' maps) and the block index the rest: no safe win short of an
    engine representation change (a fork patch). The 20-minute soak rerun
    (`soak-wu16-followup-20min.json`, load median 25): 22,615 edits, ack of edits made while
    connected p50 5.4 ms, p99 613 ms, p99.9 3.2 s, max 4.5 s (was 57 s); while disconnected p99
    3.0 s, max 3.6 s (was 60 s); median fault-free window p99 51 ms; 3.2 million frames (was
    6.5); live room heap 36 MB at 1.86 MB; converged. Found on the way, not changed: a text edit
    in a split-born block stamps its stream's home block (`fold.ts` `locate` maps the backing
    text to its home), so that block's contributors and `lastChangedBy` take the edit and every
    later split copies them; whether that is the attribution contract or a bug is for the
    attribution owner.

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
- Outcome (deviations, decided): column order is data (`data.columns`, each cell naming its
  column) rather than column ranks, and padding is the view's (`tableGrid` reads `null`, the
  first edit fills the cell) rather than the index's. The block menu rows act at the cell the
  caret was last in (else the last row and column); moving a row or a column stays in the
  grips' menus. The column resize band is the table plugin's own (`plugins/table/chrome`),
  not the columns plugin's: a columns band resizes a column block and writes its `width`,
  while a table column is an entry of the table's `data.columns`, and the columns plugin is
  optional. Undoing a column insert shows a peer's text in its column after the listed ones
  (`table.conc.column-undo`); a column delete racing another peer's adoption of an unlisted
  table is a residual (`table.conc.adopt`).

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
- Status (2026-10-08): done. One rule decides every request
  (`crdt/protocols/comments.ts`: `decideComment`, the change and its sequence
  number, `commentAnchors`, the `messageComments` codec), shared by the room
  and the clients. Room: `cloudflare/room/comments.ts` (`threads` and
  `comments` tables, `meta` `comments`), `routeDocumentComments` (GET, POST)
  authorized like history, RPC `listComments`/`comment` (a `moderator`
  deletes anyone's), the change sent only to subscribed sockets, a removed
  thread's anchor marks removed by a room transaction, `onComment`
  (`EDYTOR_COMMENTS=off` / `comments: false`). Client: `createCommentsClient`
  (HTTP plus `watchComments` on the page's socket), `createMemoryCommentsClient`
  (`as(user)`), `createCommentsPlugin` (the `comment` mark, `exclusive`,
  `copy: false`; toolbar Comment through `toolbar.run`, Mod+Shift+M; the
  sidebar in the overlay, margin or popover; composer, reply, resolve,
  reopen, delete; `onComment(change, { own })`). Rows: `room.comments.*`,
  `comment.anchor`, `comment.copy` (`tests/do/comments.test.ts`,
  `src/tests/collaboration/comments.test.ts`,
  `src/tests/fixtures/dom/comments.test.tsx`,
  `tests/editor-dom/comments.spec.ts`). Residuals: plain-text bodies, no
  edit of a posted comment, no "can comment" access, Duplicate copies anchors.

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
- Status (2026-10-08): done. `crdt/edytor-doc.ts` (3,544 → 628 lines) is the wiring: the
  schema gate, seed, public types and plan helpers are `crdt/doc/{gate,seed,types,plan}.ts`;
  each facade part is a `crdt/doc/` module over an explicit context, the parts before it
  (`reads`, `capability`, `funnel`, `events`, `history`, `anchors`, `steps`), and the op
  families take `OpsContext` (`moves`, `layout`, `split-merge`, `delete`, `meta`, `content`).
  Every `crdt/doc/` file is under 500 lines. The API report changed only in declaration file
  labels and `JsonObj`, now an exported alias. `bench:crdt`, run alternately on the base and
  the split tree under the same load: within run-to-run noise (keystroke 1k blocks facade p50
  1.44/1.21 ms base, 1.33/1.25 ms split; structural p50 at 20k blocks 0.12/0.10 ms enter both).

**WU-41: split `bindRuns` (CC-02)**

- Scope: split `crdt/text/runs.ts` into fold, claims, placement maintenance, layout rules and
  self-checks.
- Effort: 3 d.
- Status (2026-10-08): done. `crdt/text/runs.ts` (2,845 → 438 lines) declares the index's
  types and wires `crdt/text/index/` parts over one shared state object (`state.ts`; the
  fields a part reassigns are read through it): `claims`, `anchored` (anchored merge claims),
  `streams`, `layout` (the layout rules), `placement` (placement maintenance, `typeOf`),
  `records`, `cache` (the run cache), `fold`, `report` and `checks` (the self-checks, reached
  through `ix.checks`). The largest part is `fold.ts` (537 lines). The API report is
  unchanged; the vitest lanes run with the self-checks on. For the 800-line bound, the same
  lane moved the module-level functions out of `placement/model.ts` (1,325 → 758:
  `resolve.ts`, `source.ts`, `display.ts`) and `text/model.ts` (982 → 763: `items.ts`,
  `ranges.ts`, `streams.ts`), both re-exporting them, and the marks and copies index out of
  `text/deletes.ts` (959 → 601: `delete-index.ts`). **Remaining:** `crdt/document.ts`
  (1,438 lines, about 830 of them the public `EdytorDocument` class, whose shape the API
  report pins); splitting it means moving method logic out of the class, a follow-up unit.

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
- Status (2026-10-08): done. Comments, fork-patch names, the archive, the guide, the aliases
  and the test renames are done; D8 is not carried out (a deviation awaiting the user's
  sign-off, below).
- Outcome:
  - Comments: the 793 ticket ids of `src/lib` comments (686 lines) are contract rows or prose.
    `scripts/ticket-ids.mjs` lists any new one in a `src/lib` comment or in the guide's prose
    (contract rows and `YPn` allowed), and `src/tests/maintainability/ticket-ids.test.ts`
    runs it in the unit lane.
  - Fork patches are `YP1` to `YP14` in `UPSTREAM.md`, the vendored source, the vendored tests,
    `src/lib`, the guide and the patch tests (`src/tests/crdt/yp*.test.ts`); plan P-numbers
    left the code.
  - Tests: 140 checkpoint-named files renamed by behaviour: every one of
    `src/tests/fixtures/dom` and `tests/do`, the arch-v2 review, re-score and wave files of
    `src/tests/crdt/arch-v2`, the arch-v2 and wave Playwright specs, and the YP patch tests.
    References are updated outside the archive. `src/tests/api`'s `wu13-commands` and
    `wu14-naming` are now `command-surface` and `naming`.
  - The rest of the checkpoint-named tests, 110 files, renamed by behaviour with `git mv`
    (contents unchanged but for the imports and references that name a renamed file):
    - `src/tests/crdt/arch-v2`: the `cw01`, `d1`–`d12`, `fx11`, `gen5`, `gx05`, `h1`–`h11`,
      `i3`, `nw11`, `p1`/`p4`/`p6`/`p28`, `r1`/`r2`/`r4`/`r8`, `s1`, `sw16`, `t3`/`t5`,
      `uw31` and `v1`/`v3` files (47, helpers included: `p1-harness.ts` is
      `replica-harness.ts`, `p1-ops.ts` `replica-ops.ts`, `cw01-sweep.ts`
      `gesture-order-sweep.ts`; e.g. `d6-range-delete` is `range-delete`, `h5-marks`
      `paired-marks`, `p1-fuzz` `replica-fuzz`);
    - `src/tests/crdt/hardening` keeps its name, its files named by what they probe
      (`r1-p4-format` is `search-marker-format`, `gateH-r3-probes` `undo-ownership-probes`);
      `gate1` is `model-edges/`, `gate2` `boundary-attacks/` (`lifecycle` is
      `websocket-lifecycle`), `gateF1` and `gateF2` are one `text-model-probes/`; `gate3`'s
      file went to `providers/`, `phase5`'s to `placement/same-id-concurrent`,
      `document/keep-replaced-per-doc` and `text/merge-claim-anchor`;
      `src/tests/gate3/app-context.test.tsx` is `src/tests/app-context.test.tsx` and
      `fixtures/dom/gate3/lifecycle-dom` is `fixtures/dom/mount-lifecycle`;
    - `attribution/u3-*` are `persistence-paths` and `attribution-semantics`,
      `runs/u8b-fanout` is `shared-backing-fanout`, `u11-profile` `keystroke-cost-profile`,
      `fixtures/model/phase10-*` `operation-sequence-invariants` and `model-scale`;
    - the Playwright specs: `columns-round3`–`round8` are `columns-mouse-gestures`,
      `columns-resize-guide`, `columns-no-caret-keys` (and `columns-no-caret-ime.cdp`),
      `columns-gap-selection` and `columns-cross-column-selection`; `p1-*` are
      `word-delete-and-list-keys`, `foreign-dom`, `ime-undo.cdp`, `selection-races` and
      `probe-helpers.ts`; `r2-render` is `render-from-cells`, `r3-ops`
      `large-delete-linear-work`.
    - Every lane selects the same tests as before (unit, `test:crdt`, `test:dom`, `test:do`
      and the Playwright list: the same counts). References are updated outside the archive
      (contract rows, ADRs, `UPSTREAM.md`, the upstream workflow, bench, CONTRIBUTING.md,
      AGENTS.md's "replica harness"); `tsconfig.tests.json`'s stale `src/tests/api/wu*.ts`
      glob names `command-surface` and `naming` again.
  - `docs/archive/` holds the planning history: architecture-v2, reviews, research, baseline,
    and the earlier plans, handoffs and gate reviews. Links are fixed.
  - The guide is `AGENTS.md` (the overview: identity, topic guides, contexts, the owners table,
    where to fix what, lanes, practical rules; 50 KB, most of it the owners table) plus
    `docs/agents/` (`data-model`, `layouts-and-tables`, `selection-and-input`,
    `plugins-and-chrome`, `room-and-protocol`, `release`). No prose line is over 1,500
    characters (the 15,000-character room line is a list).
    `node scripts/agents-coverage.mjs <old AGENTS.md>` checks every identifier and every rule
    fragment of the old file against the guide, each kept once. Run on the 9199716 file, it
    reports 1,584 identifiers and 2,068 fragments with none missing or doubled.
  - Size, accepted: the overview is about 4,000 words (31 KB without the table padding, 50 KB
    on disk), twice the 2-to-3-page target. Most of it is the owners table, kept whole because
    it is the one place that names each fact's owner; its details already live in the topic
    files. Slimming its cells is left to a follow-up if the size hurts.
  - Aliases removed (migration "Unreleased", Breaking changes): `hotKeys`, `blockDnd`,
    `serverUrl`/`roomName`, the cloudflare `attachDocument`/`AttachDocumentOptions` and
    `moveBlocks`, a bare KV namespace as `history.store`, the block suggestion wrappers, and
    the migrator's no-op lease options.
- D8, a deviation awaiting the user's sign-off (the decision row says drop): the next.6 data forms (an array as one leaf, the whole-`data` attribute),
  next.22 containers (a record without `storage`) and next.23 alarm rows are all schema
  generation 4 (generation 5 began at next.25). A generation-5 build already meets them only
  through a one-shot migration, the generation cutover (`room.generation.convert`, the local
  store's conversion). That cutover reads them with this build's reader: `previousJSON` reads
  through the current facade, and `isPreviousGenerationRecord` takes a record without
  `storage`. So the reader is the migration's own code, and dropping it would break loading.
  A new row in `src/tests/crdt/arch-v2/generation-5-cutover.test.ts` proves a generation-4 state with
  next.6 data converts with its arrays and seeds generation 5 without the old forms. The
  next.23 alarm rule is one line (an alarm with no due rows is a due save). It is kept because
  a room last run by next.23 may still hold a due save. Revisit with the next generation
  bump: generation 6 can drop generation 4's reader and these forms with it.
  The alternative, not taken: the legacy reading (the whole-`data` attribute and the atomic
  array leaf under the leaves) also runs in the live read path, `effective` in
  `crdt/data.ts`, on every generation-5 read, although no generation-5 writer is known to
  write those forms (to verify before the move). It could move into the generation-4 reader (`previousJSON`) alone, which would
  carry out D8's drop for generation 5 without breaking the cutover. That is a change to the
  data read path and needs its own unit and tests.

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
- Status (2026-10-08): done in the tree, with two recorded deviations.
- Outcome (deviations, recorded for review):
  - The typed accessors live in `src/lib/crdt/structs.ts`, typed against the vendored dts,
    not in the vendored fork itself. `pnpm census` counts 46 casts left (from 148): 34 inside
    `structs.ts`, 1 for the UndoManager options (`doc/history.ts`), 11 outside the engine
    (DOM, JSON, the Durable Object host, a socket polyfill). The casts are centralized in one
    module, not removed. Removing them means adding the accessor types to `vendor/yjs/dts`
    through `UPSTREAM.md`; that is a follow-up.
  - `noUnusedLocals` stays off in `tsconfig`: `@typescript-eslint/no-unused-vars` enforces the
    same rule across `src/lib` (the type-only imports `edytor-doc.ts` needs for its emitted
    declarations would trip the compiler flag).
  - `keepReplaced` is per document (`keepingReplaced`). A raw `new Y.Doc()` that integrates
    edytor content before it is bound no longer gets the rule; the docs and the migration
    note send servers and scripts to `bindCrdt(Y).createDoc()`.
  - The weekly upstream job verifies each tarball's integrity, picks the newest 14.x by
    semver, and reports a `lib0` range the installed `lib0-v14` does not satisfy. Its first
    local run found `@y/y` 14.0.0-rc.28, which asks `lib0@^1.0.0-rc.35` (installed: rc.32).
    Interop and the differential still pass against it. The re-sync stays manual.

**WU-46: reactivity model (API-12)**

- Scope: handle getters read through the cell (as `data` already does), so `{block.type}`
  stays live; an `onChange` variant receiving the `DocChange` report, or debounced, so it no
  longer exports the whole document on every commit.
- Effort: 2.5 d. It touches `block/block.svelte.ts` and `edytor.svelte.ts`; sequence it after
  Lane A.
- Status (2026-10-08): done. The handle getters depend on the cells when a reactive reader
  reads them (`$effect.tracking()`), and plain reads stay document reads. `onDocChange` (an
  `EdytorOptions` field, an `<Edytor>` prop and a plugin hook) receives each commit's
  `DocChange` and exports nothing. Each `onDocChange`/`onChange` consumer is isolated (a throw
  is logged). The report is shared by every subscriber of the document, so its collections
  are typed `ReadonlyMap`/`ReadonlySet`.

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
