<script lang="ts">
	// The documented refresh: `onSyncExpired` fetches a token, `params` carries it to the redial.
	import Edytor from '$lib/components/Edytor.svelte';
	import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';

	type Expired = { reason: string; attempts: number; nextRetryMs: number };
	let { expired, getToken }: { expired: Expired[]; getToken: () => Promise<string> } = $props();
	let token = $state('stale');
</script>

<Edytor
	plugins={[richTextPlugin]}
	server="ws://rooms.test/rooms"
	room="doc-expired"
	params={{ token }}
	onSyncExpired={async (state) => {
		expired.push(state);
		token = await getToken();
	}}
/>
