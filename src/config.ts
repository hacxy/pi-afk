import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 全局配置（~/.afk/config.json）
 */
export interface GlobalConfig {
  /** 沙箱镜像名 */
  image: string
  /** 默认模型（pi 的 provider/model 格式） */
  model: string
  /** GitHub issue 标签 */
  label: string
  /** 全局日志目录 */
  logDir: string
  /** 完成信号（agent 输出后结束迭代） */
  completionSignal: string
  /** 自定义提示词模板路径（默认用包内 prompts/ralph.md） */
  promptFile?: string
  /** 完成后自动合并 PR（默认关闭，保守；AFK 切片语义下可开启） */
  autoMerge?: boolean
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  image: 'pi-afk:latest',
  model: 'deepseek/deepseek-v4-flash',
  label: 'afk',
  logDir: '~/.afk/logs',
  completionSignal: '<promise>COMPLETE</promise>',
}

export function globalConfigPath(): string {
  return join(homedir(), '.afk', 'config.json')
}

export function expandTilde(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

export function loadGlobalConfig(): GlobalConfig {
  const file = globalConfigPath()
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<GlobalConfig>
      return {
        ...DEFAULT_GLOBAL_CONFIG,
        ...raw,
        logDir: expandTilde(raw.logDir ?? DEFAULT_GLOBAL_CONFIG.logDir),
      }
    } catch {
      // 配置损坏时回退默认
    }
  }
  return { ...DEFAULT_GLOBAL_CONFIG, logDir: expandTilde(DEFAULT_GLOBAL_CONFIG.logDir) }
}

/**
 * 项目级配置（.afkrc.json，可选）
 */
export interface ProjectConfig {
  /** 覆盖全局 label */
  label?: string
  /** 单次运行最大迭代数（未指定时用 CLI 参数） */
  maxIterations?: number
}

export function loadProjectConfig(projectDir: string): ProjectConfig {
  const file = join(projectDir, '.afkrc.json')
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as ProjectConfig
    } catch {
      // ignore
    }
  }
  return {}
}

/** 确保全局配置目录存在（含日志目录） */
export function ensureGlobalDirs(): string {
  const logDir = loadGlobalConfig().logDir
  mkdirSync(logDir, { recursive: true })
  return logDir
}
