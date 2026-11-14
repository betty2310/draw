# draw

A diagram app: an Excalidraw editor with a project list, autosave, a version history with named versions, and branches. It runs on the Cloudflare free plan (one Worker, one Durable Object for each project, one D1 database).

The plan is in [docs/plan.md](docs/plan.md). It has three phases:

- Phase 0: project skeleton, local run, first deploy, measurements.
- Phase 1: editor, projects and autosave.
- Phase 2: version history, named versions and branches. This is the deployed app.

The app is deployed at https://draw.huynhduongsh1.workers.dev.

## Commands

Install [Vite+](https://viteplus.dev/guide) (`vp`), then run `vp install`.

| Task                                     | Command                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Local app with Worker and Durable Object | `vp -C apps/web dev`                                                       |
| Format, lint, type check                 | `vp check`                                                                 |
| Tests                                    | `vp test`                                                                  |
| Build                                    | `vp -C apps/web build`                                                     |
| Deploy                                   | `vp run deploy` (needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`) |
