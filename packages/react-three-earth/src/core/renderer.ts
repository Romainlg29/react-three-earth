/**
 * Whether this browser should render through three's WebGL 2 backend (`forceWebGL: true`) rather than
 * WebGPU. True in Safari and every iOS and iPadOS browser (all WebKit). Measured in November 2026 on a Mac
 * M4: Safari's WebGPU spent 27 ms of main-thread time per frame on a map that its WebGL 2 backend draws at
 * 60 fps, and Chrome's WebGPU in 2.5 ms. Revisit when Safari's WebGPU improves. The same TSL materials run
 * on both backends, so nothing else changes.
 *
 * ```tsx
 * <Canvas renderer={{ forceWebGL: prefersWebGLBackend(), reversedDepthBuffer: true }}>
 * ```
 */
export function prefersWebGLBackend(
  userAgent: string = globalThis.navigator?.userAgent ?? '',
  maximumTouchPoints: number = globalThis.navigator?.maxTouchPoints ?? 0,
): boolean {
  // iOS: every browser is WebKit underneath, whatever its name.
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return true
  // iPadOS reports a Mac by default; only the touch screen tells them apart.
  if (/\bMacintosh\b/.test(userAgent) && maximumTouchPoints > 1) return true
  // Desktop Safari says "Safari" and "Version/"; Chromium-based browsers and Firefox also say "Safari"
  // but name themselves.
  return /\bVersion\/[\d.]+.*\bSafari\//.test(userAgent) && !/\b(Chrome|Chromium|CriOS|Edg|EdgiOS|Firefox|FxiOS|OPR)\//.test(userAgent)
}
