import { useState, useMemo, useCallback } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { runPlanAudit, type PlanAuditResult } from "@/lib/plan-audit"
import { Button } from "@/components/ui/button"
import { Target, RefreshCw, CheckCircle2, AlertTriangle, Info, ChevronDown, ChevronRight } from "lucide-react"

export function PlanAuditView() {
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)

  const [results, setResults] = useState<PlanAuditResult[]>([])
  const [loading, setLoading] = useState(false)
  const [hasRun, setHasRun] = useState(false)
  const [dayRange, setDayRange] = useState<number>(30)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())

  const canRun =
    !!project &&
    (llmConfig.apiKey || llmConfig.provider === "ollama" || llmConfig.provider === "custom")

  const handleRunAudit = useCallback(async () => {
    if (!project || !canRun || loading) return
    setLoading(true)
    setResults([])
    try {
      const auditResults = await runPlanAudit(project.path, llmConfig, dayRange)
      setResults(auditResults)
      setHasRun(true)
    } catch (err) {
      console.error("Plan audit failed:", err)
    } finally {
      setLoading(false)
    }
  }, [project, llmConfig, dayRange, canRun, loading])

  const toggleExpanded = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  // Compute stats from results
  const stats = useMemo(() => {
    const total = results.length
    const matched = results.filter((r) => r.status === "matched").length
    const violations = results.filter((r) => r.status === "violation").length
    const noPlan = results.filter((r) => r.status === "no-plan").length
    return { total, matched, violations, noPlan }
  }, [results])

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        请先打开或创建一个交易复盘项目
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">计划审计</h2>
          {hasRun && results.length > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {results.length} 天
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary"
            value={dayRange}
            onChange={(e) => setDayRange(Number(e.target.value))}
            disabled={loading}
          >
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
            <option value={365}>最近一年</option>
          </select>
          <Button size="sm" onClick={handleRunAudit} disabled={!canRun || loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {loading ? "分析中..." : "开始审计"}
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {!canRun ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <AlertTriangle className="h-8 w-8 text-amber-500/60" />
            <p>未配置 LLM</p>
            <p className="text-xs">请在「设置」中配置 LLM 提供商后，再运行计划审计。</p>
          </div>
        ) : !hasRun ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Target className="h-8 w-8 text-muted-foreground/30" />
            <p>对比每日交易计划与实际执行</p>
            <p className="text-xs">AI 将读取「日复盘」中的明日计划与次日交割单，找出执行偏差</p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
            <p className="text-emerald-600 dark:text-emerald-400 font-medium">没有可审计的数据</p>
            <p className="text-xs">在选定时间范围内未找到足够的日复盘与交割单配对。</p>
          </div>
        ) : (
          <div className="mx-auto max-w-5xl space-y-4">
            {/* KPI Cards */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard title="审计天数" value={String(stats.total)} tone="neutral" />
              <KpiCard title="完全执行" value={String(stats.matched)} tone="positive" />
              <KpiCard title="严重偏离" value={String(stats.violations)} tone="negative" />
              <KpiCard title="即兴交易" value={String(stats.noPlan)} tone="warning" />
            </div>

            {/* Results list */}
            <div className="rounded-xl border bg-card">
              <div className="border-b px-4 py-3">
                <h3 className="font-semibold">审计结果</h3>
              </div>
              <div className="divide-y">
                {results.map((result) => {
                  const key = `${result.planDate}|${result.executionDate}`
                  const expanded = expandedKeys.has(key)
                  return (
                    <div key={key} className="px-4 py-3 hover:bg-muted/30 transition-colors">
                      <button
                        className="flex w-full items-start gap-3 text-left"
                        onClick={() => toggleExpanded(key)}
                      >
                        <div className="mt-0.5 shrink-0">
                          {expanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge status={result.status} />
                            <span className="text-sm font-medium">
                              {result.executionDate}
                              {result.planDate !== "—" && (
                                <span className="text-muted-foreground font-normal">
                                  {" "}
                                  (计划日期: {result.planDate})
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="mt-0.5 text-sm text-foreground truncate">{result.title}</div>
                        </div>
                      </button>

                      {expanded && (
                        <div className="mt-3 pl-7 text-sm text-muted-foreground space-y-3">
                          <div>
                            <div className="mb-1 text-xs font-medium text-foreground">分析详情</div>
                            <p className="leading-relaxed whitespace-pre-wrap">{result.detail}</p>
                          </div>
                          {result.planText && (
                            <div className="rounded-md bg-muted/50 p-3">
                              <div className="mb-1 text-xs font-medium text-foreground">明日计划</div>
                              <p className="whitespace-pre-wrap">{result.planText}</p>
                            </div>
                          )}
                          {result.tradeSummary && result.tradeSummary !== "无交易" && (
                            <div className="rounded-md bg-muted/50 p-3">
                              <div className="mb-1 text-xs font-medium text-foreground">实际交易</div>
                              <p>{result.tradeSummary}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function KpiCard({
  title,
  value,
  tone,
}: {
  title: string
  value: string
  tone: "positive" | "negative" | "warning" | "neutral"
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-500"
      : tone === "negative"
      ? "text-red-500"
      : tone === "warning"
      ? "text-amber-500"
      : "text-primary"

  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className={`mt-2 text-2xl font-bold ${toneClass}`}>{value}</p>
    </div>
  )
}

function StatusBadge({ status }: { status: PlanAuditResult["status"] }) {
  const config: Record<
    PlanAuditResult["status"],
    { label: string; className: string }
  > = {
    matched: {
      label: "完全执行",
      className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    },
    partial: {
      label: "部分执行",
      className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    },
    violation: {
      label: "严重偏离",
      className: "bg-red-500/10 text-red-600 dark:text-red-400",
    },
    "no-trade": {
      label: "无交易",
      className: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    },
    "no-plan": {
      label: "即兴交易",
      className: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
    },
  }

  const { label, className } = config[status]
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  )
}
