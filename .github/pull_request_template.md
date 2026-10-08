## What changes, for whom

<!-- The behaviour before and after. Link the issue. -->

## Checklist

- [ ] Changed in its owner (AGENTS.md, "One owner per fact"), with no new flag, timer or retry
- [ ] A test that failed before the change, citing its contract row when there is one
- [ ] The lanes the change touches pass locally (CONTRIBUTING.md, "The lanes")
- [ ] Public API or behaviour: the site page, and a note under `### Unreleased` in `reference/migration.mdx`
- [ ] Public types: `pnpm api:report` run and its diff reviewed
