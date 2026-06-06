import { useState, useEffect, useCallback, useMemo } from "react"
import {
  FileText, Lightbulb, BookOpen, HelpCircle, GitMerge, BarChart3, ChevronRight, ChevronDown, Layout, Globe,
  Users, Star, TrendingUp, PieChart, Database, FileCode, Calendar, Clock,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"
import { useTranslation } from "react-i18next"

interface WikiPageInfo {
  path: string
  title: string
  type: string
  tags: string[]
  origin?: string
  confidence?: number
  status?: string
}

// Dynamic icon/color palette — cycles through for each unique type discovered at runtime
const ICON_PALETTE = [
  Layout, FileText, Lightbulb, GitMerge, BarChart3,
  Users, BookOpen, HelpCircle, Star, TrendingUp,
  PieChart, Database, FileCode, Calendar, Clock,
]

const COLOR_PALETTE = [
  "text-yellow-500", "text-blue-500", "text-purple-500", "text-red-500",
  "text-emerald-500", "text-green-500", "text-orange-500", "text-cyan-500",
  "text-pink-500", "text-indigo-500", "text-teal-500", "text-rose-500",
  "text-amber-500", "text-lime-500", "text-sky-500",
]

/**
 * Turn a type slug into a human-readable label.
 * Supports both English kebab-case and Chinese.
 */
function humanizeType(type: string): string {
  // If it contains Chinese characters, return as-is
  if (/[\u4e00-\u9fff]/.test(type)) return type
  // kebab-case / snake_case → Title Case
  return type
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

export function KnowledgeTree() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const fileTree = useWikiStore((s) => s.fileTree)
  const [pages, setPages] = useState<WikiPageInfo[]>([])
  // Start with all expanded; user can collapse individual groups
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set())
  const [initialized, setInitialized] = useState(false)

  const loadPages = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      const wikiTree = await listDirectory(`${pp}/wiki`)
      const mdFiles = flattenMdFiles(wikiTree)

      const pageInfos: WikiPageInfo[] = []
      for (const file of mdFiles) {
        if (file.name === "index.md" || file.name === "log.md") continue
        try {
          const content = await readFile(file.path)
          const info = parsePageInfo(file.path, file.name, content)
          pageInfos.push(info)
        } catch {
          pageInfos.push({
            path: file.path,
            title: file.name.replace(".md", "").replace(/-/g, " "),
            type: "other",
            tags: [],
          })
        }
      }

      setPages(pageInfos)

      // Auto-expand all types on first load
      if (!initialized) {
        const allTypes = new Set(pageInfos.map((p) => p.type))
        setExpandedTypes(allTypes)
        setInitialized(true)
      }
    } catch {
      setPages([])
    }
  }, [project, initialized])

  // Reload when file tree changes (after ingest writes new pages)
  useEffect(() => {
    loadPages()
  }, [loadPages, fileTree])

  // Group pages by type and derive dynamic configs
  const { sortedGroups } = useMemo(() => {
    const grouped = new Map<string, WikiPageInfo[]>()
    for (const page of pages) {
      const list = grouped.get(page.type) ?? []
      list.push(page)
      grouped.set(page.type, list)
    }

    // Sort: "other" always last, then alphabetically by type name
    const entries = [...grouped.entries()]
    entries.sort((a, b) => {
      if (a[0] === "other") return 1
      if (b[0] === "other") return -1
      return a[0].localeCompare(b[0])
    })

    return { sortedGroups: entries }
  }, [pages])

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("fileTree.noProject")}
      </div>
    )
  }

  function toggleType(type: string) {
    setExpandedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-2">
        <div className="mb-2 px-2 text-xs font-semibold uppercase text-muted-foreground">
          {project.name}
        </div>

        {sortedGroups.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {t("knowledgeTree.emptyHint")}
          </div>
        )}

        {sortedGroups.map(([type, items], typeIndex) => {
          const Icon = ICON_PALETTE[typeIndex % ICON_PALETTE.length]
          const color = COLOR_PALETTE[typeIndex % COLOR_PALETTE.length]
          const label = humanizeType(type)
          const isExpanded = expandedTypes.has(type)

          return (
            <div key={type} className="mb-1">
              <button
                onClick={() => toggleType(type)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <Icon className={`h-3.5 w-3.5 shrink-0 ${color}`} />
                <span className="flex-1 text-left font-medium">{label}</span>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </button>

              {isExpanded && (
                <div className="ml-3">
                  {items.map((page) => {
                    const isSelected = selectedFile === page.path
                    return (
                      <button
                        key={page.path}
                        onClick={() => setSelectedFile(page.path)}
                        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm ${
                          isSelected
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                        }`}
                        title={page.path}
                      >
                        {page.origin === "web-clip" && <Globe className="h-3 w-3 shrink-0 text-blue-400" />}
                        <span className="truncate">{page.title}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* Raw sources quick access */}
        <RawSourcesSection />
      </div>
    </ScrollArea>
  )
}

function RawSourcesSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const [expanded, setExpanded] = useState(false)
  const [sources, setSources] = useState<FileNode[]>([])

  useEffect(() => {
    if (!project) return
    const pp = normalizePath(project.path)
    listDirectory(`${pp}/raw/sources`)
      .then((tree) => setSources(flattenAllFiles(tree)))
      .catch(() => setSources([]))
  }, [project])

  if (sources.length === 0) return null

  return (
    <div className="mt-2 border-t pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span className="flex-1 text-left font-medium text-muted-foreground">{t("sources.title")}</span>
        <span className="text-xs text-muted-foreground">{sources.length}</span>
      </button>
      {expanded && (
        <div className="ml-3">
          {sources.map((file) => {
            const isSelected = selectedFile === file.path
            return (
              <button
                key={file.path}
                onClick={() => setSelectedFile(file.path)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm ${
                  isSelected
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <span className="truncate">{file.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function parsePageInfo(path: string, fileName: string, content: string): WikiPageInfo {
  let type = "other"
  let title = fileName.replace(".md", "").replace(/-/g, " ")
  const tags: string[] = []
  let origin: string | undefined

  // Parse YAML frontmatter (support both LF and CRLF)
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fmMatch) {
    const fm = fmMatch[1]
    const typeMatch = fm.match(/^type:\s*(.+)$/m)
    if (typeMatch) type = typeMatch[1].trim()

    const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (titleMatch) title = titleMatch[1].trim()

    const tagsMatch = fm.match(/^tags:\s*\[(.+?)\]/m)
    if (tagsMatch) {
      tags.push(...tagsMatch[1].split(",").map((t) => t.trim().replace(/["']/g, "")))
    }

    const originMatch = fm.match(/^origin:\s*(.+)$/m)
    if (originMatch) origin = originMatch[1].trim()
  }

  // Fallback: try first heading if no frontmatter title
  if (title === fileName.replace(".md", "").replace(/-/g, " ")) {
    const headingMatch = content.match(/^#\s+(.+)$/m)
    if (headingMatch) title = headingMatch[1].trim()
  }

  // Fallback: infer type from wiki subdirectory name
  if (type === "other") {
    // Extract subdirectory under /wiki/ (e.g. /wiki/日复盘/xxx.md → "日复盘")
    const wikiDirMatch = path.match(/\/wiki\/([^/]+)\//)
    if (wikiDirMatch) {
      type = wikiDirMatch[1]
    } else if (fileName === "overview.md") {
      type = "overview"
    }
  }

  return { path, title, type, tags, origin }
}

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

function flattenAllFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenAllFiles(node.children))
    } else if (!node.is_dir) {
      files.push(node)
    }
  }
  return files
}
