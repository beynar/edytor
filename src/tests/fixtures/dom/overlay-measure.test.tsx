/** @jsxImportSource ../../jsx */
/**
 * The overlay's frame (R11, O63): every measure reads layout before any
 * registered write runs — a mounted placer included — so one frame forces
 * at most one layout. The menus still land where they did.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Overlay } from '$lib/surface/overlay.js';
import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
import { blockMenuPlugin } from '$lib/plugins/blockMenu/blockMenuPlugin.js';
import { BLOCK_ACTIVATE_EVENT } from '$lib/plugins/blockHandles/BlockHandleController.svelte.js';
import OverlayProbe from '../../dom/OverlayProbe.svelte';
import { dispatchDomBeforeInput, flushDomUpdates, renderDomEdytor } from '../../dom/test.utils.js';

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

describe('overlay measures', () => {
	const realRaf = window.requestAnimationFrame;
	afterEach(() => void (window.requestAnimationFrame = realRaf));

	it("a mounted placer's read runs before any registered write", () => {
		const frames: FrameRequestCallback[] = [];
		window.requestAnimationFrame = (callback) => frames.push(callback);
		const host = document.body.appendChild(document.createElement('div'));
		const overlay = new Overlay();
		const detach = overlay.attach(host);
		const log: string[] = [];
		overlay.add(() => {
			log.push('handle read');
			return () => log.push('handle write');
		});
		const unmount = overlay.mount(
			OverlayProbe,
			{ label: 'menu' },
			'probe-host',
			50,
			(menu, origin) => {
				log.push(`placer read ${menu.textContent} ${origin.left}`);
				return () => {
					log.push('placer write');
					menu.style.left = '12px';
				};
			}
		);
		frames.splice(0).forEach((run) => run(0));
		expect(log).toEqual(['handle read', 'placer read menu 0', 'handle write', 'placer write']);
		expect(document.querySelector<HTMLElement>('[data-probe-host]')!.style.left).toBe('12px');
		unmount();
		expect(document.querySelector('[data-probe-host]')).toBeNull();
		detach();
		host.remove();
	});
});

describe('menu placement', () => {
	it('the slash menu is placed below the caret, inside the viewport', async () => {
		const { editor } = await renderDomEdytor(
			<root>
				<paragraph>|</paragraph>
			</root>,
			{ plugins: [richTextPlugin, slashMenuPlugin] }
		);
		await dispatchDomBeforeInput(editor, { inputType: 'insertText', data: '/' });
		await frame();
		const host = document.querySelector<HTMLElement>('[data-edytor-slash-menu-host]')!;
		// jsdom lays nothing out: a zero caret rect, the default menu size, clamped to the 8px edge.
		expect([host.style.left, host.style.top]).toEqual(['8px', '8px']);
	});

	it('the block menu sits beside its handle, and closes once the handle leaves the view', async () => {
		const { edytor, editor } = await renderDomEdytor(
			<root>
				<paragraph>|one</paragraph>
			</root>,
			{ plugins: [richTextPlugin, blockMenuPlugin] }
		);
		const anchor = document.createElement('span');
		editor.after(anchor);
		const block = edytor.root!.children[0]!;
		editor.dispatchEvent(new CustomEvent(BLOCK_ACTIVATE_EVENT, { detail: { block, anchor } }));
		await flushDomUpdates();
		await frame();
		const host = document.querySelector<HTMLElement>('[data-edytor-block-menu-host]')!;
		// A zero anchor rect: 8px right of it, top-aligned.
		expect([host.style.left, host.style.top]).toEqual(['8px', '0px']);

		anchor.getBoundingClientRect = () => new DOMRect(0, window.innerHeight + 10, 20, 20);
		edytor.overlay.invalidate();
		await frame();
		await flushDomUpdates();
		expect(document.querySelector('[data-testid="block-menu"]')).toBeNull();
		anchor.remove();
	});
});
