<div align="center">
  <img src="cover.jpg" alt="Edytor Logo" width="60%"/>

<p>A powerful, extensible rich text editor built with Svelte and Y.js</p>

[![npm version](https://badge.fury.io/js/edytor.svg)](https://badge.fury.io/js/edytor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)
[![Svelte v5](https://img.shields.io/badge/Svelte-v5-FF3E00.svg)](https://svelte.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Bundle size](https://deno.bundlejs.com/badge?q=edytor@latest&treeshake=%5B*%5D&config=%7B%22esbuild%22:%7B%22external%22:%5B%22svelte%22,%22clx%22%5D%7D%7D)](https://deno.bundlejs.com/badge?q=edytor@latest&treeshake=%5B*%5D&config=%7B%22esbuild%22:%7B%22external%22:%5B%22svelte%22,%22clx%22%5D%7D%7D)

<p>
    <a href="#features">Features</a> •
    <a href="#quick-start">Quick Start</a> •
  </p>
</div>

Edytor aims to be the premier rich text editor for Svelte, providing the same level of power, flexibility and extensibility that Slate.js offers for React. Like Slate.js, Edytor strives to be heavily customizable and provide a powerful API to build any kind of collaborative rich text editor.

## ⚠️ Work in progress

Edytor is currently in the early stages of development. It is not yet ready for production use.
I welcome early contributors to help us build a better editor for Svelte.
Just run it, see what you can do with it, and open issues or PRs.

If you want to submit an issue please share the json value of the document. It will help understand and fix the issue.

## ✨ Features

- 📑 **Customizable with snippets**: Use snippets to render your own blocks and marks
- 🎨 **Rich Text Formatting**: Full support for marks, blocks and inline blocks.
- 🤝 **CRDT collaboration**: built on a vendored Yjs v14 engine — one `EdytorDocument` shared by any number of views (or none — it works headlessly), IndexedDB + websocket providers, awareness cursors, identity-preserving moves/splits/merges. Engine + bindings ship as `edytor/crdt` and `edytor/crdt/edytor` subpaths
- 🔌 **Plugin System**: Extensible architecture for custom features. I try to make every action performed by the editor hackable and preventable to let you build your own features.
- ⚡ **High Performance**: Optimized for large documents, fine grained update at the leaf level thanks to the CRDT substrate and Svelte's reactivity
- 🔄 **Undo/Redo**: Built-in history management
- 🖱️ **Block drag and drop**: Reorder, nest, and unnest blocks with built-in handles
- 📦 **Lightweight**: Relatively small bundle size compared to other rich text editors
- 📦 **AI copilot ready**: Support inline text suggestions for ai completions.

## ✨ Things that are ready

- [x] YJS backed editing
- [x] Basic block operations and text operations.
- [x] Stable data structure
- [x] Undo/Redo
- [x] Rich text formatting
- [x] Customizable with snippets
- [x] Plugin system
- [x] Text suggestions
- [x] Inline blocks
- [x] Nesting
- [x] Block drag and drop (move, nest, and unnest)
- [x] Selection + movable blocks
- [x] Content transformation
- [x] Content normalization
- [x] Island blocks
- [x] Customizable hotkeys
- [x] Void elements and editable void elements
- [x] Text spanning deletion
- [x] Block spanning deletion.
- [x] Readable JSON data structure
- [x] Readonly edytor to lightweightly render static content without the Y.js extra works.
- [x] Children normalization
- [x] Collaborative editing — awareness, IndexedDB persistence, websocket provider, cross-tab sync (vendored Yjs v14; proven in the test suites — no production telemetry yet)

## ✨ Things that are not ready

- [ ] Block suggestions
- [ ] Reactive data (inline)block properties with syncrostate.

## 🧠 Concepts

Edytor structure is built around this key concepts:

- **Blocks**: Container elements like paragraphs, headings, and lists
- **Content**: The content of a block is an array of inlines blocks or text and marks.
- **Children**: Children are the blocks that are directly inside a block. They allow an infinite nesting.
- **Marks**: Texts are simply text with marks that define the formatting.
- **Inline blocks**: Inline blocks are inline elements that are no editable and render custom components like footnotes, equations, etc.

Schematic example of a document:
(content and children are not dom element, i put them here to help you understand the structure)

```html
<root>
	<block>
		<content>
			<text mark="bold">Hello</text>
			<text>World</text>
			<inline-block type="footnote">
				<!-- Inline block are rendered by the user code -->
			</inline-block>
		</content>
		<children>
			<nested-block>
				<content>
					<text>World</text>
				</content>
			</nested-block>
			<nested-block>
				<content>
					<text>World</text>
				</content>
				<children>
					<nested-block>
						<content>
							<text>World</text>
						</content>
					</nested-block>
				</children>
			</nested-block>
		</children>
	</block>
</root>
```

### Blocks

Blocks are the container elements like paragraphs, headings, and lists.
They have a content that is an array of inlines blocks or text.
They may have children that is an array of nested-blocks.
Blocks can be nested unless they are void or inside an island

An island is a block that is editable but is structuraly stable and isolated from the rest of the document.
It is impossible to merge an island with another block. It is also impossible to move another block inside an island.
You may think of an island as a block that is editable but is not completely part of the document structure and isolated from the rest of the document.

A void block is a block which does not have children or whose children are not editable and rendered outside of the edytor core logic.
Void blocks can render and edit their content anyway. That is usefull to render caption.
You may think of a void block as a block that is completely independent from the rest of the document.
Void blocks acts also like an island but are even less editables.

### Text

Text is the basic text element that is rendered by the editor. At is core it is a Y.js text with any formatting attributes you want.

### Inlines Block

Inlines are inline blocks, useful to render custom components like footnotes, equations, etc.
They are rendered by the user code and are not editable nor focusable.
They have a data property

## 🚀 Quick Start

### Installation (not published yet)

```bash
npm install edytor
# or
yarn add edytor
# or
pnpm add edytor
```

### Basic Usage

```svelte
<script>
	import { Edytor } from 'edytor';

	let value = {
		children: [
			{
				type: 'paragraph',
				content: [{ text: 'Hello, World!' }]
			}
		]
	};

	function onChange(newValue) {
		console.log('Document changed:', newValue);
	}
</script>

<Edytor {value} {onChange} />
```

Block handles and drag targets are enabled by default. Drop near a block's top or bottom to reorder, in its middle to nest, or at a nested block's left gutter to outdent. Focus a handle and use `Alt+↑/↓` to reorder or `Alt+→/←` to nest or outdent. Use `blockHandles={false}` to omit the handles. Use `blockHandles={{ draggable: false, onActivate: ({ block, anchor }) => openMenu(block, anchor) }}` to keep the handle and its keyboard actions while disabling pointer drag. The typed callback receives the live block and handle element. `blockDnd={false}` remains a deprecated alias for hiding the handles; `blockHandles` takes precedence when both are set. Handle configuration is read when the editor mounts.

Relative movement is also available without the handle UI through the editor instance:

```ts
const request = { blocks: [source], target, position: 'before' as const };
if (edytor.canMoveBlocks(request)) {
	edytor.moveBlocks(request);
}
```

`position` is `before`, `after`, or `inside`. A request can instead name one relative step, `{ blocks, direction }` with `direction` `up`, `down`, `in` or `out` — the meaning the handle keys and the arrow-move plugin (`Mod+↑/↓` on selected blocks) use: `down` places the blocks after their next sibling, never inside its children, and past the last sibling after their parent (`up` mirrors it); `in` makes them the last children of their previous sibling; `out` places them after their parent. A relative group must be siblings. `moveBlocks` returns the blocks actually moved; grouped moves keep the supplied block order and run as one history step. `canMoveBlocks` checks structural eligibility, while plugins may still prevent the operation.

### The document — headless or shared by views

`createDocument` builds an `EdytorDocument`: one shared facade, one local
history, one awareness, the local actor and compact per-block attribution
on the v14 CRDT substrate. Use it headlessly (plain node/SSR via
`edytor/crdt/edytor` — no Svelte in the graph) or hand it to any number of
`<Edytor>` views:

```ts
import { createDocument, loadDocument } from 'edytor';

const document = createDocument({
	value: { children: [{ type: 'paragraph', content: [{ text: 'hello' }] }] },
	actor: { id: 'user-42', name: 'Ada' }
});

const [block] = document.facade.project().children;
document.transact(() => document.facade.insertText(block.id, 5, ' world'));
document.history.undo();

const saved = document.encode(); // Uint8Array — persist or transport it
const restored = loadDocument(saved); // restores as a fresh replica
```

```svelte
<Edytor {document} {plugins} />
<Edytor {document} {plugins} />
<!-- two views, ONE document: shared facade/history/awareness -->
```

Readiness (`pending`/`local`/`hydrated`), borrowed vs owned docs,
`attachSync` provider attach, attribution reads and the admission gate:
[`docs/crdt-v14-document.md`](docs/crdt-v14-document.md).

### Collaboration and persistence

Edytor is CRDT-backed by a vendored **Yjs v14** engine (`@y/y@14.0.0-rc.26`, pinned — not the `yjs` npm package). You can pass a shared `document` directly, or use the exported sync helpers to wire providers through the `sync` prop.

The engine and the bindings are also importable on their own — for node/SSR code paths where the Svelte component can't load. The document factories above work there unchanged; `bindCrdt(Y)` is the entry when you need the raw provider/migration stacks on a doc you own:

```ts
import * as Y from 'edytor/crdt'; // the vendored v14 engine
import { bindCrdt } from 'edytor/crdt/edytor'; // doc facade, awareness, providers, migration

const crdt = bindCrdt(Y);
const doc = crdt.createDoc();
const awareness = new crdt.Awareness(doc);
const provider = new crdt.providers.IndexeddbPersistence('document-id', doc, { awareness });
await provider.whenSynced;
```

`edytor/crdt` is edytor's owned fork of the engine, pruned to what edytor runs on (`UPSTREAM.md` patch P8): documents, nodes, transactions, undo, the V1/V2 update codecs (`applyUpdate`, `encodeStateAsUpdate`, `mergeUpdates`, `decodeUpdate`, state vectors), relative positions (JSON form), id sets/maps with their codecs, and `RangeCursor`. The concrete renderers, snapshots and the update diff/log/obfuscate helpers are not shipped (see "Migrating from 0.0.11"); the renderer interface (`AbstractRenderer`, `useRenderer`, `toDelta({renderer})`) stays for your own renderer. The document factories bind the 23-symbol engine object in `src/lib/crdt/engine.js`, so an app that never imports `edytor/crdt` bundles only what those symbols reach; `bindCrdt(Y)` with the whole namespace keeps the whole (pruned) engine.

Upgrading a deployment that has v13 (`yjs`) persisted documents? Read [`docs/crdt-v14-migration.md`](docs/crdt-v14-migration.md) — it's a one-way, non-destructive import with an explicit operator recipe and rollback.

Local IndexedDB persistence:

```svelte
<script lang="ts">
	import { Edytor, createIndexeddbSync } from 'edytor';

	const sync = createIndexeddbSync('document-id');
</script>

<Edytor {sync} />
```

Websocket provider setup:

```svelte
<script lang="ts">
	import { Edytor, createWebsocketSync } from 'edytor';

	const sync = createWebsocketSync({
		serverUrl: 'wss://collaboration.example.com',
		roomName: 'document-id'
	});
</script>

<Edytor {sync} />
```

`createWebsocketSync` also takes `params` (query parameters such as an auth token, read at every dial) and `maxBackoffTime` (the reconnect backoff cap). It carries no BroadcastChannel leg: for cross-tab sync and offline persistence, stack `createIndexeddbSync` beside it.

The sync helpers pass Edytor's `awareness` instance into the provider. Set local user metadata on the editor awareness state:

```ts
edytor.awareness.setLocalStateField('user', {
	name: 'Ada',
	color: '#dc2626'
});
```

Remote cursor and expanded selection overlays render from awareness `selection` state. Edytor publishes its own local selection into awareness when the selection changes.

Unsupported collaboration surfaces:

- Edytor does not provide authentication or permission rules: the `edytor/cloudflare` room calls your `authorize` and enforces what it returns (user, replica, read-only).
- Edytor ships a Durable Object room (below), not hosted infrastructure: you deploy it on your own Cloudflare account.
- IndexedDB persistence is local browser storage; the room's durability is the Durable Object's SQLite storage.

### Server coordinator (Cloudflare Durable Object)

Edytor ships the server room: `edytor/cloudflare` exports `DocumentRoom`, a Durable Object that coordinates one document (deploy one object per document), and `routeDocumentSocket`, the Worker-side door that authorizes a client before its WebSocket upgrade. Clients are the ordinary `createWebsocketSync` / `WebsocketProvider`. The module is Worker-only (it imports `cloudflare:workers`) and is built on the Worker-safe CRDT entry: `pnpm lint` (an import-boundary rule on `src/lib/crdt/**` and `src/lib/cloudflare/**`) and `pnpm check:worker` (bundles both entries for a Worker target) keep Svelte and the view layers out of it.

**1. The Worker.** Export the class and route sockets through `routeDocumentSocket(request, namespace, documentId, authorize)`:

```ts
// src/worker.ts
import { DocumentRoom, requestedReplica, routeDocumentSocket } from 'edytor/cloudflare';

export { DocumentRoom };

type Env = { ROOMS: DurableObjectNamespace<DocumentRoom> };

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const match = /^\/rooms\/([^/]+)$/.exec(new URL(request.url).pathname);
		if (!match) return new Response('not found', { status: 404 });
		return routeDocumentSocket(
			request,
			env.ROOMS,
			decodeURIComponent(match[1]),
			async (request, documentId) => {
				const session = await verifySession(request); // your authentication
				const access = session && (await accessTo(session.userId, documentId)); // your permissions
				if (!access) return null; // → 403, no socket
				return {
					userId: session.userId,
					replica: requestedReplica(request), // the client's doc.clientID, from ?replica=
					readOnly: access === 'view'
				};
			}
		);
	}
} satisfies ExportedHandler<Env>;
```

**2. The binding** (`wrangler.jsonc`). The room stores in SQLite, so it must be declared a SQLite class:

```jsonc
{
	"main": "src/worker.ts",
	"compatibility_date": "2026-09-26",
	"durable_objects": { "bindings": [{ "name": "ROOMS", "class_name": "DocumentRoom" }] },
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["DocumentRoom"] }]
}
```

**3. The client.** Dial `wss://<host>/rooms` with the document id as the room, and send the replica (and your token) as parameters:

```ts
const document = createDocument({ actor: { id: userId } });
document.attachSync(
	createWebsocketSync({
		serverUrl: 'wss://example.com/rooms',
		roomName: documentId,
		params: { token, replica: String(document.doc.clientID) }
	})
);
```

**`authorize`** runs before the upgrade and returns `{ userId, replica?, readOnly? }` or `null` (403). `routeDocumentSocket` then forwards a fresh request that carries only the verified identity (`X-Edytor-User`, `X-Edytor-Replica`, `X-Edytor-Access`); every header the client sent, including forged `X-Edytor-*` values, is dropped. The room trusts those headers, so reach it only through `routeDocumentSocket` (a direct request without them is refused 401).

**What the room enforces**

- **Identity is bound to the socket.** `{user, replica, readOnly}` lives in the socket's attachment, so it survives hibernation. Each Yjs client id is registered to the user who first wrote under it (the socket's `replica` is registered at the upgrade). An update that writes new structs under a client id another user owns, or under an unregistered id that already has content, is refused (close 1008 `refused: replica`): nobody can write in someone else's name. A user may write under every id they own, so a reloaded page (a new `doc.clientID`) still delivers the offline edits its previous id made. A `replica` another user owns is refused at the upgrade (403). Without a `replica` from `authorize`, the socket's first presence entry binds it.
- **Read-only sockets write nothing.** They catch up and share presence; the room never asks them for their state, and each Step2/Update they send is dropped with a `permission-denied` reply (the provider emits `'permission-denied'`); the socket stays open.
- **Admission.** A frame of another generation is refused before it is decoded; an update writing a foreign schema stamp is refused (`sync.applyRemote`). A refused frame is never applied, stored or relayed.
- **Presence** is relayed through the instance-free awareness codec (no `Awareness` instance: its sweep timer would block hibernation), only for the socket's own replica. A joiner gets every present peer; a socket that leaves without a goodbye is announced gone, also after a hibernation wake.

**Storage, acknowledgement and catch-up**

- Every integrated update is appended to SQLite as one record split into rows under the 2 MB row cap, in one `transactionSync`, then broadcast. After `EDYTOR_COMPACT_AFTER` update records (default 500) the rows are replaced by one snapshot, `Y.mergeUpdates` of every record, atomically. `compact()` is also callable over RPC. A woken object rebuilds from its rows under `blockConcurrencyWhile`; a container of another generation refuses every socket (1011).
- **Store-before-ack.** Every sync message a client sends is answered, after the write, with a `messageSaved` frame carrying the room's state vector. The provider's `saved` (boolean) and `unsaved` (the count of local updates the room has not acknowledged, offline edits included) follow those acknowledgements, and it emits `'saved'` with `{ saved, unsaved }` when they change. No timer is involved.
- **Bounded catch-up.** A frame larger than `EDYTOR_MAX_FRAME_BYTES` (default 32 MiB, the WebSocket message limit) is sent as `messageChunk` start/part/end frames that the provider applies only once the sequence is complete. Smaller frames are unchanged, so a client without chunk support still syncs small documents.
- **No timers.** Every entry point runs under `noTimers`, which throws if anything schedules one: an object with a pending timer never hibernates.

Optional `vars`: `EDYTOR_MAX_ROW_BYTES`, `EDYTOR_MAX_FRAME_BYTES`, `EDYTOR_COMPACT_AFTER` (they only lower the defaults). Limits: a single client → room message is still capped at 32 MiB by the platform (clients do not chunk); the in-memory presence snapshot refills as clients renew (every 15 s) after a wake.

**Writing your own client or server.** Every frame is `varuint GENERATION | varuint messageType | payload`, with `GENERATION = generationWord(SCHEMA_VERSION) = PROTOCOL_VERSION * 1000 + SCHEMA_VERSION` (14003 at schema 3); build one with `frame(type, (encoder) => …)` from `edytor/crdt/edytor`. The message types are `0` sync (subtypes `0` Step1, `1` Step2, `2` Update), `1` awareness, `2` auth (permission denied), `3` query awareness, `4` saved (the room's state vector) and `5` chunk (`chunkFrame`/`createChunkReader`). `edytor/crdt/edytor` also exports the sync readers/writers (`bindCrdt(Y).sync`), `readAwarenessEntries`/`writeAwarenessEntries`, and the lib0 read helpers. Never call `attachDocument` (or `createDocument`/`loadDocument`) on a server's doc: it would write the server into the replicated attribution dictionary.

## 📦 Plugins

Plugins are the primary way to extend Edytor's functionality. They allow you to add custom blocks, marks, inline blocks, hotkeys, and hook into various editor events. Each plugin is a function that receives the editor instance and returns a set of definitions and operations.

Plugins are best written in Svelte files (`.svelte`) to take full advantage of Svelte's snippets system and template syntax when defining block and mark snippets. You can define snippets for blocks, marks, inline blocks, hotkeys, and operations and still be able to use them inside the `<script module>` `</script>`tag of your file that will export the whole plugin.

### Plugin Structure

A basic plugin structure looks like this:

```typescript
const MyPlugin = (editor: Edytor) => ({
  // Define custom blocks
  blocks: {
    myBlock: {
      snippet: /* Svelte snippet */,
      // ... block options
    }
  },
  // Define custom marks
  marks: {
    myMark: {
      snippet: /* Svelte snippet */,
      // ... mark options
    }
  },
  // Define custom inline blocks
  inlineBlocks: {
    myInline: {
      snippet: /* Svelte snippet */,
      // ... inline block options
    }
  },
  // Define custom hotkeys
  hotkeys: {
    'mod+b': (e) => {
      // Handle hotkey
    }
  },
  // Define plugin operations
  onBeforeOperation: (payload) => {
    // Handle before operation
  },
  // ... other operations
});
```

### Block Definitions

Blocks are the fundamental building blocks of the editor. They can be paragraphs, headings, lists, or any custom block type.

| Option              | Type                             | Description                                                                                                                                                                                                                                | Example Use Case                                                   |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `snippet`           | `Snippet`                        | Svelte snippet for rendering the block                                                                                                                                                                                                     | Defining how a code block renders with syntax highlighting         |
| `element`           | `string` / `object` / `Function` | The block element the core renders (`'li'`, `{tag, attributes}`, or a function of `data`; default `div`); the snippet renders inner markup only                                                                                            | `element: 'blockquote'`                                            |
| `viewState`         | `string[]`                       | Attributes the browser owns on the block element (never inverted)                                                                                                                                                                          | `['open']` on a native toggle                                      |
| `rendersContent`    | `boolean`                        | `false` when the kind renders no content slot (a list container); such a block has no caret stop                                                                                                                                           | `ordered-list`                                                     |
| `defaultChild`      | `string`                         | The kind a new child of this block takes (Enter at a list item's end, a merged-out island)                                                                                                                                                 | `defaultChild: 'list-item'`                                        |
| `void`              | `boolean`                        | If true, block is not editable but can have editable captions                                                                                                                                                                              | Image blocks with editable captions                                |
| `island`            | `boolean`                        | If true, block is editable but structurally isolated                                                                                                                                                                                       | Code blocks that should be merged with other blocks                |
| `presets`           | `Array`                          | Ways to create the kind: `{label, icon?, keywords?, data?, markdown?}` each; the slash menu, markdown shortcuts and block menus (`edytor.kinds`) are generated from them (command id `block.<type>`, numbered from 1 with several presets) | `{ label: 'Heading 2', data: { level: 'h2' }, markdown: ['## '] }` |
| `empty`             | `object`                         | Content and children a conversion into the kind replaces the block's own with                                                                                                                                                              | A code block starting with one empty code line                     |
| `html` / `plain`    | `string` / `Function`            | Clipboard export forms (a tag wrapping content then children, or a function of the block and its serialized content and children); default `<p>` and text lines                                                                            | `html: 'blockquote'`                                               |
| `parse`             | `(element) => data \| undefined` | HTML import: the block's data when a pasted element is this kind (checked before the tag tables, which come from `presets` and `html`/`element`)                                                                                           | `(el) => el.matches('ol > li') ? {} : undefined`                   |
| `transformText`     | `Function`                       | Transform text content within the block                                                                                                                                                                                                    | Adding syntax highlighting to code blocks in real-time             |
| `onFocus`           | `Function`                       | Called when block receives focus                                                                                                                                                                                                           | Showing a toolbar when focusing a heading block                    |
| `onBlur`            | `Function`                       | Called when block loses focus                                                                                                                                                                                                              | Make an indicator disapear                                         |
| `onSelect`          | `Function`                       | Called when block is selected                                                                                                                                                                                                              | Showing resize handles when selecting an image block               |
| `onDeselect`        | `Function`                       | Called when block is deselected                                                                                                                                                                                                            | Hiding UI controls when deselecting a block                        |
| `normalizeContent`  | `Function`                       | Normalize block content after operations                                                                                                                                                                                                   | Ensuring list items always start with a bullet point               |
| `normalizeChildren` | `Function`                       | Normalize block children after operations                                                                                                                                                                                                  | Ensuring table cells are properly structured                       |

### Mark Definitions

Marks are used for text formatting like bold, italic, or custom formatting.

| Option       | Type                                             | Description                                                                                                                                             | Example Use Case                              |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `tag`        | `string`                                         | The mark's element: the core renders `<tag data-edytor-mark>` and the clipboard exports the same tag; marks wrap in registration order, first innermost | `tag: 'strong'`                               |
| `attributes` | `(value) => Record<string, string \| undefined>` | The element's attributes from the mark's value (sanitize here); used for render and export alike                                                        | `(v) => ({ href: safe(v.href) })`             |
| `snippet`    | `Snippet`                                        | Custom markup, rendered inside a core `<span data-edytor-mark>` (wins over `tag` for rendering)                                                         | Rendering a code token with its own classes   |
| `edge`       | `'inclusive' \| 'exclusive' \| 'side-dependent'` | Whether typing at the mark's edge extends it (default inclusive; a link is side-dependent)                                                              | `edge: 'exclusive'`                           |
| `toolbar`    | `{label, icon}`                                  | A selection-toolbar button toggling the mark                                                                                                            | `{ label: 'Bold', icon: 'B' }`                |
| `parse`      | `(element) => value \| undefined`                | HTML import: the mark's value when a pasted element carries it (checked before the bare `tag`, which only value-less marks match)                       | `(el) => el.localName === 'b' \|\| undefined` |

### Plugin Operations

Operations allow you to hook into various editor events and modify behavior.

| Operation                | Description                                                                                     | Example Use Case                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `onBeforeOperation`      | Called before any operation is executed                                                         | Validating table cell merges before they happen    |
| `onAfterOperation`       | Called after any operation is executed                                                          | Updating a table of contents after heading changes |
| `onChange`               | Called when editor value changes                                                                | Syncing content with external storage              |
| `onSelectionChange`      | Called when selection changes                                                                   | Updating a formatting toolbar position             |
| `placeholder`            | A string, or `({type, data, focused, empty}) => string \| null`; rendered as `data-placeholder` | Showing "Type '/' for commands" in empty blocks    |
| `onEdytorAttached`       | Called when editor is attached to DOM                                                           | Initializing third-party libraries                 |
| `onBlockAttached`        | Called when a block is attached to DOM                                                          | Running some svelte action on the node             |
| `onTextAttached`         | Called when text is attached to DOM                                                             | Running some svelte action on the node             |
| `onDeleteSelectedBlocks` | Called when selected blocks are deleted                                                         | Cleaning up resources when deleting media blocks   |
| `onBeforeInput`          | Called before input is processed                                                                | Converting markdown shortcuts as you type          |
| `onCopy`                 | Called before Edytor writes clipboard data                                                      | Custom copy guards for protected blocks            |
| `onCut`                  | Called before Edytor writes and deletes clipboard data                                          | Blocking cuts inside protected content             |
| `onPaste`                | Called before Edytor handles external paste data                                                | Deserializing custom HTML into editor blocks       |

### Clipboard Contract

Edytor handles clipboard operations from the model, not by cloning rendered DOM.

- Copy and cut write `application/x-edytor-fragment`, `text/html`, and `text/plain`.
- The internal fragment is also mirrored into HTML as `data-edytor-fragment` so same-editor round trips survive clipboard implementations that strip custom MIME types.
- Paste precedence is internal MIME, embedded internal HTML fragment, a plugin's `onPaste`, external `text/html`, then `text/plain` (Shift-paste is plain text).
- External HTML (paste and drop) is parsed by the browser (`DOMParser`: inert, no script runs, nothing loads) and imported through the records, not a tag table: an element is a kind when a catalogue kind's export form or element writes its tag for a preset (`h1`–`h3` → heading level, `blockquote` → quote, `li` → bulleted item, `hr` → divider, `details` → toggle; a content-less container takes its default child's tag, so `pre` → a code block, one line per text line) or when a kind's `parse(element)` returns its data (`ol > li` → numbered item, `h4`–`h6` → `h3`); text takes a mark when the mark's `tag` matches (value-less marks) or its `parse(element)` returns a value (`b`/`i`/`del` aliases, Google Docs' styled spans, sanitized link `href`s and colors). Unknown elements degrade to paragraphs and text; whitespace collapses as the browser renders it (`<br>` is a line break inside the block). HTML that carries nothing (a comment, a `<script>`, empty elements) falls through to `text/plain`, or changes nothing without one.
- Pasted internal fragments never preserve copied block or inline-block IDs; IDs are regenerated while marks, data, children, and relative order are preserved.
- Paste, drop and programmatic fragment insertion place content with one rule (`flow.*` in `docs/editor-delete-contract.md`): one line joins the text at the caret; several lines split the block, the first joining the text before the caret and the last the text after it (`Hello|World` + `X`, `Y` → `HelloX`, `YWorld`, for internal, HTML and multi-line plain text alike); a copy of selected blocks pastes as whole blocks after the caret block.
- Copy is allowed in readonly mode. Cut and paste are ignored in readonly mode.
- Copy does not create a history entry. Cut and paste each create one undoable mutation.
- The HTML and plain flavours come from the records: each block kind's `html`/`plain`, each mark's `tag` and `attributes` (the element it renders), each inline block's `plain`; a kind without one exports as `<p>` and its text.

### Prevention in Plugin Operations

Many plugin operations and hotkeys receive a `prevent` function as part of their payload. This function is a crucial part of Edytor's plugin system that allows you to:

1. Stop the default behavior of an operation
2. Register a callback to be executed after the default operation is aborted
3. Control the flow of operations across multiple plugins

Here's how it works:

```typescript
// In a hotkey handler precent will also doest a preventDefault on the keyboard event.
hotkeys: {
  'mod+b': ({ prevent }) => {
    // Prevent default and do nothing
    prevent();

    // Or register a callback to be executed after the operation is aborted
    prevent(() => {
      // This code runs after the default operation is aborted
      // Use this to implement your custom behavior
    });
  }
}

// In an operation handler
onBeforeOperation: ({ prevent, operation, payload }) => {
  if (operation === 'splitBlock') {
    prevent(() => {
      // This callback will be executed after the default split operation is aborted
      // Implement your custom split logic here
    });
  }
}
```

When using multiple plugins, prevention follows these rules:

- If a plugin prevents an operation without providing a callback, the operation is completely stopped
- If a plugin prevents an operation with a callback, the default operation is aborted and then the callback is executed
- If multiple plugins try to prevent the same operation, only the first prevention (in plugin order) takes effect
- If a plugin doesn't call prevent(), the operation continues to the next plugin or executes the default behavior

Operations are dispatched as commands (one dispatcher per editor):

- `onBeforeOperation` runs before any write, on the command itself and on each step the command plans, under the step's documented operation name. A range deletion, for example, is shown as `deleteContentWithinSelection`, then as the `deleteContentAtRange`, `removeBlock` and `mergeBlockBackward` steps it plans; a paste or drop as `insertFlow`, then its `splitBlock`, `insertText` and `addChildBlocks` steps; a block-selection deletion as `deleteBlocks`, then one `removeBlock` per selected block.
- A `prevent()` on any of them refuses the whole command: nothing is written and no undo step is recorded. `prevent(() => …)` also runs the callback in its place. The callback is a command of its own: an operation it issues that another plugin refuses returns without writing (`edytor.dispatcher.last.status === 'refused'`), and the callback carries on.
- A command that is one document plan carries its `effect` (blocks created, removed, merged, moved, retyped, and text ranges written), so a plugin can refuse a command by what it would do, e.g. `effect?.removes.includes(protectedId)`.
- Structural editing commands are one plan each: Enter (`splitBlock`, `insertBlockAfter`, `insertBlockBefore`), Backspace/Delete merges (`mergeBlockBackward`, `mergeBlockForward`, with the children moves they plan), `nestBlock`, `unNestBlock`, `removeBlock`, `removeInlineBlock`, `deleteContentAtRange`, `setBlock` (a markdown or slash trigger removal leads the conversion in the same plan) and `insertDivider`. A command the document refuses is still shown (without steps), so a plugin can replace it.
- A payload returned for the command replaces it: the replacement is prepared again and shown to every plugin. Each plugin replaces a command at most once. A payload returned for a planned step is ignored (with a warning in development).
- Operations an operation performs internally (normalization, nested structural calls) are part of it and are not shown separately. `onAfterOperation` runs once per command, after its transaction, with the original payload.
- A readonly editor, or a document that turned read-only, refuses every mutating command. An error thrown by a hook surfaces; it is never reported as handled.

This system allows plugins to:

- Completely stop operations when needed
- Replace default behavior with custom logic
- Ensure their custom logic runs only after the default behavior is properly aborted
- Build complex features while maintaining predictable behavior

### Example: Simple Bold Mark Plugin

```svelte
<script module>
	export const boldPlugin = (editor: Edytor) => ({
		// The core renders <strong data-edytor-mark="bold"> and copies it as <strong>.
		marks: {
			bold: { tag: 'strong' }
		},
		hotkeys: {
			'mod+b': ({ prevent }) => {
				prevent(() => {
					// Do something
				});
			}
		}
	});
</script>
```

A mark whose markup a tag cannot express declares a `snippet` instead; the core renders it inside `<span data-edytor-mark>`.

### Using Plugins

To use plugins, pass them to the Edytor component. The order of the plugins is important because the plugins are executed in the order they are passed. So if two plugins are trying to render the same block, the first plugin will win. If two pluggins defined the same hotkey and prevent it, the second plugin will not be executed.

```svelte
<script>
	import { Edytor } from 'edytor';
	import { BoldPlugin, HeadingPlugin } from './plugins';

	const plugins = [BoldPlugin, HeadingPlugin];
</script>

<Edytor {plugins} />
```

## Migrating from 0.0.11

The next release is a rewrite of the editor's internals around one owner per fact (`docs/architecture-v2/`). This section lists every public change. It is a 0.0.x release: nothing keeps a compatibility shim.

### Stored documents

- **Schema generation 4** (wire word `14004`). Documents, IndexedDB containers and peers of earlier v14 development generations (1–3) are refused by the generation gate (`GenerationMismatchError`, `schema-mismatch`); re-import them. Changes behind the bumps: per-writer delete marks (a deleted block is not read as live), the replicated block nonce `n` (attribution records keyed by it), and text ownership as streams delimited by boundary items (the `slices` attribute is gone; merge claims live on `claims`).
- v13 (`yjs`) documents still import through the migration (`docs/crdt-v14-migration.md`), see "Migration" below.
- Seeds are deterministic: `createDocument({value})` and `<Edytor {value}>` write the value under a writer id hashed from the value, so two replicas seeding the same template converge, and a late identical seed never erases an edit. Missing ids are derived from that hash. Seeded blocks carry no attribution stamp (`createdBy` is absent). `BOOTSTRAP_BLOCK_ID` is gone.

### Document and CRDT API (`edytor`, `edytor/crdt/edytor`)

- **Operation results.** Every facade op and every `document.block(id)` mutator returns `OpResult` `{status: 'applied' | 'noop' | 'refused', ids, reason?}` instead of a boolean. An empty op (`insertText('')`, an empty range, `moveBlocks([])`, a same-value format) is `noop` and writes nothing; a reused child id is `refused` (`id-collision`); an absent target is `refused`. `moveBlocks` answers the moved ids in request order.
- **Two-phase operations.** `facade.prepare.<op>(…)` returns a plan (steps, effect, ids) or the refusal without writing; `facade.apply(plan)` writes it in one transaction; `facade.compose(...plans)` joins plans prepared at one version. A plan applied at another version throws. New ops: `prepare.deleteRange(start, end)`, `replaceRange`, `deleteBlocks(ids)`, `insertFlow(target, flow)`, `insertBlocks`; positions are `DocPosition {block, offset}`.
- **Liveness.** Deleting a block that is not live (already deleted, merged away, under a deleted parent) is refused (was `true`); `blockText` of a block under a deleted parent is `null`.
- **Order and capability.** New `facade.order()`, `compare(a, b)`, `next(id, policy?)`, `previous(id, policy?)` (one document order; `{sealed: true}` never enters an island it did not start in), `canPlace(ids, parent?)`, `canMerge(from, into)`, `defaultChild(parentId)`, `rendersContent(type)`.
- **Change report.** `facade.onChange(cb)` delivers one `DocChange` per commit that changed the visible document: `{added, removed, moved, meta, content, order, origin, local, version}`. A block that moves into a subtree added in the same commit is reported in `moved`/`meta`/`content`, not folded into the subtree.
- **Retired exports (D-15).** The per-block subscriber API (`subscribeBlock`, `subscribe`, `blockVersion`, `snapshot` on the facade and the index), `decorateRuns` and its types (`LocalDecoration`, `DecoratedRun`), and the "advanced internals" tier: `bindEdytorDoc`, `bindDocument`, `bindNodes`, `bindModel`, `bindRuns`, `bindIndexeddbProvider`, `bindWebsocketProvider`, `bindProviders`, `bindSync`, `bindAdmission`, `bindAttribution`, `bindBlockAttribution`, `bindMigration`, `bindLegacyReader`, `setDocRand`/`randOf`, the rank functions, `REGISTRY_KEY`, `SCHEMA`, `SCHEMA_NAME`, the attribution root constants, `migrationBcRoom`, `PREFERRED_TRIM_SIZE`, `GENERATION_PREFIX`, `generationDbName`, `GENERATION_KEY`, `writeProtocolVersion`, `removeAwarenessStates`, `outdatedTimeout`, `readAuthMessage`, and their types. Use `bindCrdt(Y)` (`.doc`, `.providers`, `.migration`, `.sync`, `.admission`, `.attribution`) for engine injection, `facade.onChange` + `facade.runs(id)` for reads, and a kind's `transformText` for local decorations.
- **Kept for a server coordinator** (README "Server coordinator"; `edytor/cloudflare` is built on them): `bindCrdt(Y)`, `SCHEMA_VERSION`, `META_KEY`, `GENERATION`, `generationWord`, `frame`, `PROTOCOL_VERSION`, `readProtocolVersion`, `GENERATION_RECORD`, `GenerationMismatchError`, the message types, the lib0 frame helpers, the awareness codec (`readAwarenessEntries`, `writeAwarenessEntries`, `applyAwarenessUpdate`, `encodeAwarenessUpdate`, `modifyAwarenessUpdate`) and `messagePermissionDenied`/`writePermissionDenied`. New: `messageSaved`, `messageChunk`, `MAX_FRAME_BYTES`, `chunkFrame`, `createChunkReader`.
- **Raw engine exports pruned (`edytor/crdt`, `UPSTREAM.md` P8).** Edytor never called these; they are removed from the vendored engine: the renderers (`AttributionsRenderer`, `createAttributionsRenderer`, `DiffRenderer`, `createDiffRenderer`, `SnapshotRenderer`, `createSnapshotRenderer`; `AbstractRenderer` and `$renderer` stay), snapshots (`Snapshot`, `snapshot`, `createSnapshot`, `emptySnapshot`, `createDocFromSnapshot`, `encodeSnapshot(V2)`, `decodeSnapshot(V2)`, `equalSnapshots`, `snapshotContainsUpdate`, `nodeMapGetSnapshot`, `nodeMapGetAllSnapshot`, and the `snapshot` argument of `node.getAttrs`), update helpers (`logUpdate(V2)`, `obfuscateUpdate(V2)`, `diffUpdate` — `diffUpdateV2` stays —, `encodeStateVectorFromUpdate(V2)`, `convertUpdateFormatV1ToV2`, `createContentIdsFromUpdate(V2)`, `intersectUpdateWithContentIds(V2)`, `readUpdate`, `createDocFromUpdate(V2)`, `cloneDoc`, `diffDocsToDelta`, `logNode`), the delta-position helpers (`createRelativePositionsFromDeltaPositions`, `createDeltaPositionsFromRelativePositions`, `createRelativePositionFromDeltaPosition`, `createDeltaPositionFromRelativePosition`), the binary relative-position codec and comparison (`encodeRelativePosition`, `decodeRelativePosition`, `compareRelativePositions`; use `relativePositionToJSON`/`createRelativePositionFromJSON`), id-set/id-map algebra (`gcIdSet`, `createInsertSetFromStructStore`, `encodeIdSet`, `decodeIdSet`, `mergeIdMaps`, `diffIdMap`, `intersectMaps`, `filterIdMap`, `createIdMapFromIdSet`, `createIdSetFromIdMap`, `$idMap`), content-id helpers (`createContentIds`, `createContentIdsFromContentMap`, `createContentIdsFromDoc`, `createContentIdsFromDocDiff`, `excludeContentIds`, `excludeContentMap`, `mergeContentIds`, `mergeContentMaps`, `createContentMapFromContentIds`, `intersectContentIds`, `intersectContentMap`, `filterContentMap`, `writeContentIds`, `readContentIds`, `encodeContentIds`, `decodeContentIds`), and `getNodeChildren`, `$node`, `getPathTo`, `tryGc`, `undoContentIds`. A document built with `createDocFromUpdate(u)` is `new Y.Doc()` + `Y.applyUpdate(doc, u)`; `attribution.legacy()` still returns a `ContentMap` (`encodeContentMap`/`decodeContentMap`, `encodeIdMap`/`decodeIdMap` stay) for a renderer you supply.
- **Anchors** are `{b, a}`: the `o` owner facet and the `a: -2` form are gone from the selection value, the presence wire and history entries.
- **Attribution.** Undo and redo keep a block's record (`createdBy` survives an undo/redo of its creation on every replica). A forced re-migration (`force`) gives a block whose stream started at a boundary a new nonce without moving its record, so its `createdBy` is replaced at the next attributed write.
- `facade.toJSON()` inline atoms carry `data: {}` when they have no data (the shape `edytor.value` already had).

### Editor view, selection and commands

- **Handles.** `Block`, `Text` and `InlineBlock` are id-only handles over the document index: getters read the document (inside a command they see its writes); they are **not reactive** — templates read the snippet's view object or `edytor.cells`. `new Block({block})`, `new Text({…content})` and `new InlineBlock({block})` are gone: `block.insertChildren(index, JSONBlock[] | Block[])` (a handle moves) and `block.insertParts(index, (JSONText[] | JSONInlineBlock)[])`; `deleteParts` is removed (use `deleteContentAtRange`). A `Text` is the `ordinal`-th segment of its block (`text.id` = `t:<block>:<ordinal>`) with no identity across commits; key extension state by block id and anchor. Liveness: `block.isInTree`, `text.isInDocument`, `atom.isInDocument` (`_live`, `_bound`, `_blockId`, `_segOrd`, `_items` are gone; a dead block's `parent` is `undefined`). `edytor.idToBlock` is the handle registry; `edytor.idToText` has `get` only; `edytor.idToInlineBlock`, `Edytor.getTextById`, `Block.partOffsetOf`/`atomOffsetOfPartIndex`/`projectedParts` are removed (a text's display offset is `text.segStart`, a block's parts `edytor.idToBlock.parts(id)`). `InlineBlock.type` has no setter. `Block.firstText`/`lastText` are `undefined` for a kind that renders no content.
- **Op results inside transactions.** `splitBlock`, `insertBlockAfter/Before`, `mergeBlock*`, `addInlineBlock` and `addChildBlock(s)` answer handles of what they created, also inside an outer `edytor.transact`. A vetoed `insertFlow` answers `[null, 0]`.
- **Selection is a value.** `selection.value` (`none`, `text {anchor, focus, pending?}`, `atom {blockId, atomId, from}`, `blocks {ids}`), `selection.select(value, cause)` (the only writer), `projection`, `epoch`, `cause`, `textValue`, `stage(marks)`/`pending`. `selection.state` is a read-only wrapper view of the projection (assigning it fails; use `setAtRange`, `setAtTextOffset` or `select`): `startText`, `endText`, `yStart`, `yEnd` (offsets inside the text segments), `startBlock`, `endBlock`, `texts`, `blocks` (a block set's are the selected ids), `isCollapsed`, `isReversed`, `isBlockSpanning`, `isVoidEditableElement` and `edge` (new). K5: the projection facts moved to `selection.projection` — `content` (and its `length`), `marks` (was `state.currentMarks`), `isAtStartOfText`/`isAtEndOfText`/`isAtStartOfBlock`/`isAtEndOfBlock`, `isTextSpanning`, `islandRoot`/`voidRoot` (block ids; `isIsland`/`isVoid` are `!== null`); the caret anchors are the value's (`relativePosition`/`endPosition` → `selection.value.anchor`/`focus`); `contentParts`, `startNode` and `endNode` are gone. `yTextContent` is gone. The setter families merged: `setRangeStateAtTextOffsets` → `setAtRange` (same arguments); `setCollapsedStateAtTextOffset` → `setAtTextOffset` (the old name remains as a deprecated alias). Removed: `hasSelectedAll`, `focusBlocks`, `deadEndpointRecoveryPending`, `notifyTextMounted`, `Edytor.getTextNode`, `ignoreNextSelectionChange`, `Edytor.mirrorRevision`. `setAtTextOffset` takes a `Text` (not an id) and selects in the caller's turn; the projector displays after the flush. `onSelectionChange` fires only when the value changed (a remote edit that moves the projection does not emit).
- **Pending marks** are `selection.pending` / `selection.stage(marks)` (`Text.markOnNextInsert` is gone); a move clears them, an insertion at the caret consumes them, and they hold valued marks (links, colors) as a full set.
- **Default children (D-13).** The plugin `defaultBlock` hook, `Edytor.getDefaultBlock` and `Edytor.defaultType` are removed: a kind declares `defaultChild`; `edytor.defaultChild(parent)` answers. Enter at a list item's start or end and a merged-out island take the parent's default child.
- **Deletion and paste** follow one rule each (`del.range.*`, `flow.*` in `docs/editor-delete-contract.md`): blocks after the range end inside a dying container, and a dying tail's children, survive; an emptied list container dies; a range from inside an island never merges out of it; multi-line plain paste and drop split the block per line; copied fragments keep their ids and paste always mints fresh ones.
- **Moves.** `BlockMoveRequest` is `{blocks} & ({target, position} | {direction: 'up' | 'down' | 'in' | 'out'})`; `BlockMoveDirection` and the move types come from the package root (`block/blockMove.js` is deleted). A move is its own undo step. Arrow-move never nests; `Mod+↑` moves a selected group; the handle claims every `Alt+arrow`.
- **Keymap.** `hotkeys.ts` is deleted: types move to `session/keymap` (`HotKey`, `HotKeyCombination`; `HotKeyModifier`, `Single/DoubleModifierCombination` removed); `HotKeys` → `Keymap` (`isHotkey` → `handle`, `run(chord)`, `offered`; no `init`). A `HotKey` payload's `event` is optional. Chords are canonical in any modifier order. A key binding runs once per occurrence.
- **Navigation.** Shift+Home/End/PageUp/PageDown, Mod+Shift+↑/↓ and Shift+↑/↓ move the focus and keep the anchor; word keys are visual under RTL; arrows skip a collapsed toggle's body; an atom selection carries the side it was anchored on (`from`).
- **Input and IME.** `edytor.attempts` (the input attempts) and `edytor.composition` (the session: `live`, `phase`, `host`, `owns(node)`, `ended(fn)`, `restructured(change)`) are new; `edytor.isComposing` is read-only. Removed: `compositionState`, `compositionStartReplacementState`, `hasHandledCompositionInput`, `compositionText`, `resolveCompositionRegion`, `shouldIgnoreCompositionKeyDown`, `Text.toCompositionDomOffset`, and the input-fallback flags and timers on `Edytor`. A composition is one undo step with its ending; no timer ends it; a commit that re-places the composing block (a peer deletes, retypes, moves or re-parents it) commits what the IME shows first. `onBeforeInput` no longer sees fabricated paste, drop or keydown-fallback events. `preventUnsupportedDrop(event, edytor?)`.
- **History.** `edytor.historyUndo()`/`historyRedo()` restore the selection each step recorded for this view (before on undo, after on redo); the undo-snapshot queue and its helpers are gone.

### Plugins and the extension API

- **Hooks run on the prepared command before any write (D-10).** `onBeforeOperation` sees the command, then each planned step under its documented name (`removeBlock`, `mergeBlockBackward`, `deleteContentAtRange`, `addChildBlocks`, `moveBlock(s)`, `splitBlock`, `setBlock`, `insertText`, `addInlineBlock`), with `effect` on the payload. A veto of any step refuses the whole command (zero writes, no undo step); `prevent(cb)` or a returned command replaces it once per extension; a payload returned for a nested step is ignored with a dev warning. Nested operations and normalization are not shown as operations. `onAfterOperation` fires once per command. Commands the document refuses are still shown (no steps), so an extension may replace them.
- **Operation names.** New `deleteBlocks` (`{blocks}`), `insertFlow` (`{flow, target}`, paste and drop; replaces `setBlock`/`addChildBlocks`/`insertBlockAfter`/`insertText` sub-steps), `insertDivider`; `deleteContentWithinSelection` takes `{replace}` (was `{preserveStartBlock}`); Enter's lift is `splitBlock`; markdown and slash conversions are `setBlock` with a `deleteContentAtRange` step; word deletes are `deleteContentAtRange`; handle in/out are `moveBlock`. Browser-typed text is adopted as `insertText`/`deleteContentAtRange` and can be vetoed (the text re-renders).
- **Errors.** Top-level operations report `refused` (`edytor.dispatcher.last.status`) instead of throwing `PreventionError`; text operations refuse in readonly; a read-only (quarantined) document refuses instead of throwing `SchemaMismatchError`; async handler errors are reported, not swallowed.
- **Normalization** (`normalizeContent`/`normalizeChildren`) runs at the end of the command's transaction, inside it, with handles that read the command's writes (at most 51 passes per normalizer and block); its work is part of the same update and undo step.
- **Definitions: first wins** (was last): an extension that extends another's definition lists itself first.
- **Kind records.** `BlockDefinition` gains `element`, `viewState`, `rendersContent`, `defaultChild`, `presets`, `empty`, `html`, `plain`; `snippet` is optional. `MarkDefinition` gains `edge`, `toolbar` (and `tag`/`attributes`, phase 2); `InlineBlockDefinition` gains `plain`. `convertToKind`, `KindRow`, `KindPreset` are exported; `edytor.kinds` is the catalogue the slash menu, markdown shortcuts and menus read. One label per kind (`Text`, `To-do list`, `Toggle list`).
- **Snippets render inner markup.** The core renders, registers and marks void the block element (`use:block.attach` and `BlockView.attach`/`InlineBlockView.attach` are removed; `use:block.void` still marks inner chrome). Block snippets receive `block: BlockView` = `{id, type, data, selected, focused, handle, void}`; inline-atom snippets `block: InlineBlockView` = `{id, type, data, selected, handle}` (`handle` is `undefined` for a suggested atom). Commands and document reads go through `block.handle`. `onBlockAttached` runs once per element. Identity attributes are declarative (present in server-rendered HTML).
- **`transformText`** receives declared values `{text: {stringContent, value}, block: {id, type, data}, content}`, not handles.
- **Marks at insertion** follow one rule (explicit → a replaced range's common marks → pending → the neighbour → the mark's `edge`); `insertText` without marks resolves them by that rule; plain paste inherits the caret's marks; the rich-text plugin no longer intercepts `insertText` for links; Mod+B at the start of a bold run toggles bold off.
- **Suggestions.** `Block.suggestions` is plain JSON parts (`rawSuggestions` and the readonly Proxy wrappers are removed); `suggestText` stores `[atom, [text runs]]` groups.
- **HTML import is core.** The HTML paste plugin (never exported) and its hand-written parser are gone; external HTML paste and drop are imported by the core through the browser's parser and the records (`parse` hooks on kind and mark records; see the clipboard contract). A plugin's `onPaste` still runs first. The code plugin sets `Prism.manual = true`: Prism never highlights the page on its own.
- Other: the slash menu claims Enter only with a match; the code plugin's Shift+Enter runs `insertParagraph` as an intent and its auto-pair is a returned payload (after-hooks see the typed character).

### Rendering, placeholder and chrome

- `placeholder` (prop, option, plugin) is a string or `(view: {type, data, focused, empty}) => string | null`; the snippet form is gone. It renders as `data-placeholder` on the empty text element with a shipped `::before` rule (style `[data-placeholder]::before`); `[data-edytor-text-placeholder]` and its click handlers are gone. `edytor.placeholderRepair` is removed; `edytor.placeholderAt(id)` is new.
- Chrome lives in `[data-edytor-overlay]`, a sibling after the host: block handles (in document order), the drop indicator (`position: absolute`, not in `document.body`), menus (`position: fixed` inside the layer) and layer-relative remote carets. `--edytor-handle-offset-y` is gone. `edytor.overlay` (`layer`, `add(measure)`, `invalidate()`) is new.
- Typing, formatting, Tab and block moves never remount the element under the caret; a moved block's element is re-created where it moved. `edytor.cells`, `edytor.pin`, `edytor.surface` (the DOM observer), `edytor.projector`, `textAt`, `atomAt`, `segmentOf`, `deltasOf` are new; `refreshEditorDom`/`editorDomRevision` are removed.
- The DOM observer restores what the editor owns and leaves an extension's markup around the slots alone (D-25): a foreign node inside a block's text run is removed, a node beside it stays; foreign text inside a content is adopted; attributes the core does not own (an extension's `id` on a block element, `open` on a toggle) are never reverted.
- A "`[data-edytor-block]` exists" check no longer means hydrated; wait for a registered text element.
- **Marks by tag (phase 2, P2.7).** A mark record declares `tag` (and `attributes` from its value); the core renders the tag itself as the mark element (`<strong data-edytor-mark="bold">`, was `<span data-edytor-mark="bold"><b>`), and the clipboard exports the same element. `MarkDefinition.html` is replaced by `tag`/`attributes`; `snippet` is optional (a snippet still renders inside a core `<span data-edytor-mark>`). Built-ins: bold `strong`, italic `em`, underline `u`, strike `s`, code `code`, link `a` (sanitized `href`, `target`), superscript `sup`, subscript `sub`, color and highlight `span` with a sanitized `style`; links, colors and highlights now export their element (they exported text only). Selectors such as `[data-edytor-mark="link"] a` become `a[data-edytor-mark="link"]`.

### Collaboration and providers

- **Presence wire (D-16).** `selections[viewKey] = {start, end, collapsed, reversed, t}` for text (`DocAnchor`s), `{blocks, t}` for a block set, `{atom, block, t}` for an atom; the legacy `selection` mirror, `startTextId`/`yStart` fields and numeric fallbacks are gone. A view writes only its own key and clears it on destroy. `publishPresence` replaces `createAwarenessSelection`/`publishAwarenessSelection`/`clearAwarenessSelection`; `attachDocumentSync` is removed (use `document.attachSync`).
- **`WebsocketProvider`**: removed the `protocols` option and field (pass tokens in `params`, read at every dial), the `sync` event (use `synced`), `wsconnecting` (the `status` event carries it), the BroadcastChannel leg (`disableBc`, `bcconnected`, `bcChannel`, `connectBc()`, `disconnectBc()`) — stack `createIndexeddbSync` for cross-tab sync — and the settle window (`syncSettleMs`). `resyncInterval` stays a provider option only. `createWebsocketSync` takes `serverUrl`, `roomName`, `params`, `maxBackoffTime`, `WebSocketPolyfill` (`connect`, `protocols`, `resyncInterval`, `disableBc` removed).
- **`edytor/cloudflare` (new).** `DocumentRoom` (the Durable Object room, one per document) and `routeDocumentSocket(request, namespace, documentId, authorize)` replace the coordinator you wrote yourself (README "Server coordinator"). The room binds `{user, replica, readOnly}` to each socket and refuses updates under another user's client ids.
- **Store-before-ack and chunked catch-up.** `WebsocketProvider` gains `saved`, `unsaved` and a `'saved'` event (the room's `messageSaved` acknowledgements), and reassembles `messageChunk` sequences (frames above 32 MiB). A server that sends neither leaves `unsaved` counting; older clients report the two new message types through `'message-error'` and are otherwise unaffected on small documents.
- **`IndexeddbPersistence`**: `get`/`set`/`del` are removed (the `custom` store holds only the generation record).
- **Readiness.** The document decides readiness itself: `syncFailed`, `onSyncSettled` and `EdytorDocSyncPendingError` are gone; a lone first client is ready after `DEFAULT_READINESS_BOUND` (1 s, per factory `EdytorSync.bound`; IndexedDB always settles); `history` refuses while `pending`. `whenSynced` exists on both providers and `synced` is the lifetime claim.
- **One provider per target.** `EdytorSync.target` (`indexeddb:<name>`, `websocket:<server>/<room>`); attaching a target already attached is a no-op returning nothing; attaching on a destroyed document throws `DocumentDestroyedError`.
- **Admission.** Unversioned content is not refused at ingress: the document is read-only and quarantined until admission accepts it (`document.writable`, `onWritableChange`).

### Migration

- `MigrationRecord` loses `owner` and `leaseUntil` and is never stored `pending`; `MigrateOptions.leaseMs/owner/pollMs/waitMs` and `waitForSettled`'s options are accepted no-ops (a crash-released `navigator.locks` lock arbitrates; `status()` reports `pending`, `wait: false` returns `busy`). `MigrationPhase` loses `activate`/`announce`; there are no BroadcastChannel migration announcements. `force` restores legacy ids in place instead of overwriting a snapshot row; `result.update` is the full migrated state; a foreign-generation container makes `migrate` throw `GenerationMismatchError`. `bindCrdt(Y).doc.restore` is new.

## Testing

I'm welcome to any contribution to improve the testing.
In the end, every block operation should be tested.
I've implemented a custom jsx parser to simplify testing the editor.

So instead of defining the value as a json object, you can define the value as a jsx element.

```html
<root>
	<paragraph>Hello, World!</paragraph>
</root>
```

is the same as

```json
{
	"type": "root",
	"children": [{ "type": "paragraph", "content": [{ "text": "Hello, World!" }] }]
}
```

You can also add one or two cursors with the `|` character into the jsx in order to simulate the cursor position

```jsx
<root>
	<paragraph>Hello, |World!|</paragraph>
</root>
```

I've also implemented the `createTestEdytor` that help with creating an edytor instance from a jsx element in order to test various operations on a virtual edytor and test the expected output.

```jsx
test('split text', () => {
	const { edytor, expect } = createTestEdytor(
		<root>
			<paragraph>Hello, |World!</paragraph>
		</root>
	);

	edytor.selection.state.startBlock?.splitBlock({
		index: edytor.selection.state.yStart,
		text: edytor.selection.state.startText
	});

	expect(
		<root>
			<paragraph>Hello, </paragraph>
			<paragraph>World!</paragraph>
		</root>
	);
});
```

### Writing plugins
