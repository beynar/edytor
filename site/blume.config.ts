import { defineConfig } from "blume";
import { cloudflare } from "blume/deploy";
import type { AstroIntegration } from "astro";
import { fileURLToPath } from "node:url";

/**
 * `blume dev` only. Two Astro dev faults, fixed through Vite:
 *
 * - The islands run on one Svelte runtime. Astro's island renderer is a raw
 *   file whose `?v=` hash survives a dependency re-optimization, and Vite
 *   serves it as immutable, so a browser that cached it keeps importing the
 *   previous pre-bundled Svelte while an island imports the new one, and the
 *   island fails to hydrate (`get_first_child` reading `call`). Raw files are
 *   revalidated instead (a 304 when unchanged), and the client optimizer's
 *   first run holds what a page reaches late (Astro's view transitions, the
 *   packed `edytor`), so a first visit does not re-bundle. The include is the
 *   client's alone: on a server environment it would bundle a second Astro.
 * - A restart that reuses the prerender environment's cached dependencies
 *   loads a second copy of Astro there, and every page answers 500 (`Unable
 *   to resolve [...ClientRouter.astro?astro&type=script...]`): that
 *   environment re-optimizes on each start.
 */
const devIslands: AstroIntegration = {
  name: "edytor-dev-islands",
  hooks: {
    "astro:config:setup": ({ command, updateConfig }) => {
      if (command !== "dev") return;
      updateConfig({
        vite: {
          environments: {
            prerender: { optimizeDeps: { force: true } },
            client: {
              optimizeDeps: {
                include: [
                  "astro/virtual-modules/transitions-events.js",
                  "astro/virtual-modules/transitions-router.js",
                  "astro/virtual-modules/transitions-swap-functions.js",
                  "astro/virtual-modules/transitions-types.js",
                  "edytor",
                ],
              },
            },
          },
          plugins: [
            {
              name: "edytor-dev-revalidate",
              configureServer(server) {
                server.middlewares.use((request, response, next) => {
                  if (request.url?.startsWith("/@fs/")) {
                    const setHeader = response.setHeader.bind(response);
                    response.setHeader = (name, value) =>
                      setHeader(name, name.toLowerCase() === "cache-control" ? "no-cache" : value);
                  }
                  next();
                });
              },
            },
          ],
        },
      });
    },
  },
};

/**
 * The home page's live editor renders on the server (its seed, read-only),
 * so Vite compiles the packed `edytor`'s `.svelte` files for the server
 * instead of handing them to Node.
 */
const serverRenderedEdytor: AstroIntegration = {
  name: "edytor-server-render",
  hooks: {
    "astro:config:setup": ({ updateConfig }) => {
      const server = { resolve: { noExternal: ["edytor"] } };
      updateConfig({ vite: { ssr: { noExternal: ["edytor"] }, environments: { ssr: server, prerender: server } } });
    },
  },
};

/**
 * The demos draw the starter and the ready-made chrome from the repository's
 * shadcn-svelte registry (`../registry`, the one copy an app adds with
 * `shadcn-svelte add`): `$registry` names it, and its imports (`edytor`,
 * Svelte, bits-ui and the shadcn components' other packages) resolve from
 * this site, one copy of each. `theme.css` scans it for Tailwind's classes.
 */
const registrySource: AstroIntegration = {
  name: "edytor-registry-source",
  hooks: {
    "astro:config:setup": ({ updateConfig }) => {
      const registry = fileURLToPath(new URL("../registry", import.meta.url));
      const packages = [
        "svelte",
        "edytor",
        "bits-ui",
        "@lucide/svelte",
        "tailwind-variants",
        "cn",
        "@internationalized/date",
      ];
      // On the server too: the registry's components, bits-ui and its runes
      // helpers are Svelte sources Vite compiles.
      const compiled = [...packages.slice(1), "svelte-toolbelt", "runed"];
      const server = {
        resolve: { alias: { $registry: registry }, dedupe: packages, noExternal: compiled },
      };
      updateConfig({
        vite: {
          resolve: { alias: { $registry: registry }, dedupe: packages },
          ssr: { noExternal: compiled },
          environments: { ssr: server, prerender: server },
          server: { fs: { allow: [registry] } },
        },
      });
    },
  },
};

export default defineConfig({
  title: "Edytor",
  description:
    "A collaborative block editor for Svelte 5: Notion-style blocks, plugins that can veto anything, and a Yjs v14 engine with a Cloudflare Durable Object server.",
  logo: {
    href: "/",
    text: "Edytor",
  },
  basePath: "/docs",
  content: {
    root: "content/docs",
  },
  // The header links the repo; `master` holds these docs' source (`site/`).
  navigation: {
    repo: "https://github.com/beynar/edytor",
    sidebar: {
      display: "group",
    },
  },
  integrations: [devIslands, serverRenderedEdytor, registrySource],
  deployment: cloudflare({ site: "https://edytor.dev" }),
  agents: {
    llmsTxt: true,
    webmcp: true,
    agentReadability: true,
    mcp: {
      enabled: true,
      route: "/mcp",
      name: "Edytor MCP",
      instructions:
        "You are a helpful assistant that answers questions about Edytor, the collaborative block editor for Svelte.",
    },
  },
});
