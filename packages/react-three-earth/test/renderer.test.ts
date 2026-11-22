import { describe, expect, it } from 'vitest'

import { prefersWebGLBackend } from '../src/core/renderer.js'

const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15'
const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const edge = `${chrome} Edg/142.0.0.0`
const firefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0'
const iphoneChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1'
const android = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'

describe('prefersWebGLBackend', () => {
  it('picks WebGL 2 in Safari and every iOS browser', () => {
    expect(prefersWebGLBackend(safari)).toBe(true)
    expect(prefersWebGLBackend(iphoneChrome)).toBe(true)
  })

  it('keeps WebGPU in Chromium browsers and Firefox', () => {
    for (const userAgent of [chrome, edge, firefox, android, '']) expect(prefersWebGLBackend(userAgent)).toBe(false)
  })
})
