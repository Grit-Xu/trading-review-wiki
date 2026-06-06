import { describe, it, expect } from "vitest"

describe("Strategy Compliance Lint placeholders", () => {
  it("LintResult type accepts strategy", () => {
    const result = {
      type: "strategy" as const,
      severity: "warning" as const,
      page: "止损执行不力",
      detail: "[violation] 2025-04-14 买入平安银行后跌破 2% 止损线未执行",
      affectedPages: ["策略/止损规则.md", "raw/日复盘/2025-04-14-复盘.md"],
    }
    expect(result.type).toBe("strategy")
    expect(result.severity).toBe("warning")
    expect(result.page).toBe("止损执行不力")
  })

  it("recognizes strength as info severity", () => {
    const result = {
      type: "strategy" as const,
      severity: "info" as const,
      page: "严格执行仓位管理",
      detail: "[strength] 最近 30 天单只个股仓位未超过 20%",
    }
    expect(result.type).toBe("strategy")
    expect(result.severity).toBe("info")
  })
})
