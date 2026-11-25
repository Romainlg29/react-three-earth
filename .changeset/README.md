# Changesets

Every pull request that changes what a published package does adds a changeset: run `pnpm changeset`, pick the
packages, the bump (patch, minor, major) and write one line for the changelog. Docs-only or playground-only changes
need none.

Releasing (see `.github/workflows/release.yml`):

1. On every push to `master`, the Release workflow opens or updates a "Version packages" pull request that applies
   the pending changesets: new versions and changelogs.
2. Merge that pull request when you want to release.
3. Run the Release workflow by hand (Actions → Release → Run workflow) on `master`. With no changeset left pending, it
   builds and publishes every package whose version is not on npm yet, then tags it. It needs the `NPM_TOKEN`
   repository secret (an npm automation token with publish rights on the `@earthkit` scope).

The `@earthkit/*` packages are versioned in lockstep (`fixed` in `config.json`), so the same version of every package
works together. Plugins take `@earthkit/globe` as a peer dependency with a `0.x` range (and `workspace:*` as a dev
dependency for the build); move that range to `^1.0.0` at 1.0. A plugin package added later (for example
`@earthkit/terrain-style`) joins the group by its name alone.
