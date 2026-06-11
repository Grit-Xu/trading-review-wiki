use std::fs;
use std::path::Path;

use chrono::Local;

use crate::types::wiki::WikiProject;

#[tauri::command]
pub fn create_project(name: String, path: String) -> Result<WikiProject, String> {
    let root = Path::new(&path).join(&name);

    if root.exists() {
        return Err(format!("Directory already exists: '{}'", root.display()));
    }

    // Create all required subdirectories
    // Note: type-specific wiki subdirs are created by templates (e.g. wiki/股票/, wiki/策略/).
    // We only create the base structure here to avoid English/Chinese directory duplication.
    let dirs = [
        "raw/sources",
        "raw/assets",
        "wiki",
    ];
    for dir in &dirs {
        fs::create_dir_all(root.join(dir))
            .map_err(|e| format!("Failed to create directory '{}': {}", dir, e))?;
    }

    let today = Local::now().format("%Y-%m-%d").to_string();

    // schema.md
    let schema_content = format!(
        r#"# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
| 股票 | wiki/股票/ | 个股分析页面 |
| 策略 | wiki/策略/ | 交易策略 |
| 模式 | wiki/模式/ | 市场模式与资金行为 |
| 错误 | wiki/错误/ | 交易错误与教训 |
| 市场环境 | wiki/市场环境/ | 市场环境分析 |
| 进化 | wiki/进化/ | 交易能力跃迁记录 |
| 预测 | wiki/预测/ | 预测与验证 |
| 概念 | wiki/概念/ | 抽象概念与理论 |
| 原始资料 | wiki/原始资料/ | 导入的外部资料 |
| 问题 | wiki/问题/ | 待研究的问题 |
| 对比 | wiki/对比/ | 对比分析 |
| 综合 | wiki/综合/ | 跨主题综合总结 |

## Naming Conventions

- Files: `中文名称.md` or meaningful slugs
- 个股: 使用股票名称 (e.g., `贵州茅台.md`)
- 策略: 描述性命名 (e.g., `龙头首阴战法.md`)
- 资料来源: `日期-来源-标题.md`

## Frontmatter

All pages must include YAML frontmatter:

```yaml
---
type: 股票 | 策略 | 模式 | 错误 | 市场环境 | 进化 | 预测 | 概念 | 原始资料 | 问题 | 对比 | 综合 | overview
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

## Index Format

`wiki/index.md` lists all pages grouped by type. Each entry:
```
- [[page-slug]] — one-line description
```

## Log Format

`wiki/log.md` records research activity in reverse chronological order:
```
## YYYY-MM-DD

- Action taken / finding noted
```

## Cross-referencing Rules

- Use `[[page-slug]]` syntax to link between wiki pages
- Every entity and concept should appear in `wiki/index.md`
- Queries link to the sources and concepts they draw on
- Synthesis pages cite all contributing sources via `related:`

## Contradiction Handling

When sources contradict each other:
1. Note the contradiction in the relevant concept or entity page
2. Create or update a query page to track the open question
3. Link both sources from the query page
4. Resolve in a synthesis page once sufficient evidence exists
"#
    );
    write_file_inner(root.join("schema.md"), &schema_content)?;

    // purpose.md
    let purpose_content = r#"# Project Purpose

## Goal

<!-- What are you trying to understand or build? -->

## Key Questions

<!-- List the primary questions driving this research -->

1.
2.
3.

## Scope

<!-- What is in scope? What is explicitly out of scope? -->

**In scope:**
-

**Out of scope:**
-

## Thesis

<!-- Your current working hypothesis or conclusion (update as research progresses) -->

> TBD
"#;
    write_file_inner(root.join("purpose.md"), purpose_content)?;

    // wiki/index.md
    let index_content = r#"# Wiki Index

## 股票

## 策略

## 模式

## 错误

## 市场环境

## 进化

## 预测

## 概念

## 原始资料

## 问题

## 对比

## 综合
"#;
    write_file_inner(root.join("wiki/index.md"), index_content)?;

    // wiki/log.md
    let log_content = format!(
        r#"# Research Log

## {today}

- Project created
"#
    );
    write_file_inner(root.join("wiki/log.md"), &log_content)?;

    // wiki/overview.md
    let overview_content = r#"---
type: overview
title: Project Overview
tags: []
related: []
---

# Overview

<!-- Provide a high-level summary of what this wiki covers and its current state. Update regularly as understanding deepens. -->
"#;
    write_file_inner(root.join("wiki/overview.md"), overview_content)?;

    // .obsidian config for Obsidian compatibility
    fs::create_dir_all(root.join(".obsidian"))
        .map_err(|e| format!("Failed to create .obsidian: {}", e))?;

    // Obsidian app config: set attachment folder, exclude hidden dirs
    let obsidian_app_config = r#"{
  "attachmentFolderPath": "raw/assets",
  "userIgnoreFilters": [
    ".cache",
    ".llm-wiki",
    ".superpowers"
  ],
  "useMarkdownLinks": false,
  "newLinkFormat": "shortest",
  "showUnsupportedFiles": false
}"#;
    write_file_inner(root.join(".obsidian/app.json"), obsidian_app_config)?;

    // Obsidian appearance: dark mode
    let obsidian_appearance = r#"{
  "baseFontSize": 16,
  "theme": "obsidian"
}"#;
    write_file_inner(root.join(".obsidian/appearance.json"), obsidian_appearance)?;

    // Enable graph view and backlinks core plugins
    let obsidian_core_plugins = r#"{
  "file-explorer": true,
  "global-search": true,
  "graph": true,
  "backlink": true,
  "tag-pane": true,
  "page-preview": true,
  "outgoing-link": true,
  "starred": true
}"#;
    write_file_inner(root.join(".obsidian/core-plugins.json"), obsidian_core_plugins)?;

    Ok(WikiProject {
        name,
        path: root.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn open_project(path: String) -> Result<WikiProject, String> {
    let root = Path::new(&path);

    if !root.exists() {
        return Err(format!("Path does not exist: '{}'", path));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: '{}'", path));
    }

    // Validate that this looks like a wiki project
    if !root.join("schema.md").exists() {
        return Err(format!(
            "Not a valid wiki project (missing schema.md): '{}'",
            path
        ));
    }
    if !root.join("wiki").is_dir() {
        return Err(format!(
            "Not a valid wiki project (missing wiki/ directory): '{}'",
            path
        ));
    }

    // Derive project name from the directory name
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();

    Ok(WikiProject { name, path })
}

fn write_file_inner(path: std::path::PathBuf, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dirs for '{}': {}", path.display(), e))?;
    }
    fs::write(&path, contents)
        .map_err(|e| format!("Failed to write file '{}': {}", path.display(), e))
}
