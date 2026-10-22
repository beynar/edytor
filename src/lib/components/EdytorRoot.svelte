<script lang="ts">
	// The public `<Edytor>`: the view, built again on a new document when the
	// room re-seeds the one it owns (`room.reseed.protocol`).
	import Edytor, { type EdytorProps } from './Edytor.svelte';

	// eslint-disable-next-line no-useless-assignment -- bindable: `adopt` assigns it
	let { edytor = $bindable(), ...props }: EdytorProps = $props();
	let epoch = $state(0);
</script>

{#key epoch}<Edytor {...props} adopt={(view) => (edytor = view)} rebuild={() => epoch++} />{/key}
