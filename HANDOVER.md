# 工作交接文档 — Trading Review Wiki

> **交接人**: Kimi Code CLI  
> **接手人**: Claude Code  
> **交接日期**: 2026-04-20  
> **当前版本**: v0.6.7（已发布）

---

## 一、项目当前状态

| 项目 | 状态 |
|------|------|
| 最新版本 | **v0.6.7**（Git tag + GitHub Release 已发布） |
| 代码分支 | `main`（最新 commit: `904db85`） |
| 构建状态 | ✅ 通过（Tauri build 成功，MSI + NSIS 已上传） |
| 单元测试 | ✅ 27 项全部通过 |
| TypeScript | ✅ 无类型错误 |

**GitHub Release**: https://github.com/ymj8903668-droid/trading-review-wiki/releases/tag/v0.6.7

---

## 二、最近完成的工作（v0.6.7）

### 2.1 新功能
- **浅色主题（Light Theme）**
  - 新增 `light` 预设（白底黑字，白天使用）
  - `types/theme.ts` — 添加预设定义
  - `stores/wiki-store.ts` — `setAppTheme` 切换 `.dark` class
  - `App.tsx` — 移除硬编码 `document.documentElement.classList.add("dark")`
  - `index.css` — 添加 `:not(.dark) .milkdown-theme-nord` 覆盖（编辑器文字颜色）
  - 多个组件：`prose-invert` → `dark:prose-invert`

- **图谱明暗自适应**
  - `src/components/graph/graph-view.tsx`
  - 新增 `isDarkMode()` 辅助函数
  - Sigma settings（labelColor、defaultEdgeColor、edge alpha、highlight/dim 颜色）根据 `.dark` 类动态切换

### 2.2 Bug 修复（关键）

#### 🔴 严重：Save to Wiki / Deep Research 卡死（无限循环）
**根因**: `readFile` Rust 后端（`fs.rs:49-59`）在文件不存在时**不抛异常**，而是返回 `"[Binary file: {name} ({size:.1f} KB)]"` 字符串。  
三个文件用 `while(true) { try { await readFile(testPath) } catch { break } }` 做文件名去重，结果变成死循环。

**修复方案**: 全部改用 `listDirectory` + `Set.has()` 检测文件名是否存在。

| 文件 | 修复位置 |
|------|---------|
| `src/components/chat/chat-message.tsx` | SaveToWikiButton 保存到 `wiki/queries/` 时的去重逻辑 |
| `src/lib/deep-research.ts` | `saveResearchDraft()` 保存研究草稿时的去重逻辑 |
| `src/components/review/review-view.tsx` | Review 面板保存到 Wiki 时的去重逻辑 |

**⚠️ 重要教训**: 项目中任何用 `try-catch` 围绕 `readFile` 来判断文件是否存在的代码都是**错误的**。必须改用 `listDirectory` 或类似的目录遍历方式。

#### 🟡 ActivityPanel 闪烁
- `src/components/layout/activity-panel.tsx`
- 移除 `expanded`/`hasQueue` 从 `useEffect` 依赖数组
- 自动展开只在 `runningCount` 从 `0→1` 时触发

#### 🟡 Review 面板按钮冲突
- `src/components/review/review-view.tsx`
- `ReviewCard` 按钮 `key` 从 `key={opt.action}` 改为 `key={\`\${opt.action}-\${idx}\`}`
- 避免 React key 碰撞导致点击错位

#### 🟡 createPageFromReview 未定义
- `review-view.tsx` 中 `__create_page__:` 分支调用了不存在的函数
- 已内联实现

### 2.3 已回退的改动
- `writeFileBlocks`（`src/lib/ingest.ts`）已恢复为**原始透传行为**
- 不验证目录、不做中英文映射、不跳过未知目录
- LLM 输出的文件路径直接写入

---

## 三、已知陷阱与关键约定

### 3.1 readFile 行为（⚠️ 必须牢记）
```
readFile(path) → 文件存在：返回内容
readFile(path) → 文件不存在：返回 "[Binary file: filename (0.0 KB)]"
readFile(path) → 文件存在但读取失败：可能也返回类似字符串
```
**绝不可以用 try-catch 来判断文件是否存在。**  
**正确做法**: `listDirectory(dir).then(files => files.map(f => f.name).includes(filename))`

### 3.2 主题系统
```
<html class="dark">              → 暗色模式（Tailwind dark: 变体生效）
<html>（无 .dark）               → 浅色模式
<html data-theme="midnight">     → 暗色 + 色相偏移（午夜蓝）
```
- `data-theme` 只用于色相偏移的暗色变体（midnight/forest/plum/amber）
- Light 主题：**移除 `.dark`**，**不设置 `data-theme`**
- Milkdown 编辑器颜色覆盖在 `index.css` 中手动维护

### 3.3 图谱 Sigma.js 重挂载
- `graph-view.tsx` 使用 `sigmaKey` state
- 当面板 resize/切换时递增 `sigmaKey`，强制 Sigma 重新挂载
- 防止 WebGL crash：`"could not find suitable program for node type circle"`

### 3.4 Review Item ID 生成
```ts
let counter = 0  // 模块级别
type: "review", id: `review-${++counter}`
```
- 开发/HMR 时 counter 会重置，可能导致重复 ID
- 生产构建安全（counter 只初始化一次）

### 3.5 自动摄入（Auto Ingest）
- `src/lib/ingest.ts` 中的 `autoIngest()` 是核心流程
- 耗时操作通过 `ingest-queue.ts` 队列串行处理
- `writeFileBlocks` 解析 `---FILE: path---` 格式的 LLM 输出并直接写入文件

### 3.6 Wiki 目录结构
- 输出目录使用**中文命名**：`wiki/股票/`、`wiki/概念/`、`wiki/查询/`、`wiki/日志/`
- 不创建英文目录

---

## 四、技术债务

| 优先级 | 问题 | 位置 | 说明 |
|--------|------|------|------|
| 🔴 高 | `readFile` 语义混乱 | `src-tauri/src/commands/fs.rs:49-59` | 文件不存在应返回 `Err`，而不是返回伪造的 binary 字符串。前端已有代码依赖此行为，修改需全局检查 |
| 🟡 中 | Review 面板 stale closure | `review-view.tsx` | 已用 `key` 修复缓解，但底层仍依赖模块级 counter。建议改为 store 生成唯一 ID |
| 🟡 中 | 动态导入无效 | 多个文件 | Vite 警告：`project-store.ts`、`search.ts`、`ingest-queue.ts` 同时被静态和动态导入，代码分割不生效 |
| 🟢 低 | Rust 编译警告 | `fs.rs`, `clip_server.rs` | 8 个 warnings（unused variables, irrefutable let patterns, dead code）不影响功能 |
| 🟢 低 | Bundle 体积 | `index-BkvbXDoD.js` | 2.3 MB（gzip 720 KB），可进一步优化代码分割 |
| 🟢 低 | bundle identifier | `tauri.conf.json` | 以 `.app` 结尾，macOS 会有警告 |

---

## 五、待办事项（下一步建议）

### 5.1 高优先级
1. **修复 `readFile` 语义** — 这是最脏的技术债
   - 方案 A：新增 `fileExists(path)` Rust 命令，前端逐步替换 `try-catch` 模式
   - 方案 B：修改 `readFile` 在文件不存在时返回 `Err`，但需全局搜索所有 `readFile` 调用

2. **Review 面板稳健性**
   - Review item ID 改用 store 生成（类似 `crypto.randomUUID()` 或递增 store 计数器）
   - 彻底解决 HMR/重复 ID 导致的 stale closure 风险

### 5.2 中优先级
3. **向量语义搜索**（用户曾经提过）
   - 当前是关键词搜索，用户希望加 embedding-based 语义搜索
   - 已有 `src/lib/embedding.ts`，但未接入搜索流程

4. **移动端适配**
   - 当前桌面端为主，用户可能希望在平板/手机上查看

### 5.3 低优先级
5. **主题系统扩展**
   - 当前 light 主题是手动覆盖，可考虑用 CSS 变量系统化
   - 支持跟随系统主题（`prefers-color-scheme`）

6. **构建优化**
   - 修复动态导入警告，真正实现代码分割
   - 减小主 bundle 体积

---

## 六、发布流程速查

```bash
# 1. 更新版本号（4 个文件）
#    package.json, Cargo.toml, tauri.conf.json, README.md, README_CN.md

# 2. 更新 CHANGELOG.md（中文，顶部添加新版本）

# 3. 测试
npx tsc --noEmit
npx vitest run

# 4. 构建
npx tauri build          # 约 12-15 分钟（Rust release 编译慢）

# 5. Git 提交 + 标签
git add -A
git commit -m "release vX.Y.Z: 描述"
git tag vX.Y.Z
git push origin main --follow-tags
# 或分开：git push origin main; git push origin vX.Y.Z

# 6. GitHub Release
#    - 创建 Release，关联 tag
#    - 上传 MSI + NSIS 安装包
#    MSI: src-tauri/target/release/bundle/msi/*.msi
#    NSIS: src-tauri/target/release/bundle/nsis/*.exe
```

---

## 七、关键文件速查

| 文件 | 作用 |
|------|------|
| `src-tauri/src/commands/fs.rs` | Rust 文件读写核心，**readFile 行为特殊** |
| `src/lib/ingest.ts` | Auto-ingest 核心（LLM → 文件写入） |
| `src/lib/ingest-queue.ts` | 摄入队列（串行、可取消） |
| `src/stores/wiki-store.ts` | 全局状态（主题、项目路径、页面列表） |
| `src/stores/activity-store.ts` | 活动/队列状态 |
| `src/components/graph/graph-view.tsx` | Sigma.js 图谱 |
| `src/components/chat/chat-message.tsx` | 聊天消息 + Save to Wiki |
| `src/components/review/review-view.tsx` | Review 面板 |
| `src/lib/deep-research.ts` | Deep Research 逻辑 |
| `src/lib/search.ts` | 搜索逻辑 |
| `index.css` | 全局样式 + Milkdown 主题覆盖 |
| `types/theme.ts` | 主题预设定义 |

---

## 八、最后的话

Claude，以下是你最需要记住的三件事：

1. **`readFile` 不抛异常，返回假 binary 字符串** — 所有文件存在性检测必须用 `listDirectory`，这是最容易踩的坑。

2. **主题切换靠 `.dark` class，不是 `data-theme`** — Light 主题 = 移除 `.dark`，不碰 `data-theme`。

3. **构建很慢（12-15 分钟）** — 需要耐心，或提前在后台运行。

项目规范详见 `CLAUDE.md`，技术债务和待办在上面第 3-5 节。杰哥是个有多年 A 股实战经验的交易者，界面要中文，生成的 Wiki 要有交易视角。

祝顺利！
