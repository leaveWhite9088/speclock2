# SpecLock 2 · 前端（web/）

M1 单页应用：Vue 3（Composition API + `<script setup>`）+ Vite + TypeScript。
**不引入** vue-router / UI 组件库 / 状态管理库；样式为手写 CSS，设计令牌集中在 `src/styles/tokens.css`。

**chat-first 形态**（DESIGN.md §15.1）：中央对话流是绝对主体（自上而下滚动、底部固定输入框），
轮次 = 对话流中的分段线（`┈┈ 轮次 #12 · 进行中 ┈┈`），审批/派发/回执/裁决卡片内联挂在所属轮次下方；
左右功能面板整体可折叠，把宽度让给对话。全程单页，无路由跳转。

已实现切片：

- **S0 骨架**：单页壳、API 层、mock/live 双模式探测（MOCK/LIVE 徽标）；
- **S1 文档系统**：模块全景三层树（业务域→文档→模块，草稿/版本徽标）、新建流、只读草稿四件套查看；
- **S2 chat-first + M1 收尾**（契约 v0.2）：
  - 起草卡片表单（选模块 / statement 说明+动机 / rule_ops+api_ops 增删改编辑）→ 卡片以 §8.1 样式内联到当前轮次（破坏性强制展开，L2 默认折叠计数）；
  - 批准 / 打回 → 卡片态变化、轮次分段线推进（旧轮关闭、新轮开启）、版本链面板 +1、任务包入队；
  - 任务包面板（右栏，可折叠）：8 态任务徽标（timeout 标红）、模拟派发（可填看门狗分钟数，0 分钟可即时演示超时）、回执表单（files_changed/self_check/summary）、审计按钮（pass/fail）；
  - 技术任务单建单（intent/scope/baseline/acceptance，DESIGN §6.4）→ origin=tech 任务包；
  - 全局约定面板：查看当前版 / 编辑草稿 / 批准（说明+动机）；
  - 仪表盘：GET /stats 计数卡；代理面板含「直达会话」占位按钮（R-M2 接入）；
  - 顶栏：项目切换器、会话切换器占位（会话：主主代理 ▾）、队列/仪表盘/约定/代理入口；
  - 底部输入框 M1 占位（"主主代理将于接入轮上线"），旁边「起草卡片」「技术任务单」两个入口。

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

- **后端不可达** → 自动切 mock：顶栏显示 `MOCK` 徽标。内置两个项目（日报系统 / 费用报销），
  含完整"迷你账本"状态机：轮次 #11（已关闭：已批准卡片 + 已完成任务包 + 回执/裁决卡）与
  轮次 #12（进行中：§8.1 示例的待批准卡片）；起草/批准/派发/回执/审计/超时/技术单/约定/统计全部可演示；
- **后端可用** → live：顶栏显示 `LIVE` 徽标，全部数据走契约 v0.2 真实端点。
  若后端尚未实现 S2 端点（轮次/卡片/包等），对话流会显示行内说明（不崩溃）。

## 构建与类型检查

```bash
npm run build     # vue-tsc 类型检查 + vite build
npm run preview   # 本地预览构建产物（继承 /api 代理；后端在跑则为 LIVE）
```

## 开发代理

`vite.config.ts` 已配置 `/api` → `http://127.0.0.1:8000`（DEV-PLAN.md §2 通用约定）。

## 目录结构

```
src/
├── api/
│   ├── client.ts   # 契约 v0.2 全端点：类型定义 + 调用函数（live 客户端）
│   └── mock.ts     # mock 客户端：fixtures + 迷你账本状态机（批准/轮次/semver/看门狗）
├── components/
│   ├── TopBar.vue            # 顶栏：品牌 / 模式徽标 / 项目切换 / 会话占位 / 四入口
│   ├── ChatStream.vue        # 中央对话流：轮次分段线 + 内联卡片
│   ├── RoundDivider.vue      # 轮次分段线（┈┈ 轮次 #N ┈┈）
│   ├── Composer.vue          # 底部输入栏（M1 禁用占位）+ 起草卡片 / 技术任务单入口
│   ├── ApprovalCard.vue      # 审批卡片（§8.1；批准/打回动作）
│   ├── DispatchCard.vue      # 派发卡（任务包：任务/主代理/状态/看门狗）
│   ├── ReceiptCard.vue       # 回执卡
│   ├── VerdictCard.vue       # 裁决卡（审计事件）
│   ├── CardComposer.vue      # 起草卡片表单（模块/statement/rule_ops/api_ops 编辑）
│   ├── TechOrderComposer.vue # 技术任务单建单表单
│   ├── LeftPanel.vue         # 左面板（可折叠）：模块全景/版本链/规则违反榜/全局约定
│   ├── ModuleTree.vue        # 模块全景树 + 新建流 + 草稿查看（S1 迁入）
│   ├── DraftViewer.vue       # 只读草稿四件套
│   ├── ApiFieldList.vue      # 契约字段递归清单
│   ├── VersionChain.vue      # 版本链视图（按轮次倒序）
│   ├── RightPanel.vue        # 右面板（可折叠）：当前任务包
│   ├── PackageList.vue       # 任务包列表（右栏与队列面板共用）
│   ├── TaskRow.vue           # 任务行：状态徽标 + 派发/回执/审计操作
│   ├── PanelShell.vue        # 顶栏入口面板壳
│   ├── ModalShell.vue        # 模态壳
│   ├── ConventionPanel.vue   # 全局约定：查看/草稿/批准
│   ├── DashboardPanel.vue    # 仪表盘（stats 计数卡）
│   ├── MastersPanel.vue      # 代理面板（含直达会话占位）
│   └── DrawerSection.vue     # 通用折叠抽屉
├── styles/
│   ├── tokens.css  # 设计令牌（颜色 / 字体 / 字号 / 间距 / 圆角 / 阴影）
│   └── base.css    # 基础样式与通用原语（徽标 / 按钮 / ops 行 / 子卡片 / 任务状态徽标）
├── types.ts        # 前端展示层共享类型（轮次分段 FeedRound / 面板 key / 状态文案）
├── App.vue         # 单页壳：模式探测、项目切换、chat-first 三区编排、全部动作
└── main.ts
```
