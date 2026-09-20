# HTML Parser and Deserializer

This directory contains the HTML parsing and deserialization logic for the Edytor rich text editor. These components are responsible for converting HTML content into the editor's internal data model.

## Overview

The system consists of two main components:

1. **HTML Parser** (`parser.ts`): Transforms raw HTML strings into a tree of HTMLNode objects
2. **HTML Deserializer** (`deserialize.ts`): Converts the HTMLNode tree into the editor's internal block and mark structures

## HTML Parser (`parser.ts`)

The HTML parser is a lightweight custom implementation built specifically for our rich text editing contexts. It was inspired by [dom-parser-mini](https://github.com/brideo/dom-parser-mini) but heavily modified for the Edytor use case.

### How It Works

1. **Tokenization**: The input HTML string is tokenized into a sequence of tokens (TAG_OPEN, TAG_CLOSE, TEXT, etc.)
2. **Tree Construction**: The tokens are processed sequentially to build a tree of HTMLNode objects
3. **Node Classification**: Nodes are classified as blocks, marks, or inline blocks based on the provided ElementSets
4. **Unwrapping**: Unknown elements are unwrapped, with their content promoted to their parent or the root level

### Key Features

- **Selective Element Processing**: Only processes elements defined in the ElementSets (blocks, marks, inlineBlocks)
- **Content Filtering**: Automatically skips `<script>`, `<style>`, and `<head>` tags and their contents
- **Entity Decoding**: Automatically decodes HTML entities (`&lt;`, `&gt;`, etc.) to their corresponding characters
- **Whitespace Preservation**: Maintains original whitespace to preserve formatting
- **Self-Closing Tag Handling**: Correctly processes self-closing tags like `<br>`, `<img>`, etc.

### Edge Case Handling

The parser is designed to handle various edge cases:

- **Malformed HTML**: Recovers from common HTML errors like unclosed tags or improperly nested elements
- **Missing Brackets**: Attempts to parse HTML even when brackets are missing or malformed
- **Mixed Case Tags**: Tag names are normalized to lowercase for consistency
- **Interleaved Tags**: Handles interleaved tag structures by consolidating content
- **Duplicate Attributes**: Uses the first occurrence of an attribute when duplicates are present
- **Deeply Nested HTML**: Handles deeply nested structures without stack overflow
- **Zero-Width Spaces**: Preserves invisible characters and zero-width spaces
- **Unclosed Tags**: Automatically closes unclosed tags at the appropriate level

### Element Sets

The parser uses ElementSets to determine how to handle different HTML elements:

```typescript
export interface ElementSets {
	blocks: Set<string>; // Block-level elements (p, div, h1, etc.)
	marks: Set<string>; // Formatting elements (strong, em, u, etc.)
	inlineBlocks: Set<string>; // Inline block elements (a, img, etc.)
}
```

Elements not defined in these sets are unwrapped, with their content preserved but the tags removed.

## HTML Deserializer (`deserialize.ts`)

The deserializer converts the HTMLNode tree into the editor's internal block and mark structure.

### How It Works

1. **Node Traversal**: Recursively traverses the HTMLNode tree
2. **Element Mapping**: Maps HTML elements to the editor's internal block and mark types
3. **Text Processing**: Processes text nodes and applies appropriate marks
4. **Block Formation**: Creates block-level structures with nested content when needed

### Element mappings

`parseHtml.call(edytor, html, options)` converts known HTML tags through explicit mapping
functions. Unknown tags are unwrapped and their text/children are preserved.

Default block mappings:

| HTML tag               | Edytor block                     |
| ---------------------- | -------------------------------- |
| `p`, `pre`             | `paragraph`                      |
| `h1`                   | `heading` with `{ level: "h1" }` |
| `h2`                   | `heading` with `{ level: "h2" }` |
| `h3`, `h4`, `h5`, `h6` | `heading` with `{ level: "h3" }` |
| `blockquote`           | `quote`                          |
| `ul`, `li` inside `ul` | `bulleted-list-item`             |
| `ol`, `li` inside `ol` | `numbered-list-item`             |
| `hr`                   | `divider`                        |

Default mark mappings:

| HTML tag             | Edytor mark                                   |
| -------------------- | --------------------------------------------- |
| `strong`, `b`        | `bold`                                        |
| `em`, `i`            | `italic`                                      |
| `u`                  | `underline`                                   |
| `s`, `strike`, `del` | `strike`                                      |
| `sup`                | `superscript`                                 |
| `sub`                | `subscript`                                   |
| `mark`               | `highlight` with `yellow` data                |
| `code`               | `code`                                        |
| `a`                  | `link` with `href` and optional `target` data |

There are no default inline-block mappings. Inline blocks must be supplied explicitly.
Mapped inline blocks pasted at the top level become `$fragment` content, so they are
inserted at the current caret instead of being wrapped as standalone blocks.

### Customization

The deserializer supports customization through mapping options:

```typescript
interface HTMLDeserializeOptions {
	blocks?: { [tagName: string]: (node: HTMLNodeInterface) => { type: string; data?: unknown } };
	marks?: { [tagName: string]: (node: HTMLNodeInterface) => { type: string; data?: unknown } };
	inlineBlocks?: {
		[tagName: string]: (node: HTMLNodeInterface) => { type: string; data?: unknown };
	};
}
```

User mappings are merged with the default mappings. Tag names are normalized to lowercase.

Every default and user mapping is validated against the live editor registry before the
HTML is accepted. A block mapping must resolve to `edytor.blocks`, a mark mapping to
`edytor.marks`, and an inline-block mapping to `edytor.inlineBlocks`. Dynamic mapping
results are checked again against the actual parsed node, so attribute-driven mappings
cannot return missing editor types silently.

Parent-sensitive list mappings are validated with `li` under `ul`, `li` under `ol`,
and orphan `li` samples, so custom list-container mappings cannot hide an unsupported
list-item target until paste time.

### Edge Case Handling

The deserializer handles several edge cases:

- **Empty Elements**: Creates appropriate empty blocks for empty elements
- **Mixed Content**: Properly handles elements with mixed block and inline content
- **Deeply Nested Structures**: Maintains the hierarchy of deeply nested elements
- **Line Breaks**: Converts `<br>` tags to newline characters
- **Unknown Elements**: Treats unknown elements as text content
- **Nested Identical Elements**: Creates separate blocks for each nested element
- **Document Fragments**: Handles multiple top-level elements in document fragments

## Usage Example

```typescript
import { parseHtml } from '$lib/plugins/html/deserialize';

const blocks = parseHtml.call(edytor, '<p>This is <strong>bold</strong> text</p>', {
	inlineBlocks: {
		abbr: (node) => ({
			type: 'mention',
			data: { name: node.attributes['data-name'] }
		})
	}
});
```

## Design Decisions and Limitations

- **No DOM Dependency**: Implemented without a DOM dependency for broader compatibility
- **Lightweight**: Focuses on the essentials needed for rich text editing, not a full HTML parser
- **Content-Focused**: Prioritizes content preservation over strict HTML compliance
- **Attribute Handling**: Minimal attribute processing (mainly focused on element structure)
- **Performance**: Optimized for typical content sizes in rich text editing

### Known Limitations

- Limited attribute utilization (mainly focuses on tag structure)
- Does not fully reconstruct invalid HTML as a browser would
- Not designed for extremely large HTML documents (though it handles moderate sizes well)
- Handles simple HTML well but may not perfectly handle extremely complex or malformed structures

## Testing

The parser and deserializer are fixture-tested in:

- `src/tests/fixtures/model/parser/html-parser.fixtures.ts`
- `src/tests/fixtures/model/parser/html-deserialize.fixtures.ts`

These tests cover core functionality, edge cases, and various special scenarios.
