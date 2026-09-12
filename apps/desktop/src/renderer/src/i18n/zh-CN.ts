import type { TranslationKey } from './en-US'

/** 中文字典：必须为 en-US 的每个键提供译文（类型层面强制）。 */
export const zhCN: Record<TranslationKey, string> = {
  'app.tagline': '统一调度你的 Coding Agent。',
  'app.language': '语言',
  'app.language.en-US': 'English',
  'app.language.zh-CN': '中文',

  'nav.home': '首页',
  'nav.workspace': '工作区',
  'nav.tasks': '任务',
  'nav.runs': '运行',
  'nav.git': 'Git',
  'nav.terminal': '终端',
  'nav.doctor': '诊断',
  'nav.recovery': '恢复',
  'nav.settings': '设置',

  'topbar.noWorkspace': '未选择工作区',
  'topbar.noBranch': '无分支',

  'workspaceRequired.body': '请先打开一个工作区，再使用{feature}。',
  'workspaceRequired.action': '选择工作区',

  'agent.attendedWarning': '直接修改主工作区，未做隔离',
  'agent.attendedWarningDetail': 'Attended 运行直接使用当前工作区，提交前请检查变更。',
  'agent.noEnforcement': '该 Agent 的权限无法由 Teskra 约束，仅依赖 worktree 隔离',
  'agent.noEnforcementDetail':
    '该 Agent 没有 Teskra 可投影的权限机制，其 approval 模式无法强制执行。',
  'agent.noEnforcementDetailInteractive':
    '该 Agent 没有 Teskra 可投影的权限机制。approval 模式对其无效，只有 worktree 隔离能限制它的改动范围。',
  'agentPicker.suggestAlternative': '建议改用 {name}',
}
