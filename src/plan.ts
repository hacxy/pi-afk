import { z } from 'zod'

/**
 * planner 输出的结构化计划（阶段间契约）。
 * 结构化 JSON + zod 校验：planner 容器输出 → 宿主解析校验 → 注入 implementer prompt。
 */
export const planSchema = z.object({
  number: z.number(),
  title: z.string(),
  branch: z.string(),
  summary: z.string(),
  files: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  steps: z.array(z.string()),
})

export type Plan = z.infer<typeof planSchema>

/** 从 pi -p 的 stdout 提取 JSON 并校验。容错 markdown 代码块 / 前后杂音。 */
export function parsePlan(text: string): Plan {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('planner 输出中未找到 JSON')
  }
  const json = candidate.slice(start, end + 1)
  return planSchema.parse(JSON.parse(json))
}
