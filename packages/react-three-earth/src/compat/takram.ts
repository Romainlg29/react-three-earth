// The only door to @takram's webgpu modules, so a version bump or a vendored copy changes one file.
//
// three >= 0.185 broke @takram/three-* 0.19.1 (their last release, May 2026): struct(...).layout is gone.
// The workspace patches both packages (see /patches). Published builds will need takram to release a
// fix, or a vendored copy of the atmosphere; see SPIKE.md.
export * as atmosphere from '@takram/three-atmosphere/webgpu'
export * as geospatial from '@takram/three-geospatial/webgpu'
