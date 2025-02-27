import type { ElementDefinition } from './deserialize.js';
import type { Plugin } from '$lib/plugins.js';
import { parseHtml } from './deserialize.js';
type HTMLPluginOptions = {
	blocks?: ElementDefinition;
	marks?: ElementDefinition;
	inlineBlocks?: ElementDefinition;
};

export const htmlPlugin =
	(options: HTMLPluginOptions): Plugin =>
	(edytor) => {
		return {
			onPaste: ({ prevent, e }) => {
				const html = e.clipboardData?.getData('text/html');
				if (html) {
					prevent(() => {
						const blocks = parseHtml.bind(edytor)(html, options);
						const [firstBlock] = blocks;
						if (firstBlock.type === '$fragment') {
							const { content } = firstBlock;
						} else {
							// edytor.root?.addChildBlocks({blocks, index:});
						}
					});
				}
			}
		};
	};
