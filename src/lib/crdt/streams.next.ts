/**
 * D11 SPIKE — stream boundaries (plan §2.1, R2). Stub for the tests-first
 * commit: the spike lands in the next commit and is removed at D12.
 */
export type Boundary = { s: string; n: number };
export const isBoundary = (v: unknown): v is Boundary =>
	v != null && typeof v === 'object' && typeof (v as Boundary).s === 'string' && 'n' in v;
export const bindStreams = (_Y: unknown): never => {
	throw new Error('D11 spike: not implemented');
};
