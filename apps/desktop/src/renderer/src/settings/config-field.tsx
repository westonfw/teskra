import { Tag, Typography } from 'antd'
import type { PropsWithChildren, ReactNode } from 'react'

import type { ConfigLayerName } from '@teskra/contracts'

import { useTranslation, type TranslationKey } from '../i18n'
import { useSettingsStore } from './settings-store'

const sourceLabelKeys: Record<ConfigLayerName, TranslationKey> = {
  default: 'settings.source.default',
  global: 'settings.source.global',
  workspace: 'settings.source.workspace',
  override: 'settings.source.override',
}

interface ConfigFieldProps extends PropsWithChildren {
  readonly path: string
  readonly label: ReactNode
  readonly description: string
}

export function ConfigField({ path, label, description, children }: ConfigFieldProps) {
  const { t } = useTranslation()
  const source = useSettingsStore((state) => state.resolved?.sources[path] ?? 'default')

  return (
    <div className="settings-field">
      <div className="settings-field-copy">
        <div className="settings-field-title">
          <Typography.Text strong>{label}</Typography.Text>
          <Tag bordered={false} color={source === 'workspace' ? 'cyan' : undefined}>
            {t(sourceLabelKeys[source])}
          </Tag>
        </div>
        <Typography.Text type="secondary">{description}</Typography.Text>
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  )
}
