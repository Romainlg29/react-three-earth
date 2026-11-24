// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ImagerySource, TerrainSource } from '../src/core/sources.js'
import { ImagerySourceContext, TerrainSourceContext, type SourceRegistry } from '../src/react/context.js'
import { useRegisterImagerySource, useRegisterTerrainSource } from '../src/react/index.js'

// React's act() needs this flag outside a test renderer.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const imagerySource: ImagerySource = { kind: 'imagery', createOverlay: () => ({}) }
const terrainSource: TerrainSource = { kind: 'terrain', url: 'https://example.com/terrain/', createPlugins: () => [] }

function TenantImagerySource() {
  useRegisterImagerySource(imagerySource, 'TenantImagerySource')
  return null
}

function TenantTerrainSource() {
  useRegisterTerrainSource(terrainSource, 'TenantTerrainSource')
  return null
}

afterEach(() => {
  vi.restoreAllMocks()
})

function createRegistry<T>() {
  const unregister = vi.fn()
  const registry: SourceRegistry<T> = { register: vi.fn(() => unregister) }
  return { registry, unregister }
}

const roots = new Set<ReturnType<typeof createRoot>>()

function render(element: ReactNode) {
  const root = createRoot(document.createElement('div'))
  roots.add(root)
  act(() => root.render(element))
  return root
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots.clear()
})

describe('third-party source components', () => {
  it('register an imagery source with the surrounding <Imagery> and unregister it on unmount', () => {
    const { registry, unregister } = createRegistry<ImagerySource>()
    const root = render(createElement(ImagerySourceContext, { value: registry }, createElement(TenantImagerySource)))
    expect(registry.register).toHaveBeenCalledExactlyOnceWith(imagerySource)
    expect(unregister).not.toHaveBeenCalled()
    act(() => root.unmount())
    roots.delete(root)
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('register a terrain source with the surrounding <Terrain>', () => {
    const { registry } = createRegistry<TerrainSource>()
    render(createElement(TerrainSourceContext, { value: registry }, createElement(TenantTerrainSource)))
    expect(registry.register).toHaveBeenCalledExactlyOnceWith(terrainSource)
  })

  it('replace the registered source when the component gets a new instance', () => {
    const { registry, unregister } = createRegistry<ImagerySource>()
    const otherSource: ImagerySource = { kind: 'imagery', createOverlay: () => ({}) }
    function Switching({ source }: { source: ImagerySource }) {
      useRegisterImagerySource(source, 'Switching')
      return null
    }
    const root = render(createElement(ImagerySourceContext, { value: registry }, createElement(Switching, { source: imagerySource })))
    act(() => root.render(createElement(ImagerySourceContext, { value: registry }, createElement(Switching, { source: otherSource }))))
    expect(unregister).toHaveBeenCalledOnce()
    expect(registry.register).toHaveBeenLastCalledWith(otherSource)
    expect(registry.register).toHaveBeenCalledTimes(2)
  })

  it('name the component and its layer when used outside it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(createElement(TenantImagerySource))).toThrow('<TenantImagerySource> must sit inside <Imagery>.')
    expect(() => render(createElement(TenantTerrainSource))).toThrow('<TenantTerrainSource> must sit inside <Terrain>.')
  })
})
