import { Tag, Typography } from 'antd'
import type { PropsWithChildren, ReactNode } from 'react'

import type { ConfigLayerName } from '@teskra/contracts'

import { useSettingsStore } from './settings-store'

const sourceLabels: Record<ConfigLayerName, string> = {
  default: 'Built-in default',
  global: 'Global config',
  workspace: 'Workspace config',
  override: 'Run override',
}

interface ConfigFieldProps extends PropsWithChildren {
  readonly path: string
  readonly label: ReactNode
  readonly description: string
}

export function ConfigField({ path, label, description, children }: ConfigFieldProps) {
  const source = useSettingsStore((state) => state.resolved?.sources[path] ?? 'default')

  return (
    <div className="settings-field">
      <div className="settings-field-copy">
        <div className="settings-field-title">
          <Typography.Text strong>{label}</Typography.Text>
          <Tag bordered={false} color={source === 'workspace' ? 'cyan' : undefined}>
            {sourceLabels[source]}
          </Tag>
        </div>
        <Typography.Text type="secondary">{description}</Typography.Text>
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  )
}
