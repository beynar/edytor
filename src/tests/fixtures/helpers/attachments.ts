import type { Plugin } from '$lib/plugins.js';

type AttachmentEvent = {
	id: string;
	kind: 'editor' | 'block' | 'text';
	phase: 'attach' | 'detach';
};

export const createAttachmentProbe = () => {
	const events: AttachmentEvent[] = [];

	const plugin: Plugin = () => {
		return {
			onEdytorAttached: ({ node }) => {
				const id = node.dataset.edytorId ?? 'editor';
				events.push({ id, kind: 'editor', phase: 'attach' });
				return () => {
					events.push({ id, kind: 'editor', phase: 'detach' });
				};
			},
			onBlockAttached: ({ block }) => {
				events.push({ id: block.id, kind: 'block', phase: 'attach' });
				return () => {
					events.push({ id: block.id, kind: 'block', phase: 'detach' });
				};
			},
			onTextAttached: ({ text }) => {
				events.push({ id: text.id, kind: 'text', phase: 'attach' });
				return () => {
					events.push({ id: text.id, kind: 'text', phase: 'detach' });
				};
			}
		};
	};

	return {
		plugin,
		clear() {
			events.length = 0;
		},
		read() {
			return [...events];
		}
	};
};
