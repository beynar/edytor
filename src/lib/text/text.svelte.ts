import { Edytor } from '../edytor.svelte.js';
import * as Y from 'yjs';
import { type Delta, type JSONText } from '$lib/utils/json.js';
import type { Block } from '../block/block.svelte.js';
import { deleteText, getAttributesAtPosition, insertText, mark, set, split } from './text.utils.js';
import { toDeltas, type JSONDelta } from './deltas.js';
import { id } from '$lib/utils.js';

export class Text {
	parent: Block;
	yText: Y.Text;
	edytor: Edytor;
	children = $state<JSONDelta[]>([]);
	node: HTMLElement | undefined;
	delta: Delta[] = [];
	isEmpty = $state(false);
	id: string;
	get value(): JSONText[] {
		const [deltas] = toDeltas(this.yText);
		return deltas.map((delta) => ({
			text: delta.text,
			marks: Object.fromEntries(delta.marks)
		}));
	}

	setChildren = (text?: Y.Text) => {
		[this.children, this.isEmpty] = toDeltas(text || this.yText);
	};

	private observeText = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
		if (transaction.origin !== this.edytor.transaction) {
			this.setChildren(event.target);
		}
	};

	constructor({
		parent,
		content,
		yText
	}: { parent: Block } & (
		| { yText?: undefined; content: string | JSONText[] }
		| { yText: Y.Text; content?: undefined }
	)) {
		this.parent = parent;
		this.edytor = parent.edytor;
		this.yText = yText || new Y.Text();
		this.id = this.yText.doc ? this.yText.getAttribute('id') : id('text');

		if (content !== undefined) {
			// If content is provided we need to initialize the text with the content
			this.yText._pending?.push(() => {
				this.yText.setAttribute('id', this.id);
				if (typeof content === 'string') {
					this.yText.insert(0, content);
				} else {
					this.yText.applyDelta(
						content.map((part) => ({
							insert: part.text,
							attributes: part.marks
						}))
					);
				}
				this.setChildren();
			});
		} else {
			this.setChildren();
		}
		this.edytor.idToText.set(this.id, this);

		if (!this.edytor.readonly) {
			this.yText.observe(this.observeText);
		}
	}

	getAttributesAtPosition = getAttributesAtPosition.bind(this);
	insertText = insertText.bind(this);
	deleteText = deleteText.bind(this);
	mark = mark.bind(this);
	split = split.bind(this);
	set = set.bind(this);
	attach = (node: HTMLElement) => {
		this.node = node;
		this.edytor.textToNode.set(this, node);
		this.edytor.nodeToText.set(node, this);
		this.edytor.YElementsToNodes.set(this.yText, node);
		this.edytor.nodesToYElements.set(node, this.yText);
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-text', `true`);

		return {
			destroy: () => {
				this.yText?.unobserve(this.observeText);
				this.edytor.idToText.delete(this.id);
			}
		};
	};
}
