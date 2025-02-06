import { Edytor } from '../edytor.svelte.js';
import * as Y from 'yjs';
import { type Delta, type JSONText, type SerializableContent } from '$lib/utils/json.js';
import type { Block } from '../block/block.svelte.js';
import {
	batch,
	deleteText,
	removeMarksFromText,
	getMarksAtRange,
	insertText,
	markText,
	setText,
	splitText
} from './text.utils.js';
import { deltaToJson, jsonToDelta, toDeltas, type JSONDelta } from './deltas.js';
import { id } from '$lib/utils.js';
import { tick } from 'svelte';

export class Text {
	parent: Block;
	yText: Y.Text;
	edytor: Edytor;
	children = $state<JSONDelta[]>([]);
	stringContent = $state('');
	node: HTMLElement | undefined;
	delta: Delta[] = [];
	isEmpty = $state(false);
	endsWithNewline = $state(false);
	markOnNextInsert: undefined | Record<string, SerializableContent | null> = undefined;
	id: string;

	get value(): JSONText[] {
		return this.children.map((child) => {
			const marks = Object.fromEntries(child.marks);
			const value: JSONText = {
				text: child.text,
				marks
			};
			if (!marks.length) {
				delete value.marks;
			}
			return value;
		});
	}

	private setChildren = (text?: Y.Text) => {
		this.stringContent = this.yText.toJSON();
		const [children, isEmpty] = toDeltas(text || this.yText);
		const transformer = this.parent.definition.transformContent;
		this.children = transformer
			? jsonToDelta(transformer({ text: this, block: this.parent, content: deltaToJson(children) }))
			: children;
		this.isEmpty = isEmpty;
		this.endsWithNewline = this.stringContent.endsWith('\n');
	};

	private observeText = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
		if (transaction.origin !== this.edytor.transaction) {
			// If the transaction is not from the edytor, we need to restore the selection
			// If the current text is not focused, this action will be ignored
			this.edytor.selection.restoreRelativePosition(this);
		}
		this.setChildren(event.target);
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
	private batch = batch.bind(this);
	getMarksAtRange = getMarksAtRange.bind(this);
	insertText = this.batch('insertText', insertText.bind(this));
	deleteText = this.batch('deleteText', deleteText.bind(this));
	splitText = this.batch('splitText', splitText.bind(this));
	setText = this.batch('setText', setText.bind(this));
	markText = this.batch('markText', markText.bind(this));
	removeMarksFromText = this.batch('removeMarksFromText', removeMarksFromText.bind(this));

	attach = (node: HTMLElement) => {
		this.node = node;
		this.edytor.nodeToText.set(node, this);
		node.setAttribute('data-edytor-id', `${this.id}`);
		node.setAttribute('data-edytor-text', `true`);

		tick().then(() => {
			if (this.parent.definition.void) {
				node.setAttribute('contenteditable', 'true');
				node.style.outline = 'none';
				node.style.border = 'none';
				node.style.minWidth = '100%';
				node.onbeforeinput = (e) => {
					e.preventDefault();
					e.stopPropagation();
					this.edytor.onBeforeInput(e);
				};
			}
		});

		let pluginDestroy = this.edytor.plugins.reduce(
			(acc, plugin) => {
				const action = plugin.onTextAttached?.({ node, text: this });
				action && acc.push(action);
				return acc;
			},
			[] as (() => void)[]
		);
		return {
			destroy: () => {
				this.yText?.unobserve(this.observeText);
				this.edytor.idToText.delete(this.id);
				pluginDestroy.forEach((destroy) => destroy());
			}
		};
	};
}
