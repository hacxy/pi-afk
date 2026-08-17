import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z, ZodError } from 'zod'

/** 配置文件名（相对项目根 cwd） */
export const CONFIG_FILE = '.pi/afk/config.json'

/** 合法 thinking 等级（pi --thinking 取值） */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 内置默认值（init 模板与 loadConfig 共用；不含可选键） */
export const DEFAULT_CONFIG = {
  model: 'deepseek/deepseek-v4-flash',
  thinking: 'medium',
  maxParallel: 2,
  todoLabel: 'agent:todo',
  doneLabel: 'agent:done',
  failedLabel: 'agent:failed',
  branchPrefix: 'afk',
  baseBranch: 'main',
  worktreesDir: '.pi/afk/worktrees',
  failedDir: '.pi/afk/failed',
  logsDir: '.pi/afk/logs',
  sessionsDir: '.pi/afk/sessions',
  idleTimeoutSec: 600,
  completionTimeoutSec: 60,
  // 完整流程：codereview + 合并 PR（默认关，opt-in）
  autoMerge: false,
  mergedLabel: 'agent:merged',
  maxReviewRounds: 2,
  conflictTries: 2,
  waitForChecks: true,
  mergeTimeoutSec: 600,
} as const

/** 项目配置（含可选 git 提交身份键，opt-in 成对） */
export interface Config {
  model: string
  thinking: (typeof THINKING_LEVELS)[number]
  maxParallel: number
  todoLabel: string
  doneLabel: string
  failedLabel: string
  branchPrefix: string
  baseBranch: string
  worktreesDir: string
  failedDir: string
  logsDir: string
  sessionsDir: string
  installCmd?: string
  idleTimeoutSec: number
  completionTimeoutSec: number
  gitAuthor?: string
  gitEmail?: string
  /** 合并 PR（false = review 通过后停在 PR，人工 merge） */
  autoMerge: boolean
  /** 合并成功后补打的 label */
  mergedLabel: string
  /** review agent 模型（缺省回落 model） */
  reviewerModel?: string
  /** review → 修复 循环上限 */
  maxReviewRounds: number
  /** merge 冲突 agent 化解尝试上限 */
  conflictTries: number
  /** merge 前等待 gh pr checks 通过 */
  waitForChecks: boolean
  /** 等 checks / 化解冲突的总超时（秒） */
  mergeTimeoutSec: number
}

/** 环境变量覆盖映射：AFK_* → 配置键 → 类型化（数字走 Number，坏值由 schema 拦截） */
const ENV_MAP: ReadonlyArray<readonly [string, keyof Config, (v: string) => unknown]> = [
  ['AFK_MODEL', 'model', (v) => v],
  ['AFK_THINKING', 'thinking', (v) => v],
  ['AFK_MAX_PARALLEL', 'maxParallel', Number],
  ['AFK_TODO_LABEL', 'todoLabel', (v) => v],
  ['AFK_DONE_LABEL', 'doneLabel', (v) => v],
  ['AFK_FAILED_LABEL', 'failedLabel', (v) => v],
  ['AFK_BRANCH_PREFIX', 'branchPrefix', (v) => v],
  ['AFK_BASE_BRANCH', 'baseBranch', (v) => v],
  ['AFK_WORKTREES_DIR', 'worktreesDir', (v) => v],
  ['AFK_FAILED_DIR', 'failedDir', (v) => v],
  ['AFK_LOGS_DIR', 'logsDir', (v) => v],
  ['AFK_SESSIONS_DIR', 'sessionsDir', (v) => v],
  ['AFK_INSTALL_CMD', 'installCmd', (v) => v],
  ['AFK_IDLE_TIMEOUT_SEC', 'idleTimeoutSec', Number],
  ['AFK_COMPLETION_TIMEOUT_SEC', 'completionTimeoutSec', Number],
  ['AFK_AUTO_MERGE', 'autoMerge', parseBool],
  ['AFK_MERGED_LABEL', 'mergedLabel', (v) => v],
  ['AFK_REVIEWER_MODEL', 'reviewerModel', (v) => v],
  ['AFK_MAX_REVIEW_ROUNDS', 'maxReviewRounds', Number],
  ['AFK_CONFLICT_TRIES', 'conflictTries', Number],
  ['AFK_WAIT_FOR_CHECKS', 'waitForChecks', parseBool],
  ['AFK_MERGE_TIMEOUT_SEC', 'mergeTimeoutSec', Number],
]

/** 布尔 env 解析：'true'/'false' 转布尔，坏值原样透传交给 schema 拦截 */
function parseBool(v: string): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  return v
}

/** 配置 schema：.strict() 拒绝未知键；缺省键回落默认值；可选键不要求 */
const schema = z
  .object({
    model: z.string().default(DEFAULT_CONFIG.model),
    thinking: z.enum(THINKING_LEVELS).default(DEFAULT_CONFIG.thinking),
    maxParallel: z.number().int().min(1).default(DEFAULT_CONFIG.maxParallel),
    todoLabel: z.string().default(DEFAULT_CONFIG.todoLabel),
    doneLabel: z.string().default(DEFAULT_CONFIG.doneLabel),
    failedLabel: z.string().default(DEFAULT_CONFIG.failedLabel),
    branchPrefix: z.string().default(DEFAULT_CONFIG.branchPrefix),
    baseBranch: z.string().default(DEFAULT_CONFIG.baseBranch),
    worktreesDir: z.string().default(DEFAULT_CONFIG.worktreesDir),
    failedDir: z.string().default(DEFAULT_CONFIG.failedDir),
    logsDir: z.string().default(DEFAULT_CONFIG.logsDir),
    sessionsDir: z.string().default(DEFAULT_CONFIG.sessionsDir),
    installCmd: z.string().optional(),
    idleTimeoutSec: z.number().int().min(1).default(DEFAULT_CONFIG.idleTimeoutSec),
    completionTimeoutSec: z.number().int().min(1).default(DEFAULT_CONFIG.completionTimeoutSec),
    gitAuthor: z.string().optional(),
    gitEmail: z.string().optional(),
    autoMerge: z.boolean().default(DEFAULT_CONFIG.autoMerge),
    mergedLabel: z.string().default(DEFAULT_CONFIG.mergedLabel),
    reviewerModel: z.string().optional(),
    maxReviewRounds: z.number().int().min(1).default(DEFAULT_CONFIG.maxReviewRounds),
    conflictTries: z.number().int().min(1).default(DEFAULT_CONFIG.conflictTries),
    waitForChecks: z.boolean().default(DEFAULT_CONFIG.waitForChecks),
    mergeTimeoutSec: z.number().int().min(1).default(DEFAULT_CONFIG.mergeTimeoutSec),
  })
  .strict()

/** 收集 AFK_* 环境变量覆盖（空串/空白视为未设置） */
function envOverrides(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [envKey, key, parse] of ENV_MAP) {
    const raw = process.env[envKey]
    if (raw === undefined || raw.trim() === '') continue
    out[key] = parse(raw)
  }
  return out
}

/**
 * 加载项目配置：读 <cwd>/.pi/afk/config.json（必须存在，缺省键回落内置默认值），
 * 环境变量 AFK_* 作为覆盖层（env > config.json > 内置默认）。
 * 缺失 / 坏 JSON / 校验失败均抛干净 Error（含 afk init 提示）。
 */
export function loadConfig(cwd: string = process.cwd()): Config {
  const file = join(cwd, CONFIG_FILE)
  if (!existsSync(file)) {
    throw new Error(`未找到配置 ${file}（当前目录未初始化）\n请在项目根目录执行: afk init`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(
      `配置解析失败 ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`配置格式错误 ${file}: 顶层必须是 JSON 对象（{} 也合法，缺省键回落默认值）`)
  }
  try {
    return schema.parse({ ...raw, ...envOverrides() })
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')
      throw new Error(`配置校验失败 ${file}: ${details}`)
    }
    throw error
  }
}
