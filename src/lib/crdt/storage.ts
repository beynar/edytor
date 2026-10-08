/**
 * The storage codec — what the room's rows and the IndexedDB store
 * hold, apart from the wire (which stays v1 until the schema generation
 * that changes it). Snapshots are written in the v2 (columnar) encoding
 * and gzip-compressed where the platform has `CompressionStream`; update
 * rows stay v1 (smaller for one keystroke). A compressed record starts
 * with gzip's magic `1f 8b`, which no v2 update does (its first byte is
 * the encoder's feature flag, `00`), so a v2 container's snapshot says
 * itself whether it is compressed. Worker-safe: no timers, every
 * platform API feature-detected.
 */

/** Whether `bytes` are gzip (its magic `1f 8b`). */
export const isGzip = (bytes: Uint8Array): boolean =>
	bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

type Transform = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
type TransformClass = new (format: 'gzip') => Transform;
const platform = globalThis as {
	CompressionStream?: TransformClass;
	DecompressionStream?: TransformClass;
};

/** Run `bytes` through a (de)compression stream. */
const through = async (bytes: Uint8Array, transform: Transform): Promise<Uint8Array> => {
	const stream = new Response(bytes as Uint8Array<ArrayBuffer>).body!.pipeThrough(transform);
	return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** Whether this platform compresses (`CompressionStream`). */
export const canCompress = (): boolean => typeof platform.CompressionStream === 'function';

/** `bytes` gzip-compressed, or `null` where the platform has no `CompressionStream`. */
export const gzip = async (bytes: Uint8Array): Promise<Uint8Array | null> =>
	platform.CompressionStream ? through(bytes, new platform.CompressionStream('gzip')) : null;

/** `bytes` as stored: inflated when gzip, else as they are. */
export const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
	if (!isGzip(bytes)) return bytes;
	if (!platform.DecompressionStream) {
		throw new Error('a compressed record needs DecompressionStream, which this platform lacks');
	}
	return through(bytes, new platform.DecompressionStream('gzip'));
};

/** `bytes` compressed when that makes them smaller (and the platform can), else as they are. */
export const packed = async (bytes: Uint8Array): Promise<Uint8Array> => {
	const out = await gzip(bytes);
	return out !== null && out.length < bytes.length ? out : bytes;
};
