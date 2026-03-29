# Skills 使用指南

## 1. 什么是 Skill

**Skill** 是一段预先编写好的任务指令，存储为工作区文件后，AI 助手可以在对话中自动识别并加载它。

你可以把 Skill 理解为"为 AI 定制的操作手册"：当你提出某类请求时，AI 会自动找到对应的 Skill，按照其中的步骤和规范来完成任务，而不是每次都从零开始摸索。

**与普通对话的区别：**

- 普通对话中你需要每次重复说明要求和规范
- 启用 Skill 后，AI 会自动读取指令，行为始终一致、可复现

**Skill 的典型用途：**

- 让 AI 按固定格式写日报、周报
- 让 AI 按照你团队的代码审查标准检查代码
- 让 AI 用特定模板起草合同、邮件
- 让 AI 遵循特定工作流处理数据

---

## 2. 在哪里管理 Skills

打开扩展的设置页面（Options）→ 左侧导航选择 **Agent** 分组 → 点击 **Skills**。

如果你在管理某个特定 Agent 的 Skills，进入 **Agent** 分组 → **Agents** → 选择一个 Agent → 切换到 **Skills** 子标签。

---

## 3. 内置 Skills

ULCopilot 预置了 3 个 Skill，默认处于禁用状态。你可以在设置页面将它们启用：

### Daily Journal（每日日记）

**触发时机：** 当你让 AI 创建或更新日记条目时

AI 会在工作区的 `memory/YYYY-MM-DD.md` 文件中维护结构化日记，固定包含以下版块：
- **Summary**：当天要点摘要
- **Decisions**：做出的决策
- **Learnings**：新的学习与洞察
- **Action Items**：待办事项
- **Notes**：其他值得记录的内容

### Skill Creator（技能创建助手）

**触发时机：** 当你让 AI 帮你创建或修改 Skill 时

启用后，AI 会按照最佳实践引导你完成 Skill 的设计与编写，并直接将文件保存到工作区。这是创建自定义 Skill 的**推荐方式**。

### Tool Creator（工具创建助手）

**触发时机：** 当你让 AI 帮你创建自定义工具时

AI 会通过 `execute_javascript` 将 JavaScript 代码注册为可调用工具，扩展助手的能力边界。

---

## 4. 启用与禁用 Skill

在 Skills 管理页面，每个 Skill 右侧有一个开关：

- **开启**：该 Skill 的名称和描述会出现在 AI 的系统提示中，AI 下次对话时即可感知并使用
- **关闭**：AI 的系统提示中不包含该 Skill，不影响对话但也不会触发

开关操作**立即生效**，无需刷新或重启扩展。

---

## 5. Skill 的工作原理

Skill 采用 3 级懒加载设计，兼顾上下文效率与触发精度：

```
第 1 级（始终在上下文中）
  └─ AI 在每次对话时只能看到 Skill 的 name 和 description
     token 消耗极低

第 2 级（匹配后加载）
  └─ AI 判断某条 Skill 的 description 与当前请求匹配
     → 调用 read 工具读取完整 SKILL.md
     → 按照正文中的步骤执行

第 3 级（按需加载）
  └─ SKILL.md 中可以引用其他文件
     → AI 在需要时按需读取（适合大型参考资料）
```

**关键点：** `description` 字段是 AI 判断是否触发 Skill 的**唯一依据**。一条好的 description 应同时说明"这个 Skill 做什么"和"什么情况下用它"。

---

## 6. 创建自定义 Skill

### 方式一：让 AI 帮你创建（推荐）

1. 在 Skills 页面启用 **Skill Creator**
2. 在对话中说：`帮我创建一个 Skill，用于……`
3. AI 会询问几个关键问题，然后自动生成 SKILL.md 并保存到工作区

**示例提示：**
> 帮我创建一个 Skill，每次我说"写周报"时，AI 按固定格式总结本周工作，包括：完成事项、进行中的任务、下周计划、遇到的问题。

### 方式二：手动编写

Skill 文件是一个带有 YAML frontmatter 的 Markdown 文件，遵循以下路径约定：

```
skills/{kebab-case-name}/SKILL.md
```

例如：`skills/weekly-report/SKILL.md`

#### 文件格式

```markdown
---
name: Weekly Report
description: Write a structured weekly work report. Use when the user asks to write
  a weekly report, summarize this week's work, or create a work summary.
---

# 周报撰写指南

当用户要求写周报时，按以下结构组织内容：

## 结构

1. **本周完成事项**
   - 按重要性排序，每项用一句话说明
   - 注明完成度（完成 / 部分完成）

2. **进行中的任务**
   - 列出正在推进的项目，附进度百分比

3. **下周计划**
   - 3-5 项，优先级由高到低

4. **问题与风险**
   - 若无则省略此项

## 格式要求

- 使用 Markdown 格式
- 标题用 `##`，列表用 `-`
- 语言简练，避免口水话
```

#### Frontmatter 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | Skill 的显示名称，出现在设置列表和 AI 的系统提示中 |
| `description` | 是 | **触发机制**，AI 根据此判断是否加载该 Skill（见下文） |
| `disable-model-invocation` | 否 | `true` = 不注入 AI 系统提示，AI 不可见（默认 `false`） |
| `user-invocable` | 否 | `false` = 不在 UI 中允许用户手动触发（默认 `true`） |

#### description 字段的写法

`description` 是 Skill 唯一的触发机制，需要同时包含：

- **是什么**：这个 Skill 的功能
- **什么时候用**：具体触发条件

**差的写法：**
```yaml
description: 帮助写文档
```

**好的写法：**
```yaml
description: Write structured weekly work reports. Use when the user asks to write
  a weekly report, summarize this week's work, or draft a work summary.
```

好的 description 应该足够具体，让 AI 在"用户请求写周报"与"用户请求写月报"之间能做出正确区分。

#### description 多行写法

当 description 较长时，可以用缩进续行（YAML 多行字符串）：

```yaml
description: Create or update ULCopilot skills. Use when the user wants to design,
  build, edit, or improve a skill, or when asked to make a reusable prompt template
  for a specific task or domain.
```

#### 拆分大型 Skill（引用文件）

如果 Skill 需要携带大量参考内容（如数据字典、长格式模板），可以拆分为主文件 + 引用文件：

```
skills/data-analysis/SKILL.md          # 主文件（简洁的触发指令）
skills/data-analysis/references/
    schema.md                           # 字段字典
    chart-templates.md                  # 图表模板
```

在 SKILL.md 正文中引用：

```markdown
对于字段定义，读取 `skills/data-analysis/references/schema.md`。
```

> **注意**：只有 `skills/{name}/SKILL.md` 会被识别为 Skill 入口，引用文件是普通工作区文件，AI 按需读取。

---

## 7. 导入 Skill（ZIP 包）

你可以将 Skill 打包为 ZIP 文件分享给他人，或从他人处导入。

### 导入步骤

1. 在 Skills 设置页面点击 **Import ZIP**
2. 选择 `.zip` 文件（大小限制：1 MB）
3. 导入成功后，新 Skill 出现在列表中，默认禁用状态
4. 手动开启开关即可启用

### ZIP 包格式要求

- ZIP 内必须包含**且仅包含一个** `SKILL.md` 文件
- `SKILL.md` 必须有合法的 frontmatter（含 `name` 和 `description`）
- 其他引用文件可以一并打包，保持相对路径

**推荐的 ZIP 目录结构：**

```
my-skill.zip
└── my-skill/
    ├── SKILL.md
    └── references/
        └── data.md
```

Skill 目录名（`my-skill`）会被用作工作区中的路径名。若 ZIP 没有顶层目录，系统会根据 frontmatter `name` 自动生成 kebab-case 目录名。

---

## 8. Agent 作用域

Skills 支持全局和 Agent 专属两种作用域：

| 类型 | 说明 |
|------|------|
| **全局 Skill** | 在 Settings → Agent → Skills 页面管理，所有 Agent 共享 |
| **Agent 专属 Skill** | 在某个 Agent 的 Skills 子标签中管理，仅该 Agent 可见 |

**覆盖规则：** 在 Agent 的 Skills 视图中操作全局 Skill 时，系统会为该 Agent 创建一个独立副本，修改不影响全局记录。这样你可以为不同 Agent 定制相同 Skill 的不同版本，也可以在某个 Agent 中禁用全局已启用的 Skill。

**新建 Agent 时：** 系统会自动将所有全局 Skill 复制一份给新 Agent，初始状态与全局保持一致。

---

## 9. 完整示例：创建一个代码审查 Skill

以下是一个实际可用的代码审查 Skill，可直接复制到工作区文件 `skills/code-review/SKILL.md`：

```markdown
---
name: Code Review
description: Review code for quality, bugs, and style issues. Use when the user asks
  to review code, check a pull request, or audit code quality.
---

# Code Review

当用户提交代码或 PR 进行审查时，按以下维度逐一检查：

## 检查维度

### 1. 正确性
- 逻辑是否存在错误或边界条件遗漏？
- 错误处理是否完整？
- 并发/异步场景是否安全？

### 2. 可读性
- 变量和函数命名是否清晰？
- 复杂逻辑是否有必要的注释？
- 函数是否单一职责？

### 3. 性能
- 是否有明显的性能瓶颈（N+1 查询、不必要的循环等）？
- 数据结构选择是否合适？

### 4. 安全性
- 用户输入是否经过校验？
- 是否存在注入风险或权限漏洞？

## 输出格式

用 Markdown 分节输出，每个问题注明：
- **位置**：文件名 + 行号
- **严重程度**：🔴 严重 / 🟡 建议 / 🟢 可选
- **问题描述**：简明说明问题所在
- **修改建议**：给出具体的改进方向或示例代码

若代码质量良好，在结尾注明 "✅ 未发现显著问题"。
```

**启用方式：**

1. 通过 AI 工具将上述内容写入工作区（或手动在文件管理器中创建）
2. 在 Settings → Agent → Skills 中找到 **Code Review**，开启开关
3. 在对话中说"帮我审查这段代码"，AI 会自动加载该 Skill

---

## 10. 常见问题

**Q：启用了 Skill 但 AI 没有按照它执行？**

1. 检查 `description` 字段是否足够具体——它必须清晰描述"什么情况下使用"
2. 确认 Skill 在设置中已开启（开关为绿色）
3. 检查 frontmatter 格式是否正确：`---` 包裹，`name` 和 `description` 都存在
4. 如果使用的是轻量级本地模型，Skills 功能可能被关闭（minimal 模式不注入 Skills）

**Q：description 只能用英文写吗？**

不是。中文 description 同样有效，只需清晰描述触发条件即可。不过如果 AI 使用英文交互，建议 description 也用英文，匹配效果更稳定。

**Q：Skill 和 workspace 文件（如 USER.md、SOUL.md）有什么区别？**

workspace 文件在每次对话时**全文注入**系统提示；Skill 只注入元数据（name + description），正文在 AI 判断匹配后才读取。因此 Skill 更适合体积较大、仅在特定场景需要的指令内容。

**Q：内置的 3 个 Skill 能删除吗？**

不能删除，但可以禁用。内置 Skill 标记为 `predefined`，系统不允许删除，以保证基础功能完整。你可以随时关闭开关将其隐藏。

**Q：多个 Skill 同时启用，AI 会怎么选择？**

AI 每次回复前扫描所有启用 Skill 的 `description`，选择**最匹配**当前请求的那一个（最多一个），然后读取其完整内容。如果没有明确匹配的 Skill，则不加载任何 Skill，正常回复。

**Q：自定义 Skill 文件名有什么限制？**

目录名（`skills/` 后的部分）只能使用小写字母、数字和连字符，例如 `my-skill`、`code-review`、`data-analysis`。主文件名必须是 `SKILL.md`（大小写均可）。
