# Working on earthkit

Guidance for coding agents and contributors changing this repository. To *use* the library in an app,
read the shipped skills in [packages/react-three-earth/skills/](packages/react-three-earth/skills/)
instead.

## Layout

- `packages/react-three-earth`: the library.
  - `src/core`: vanilla three.js classes (`Earth`, `Terrain`, `Imagery`, `Atmosphere`, `EarthControls`,
    sources, camera helpers). Exported from `src/index.ts`.
  - `src/react`: R3F v10 components and hooks wrapping the core classes. Exported from `src/react/index.tsx`.
  - `src/atmosphere`: Bruneton 2017 precomputed scattering in TSL, solar ephemeris.
  - `src/tiles`: 3DTilesRenderer plugins; `src/tiles/imagery` is the GPU imagery compositor.
  - `skills/`: Agent Skills shipped in the npm package (TanStack Intent format).
  - `test/`: vitest unit tests.
- `packages/draw`: `@earthkit/draw`, headless drawing and editing as a plugin, built only on the library's
  public API (`src/modes` for the tools, `src/render` for the draped features and the live overlay). Ships its own
  skills in `packages/draw/skills/`.
- `apps/playground`: Vite app on the library source. `?fixtures` serves synthetic tiles, `?test=precision`
  is the centimetre test, `?atmosphere=0` turns the atmosphere off, `?markers` adds markers and popups, `?strict`
  renders under React's StrictMode, `?example=<name>` opens a gallery example (`src/examples/`, live data or `?fixtures`). `tests/run.mjs` drives it in Chromium.
- `docs/spike/SPIKE.md`: what was built and measured so far. Read it before architectural changes.

## Rules

- WebGPU first, with three's WebGL2 fallback: node materials and TSL only, no GLSL or `onBeforeCompile`.
- Full names, no abbreviations. SI units spelled out in public names: `heightMeters`, `memoryBudgetBytes`,
  `imageryCompositionBudgetMilliseconds`.
- `protected`, not `#private`, so classes stay extensible.
- Vanilla is first-class: every React component wraps a core class of the same name, and the React layer
  only wires it to R3F (scheduler, render pipeline, context).
- Composable JSX: layers hold source components (`<Terrain><QuantizedMeshSource /></Terrain>`).
- Errors and warnings state the fix (`<RasterTileSource> must sit inside <Imagery>`).
- The library makes no network request of its own; every URL comes from the app.
- Performance floor: 60 fps on a Pixel, constant 60 fps on an iPhone.
- three is pinned to r187, 3d-tiles-renderer to 0.5.4 and @mapbox/tiny-sdf to 2.3.0: some code overrides their private APIs
  (`composeRegionsOnGpu.ts`, `ImageOverlayPlugin.ts`, `MapStyleOverlay.setRegionVisible`; `Earth.hasListeners` reads three's `EventDispatcher._listeners`; `GlyphProvider.drawLocal` sets TinySDF's untyped `ctx.font` for clusters). Re-check those when bumping.

## Releases

The packages publish to npm under the `@earthkit` scope (`@earthkit/globe`, `@earthkit/draw`, …) with changesets. A
pull request that changes a published package adds one (`pnpm changeset`); see [.changeset/README.md](.changeset/README.md).
Never publish from a local machine.

## Checks

Run before pushing. CI runs the first four on every pull request; the browser checks are local only, so
run them yourself when you change rendering.

```sh
pnpm typecheck
pnpm test        # about 10 s; `pnpm test:changed` runs only the unit tests the branch's changes reach
pnpm -r --if-present validate:skills
pnpm build
pnpm dev &   # then:
xvfb-run -a node apps/playground/tests/run.mjs && node apps/playground/tests/assert-results.mjs
```

`run.mjs` runs only the browser checks a change can reach, and nothing when no change reaches any. Each check
(`labels/webgl2`, `draw/editing-globe-touch`, … 100 of them) records the source lines it ran when it last passed: in
the page, in its workers, in `run.mjs` and in its assertions in `assert-results.mjs`. A check runs again only when one
of those lines changed (or the code around an inserted line ran), when a file coverage cannot see changed (fixtures,
`vite.config.ts`, `public/`, the lockfile), or when it failed last time. Comments, blank lines and types never run
anything. So a fix round reruns the one check you are fixing, not the area, and never a check that already passed
on the same code.

- `run.mjs --list` prints what would run and why, without a browser or dev server. Use it before a run.
- `run.mjs labels/webgl2` runs one check, `run.mjs labels buildings` named areas, whatever changed.
- `run.mjs --all` runs every check (10 to 15 minutes): to refresh the baseline, never for a fix round.
- Always run `assert-results.mjs` after `run.mjs`: it keeps the record of the checks that passed (in
  `apps/playground/test-results/`) and drops those that failed, so the next run skips exactly the passing ones.
- `tests/check-coverage.json.gz` is the committed starting point for fresh clones. After an `--all` run that passes,
  `assert-results.mjs --save-baseline` refreshes it; commit it only then, in its own commit.

What the selection cannot see, so a periodic `--all` run covers it: a page's popups or its own navigations
(`location.href`), a statement added at the top level of a file that had no runtime code, and Node-side state
one check leaves for the next. A check whose worker was terminated without a stand-in, or whose files were edited
during the run, keeps no record and always runs until it passes cleanly.

Do not rerun checks that passed when nothing they ran changed, and do not run whole areas or `--all` to be safe:
the selection is the safety. Name a check only when you need it to run regardless (for example a flaky result).

Outside the dev sandbox, install Playwright once with `npm i -g playwright@1.63.0 && npx playwright@1.63.0 install chromium`
and run the checks with `NODE_PATH="$(npm root -g)"` in front. The browser checks need a headed Chromium (headless drops the WebGPU device);
the sandbox cannot reach tile hosts, so they use `?fixtures`. They run on SwiftShader, a CPU
rasteriser: they prove correctness, never frame times. On a machine with a GPU (Windows included, no xvfb), set
`BROWSER_CHECKS_GPU=1` to run them on it, about four times faster. Screenshots land in `apps/playground/test-results/`.

## Keeping the skills current

The skills are part of the public API. When you change a public name, a default, a prop or a behaviour:

1. Update every skill that mentions it (`grep -r <name> packages/react-three-earth/skills`). Each skill
   lists the files it is derived from under `sources:` in its frontmatter.
2. Run `pnpm -r --if-present validate:skills`: it typechecks every TypeScript example
   against the source, so a renamed export fails here. Mark a fence `no-check` only when it cannot compile
   on its own (for example a Playwright script).
3. New features that an app developer would ask an agent about get a section in an existing skill, or a
   new `skills/<task-name>/SKILL.md` with a "Use when…" description, Setup / Core Patterns / Common
   Mistakes / Completion sections, under 500 lines. List it in the README's skills table.
