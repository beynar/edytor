let alphabet = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict';

export const id = (prefix: 'text' | 'block') => {
	const e = 21;
	let t = '',
		r = crypto.getRandomValues(new Uint8Array(e));
	for (let n = 0; n < e; n++) t += alphabet[61 & r[n]];
	return `${prefix}_${t}`;
};
