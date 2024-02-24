import type { Text } from 'yjs';
import type { YBlock } from './json.js';

export const getId = (y: YBlock | Text) => {
	return `${y._item?.id.client}-${y._item?.id.clock}`;
};
