# Edytor 📝

<div align="center">
  <img src="assets/edytor-logo.png" alt="Edytor Logo" width="200"/>

  <p>A powerful, extensible rich text editor built with Svelte and Y.js</p>

[![npm version](https://badge.fury.io/js/edytor.svg)](https://badge.fury.io/js/edytor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)
[![Svelte v4](https://img.shields.io/badge/Svelte-v4-FF3E00.svg)](https://svelte.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)

  <p>
    <a href="#features">Features</a> •
    <a href="#quick-start">Quick Start</a> •
  </p>
</div>

## ⚠️ Work in progress

Edytor is currently in the early stages of development. It is not yet ready for production use.
I welcome early contributors to help us build a better editor for Svelte.
Just run it, see what you can do with it, and open issues or PRs.

If you want to submit an issue please share the json value of the document. It will help understand and fix the issue.

## ✨ Features

- 📑 **Customizable with snippets**: Use snippets to render your own blocks and marks
- 🎨 **Rich Text Formatting**: Full support for marks, blocks and inline blocks.
- 🤝 **Real-time Collaboration**: Uses Y.js as data store, collaborative editing is built-in
- 🔌 **Plugin System**: Extensible architecture for custom features. I try to make every action performed by the editor hackable and preventable to let you build your own features.
- ⚡ **High Performance**: Optimized for large documents, fine grained update at the leaf level thanks to Y.js and Svelte's reactivity
- 🔄 **Undo/Redo**: Built-in history management
- 📦 **Lightweight**: Relatively small bundle size compared to other rich text editors
- 📦 **AI copilot ready**: Support inline text suggestions for ai completions.

## 🧠 Concepts

Edytor structure is built around this key concepts:

- **Blocks**: Container elements like paragraphs, headings, and lists
- **Content**: The content of a block is an array of inlines blocks or text and marks.
- **Children**: Children are the blocks that are directly inside a block. They allow an infinite nesting.
- **Marks**: Texts are simply text with marks that define the formatting.
- **Inline blocks**: Inline blocks are inline elements that are no editable and render custom components like footnotes, equations, etc.

Example of a document:

```jsx
<document>
	<block>
		<content>
			<text mark="bold">Hello</text>
			<text>World</text>
			<inline-block  type="footnote">
				<!-- Inline block are rendered by the user code -->
			</inline-block>
		</content>
		<children>
			<block>
				<content>
					<text>World</text>
				</content>
			</block>
			<block>
				<content>
					<text>World</text>
				</content>
				<children>
					<block>
						<content>
							<text>World</text>
						</content>
					</block>
				</children>
			</block>
		</children>
	</block>
</document>
```

### Blocks

Blocks are the container elements like paragraphs, headings, and lists.
They have a content that is an array of inlines blocks or text.
They have children that is an array of blocks.
Blocks can be nested unless they are void or inside an island

An island is a block that is editable but is structuraly stable and and isolated from the rest of the document.
It is impossible to merge an island with another block. Beside the island children it is also impossible to move another block inside an island.
You may think of an island as a block that is editable but is not completely part of the document structure and isolated from the rest of the document.

A void block is a block which does not have children or whose children are not editable and rendered outside of the edytor core logic.
Void blocks can render and edit their content anyway. That is usefull to render caption.
You may think of a void block as a block that is completely independent from the rest of the document.
Void blocks acts also like an island but are even less editables.

###

### Inlines

Inlines are the inline elements like bold, italic, and links.
They have a content property that is an array of text.
They have a type property that is a string that identifies the inline type.

## 🚀 Quick Start

### Installation

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

## 📖 Documentation

### Core Concepts

Edytor is built around three main concepts:

1. **Blocks**: Container elements like paragraphs, headings, and lists
2. **Marks**: Inline formatting like bold, italic, and links
3. **Plugins**: Extensions that add new functionality

### Available Props

| Prop          | Type                     | Default             | Description                            |
| ------------- | ------------------------ | ------------------- | -------------------------------------- |
| `value`       | `JSONDoc`                | `{ children: [] }`  | The initial document content           |
| `readonly`    | `boolean`                | `false`             | Whether the editor is read-only        |
| `plugins`     | `Plugin[]`               | `[]`                | Array of plugins to use                |
| `hotKeys`     | `Record<string, HotKey>` | `{}`                | Custom keyboard shortcuts              |
| `sync`        | `Function`               | `undefined`         | Custom sync function for collaboration |
| `class`       | `string`                 | `undefined`         | Custom CSS class                       |
| `placeholder` | `string`                 | `"Start typing..."` | Placeholder text when empty            |

### Events

| Event    | Detail Type | Description                          |
| -------- | ----------- | ------------------------------------ |
| `change` | `JSONDoc`   | Fired when the document changes      |
| `focus`  | `void`      | Fired when the editor gains focus    |
| `blur`   | `void`      | Fired when the editor loses focus    |
| `ready`  | `void`      | Fired when the editor is initialized |

### Plugins

Edytor comes with several built-in plugins:

- `RichTextPlugin`: Basic text formatting
- `MentionPlugin`: @mentions support
- `ListPlugin`: Ordered and unordered lists
- `ImagePlugin`: Image upload and display
- `TablePlugin`: Table support with cell merging
- `HistoryPlugin`: Undo/redo functionality
- And more...

Creating a custom plugin:

```typescript
import type { Plugin, EdytorInstance } from 'edytor';

interface CustomMarkData {
	color: string;
	title?: string;
}

const myPlugin: Plugin = (edytor: EdytorInstance) => {
	return {
		marks: {
			// Snippet
		},
		blocks: {
			// Snippet
		},
		hotkeys: {
			'mod+k': ({ edytor }) => {
				// Custom hotkey handler
			}
		}
	};
};
```

### Collaborative Editing

Edytor supports real-time collaboration out of the box using Y.js:

```svelte
<script>
	import { WebsocketProvider } from 'y-websocket';
	import * as Y from 'yjs';
	import { onMount, onDestroy } from 'svelte';

	let provider;

	onMount(() => {
		return () => {
			provider?.destroy();
		};
	});
</script>

<Edytor
	{doc}
	sync={({ doc, awareness, synced }) => {
		provider = new WebsocketProvider('ws://localhost:1234', 'my-document', doc);
		provider.on('sync', () => {
			synced({ provider });
		});
	}}
	plugins={[CollaborationPlugin]}
/>
```

### Current Limitations

1. **Text Spanning**

   - Complex text spanning operations are not fully implemented
   - Some multi-block operations need improvement

2. **Void Elements**

   - Void elements are not fully implemented

3. **Inline void elements**

   - No inline void elements support for now

4. **Decorations**

   - We need to implement decorations as Slate.js does.

## 🛠️ Development

### Setup

```

```
