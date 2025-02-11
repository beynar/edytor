let alphabet = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict';

export const id = (prefix: 't' | 'b' | 'i') => {
	const e = 10;
	let t = '',
		r = crypto.getRandomValues(new Uint8Array(e));
	for (let n = 0; n < e; n++) t += alphabet[61 & r[n]];
	return `${prefix}_${t}`;
};

export class PreventionError extends Error {
	cb?: () => void;
	constructor(cb?: () => void) {
		super('Prevent');
		this.name = 'PreventionError';
		this.cb = cb;
	}
}
export const prevent = (cb?: () => void): void => {
	throw new PreventionError(cb);
};
