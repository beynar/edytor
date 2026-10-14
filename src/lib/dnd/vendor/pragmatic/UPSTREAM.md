# Vendored Pragmatic drag and drop — provenance & changes

Atlassian's Pragmatic drag and drop, forked inside edytor: only the modules
edytor reaches, as the packages publish them, so the block handles' and the
table grips' drags run the library's own logic without depending on its
packages. `src/lib/dnd/pragmatic.ts` is the one importer; nothing else in
edytor imports from this directory. Do not edit these files by hand: re-sync
(below) and record every change here.

## Pinned source

| Package                                         | Version | npm integrity (`pnpm-lock.yaml` before the fork)                                                          | License                           |
| ----------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `@atlaskit/pragmatic-drag-and-drop`             | 4.0.0   | `sha512-pyDo2B5NiaExoKGmgeXKGNUL4aR4UzzSZm8QWWjYTEyBLVqSqKyKUwtVxMw2YEkakagOGFONUdHM32LAH2nPug==` | Apache-2.0, `…/LICENSE.md`        |
| `@atlaskit/pragmatic-drag-and-drop-auto-scroll` | 3.2.1   | `sha512-2fhWAG48EjPoKhoHLG6RcT3/VaCzYEbRb6BtA/Vcfx4FrL0P1KrEgBJ6OAwB0X8MOV6UH22YgjFFHjv8fQD9rA==` | Apache-2.0, `…/LICENSE.md`        |
| `bind-event-listener` (core's dependency)       | 3.0.0   | `sha512-PJvH288AWQhKs2v9zyfYdPzlPqf5bXbGMmhmUIY9x4dAUGIWgomO771oBQNwJnMQSnUIXhKu6sgzpBRXTlvb8Q==` | MIT © Alexander Reardon, `LICENSE` |
| `raf-schd` (core's dependency)                  | 4.0.3   | `sha512-tQkJl2GRWh83ui2DiPTJz9wEiMN20syf+5oKfB03yYP7ioZcJwsIK8FjrtLwH1m7C7e+Tt2yYBlrOpdT+dyeIQ==` | MIT © Alex Reardon, `LICENSE`     |

The core's third dependency, `@babel/runtime`, is not needed: the fork takes
each package's `dist/es2019` build, which uses no Babel helper (object spread,
destructuring and `for…of` are native there), not its `dist/esm` build.

## Layout

```text
pragmatic-drag-and-drop/              dist/es2019/<path>.js and dist/types/<path>.d.ts of the core
pragmatic-drag-and-drop-auto-scroll/  the same, of the auto-scroll package
bind-event-listener/                  index.js, bind.js, bind-all.js: its src/*.ts with the types removed
raf-schd/                             dist/raf-schd.esm.js, verbatim
```

Each package keeps its published directory structure, so a file here diffs
against `dist/es2019/<same path>` (or `dist/types/<same path>` for a `.d.ts`).

## What was kept

The module closure of the three entry points `pragmatic.ts` imports, nothing
else:

- core `entry-point/element/adapter` (`draggable`, `dropTargetForElements`,
  `monitorForElements`): the element adapter, the drag lifecycle, drop targets
  and monitors, the honey pot fix, the window-leaving and broken-drag
  detection;
- core `entry-point/element/set-custom-native-drag-preview`;
- auto-scroll `entry-point/element` (`autoScrollForElements`,
  `autoScrollWindowForElements`, the over-element API and its scheduler).

The `.d.ts` files are the declarations those entry points' types reach (9
files); a `.js` without one is reached only from other vendored `.js`.
Everything else the packages publish (the external and text-selection
adapters, the other utilities, the hitbox package (the block handles split a
row into its halves themselves), the unsafe-overflow auto-scroll, CommonJS and `dist/esm` builds) is left out.

## Local changes (the only ones)

1. **Import specifiers.** Every relative specifier gains its file extension
   (`'./once'` → `'./once.js'`, a directory import its `/index.js`), so the
   packaged `dist/` loads in Node as ES modules too. Every bare specifier
   between the packages (`@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter`,
   `…/utils/combine`, `…/utils/once`, `…/get-element-from-point-without-honey-pot`,
   `…/types` in the declarations) and to the two dependencies
   (`bind-event-listener`, `raf-schd`) becomes the relative path of the
   vendored file. This binds the auto-scroll package to the same core as the
   element adapter: its monitor sees the drags the adapter starts (edytor
   used to rebuild the auto-scroll API from its CommonJS `makeApi` for that,
   since a browser bundle resolved the package's own bare import to a second
   core). Specifiers quoted in comments (the `@deprecated` notes) stay as
   written.
2. **`bind-event-listener` in JavaScript.** The package publishes CommonJS
   only; its three `src/*.ts` modules are vendored as ES modules with their
   type annotations removed (the code, comments and names unchanged). Its
   types are not needed: no vendored declaration names them.

3. **Options edytor never passes, removed** (each site marked `// edytor:`):
   the auto-scroll's `getConfiguration` (its speed is the standard one, a
   constant `internalConfig`) and `getAllowedAxis` (both axes always:
   `shared/is-axis-allowed.js` is gone), and its distance dampening always on
   (`get-scroll-by.js` reads its two axes through one `change`); a
   `draggable`'s `dragHandle`, a drop target's `getDropEffect` and
   `onDropTargetChange`, a monitor's `canMonitor`, and the native drag
   preview's default `getOffset` (both callers give theirs). Their
   declarations go too, so a caller passing one does not compile.

No other statement of the libraries' own code is changed. A check that a
re-sync reproduces this: strip every import specifier from each vendored file
and from its upstream file, and compare: they are equal but for the sites of
change 3.

## How edytor builds around it

- `tsconfig*.json` exclude `src/lib/dnd/vendor/**`: TypeScript reads the
  vendored `.d.ts` beside each entry `.js`, never checks the JavaScript.
- ESLint, Prettier, `scripts/deps.mjs` (the context graph) and the line counts
  (`scripts/xloc.mjs`, `scripts/bundle-size.mjs`) skip it as vendored code.
- `package.json#sideEffects` lists the core's directory: upstream declares the
  core with side effects (`count-events-for-safari.js` binds its WebKit
  listeners at import), the auto-scroll without.
- Nothing runs against the DOM at import (the core guards `typeof window`):
  server rendering imports it as before.

## Re-syncing with upstream

1. Install the new versions of the two packages (and of `bind-event-listener`,
   `raf-schd`) somewhere outside the package's dependencies.
2. From each package's `module:es2019` entry (`element/adapter`,
   `element/set-custom-native-drag-preview`, auto-scroll
   `element`), follow every import; copy each reached `dist/es2019` file and,
   from each entry's `types` field, each reached `dist/types` declaration to
   the same path here, rewriting specifiers as in change 1.
3. Redo change 2 from `bind-event-listener`'s `src/`, and change 3; copy
   `raf-schd/dist/raf-schd.esm.js`; copy the license files.
4. Update the table above, run the drag lanes (the block handle, table, columns,
   drop reach, auto-scroll, drag preview and press-after-drag specs in
   Chromium, Firefox and WebKit, the jsdom drag rows) and the packed consumer.
