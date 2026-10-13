/**
 * The starter editor (the `starter` registry item): a full editor in one
 * component (`StarterEditor`), its plugin list and its types, and the
 * ready-made chrome it draws (`../chrome`). The files are yours: edit them.
 */
export { default as StarterEditor } from './StarterEditor.svelte';
export { starterPlugins, type StarterPluginInput } from './starterPlugins.js';
export type {
	StarterCoverPayload,
	StarterEditorProps,
	StarterIconPayload,
	StarterPageData,
	StarterPart,
	StarterPerson,
	StarterPluginOptions,
	StarterPlugins,
	StarterPropertiesPayload,
	StarterProperty,
	StarterPropertyCellPayload,
	StarterPropertyOption,
	StarterPropertyType,
	StarterPropertyValue,
	StarterTitlePayload
} from './types.js';
export * from '../chrome/index.js';
