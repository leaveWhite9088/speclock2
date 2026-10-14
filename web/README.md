# SpecLock 2 · 前端（web/）

M1 单页应用：Vue 3（Composition API + `<script setup>`）+ Vite + TypeScript。
**不引入** vue-router / UI 组件库 / 状态管理库；样式手写 CSS（设计令牌 `src/styles/tokens.css`）。

**界面形态（Kimi Code 风格的聊天工作台）：**

- **左侧栏**：上半是项目列表（项目一切换 = 换工作区）；下半是当前项目的代理——
  **核心代理**（原"主主代理"：需求澄清、提案起草、汇报与决策支持，平时只看它）+
  自建**主代理**（每个都写清职责，可随时添加）；
- **主区 = 聊天框**：
  - **核心代理会话**：口语化对话与汇报（干完了什么、改了哪些文件、验收结果），
    审批卡片内联呈现（批准/打回），底部输入框（M1 占位）+「起草卡片」「技术任务单」；
  - **主代理工作流**（点左侧主代理进入）：工具调用、文件编辑（+N −M）、思考耗时等过程流——
    核心 ↔ 主代理的通信细节收在这里，默认不打扰主对话；
- **右上角抽屉**：**查看版本**（每次批准生成一个版本，点开看当时那份 API 契约与业务规则快照）、
  **队列**（任务包排队，一键开始——包内并行、包间串行；mock 模拟执行）、
  文档（模块全景树+草稿）、约定、统计；
- 视觉：中性灰阶 + 近黑主色，仅 成功绿/危险红 两个语义色，无阴影无动效。

已实现切片：S0 骨架 / S1 文档系统（树+草稿）/ S2 chat-first + M1 收尾（契约 v0.2 全端点）/
**本次改版**（用户直述需求：左侧项目+代理栏、核心代理对话、主代理过程流、版本与队列右侧栏）。

## 环境要求

- Node ≥ 22（本工程在 Node 24 / npm 11 下验证）
- 后端（可选）：仓库根 `backend/`，默认 `http://127.0.0.1:8000`

## 安装与运行（Windows + Git Bash）

```bash
cd web
npm install
npm run dev
# 浏览器打开 http://127.0.0.1:5173（端口被占时 Vite 自动顺延）
```

## mock / live 双模式

启动时探测 `GET /api/health`（经 Vite 代理转发到后端）：

- **后端不可达** → 自动切 mock（侧栏底部 MOCK 徽标）：内置两个项目与完整"迷你账本"，
  起草/批准/版本/队列一键开始（模拟执行+过程流）/约定/统计全部可演示；
- **后端可用** → LIVE：走契约 v0.2 真实端点。主代理列表、版本快照详情、队列一键开始
  属 R-M2 前的前端承载（mock 实现；live 缺端点时优雅降级）。

## 构建与类型检查

```bash
npm run build     # vue-tsc 类型检查 + vite build
npm run preview   # 预览构建产物（继承 /api 代理；后端在跑则为 LIVE）
```

## 目录结构

```
src/
├── api/
│   ├── client.ts   # 契约 v0.2 全端点 + masters/版本快照/queue-start（提议端点）
│   └── mock.ts     # mock 客户端：迷你账本状态机 + 主代理注册 + 过程流 + 队列模拟
├── components/
│   ├── Sidebar.vue            # 左侧栏：项目列表 + 核心代理/主代理（职责+创建）
│   ├── TopBar.vue             # 顶栏：当前会话标题 + 右侧抽屉入口
│   ├── CoreChat.vue           # 核心代理会话：口语化汇报 + 内联审批卡 + 底部输入栏
│   ├── MasterSession.vue      # 主代理工作流：任务 + 思考/工具/文件编辑过程流
│   ├── ApprovalCard.vue       # 审批卡片（§8.1；批准/打回）
│   ├── CardComposer.vue       # 起草卡片表单（模块/statement/rule_ops/api_ops）
│   ├── TechOrderComposer.vue  # 技术任务单建单表单
│   ├── RightDrawer.vue        # 右侧抽屉壳
│   ├── VersionPanel.vue       # 查看版本：版本列表 → 当时 API/业务快照详情
│   ├── QueuePanel.vue         # 队列：一键开始（包内并行·包间串行）
│   ├── PackageList.vue        # 任务包列表（队列共用）
│   ├── TaskRow.vue            # 任务行：状态徽标 + 派发/回执/审计
│   ├── DocsPanel.vue / ModuleTree.vue / DraftViewer.vue / ApiFieldList.vue  # 文档抽屉
│   ├── ConventionPanel.vue    # 约定：查看/草稿/批准
│   ├── DashboardPanel.vue     # 统计计数卡
│   ├── ModalShell.vue / RoundDivider.vue / DrawerSection.vue
├── styles/          # tokens.css（令牌）+ base.css（原语）
├── types.ts         # 会话/抽屉/过程流/轮次分段 等展示层类型
├── App.vue          # 编排：探测、项目/会话切换、抽屉、全部动作、mock 轮询
└── main.ts
```
