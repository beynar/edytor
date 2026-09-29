/**
 * The event base of the providers and of awareness: lib0's `ObservableV2`
 * with an `emit` that runs each listener in isolation (lib0 leaves this as
 * a `@todo`). A listener that throws is logged and the rest still run, as
 * does the emitter's own work after the emit: a consumer's callback must
 * not stop a redial, a readiness hold or a presence broadcast.
 */
import { ObservableV2 } from 'lib0-v14/observable';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Events<E> = { [K in keyof E]: (...args: any[]) => void };

export class IsolatedObservable<E extends Events<E>> extends ObservableV2<E> {
	emit<N extends keyof E & string>(name: N, args: Parameters<E[N]>): void {
		const listeners = Array.from(this._observers.get(name) ?? []) as E[N][];
		for (const listener of listeners) {
			try {
				listener(...args);
			} catch (error) {
				console.error(`[edytor] "${name}" listener failed; continuing`, error);
			}
		}
	}
}
