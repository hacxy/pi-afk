import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 全局配置（~/.afk/config.json）——全局唯一配置源（无项目级配置层）。
 * 只保留用户真正会改的 5 个字段，其余行为项（completionSignal）硬编码为代码常量。
 */
export interface GlobalConfig {
  /** 沙箱镜像名 */
  image: string
  /** 默认模型（pi 的 provider/model 格式） */
  model: string
  /** 拉取 issue 的标签（任一命中即拉取；空数组 = 不过滤，拉取所有开放 issue） */
  labels: string[]
  /** 完成后自动合并 PR（默认关闭，保守；AFK 切片语义下可开启） */
  autoMerge?: boolean
  /** 可选验证门：发布（T8）push 前在分支临时 worktree 执行该命令，非零退出不发版（默认缺省 = 跳过验证） */
  verifyCommand?: string
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  image: 'pi-afk:latest',
  model: 'deepseek/deepseek-v4-flash',
  labels: [],
}

export function globalConfigPath(): string {
  return join(homedir(), '.afk', 'config.json')
}

/**
 * 项目日志目录（issue #33）：事件流与沙箱日志写入**目标项目目录下的 .sandcastle/logs/**，
 * 不再写入全局 ~/.afk/logs（旧文件保留原地，不迁移不双写）。每项目独立，可随仓库携带/清理。
 */
export function projectLogDir(projectDir: string): string {
  return join(projectDir, '.sandcastle', 'logs')
}

/** 完成信号（与模板协议强耦合，固定为代码常量，不再可配置） */
export const COMPLETION_SIGNAL = '<promise>COMPLETE</promise>'

/** 归一化 labels：兼容旧字段 label（字符串或数组）→ labels 数组；非法值回退空数组 */
function normalizeLabels(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return [raw]
  }
  return []
}

/** 归一化 verifyCommand：仅字符串且非空白才生效（trim 后），其余 → undefined（跳过验证） */
function normalizeVerifyCommand(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function loadGlobalConfig(filePath = globalConfigPath()): GlobalConfig {
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<GlobalConfig> & {
        label?: string | string[]
      }
      // 只读 5 个字段；旧配置中的其他字段（logDir/completionSignal/promptFile 等）被忽略且不报错
      // （logDir 已废弃：日志位置改为项目 .sandcastle/logs/，不受全局配置影响）。
      // labels 优先；旧字段 label（字符串/数组）自动迁移为 labels 数组
      const labels = normalizeLabels(raw.labels ?? raw.label)
      return {
        image: raw.image ?? DEFAULT_GLOBAL_CONFIG.image,
        model: raw.model ?? DEFAULT_GLOBAL_CONFIG.model,
        labels,
        autoMerge: raw.autoMerge ?? DEFAULT_GLOBAL_CONFIG.autoMerge,
        verifyCommand: normalizeVerifyCommand(raw.verifyCommand),
      }
    } catch {
      // 配置损坏时回退默认
    }
  }
  return { ...DEFAULT_GLOBAL_CONFIG }
}
