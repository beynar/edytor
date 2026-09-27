import type { Plugin } from '$lib/plugins.js';
import type { JSONBlock } from '$lib/utils/json.js';
import { flowOfBlocks, pasteFlow } from '$lib/clipboard/insertClipboardFragment.js';
import type { ElementDefinitions } from './deserialize.js';
import { parseHtml } from './deserialize.js';

type HTMLPluginOptions = Partial<ElementDefinitions>;

export const htmlPlugin =
	(options: HTMLPluginOptions): Plugin =>
	(edytor) => {
		return {
			onPaste: ({ prevent, e }) => {
				const html = e.clipboardData?.getData('text/html');
				if (!html) {
					return;
				}

				prevent(async () => {
					// Parsed before any write: a bad mapping throws with the selection intact.
					const blocks = parseHtml.call(edytor, html, options);
					// HTML that carries nothing (a comment, a script, an empty span) is an empty flow (F-P10).
					const carries = (b: JSONBlock): boolean =>
						Boolean(b.children?.length) || (b.content ?? []).some((p) => !('text' in p) || p.text);
					const flow = flowOfBlocks(blocks.some(carries) ? blocks : []);
					// `$fragment` pseudo-blocks are inline runs (`flow.shape`).
					for (const line of flow.lines) if (line.type === '$fragment') delete line.type;
					edytor.undoManager.stopCapturing();
					await pasteFlow(edytor, flow);
				});
			}
		};
	};
