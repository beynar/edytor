# Edytor 📝

<div align="center">
  <img src="assets/edytor-logo.png" alt="Edytor Logo" width="200"/>

  <p>A powerful, extensible rich text editor built with Svelte and Y.js</p>

[![npm version](https://badge.fury.io/js/edytor.svg)](https://badge.fury.io/js/edytor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)
[![Svelte v5](https://img.shields.io/badge/Svelte-v5-FF3E00.svg)](https://svelte.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)

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
- 🤝 **Real-time Collaboration**: Uses Y.js as data store, collaborative editing is built-in
- 🔌 **Plugin System**: Extensible architecture for custom features. I try to make every action performed by the editor hackable and preventable to let you build your own features.
- ⚡ **High Performance**: Optimized for large documents, fine grained update at the leaf level thanks to Y.js and Svelte's reactivity
- 🔄 **Undo/Redo**: Built-in history management
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

## ✨ Things that are not ready

- [ ] DND
- [ ] Battle tested collaborative editing + awareness + providers
- [ ] Children normalization
- [ ] Children transformation
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
