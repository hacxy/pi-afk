import { execFileSync } from 'node:child_process'

import { loadGlobalConfig, type GlobalConfig } from './config.js'
import { projectPromptPath, resolvePromptFile } from './prompts.js'

/**
 * 诊断事实（afk doctor 收集后交给 doctorReport 渲染）。
 * 全部为只读信息：配置 / 模板路径 / 镜像状态 / gh 状态。
 */
export interface DoctorFacts {
  /** 生效的全局配置（4 字段） */
  config: GlobalConfig
  /** 实际生效的模板绝对路径 */
  templatePath: string
  /** 模板来源层：项目 .sandcastle/prompt.md 或包内默认 */
  templateSource: 'project' | 'bundled'
  /** 沙箱镜像是否存在 */
  imageExists: boolean
  /** gh 是否已登录 */
  ghLoggedIn: boolean
}

/** 沙箱镜像是否存在（只读检查，不触发构建） */
export function dockerImageExists(image: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** gh 是否已登录（只读检查） */
export function ghLoggedIn(): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * 收集诊断事实（纯只读：配置/模板/镜像/gh，无任何写操作——doctor 无副作用）。
 */
export function collectDoctorFacts(projectDir: string): DoctorFacts {
  const config = loadGlobalConfig()
  const templatePath = resolvePromptFile(projectDir)
  return {
    config,
    templatePath,
    templateSource: templatePath === projectPromptPath(projectDir) ? 'project' : 'bundled',
    imageExists: dockerImageExists(config.image),
    ghLoggedIn: ghLoggedIn(),
  }
}

/** 渲染 doctor 报告（纯函数） */
export function doctorReport(facts: DoctorFacts): string {
  const { config, templatePath, templateSource, imageExists, ghLoggedIn } = facts
  const sourceLabel = templateSource === 'project' ? '（项目自定义）' : '（包内默认）'
  return [
    '=== afk doctor ===',
    '',
    '配置（生效合并值）:',
    `  image:     ${config.image}`,
    `  model:     ${config.model}`,
    `  labels:    ${config.labels.length > 0 ? config.labels.join(', ') : '（无——不过滤）'}`,
    `  autoMerge: ${config.autoMerge ? 'on' : 'off'}`,
    '',
    `模板: ${templatePath} ${sourceLabel}`,
    '',
    '检查项:',
    `  ${imageExists ? '✓' : '✗'} 沙箱镜像: ${
      imageExists ? '存在' : `不存在（${config.image}，首次运行 afk <N> 会自动构建）`
    }`,
    `  ${ghLoggedIn ? '✓' : '✗'} gh 登录: ${
      ghLoggedIn ? '已登录' : '未登录（issue 拉取/PR 推送需要 gh auth login）'
    }`,
  ].join('\n')
}

/** afk <N> 启动时打印的使用中模板行 */
export function startupTemplateLine(projectDir: string): string {
  return `→ 使用模板: ${resolvePromptFile(projectDir)}`
}
