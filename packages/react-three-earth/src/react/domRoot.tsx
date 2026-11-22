import { useContextBridge } from 'its-fine'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * Renders React children into a DOM element from inside the React Three Fiber tree, which cannot hold DOM
 * nodes itself. The contexts above (the app's, `<Earth>`'s, R3F's) are bridged in, so hooks such as `useEarth`
 * work in the children. Call it under an its-fine `<FiberProvider>`.
 */
export function useDomRoot(element: HTMLElement | null, children: ReactNode): void {
  const Bridge = useContextBridge()
  const root = useRef<Root | null>(null)

  useLayoutEffect(() => {
    if (element === null) return
    // A fresh host per run: under StrictMode the effect runs again before the last root's deferred unmount,
    // and two roots must never share an element. `display: contents` keeps it out of the layout.
    const host = element.ownerDocument.createElement('div')
    host.style.display = 'contents'
    element.append(host)
    const created = createRoot(host)
    root.current = created
    return () => {
      root.current = null
      // Not during this commit: React refuses to unmount a root synchronously while it renders another.
      queueMicrotask(() => {
        created.unmount()
        host.remove()
      })
    }
  }, [element])

  useLayoutEffect(() => {
    root.current?.render(<Bridge>{children}</Bridge>)
  })
}
