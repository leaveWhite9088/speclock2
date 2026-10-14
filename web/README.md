# SpecLock 2 · 前端（web/）

M1-S0 单页骨架：Vue 3（Composition API + `<script setup>`）+ Vite + TypeScript。
**不引入** vue-router / UI 组件库 / 状态管理库；样式为手写 CSS，设计令牌集中在 `src/styles/tokens.css`。

布局对应 DESIGN.md §15.1：顶栏（品牌 / 项目切换器 / 队列·仪表盘·约定·代理入口）+
左栏抽屉组（模块全景 / 版本链 / 规则违反榜 / 全局约定）+ 中栏轮次时间线 + 右栏可折叠任务包面板。
全程单页，无路由跳转。

## 环境要求

- Node ≥ 22（本工程在 Node 24 / npm 11 下验证）
- 后端（可选）：仓库根 `backend/`，默认 `http://127.0.0.1:8000`

## 安装与运行（Windows + Git Bash）

```bash
cd web
npm install
npm run dev
# 浏览器打开 http://127.0.0.1:5173
```

## mock / live 双模式

启动时探测 `GET /api/health`（经 Vite 代理转发到后端）：

- **后端不可达** → 自动切 mock：顶栏显示 `MOCK` 徽标。内置两个项目（日报系统 / 费用报销）；
  「日报系统」时间线渲染轮次 #12，内含一张待批准审批卡（数据照 DESIGN.md §8.1 示例）；
  左栏模块全景显示 mock 树。
- **后端可用** → live：顶栏显示 `LIVE` 徽标，项目列表来自 `GET /api/projects`，
  模块全景来自 `GET /api/p/{slug}/tree`；时间线数据自 S3 切片
  （`GET /api/p/{slug}/rounds/{n}`）接入，此前显示占位说明。

## 构建与类型检查

```bash
npm run build     # vue-tsc 类型检查 + vite build
npm run preview   # 本地预览构建产物（无 /api 代理，通常处于 MOCK 模式）
```

## 开发代理

`vite.config.ts` 已配置 `/api` → `http://127.0.0.1:8000`（DEV-PLAN.md §2 通用约定）。

## 目录结构

```
src/
├── api/
│   ├── client.ts   # 契约 v0（DEV-PLAN.md §2）全端点：类型定义 + 调用函数（live 客户端）
│   └── mock.ts     # mock 客户端与 fixtures（两个项目 + 轮次 #12 待批准卡片）
├── components/
│   ├── TopBar.vue            # 顶栏：品牌 / 模式徽标 / 项目切换器 / 四个入口
│   ├── PlaceholderPanel.vue  # 入口的占位面板
│   ├── LeftRail.vue          # 左栏抽屉组
│   ├── DrawerSection.vue     # 通用折叠抽屉
│   ├── RightRail.vue         # 右栏：当前任务包状态（可折叠，占位）
│   ├── RoundTimeline.vue     # 中栏：轮次时间线（自底向上）
│   ├── RoundCard.vue         # 轮次卡（含子卡片槽位）
│   ├── ApprovalCard.vue      # 审批卡片（DESIGN.md §8.1）
│   ├── DispatchCard.vue      # 派发卡（骨架）
│   ├── ReceiptCard.vue       # 回执卡（骨架）
│   └── VerdictCard.vue       # 裁决卡（骨架）
├── styles/
│   ├── tokens.css  # 设计令牌（颜色 / 字体 / 字号 / 间距 / 圆角 / 阴影）
│   └── base.css    # 基础样式与通用原语（徽标 / 按钮 / ops 行 / 子卡片）
├── types.ts        # 前端展示层共享类型（时间线骨架、面板 key）
├── App.vue         # 单页壳：模式探测、项目切换、三栏编排
└── main.ts
```
