/**
 * MDX-lite tags as markdown (`toMarkdown`): a block written as
 * `<Name a="x" n={1} on={true} />`, the tag `fromMarkdown` reads back.
 */
import type { SerializableContent } from '$lib/utils/json.js';

const ATTRIBUTE = /^[A-Za-z_][\w:-]*$/;

/** A data value as an attribute, or `null` when MDX-lite has no literal for it. */
const attribute = (name: string, value: SerializableContent | undefined) => {
	if (!ATTRIBUTE.test(name)) return null;
	if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
		return `${name}={${value}}`;
	if (typeof value !== 'string' || /\n/.test(value)) return null;
	if (!value.includes('"')) return `${name}="${value}"`;
	return value.includes("'") ? null : `${name}='${value}'`;
};

/**
 * A component tag, for a kind's `markdown` form: `mdxComponent('Endpoint',
 * block.data, content, children)`. Each data value that has a literal is an
 * attribute (a string `"x"`, a number `{1}`, a boolean `{true}`); others
 * (objects, arrays, `null`, a string holding a newline or both quotes) are
 * left out. No text and no children: a self-closing tag. Text only: the
 * text inside the tag on one line. Children: the tag on its own lines, the
 * text first (a paragraph), then the children.
 */
export const mdxComponent = (
	name: string,
	data: Record<string, SerializableContent> | undefined = {},
	content = '',
	children = ''
): string => {
	const attributes = Object.entries(data)
		.map(([key, value]) => attribute(key, value))
		.filter((part) => part !== null);
	const open = `<${[name, ...attributes].join(' ')}`;
	if (!content && !children) return `${open} />`;
	if (!children) return `${open}>${content}</${name}>`;
	return `${open}>\n${[content, children].filter(Boolean).join('\n\n')}\n</${name}>`;
};
