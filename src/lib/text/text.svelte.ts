import { Edytor } from '../edytor.svelte.js';
import * as Y from 'yjs';
import { type Delta, type JSONText } from '$lib/utils/json.js';
import type { Block } from '../block/block.svelte.js';
import { deleteText, getAttributesAtPosition, insertText, mark } from './text.utils.js';
import { toDeltas, type JSONDelta } from './deltas.js';
import { tick } from 'svelte';

export class Text {
	edytor: Edytor;
	children = $state<JSONDelta[]>([]);
	node = $state<HTMLElement | undefined>(undefined);
	delta: Delta[] = [];
	forcedUpdate = $state(crypto.randomUUID());
	isEmpty = $state(false);
	isComposing = $state(false);
	composingEndTimeOut: number | null = null;
	id: string;

	get value(): JSONText[] {
		const [deltas] = toDeltas(this.yText);
		return deltas.map((delta) => ({
			text: delta.text,
			marks: Object.fromEntries(delta.marks)
		}));
	}

	startComposing = () => {
		return;
		if (this.composingEndTimeOut) {
			clearTimeout(this.composingEndTimeOut);
		}
		const { startNode, start } = this.edytor.selection.state;
		this.composingEndTimeOut = setTimeout(() => {
			this.composingEndTimeOut = null;
			this.forceUpdate();
			tick().then(() => {
				this.edytor.selection.setAtNodeOffset(startNode, start);
			});
		}, 800);
	};

	forceUpdate = () => {
		this.setChildren();

		this.forcedUpdate = crypto.randomUUID();
	};

	setChildren = (text?: Y.Text) => {
		[this.children, this.isEmpty] = toDeltas(text || this.yText);
		console.log(this.children);
	};
	private observeText = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
		if (transaction.origin !== this.edytor.transaction) {
			this.setChildren(event.target);
			console.log(event.target.toJSON());
		}
	};

	static create = (content: string | JSONText[] | undefined, parent: Block) => {
		if (typeof content === 'string' || !content) {
			const yText = new Y.Text(content);
			parent.yBlock.set('content', yText);
			return new Text(yText, parent);
		} else {
			const yText = new Y.Text();
			parent.yBlock.set('content', yText);
			let offset = 0;
			content.forEach((part) => {
				const { text, marks } = part;
				yText.insert(offset, text, marks);
				offset += text.length;
			});
			return new Text(yText, parent);
		}
	};

	constructor(
		public yText: Y.Text,
		public parent: Block
	) {
		this.edytor = parent.edytor;
		this.id = crypto.randomUUID();
		this.setChildren();
		this.yText.observe(this.observeText);
	}

	getAttributesAtPosition = getAttributesAtPosition.bind(this);
	insertText = insertText.bind(this);
	deleteText = deleteText.bind(this);
	mark = mark.bind(this);

	destroy = () => {
		this.yText?.unobserve(this.observeText);
		this.edytor.YElementsToNodes.delete(this.yText);
		this.node && this.edytor.nodesToYElements.delete(this.node);
	};

	attach = (node: HTMLElement) => {
		this.node = node;
		this.edytor.YElementsToNodes.set(this.yText, node);
		this.edytor.nodesToYElements.set(node, this.yText);
		this.edytor.textToNode.set(this, node);
		this.edytor.nodeToText.set(node, this);
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-text', `true`);
		return {
			destroy: this.destroy
		};
	};
}
