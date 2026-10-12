# Plugin demos

The live editors on the plugin pages (`site/content/docs/plugins/<page>.mdx`): a **Try it** editor showing the plugin with the demo's chrome, and a **Customize** editor drawing the same document with your own renderers, whose code the page shows in a `check` fence. The code plugin (`code/`, `plugins/code.mdx`) is the reference.

## Layout

```
site/islands/PluginDemo.svelte   the one island: <PluginDemo plugin="<page>" variant="default|custom" />
site/demos/registry.ts           finds every <page>/index.ts (import.meta.glob); never edited
site/demos/types.ts              PluginDemo, DemoProps
site/demos/base.ts               basePlugins(), objectUrlUpload, searchBy
site/demos/<page>/index.ts       the page's demo (default export)
site/demos/<page>/<Shown>.svelte the Customize component, shown on the page byte for byte
```

`<page>` is the page's file name without `.mdx` (`table-of-contents`, `page-link`). A new folder is picked up as it is: no shared file changes. Nothing under `site/demos` may live in `site/islands/` (blume prerenders every component there on the server).

## `index.ts`

```ts
import type { JSONDoc } from 'edytor';
import { codePlugin } from '../../chrome/plugins'; // the demo's chrome for this plugin
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';
import CodeEditor from './CodeEditor.svelte';

const value: JSONDoc = { children: [/* a small document that shows the plugin */] };

export default {
	value, // each editor opens its own copy
	plugins: () => [codePlugin, ...basePlugins()], // "Try it": the page's plugin first
	custom: CodeEditor // "Customize"; leave out where nothing renders
	// customPlugins: () => [...basePlugins()] // what `custom` gets as `plugins` (default basePlugins())
} satisfies PluginDemo;
```

- `basePlugins()` is the editor around every demo: Notion's placeholders, the block handles, the block menu, the slash menu, the toolbar and rich text. List the page's plugins before it. `<Edytor>` adds its defaults (arrow move, image, suggestions) itself.
- The page's plugin comes from `../../chrome/plugins` when the demo chrome has it (`codePlugin`, `tablePlugin`, `equation()`, `mention({ items })`, `comments({ client, user, users })`, …), else from `edytor`.
- `customPlugins` never holds a second instance of the plugin the Customize component configures: the first plugin listed wins a kind, so a second instance's options would do nothing and only confuse a reader. When that plugin is one of `basePlugins()`, pass it to leave the demo's out: `customPlugins: () => basePlugins(toolbarPlugin)`. Add what else the page needs (a media plugin's uploads, the columns plugin) there.
- Keep ids unique in the seed and the document short: a heading or a sentence of context, the plugin's blocks, maybe one empty paragraph to type in.

## The Customize component

One `.svelte` file (more if the customization needs them), every file of the folder but `index.ts` shown on the page. It takes `{ value, plugins }` and renders `<Edytor {value} plugins={[yours, ...plugins]} />`:

```svelte
<script lang="ts">
	import { Edytor, createCodePlugin, type CodeHeader, type JSONDoc, type Plugin } from 'edytor';

	// The page's document and the rest of your editor's plugins.
	let { value, plugins = [] }: { value?: JSONDoc; plugins?: Plugin[] } = $props();

	const code = createCodePlugin({ header });
</script>

{#snippet header(header: CodeHeader)}…{/snippet}

<Edytor {value} plugins={[code, ...plugins]} />

<style>…</style>
```

- Imports come from `edytor` only (and sibling shown files, `./Card.svelte`): the fence is checked as a reader's file, so `../../chrome` or `../base` would not resolve there. A service the plugin needs (an unfurl, a search, a comments client) is written in the file, local, as a reader's app would.
- Snippets declared in the component's markup are scoped by its `<style>`, the overlay's too (menus, panels): no `:global` needed.
- What to customize, where the plugin has it: its snippet options, the controls inside blocks (to-do checkbox, callout icon, bookmark card, file row, embed fallback, table of contents entries, page link, equation placeholder) and the chrome (menus, toolbars, panels, grips). For content, a kind override: a plugin listed first naming only the kind's `snippet` (or `element`) restyles it and keeps its roles and hooks. Each look must be visibly different from the default, small and tasteful.
- `aria-label` on the `<Edytor>` (`"Code demo"`), and words in your markup (the package carries none).

## The page

Right after the page's opening paragraphs, before its first `##`:

````mdx
## Try it

<PluginDemo plugin="code" />

One line saying what to press or click. The editor is local to this page: a reload resets it.

## Customize

One or two sentences: which snippets or kinds this changes, and how it looks.

<PluginDemo plugin="code" variant="custom" />

```svelte title="CodeEditor.svelte" check
```
````

A behaviour-only plugin (arrow move, input rules, markdown shortcuts) has **Try it** and its hint only. Guide pages (index, operations, writing plugins) have no demo.

## The fence is the source

`site/demos/<page>/<File>` is the source; the fence titled `<File>` on the page is a copy. Write the file, put the empty fence (`title="<File>"`, then `check`) on the page once, and copy it in:

```bash
node site/scripts/demo-fences.mjs code   # one page; no argument: every demo
```

`src/tests/docs-onboarding.test.ts` ("a plugin page's live demo runs the code the page shows") fails when a fence and its file differ, when a demo folder's page has no `<PluginDemo plugin="<page>" />` (or no `variant="custom"` one while `index.ts` has `custom`), and when a page names a folder that does not exist. `pnpm check:docs` type-checks the fence.

## Fully local

No room, no socket, no server, no persistence: no `server`, `room`, `sync` or `document` props, no `localStorage`; a reload resets the page. Instead:

| Service | Local stand-in |
| --- | --- |
| Comments | `createMemoryCommentsClient({ user })` from `edytor` |
| Mention people, page link pages | a fixed list: `items: searchBy(PEOPLE, (p) => p.label)` (`base.ts`) |
| Uploads (image, file, video, audio) | `createUploadsPlugin({ upload: objectUrlUpload })` (`base.ts`): the file's object URL |
| Bookmark unfurl | a function answering canned metadata after a short delay |
| An image to show | a `data:image/svg+xml,…` URL |
| A page to open (`page` plugin) | an `open` that changes nothing outside the editor |

Third-party content the plugin exists for (an embed's provider player, KaTeX from its CDN) may load; say so in the report. Nothing may reach `edytor-room` or a websocket.

## Checking a demo

- `blume dev` runs at http://localhost:3012 (`.claude/launch.json`, `site`); a page reloads as you edit. Open `/docs/plugins/<page>`: both editors render, typing works, the plugin's menu or control opens, no console error, no request to a room or a websocket, and at 375px wide no horizontal scroll.
- `pnpm exec vitest --run src/tests/docs-onboarding.test.ts` and `pnpm check:docs` from the repository root.
- The deploy's build: `cd site && sh scripts/pack-edytor.sh && pnpm install --no-frozen-lockfile && pnpm --dir room install --no-frozen-lockfile && sh scripts/installed-edytor.sh && pnpm exec blume build` (restore `site/pnpm-lock.yaml` after).
- The island resets the page's prose rules inside the editor (`.prose :where(…)` reaches through `not-prose`); a look that still leaks belongs in that reset, in `PluginDemo.svelte`, not in a demo.
