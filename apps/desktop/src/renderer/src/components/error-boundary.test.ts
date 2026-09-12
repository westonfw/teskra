import { createElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { enUS } from '../i18n/en-US'
import { zhCN } from '../i18n/zh-CN'
import { ErrorBoundary } from './error-boundary'

describe('ErrorBoundary (P2-12)', () => {
  it('captures a thrown Error into state so render() can show the fallback', () => {
    const error = new Error('render exploded')
    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({ error })
  })

  it('wraps non-Error throws (e.g. a bare string) into an Error', () => {
    const state = ErrorBoundary.getDerivedStateFromError('boom')
    expect(state.error).toBeInstanceOf(Error)
    expect(state.error?.message).toBe('boom')
  })

  it('passes children through while no error was captured', () => {
    const boundary = new ErrorBoundary({ children: createElement('div') })
    expect(boundary.state).toEqual({ error: null })
    expect(boundary.render()).toBe(boundary.props.children)
  })

  it('renders the localized fallback once an error was captured', () => {
    const boundary = new ErrorBoundary({ children: null })
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('kaput'))
    const fallback = boundary.render() as { props: { title: string; subTitle: string } }
    expect(fallback.props.title).toBe(enUS['errorBoundary.title'])
    expect(fallback.props.subTitle).toBe(enUS['errorBoundary.description'])
  })

  it('has translations in both dictionaries (zh-CN must mirror en-US)', () => {
    for (const key of [
      'errorBoundary.title',
      'errorBoundary.description',
      'errorBoundary.reload',
    ] as const) {
      expect(typeof enUS[key]).toBe('string')
      expect(typeof zhCN[key]).toBe('string')
      expect(zhCN[key].length).toBeGreaterThan(0)
    }
  })

  it('keeps the boundary mounted after a catch (children replaceable on reload)', () => {
    const boundary = new ErrorBoundary({ children: createElement('span') as ReactNode })
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('x'))
    expect(boundary.render()).not.toBe(boundary.props.children)
  })
})
