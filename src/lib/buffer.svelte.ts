import { Edytor } from './edytor.svelte.js';
import { Text } from './text/text.svelte.js';
export class Buffer {
	edytor: Edytor;
	inputBuffer: string = '';
	startIndex: number = 0;
	text?: Text;
	rafId: number | null = null;
	deletedLength: number = 0;
	private lastAddTime: number = 0;
	private readonly THROTTLE_INTERVAL = 100;

	constructor(edytor: Edytor) {
		this.edytor = edytor;
	}

	private flushBufferToYjs() {
		if (this.inputBuffer.length === 0 || !this.text) return;
		this.edytor.selection.savePosition();
		console.log('savedPosition', this.edytor.selection.savedPosition);
		const deltas = [
			{ retain: this.startIndex },
			// delete the selection length
			{ insert: this.inputBuffer }
		];
		if (this.deletedLength) {
			// @ts-ignore
			deltas.splice(1, 0, { delete: this.deletedLength });
		}

		this.text!.yText.applyDelta(deltas);

		console.log({ deltas });
		console.log(this.text!.yText.toDelta());

		this.inputBuffer = '';
		this.startIndex = 0;
		this.text = undefined;
	}

	private scheduleFlush = () => {
		const currentTime = performance.now();
		const timeSinceLastAdd = currentTime - this.lastAddTime;

		if (timeSinceLastAdd >= this.THROTTLE_INTERVAL) {
			this.flushBufferToYjs();
			this.rafId && cancelAnimationFrame(this.rafId);
			this.rafId = null;
		} else {
			this.rafId = requestAnimationFrame(this.scheduleFlush);
		}
	};

	add(value: string, startIndex: number, text: Text | null, length: number) {
		this.deletedLength = length;
		if (!text) return;
		if (this.inputBuffer.length === 0) {
			this.startIndex = startIndex;
			this.text = text;
		}
		this.inputBuffer += value;
		this.lastAddTime = performance.now();
		this.rafId && cancelAnimationFrame(this.rafId);
		this.rafId = requestAnimationFrame(this.scheduleFlush);
	}
}
