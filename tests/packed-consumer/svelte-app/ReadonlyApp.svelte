<script>
	import { Edytor, richTextPlugin } from 'edytor';

	const seed = {
		children: [
			{
				type: 'paragraph',
				id: 'ssr1',
				content: [{ text: 'ssr ' }, { text: 'rendered', marks: { bold: true } }]
			}
		]
	};
</script>

<Edytor readonly value={seed} plugins={[richTextPlugin]} />
