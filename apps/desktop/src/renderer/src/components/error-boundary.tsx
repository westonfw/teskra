import { Button, Result, Typography } from 'antd'
import { Component, type ErrorInfo, type ReactNode } from 'react'

import { translate, useLocaleStore, type TranslationKey } from '../i18n'

export interface ErrorBoundaryState {
  readonly error: Error | null
}

interface ErrorBoundaryProps {
  readonly children: ReactNode
}

/**
 * Root error boundary (code-review P2-12). Without it any render exception
 * unmounts the whole tree into a white screen. Class component on purpose:
 * error boundaries are the one React feature with no hook equivalent.
 *
 * The fallback UI lives OUTSIDE App's ConfigProvider (it must still render
 * when App itself crashed), so it resolves translations imperatively from the
 * locale store instead of the useTranslation hook.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  state: ErrorBoundaryState = { error: null }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // No logger reaches the renderer; the main-process log gets the crash via
    // the console transport, so keep the component stack for diagnosis.
    console.error('[teskra] renderer crashed:', error, info.componentStack)
  }

  private readonly reload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const { error } = this.state
    if (error === null) {
      return this.props.children
    }
    const t = (key: TranslationKey): string => translate(useLocaleStore.getState().locale, key)
    return (
      <Result
        status="error"
        title={t('errorBoundary.title')}
        subTitle={t('errorBoundary.description')}
        extra={[
          <Button key="reload" type="primary" onClick={this.reload}>
            {t('errorBoundary.reload')}
          </Button>,
        ]}
      >
        <Typography.Paragraph type="secondary" copyable>
          {error.message}
        </Typography.Paragraph>
      </Result>
    )
  }
}
