import { defineConfig } from "blume";
import { cloudflare } from "blume/deploy";

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
  // No `github` block: its "Edit this page" links would target `master`,
  // which holds 0.0.11 and no `site/`. Restore it with the branch these docs
  // live on once that branch is pushed; until then the header links the repo.
  navigation: {
    repo: "https://github.com/beynar/edytor",
    sidebar: {
      display: "group",
    },
  },
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
