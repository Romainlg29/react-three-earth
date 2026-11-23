const STYLE_ELEMENT_ATTRIBUTE = 'data-react-three-earth-controls-style'

/**
 * The CSS of the map controls, injected once per document. Everything an app would restyle is a CSS variable:
 * `--react-three-earth-control-background`, `-color`, `-hover-background`, `-active-color` (the geolocate dot
 * and the pressed state), `-error-color`, `-shadow`, `-radius`, `-size` (button side) and
 * `--react-three-earth-controls-margin` (distance from the corners), `--react-three-earth-controls-bottom-margin`
 * (extra room at the bottom for the attribution).
 *
 * Touch screens (`pointer: coarse`) get 44-pixel buttons, Apple's minimum target, and the corners keep clear of
 * the notch and the home indicator with the safe-area insets.
 */
const STYLE = `
.react-three-earth-controls {
  position: absolute; z-index: 2; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px;
  max-width: 100%; max-height: 100%; pointer-events: none;
  --react-three-earth-control-size: 29px;
}
@media (pointer: coarse) { .react-three-earth-controls { --react-three-earth-control-size: 44px; } }
.react-three-earth-controls[data-position="top-left"], .react-three-earth-controls[data-position="top-right"] {
  top: 0; padding-top: calc(var(--react-three-earth-controls-margin, 10px) + env(safe-area-inset-top, 0px));
}
.react-three-earth-controls[data-position="bottom-left"], .react-three-earth-controls[data-position="bottom-right"] {
  bottom: 0; justify-content: flex-end;
  padding-bottom: calc(var(--react-three-earth-controls-bottom-margin, 28px) + env(safe-area-inset-bottom, 0px));
}
.react-three-earth-controls[data-position="top-left"], .react-three-earth-controls[data-position="bottom-left"] {
  left: 0; align-items: flex-start; padding-left: calc(var(--react-three-earth-controls-margin, 10px) + env(safe-area-inset-left, 0px));
}
.react-three-earth-controls[data-position="top-right"], .react-three-earth-controls[data-position="bottom-right"] {
  right: 0; align-items: flex-end; padding-right: calc(var(--react-three-earth-controls-margin, 10px) + env(safe-area-inset-right, 0px));
}
.react-three-earth-control-group {
  display: flex; flex-direction: column; overflow: hidden; pointer-events: auto;
  border-radius: var(--react-three-earth-control-radius, 6px);
  background: var(--react-three-earth-control-background, #fff);
  box-shadow: var(--react-three-earth-control-shadow, 0 0 0 2px rgba(0, 0, 0, 0.1));
  touch-action: manipulation;
}
.react-three-earth-control-group[hidden], .react-three-earth-scale[hidden] { display: none; }
.react-three-earth-control-button {
  all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center; cursor: pointer;
  width: var(--react-three-earth-control-size); height: var(--react-three-earth-control-size); min-width: var(--react-three-earth-control-size);
  color: var(--react-three-earth-control-color, #333); font: 600 12px/1 system-ui, sans-serif;
  -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none;
}
.react-three-earth-control-button + .react-three-earth-control-button { border-top: 1px solid rgba(0, 0, 0, 0.1); }
.react-three-earth-control-button svg { width: 20px; height: 20px; fill: currentColor; pointer-events: none; }
@media (hover: hover) { .react-three-earth-control-button:not(:disabled):hover { background: var(--react-three-earth-control-hover-background, rgba(0, 0, 0, 0.05)); } }
.react-three-earth-control-button:not(:disabled):active { background: var(--react-three-earth-control-hover-background, rgba(0, 0, 0, 0.1)); }
.react-three-earth-control-button:focus-visible { outline: 2px solid var(--react-three-earth-control-active-color, #33b5e5); outline-offset: -2px; }
.react-three-earth-control-button:disabled { opacity: 0.4; cursor: not-allowed; }
.react-three-earth-control-button[data-state="active"] { color: var(--react-three-earth-control-active-color, #33b5e5); }
.react-three-earth-control-button[data-state="background"] { color: var(--react-three-earth-control-active-color, #33b5e5); opacity: 0.7; }
.react-three-earth-control-button[data-state="waiting"] svg { animation: react-three-earth-pulse 1s ease-in-out infinite; }
.react-three-earth-control-button[data-state="error"] { color: var(--react-three-earth-control-error-color, #e58978); }
.react-three-earth-compass-needle { transition: transform 0.05s linear; transform-origin: 50% 50%; }
.react-three-earth-control-button[data-north="true"] .react-three-earth-compass-needle { opacity: 0.75; }
.react-three-earth-scale {
  box-sizing: border-box; pointer-events: none; white-space: nowrap; text-align: center; padding: 0 5px; min-width: 20px;
  font: 11px/18px system-ui, sans-serif; color: var(--react-three-earth-control-color, #333);
  background: var(--react-three-earth-control-scale-background, rgba(255, 255, 255, 0.75));
  border: 2px solid var(--react-three-earth-control-color, #333); border-top: none; border-radius: 0 0 3px 3px;
}
.react-three-earth-user-dot {
  width: 15px; height: 15px; box-sizing: border-box; border-radius: 50%; border: 2px solid #fff;
  background: var(--react-three-earth-control-active-color, #33b5e5); box-shadow: 0 0 3px rgba(0, 0, 0, 0.35);
}
.react-three-earth-user-dot[data-stale="true"] { background: #a8a8a8; }
.react-three-earth-accuracy-circle {
  box-sizing: border-box; border-radius: 50%; pointer-events: none;
  background: rgba(51, 181, 229, 0.2); border: 1px solid rgba(51, 181, 229, 0.5);
}
.react-three-earth-pseudo-fullscreen {
  position: fixed !important; inset: 0 !important; width: 100% !important; height: 100% !important; height: 100dvh !important;
  max-width: none !important; max-height: none !important; margin: 0 !important; z-index: 2147483000 !important;
}
@keyframes react-three-earth-pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .react-three-earth-control-button[data-state="waiting"] svg { animation: none; }
  .react-three-earth-compass-needle { transition: none; }
}
`

export function ensureControlsStyle(document: Document): void {
  if (document.head.querySelector(`style[${STYLE_ELEMENT_ATTRIBUTE}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute(STYLE_ELEMENT_ATTRIBUTE, '')
  style.textContent = STYLE
  document.head.append(style)
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/** A 20 × 20 icon from SVG path data, built with DOM calls (never `innerHTML`). */
export function createIcon(document: Document, ...paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const data of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path')
    path.setAttribute('d', data)
    svg.append(path)
  }
  return svg
}

/** A `<button>` of the control style with an accessible name. */
export function createControlButton(document: Document, label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'react-three-earth-control-button'
  setButtonLabel(button, label)
  return button
}

export function setButtonLabel(button: HTMLElement, label: string): void {
  button.title = label
  button.setAttribute('aria-label', label)
}
