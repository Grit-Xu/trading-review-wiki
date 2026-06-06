import { readFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import { useActivityStore } from "@/stores/activity-store"
import { getFileName, getRelativePath, normalizePath } from "@/lib/path-utils"

export interface LintResult {
  type: "orphan" | "broken-link" | "no-outlinks" | "semantic" | "strategy"
  severity: "warning" | "info"
  page: string
  detail: string
  affectedPages?: string[]
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

function extractWikilinks(content: string): string[] {
  const links: string[] = []
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

function relativeToSlug(relativePath: string): string {
  // relativePath relative to wiki/ dir, e.g. "entities/foo-bar" or "queries/my-page-2024-01-01"
  return relativePath.replace(/\.md$/, "")
}

/** Build a slug → absolute path map from wiki files */
function buildSlugMap(
  wikiFiles: FileNode[],
  wikiRoot: string,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const f of wikiFiles) {
    // e.g. /path/to/project/wiki/entities/foo.md → entities/foo
    const rel = getRelativePath(f.path, wikiRoot).replace(/\.md$/, "")
    map.set(rel, f.path)
    // also index by basename without extension
    map.set(f.name.replace(/\.md$/, ""), f.path)
  }
  return map
}

// ── Structural lint ───────────────────────────────────────────────────────────

export async function runStructuralLint(projectPath: string): Promise<LintResult[]> {
  const wikiRoot = `${normalizePath(projectPath)}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const wikiFiles = flattenMdFiles(tree)
  // Exclude index.md and log.md from orphan checks
  const contentFiles = wikiFiles.filter(
    (f) => f.name !== "index.md" && f.name !== "log.md"
  )

  const slugMap = buildSlugMap(contentFiles, wikiRoot)

  // Read all content files
  type PageData = { path: string; slug: string; content: string; outlinks: string[] }
  const pages: PageData[] = []

  for (const f of contentFiles) {
    try {
      const content = await readFile(f.path)
      const slug = relativeToSlug(getRelativePath(f.path, wikiRoot))
      const outlinks = extractWikilinks(content)
      pages.push({ path: f.path, slug, content, outlinks })
    } catch {
      // skip unreadable files
    }
  }

  // Build inbound link count
  const inboundCounts = new Map<string, number>()
  for (const p of pages) {
    for (const link of p.outlinks) {
      const target = slugMap.has(link)
        ? relativeToSlug(getRelativePath(slugMap.get(link)!, wikiRoot))
        : link
      inboundCounts.set(target, (inboundCounts.get(target) ?? 0) + 1)
    }
  }

  const results: LintResult[] = []

  for (const p of pages) {
    const shortName = getRelativePath(p.path, wikiRoot)

    // Orphan: no inbound links
    const inbound = inboundCounts.get(p.slug) ?? 0
    if (inbound === 0) {
      results.push({
        type: "orphan",
        severity: "info",
        page: shortName,
        detail: "No other pages link to this page.",
      })
    }

    // No outbound links
    if (p.outlinks.length === 0) {
      results.push({
        type: "no-outlinks",
        severity: "info",
        page: shortName,
        detail: "This page has no [[wikilink]] references to other pages.",
      })
    }

    // Broken links
    for (const link of p.outlinks) {
      const exists = slugMap.has(link) || slugMap.has(getFileName(link).replace(/\.md$/, ""))
      if (!exists) {
        results.push({
          type: "broken-link",
          severity: "warning",
          page: shortName,
          detail: `Broken link: [[${link}]] — target page not found.`,
        })
      }
    }
  }

  return results
}

// ── Semantic lint ─────────────────────────────────────────────────────────────

const LINT_BLOCK_REGEX =
  /---LINT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINT---/g

export async function runSemanticLint(
  projectPath: string,
  llmConfig: LlmConfig,
): Promise<LintResult[]> {
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: "Semantic wiki lint",
    status: "running",
    detail: "Reading wiki pages...",
    filesWritten: [],
  })

  const wikiRoot = `${pp}/wiki`
  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    activity.updateItem(activityId, { status: "error", detail: "Failed to read wiki directory." })
    return []
  }

  const wikiFiles = flattenMdFiles(tree).filter(
    (f) => f.name !== "log.md"
  )

  // Build a compact summary of each page (frontmatter + first 500 chars)
  const summaries: string[] = []
  for (const f of wikiFiles) {
    try {
      const content = await readFile(f.path)
      const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "")
      const shortPath = getRelativePath(f.path, wikiRoot)
      summaries.push(`### ${shortPath}\n${preview}`)
    } catch {
      // skip
    }
  }

  if (summaries.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "No wiki pages to lint." })
    return []
  }

  activity.updateItem(activityId, { detail: "Running LLM semantic analysis..." })

  const prompt = [
    "You are a wiki quality analyst. Review the following wiki page summaries and identify issues.",
    "",
    "## Language Rule",
    "- Match the language of the wiki content. If pages are in Chinese, write issues in Chinese. If in English, use English.",
    "",
    "For each issue, output exactly this format:",
    "",
    "---LINT: type | severity | Short title---",
    "Description of the issue.",
    "PAGES: page1.md, page2.md",
    "---END LINT---",
    "",
    "Types:",
    "- contradiction: two or more pages make conflicting claims",
    "- stale: information that appears outdated or superseded",
    "- missing-page: an important concept is heavily referenced but has no dedicated page",
    "- suggestion: a question or source worth adding to the wiki",
    "",
    "Severities:",
    "- warning: should be addressed",
    "- info: nice to have",
    "",
    "Only report genuine issues. Do not invent problems. Output ONLY the ---LINT--- blocks, no other text.",
    "",
    "## Wiki Pages",
    "",
    summaries.join("\n\n"),
  ].join("\n")

  let raw = ""
  let hadError = false

  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: (err) => {
        hadError = true
        activity.updateItem(activityId, {
          status: "error",
          detail: `LLM error: ${err.message}`,
        })
      },
    },
  )

  if (hadError) return []

  const results: LintResult[] = []
  const matches = raw.matchAll(LINT_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const severity = match[2].trim().toLowerCase()
    const title = match[3].trim()
    const body = match[4].trim()

    // semantic results always use type "semantic"
    void rawType

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    const detail = body.replace(/^PAGES:.*$/m, "").trim()

    results.push({
      type: "semantic",
      severity: (severity === "warning" ? "warning" : "info") as LintResult["severity"],
      page: title,
      detail: `[${rawType}] ${detail}`,
      affectedPages,
    })
  }

  activity.updateItem(activityId, {
    status: "done",
    detail: `Found ${results.length} semantic issue(s).`,
  })

  return results
}

// ── Strategy compliance lint ──────────────────────────────────────────────────

export async function runStrategyComplianceLint(
  projectPath: string,
  llmConfig: LlmConfig,
): Promise<LintResult[]> {
  const pp = normalizePath(projectPath)
  const activity = useActivityStore.getState()
  const activityId = activity.addItem({
    type: "lint",
    title: "策略一致性检查",
    status: "running",
    detail: "读取策略与交易记录...",
    filesWritten: [],
  })

  // 1. Read strategies
  const strategyRoot = `${pp}/wiki/策略`
  let strategyFiles: FileNode[] = []
  try {
    const tree = await listDirectory(strategyRoot)
    strategyFiles = flattenMdFiles(tree).filter((f) => f.name.endsWith(".md"))
  } catch {
    // no strategies
  }

  const strategies: string[] = []
  for (const f of strategyFiles) {
    try {
      const content = await readFile(f.path)
      strategies.push(`# ${f.name.replace(/\.md$/, "")}\n${content.slice(0, 1200)}`)
    } catch {
      // skip
    }
  }

  if (strategies.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "未找到策略文件，请在 wiki/策略/ 目录下创建策略。" })
    return []
  }

  // 2. Read recent daily reviews and trade records
  const reviewRoot = `${pp}/raw/日复盘`
  const tradeRoot = `${pp}/raw/交割单`

  const reviews: { date: string; content: string }[] = []
  try {
    const tree = await listDirectory(reviewRoot)
    const files = flattenMdFiles(tree)
      .filter((f) => f.name.endsWith("-复盘.md"))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 30) // 最近30天
    for (const f of files) {
      try {
        const content = await readFile(f.path)
        const dateMatch = f.name.match(/(\d{4}-\d{2}-\d{2})-复盘\.md/)
        reviews.push({ date: dateMatch?.[1] ?? f.name, content: content.slice(0, 1500) })
      } catch {
        // skip
      }
    }
  } catch {
    // no reviews
  }

  const trades: { date: string; content: string }[] = []
  try {
    const tree = await listDirectory(tradeRoot)
    const files = flattenMdFiles(tree)
      .filter((f) => f.name.endsWith("-交割单.md"))
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 30)
    for (const f of files) {
      try {
        const content = await readFile(f.path)
        const dateMatch = f.name.match(/(\d{4}-\d{2}-\d{2})-交割单\.md/)
        trades.push({ date: dateMatch?.[1] ?? f.name, content: content.slice(0, 1200) })
      } catch {
        // skip
      }
    }
  } catch {
    // no trades
  }

  if (reviews.length === 0 && trades.length === 0) {
    activity.updateItem(activityId, { status: "done", detail: "未找到交易记录，请先导入交割单或写日复盘。" })
    return []
  }

  activity.updateItem(activityId, { detail: "正在让 AI 分析策略一致性..." })

  const prompt = [
    "你是一位专业的交易纪律审计员。你的任务是：阅读用户的交易策略规则，再阅读他最近的交易记录和日复盘，找出「策略」与「实际行为」之间的不一致。",
    "",
    "## 输出格式要求",
    "对于每一个发现的问题或亮点，必须严格按照以下格式输出：",
    "",
    "---LINT: type | severity | 简短标题---",
    "详细描述：具体问题或亮点是什么，涉及哪一天、哪只股票。",
    "PAGES: 策略文件名.md, 日复盘/YYYY-MM-DD-复盘.md",
    "---END LINT---",
    "",
    "type 只能是以下两种：",
    "- violation: 违反了策略规则（如止损线被突破、追高、仓位超限、逆势加仓、未按计划执行等）",
    "- strength: 严格遵守了策略规则，值得保持",
    "",
    "severity 只能是：",
    "- warning: 严重违规，必须立即纠正",
    "- info: 轻微偏离或值得表扬的优点",
    "",
    "注意：",
    "- 只基于提供的策略和交易记录进行分析，不要编造",
    "- 如果策略文件中某条规则无法从交易记录中验证，不要输出",
    "- 尽量引用具体日期和股票代码/名称",
    "- 使用中文输出",
    "",
    "## 策略规则",
    "",
    strategies.join("\n\n---\n\n"),
    "",
    "## 最近交易记录",
    "",
    ...trades.map((t) => `### 交割单 ${t.date}\n${t.content}`),
    "",
    "## 最近日复盘",
    "",
    ...reviews.map((r) => `### 复盘 ${r.date}\n${r.content}`),
  ].join("\n")

  let raw = ""
  let hadError = false

  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { raw += token },
      onDone: () => {},
      onError: (err) => {
        hadError = true
        activity.updateItem(activityId, {
          status: "error",
          detail: `LLM error: ${err.message}`,
        })
      },
    },
  )

  if (hadError) return []

  const results: LintResult[] = []
  const matches = raw.matchAll(LINT_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const severity = match[2].trim().toLowerCase()
    const title = match[3].trim()
    const body = match[4].trim()

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    const detail = body.replace(/^PAGES:.*$/m, "").trim()

    results.push({
      type: "strategy",
      severity: (severity === "warning" ? "warning" : "info") as LintResult["severity"],
      page: title,
      detail: `[${rawType}] ${detail}`,
      affectedPages,
    })
  }

  activity.updateItem(activityId, {
    status: "done",
    detail: `发现 ${results.length} 条策略一致性结论。`,
  })

  return results
}
