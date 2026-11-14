# draw

A diagram app: an Excalidraw editor with a project list, autosave, a version history with named versions, and branches. It runs on the Cloudflare free plan (one Worker, one Durable Object for each project, one D1 database).

The repository has no application code yet. The plan is in [docs/plan.md](docs/plan.md). It has three phases:

- Phase 0: project skeleton, local run, first deploy, measurements.
- Phase 1: editor, projects and autosave.
- Phase 2: version history, named versions and branches.
