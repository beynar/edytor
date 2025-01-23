import * as Y from 'yjs';
export const getId = (y: { _item: Y.Item | null }) => {
	return `${y._item?.id.client}-${y._item?.id.clock}`;
};

export const makeId = () => {
	return `${Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)}`;
};
