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

The sync helpers pass Edytor's `awareness` instance into the provider. Set local user metadata on the editor awareness state:

```ts
edytor.awareness.setLocalStateField('user', {
	name: 'Ada',
	color: '#dc2626'
});
```

Remote cursor and expanded selection overlays render from awareness `selection` state. Edytor publishes its own local selection into awareness when the selection changes.

Unsupported collaboration surfaces:

- Edytor does not provide authentication.
- Edytor does not provide document permissions or authorization rules.
- Edytor does not provide hosted websocket infrastructure.
- Edytor does not guarantee hosted persistence durability; IndexedDB persistence is local browser storage.

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

| Option              | Type       | Description                                                   | Example Use Case                                           |
| ------------------- | ---------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `snippet`           | `Snippet`  | Svelte snippet for rendering the block                        | Defining how a code block renders with syntax highlighting |
| `void`              | `boolean`  | If true, block is not editable but can have editable captions | Image blocks with editable captions                        |
| `island`            | `boolean`  | If true, block is editable but structurally isolated          | Code blocks that should be merged with other blocks        |
| `transformText`     | `Function` | Transform text content within the block                       | Adding syntax highlighting to code blocks in real-time     |
| `onFocus`           | `Function` | Called when block receives focus                              | Showing a toolbar when focusing a heading block            |
| `onBlur`            | `Function` | Called when block loses focus                                 | Make an indicator disapear                                 |
| `onSelect`          | `Function` | Called when block is selected                                 | Showing resize handles when selecting an image block       |
| `onDeselect`        | `Function` | Called when block is deselected                               | Hiding UI controls when deselecting a block                |
| `normalizeContent`  | `Function` | Normalize block content after operations                      | Ensuring list items always start with a bullet point       |
| `normalizeChildren` | `Function` | Normalize block children after operations                     | Ensuring table cells are properly structured               |
| `schema`            | `any`      | Schema for synchronization state data                         | Defining the structure of a table block's metadata         |

### Mark Definitions

Marks are used for text formatting like bold, italic, or custom formatting.

| Option    | Type      | Description                           | Example Use Case                                          |
| --------- | --------- | ------------------------------------- | --------------------------------------------------------- |
| `snippet` | `Snippet` | Svelte snippet for rendering the mark | Rendering highlighted text with a custom background color |

### Plugin Operations

Operations allow you to hook into various editor events and modify behavior.

| Operation                | Description                                            | Example Use Case                                   |
| ------------------------ | ------------------------------------------------------ | -------------------------------------------------- |
| `onBeforeOperation`      | Called before any operation is executed                | Validating table cell merges before they happen    |
| `onAfterOperation`       | Called after any operation is executed                 | Updating a table of contents after heading changes |
| `onChange`               | Called when editor value changes                       | Syncing content with external storage              |
| `onSelectionChange`      | Called when selection changes                          | Updating a formatting toolbar position             |
| `placeholder`            | Define placeholder content for empty blocks            | Showing "Type '/' for commands" in empty blocks    |
| `onEdytorAttached`       | Called when editor is attached to DOM                  | Initializing third-party libraries                 |
| `onBlockAttached`        | Called when a block is attached to DOM                 | Running some svelte action on the node             |
| `onTextAttached`         | Called when text is attached to DOM                    | Running some svelte action on the node             |
| `defaultBlock`           | Define default block type when a new one is inserted   | Using different default blocks based on context    |
| `onDeleteSelectedBlocks` | Called when selected blocks are deleted                | Cleaning up resources when deleting media blocks   |
| `onBeforeInput`          | Called before input is processed                       | Converting markdown shortcuts as you type          |
| `onCopy`                 | Called before Edytor writes clipboard data             | Custom copy guards for protected blocks            |
| `onCut`                  | Called before Edytor writes and deletes clipboard data | Blocking cuts inside protected content             |
| `onPaste`                | Called before Edytor handles external paste data       | Deserializing custom HTML into editor blocks       |

### Clipboard Contract

Edytor handles clipboard operations from the model, not by cloning rendered DOM.

- Copy and cut write `application/x-edytor-fragment`, `text/html`, and `text/plain`.
- The internal fragment is also mirrored into HTML as `data-edytor-fragment` so same-editor round trips survive clipboard implementations that strip custom MIME types.
- Paste precedence is internal MIME, embedded internal HTML fragment, a plugin's `onPaste`, then `text/plain`.
- HTML import was retired: external `text/html` pastes and drops as its `text/plain`. Handle `onPaste` to import HTML.
- Pasted internal fragments never preserve copied block or inline-block IDs; IDs are regenerated while marks, data, children, and relative order are preserved.
- Paste, drop and programmatic fragment insertion place content with one rule (`flow.*` in `docs/editor-delete-contract.md`): one line joins the text at the caret; several lines split the block, the first joining the text before the caret and the last the text after it (`Hello|World` + `X`, `Y` → `HelloX`, `YWorld`, for internal, HTML and multi-line plain text alike); a copy of selected blocks pastes as whole blocks after the caret block.
- Copy is allowed in readonly mode. Cut and paste are ignored in readonly mode.
- Copy does not create a history entry. Cut and paste each create one undoable mutation.
- Clipboard serialization is currently core-owned. Plugin-specific serializers are intentionally deferred until there is a second concrete plugin need.

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
		marks: {
			bold: {
			snippet: bold
		}
	},
	hotkeys: {
		'mod+b': ({prevent}) => {
			prevent(()=>{
				// Do something
			});
		}
	}
});
</script>

{#snippet bold({content}: MarkSnippetPayload)}
	<strong>{@render content()}</strong>
{/snippet}
```

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
