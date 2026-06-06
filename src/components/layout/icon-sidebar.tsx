import { useState, useEffect } from "react"
import {
  FileText, FolderOpen, Search, Network, ClipboardCheck, Settings, ArrowLeftRight, ClipboardList, Globe, TrendingUp, PenLine, BarChart3, Target,
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { useResearchStore } from "@/stores/research-store"
import { useTranslation } from "react-i18next"
import { readFile, writeFile, createDirectory } from "@/commands/fs"
import type { WikiState } from "@/stores/wiki-store"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

type NavView = WikiState["activeView"] | "quick-review"

interface ReviewTemplate {
  id: string
  name: string
  description: string
  buildContent: (today: string) => string
}

const REVIEW_TEMPLATES: ReviewTemplate[] = [
  {
    id: "trading",
    name: "创建今日复盘",
    description: "基于你的复盘模板创建今日笔记，保存到 raw/日复盘/",
    buildContent: (today) => `# ${today} 交易复盘

## 一、今日操作

### 操作 1：买入/卖出 [股票名称/代码]
- **时间**：09:35
- **价格**：XX.XX
- **仓位**：X 成
- **理由**：
- **结果**：盈利/亏损 X%
- **截图**：\`../截图/${today}-股票名-买卖点.png\`

### 操作 2：...

----

## 二、市场环境

- **指数走势**：上涨/下跌/震荡
- **市场情绪**：高涨/分化/冰点
- **涨停家数**：XX
- **跌停家数**：XX
- **主流题材**：...
- **特殊事件**：...

----

## 三、心态与纪律

- **情绪状态**：平静/焦虑/兴奋/懊悔
- **是否按计划交易**：是/否
- **最强烈的情绪时刻**：...
- **自我评分（1-10）**：X

----

## 四、关键反思

### 做对了什么？
1. 

### 做错了什么？
1. 

### 新发现/新疑问？
1. 

----

## 五、明日计划（可选）

1. 
2. 
3. 

----

> 写完后对 LLM 说"摄入今日复盘"。
`,
  },
]

const NAV_ITEMS: { view: NavView; icon: typeof FileText; labelKey: string }[] = [
  { view: "wiki", icon: FileText, labelKey: "nav.wiki" },
  { view: "sources", icon: FolderOpen, labelKey: "nav.sources" },
  { view: "search", icon: Search, labelKey: "nav.search" },
  { view: "graph", icon: Network, labelKey: "nav.graph" },
  { view: "dashboard", icon: BarChart3, labelKey: "nav.dashboard" },
  { view: "plan", icon: Target, labelKey: "nav.plan" },
  { view: "lint", icon: ClipboardCheck, labelKey: "nav.lint" },
  { view: "review", icon: ClipboardList, labelKey: "nav.review" },
]

interface IconSidebarProps {
  onSwitchProject: () => void
}

export function IconSidebar({ onSwitchProject }: IconSidebarProps) {
  const { t } = useTranslation()
  const activeView = useWikiStore((s) => s.activeView)
  const setActiveView = useWikiStore((s) => s.setActiveView)
  const pendingCount = useReviewStore((s) => s.items.filter((i) => !i.resolved).length)
  const researchPanelOpen = useResearchStore((s) => s.panelOpen)
  const researchActiveCount = useResearchStore((s) => s.tasks.filter((t) => t.status !== "done" && t.status !== "error").length)
  const toggleResearchPanel = useResearchStore((s) => s.setPanelOpen)

  // Daemon health check
  const [daemonStatus, setDaemonStatus] = useState<string>("starting")
  useEffect(() => {
    const check = async () => {
      try {
        const { clipServerStatus } = await import("@/commands/fs")
        const status = await clipServerStatus()
        setDaemonStatus(status)
      } catch {
        setDaemonStatus("error")
      }
    }
    check()
    const interval = setInterval(check, 30000)
    return () => clearInterval(interval)
  }, [])

  const [templateDialogOpen, setTemplateDialogOpen] = useState(false)

  async function createQuickReviewFile(template: ReviewTemplate) {
    const today = new Date().toISOString().split("T")[0]
    const proj = useWikiStore.getState().project
    if (!proj) return

    let dir = `${proj.path}/raw/日复盘`
    let fileName = `${today}-复盘.md`

    // 非交易复盘放到 raw/sources/ 下更合适
    if (template.id !== "trading") {
      dir = `${proj.path}/raw/sources`
      fileName = `${today}-${template.name}.md`
    }

    const path = `${dir}/${fileName}`

    let content = ""
    try {
      content = await readFile(path)
    } catch {
      content = template.buildContent(today)
      await createDirectory(dir)
      await writeFile(path, content)
      // Refresh file tree so the new file appears
      const { listDirectory } = await import("@/commands/fs")
      const tree = await listDirectory(proj.path)
      useWikiStore.getState().setFileTree(tree)
    }

    useWikiStore.getState().setSelectedFile(path)
    useWikiStore.getState().setFileContent(content)
    useWikiStore.getState().setActiveView("wiki")
  }

  async function handleQuickReview() {
    const today = new Date().toISOString().split("T")[0]
    const proj = useWikiStore.getState().project
    if (!proj) return

    // 如果今日交易复盘已存在，直接打开
    const tradingPath = `${proj.path}/raw/日复盘/${today}-复盘.md`
    try {
      const content = await readFile(tradingPath)
      useWikiStore.getState().setSelectedFile(tradingPath)
      useWikiStore.getState().setFileContent(content)
      useWikiStore.getState().setActiveView("wiki")
      return
    } catch {
      // 不存在则弹出模板选择
      setTemplateDialogOpen(true)
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full w-12 flex-col items-center border-r bg-muted/50 py-2">
        {/* Logo */}
        <div className="mb-2 flex items-center justify-center">
          <div className="flex h-8 w-8 items-center justify-center rounded-[22%] bg-primary/10">
            <TrendingUp className="h-5 w-5 text-primary" />
          </div>
        </div>
        {/* Top: main nav items + Deep Research */}
        <div className="flex flex-1 flex-col items-center gap-1">
          {/* Quick Review */}
          <Tooltip>
            <TooltipTrigger
              onClick={handleQuickReview}
              className="relative flex h-10 w-10 items-center justify-center rounded-md transition-colors text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
            >
              <PenLine className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">{t("nav.quickReview")}</TooltipContent>
          </Tooltip>

          <div className="my-1 h-px w-6 bg-border" />

          {NAV_ITEMS.map(({ view, icon: Icon, labelKey }) => (
            <Tooltip key={view}>
              <TooltipTrigger
                onClick={() => setActiveView(view as WikiState["activeView"])}
                className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                  activeView === view
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                <Icon className="h-5 w-5" />
                {view === "review" && pendingCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </TooltipTrigger>
              <TooltipContent side="right">
                {t(labelKey)}
                {view === "review" && pendingCount > 0 && ` (${pendingCount})`}
              </TooltipContent>
            </Tooltip>
          ))}
          {/* Deep Research */}
          <Tooltip>
            <TooltipTrigger
              onClick={() => toggleResearchPanel(!researchPanelOpen)}
              className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                researchPanelOpen
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
              }`}
            >
              <Globe className="h-5 w-5" />
              {researchActiveCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-bold text-white">
                  {researchActiveCount}
                </span>
              )}
            </TooltipTrigger>
            <TooltipContent side="right">Deep Research</TooltipContent>
          </Tooltip>
        </div>
        {/* Bottom: daemon status + settings + switch project */}
        <div className="flex flex-col items-center gap-1 pb-1">
          {/* Daemon status indicator */}
          <Tooltip>
            <TooltipTrigger className="flex h-6 w-6 items-center justify-center">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  daemonStatus === "running" ? "bg-emerald-500" :
                  daemonStatus === "starting" ? "bg-amber-400 animate-pulse" :
                  daemonStatus === "port_conflict" ? "bg-red-500" :
                  "bg-red-500 animate-pulse"
                }`}
              />
            </TooltipTrigger>
            <TooltipContent side="right">
              {daemonStatus === "running" && "Clip server running"}
              {daemonStatus === "starting" && "Clip server starting..."}
              {daemonStatus === "port_conflict" && "Port 19827 is occupied. Web Clipper unavailable."}
              {daemonStatus === "error" && "Clip server error. Restarting..."}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              onClick={() => setActiveView("settings")}
              className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
                activeView === "settings"
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
              }`}
            >
              <Settings className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">{t("nav.settings")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              onClick={onSwitchProject}
              className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground"
            >
              <ArrowLeftRight className="h-5 w-5" />
            </TooltipTrigger>
            <TooltipContent side="right">{t("nav.switchProject")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Quick review create dialog */}
      <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>快速复盘</DialogTitle>
            <DialogDescription>
              点击下方按钮，基于你的复盘模板创建今日笔记并保存到 raw/日复盘/。
              若今日复盘已存在，会直接打开现有文件。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            {REVIEW_TEMPLATES.map((template) => (
              <Button
                key={template.id}
                className="h-auto flex-col items-start justify-start whitespace-normal px-4 py-3 text-left"
                onClick={async () => {
                  setTemplateDialogOpen(false)
                  await createQuickReviewFile(template)
                }}
              >
                <span className="font-medium">{template.name}</span>
                <span className="text-xs text-primary-foreground/80">{template.description}</span>
              </Button>
            ))}
          </div>
          <DialogClose asChild>
            <Button variant="ghost" className="mt-2 w-full">
              取消
            </Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
