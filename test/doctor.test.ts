import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { DEFAULT_GLOBAL_CONFIG } from '../src/config'
import { doctorReport, startupTemplateLine, type DoctorFacts } from '../src/doctor'
import { promptFilePath } from '../src/prompts'

const makeFacts = (overrides: Partial<DoctorFacts> = {}): DoctorFacts => ({
  config: { ...DEFAULT_GLOBAL_CONFIG },
  templatePath: promptFilePath(),
  templateSource: 'bundled',
  imageExists: true,
  ghLoggedIn: true,
  ...overrides,
})

describe('doctorReport', () => {
  it('输出包含生效的 4 个配置字段及值', () => {
    const report = doctorReport(
      makeFacts({
        config: {
          image: 'pi-afk:test',
          model: 'custom/model',
          label: 'custom-label',
          autoMerge: true,
        },
      }),
    )
    expect(report).toContain('image:')
    expect(report).toContain('pi-afk:test')
    expect(report).toContain('model:')
    expect(report).toContain('custom/model')
    expect(report).toContain('label:')
    expect(report).toContain('custom-label')
    expect(report).toContain('autoMerge: on')
  })

  it('输出包含模板绝对路径与来源层', () => {
    const projectPath = join('/proj', '.sandcastle', 'prompt.md')
    const projectReport = doctorReport(
      makeFacts({ templatePath: projectPath, templateSource: 'project' }),
    )
    expect(projectReport).toContain(projectPath)
    expect(projectReport).toContain('项目自定义')

    const bundledReport = doctorReport(makeFacts())
    expect(bundledReport).toContain(promptFilePath())
    expect(bundledReport).toContain('包内默认')
  })

  it('镜像存在/不存在时分别显示对应状态', () => {
    expect(doctorReport(makeFacts({ imageExists: true }))).toContain('✓')
    expect(doctorReport(makeFacts({ imageExists: true }))).toContain('存在')

    const missing = doctorReport(makeFacts({ imageExists: false }))
    expect(missing).toContain('✗')
    expect(missing).toContain('不存在')
    expect(missing).toContain('首次运行')
  })

  it('gh 登录/未登录时分别显示对应状态', () => {
    expect(doctorReport(makeFacts({ ghLoggedIn: true }))).toContain('已登录')

    const loggedOut = doctorReport(makeFacts({ ghLoggedIn: false }))
    expect(loggedOut).toContain('未登录')
    expect(loggedOut).toContain('gh auth login')
  })

  it('干净环境（默认配置 + 包内模板 + 无镜像 + 未登录）也能正常输出默认值', () => {
    const report = doctorReport(makeFacts({ imageExists: false, ghLoggedIn: false }))
    expect(report).toContain(DEFAULT_GLOBAL_CONFIG.image)
    expect(report).toContain(DEFAULT_GLOBAL_CONFIG.model)
    expect(report).toContain(DEFAULT_GLOBAL_CONFIG.label)
    expect(report).toContain(promptFilePath())
    expect(report).toContain('不存在')
    expect(report).toContain('未登录')
  })
})

describe('startupTemplateLine', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-doctor-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('项目无 .sandcastle/prompt.md 时指向包内默认模板', () => {
    expect(startupTemplateLine(dir)).toBe(`→ 使用模板: ${promptFilePath()}`)
  })

  it('项目存在 .sandcastle/prompt.md 时指向项目模板', () => {
    const projectPrompt = join(dir, '.sandcastle', 'prompt.md')
    mkdirSync(join(dir, '.sandcastle'), { recursive: true })
    writeFileSync(projectPrompt, '# 自定义\n')
    expect(startupTemplateLine(dir)).toBe(`→ 使用模板: ${projectPrompt}`)
  })
})
