# Working on react-three-earth

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
- `apps/playground`: Vite app on the library source. `?fixtures` serves synthetic tiles, `?test=precision`
  is the centimetre test, `?atmosphere=0` turns the atmosphere off, `?markers` adds markers and popups, `?strict`
  renders under React's StrictMode. `tests/run.mjs` drives it in Chromium.
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

## Checks

Run before pushing. CI runs the first four on every pull request; the browser checks are local only, so
run them yourself when you change rendering.

```sh
pnpm typecheck
pnpm test
pnpm --filter react-three-earth validate:skills
pnpm build
pnpm dev &   # then:
xvfb-run -a node apps/playground/tests/run.mjs && node apps/playground/tests/assert-results.mjs
```

Outside the dev sandbox, install Playwright once with `npm i -g playwright@1.63.0 && npx playwright@1.63.0 install chromium`
and run the checks with `NODE_PATH="$(npm root -g)"` in front. The browser checks need a headed Chromium (headless drops the WebGPU device) and take about 1.5 minutes
locally; the sandbox cannot reach tile hosts, so they use `?fixtures`. They run on SwiftShader, a CPU
rasteriser: they prove correctness, never frame times. Screenshots land in `apps/playground/test-results/`.

## Keeping the skills current

The skills are part of the public API. When you change a public name, a default, a prop or a behaviour:

1. Update every skill that mentions it (`grep -r <name> packages/react-three-earth/skills`). Each skill
   lists the files it is derived from under `sources:` in its frontmatter.
2. Run `pnpm --filter react-three-earth validate:skills`: it typechecks every TypeScript example
   against the source, so a renamed export fails here. Mark a fence `no-check` only when it cannot compile
   on its own (for example a Playwright script).
3. New features that an app developer would ask an agent about get a section in an existing skill, or a
   new `skills/<task-name>/SKILL.md` with a "Use when…" description, Setup / Core Patterns / Common
   Mistakes / Completion sections, under 500 lines. List it in the README's skills table.
