# MCP Design Review Server

基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 的设计方案评审工具，用于在 Claude Code 与用户之间建立「可视化设计评审 → 标注反馈 → 迭代修改」的闭环工作流。

---

## 项目概述

本服务是一个本地 MCP Server，让 Claude Code 能够将 HTML 设计方案输出到浏览器，用户在浏览器中对设计进行可视化标注和审查，意见自动回流给 Claude Code，从而实现：

> **需求讨论 → 生成设计方案 → 保存并打开评审页 → 用户标注反馈 → AI 修改方案 → 确认通过 → 开始写代码**

---

## 核心原理

### 双进程架构

服务启动后同时运行两个逻辑单元：

1. **MCP Server（stdio 通信）**
   - 通过标准输入输出与 Claude Code 进行 MCP 协议通信
   - 注册 7 个 Tools，供 Claude Code 调用

2. **HTTP Server（本地 Web 服务）**
   - 默认监听 `3456` 端口（若被占用则自动递增）
   - 提供浏览器评审页面（`src/reviewer.html`）
   - 提供 REST API 供评审页提交/查询标注数据

### 数据流

```
┌─────────────┐   save_design / start_review    ┌──────────────┐
│ Claude Code │  ─────────────────────────────→  │  MCP Server  │
│   (Agent)   │        (stdio / MCP 协议)         │  (server.js) │
└─────────────┘                                   └──────┬───────┘
      ↑                                                  │
      │    wait_for_annotations / get_annotations        │ 打开浏览器
      │  ←────────────────────────────────────────────── │
      │         (读取 sessions.json 中的标注数据)          │
      │                                                  ↓
      │                                         ┌────────────────┐
      │                                         │  Browser 评审页 │
      └──────────────────────────────────────── │ (reviewer.html)│
                标注数据写入 sessions.json      └────────────────┘
```

### 文件存储

- **设计方案**：保存在项目目录下的 `.claude/design-reviews/{name}.html`
- **会话状态**：保存在服务目录下的 `sessions.json`，包含每个评审会话的状态、标注列表、时间戳等

### 会话状态机

每个评审会话有三种状态：

- `pending`：等待用户标注（初始状态，获取标注后也重置为此状态以支持多轮评审）
- `has_annotations`：用户已提交标注，等待 Claude Code 读取
- `approved`：用户已确认设计通过，可进入代码实现阶段

---

## MCP Tools

| Tool | 功能说明 |
|---|---|
| `save_design` | 将设计方案 HTML 保存到指定项目的 `.claude/design-reviews/` 目录下 |
| `start_review` | 启动一个评审会话，自动打开浏览器评审页，等待用户反馈 |
| `check_status` | 查询指定会话的当前状态（pending / has_annotations / approved）|
| `get_annotations` | 获取用户已提交的标注列表；获取后会话状态重置为 pending，支持多轮迭代 |
| `wait_for_annotations` | **阻塞等待**：轮询会话状态，直到用户提交标注、确认通过或超时（默认 300 秒）|
| `approve_design` | 将指定会话标记为 approved，表示设计已确认通过 |
| `list_sessions` | 列出当前所有活跃的评审会话及其状态 |

---

## 评审页面功能

浏览器端评审页（`src/reviewer.html`）提供以下能力：

- **双栏布局**：左侧 iframe 渲染设计方案，右侧为标注管理面板
- **元素选取**：点击页面中的元素，自动提取 CSS Selector 与 XPath
- **四种意见类型**：修改建议 / 决策质疑 / 补充遗漏 / 正向确认
- **暂存模式**：可暂存多条标注，确认后批量提交
- **本地草稿**：`localStorage` 自动保存未提交的标注草稿，刷新页面不丢失
- **通过确认**：提供「确认通过」按钮，点击后通知 Claude Code 可以进入代码实现

---

## 安装

```bash
cd /Users/xueyandong/Desktop/0-XYD-Mac/5-Code/0-tools/mcp-design-review
npm install
```

---

## 配置到 Claude Code

Claude Code 通过 `~/.claude/mcp.json` 管理 MCP Server 配置。

编辑该文件，添加以下内容：

```json
{
  "mcpServers": {
    "design-review": {
      "command": "node",
      "args": ["/Users/xueyandong/Desktop/0-XYD-Mac/5-Code/0-tools/mcp-design-review/server.js"]
    }
  }
}
```

> 请将 `args` 中的路径替换为你本机实际的绝对路径。

配置完成后，重启 Claude Code（或重新加载 MCP 配置），Claude Code 会自动启动该服务并通过 stdio 与之通信。

---

## 怎么触发使用

该服务以 **Tools（工具）** 的形式暴露给 Claude Code，无需手动命令触发。当 Claude Code 判断当前场景需要使用设计评审能力时，会自动调用对应 Tool。

### 典型工作流示例

以下是一次完整的设计评审闭环：

1. **生成设计方案**：你向 Claude Code 描述需求，Claude Code 生成一份 HTML 设计方案
2. **保存设计**：Claude Code 调用 `save_design`，将方案保存到项目 `.claude/design-reviews/` 目录
3. **启动评审**：Claude Code 调用 `start_review`，服务自动打开浏览器评审页
4. **用户标注**：你在浏览器中查看设计，点击元素添加修改意见，批量提交
5. **等待反馈**：Claude Code 调用 `wait_for_annotations` 阻塞等待，直到你提交标注或点击「通过」
6. **获取意见**：Claude Code 读取标注内容，理解你的反馈
7. **迭代修改**：Claude Code 修改设计方案，重新 `save_design` + `start_review`，循环步骤 3-6
8. **确认通过**：你在浏览器中点击「确认通过」，状态变为 `approved`
9. **开始编码**：Claude Code 确认设计通过后，正式进入代码实现阶段

### 常见触发话术

在与 Claude Code 的对话中，你可以通过以下方式主动触发该服务：

- "帮我生成一个设计方案，我想在浏览器里评审一下"
- "先输出设计稿，我们走评审流程"
- "把当前方案保存为设计稿，打开评审页面"
- "这个设计我还没确认，打开评审页让我标注一下"
- "设计方案确认通过了，开始写代码吧"

Claude Code 会根据上下文自动调用 `save_design`、`start_review`、`wait_for_annotations`、`approve_design` 等工具完成协作。

---

## 目录结构

```
mcp-design-review/
├── server.js              # MCP Server + HTTP Server 主入口
├── src/
│   ├── reviewer.html      # 浏览器评审页面
│   └── template.html      # 设计方案 HTML 模板
├── sessions.json          # 持久化评审会话状态
├── package.json
└── README.md
```

---

## 依赖

- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — MCP 协议 SDK
- [`open`](https://www.npmjs.com/package/open) — 自动打开系统默认浏览器

---

## License

MIT
