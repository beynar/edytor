/**
 * The storage codec — what the room's rows and the IndexedDB store
 * hold: updates in the engine's one encoding, snapshots gzip-compressed
 * when that makes them smaller (`CompressionStream`, in every supported
 * browser, Node and Workers). A compressed record starts with gzip's magic
 * `1f 8b`, which no update does (its first byte is the encoder's feature
 * flag, `00`), so a record says itself whether it is compressed.
 * Worker-safe: no timers.
 */

/** Whether `bytes` are gzip (its magic `1f 8b`). */
export const isGzip = (bytes: Uint8Array): boolean =>
	bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** Run `bytes` through a (de)compression stream. */
const through = async (
	bytes: Uint8Array,
	transform: CompressionStream | DecompressionStream
): Promise<Uint8Array> => {
	const stream = new Response(bytes as Uint8Array<ArrayBuffer>).body!.pipeThrough(transform);
	return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** `bytes` as stored: inflated when gzip, else as they are. */
export const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> =>
	isGzip(bytes) ? through(bytes, new DecompressionStream('gzip')) : bytes;

/** `bytes` compressed when that makes them smaller, else as they are. */
export const packed = async (bytes: Uint8Array): Promise<Uint8Array> => {
	const out = await through(bytes, new CompressionStream('gzip'));
	return out.length < bytes.length ? out : bytes;
};
