const POSITIONED_ATTRIBUTE = 'data-react-three-earth-positioned'
const holders = new WeakMap<HTMLElement, number>()

/**
 * Makes a static container `position: relative`, so overlays (markers, popups, controls) can be placed in it
 * absolutely. Counted: the container gets its position back when the last holder lets go with
 * `releaseContainerPosition`. A container positioned by the app is left as it is.
 */
export function holdContainerPosition(container: HTMLElement): void {
  const count = holders.get(container) ?? 0
  const position = count === 0 ? container.ownerDocument.defaultView?.getComputedStyle(container).position : undefined
  // Some DOM implementations report an unset position as '' rather than 'static'.
  if (position === 'static' || position === '') {
    container.style.position = 'relative'
    container.setAttribute(POSITIONED_ATTRIBUTE, '')
  }
  holders.set(container, count + 1)
}

/** Lets go of a position held with `holdContainerPosition`. */
export function releaseContainerPosition(container: HTMLElement): void {
  const count = (holders.get(container) ?? 1) - 1
  if (count > 0) {
    holders.set(container, count)
    return
  }
  holders.delete(container)
  if (container.hasAttribute(POSITIONED_ATTRIBUTE)) {
    container.removeAttribute(POSITIONED_ATTRIBUTE)
    container.style.position = ''
  }
}
