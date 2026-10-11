/**
 * Test-only reads and conveniences on the engine's node (UPSTREAM.md YP19).
 *
 * The fork ships the node's writes and the attribute reads edytor calls; the
 * renderings and conveniences the tests read state through (`toJSON`,
 * `toString`, `toArray`, `get`, `slice`, `getAttrs`, `hasAttr`, the attr
 * iterators, `map`, `forEach`, `push`, `unshift`, `clone`, `clearAttrs`,
 * `parent`) are
 * installed on its prototype here, by every vitest lane's setup
 * (`src/tests/setup/engine-reads.ts`), over the engine's own items. Never
 * imported by `src/lib`. Formats are not read: an edytor document holds only
 * paired marks, which the range cursor reads.
 */
import { YNode } from '../../../lib/crdt/vendor/yjs/src/ynode.js';

/** @param {any} item */
const value = (item) => item.content.getContent()[item.length - 1];

/**
 * The node's live elements: each text run (adjacent strings) as one string.
 *
 * @param {any} node
 * @return {Array<any>}
 */
const children = (node) => {
	/** @type {Array<any>} */
	const out = [];
	let text = null;
	for (let item = node._start; item !== null; item = item.right) {
		if (item.deleted || !item.countable) continue;
		const str = item.content.str;
		if (typeof str === 'string') {
			text = (text ?? '') + str;
			continue;
		}
		if (text !== null) out.push(text);
		text = null;
		out.push(...item.content.getContent());
	}
	if (text !== null) out.push(text);
	return out;
};

/**
 * The node's live units, one per index (a string's characters one by one).
 *
 * @param {any} node
 * @return {Array<any>}
 */
const units = (node) => {
	/** @type {Array<any>} */
	const out = [];
	for (let item = node._start; item !== null; item = item.right) {
		if (!item.deleted && item.countable) out.push(...item.content.getContent());
	}
	return out;
};

/** @param {any} node */
const liveAttrs = (node) => {
	/** @type {Array<[string, any]>} */
	const out = [];
	node._map.forEach((/** @type {any} */ item, /** @type {string} */ key) => {
		if (!item.deleted) out.push([key, value(item)]);
	});
	return out;
};

const reads = {
	/** @this {any} */
	toArray() {
		return children(this);
	},
	/** @this {any} @param {number} index */
	get(index) {
		return units(this)[index];
	},
	/** @this {any} @param {number} [start] @param {number} [end] */
	slice(start = 0, end = this.length) {
		return units(this).slice(start, end);
	},
	/** @this {any} */
	getAttrs() {
		return Object.fromEntries(liveAttrs(this));
	},
	/** @this {any} @param {string} key */
	hasAttr(key) {
		const item = this._map.get(key);
		return item !== undefined && !item.deleted;
	},
	/** @this {any} */
	attrValues() {
		return liveAttrs(this)
			.map(([, v]) => v)
			[Symbol.iterator]();
	},
	/** @this {any} */
	attrEntries() {
		return liveAttrs(this)[Symbol.iterator]();
	},
	/** @this {any} @param {(child: any, index: number) => any} f */
	map(f) {
		return children(this).map(f);
	},
	/** @this {any} @param {(child: any, index: number) => any} f */
	forEach(f) {
		children(this).forEach(f);
	},
	/** @this {any} @param {Array<any>|string} content */
	push(content) {
		this.insert(this.length, content);
	},
	/** @this {any} @param {Array<any>|string} content */
	unshift(content) {
		this.insert(0, content);
	},
	/** @this {any} */
	clearAttrs() {
		const keys = liveAttrs(this).map(([key]) => key);
		if (keys.length === 0 || this.doc == null || (this._item !== null && this._item.deleted))
			return;
		// one transaction, as the engine's own did
		this.doc.transact(() => {
			for (const key of keys) this.deleteAttr(key);
		});
	},
	/** @this {any} */
	clone() {
		const copy = this._copy();
		for (const [key, v] of liveAttrs(this)) copy.setAttr(key, v instanceof YNode ? v.clone() : v);
		let index = 0;
		for (const child of children(this)) {
			const insert =
				typeof child === 'string' ? child : [child instanceof YNode ? child.clone() : child];
			copy.insert(index, insert);
			index += insert.length;
		}
		return copy;
	},
	/** @this {any} */
	toJSON() {
		/** @type {any} */
		const res = {};
		if (this.name != null) res.name = this.name;
		const kids = children(this).map((c) =>
			c instanceof YNode ? /** @type {any} */ (c).toJSON() : c
		);
		if (this.length > 0) res.children = kids;
		const attrs = liveAttrs(this);
		if (attrs.length > 0)
			res.attrs = Object.fromEntries(
				attrs.map(([k, v]) => [k, v instanceof YNode ? /** @type {any} */ (v).toJSON() : v])
			);
		return res;
	},
	/** @this {any} @param {{ forceTag?: boolean }} [opts] */
	toString({ forceTag = false } = {}) {
		const attrs = liveAttrs(this)
			.map(([k, v]) => [k, v instanceof YNode ? v.toString({ forceTag: true }) : JSON.stringify(v)])
			.sort((a, b) => (a[0] < b[0] ? -1 : 1));
		const attrsString =
			(attrs.length > 0 ? ' ' : '') + attrs.map(([k, v]) => k + '=' + v).join(' ');
		const kids = children(this)
			.map((c) =>
				typeof c === 'string'
					? c
					: c instanceof YNode
						? c.toString({ forceTag: true })
						: JSON.stringify(c)
			)
			.join('');
		if (this.name == null && !forceTag && attrs.length === 0) return kids;
		if (this.length === 0) return `<${this.name ?? ''}${attrsString} />`;
		return `<${this.name ?? ''}${attrsString}>${kids}</${this.name ?? ''}>`;
	}
};

/**
 * Install the reads on `Node` (this module's engine, or a copy of its tree:
 * the differentials load stripped copies).
 *
 * @param {any} [Node]
 */
export const installNodeReads = (Node = YNode) => {
	for (const [name, f] of Object.entries(reads)) {
		if (!Object.hasOwn(Node.prototype, name))
			Object.defineProperty(Node.prototype, name, { value: f, configurable: true, writable: true });
	}
	if (!Object.hasOwn(Node.prototype, 'attrSize'))
		Object.defineProperty(Node.prototype, 'attrSize', {
			configurable: true,
			get() {
				return liveAttrs(this).length;
			}
		});
	if (!Object.hasOwn(Node.prototype, 'parent'))
		Object.defineProperty(Node.prototype, 'parent', {
			configurable: true,
			get() {
				return this._item ? this._item.parent : null;
			}
		});
};
