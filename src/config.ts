import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 全局配置（~/.afk/config.json）——全局唯一配置源（共识 T2）。
 * 只保留用户真正会改的 4 个字段，其余行为项（logDir / completionSignal）硬编码为代码常量。
 */
export interface GlobalConfig {
  /** 沙箱镜像名 */
  image: string
  /** 默认模型（pi 的 provider/model 格式） */
  model: string
  /** GitHub issue 标签 */
  label: string
  /** 完成后自动合并 PR（默认关闭，保守；AFK 切片语义下可开启） */
  autoMerge?: boolean
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  image: 'pi-afk:latest',
  model: 'deepseek/deepseek-v4-flash',
  label: 'afk',
}

export function globalConfigPath(): string {
  return join(homedir(), '.afk', 'config.json')
}

export function expandTilde(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/** 全局日志目录（固定 ~/.afk/logs，不再可配置） */
export const LOG_DIR = expandTilde('~/.afk/logs')

/** 完成信号（与模板协议强耦合，固定为代码常量，不再可配置） */
export const COMPLETION_SIGNAL = '<promise>COMPLETE</promise>'

export function loadGlobalConfig(filePath = globalConfigPath()): GlobalConfig {
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<GlobalConfig>
      // 只读 4 个字段；旧配置中的其他字段（logDir/completionSignal/promptFile 等）被忽略且不报错
      return {
        image: raw.image ?? DEFAULT_GLOBAL_CONFIG.image,
        model: raw.model ?? DEFAULT_GLOBAL_CONFIG.model,
        label: raw.label ?? DEFAULT_GLOBAL_CONFIG.label,
        autoMerge: raw.autoMerge ?? DEFAULT_GLOBAL_CONFIG.autoMerge,
      }
    } catch {
      // 配置损坏时回退默认
    }
  }
  return { ...DEFAULT_GLOBAL_CONFIG }
}

/** 确保全局日志目录存在（固定路径） */
export function ensureGlobalDirs(): string {
  mkdirSync(LOG_DIR, { recursive: true })
  return LOG_DIR
}
