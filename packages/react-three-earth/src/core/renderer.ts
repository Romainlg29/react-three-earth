/**
 * Whether this browser should render through three's WebGL 2 backend (`forceWebGL: true`) rather than
 * WebGPU. True in Safari and every iOS browser (all WebKit): on a Mac M4, Safari's WebGPU spent 27 ms of
 * main-thread time per frame on a map that WebGL 2 draws at 60 fps, and Chrome's WebGPU in 2.5 ms. The same
 * TSL materials run on both backends, so nothing else changes.
 *
 * ```tsx
 * <Canvas renderer={{ forceWebGL: prefersWebGLBackend(), reversedDepthBuffer: true }}>
 * ```
 */
export function prefersWebGLBackend(userAgent: string = globalThis.navigator?.userAgent ?? ''): boolean {
  // iOS: every browser is WebKit underneath, whatever its name.
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return true
  // Desktop Safari says "Safari" and "Version/"; Chromium-based browsers and Firefox also say "Safari"
  // but name themselves.
  return /\bVersion\/[\d.]+.*\bSafari\//.test(userAgent) && !/\b(Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|OPR)\//.test(userAgent)
}
