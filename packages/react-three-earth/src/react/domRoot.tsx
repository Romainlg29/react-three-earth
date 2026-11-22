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
    const created = createRoot(element)
    root.current = created
    return () => {
      root.current = null
      // Not during this commit: React refuses to unmount a root synchronously while it renders another.
      queueMicrotask(() => created.unmount())
    }
  }, [element])

  useLayoutEffect(() => {
    root.current?.render(<Bridge>{children}</Bridge>)
  })
}
