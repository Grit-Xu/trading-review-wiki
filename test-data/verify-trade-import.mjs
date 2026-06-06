import fs from "fs"
import Papa from "papaparse"

// Inline copy of parsing logic to verify end-to-end without path resolution issues
const HEADER_MAP = {
  date: ["日期", "成交日期", "交割日期", "date", "tradedate", "交易日期", "发生日期"],
  time: ["时间", "成交时间", "time", "成交时刻"],
  code: ["证券代码", "股票代码", "代码", "code", "stockcode", "证券编号"],
  name: ["证券名称", "股票名称", "名称", "name", "stockname", "证券简称"],
  direction: ["操作", "买卖方向", "成交方向", "委托方向", "direction", "side", "买/卖", "交易方向", "买卖"],
  quantity: ["成交数量", "数量", "quantity", "volume", "成交股数", "股数", "委托数量"],
  price: ["成交价格", "价格", "price", "成交均价", "均价", "成交单价"],
  amount: ["成交金额", "金额", "amount", "turnover", "成交总额", "成交额"],
  fee: ["手续费", "佣金", "fee", "commission", "交易费用"],
  stampTax: ["印花税", "stamptax", "印花"],
  transferFee: ["过户费", "transferfee", "过户"],
  totalCost: ["发生金额", "总费用", "totalamount", "清算金额", "发生额", "净额", "资金发生额"],
}

function findHeaderIndex(headers, keys) {
  const normalizedHeaders = headers.map((h) => h.toString().trim().replace(/\s+/g, "").toLowerCase())
  for (const key of keys) {
    const normalizedKey = key.toLowerCase().replace(/\s+/g, "")
    const idx = normalizedHeaders.indexOf(normalizedKey)
    if (idx !== -1) return idx
  }
  return -1
}

function normalizeDate(value) {
  if (value == null) return ""
  const str = String(value).trim()
  const isoLike = str.match(/(\d{4})[-\/\.年](\d{1,2})[-\/\.月](\d{1,2})/)
  if (isoLike) {
    const [, y, m, d] = isoLike
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  const short = str.match(/(\d{2})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/)
  if (short) {
    const [, y, m, d] = short
    const year = parseInt(y, 10) >= 50 ? `19${y}` : `20${y}`
    return `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`
  }
  return str
}

function parseDirection(value) {
  const str = String(value ?? "").trim().toLowerCase()
  if (["买", "买入", "b", "buy", "buyin", "多头", "多"].includes(str)) return "buy"
  if (["卖", "卖出", "s", "sell", "sale", "sellout", "空头", "空"].includes(str)) return "sell"
  return "buy"
}

function parseNumber(value) {
  if (typeof value === "number") return value
  if (value == null) return 0
  const str = String(value).replace(/,/g, "").replace(/[￥$¥]/g, "").trim()
  const num = parseFloat(str)
  return isNaN(num) ? 0 : num
}

function parseTradeRecords(rows) {
  if (rows.length < 2) return []
  const headers = rows[0].map((h) => String(h ?? ""))
  const indices = {}
  for (const [key, candidates] of Object.entries(HEADER_MAP)) {
    const idx = findHeaderIndex(headers, candidates)
    if (idx !== -1) indices[key] = idx
  }
  if (indices.date == null || indices.code == null || indices.name == null) {
    throw new Error("无法识别交割单格式，请确保文件包含日期、证券代码、证券名称等列")
  }
  const records = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length === 0) continue
    if (row.every((cell) => cell == null || String(cell).trim() === "")) continue
    const date = normalizeDate(row[indices.date])
    if (!date) continue
    records.push({
      date,
      time: indices.time != null ? String(row[indices.time] ?? "").trim() || undefined : undefined,
      code: String(row[indices.code]).trim(),
      name: String(row[indices.name]).trim(),
      direction: parseDirection(row[indices.direction ?? -1]),
      quantity: parseNumber(row[indices.quantity ?? -1]),
      price: parseNumber(row[indices.price ?? -1]),
      amount: parseNumber(row[indices.amount ?? -1]),
      fee: parseNumber(row[indices.fee ?? -1]),
      stampTax: parseNumber(row[indices.stampTax ?? -1]),
      transferFee: parseNumber(row[indices.transferFee ?? -1]),
      totalCost: parseNumber(row[indices.totalCost ?? -1]),
    })
  }
  return records
}

function groupRecordsByDate(records) {
  const map = new Map()
  for (const r of records) {
    const list = map.get(r.date) ?? []
    list.push(r)
    map.set(r.date, list)
  }
  return map
}

function formatMoney(n) {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function buildTradeMarkdown(date, records) {
  const sorted = [...records].sort((a, b) => (a.time || "").localeCompare(b.time || ""))
  const lines = [`# 交割单 — ${date}`, ""]
  lines.push("| 时间 | 代码 | 名称 | 方向 | 数量 | 价格 | 金额 | 手续费 | 印花税 | 过户费 |")
  lines.push("|------|------|------|------|------|------|------|--------|--------|--------|")
  for (const r of sorted) {
    const time = r.time || "—"
    const dir = r.direction === "buy" ? "买入" : "卖出"
    lines.push(
      `| ${time} | ${r.code} | ${r.name} | ${dir} | ${r.quantity} | ${formatMoney(r.price)} | ${formatMoney(r.amount)} | ${formatMoney(r.fee)} | ${formatMoney(r.stampTax)} | ${formatMoney(r.transferFee)} |`
    )
  }
  const buyRecords = records.filter((r) => r.direction === "buy")
  const sellRecords = records.filter((r) => r.direction === "sell")
  const totalFee = records.reduce((s, r) => s + r.fee, 0)
  const totalStamp = records.reduce((s, r) => s + r.stampTax, 0)
  const totalTransfer = records.reduce((s, r) => s + r.transferFee, 0)
  const buyAmount = buyRecords.reduce((s, r) => s + r.amount, 0)
  const sellAmount = sellRecords.reduce((s, r) => s + r.amount, 0)
  const netPnL = records.reduce((s, r) => s + r.totalCost, 0)
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

function buildTradeSummaryForReview(date, records) {
  const buyRecords = records.filter((r) => r.direction === "buy")
  const sellRecords = records.filter((r) => r.direction === "sell")
  const totalFee = records.reduce((s, r) => s + r.fee, 0)
  const totalStamp = records.reduce((s, r) => s + r.stampTax, 0)
  const totalTransfer = records.reduce((s, r) => s + r.transferFee, 0)
  const buyAmount = buyRecords.reduce((s, r) => s + r.amount, 0)
  const sellAmount = sellRecords.reduce((s, r) => s + r.amount, 0)
  const netPnL = records.reduce((s, r) => s + r.totalCost, 0)
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

// Run verification
const csvPath = new URL("./sample-trade.csv", import.meta.url).pathname.replace(/^\//, "")
const content = fs.readFileSync(csvPath, "utf-8")
const parsed = Papa.parse(content, { skipEmptyLines: true })
const records = parseTradeRecords(parsed.data)

console.log("=== 解析结果 ===")
console.log(JSON.stringify(records, null, 2))

const grouped = groupRecordsByDate(records)
console.log("\n=== 按日期分组 ===")
for (const [date, list] of grouped) {
  console.log(`${date}: ${list.length} 笔交易`)
}

console.log("\n=== 2025-04-14 交割单 Markdown ===")
const md14 = buildTradeMarkdown("2025-04-14", grouped.get("2025-04-14"))
console.log(md14)

console.log("\n=== 2025-04-14 复盘追加内容 ===")
const summary14 = buildTradeSummaryForReview("2025-04-14", grouped.get("2025-04-14"))
console.log(summary14)
