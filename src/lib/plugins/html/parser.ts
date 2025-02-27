// This was heavily inspired by https://github.com/brideo/dom-parser-mini/blob/main/src/parser.test.ts
// And heavily modified by me and the Claude to fit our edytor use case

enum TokenType {
	TEXT,
	TAG_OPEN,
	TAG_CLOSE,
	ATTRIBUTE_NAME,
	ATTRIBUTE_VALUE,
	SELF_CLOSING_TAG
}

interface Token {
	type: TokenType;
	value: string;
}

const selfClosingTags = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'source',
	'track',
	'wbr'
]);

// Common HTML entities mapping
const htmlEntities: { [key: string]: string } = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&apos;': "'",
	'&nbsp;': ' ',
	'&copy;': '©',
	'&reg;': '®',
	'&trade;': '™',
	'&mdash;': '—',
	'&ndash;': '–',
	'&euro;': '€',
	'&pound;': '£',
	'&yen;': '¥',
	'&cent;': '¢'
};

// Function to decode HTML entities
function decodeHTMLEntities(text: string): string {
	if (!text) return '';

	// Handle named entities first
	let result = text;
	for (const [entity, value] of Object.entries(htmlEntities)) {
		result = result.replace(new RegExp(entity, 'g'), value);
	}

	// Handle numeric entities
	result = result.replace(/&#(\d+);/g, (_, dec) => {
		return String.fromCodePoint(parseInt(dec, 10));
	});

	// Handle hex entities
	result = result.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
		return String.fromCodePoint(parseInt(hex, 16));
	});

	return result;
}

// Simple classification for HTML elements by tag name
export interface ElementSets {
	blocks: Set<string>;
	marks: Set<string>;
	inlineBlocks: Set<string>;
}

export interface HTMLNodeInterface {
	tagName: string;
	attributes: { [key: string]: string };

	// Separate arrays for block-level children and inline content
	children: HTMLNodeInterface[]; // Block-level child elements
	content: HTMLNodeInterface[]; // Inline content elements

	// Text content of this node
	textContent?: string;

	isSelfClosing: boolean;
	parent: HTMLNodeInterface | null;

	// Node classification properties
	isBlock: boolean;
	isInlineBlock: boolean;
	isMark: boolean;

	html(): string;
	text(): string;
}

class HTMLNode implements HTMLNodeInterface {
	tagName: string;
	attributes: { [key: string]: string };
	children: HTMLNodeInterface[];
	content: HTMLNodeInterface[];
	textContent?: string;
	isSelfClosing: boolean;
	parent: HTMLNodeInterface | null;

	isBlock: boolean;
	isInlineBlock: boolean;
	isMark: boolean;

	constructor(tagName: string, attributes: { [key: string]: string }, textContent?: string) {
		this.tagName = tagName;
		this.attributes = attributes;
		this.children = [];
		this.content = [];
		this.textContent = textContent ? decodeHTMLEntities(textContent) : textContent;
		this.isSelfClosing = false;
		this.parent = null;

		// These will be properly set later based on element sets
		this.isBlock = false;
		this.isInlineBlock = false;
		this.isMark = false;
	}

	html(): string {
		let innerHTML = this.textContent || '';

		// Add inline content HTML
		for (const inlineElement of this.content) {
			innerHTML += inlineElement.html();
		}

		// Add block children HTML
		for (const child of this.children) {
			innerHTML += child.html();
		}

		if (this.tagName === '') {
			// For unwrapped nodes, just return the inner content
			return innerHTML;
		}

		if (this.isSelfClosing) {
			return `<${this.tagName} />`;
		}

		return `<${this.tagName}>${innerHTML}</${this.tagName}>`;
	}

	text(): string {
		// Special handling for <br> tags - return newline
		if (this.tagName === 'br') {
			return '\n';
		}

		// Return content directly without trimming to preserve whitespace
		const nodeText = this.textContent || '';
		let contentText = '';
		let childrenText = '';

		// Get text from inline content
		for (const inlineElement of this.content) {
			contentText += inlineElement.text();
		}

		// Get text from block children
		for (const child of this.children) {
			childrenText += child.text();
		}

		return nodeText + contentText + childrenText;
	}

	static create(input: string, elementSets?: ElementSets): HTMLNodeInterface[] {
		const tokens = HTMLNode.tokenize(input);
		const rootNodes: HTMLNodeInterface[] = [];
		let currentNode: HTMLNode | null = null;
		let stack: HTMLNode[] = [];
		let currentTextContent = '';

		const processTextContent = (node: HTMLNode) => {
			if (currentTextContent) {
				const textNode = new HTMLNode('', {}, currentTextContent);
				textNode.parent = node;
				node.content.push(textNode);
				currentTextContent = '';
			}
		};

		// Function to handle node unwrapping (moving its content to parent/root)
		const unwrapNode = (node: HTMLNode): void => {
			// For root nodes, add their content to the rootNodes
			if (!node.parent) {
				// Move content and children to root level
				for (const item of node.content) {
					item.parent = null;
					rootNodes.push(item);
				}
				for (const child of node.children) {
					child.parent = null;
					rootNodes.push(child);
				}
			} else {
				// Move all content to parent's content
				for (const item of node.content) {
					node.parent.content.push(item);
					item.parent = node.parent;
				}

				// Move block children to parent's children
				for (const child of node.children) {
					if (child.isBlock) {
						node.parent.children.push(child);
					} else {
						node.parent.content.push(child);
					}
					child.parent = node.parent;
				}

				// Remove this node from parent's collections
				if (node.parent.children.includes(node)) {
					node.parent.children = node.parent.children.filter((child) => child !== node);
				}
				if (node.parent.content.includes(node)) {
					node.parent.content = node.parent.content.filter((item) => item !== node);
				}
			}
		};

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];

			switch (token.type) {
				case TokenType.TAG_OPEN:
					// Process any pending text content if we have a current node
					if (currentNode) {
						processTextContent(currentNode);
					} else if (currentTextContent) {
						// Handle text at beginning of HTML by creating a root text node
						const rootTextNode = new HTMLNode('', {}, currentTextContent);
						rootNodes.push(rootTextNode);
						currentTextContent = '';
					}

					// Create a new node
					const tagName = token.value.toLowerCase();
					const newNode = new HTMLNode(tagName, {});

					// Determine if this is a block, mark, or inline block based on tag name
					if (elementSets) {
						newNode.isBlock = elementSets.blocks.has(tagName);
						newNode.isMark = elementSets.marks.has(tagName);
						newNode.isInlineBlock = elementSets.inlineBlocks.has(tagName) || tagName === 'br';
					}

					if (currentNode) {
						// Add new node to appropriate collection based on its type
						if (newNode.isBlock) {
							currentNode.children.push(newNode);
						} else {
							currentNode.content.push(newNode);
						}
						newNode.parent = currentNode;
						stack.push(currentNode);
					} else {
						// This is a root level node
						if (
							elementSets &&
							!newNode.isBlock &&
							!newNode.isMark &&
							!newNode.isInlineBlock &&
							tagName !== 'br'
						) {
							// For unwrapped root nodes, we'll handle them when they close
							// We set the parent to null, but don't add to rootNodes yet
						} else {
							// Keep blocks and special tags like br at root level
							rootNodes.push(newNode);
						}
					}

					currentNode = newNode;
					break;

				case TokenType.TEXT:
					// Accumulate text content
					currentTextContent += token.value;
					break;

				case TokenType.TAG_CLOSE:
				case TokenType.SELF_CLOSING_TAG:
					if (!currentNode) break;

					currentNode.isSelfClosing = token.type === TokenType.SELF_CLOSING_TAG;

					// Process any pending text content
					processTextContent(currentNode);

					// Determine if this node should be unwrapped
					const shouldUnwrap =
						elementSets &&
						!currentNode.isBlock &&
						!currentNode.isMark &&
						!currentNode.isInlineBlock &&
						currentNode.tagName !== 'br'; // Never unwrap BR tags

					if (shouldUnwrap) {
						// Unwrap this node (move its content to parent or root)
						unwrapNode(currentNode);
					}

					// Return to parent node or set current to null if at root level
					if (stack.length > 0) {
						currentNode = stack.pop() || null;
					} else {
						// If not unwrapped and not in roots already, add it now
						if (!shouldUnwrap && !rootNodes.includes(currentNode)) {
							rootNodes.push(currentNode);
						}
						currentNode = null;
					}
					break;

				case TokenType.ATTRIBUTE_NAME:
				case TokenType.ATTRIBUTE_VALUE:
					// Skip attributes as per requirement
					break;
			}
		}

		// Handle any unclosed tags at the end
		if (currentNode && stack.length === 0) {
			// Process any remaining text content
			processTextContent(currentNode);

			// Check if this node should be unwrapped
			const shouldUnwrap =
				elementSets &&
				!currentNode.isBlock &&
				!currentNode.isMark &&
				!currentNode.isInlineBlock &&
				currentNode.tagName !== 'br';

			if (shouldUnwrap) {
				unwrapNode(currentNode);
			} else if (!rootNodes.includes(currentNode)) {
				rootNodes.push(currentNode);
			}
		}

		// Handle any text that might be left after processing all tokens
		if (currentTextContent && !currentNode) {
			if (rootNodes.length > 0) {
				// Append trailing text to the last node's content
				const lastNode = rootNodes[rootNodes.length - 1];
				const trailingTextNode = new HTMLNode('', {}, currentTextContent);
				trailingTextNode.parent = lastNode;
				lastNode.content.push(trailingTextNode);
			} else {
				// If there are no nodes yet, create a new text node
				const rootTextNode = new HTMLNode('', {}, currentTextContent);
				rootNodes.push(rootTextNode);
			}
		}

		return rootNodes;
	}

	private static tokenize(input: string): Token[] {
		const tokens: Token[] = [];
		let i = 0;

		while (i < input.length) {
			if (input[i] === '<') {
				// Skip comments, doctypes, and other special elements
				if (input.slice(i, i + 4) === '<!--') {
					// Skip comment
					const commentEnd = input.indexOf('-->', i);
					if (commentEnd !== -1) {
						i = commentEnd + 3;
						continue;
					}
				} else if (input.slice(i, i + 2) === '<!') {
					// Skip DOCTYPE and other declarations
					const endBracket = input.indexOf('>', i);
					if (endBracket !== -1) {
						i = endBracket + 1;
						continue;
					}
				} else if (input.slice(i, i + 2) === '<?') {
					// Skip processing instructions like <?xml ?>
					const endPI = input.indexOf('?>', i);
					if (endPI !== -1) {
						i = endPI + 2;
						continue;
					}
				} else if (input.slice(i, i + 7).toLowerCase() === '<script') {
					// Skip script tags completely
					const scriptEnd = input.toLowerCase().indexOf('</script>', i);
					if (scriptEnd !== -1) {
						i = scriptEnd + 9; // Length of </script>
						continue;
					}
				} else if (input.slice(i, i + 6).toLowerCase() === '<style') {
					// Skip style tags completely
					const styleEnd = input.toLowerCase().indexOf('</style>', i);
					if (styleEnd !== -1) {
						i = styleEnd + 8; // Length of </style>
						continue;
					}
				} else if (input.slice(i, i + 6).toLowerCase() === '<head>') {
					// Skip head tags and their contents completely
					const headEnd = input.toLowerCase().indexOf('</head>', i);
					if (headEnd !== -1) {
						i = headEnd + 7; // Length of </head>
						continue;
					}
				} else if (input.slice(i, i + 5).toLowerCase() === '<head') {
					// Also catch head with attributes
					const endBracket = input.indexOf('>', i);
					if (endBracket !== -1) {
						const headEnd = input.toLowerCase().indexOf('</head>', endBracket);
						if (headEnd !== -1) {
							i = headEnd + 7; // Length of </head>
							continue;
						} else {
							// If no closing head tag is found, skip to the end of the opening tag
							// This helps with malformed HTML
							i = endBracket + 1;
							continue;
						}
					}
				}

				if (input[i + 1] === '/') {
					let j = i + 2;
					while (j < input.length && input[j] !== '>') j++;
					tokens.push({ type: TokenType.TAG_CLOSE, value: input.slice(i + 2, j).trim() });
					i = j + 1;
				} else {
					let j = i + 1;
					while (j < input.length && input[j] !== ' ' && input[j] !== '>' && input[j] !== '/') j++;
					const tagName = input.slice(i + 1, j).trim();

					// Skip script and style tags
					if (tagName.toLowerCase() === 'script' || tagName.toLowerCase() === 'style') {
						const closingTag = '</' + tagName.toLowerCase() + '>';
						const endTag = input.toLowerCase().indexOf(closingTag, i);
						if (endTag !== -1) {
							i = endTag + closingTag.length;
							continue;
						}
					}

					tokens.push({ type: TokenType.TAG_OPEN, value: input.slice(i + 1, j).trim() });

					while (j < input.length && input[j] !== '>') {
						if (input[j] === ' ') {
							j++;
							let attrName = '';
							while (
								j < input.length &&
								input[j] !== '=' &&
								input[j] !== ' ' &&
								input[j] !== '>' &&
								input[j] !== '/'
							) {
								attrName += input[j];
								j++;
							}

							if (attrName !== '') {
								tokens.push({
									type: TokenType.ATTRIBUTE_NAME,
									value: attrName.trim().toLowerCase()
								});
							}

							if (input[j] === '=') {
								j++;
								const quoteType = input[j];
								j++;
								let attrValue = '';
								while (j < input.length && input[j] !== quoteType) {
									attrValue += input[j];
									j++;
								}
								tokens.push({ type: TokenType.ATTRIBUTE_VALUE, value: attrValue });
								j++;
							}
						} else {
							j++;
						}
					}

					if (selfClosingTags.has(tagName.toLowerCase()) || input[j - 1] === '/') {
						tokens.push({ type: TokenType.SELF_CLOSING_TAG, value: tagName });
					}

					if (input[j] === '>') {
						j++;
					}

					i = j;
				}
			} else {
				let j = i;
				while (j < input.length && input[j] !== '<') j++;

				// Preserve all text tokens to maintain whitespace
				const textContent = input.slice(i, j);
				tokens.push({ type: TokenType.TEXT, value: textContent });
				i = j;
			}
		}

		return tokens;
	}
}

export default HTMLNode;
