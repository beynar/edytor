import type { PluginDemo } from './types';

/**
 * Every `site/demos/<page>/index.ts`, each its own chunk: a page loads only
 * its plugin's demo. A new folder is picked up as it is; nothing here changes.
 */
const demos = import.meta.glob<{ default: PluginDemo }>('./*/index.ts');

export const loadDemo = async (page: string): Promise<PluginDemo> => {
	const load = demos[`./${page}/index.ts`];
	if (!load) throw new Error(`No demo in site/demos/${page}/index.ts`);
	return (await load()).default;
};
