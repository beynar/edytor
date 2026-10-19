<script module lang="ts">
	import type { BlockSnippetPayload, Plugin } from '$lib/plugins.js';

	/** The demo's widget card: what its controls write. */
	type WidgetData = { count?: number; note?: string; taps?: number };

	/**
	 * A custom void kind for trying presses by hand (the demo only, not the
	 * package): a press on the card's empty area selects the block; its
	 * button, its input and its element marked `data-edytor-control` keep
	 * their own presses; its caption is editable text.
	 */
	export const demoWidgetPlugin: Plugin = () => ({
		blocks: {
			widget: {
				void: true,
				snippet: widget,
				presets: [{ label: 'Widget', icon: '🧩', keywords: ['widget', 'card'], data: { count: 0 } }]
			}
		}
	});

	/** One property of the widget's data, written as one `patchData` (one undo step). */
	const set = (
		block: BlockSnippetPayload<WidgetData>['block'],
		key: keyof WidgetData,
		value: unknown
	) => block.handle?.edytor.patchData(block.id, [{ path: [key], value }]);
</script>

{#snippet widget({ block, content }: BlockSnippetPayload<WidgetData>)}
	<div use:block.void data-demo-widget data-selected={block.selected ? 'true' : undefined}>
		<div class="demo-widget-title">🧩 Widget</div>
		<div class="demo-widget-row">
			<button type="button" onclick={() => set(block, 'count', (block.data.count ?? 0) + 1)}
				>Clicked {block.data.count ?? 0} times</button
			>
			<input
				type="text"
				placeholder="Type a note"
				value={block.data.note ?? ''}
				oninput={(event) => set(block, 'note', event.currentTarget.value)}
			/>
			<div
				class="demo-widget-custom"
				role="button"
				tabindex="0"
				data-edytor-control
				onclick={() => set(block, 'taps', (block.data.taps ?? 0) + 1)}
				onkeydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						set(block, 'taps', (block.data.taps ?? 0) + 1);
					}
				}}
			>
				Custom element: {block.data.taps ?? 0} taps
			</div>
		</div>
		<div class="demo-widget-hint">Press the empty area of this card to select the block.</div>
	</div>
	<div class="demo-widget-caption">{@render content()}</div>
{/snippet}

<style>
	:global([data-demo-widget]) {
		padding: 12px 14px;
		border: 1px solid rgba(55, 53, 47, 0.16);
		border-radius: 6px;
		background: rgba(55, 53, 47, 0.03);
	}
	:global([data-demo-widget][data-selected='true']) {
		box-shadow: 0 0 0 2px rgba(35, 131, 226, 0.5);
	}
	:global(.demo-widget-title) {
		font-weight: 600;
		margin-bottom: 8px;
	}
	:global(.demo-widget-row) {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}
	:global(.demo-widget-row button),
	:global(.demo-widget-row input),
	:global(.demo-widget-custom) {
		font: inherit;
		padding: 4px 8px;
		border: 1px solid rgba(55, 53, 47, 0.2);
		border-radius: 4px;
		background: white;
	}
	:global(.demo-widget-custom) {
		cursor: pointer;
		user-select: none;
	}
	:global(.demo-widget-hint) {
		margin-top: 10px;
		color: rgba(55, 53, 47, 0.55);
		font-size: 13px;
	}
	:global(.demo-widget-caption) {
		margin-top: 4px;
		color: rgba(55, 53, 47, 0.65);
		font-size: 14px;
	}
</style>
