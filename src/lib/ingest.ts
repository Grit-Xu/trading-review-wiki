import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { useChatStore } from "@/stores/chat-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { checkIngestCache, saveIngestCache } from "@/lib/ingest-cache"

const FILE_BLOCK_REGEX = /---FILE:\s*([^\n-]+?)\s*---\n([\s\S]*?)---END FILE---/g

export const LANGUAGE_RULE = "## Language Rule\n- ALWAYS match the language of the source document. If the source is in Chinese, write in Chinese. If in English, write in English. Wiki page titles, content, and descriptions should all be in the same language as the source material."

// ── Path Validation ──────────────────────────────────────────

/** English directory → Chinese canonical directory (for path redirection) */
const PATH_REDIRECT_MAP: Record<string, string> = {
  "entities": "股票",
  "entity": "股票",
  "concepts": "概念",
  "concept": "概念",
  "sources": "原始资料",
  "source": "原始资料",
  "queries": "问题",
  "query": "问题",
  "comparisons": "对比",
  "comparison": "对比",
  "synthesis": "综合",
  "stock": "股票",
  "stocks": "股票",
  "strategy": "策略",
  "strategies": "策略",
  "pattern": "模式",
  "patterns": "模式",
  "mistake": "错误",
  "mistakes": "错误",
  "market": "市场环境",
  "market-environment": "市场环境",
  "evolution": "进化",
  "prediction": "预测",
  "predictions": "预测",
}

/** Directories that are known to be temp/scaffold and must be rejected */
const TEMP_DIR_PATTERNS = [
  /更新核心页面/i,
  /临时/i,
  /temp/i,
  /tmp\b/i,
  /draft/i,
  /scaffold/i,
]

/** Maximum filename length (excluding extension) */
const MAX_FILENAME_LENGTH = 40

/**
 * Validate and sanitize a wiki file path produced by the LLM.
 * Returns null if the path should be rejected entirely.
 */
function sanitizeWikiPath(rawPath: string, frontmatterTitle?: string): string | null {
  // Normalize slashes
  let path = rawPath.replace(/\\/g, "/").trim()

  // Must start with wiki/
  if (!path.startsWith("wiki/")) return null

  // Split into parts
  const parts = path.split("/")
  if (parts.length < 2) return null

  // Check for temp dir patterns in any segment
  for (const part of parts) {
    for (const pattern of TEMP_DIR_PATTERNS) {
      if (pattern.test(part)) return null
    }
  }

  // Redirect English directory names to Chinese
  const dirName = parts[1]
  const canonicalDir = PATH_REDIRECT_MAP[dirName]
  if (canonicalDir) {
    parts[1] = canonicalDir
  }

  // Sanitize filename (last part)
  if (parts.length >= 3) {
    let fileName = parts[parts.length - 1]
    const ext = fileName.endsWith(".md") ? ".md" : ""
    const stem = fileName.replace(/\.md$/i, "")

    // If filename is obviously AI-generated text (too long, contains quotes, etc.),
    // try to use the frontmatter title instead
    const needsSanitize =
      stem.length > MAX_FILENAME_LENGTH ||
      /[""''《》「」【】]/.test(stem) ||
      /^[，。！？,\.!\?]/.test(stem) // starts with punctuation

    if (needsSanitize && frontmatterTitle) {
      // Use frontmatter title as filename, stripped of special chars
      let safeName = frontmatterTitle
        .replace(/[""''《》「」【】]/g, "")
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
      if (safeName.length > MAX_FILENAME_LENGTH) {
        safeName = safeName.slice(0, MAX_FILENAME_LENGTH)
      }
      if (safeName) {
        fileName = safeName + ext
      } else {
        // Fallback: just truncate the original
        fileName = stem.slice(0, MAX_FILENAME_LENGTH).replace(/[\\/:*?"<>|]/g, "-") + ext
      }
    } else if (stem.length > MAX_FILENAME_LENGTH) {
      // Truncate long filenames
      fileName = stem.slice(0, MAX_FILENAME_LENGTH) + ext
    }

    parts[parts.length - 1] = fileName
  }

  return parts.join("/")
}

/**
 * Extract the title from YAML frontmatter content.
 */
function extractFrontmatterTitle(content: string): string | null {
  const match = content.match(/^---\r?\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
  return match ? match[1].trim() : null
}

/**
 * Normalize tags in frontmatter to yaml multiline format.
 * Converts: tags: [x, y, z] → tags:\n  - x\n  - y\n  - z
 * Converts: tags: [] → tags: [] (kept empty)
 */
function normalizeTags(content: string): string {
  // Match tags in various formats:
  // tags: [a, b, c]
  // tags: ['a', 'b', 'c']
  // tags: ["a", "b", "c"]
  const inlineTagsRegex = /^(\s*tags:\s*)\[([^\]]*)\]\s*$/m
  const match = content.match(inlineTagsRegex)
  if (!match) return content

  const indent = match[1].replace(/tags:.*/, "") // preserve indentation
  const tagsContent = match[2].trim()

  if (!tagsContent) {
    // Empty tags — already fine as `tags: []`
    return content
  }

  // Parse comma-separated tags, stripping quotes
  const tags = tagsContent
    .split(",")
    .map((t) => t.trim().replace(/^['"]|['"]$/g, "").trim())
    .filter(Boolean)

  if (tags.length === 0) return content

  const yamlLines = tags.map((t) => `${indent}  - ${t}`)
  const replacement = `${indent}tags:\n${yamlLines.join("\n")}`

  return content.replace(inlineTagsRegex, replacement)
}

/**
 * Smart-merge new index entries into existing index.md.
 * - Each section heading (## xxx) is a group
 * - New entries under each group are merged in, deduplicating by wikilink target
 * - Existing entries are preserved
 */
function smartMergeIndex(existing: string, newContent: string): string {
  if (!existing) return newContent
  if (!newContent) return existing

  // Parse existing index into sections
  const sectionRegex = /^(##\s+.+)$/gm
  const existingSections = new Map<string, string[]>()
  let currentSection = "__head__"
  let currentLines: string[] = []

  for (const line of existing.split("\n")) {
    if (/^##\s+/.test(line)) {
      if (currentLines.length > 0) {
        existingSections.set(currentSection, currentLines)
      }
      currentSection = line.trim()
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }
  if (currentLines.length > 0) {
    existingSections.set(currentSection, currentLines)
  }

  // Parse new index into sections
  const newSections = new Map<string, string[]>()
  currentSection = "__head__"
  currentLines = []

  for (const line of newContent.split("\n")) {
    if (/^##\s+/.test(line)) {
      if (currentLines.length > 0) {
        newSections.set(currentSection, currentLines)
      }
      currentSection = line.trim()
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }
  if (currentLines.length > 0) {
    newSections.set(currentSection, currentLines)
  }

  // Extract wikilinks from a section's lines
  const extractLinks = (lines: string[]): Set<string> => {
    const links = new Set<string>()
    const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
    for (const line of lines) {
      let match
      while ((match = linkRegex.exec(line)) !== null) {
        links.add(match[1].trim().toLowerCase())
      }
    }
    return links
  }

  // Merge: for each section in new, append new entries to existing
  const allSections = new Set([...existingSections.keys(), ...newSections.keys()])

  // Build merged output
  const mergedLines: string[] = []

  for (const section of allSections) {
    if (section === "__head__") {
      // Head content (before any ## heading) — use new if available, else existing
      const headLines = newSections.get("__head__") ?? existingSections.get("__head__") ?? []
      mergedLines.push(...headLines.filter((l) => l.trim() !== ""))
      continue
    }

    mergedLines.push("")
    mergedLines.push(section)
    mergedLines.push("")

    const existingLines = existingSections.get(section) ?? []
    const newLines = newSections.get(section) ?? []

    // Get existing links
    const existingLinks = extractLinks(existingLines)

    // Add all existing entries
    for (const line of existingLines) {
      if (line.trim()) mergedLines.push(line)
    }

    // Add new entries that don't duplicate existing ones
    for (const line of newLines) {
      if (!line.trim()) continue
      const newLinks = extractLinks([line])
      const isDuplicate = [...newLinks].some((l) => existingLinks.has(l))
      if (!isDuplicate) {
        mergedLines.push(line)
      }
    }
  }

  return mergedLines.join("\n")
}

/**
 * Auto-ingest: reads source → LLM analyzes → LLM writes wiki pages, all in one go.
 * Used when importing new files.
 */
export async function autoIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const activity = useActivityStore.getState()
  const fileName = getFileName(sp)
  const activityId = activity.addItem({
    type: "ingest",
    title: fileName,
    status: "running",
    detail: "Reading source...",
    filesWritten: [],
  })

  const [sourceContent, schema, purpose, index, overview] = await Promise.all([
    tryReadFile(sp),
    tryReadFile(`${pp}/schema.md`),
    tryReadFile(`${pp}/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
    tryReadFile(`${pp}/wiki/overview.md`),
  ])

  // Detect wiki subdirectories so the generation prompt can route pages correctly
  // (e.g. trading projects use wiki/股票/ instead of wiki/entities/)
  let wikiDirs: string[] = []
  try {
    const wikiTree = await listDirectory(`${pp}/wiki`)
    wikiDirs = wikiTree
      .filter((n) => n.is_dir)
      .map((n) => `wiki/${n.name}/`)
  } catch {
    // ignore
  }

  // ── Cache check: skip re-ingest if source content hasn't changed ──
  const cachedFiles = await checkIngestCache(pp, fileName, sourceContent)
  if (cachedFiles !== null) {
    activity.updateItem(activityId, {
      status: "done",
      detail: `Skipped (unchanged) — ${cachedFiles.length} files from previous ingest`,
      filesWritten: cachedFiles,
    })
    return cachedFiles
  }

  const truncatedContent = sourceContent.length > 100000
    ? sourceContent.slice(0, 100000) + "\n\n[...truncated...]"
    : sourceContent

  // ── Step 1: Analysis ──────────────────────────────────────────
  // LLM reads the source and produces a structured analysis:
  // key entities, concepts, main arguments, connections to existing wiki, contradictions
  activity.updateItem(activityId, { detail: "Step 1/2: Analyzing source..." })

  let analysis = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildAnalysisPrompt(purpose, index) },
      { role: "user", content: `Analyze this source document:\n\n**File:** ${fileName}${folderContext ? `\n**Folder context:** ${folderContext}` : ""}\n\n---\n\n${truncatedContent}` },
    ],
    {
      onToken: (token) => { analysis += token },
      onDone: () => {},
      onError: (err) => {
        activity.updateItem(activityId, { status: "error", detail: `Analysis failed: ${err.message}` })
      },
    },
    signal,
  )

  if (useActivityStore.getState().items.find((i) => i.id === activityId)?.status === "error") {
    return []
  }

  // ── Step 2: Generation ────────────────────────────────────────
  // LLM takes its own analysis and generates wiki files + review items
  activity.updateItem(activityId, { detail: "Step 2/2: Generating wiki pages..." })

  let generation = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildGenerationPrompt(schema, purpose, index, fileName, overview, wikiDirs) },
      {
        role: "user",
        content: [
          `Based on the following analysis of **${fileName}**, generate the wiki files.`,
          "",
          "## Source Analysis",
          "",
          analysis,
          "",
          "## Original Source Content",
          "",
          truncatedContent,
        ].join("\n"),
      },
    ],
    {
      onToken: (token) => { generation += token },
      onDone: () => {},
      onError: (err) => {
        activity.updateItem(activityId, { status: "error", detail: `Generation failed: ${err.message}` })
      },
    },
    signal,
  )

  if (useActivityStore.getState().items.find((i) => i.id === activityId)?.status === "error") {
    return []
  }

  // ── Step 3: Write files ───────────────────────────────────────
  activity.updateItem(activityId, { detail: "Writing files..." })
  let writtenPaths: string[] = []
  try {
    writtenPaths = await writeFileBlocks(pp, generation)
  } catch (err) {
    console.error("Failed to write wiki files:", err)
    activity.updateItem(activityId, { status: "error", detail: `Write failed: ${err instanceof Error ? err.message : String(err)}` })
    return []
  }

  // Ensure source summary page exists (LLM may not have generated it correctly)
  const sourceBaseName = fileName.replace(/\.[^.]+$/, "")
  const sourceSummaryPath = `wiki/原始资料/${sourceBaseName}.md`
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`
  const hasSourceSummary = writtenPaths.some((p) => p.startsWith("wiki/原始资料/") || p.startsWith("wiki/sources/"))

  if (!hasSourceSummary) {
    const date = new Date().toISOString().slice(0, 10)
    const fallbackContent = [
      "---",
      `type: 原始资料`,
      `title: "Source: ${fileName}"`,
      `created: ${date}`,
      `updated: ${date}`,
      `sources: ["${fileName}"]`,
      `tags: []`,
      `related: []`,
      "---",
      "",
      `# Source: ${fileName}`,
      "",
      analysis || "(Analysis not available)",
      "",
    ].join("\n")
    try {
      await writeFile(sourceSummaryFullPath, fallbackContent)
      writtenPaths.push(sourceSummaryPath)
    } catch {
      // non-critical
    }
  }

  if (writtenPaths.length > 0) {
    try {
      const tree = await listDirectory(pp)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    } catch {
      // ignore
    }
  }

  // ── Step 4: Parse review items ────────────────────────────────
  const reviewItems = parseReviewBlocks(generation, sp)
  if (reviewItems.length > 0) {
    useReviewStore.getState().addItems(reviewItems)
  }

  // ── Step 5: Save to cache ───────────────────────────────────
  if (writtenPaths.length > 0) {
    await saveIngestCache(pp, fileName, sourceContent, writtenPaths)
  }

  // ── Step 6: Generate embeddings (if enabled) ───────────────
  const embCfg = useWikiStore.getState().embeddingConfig
  if (embCfg.enabled && embCfg.model && writtenPaths.length > 0) {
    try {
      const { embedPage } = await import("@/lib/embedding")
      for (const wpath of writtenPaths) {
        const pageId = wpath.split("/").pop()?.replace(/\.md$/, "") ?? ""
        if (!pageId || ["index", "log", "overview"].includes(pageId)) continue
        try {
          const content = await readFile(`${pp}/${wpath}`)
          const titleMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
          const title = titleMatch ? titleMatch[1].trim() : pageId
          await embedPage(pp, pageId, title, content, embCfg)
        } catch {
          // non-critical
        }
      }
    } catch {
      // embedding module not available
    }
  }

  const detail = writtenPaths.length > 0
    ? `${writtenPaths.length} files written${reviewItems.length > 0 ? `, ${reviewItems.length} review item(s)` : ""}`
    : "No files generated"

  activity.updateItem(activityId, {
    status: writtenPaths.length > 0 ? "done" : "error",
    detail,
    filesWritten: writtenPaths,
  })

  return writtenPaths
}

async function writeFileBlocks(
  projectPath: string,
  text: string,
): Promise<string[]> {
  const writtenPaths: string[] = []
  const matches = text.matchAll(FILE_BLOCK_REGEX)

  for (const match of matches) {
    let relativePath = match[1].trim()
    let content = match[2]
    if (!relativePath) continue

    // ── Step 0: Path validation & sanitization ──
    const frontmatterTitle = extractFrontmatterTitle(content)
    const sanitizedPath = sanitizeWikiPath(relativePath, frontmatterTitle)
    if (!sanitizedPath) {
      console.log(`[Ingest] Rejected path (temp dir or invalid): ${relativePath}`)
      continue
    }
    if (sanitizedPath !== relativePath) {
      console.log(`[Ingest] Redirected path: ${relativePath} → ${sanitizedPath}`)
      relativePath = sanitizedPath
    }

    // ── Step 1: Normalize tags in content ──
    content = normalizeTags(content)

    const fullPath = `${projectPath}/${relativePath}`

    // ── Step 2: Skip duplicate files ──
    if (!relativePath.includes("log.md") && !relativePath.includes("index.md")) {
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"))
      const fileName = fullPath.substring(fullPath.lastIndexOf("/") + 1)
      const baseName = fileName.replace(/\s*\([^)]*\)\s*/, "").replace(".md", "")
      const exists = await findExistingFile(dir, baseName)
      if (exists && exists !== fullPath) {
        console.log(`[Ingest] Skipping duplicate: ${fileName} (similar to ${exists.split("/").pop()})`)
        continue
      }
    }

    // ── Step 3: Write file (with smart merge for index.md) ──
    try {
      if (relativePath === "wiki/log.md" || relativePath.endsWith("/log.md")) {
        const existing = await tryReadFile(fullPath)
        const appended = existing ? `${existing}\n\n${content.trim()}` : content.trim()
        await writeFile(fullPath, appended)
      } else if (relativePath === "wiki/index.md" || relativePath.endsWith("/index.md")) {
        // Smart merge: preserve existing entries, add new ones without duplication
        const existing = await tryReadFile(fullPath)
        const merged = smartMergeIndex(existing, content)
        await writeFile(fullPath, merged)
      } else {
        await writeFile(fullPath, content)
      }
      writtenPaths.push(relativePath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  return writtenPaths
}

/**
 * Check if a directory contains a file whose base name matches the given base name.
 * Base name comparison strips parenthesized suffixes like stock codes.
 * Returns the full path of the existing file, or null.
 */
async function findExistingFile(dir: string, baseName: string): Promise<string | null> {
  try {
    const entries = await listDirectory(dir)
    for (const entry of entries) {
      if (entry.is_dir) continue
      const entryBase = entry.name
        .replace(/\s*\([^)]*\)\s*/, "")
        .replace(".md", "")
      if (entryBase.toLowerCase() === baseName.toLowerCase()) {
        return entry.path
      }
    }
  } catch {
    // Directory doesn't exist yet, no duplicates possible
  }
  return null
}

const REVIEW_BLOCK_REGEX = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g

function parseReviewBlocks(
  text: string,
  sourcePath: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  const items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[] = []
  const matches = text.matchAll(REVIEW_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const title = match[2].trim()
    const body = match[3].trim()

    const type = (
      ["contradiction", "duplicate", "missing-page", "suggestion"].includes(rawType)
        ? rawType
        : "confirm"
    ) as ReviewItem["type"]

    // Parse OPTIONS line
    const optionsMatch = body.match(/^OPTIONS:\s*(.+)$/m)
    const options = optionsMatch
      ? optionsMatch[1].split("|").map((o) => {
          const label = o.trim()
          return { label, action: label }
        })
      : [
          { label: "Approve", action: "Approve" },
          { label: "Skip", action: "Skip" },
        ]

    // Parse PAGES line
    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    // Parse SEARCH line (optimized search queries for Deep Research)
    const searchMatch = body.match(/^SEARCH:\s*(.+)$/m)
    const searchQueries = searchMatch
      ? searchMatch[1].split("|").map((q) => q.trim()).filter((q) => q.length > 0)
      : undefined

    // Description is the body minus OPTIONS, PAGES, and SEARCH lines
    const description = body
      .replace(/^OPTIONS:.*$/m, "")
      .replace(/^PAGES:.*$/m, "")
      .replace(/^SEARCH:.*$/m, "")
      .trim()

    items.push({
      type,
      title,
      description,
      sourcePath,
      affectedPages,
      searchQueries,
      options,
    })
  }

  return items
}

/**
 * Step 1 prompt: AI reads the source and produces a structured analysis.
 * This is the "discussion" step — the AI reasons about the source before writing wiki pages.
 */
function buildAnalysisPrompt(purpose: string, index: string): string {
  return [
    "You are an expert research analyst. Read the source document and produce a structured analysis.",
    "",
    LANGUAGE_RULE,
    "",
    "Your analysis should cover:",
    "",
    "## Key Entities",
    "List people, organizations, products, datasets, tools mentioned. For each:",
    "- Name and type",
    "- Role in the source (central vs. peripheral)",
    "- Whether it likely already exists in the wiki (check the index)",
    "",
    "## Key Concepts",
    "List theories, methods, techniques, phenomena. For each:",
    "- Name and brief definition",
    "- Why it matters in this source",
    "- Whether it likely already exists in the wiki",
    "",
    "## Main Arguments & Findings",
    "- What are the core claims or results?",
    "- What evidence supports them?",
    "- How strong is the evidence?",
    "",
    "## Connections to Existing Wiki",
    "- What existing pages does this source relate to?",
    "- Does it strengthen, challenge, or extend existing knowledge?",
    "",
    "## Contradictions & Tensions",
    "- Does anything in this source conflict with existing wiki content?",
    "- Are there internal tensions or caveats?",
    "",
    "## Recommendations",
    "- What wiki pages should be created or updated?",
    "- What should be emphasized vs. de-emphasized?",
    "- Any open questions worth flagging for the user?",
    "",
    "Be thorough but concise. Focus on what's genuinely important.",
    "",
    "If a folder context is provided, use it as a hint for categorization — the folder structure often reflects the user's organizational intent (e.g., 'papers/energy' suggests the file is an energy-related paper).",
    "",
    purpose ? `## Wiki Purpose (for context)\n${purpose}` : "",
    index ? `## Current Wiki Index (for checking existing content)\n${index}` : "",
  ].filter(Boolean).join("\n")
}

/**
 * Step 2 prompt: AI takes its own analysis and generates wiki files + review items.
 */
function buildGenerationPrompt(schema: string, purpose: string, index: string, sourceFileName: string, overview?: string, wikiDirs?: string[]): string {
  // Use original filename (without extension) as the source summary page name
  const sourceBaseName = sourceFileName.replace(/\.[^.]+$/, "")

  return [
    "You are a wiki maintainer. Based on the analysis provided, generate wiki files.",
    "",
    LANGUAGE_RULE,
    "",
    `## IMPORTANT: Source File`,
    `The original source file is: **${sourceFileName}**`,
    `All wiki pages generated from this source MUST include this filename in their frontmatter \`sources\` field.`,
    "",
    "## Output Format",
    "",
    "Output each wiki file in this exact format:",
    "",
    "---FILE: wiki/子目录/文件名.md---",
    "(complete file content with YAML frontmatter)",
    "---END FILE---",
    "",
    "Generate:",
    `1. A source summary page at **wiki/原始资料/${sourceBaseName}.md** (MUST use this exact path)`,
    `2. Entity/concept/strategy/stock pages in the appropriate wiki subdirectory. Available directories: ${wikiDirs && wikiDirs.length > 0 ? wikiDirs.join(", ") : "wiki/股票/, wiki/概念/"}.`,
    `   CRITICAL RULES:`,
    `   (a) You MUST use ONLY the directories listed above. Do NOT create any new directories.`,
    `   (b) If a Chinese directory exists for a page type (e.g. wiki/股票/, wiki/策略/, wiki/模式/), you MUST use the Chinese directory and NEVER use its English equivalent (e.g. wiki/stocks/, wiki/strategies/, wiki/patterns/).`,
    `   (c) The frontmatter \`type\` field determines the directory. Map: 股票→wiki/股票/, 策略→wiki/策略/, 模式→wiki/模式/, 错误→wiki/错误/, 市场环境→wiki/市场环境/, 进化→wiki/进化/, 总结→wiki/总结/, 预测→wiki/预测/. If no matching dir exists, use the closest available one.`,
    `   (d) Filenames MUST be short descriptive names (max 30 Chinese chars or 50 ASCII chars), NEVER use the AI's own response text as the filename. Use the entity/concept/stock name, or a concise summary. Examples: 贵州茅台.md, 龙头首阴战法.md, 市场情绪周期.md — NOT "好的收到这份市场环境分析是对你职业生涯.md".`,
    "3. An updated wiki/index.md — output the COMPLETE index with ALL entries (existing + new). New entries should be ADDED to the appropriate category section WITHOUT removing existing entries. The system will automatically deduplicate.",
    "4. A log entry for wiki/log.md (just the new entry to append, format: ## YYYY-MM-DD | 类型 | 标题)",
    "5. An updated wiki/overview.md — a high-level summary of what the entire wiki covers, updated to reflect the newly ingested source. This should be a comprehensive 2-5 paragraph overview of ALL topics in the wiki, not just the new source.",
    "",
    "## Frontmatter Rules (CRITICAL)",
    "",
    "Every page MUST have YAML frontmatter with these fields:",
    "```yaml",
    "---",
    "type: 股票 | 策略 | 模式 | 错误 | 市场环境 | 进化 | 总结 | 预测 | 原始资料",
    "title: Human-readable title",
    "created: YYYY-MM-DD",
    "updated: YYYY-MM-DD",
    "tags:",
    "  - 标签1",
    "  - 标签2",
    "related: []",
    `sources: ["${sourceFileName}"]  # MUST contain the original source filename`,
    "confidence_grade: B  # A/B/C/D/E — see rules below",
    "confidence_reason: 基于2份来源的分析",
    "---",
    "```",
    "",
    `CRITICAL — Tags Format: tags MUST be in yaml multiline format (tags:\\n  - xxx\\n  - yyy). NEVER use inline format like tags: [xxx, yyy] or tags: ['xxx', 'yyy']. Even empty tags should be \`tags: []\`.`,
    "",
    `IMPORTANT: The exact \`type\` values MUST follow the Wiki Schema above. If the schema defines Chinese types (e.g. \`策略\`, \`股票\`, \`模式\`, \`错误\`, \`市场环境\`, \`进化\`, \`总结\`, \`预测\`), use those Chinese values. Do NOT use English types like \`entity\` or \`concept\` when Chinese equivalents are defined in the schema.`,
    `CRITICAL: The frontmatter \`type\` field must match the directory where the file is placed. For example, a file at \`wiki/股票/沃格光电.md\` must have \`type: 股票\`, NOT \`type: entity\` or \`type: 个股\`.`,
    "",
    `The \`sources\` field MUST always contain "${sourceFileName}" — this links the wiki page back to the original uploaded document.`,
    "",
    "## Confidence Rules",
    "",
    "Each page MUST include a `confidence_grade` field. Do NOT guess a number. Instead, evaluate the evidence quality and pick a grade:",
    "",
    "| Grade | Condition | Example |",
    "|-------|-----------|---------|",
    "| A | 3+ independent sources confirm, no contradictions, recently verified | 研报+交割单+复盘三重验证 |",
    "| B | 2+ sources support, no known contradictions | 研报+复盘验证 |",
    "| C | Single source, or limited evidence | 仅一份研报 |",
    "| D | Speculative, based on reasoning with little direct evidence | 基于盘面推测 |",
    "| E | Hypothesis/guess, explicitly needs verification | 初步猜想 |",
    "",
    "Also include `confidence_reason`: a brief explanation of why this grade was chosen (e.g. '基于2份研报和1份交割单验证').",
    "",
    "Other rules:",
    "- Use [[wikilink]] syntax for cross-references between pages",
    "- Use short descriptive filenames (NOT AI response text)",
    "- Follow the analysis recommendations on what to emphasize",
    "- If the analysis found connections to existing pages, add cross-references",
    "- NEVER create temp directories like '更新核心页面/' or '临时/' — write directly to the target wiki/ directory",
    "",
    "## Review Items",
    "",
    "After the FILE blocks, output REVIEW blocks for anything that needs human judgment:",
    "",
    "---REVIEW: type | Title---",
    "Description of what needs the user's attention.",
    "OPTIONS: (see allowed options below)",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: search query 1 | search query 2 | search query 3",
    "---END REVIEW---",
    "",
    "Review types and when to use:",
    "- contradiction: the analysis found conflicts with existing wiki content",
    "- duplicate: an entity/concept might already exist under a different name in the index",
    "- missing-page: an important concept is referenced but has no dedicated page",
    "- suggestion: ideas for further research, related sources to look for, or connections worth exploring",
    "",
    "## OPTIONS Rules (CRITICAL — only use these predefined options):",
    "",
    "For each review type, use ONLY these allowed OPTIONS:",
    "",
    "- contradiction: OPTIONS: Create Page | Skip",
    "- duplicate: OPTIONS: Create Page | Skip",
    "- missing-page: OPTIONS: Create Page | Skip",
    "- suggestion: OPTIONS: Create Page | Skip",
    "",
    "The user also has a 'Deep Research' button (auto-added by the system) that triggers web search.",
    "Do NOT invent custom option labels. Only use 'Create Page' and 'Skip'.",
    "",
    "IMPORTANT for suggestion and missing-page types:",
    "- The SEARCH field must contain 2-3 web search queries optimized for finding relevant papers, articles, or documentation.",
    "- These should be specific, keyword-rich queries suitable for a search engine — NOT titles or sentences.",
    "- Example: for a suggestion about 'automated debt detection in AI-generated code', good SEARCH queries would be:",
    "  SEARCH: automated technical debt detection AI generated code | software quality metrics LLM code generation | static analysis tools agentic software development",
    "",
    "Only create reviews for things that genuinely need human input. Don't create trivial reviews.",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index (preserve all existing entries, add new ones)\n${index}` : "",
    overview ? `## Current Overview (update this to reflect the new source)\n${overview}` : "",
  ].filter(Boolean).join("\n")
}

function getStore() {
  return useChatStore.getState()
}

async function tryReadFile(path: string): Promise<string> {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

export async function startIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const store = getStore()
  store.setMode("ingest")
  store.setIngestSource(sp)
  store.clearMessages()
  store.setStreaming(false)

  const [sourceContent, schema, purpose, index] = await Promise.all([
    tryReadFile(sp),
    tryReadFile(`${pp}/wiki/schema.md`),
    tryReadFile(`${pp}/wiki/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const fileName = getFileName(sp)

  const systemPrompt = [
    "You are a knowledgeable assistant helping to build a wiki from source documents.",
    "",
    LANGUAGE_RULE,
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  const userMessage = [
    `I'm ingesting the following source file into my wiki: **${fileName}**`,
    "",
    "Please read it carefully and present the key takeaways, important concepts, and information that would be valuable to capture in the wiki. Highlight anything that relates to the wiki's purpose and schema.",
    "",
    "---",
    `**File: ${fileName}**`,
    "```",
    sourceContent || "(empty file)",
    "```",
  ].join("\n")

  store.addMessage("user", userMessage)
  store.setStreaming(true)

  let accumulated = ""

  try {
    await streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      {
        onToken: (token) => {
          accumulated += token
          getStore().appendStreamToken(token)
        },
        onDone: () => {
          getStore().finalizeStream(accumulated)
        },
        onError: (err) => {
          getStore().finalizeStream(`Error during ingest: ${err.message}`)
        },
      },
      signal,
    )
  } finally {
    store.setStreaming(false)
  }
}

export async function executeIngestWrites(
  projectPath: string,
  llmConfig: LlmConfig,
  userGuidance?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const store = getStore()

  const [schema, index] = await Promise.all([
    tryReadFile(`${pp}/wiki/schema.md`),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const conversationHistory = store.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))

  const writePrompt = [
    "Based on our discussion, please generate the wiki files that should be created or updated.",
    "",
    LANGUAGE_RULE,
    "",
    "## Output Format",
    "",
    "Output each wiki file in this exact format:",
    "",
    "---FILE: wiki/子目录/文件名.md---",
    "(complete file content with YAML frontmatter)",
    "---END FILE---",
    "",
    "Generate:",
    "1. A source summary page at wiki/原始资料/{filename}.md",
    "2. Entity/concept/strategy/stock pages in the appropriate wiki subdirectory",
    "3. An updated wiki/index.md — output COMPLETE index with ALL entries (existing + new), system deduplicates",
    "4. A log entry for wiki/log.md",
    "5. An updated wiki/overview.md",
    "",
    "## Frontmatter Rules (CRITICAL)",
    "",
    "Every page MUST have YAML frontmatter with these fields:",
    "```yaml",
    "---",
    "type: 股票 | 策略 | 模式 | 错误 | 市场环境 | 进化 | 总结 | 预测 | 原始资料",
    "title: Human-readable title",
    "created: YYYY-MM-DD",
    "updated: YYYY-MM-DD",
    "tags:",
    "  - 标签1",
    "  - 标签2",
    "related: []",
    "sources: []  # MUST contain the original source filename",
    "confidence_grade: B  # A/B/C/D/E",
    "confidence_reason: 基于2份来源的分析",
    "---",
    "```",
    "",
    "CRITICAL — Tags Format: tags MUST be yaml multiline (tags:\\n  - xxx). NEVER use tags: [xxx, yyy].",
    "",
    "## Filename Rules",
    "- Names MUST be short descriptive names, NEVER use AI response text as filename",
    "- NEVER create temp directories like '更新核心页面/' or '临时/'",
    "- Use Chinese directory names only (NOT English like wiki/stocks/)",
    "",
    "Other rules:",
    "- Use [[wikilink]] syntax for cross-references between pages",
    "- Follow the analysis recommendations on what to emphasize",
    "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
    userGuidance ? `## User Guidance\n${userGuidance}` : "",
  ].filter(Boolean).join("\n")

  const messages = [
    { role: "system" as const, content: writePrompt },
    ...conversationHistory,
  ]

  let generation = ""

  store.setStreaming(true)

  try {
    await streamChat(
      llmConfig,
      messages,
      {
        onToken: (token) => {
          generation += token
          getStore().appendStreamToken(token)
        },
        onDone: () => {
          getStore().finalizeStream(generation)
        },
        onError: (err) => {
          getStore().finalizeStream(`Error during write: ${err.message}`)
        },
      },
      signal,
    )
  } finally {
    store.setStreaming(false)
  }

  // Write files
  let writtenPaths: string[] = []
  try {
    writtenPaths = await writeFileBlocks(pp, generation)
  } catch (err) {
    console.error("Failed to write wiki files:", err)
  }

  if (writtenPaths.length > 0) {
    try {
      const tree = await listDirectory(pp)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    } catch {
      // ignore
    }
  }

  return writtenPaths
}
