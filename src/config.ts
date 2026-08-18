import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z, ZodError } from 'zod'

/** 配置文件名（相对项目根 cwd） */
export const CONFIG_FILE = '.pi/afk/config.json'

/** 合法 thinking 等级（pi --thinking 取值） */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * 默认沙箱 env 白名单：透传进容器的宿主环境变量（按名精确匹配，`*` 后缀通配）。
 * 只放行运行 pi 所需：模型 API key（显式列举，不让无关 secret 借通配进容器）、
 * 网络代理、pi 自身设置、git 提交身份注入、CI。GH_TOKEN 等 GitHub 凭据明确不在列
 * （gh 在宿主侧跑，容器内不需要）。
 */
export const DEFAULT_SANDBOX_ENV: readonly string[] = [
  // 模型 API key
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  'TOGETHER_API_KEY',
  // 网络代理
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  // pi 自身设置
  'PI_*',
  // git 提交身份（宿主解析后注入，容器内 commit 用）
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  // 非交互安装
  'CI',
]

/** 内置默认值（init 模板与 loadConfig 共用；不含可选键/可选 identity） */
export const DEFAULT_CONFIG: Omit<
  Config,
  'gitAuthor' | 'gitEmail' | 'installCmd' | 'reviewerModel' | 'sandboxMemory' | 'sandboxCpus'
> = {
  model: 'deepseek/deepseek-v4-flash',
  sandbox: true,
  sandboxEnv: [...DEFAULT_SANDBOX_ENV],
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
  /** 默认沙箱 docker 容器运行；false = 宿主本地运行（--local） */
  sandbox: boolean
  /** 沙箱 env 白名单：透传进容器的宿主环境变量（可含 `*` 后缀通配） */
  sandboxEnv: string[]
  /** 容器内存上限（docker --memory，如 '4g'），缺省不限 */
  sandboxMemory?: string
  /** 容器 CPU 上限（docker --cpus），缺省不限 */
  sandboxCpus?: number
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
    sandbox: z.boolean().default(DEFAULT_CONFIG.sandbox),
    sandboxEnv: z.array(z.string()).default([...DEFAULT_CONFIG.sandboxEnv]),
    sandboxMemory: z.string().min(1).optional(),
    sandboxCpus: z.number().int().min(1).optional(),
    maxReviewRounds: z.number().int().min(1).default(DEFAULT_CONFIG.maxReviewRounds),
    conflictTries: z.number().int().min(1).default(DEFAULT_CONFIG.conflictTries),
    waitForChecks: z.boolean().default(DEFAULT_CONFIG.waitForChecks),
    mergeTimeoutSec: z.number().int().min(1).default(DEFAULT_CONFIG.mergeTimeoutSec),
  })
  .strict()

/**
 * 加载项目配置：读 <cwd>/.pi/afk/config.json（必须存在，缺省键回落内置默认值）。
 * 配置只读 config.json；环境变量仅用于秘密（模型 API key / GH_TOKEN），不进配置。
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
    return schema.parse(raw)
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
