/**
 * Listener isolation, the one helper every CRDT event source uses: the
 * document's readiness/writable/refusal listeners, the facade's change
 * report, and the providers' and awareness' events. A listener that throws
 * is logged and the rest still run, as does the emitter's own work after
 * the emit: a consumer's callback must not stop a redial, a readiness hold,
 * a presence broadcast, or the engine's `update` cleanup (SW16-rest-1).
 */
import { ObservableV2 } from 'lib0-v14/observable';

/** Run each of `listeners` with `args`; one that throws is logged as `<label> listener failed`, never rethrown. */
export const callEach = <A extends unknown[]>(
	label: string,
	listeners: Iterable<(...args: A) => void>,
	...args: A
): void => {
	for (const listener of listeners) {
		try {
			listener(...args);
		} catch (error) {
			console.error(`${label} listener failed; continuing`, error);
		}
	}
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Events<E> = { [K in keyof E]: (...args: any[]) => void };

/** lib0's `ObservableV2` with an isolated `emit` (lib0 leaves this as a `@todo`). */
export class IsolatedObservable<E extends Events<E>> extends ObservableV2<E> {
	emit<N extends keyof E & string>(name: N, args: Parameters<E[N]>): void {
		callEach(`[edytor] "${name}"`, Array.from(this._observers.get(name) ?? []) as E[N][], ...args);
	}
}
