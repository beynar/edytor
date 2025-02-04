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
    <a href="#documentation">Docs</a> •
    <a href="#examples">Examples</a> •
    <a href="#contributing">Contributing</a>
  </p>
</div>

## ✨ Features

- 🎨 **Rich Text Formatting**: Full support for text styling including bold, italic, underline, strikethrough, and more
- 📑 **Block Elements**: Paragraphs, headings, lists, and custom blocks
- 🤝 **Real-time Collaboration**: Built-in support for collaborative editing using Y.js
- 🔌 **Plugin System**: Extensible architecture for custom features
- ⚡ **High Performance**: Optimized for large documents
- 📱 **Responsive**: Works great on both desktop and mobile
- ♿ **Accessible**: Built with accessibility in mind
- 🎯 **Framework Agnostic**: Core can be used with any framework
- 🔄 **Undo/Redo**: Built-in history management
- 🎯 **TypeScript**: Full type safety and IntelliSense support
- 🔒 **Secure**: No dangerous HTML injection
- 📦 **Lightweight**: Small bundle size with tree-shaking support

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
		provider.on('sync', synced);
	}}
	plugins={[CollaborationPlugin]}
/>
```

## 🎯 Examples

### Basic Examples

- [Simple Editor](examples/simple.md)
- [With Plugins](examples/plugins.md)
- [Custom Styling](examples/styling.md)
- [Read-only Mode](examples/readonly.md)

### Advanced Examples

- [Collaborative Editing](examples/collaboration.md)
- [Custom Plugins](examples/custom-plugin.md)
- [Image Upload](examples/image-upload.md)
- [Table Support](examples/tables.md)
- [Mobile Support](examples/mobile.md)

## 🔧 Internal Architecture

### Core Components

The editor is built on three main components that work together:

1. **Document Structure**

   ```typescript
   class Edytor {
   	doc: Y.Doc; // Y.js document for collaboration
   	children: Block[]; // Root blocks
   	selection: EdytorSelection; // Selection management
   	plugins: InitializedPlugin[]; // Active plugins
   	marks: Map<string, Snippet>; // Available mark renderers
   	blocks: Map<string, Snippet>; // Available block renderers
   }
   ```

2. **Block Management**

   ```typescript
   class Block {
   	yBlock: YBlock; // Y.js block data
   	content: Text; // Block's text content
   	children: Block[]; // Nested blocks
   	parent: Block | Edytor; // Parent reference
   	type: string; // Block type (paragraph, heading, etc)
   }
   ```

3. **Text Operations**
   ```typescript
   class Text {
   	yText: Y.Text; // Y.js text content
   	parent: Block; // Parent block
   	children: JSONDelta[]; // Text fragments with marks
   	markOnNextInsert?: Record<string, any>; // Pending marks
   }
   ```

### Key Features

1. **Selection Engine**

   - Tracks cursor and selection state
   - Handles block and text selection
   - Manages selection restoration during collaboration
   - Supports triple-click text selection

2. **Input Handling**

   - Manages text insertion and deletion
   - Handles block splitting and merging
   - Processes keyboard shortcuts
   - Supports paste operations

3. **Plugin System**
   - Provides hooks for text and block operations
   - Allows custom mark and block renderers
   - Supports keyboard shortcut customization
   - Enables feature extension

### Data Flow

1. **Text Operations**

   ```typescript
   // Example: Inserting text
   text.insertText({
     value: string,
     start?: number,
     end?: number,
     marks?: Record<string, any>
   });

   // Example: Marking text
   text.markText({
     mark: string,
     value?: any,
     toggle?: boolean,
     start?: number,
     end?: number
   });
   ```

2. **Block Operations**

   ```typescript
   // Example: Splitting blocks
   block.splitBlock({ index: number });

   // Example: Merging blocks
   block.mergeBlockForward();
   block.mergeBlockBackward();
   ```

3. **Event Handling**
   ```typescript
   // Input events
   onBeforeInput(event: InputEvent) {
     switch (event.inputType) {
       case 'insertText':
       case 'deleteContentForward':
       case 'deleteContentBackward':
       case 'insertParagraph':
       // ... handle each case
     }
   }
   ```

### Collaborative Features

The editor uses Y.js for real-time collaboration:

- Document changes are synchronized using CRDT
- Selection state is preserved during updates
- Undo/redo history is maintained
- Changes are batched in transactions

### Performance

1. **Reactivity**

   - Uses Svelte's fine-grained reactivity
   - Updates only changed components
   - Batches related operations

2. **Memory Management**
   - Cleans up text observers
   - Manages block references
   - Handles DOM node cleanup

### Current Limitations

1. **Text Spanning**

   - Complex text spanning operations are not fully implemented
   - Some multi-block operations need improvement

2. **Block Operations**

   - Nested block operations could be enhanced
   - Some edge cases in block merging need attention

3. **Selection**
   - Complex selection across blocks needs improvement
   - Some selection restoration cases need handling

## 🛠️ Development

### Setup

```

```
