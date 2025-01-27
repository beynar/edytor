import { describe, it, expect, should } from 'vitest';
import * as Y from 'yjs';

describe('sum test', () => {
	it('should work', () => {
		const doc = new Y.Doc();
		const block = doc.getMap('root');

		const text = new Y.Text();
		block.set('content', text);
		block.set('date', undefined);

		console.log(block.get('date'));

		text._pending?.push(() => {
			text.insert(0, 'Hello', { bold: true });
			text.insert(5, 'World', { italic: true });
		});

		console.log(text.getAttributes());
		text.observe(() => {
			console.log('observed', text.getAttributes());
		});
		text.setAttribute('id', '1');
		console.log(text.getAttributes());
		// text.insert(0, 'Hello', { bold: true });

		console.log(doc.getMap('root').get('content').toDelta());
	});
});
