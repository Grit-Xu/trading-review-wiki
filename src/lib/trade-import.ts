import Papa from "papaparse"
import * as XLSX from "xlsx"

export interface TradeRecord {
  date: string // YYYY-MM-DD
  time?: string
  code: string
  name: string
  direction: "buy" | "sell"
  quantity: number
  price: number
  amount: number
  fee: number
  stampTax: number
  transferFee: number
  totalCost: number // 发生金额：买入为正，卖出为负（或相反，取决于券商）
}

const HEADER_MAP: Record<keyof TradeRecord, string[]> = {
  date: ["日期", "成交日期", "交割日期", "委托日期", "date", "tradedate", "交易日期", "发生日期"],
  time: ["时间", "成交时间", "委托时间", "time", "成交时刻"],
  code: ["证券代码", "股票代码", "代码", "code", "stockcode", "证券编号", "合约"],
  name: ["证券名称", "股票名称", "名称", "name", "stockname", "证券简称"],
  direction: ["操作", "买卖方向", "成交方向", "委托方向", "买卖标志", "direction", "side", "买/卖", "交易方向", "买卖"],
  quantity: ["成交数量", "数量", "quantity", "volume", "成交股数", "股数", "委托数量"],
  price: ["成交价格", "价格", "price", "成交均价", "均价", "成交单价", "委托价格"],
  amount: ["成交金额", "金额", "amount", "turnover", "成交总额", "成交额", "委托金额"],
  fee: ["手续费", "佣金", "fee", "commission", "交易费用", "规费", "其他费用"],
  stampTax: ["印花税", "stamptax", "印花"],
  transferFee: ["过户费", "transferfee", "过户"],
  totalCost: ["发生金额", "总费用", "totalamount", "清算金额", "发生额", "净额", "资金发生额"],
}

function normalizeHeader(h: unknown): string {
  return String(h ?? "").trim().replace(/\s+/g, "").toLowerCase()
}

function findHeaderIndex(headers: string[], keys: string[]): number {
  const normalizedHeaders = headers.map(normalizeHeader)
  for (const key of keys) {
    const normalizedKey = key.toLowerCase().replace(/\s+/g, "")
    const idx = normalizedHeaders.indexOf(normalizedKey)
    if (idx !== -1) return idx
  }
  return -1
}

function findHeaderRow(rows: unknown[][]): { rowIndex: number; headers: string[] } | null {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i]
    if (!Array.isArray(row) || row.length < 3) continue
    const headers = row.map((h) => String(h ?? ""))
    const hasCode = findHeaderIndex(headers, HEADER_MAP.code) !== -1
    const hasDate = findHeaderIndex(headers, HEADER_MAP.date) !== -1
    const hasName = findHeaderIndex(headers, HEADER_MAP.name) !== -1
    if (hasCode && (hasDate || hasName)) {
      return { rowIndex: i, headers }
    }
  }
  return null
}

function normalizeDate(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "number" && value > 30000 && value < 60000) {
    // Excel serial date → JS Date (1899-12-30 baseline)
    const epoch = new Date(1899, 11, 30)
    const d = new Date(epoch.getTime() + value * 86400000)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
  }
  const str = String(value).trim()
  // 2025-04-15 or 2025/04/15
  const isoLike = str.match(/(\d{4})[-\/\.年](\d{1,2})[-\/\.月](\d{1,2})/)
  if (isoLike) {
    const [, y, m, d] = isoLike
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  // 25/04/15 (assume 20xx)
  const short = str.match(/(\d{2})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/)
  if (short) {
    const [, y, m, d] = short
    const year = parseInt(y, 10) >= 50 ? `19${y}` : `20${y}`
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  return str
}

function parseDirection(value: unknown): TradeRecord["direction"] | null {
  const str = String(value ?? "").trim().toLowerCase()
  if (["买", "买入", "b", "buy", "buyin", "多头", "多", "证券买入"].includes(str)) return "buy"
  if (["卖", "卖出", "s", "sell", "sale", "sellout", "空头", "空", "证券卖出"].includes(str)) return "sell"
  return null // 不再静默 fallback — 避免列错位导致统计全错
}

function parseNumber(value: unknown): number {
  if (typeof value === "number") return value
  if (value == null) return 0
  const str = String(value).replace(/,/g, "").replace(/[￥$¥]/g, "").trim()
  const num = parseFloat(str)
  return isNaN(num) ? 0 : num
}

function isWithdrawn(row: unknown[], headers: string[]): boolean {
  const idxDealQty = findHeaderIndex(headers, ["成交数量", "成交量"])
  const idxEntrustQty = findHeaderIndex(headers, ["委托数量"])
  const idxWithdrawQty = findHeaderIndex(headers, ["已撤数量", "撤单数量", "撤销量"])
  const idxStatus = findHeaderIndex(headers, ["状态", "成交状态", "委托状态", "撤单标志", "备注", "摘要"])

  // 过滤非交易流水（红利、送转股、配股缴款、新股中签、可转债转股等）
  const summary = idxStatus !== -1 ? String(row[idxStatus] ?? "").trim() : ""
  if (/(红利|股息|送转|送股|转增|配股|中签|新股|转债|转股|转托管|回购|质押|解冻)/.test(summary)) return true

  // 撤单/废单/未成交过滤（原有逻辑保留）

  const dealQty = idxDealQty !== -1 ? parseNumber(row[idxDealQty]) : NaN
  const entrustQty = idxEntrustQty !== -1 ? parseNumber(row[idxEntrustQty]) : NaN
  const withdrawQty = idxWithdrawQty !== -1 ? parseNumber(row[idxWithdrawQty]) : NaN
  const status = idxStatus !== -1 ? String(row[idxStatus] ?? "").trim() : ""

  if (idxDealQty !== -1 && dealQty === 0) return true
  if (idxEntrustQty !== -1 && idxWithdrawQty !== -1 && entrustQty > 0 && withdrawQty >= entrustQty) return true
  if (status && /(撤单|废单|未成交|失败|拒绝)/.test(status)) return true
  return false
}

export function parseTradeRecords(rows: unknown[][]): TradeRecord[] {
  if (rows.length < 2) return []

  const headerInfo = findHeaderRow(rows)
  if (!headerInfo) {
    throw new Error("无法找到表头行。请确保文件前20行内包含“证券代码”、“日期”等列名。")
  }

  const { rowIndex, headers } = headerInfo
  const indices: Partial<Record<keyof TradeRecord, number>> = {}
  for (const [key, candidates] of Object.entries(HEADER_MAP)) {
    const idx = findHeaderIndex(headers, candidates)
    if (idx !== -1) {
      indices[key as keyof TradeRecord] = idx
    }
  }

  // Fuzzy fallback for date column
  if (indices.date == null) {
    const idx = headers.findIndex((h) => /(日期|date|day)/i.test(h))
    if (idx !== -1) indices.date = idx
  }

  // Fuzzy fallback for direction column
  if (indices.direction == null) {
    const idx = headers.findIndex((h) => /(买|卖|方向|操作|side|委托类型|类型|b\/s)/i.test(h))
    if (idx !== -1) indices.direction = idx
  }

  // Fallback: some brokers put datetime inside the "time" column (e.g. "2025-04-15 09:23:45")
  if (indices.date == null && indices.time != null) {
    for (let i = rowIndex + 1; i < rows.length; i++) {
      const row = rows[i]
      if (!row || row.length === 0) continue
      const timeVal = row[indices.time]
      if (timeVal != null && normalizeDate(timeVal)) {
        indices.date = indices.time
        break
      }
    }
  }

  if (indices.date == null || indices.code == null || indices.name == null) {
    const matched = Object.keys(indices).join(", ") || "无"
    const allKeys = Object.keys(HEADER_MAP) as (keyof TradeRecord)[]
    const unmatched = allKeys.filter((k) => indices[k] == null).join(", ")
    throw new Error(
      `无法识别交割单/委托单格式。已匹配字段：${matched}；未匹配字段：${unmatched}。请检查文件是否包含日期、证券代码、证券名称列。`
    )
  }

  const records: TradeRecord[] = []
  for (let i = rowIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length === 0) continue
    if (row.every((cell) => cell == null || String(cell).trim() === "")) continue

    // 过滤未成交/撤单记录（委托单常见）
    if (isWithdrawn(row, headers)) continue

    const date = normalizeDate(row[indices.date!])
    if (!date) continue

    let direction = indices.direction != null ? parseDirection(row[indices.direction]) : null

    // Fallback: 若方向列缺失或无法识别，尝试从发生金额正负推断（买入扣钱为负，卖出收钱为正）
    if (direction === null && indices.totalCost != null) {
      const tc = parseNumber(row[indices.totalCost])
      if (tc < 0) direction = "buy"
      else if (tc > 0) direction = "sell"
    }

    if (direction === null) {
      // 方向无法识别，跳过该记录（防止静默污染统计）
      continue
    }

    const quantity = indices.quantity != null ? parseNumber(row[indices.quantity]) : 0
    const price = indices.price != null ? parseNumber(row[indices.price]) : 0
    // 某些券商 CSV 中买入金额为负数，统一取绝对值
    const amount = Math.abs(indices.amount != null ? parseNumber(row[indices.amount]) : 0)
    const fee = indices.fee != null ? parseNumber(row[indices.fee]) : 0
    const stampTax = indices.stampTax != null ? parseNumber(row[indices.stampTax]) : 0
    const transferFee = indices.transferFee != null ? parseNumber(row[indices.transferFee]) : 0
    let totalCost = indices.totalCost != null ? parseNumber(row[indices.totalCost]) : 0

    // 若缺少发生金额，用成交金额+费用估算（买入记负，卖出记正）
    if (totalCost === 0 && (amount > 0 || fee > 0 || stampTax > 0 || transferFee > 0)) {
      const cost = amount + fee + stampTax + transferFee
      totalCost = direction === "buy" ? -cost : cost
    }

    records.push({
      date,
      time: indices.time != null ? String(row[indices.time] ?? "").trim() || undefined : undefined,
      code: String(row[indices.code!] ?? "").trim(),
      name: String(row[indices.name!] ?? "").trim(),
      direction,
      quantity,
      price,
      amount,
      fee,
      stampTax,
      transferFee,
      totalCost,
    })
  }

  return records
}

export function parseTradeCSV(content: string): TradeRecord[] {
  const result = Papa.parse<unknown[]>(content, {
    skipEmptyLines: true,
  })
  return parseTradeRecords(result.data)
}

function fixGbkString(str: string): string {
  const bytes = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff
  }
  try {
    return new TextDecoder("gbk").decode(bytes)
  } catch {
    return str
  }
}

function fixGbkRows(rows: unknown[][]): unknown[][] {
  return rows.map((row) =>
    Array.isArray(row)
      ? row.map((cell) => (typeof cell === "string" ? fixGbkString(cell) : cell))
      : row
  )
}

export function parseTradeExcel(arrayBuffer: ArrayBuffer): TradeRecord[] {
  // 第一次尝试默认解析
  let workbook = XLSX.read(arrayBuffer, { type: "array" })
  let sheet = workbook.Sheets[workbook.SheetNames[0]]
  let rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })

  // 如果找不到表头，尝试用中文 codepage 936 重新解析
  if (!findHeaderRow(rows)) {
    try {
      workbook = XLSX.read(arrayBuffer, { type: "array", codepage: 936 })
      sheet = workbook.Sheets[workbook.SheetNames[0]]
      rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })
    } catch {}
  }

  // 如果还是找不到，尝试手动 GBK 编码修复
  if (!findHeaderRow(rows)) {
    try {
      rows = fixGbkRows(rows)
    } catch {}
  }

  // 最后尝试：有些券商导出的是 HTML 表格伪装成 .xls
  if (!findHeaderRow(rows)) {
    try {
      const text = new TextDecoder("gbk").decode(new Uint8Array(arrayBuffer))
      if (text.includes("<table") || text.includes("<TABLE")) {
        workbook = XLSX.read(text, { type: "string" })
        sheet = workbook.Sheets[workbook.SheetNames[0]]
        rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })
      }
    } catch {}
  }

  return parseTradeRecords(rows)
}

export function groupRecordsByDate(records: TradeRecord[]): Map<string, TradeRecord[]> {
  const map = new Map<string, TradeRecord[]>()
  for (const r of records) {
    const list = map.get(r.date) ?? []
    list.push(r)
    map.set(r.date, list)
  }
  return map
}

// ==================== FIFO 持仓盈亏计算 ====================

interface Lot {
  quantity: number
  costPerShare: number // (成交金额 + 全部费用) / 数量
}

/**
 * 基于先进先出(FIFO)计算每日已实现盈亏。
 * 买入增加持仓批次，卖出按最早批次扣减并计算盈亏。
 * 返回 Map<日期, 当日已实现盈亏>
 *
 * ⚠️ 边界限制：本算法假设所有记录均为普通买卖交易。
 * 不支持 A 股特殊场景：送股、转增股、现金分红、配股缴款、新股中签/缴款、可转债转股等。
 * 这些行为会导致持仓成本或数量突变，从而使 FIFO 盈亏计算结果错乱。
 * 建议：如交割单中包含此类记录，应通过摘要/备注列提前过滤，或在 wiki 中手动标注并调整持仓成本。
 */
export function calculateFifoPnL(allRecords: TradeRecord[]): { datePnL: Map<string, number>; hasUnknownCost: boolean } {
  const sorted = [...allRecords].sort((a, b) => {
    const dtA = `${a.date}T${a.time || "00:00:00"}`
    const dtB = `${b.date}T${b.time || "00:00:00"}`
    return dtA.localeCompare(dtB)
  })

  const holdings = new Map<string, Lot[]>()
  const datePnL = new Map<string, number>()
  let hasUnknownCost = false

  for (const r of sorted) {
    const lots = holdings.get(r.code) ?? []

    if (r.direction === "buy") {
      // 买入成本 = 成交金额 + 手续费 + 过户费（A股买入无印花税）
      const totalCost = Math.abs(r.amount) + r.fee + r.transferFee
      const costPerShare = r.quantity > 0 ? totalCost / r.quantity : 0
      lots.push({ quantity: r.quantity, costPerShare })
      holdings.set(r.code, lots)
    } else {
      let remainingQty = r.quantity
      let soldCost = 0

      while (remainingQty > 0 && lots.length > 0) {
        const lot = lots[0]
        const deduct = Math.min(remainingQty, lot.quantity)
        soldCost += deduct * lot.costPerShare
        lot.quantity -= deduct
        remainingQty -= deduct
        if (lot.quantity <= 0) lots.shift()
      }

      holdings.set(r.code, lots)

      if (remainingQty > 0) {
        // 卖出数量超过已知持仓 — 缺少期初持仓，成本未知
        hasUnknownCost = true
        // 只计算已知成本匹配部分的盈亏（按成交额比例分摊费用）
        const matchedQty = r.quantity - remainingQty
        if (matchedQty > 0) {
          const ratio = matchedQty / r.quantity
          const matchedAmount = r.amount * ratio
          const matchedFee = r.fee * ratio
          const matchedStamp = r.stampTax * ratio
          const matchedTransfer = r.transferFee * ratio
          const realizedPnL = matchedAmount - soldCost - matchedFee - matchedStamp - matchedTransfer
          datePnL.set(r.date, (datePnL.get(r.date) ?? 0) + realizedPnL)
        }
      } else {
        // 全部有成本 basis，正常计算
        const realizedPnL = r.amount - soldCost - r.fee - r.stampTax - r.transferFee
        datePnL.set(r.date, (datePnL.get(r.date) ?? 0) + realizedPnL)
      }
    }
  }

  return { datePnL, hasUnknownCost }
}

// ==================== Markdown 生成 ====================

function formatMoney(n: number): string {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function buildTradeMarkdown(date: string, records: TradeRecord[], realizedPnL?: number): string {
  const sorted = [...records].sort((a, b) => (a.time || "").localeCompare(b.time || ""))
  const lines: string[] = [`# 交割单 — ${date}`, ""]
  lines.push("| 时间 | 代码 | 名称 | 方向 | 数量 | 价格 | 金额 | 手续费 | 印花税 | 过户费 |")
  lines.push("|------|------|------|------|------|------|------|--------|--------|--------|")

  for (const r of sorted) {
    const time = r.time || "—"
    const dir = r.direction === "buy" ? "买入" : "卖出"
    lines.push(
      `| ${time} | ${r.code} | ${r.name} | ${dir} | ${r.quantity} | ${formatMoney(r.price)} | ${formatMoney(r.amount)} | ${formatMoney(r.fee)} | ${formatMoney(r.stampTax)} | ${formatMoney(r.transferFee)} |`
    )
  }

  // Stats
  const buyRecords = records.filter((r) => r.direction === "buy")
  const sellRecords = records.filter((r) => r.direction === "sell")
  const totalFee = records.reduce((s, r) => s + r.fee, 0)
  const totalStamp = records.reduce((s, r) => s + r.stampTax, 0)
  const totalTransfer = records.reduce((s, r) => s + r.transferFee, 0)
  const buyAmount = buyRecords.reduce((s, r) => s + r.amount, 0)
  const sellAmount = sellRecords.reduce((s, r) => s + r.amount, 0)

  // 若提供了 FIFO 已实现盈亏则使用，否则 fallback 到发生金额求和
  const netPnL = realizedPnL !== undefined ? realizedPnL : records.reduce((s, r) => s + r.totalCost, 0)

  lines.push("")
  lines.push("## 汇总")
  lines.push(`- 成交笔数：${records.length}`)
  lines.push(`- 买入金额：${formatMoney(buyAmount)}`)
  lines.push(`- 卖出金额：${formatMoney(sellAmount)}`)
  lines.push(`- 手续费：${formatMoney(totalFee)}`)
  lines.push(`- 印花税：${formatMoney(totalStamp)}`)
  lines.push(`- 过户费：${formatMoney(totalTransfer)}`)
  lines.push(`- 净盈亏：${netPnL >= 0 ? "+" : ""}${formatMoney(netPnL)}`)
  lines.push("")

  return lines.join("\n")
}

export function buildTradeSummaryForReview(date: string, records: TradeRecord[], realizedPnL?: number): string {
  const buyRecords = records.filter((r) => r.direction === "buy")
  const sellRecords = records.filter((r) => r.direction === "sell")
  const totalFee = records.reduce((s, r) => s + r.fee, 0)
  const totalStamp = records.reduce((s, r) => s + r.stampTax, 0)
  const totalTransfer = records.reduce((s, r) => s + r.transferFee, 0)
  const buyAmount = buyRecords.reduce((s, r) => s + r.amount, 0)
  const sellAmount = sellRecords.reduce((s, r) => s + r.amount, 0)
  const netPnL = realizedPnL !== undefined ? realizedPnL : records.reduce((s, r) => s + r.totalCost, 0)

  return [
    `## 当日交易汇总（${date}）`,
    "",
    `- 成交笔数：${records.length}（买入 ${buyRecords.length} / 卖出 ${sellRecords.length}）`,
    `- 买入金额：${formatMoney(buyAmount)}`,
    `- 卖出金额：${formatMoney(sellAmount)}`,
    `- 交易成本：手续费 ${formatMoney(totalFee)} + 印花税 ${formatMoney(totalStamp)} + 过户费 ${formatMoney(totalTransfer)} = ${formatMoney(totalFee + totalStamp + totalTransfer)}`,
    `- 净盈亏：${netPnL >= 0 ? "+" : ""}${formatMoney(netPnL)}`,
    "",
    "### 持仓变动",
    ...records.map((r) => `- ${r.direction === "buy" ? "买入" : "卖出"} [[${r.name}]]（${r.code}） ${r.quantity} 股 @ ${formatMoney(r.price)}`),
    "",
  ].join("\n")
}
