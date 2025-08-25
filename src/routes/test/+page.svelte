<script lang="ts">
	import { tick } from 'svelte';
	import { on } from 'svelte/events';

	const onCompositionStart = (e: CompositionEvent) => {
		console.log('compositionstart', e, e.isComposing);
	};
	const onCompositionUpdate = (e: CompositionEvent) => {
		console.log('compositionupdate', e, e.isComposing);
	};
	const onCompositionEnd = (e: CompositionEvent) => {
		console.log('compositionend', e, e.isComposing);
	};
	const onKeyDown = (e: KeyboardEvent) => {
		console.log('keydown', e, e.isComposing);
	};
	const onBeforeInput = (e: InputEvent) => {
		if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText') {
			// Let browser handle naturally
			tick().then(() => {
				const domText = e.target?.innerText;
				console.log('domText', domText);
				//   const slateText = node.textContent;
				//   if (domText !== slateText) {
				//reconcileWithSlate(domText);
				//   }
			});
			return; // Don't prevent default
		}

		// Handle other input types manually
		e.preventDefault();
	};

	const attach = (node: HTMLElement) => {
		const off = [
			on(node, 'compositionstart', onCompositionStart),
			on(node, 'compositionupdate', onCompositionUpdate),
			on(node, 'compositionend', onCompositionEnd),
			on(node, 'keydown', onKeyDown),
			on(node, 'beforeinput', onBeforeInput)
		];
		return () => {
			off.forEach((fn) => fn());
		};
	};

	const detach = (node: HTMLElement) => {
		node.removeEventListener('keydown', (e) => {
			console.log('keydown', e);
		});
	};
</script>

<div class="p-4">
	<div {@attach attach} contenteditable="true" class="p-4 m-4 min-h-4 border border-red-400"></div>
</div>
