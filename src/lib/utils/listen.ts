/**
 * Listen for each of the space-separated `types` on `target` (none when it
 * is missing); answers the cleanup. The one way the chrome adds a listener
 * it removes itself.
 */
export const listen = <E extends Event>(
	target: EventTarget | null | undefined,
	types: string,
	listener: (event: E) => void,
	capture = false
) => {
	const all = types.split(' ');
	for (const type of all) target?.addEventListener(type, listener as EventListener, capture);
	return () => {
		for (const type of all) target?.removeEventListener(type, listener as EventListener, capture);
	};
};

/** Run every cleanup of `offs` (a list of `listen` answers and other teardowns). */
export const all =
	(...offs: (() => unknown)[]) =>
	() => {
		for (const off of offs) off();
	};
