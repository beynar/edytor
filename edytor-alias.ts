import { fileURLToPath } from 'node:url';

/**
 * The registry's source (`registry/`) imports the package by its published
 * name, as the app it is copied into does: in this repository that name is
 * src/lib (the app, the unit, DOM and CRDT lanes all resolve it here, never
 * through a built `dist/`).
 */
export const edytorAlias = [
	{ find: /^edytor$/, replacement: fileURLToPath(new URL('./src/lib/index.ts', import.meta.url)) },
	{
		find: /^edytor\/themes\/(.*)$/,
		replacement: fileURLToPath(new URL('./src/lib/themes/$1', import.meta.url))
	}
];
