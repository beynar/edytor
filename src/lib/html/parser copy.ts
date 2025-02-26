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

export interface HTMLNodeInterface {
	tagName: string;
	attributes: { [key: string]: string };
	children: HTMLNodeInterface[];
	isSelfClosing: boolean;
	content?: string;
	parent: HTMLNodeInterface | null;

	html(): string;
	text(): string;
}

class HTMLNode implements HTMLNodeInterface {
	tagName: string;
	attributes: { [key: string]: string };
	children: HTMLNodeInterface[];
	content?: string;
	isSelfClosing: boolean;
	parent: HTMLNodeInterface | null;

	constructor(
		tagName: string,
		attributes: { [key: string]: string },
		children: HTMLNodeInterface[],
		content?: string
	) {
		this.tagName = tagName;
		this.attributes = attributes;
		this.children = children;
		this.content = content ? decodeHTMLEntities(content) : content;
		this.isSelfClosing = false;
		this.parent = null;

		// Set parent reference for children
		for (const child of this.children) {
			if (child instanceof HTMLNode) {
				child.parent = this;
			}
		}
	}

	html(): string {
		let innerHTML = this.content || '';
		for (const child of this.children) {
			innerHTML += child.html();
		}

		if (this.isSelfClosing) {
			return `<${this.tagName} />`;
		}

		return `<${this.tagName}>${innerHTML}</${this.tagName}>`;
	}

	text(): string {
		// Return content directly without trimming to preserve whitespace
		const nodeText = this.content || '';
		let childrenText = '';

		for (const child of this.children) {
			childrenText += child.text();
		}

		return nodeText + childrenText;
	}

	static create(input: string): HTMLNodeInterface[] {
		const tokens = HTMLNode.tokenize(input);

		const nodes: HTMLNodeInterface[] = [];
		const stack: HTMLNode[] = [];

		let currentNode: HTMLNode | null = null;
		let currentContent: string = '';

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];

			switch (token.type) {
				case TokenType.TAG_OPEN:
					if (currentNode) {
						// Store content without trimming to preserve whitespace
						currentNode.content = currentContent;
						currentContent = '';
						stack.push(currentNode);
					}

					currentNode = new HTMLNode(token.value, {}, []);
					break;
				case TokenType.ATTRIBUTE_NAME:
				case TokenType.ATTRIBUTE_VALUE:
					// Skip attributes as per requirement
					break;
				case TokenType.TAG_CLOSE:
				case TokenType.SELF_CLOSING_TAG:
					if (!currentNode) {
						break;
					}

					currentNode.isSelfClosing = token.type === TokenType.SELF_CLOSING_TAG;

					if (!currentNode.content) {
						currentNode.content = currentContent;
					} else {
						currentNode.content += currentContent;
					}

					currentContent = '';
					if (stack.length > 0) {
						const parentNode = stack[stack.length - 1];
						currentNode.parent = parentNode;
						parentNode.children.push(currentNode);
					} else {
						nodes.push(currentNode);
					}
					currentNode = stack.pop() || null;
					break;
				case TokenType.TEXT:
					if (currentNode) {
						currentContent += token.value;
					}
					break;
			}
		}

		// Special case for malformed HTML where we have unclosed tags
		if (currentNode && stack.length === 0) {
			nodes.push(currentNode);
		}

		return nodes;
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
