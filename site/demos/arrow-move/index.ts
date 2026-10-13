import type { JSONDoc } from 'edytor';
import { arrowMovePlugin } from '$registry/edytor/chrome/index.js';
import { basePlugins } from '../base';
import type { PluginDemo } from '../types';

const value: JSONDoc = {
	children: [
		{ id: 'intro', type: 'heading', data: { level: 2 }, content: [{ text: 'Packing list' }] },
		{ id: 'one', type: 'paragraph', content: [{ text: '1. Passport and tickets' }] },
		{ id: 'two', type: 'paragraph', content: [{ text: '2. Charger and adapter' }] },
		{ id: 'three', type: 'paragraph', content: [{ text: '3. Camera' }] },
		{ id: 'four', type: 'paragraph', content: [{ text: '4. Something to read' }] },
		{ id: 'end', type: 'paragraph', content: [{ text: '' }] }
	]
};

export default {
	value,
	// Arrow move is not a default: the page lists it.
	plugins: () => [arrowMovePlugin, ...basePlugins(arrowMovePlugin)]
} satisfies PluginDemo;
