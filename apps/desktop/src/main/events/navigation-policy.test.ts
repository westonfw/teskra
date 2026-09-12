import { describe, expect, it } from 'vitest'

import { isAllowedNavigation } from './navigation-policy'

describe('navigation policy (P1-10)', () => {
  describe('dev mode (vite dev server)', () => {
    const rendererUrl = 'http://localhost:5173'

    it('allows same-origin navigations such as HMR full reloads', () => {
      expect(isAllowedNavigation('http://localhost:5173/', rendererUrl)).toBe(true)
      expect(isAllowedNavigation('http://localhost:5173/workspace/abc', rendererUrl)).toBe(true)
      expect(isAllowedNavigation('http://localhost:5173/?t=123#hash', rendererUrl)).toBe(true)
    })

    it('denies a different origin, port, or scheme on the same host', () => {
      expect(isAllowedNavigation('http://localhost:5174/', rendererUrl)).toBe(false)
      expect(isAllowedNavigation('https://localhost:5173/', rendererUrl)).toBe(false)
      expect(isAllowedNavigation('http://127.0.0.1:5173/', rendererUrl)).toBe(false)
    })

    it('denies external URLs', () => {
      expect(isAllowedNavigation('https://example.com/', rendererUrl)).toBe(false)
      expect(isAllowedNavigation('file:///etc/passwd', rendererUrl)).toBe(false)
    })
  })

  describe('packaged mode (no rendererUrl)', () => {
    it('allows file: navigations within the bundled app', () => {
      expect(isAllowedNavigation('file:///app/out/renderer/index.html')).toBe(true)
      expect(isAllowedNavigation('file:///app/out/renderer/index.html#route')).toBe(true)
    })

    it('denies any remote navigation', () => {
      expect(isAllowedNavigation('https://example.com/')).toBe(false)
      expect(isAllowedNavigation('http://localhost:5173/')).toBe(false)
    })
  })

  it('denies malformed URLs and unusable renderer origins', () => {
    expect(isAllowedNavigation('not a url', 'http://localhost:5173')).toBe(false)
    expect(isAllowedNavigation('http://localhost:5173/', 'not a url')).toBe(false)
    expect(isAllowedNavigation('not a url')).toBe(false)
  })
})
