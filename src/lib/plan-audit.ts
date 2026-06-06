import { readFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useActivityStore } from "@/stores/activity-store"
import { normalizePath, getRelativePath } from "@/lib/path-utils"
import { parseTradeMarkdown, computeDashboardStats, type TradeDayStats } from "@/lib/trade-stats"

export interface PlanAuditResult {
  planDate: string
  executionDate: string
  status: "matched" | "partial" | "violation" | "no-trade" | "no-plan"
  title: string
  detail: string
  planText: string
  tradeSummary: string
}

// ── helpers ───────────────────────────────────────────────────────────────────

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractPlanSection(content: string): string {
  // Match "## 五、明日计划" with optional "（可选）"
  const regex = /##\s*五、明日计划(?:（可选）)?\s*\n([\s\S]*?)(?=\n##\s|$)/
  const match = content.match(regex)
  if (!match) return ""
  return match[1].trim()
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().split("T")[0]
}

function findNextTradeDate(planDate: string, tradeDates: string[]): string | null {
  // Find the first trade date strictly after planDate (up to 7 days later)
  for (let i = 1; i <= 7; i++) {
    const candidate = addDays(planDate, i)
    if (tradeDates.includes(candidate)) return candidate
  }
  return null
}

const AUDIT_BLOCK_REGEX =
  /---AUDIT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END AUDIT---/g

// ── main audit function ───────────────────────────────────────────────────────

export async function runPlanAudit(
  projectPath: string,
  llmConfig: LlmConfig,
  dayRange: number = 30
): Promise<PlanAuditResult[]> {
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: "交易计划审计",
    status: "running",
    detail: "读取日复盘与交割单...",
    filesWritten: [],
  })

  // 1. Read daily reviews
  const reviewRoot = `${pp}/raw/日复盘`
  const reviewFiles: FileNode[] = []
  try {
    const tree = await listDirectory(reviewRoot)
    reviewFiles.push(
      ...flattenMdFiles(tree).filter((f) => f.name.endsWith("-复盘.md"))
    )
  } catch {
    // no reviews
  }

  const reviews: { date: string; content: string; planText: string }[] = []
  for (const f of reviewFiles) {
    const dateMatch = f.name.match(/(\d{4}-\d{2}-\d{2})-复盘\.md/)
    if (!dateMatch) continue
    try {
      const content = await readFile(f.path)
      const planText = extractPlanSection(content)
      // Only include files that have a plan section with some content
      if (planText) {
        reviews.push({ date: dateMatch[1], content, planText })
      }
    } catch {
      // skip unreadable
    }
  }

  // Sort and filter by dayRange
  reviews.sort((a, b) => b.date.localeCompare(a.date))
  const cutoffDate = addDays(new Date().toISOString().split("T")[0], -dayRange)
  const filteredReviews = reviews.filter((r) => r.date >= cutoffDate)

  // 2. Read trade records
  const tradeRoot = `${pp}/raw/交割单`
  const tradeFiles: FileNode[] = []
  try {
    const tree = await listDirectory(tradeRoot)
    tradeFiles.push(
      ...flattenMdFiles(tree).filter((f) => f.name.endsWith("-交割单.md"))
    )
  } catch {
    // no trades
  }

  const tradesMap = new Map<string, TradeDayStats>()
  const tradeDates: string[] = []
  for (const f of tradeFiles) {
    const dateMatch = f.name.match(/(\d{4}-\d{2}-\d{2})-交割单\.md/)
    if (!dateMatch) continue
    try {
      const content = await readFile(f.path)
      const stats = parseTradeMarkdown(dateMatch[1], content)
      tradesMap.set(dateMatch[1], stats)
      tradeDates.push(dateMatch[1])
    } catch {
      // skip unreadable
    }
  }

  tradeDates.sort()

  if (filteredReviews.length === 0 && tradesMap.size === 0) {
    activity.updateItem(activityId, {
      status: "done",
      detail: "未找到日复盘或交割单数据。",
    })
    return []
  }

  // 3. Build plan-execution pairs
  const pairs: { planDate: string; executionDate: string; planText: string; trades: TradeDayStats | null }[] = []

  // From reviews: find next trade date for each plan
  for (const review of filteredReviews) {
    const execDate = findNextTradeDate(review.date, tradeDates)
    if (execDate) {
      pairs.push({
        planDate: review.date,
        executionDate: execDate,
        planText: review.planText,
        trades: tradesMap.get(execDate) ?? null,
      })
    } else {
      // No following trade date within 7 days
      pairs.push({
        planDate: review.date,
        executionDate: addDays(review.date, 1),
        planText: review.planText,
        trades: null,
      })
    }
  }

  // Also capture "no-plan" cases: trade days that don't have a preceding plan
  const coveredExecutionDates = new Set(pairs.map((p) => p.executionDate))
  for (const execDate of tradeDates) {
    if (coveredExecutionDates.has(execDate)) continue
    // Check if there's a review within the last 7 days
    let hasPlan = false
    for (const r of filteredReviews) {
      const diff = new Date(execDate).getTime() - new Date(r.date).getTime()
      const dayDiff = diff / (1000 * 60 * 60 * 24)
      if (dayDiff > 0 && dayDiff <= 7) {
        hasPlan = true
        break
      }
    }
    if (!hasPlan) {
      pairs.push({
        planDate: "—",
        executionDate: execDate,
        planText: "",
        trades: tradesMap.get(execDate) ?? null,
      })
    }
  }

  // Sort by executionDate desc
  pairs.sort((a, b) => b.executionDate.localeCompare(a.executionDate))

  if (pairs.length === 0) {
    activity.updateItem(activityId, {
      status: "done",
      detail: "没有足够的计划-交易配对数据。",
    })
    return []
  }

  activity.updateItem(activityId, { detail: "AI 正在对比计划与实际执行..." })

  // 4. 统一计算所有交割单的 FIFO 盈亏（回填 netPnL）
  const tradesWithData = pairs.map((p) => p.trades).filter(Boolean) as import("@/lib/trade-stats").TradeDayStats[]
  if (tradesWithData.length > 0) {
    computeDashboardStats(tradesWithData)
  }

  // 5. Build LLM prompt
  const pairBlocks = pairs.map((p) => {
    const tradeBlock = p.trades
      ? `### 实际交割单 (${p.executionDate})
成交笔数：${p.trades.tradeCount}
买入金额：${p.trades.buyAmount.toFixed(2)}
卖出金额：${p.trades.sellAmount.toFixed(2)}
净盈亏：${p.trades.netPnL.toFixed(2)}
明细：
${p.trades.records
  .map(
    (r) =>
      `- ${r.time || "—"} | ${r.code} ${r.name} | ${r.direction === "buy" ? "买入" : "卖出"} ${r.quantity} 股 @ ${r.price.toFixed(2)}`
  )
  .join("\n")}`
      : `### 实际交割单 (${p.executionDate})\n无交易记录`

    return `--- 配对 ---
计划日期：${p.planDate}
执行日期：${p.executionDate}
### 明日计划
${p.planText || "（无计划）"}
${tradeBlock}
`
  })

  const prompt = [
    "你是一位专业的交易纪律审计员。请阅读以下每一组「明日计划」与「次日实际交割单」，逐日分析交易执行是否符合计划。",
    "",
    "## 分析要求",
    "1. 检查计划中的股票/操作是否在实际交易中出现",
    "2. 识别「计划外交易」：没有计划但发生了的交易",
    "3. 识别「遗漏执行」：有计划但实际未执行",
    "4. 检查是否有违反计划中明确禁止的操作（如追高、加仓、持仓过夜等）",
    "5. 给出具体股票代码和简要原因",
    "",
    "## 输出格式",
    "对于每一个配对，必须严格按照以下格式输出：",
    "",
    "---AUDIT: status | executionDate | 一句话总结---",
    "详细分析：...",
    "PLAN_DATE: YYYY-MM-DD",
    "---END AUDIT---",
    "",
    "status 只能是以下五种之一：",
    "- matched: 完全按计划执行",
    "- partial: 部分执行，有遗漏或有额外操作",
    "- violation: 严重偏离计划（如计划卖出却买入、计划观望却追高）",
    "- no-trade: 有计划但次日无交易",
    "- no-plan: 无计划但有交易（即兴操作）",
    "",
    "注意：",
    "- 只基于提供的资料分析，不要编造",
    "- 尽量引用具体日期和股票代码",
    "- 使用中文输出",
    "",
    "## 资料",
    "",
    ...pairBlocks,
  ].join("\n")

  let raw = ""
  let hadError = false

  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => {
        raw += token
      },
      onDone: () => {},
      onError: (err) => {
        hadError = true
        activity.updateItem(activityId, {
          status: "error",
          detail: `LLM error: ${err.message}`,
        })
      },
    }
  )

  if (hadError) return []

  // 5. Parse results
  const results: PlanAuditResult[] = []
  const matches = raw.matchAll(AUDIT_BLOCK_REGEX)

  for (const match of matches) {
    const rawStatus = match[1].trim().toLowerCase()
    const executionDate = match[2].trim()
    const title = match[3].trim()
    const body = match[4].trim()

    const planDateMatch = body.match(/^PLAN_DATE:\s*(.+)$/m)
    const planDate = planDateMatch?.[1].trim() ?? "—"
    const detail = body.replace(/^PLAN_DATE:.*$/m, "").trim()

    const status = (
      ["matched", "partial", "violation", "no-trade", "no-plan"].includes(rawStatus)
        ? rawStatus
        : "partial"
    ) as PlanAuditResult["status"]

    // Find original pair to preserve planText and tradeSummary
    const pair = pairs.find(
      (p) => p.executionDate === executionDate && (planDate === "—" || p.planDate === planDate)
    )

    results.push({
      planDate: pair?.planDate ?? planDate,
      executionDate,
      status,
      title,
      detail,
      planText: pair?.planText ?? "",
      tradeSummary:
        pair?.trades
          ? pair.trades.records
              .map(
                (r) =>
                  `${r.code} ${r.name} ${r.direction === "buy" ? "买入" : "卖出"} ${r.quantity}@${r.price.toFixed(2)}`
              )
              .join("； ")
          : "无交易",
    })
  }

  // If LLM didn't return results for some pairs, add fallback entries
  const resultKeys = new Set(results.map((r) => `${r.planDate}|${r.executionDate}`))
  for (const p of pairs) {
    const key = `${p.planDate}|${p.executionDate}`
    if (resultKeys.has(key)) continue
    results.push({
      planDate: p.planDate,
      executionDate: p.executionDate,
      status: p.planText && !p.trades ? "no-trade" : !p.planText && p.trades ? "no-plan" : "partial",
      title: "AI 未返回分析",
      detail: "请检查 LLM 输出或手动核对此日计划与交割单。",
      planText: p.planText,
      tradeSummary:
        p.trades
          ? p.trades.records
              .map(
                (r) =>
                  `${r.code} ${r.name} ${r.direction === "buy" ? "买入" : "卖出"} ${r.quantity}@${r.price.toFixed(2)}`
              )
              .join("； ")
          : "无交易",
    })
  }

  // Sort by executionDate desc
  results.sort((a, b) => b.executionDate.localeCompare(a.executionDate))

  activity.updateItem(activityId, {
    status: "done",
    detail: `完成 ${results.length} 天的计划审计。`,
  })

  return results
}
