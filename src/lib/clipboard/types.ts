import type { JSONContentPart as ClipboardContentPart } from '$lib/block/contentRange.js';
import type { JSONBlock } from '$lib/utils/json.js';

export const EDYTOR_FRAGMENT_MIME = 'application/x-edytor-fragment';
export const EDYTOR_FRAGMENT_ATTRIBUTE = 'data-edytor-fragment';

export type { JSONContentPart } from '$lib/block/contentRange.js';

export type EdytorClipboardFragment =
	| {
			version: 1;
			source: 'edytor';
			kind: 'blocks';
			blocks: JSONBlock[];
	  }
	| {
			version: 1;
			source: 'edytor';
			kind: 'content';
			blockType: string;
			content: ClipboardContentPart[];
	  };

export type ClipboardWritable = Pick<DataTransfer, 'getData' | 'setData'>;
