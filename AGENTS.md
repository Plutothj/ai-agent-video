# AGENTS.md — waoowaoo 项目全景文档

> 本文档为大模型（LLM）理解本项目而编写，涵盖架构、模块、数据流、约定等全部关键信息。
> 阅读本文档后，应能独立定位代码、理解业务逻辑、进行开发或修复。

---

## 1. 项目概述

**项目名称**：waoowaoo（哇哦哇哦 AI 视频工作室）
**版本**：0.4.1
**许可证**：CC BY-NC-SA 4.0（非商业用途）
**仓库**：https://github.com/saturndec/waoowaoo

**一句话描述**：一款基于 AI 的短剧/漫画视频制作工具——用户输入小说文本，系统自动完成剧本分析、角色提取、场景生成、分镜制作、AI 配音，最终输出完整视频。

**核心功能**：
- AI 剧本分析：自动解析小说，提取角色、场景、剧情
- 角色 & 场景生成：AI 生成一致性人物和场景图片
- 分镜视频制作：自动生成分镜头并合成视频
- AI 配音：多角色语音合成（支持声音克隆和 TTS）
- 唇形同步：视频人物口型与语音对齐
- 视频编辑器：基于 Remotion 的时间线编辑器
- 全局素材库：跨项目复用角色、场景、声音资产
- 多语言支持：中文 / 英文界面，提示词双语模板

---

## 2. 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| **框架** | Next.js (App Router) + React | 15.x + 19.x |
| **语言** | TypeScript | 5.x |
| **数据库** | MySQL + Prisma ORM | 8.0 + 6.19 |
| **队列** | Redis + BullMQ | 7.x + 5.x |
| **对象存储** | MinIO (S3 兼容) | 最新 |
| **样式** | Tailwind CSS + PostCSS | v4 |
| **认证** | NextAuth.js (Credentials) | 4.x |
| **国际化** | next-intl | 4.7 |
| **视频合成** | Remotion | 4.x |
| **AI SDK** | @ai-sdk/google, @ai-sdk/openai, @google/genai, openai, @fal-ai/client, @openrouter/sdk | — |
| **测试** | Vitest + v8 coverage | 2.x |
| **Lint** | ESLint (flat config) | 9.x |
| **Git Hooks** | Husky (pre-commit, pre-push) | 9.x |
| **Node.js** | — | ≥ 22.14.0 |

---

## 3. 快速启动

### 方式一：Docker 预构建镜像（最简单）

```bash
curl -O https://raw.githubusercontent.com/saturndec/waoowaoo/main/docker-compose.yml
docker compose up -d
# 访问 http://localhost:13000
```

### 方式二：克隆 + Docker 构建

```bash
git clone https://github.com/saturndec/waoowaoo.git
cd waoowaoo
docker compose up -d
# 访问 http://localhost:13000
```

### 方式三：本地开发

```bash
git clone https://github.com/saturndec/waoowaoo.git
cd waoowaoo
cp .env.example .env   # 编辑 .env 填入 API Key
npm install
docker compose up mysql redis minio -d   # 启动基础设施
npx prisma db push                        # 初始化数据库（必须！）
npm run dev                               # 启动开发服务器
# 访问 http://localhost:3000
```

**npm run dev 同时启动 4 个进程**（通过 concurrently）：
1. `next dev --turbopack` — Next.js 开发服务器
2. `tsx watch src/lib/workers/index.ts` — BullMQ 后台 Worker
3. `tsx watch scripts/watchdog.ts` — 任务心跳监控
4. `tsx watch scripts/bull-board.ts` — 队列管理面板

---

## 4. 目录结构

```
ai-agent-video/
├── .env.example              # 环境变量模板
├── docker-compose.yml        # 4 服务编排：mysql, redis, minio, app
├── Dockerfile                # 多阶段构建
├── caddyfile                 # HTTPS 反向代理配置（可选）
├── package.json              # 项目配置，含 90+ scripts
├── tsconfig.json             # TypeScript 配置，@/* 别名指向 src/
├── next.config.ts            # Next.js 配置（集成 next-intl）
├── vitest.config.ts          # 测试配置
├── middleware.ts              # next-intl locale 路由中间件
│
├── prisma/                   # 数据库层
│   ├── schema.prisma         # 40+ 数据模型定义
│   └── migrations/           # SQL 迁移文件
│
├── lib/                      # 静态资源（非运行时代码）
│   └── prompts/              # AI 提示词模板（双语 .zh.txt / .en.txt）
│       ├── novel-promotion/  # 30+ 小说转视频流水线提示词
│       ├── character-reference/ # 角色参考图提示词
│       └── skills/           # API 配置教程提示词
│
├── messages/                 # i18n 翻译文件
│   ├── zh/                   # 中文（33 个 JSON 模块）
│   └── en/                   # 英文（33 个 JSON 模块）
│
├── standards/                # 能力目录 & 价格目录
│   ├── capabilities/         # image-video.catalog.json
│   └── pricing/              # image-video.pricing.json
│
├── scripts/                  # 构建、运维、Guard 脚本
│   ├── guards/               # 25+ 静态分析 Guard（架构守护）
│   ├── migrations/           # 数据迁移脚本
│   ├── watchdog.ts           # 任务心跳监控进程
│   └── bull-board.ts         # BullMQ 管理面板进程
│
├── tests/                    # 测试套件（200+ 测试文件）
│   ├── unit/                 # 单元测试
│   ├── integration/          # 集成测试（API、Provider、Chain、Task）
│   ├── system/               # 系统测试（端到端）
│   ├── regression/           # 回归测试
│   ├── concurrency/          # 并发测试（计费）
│   ├── contracts/            # 契约测试（需求矩阵）
│   ├── setup/                # 测试环境初始化
│   └── helpers/              # 测试工具（Fake LLM、Fake Media 等）
│
├── public/                   # 静态资源（logo、图标）
│
└── src/                      # 核心源码
    ├── app/                  # Next.js App Router
    │   ├── [locale]/         # 国际化页面路由
    │   │   ├── auth/         # 登录/注册
    │   │   ├── home/         # 首页
    │   │   ├── workspace/    # 工作区（项目列表 + 项目详情）
    │   │   ├── profile/      # 用户设置（API 配置、计费）
    │   │   └── dev/          # 开发测试页
    │   ├── api/              # 130+ API 路由
    │   └── m/[publicId]/     # 公开分享链接
    │
    ├── components/           # React 组件
    │   ├── ui/               # UI 基础组件（Glass 设计系统）
    │   │   ├── primitives/   # GlassSurface, GlassButton, GlassInput 等
    │   │   ├── patterns/     # PanelCardV2, StoryboardHeaderV2 等
    │   │   ├── config-modals/ # 配置弹窗
    │   │   └── icons/        # 图标系统
    │   ├── ai-elements/      # AI 对话 UI 组件
    │   ├── assistant/        # AI 助手组件
    │   ├── shared/           # 共享资产弹窗
    │   ├── task/             # 任务状态组件
    │   ├── media/            # 媒体展示组件
    │   └── voice/            # 语音相关组件
    │
    ├── features/             # 独立功能模块
    │   └── video-editor/     # Remotion 视频编辑器
    │       ├── components/   # Timeline, Preview, TransitionPicker
    │       ├── hooks/        # useEditorState, useEditorActions
    │       ├── remotion/     # VideoComposition, 转场效果
    │       └── types/        # 编辑器类型定义
    │
    ├── lib/                  # 核心业务逻辑（80+ 模块）
    │   ├── ai-runtime/       # AI 执行层
    │   ├── generators/       # 媒体生成器（image/, video/, audio/）
    │   ├── model-gateway/    # 模型网关路由
    │   ├── model-capabilities/ # 模型能力定义
    │   ├── model-pricing/    # 定价逻辑
    │   ├── llm/              # LLM 抽象层
    │   ├── novel-promotion/  # 小说转视频核心流水线
    │   ├── storyboard-phases.ts # 3 阶段分镜生成
    │   ├── task/             # 任务生命周期管理
    │   ├── workers/          # BullMQ Worker 进程
    │   ├── workflow-engine/  # 图工作流引擎
    │   ├── run-runtime/      # 运行时管理
    │   ├── billing/          # 计费子系统
    │   ├── storage/          # 存储抽象层
    │   ├── media/            # MediaObject 管理
    │   ├── prompt-i18n/      # 提示词国际化
    │   ├── config-service.ts # 统一配置服务
    │   ├── query/            # React Query hooks & mutations
    │   ├── sse/              # Server-Sent Events
    │   ├── errors/           # 错误目录
    │   ├── contracts/        # API 契约
    │   └── logging/          # 结构化日志
    │
    ├── hooks/                # 共享 React Hooks
    ├── contexts/             # React Context（Toast 等）
    ├── i18n/                 # next-intl 配置
    ├── types/                # TypeScript 类型定义
    └── styles/               # 全局样式（Glass 设计系统 tokens）
```

---

## 5. 架构概览

### 5.1 四进程架构

应用运行时包含 4 个并发进程：

```
┌─────────────────────────────────────────────────────┐
│                    waoowaoo App                      │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐                 │
│  │  Next.js      │  │  BullMQ      │                 │
│  │  Web Server   │  │  Workers     │                 │
│  │  (端口 3000)  │  │  (4 队列)    │                 │
│  └──────────────┘  └──────────────┘                 │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐                 │
│  │  Watchdog     │  │  Bull Board  │                 │
│  │  心跳监控     │  │  队列管理 UI │                 │
│  │              │  │  (端口 3010)  │                 │
│  └──────────────┘  └──────────────┘                 │
└─────────────────────────────────────────────────────┘
         │              │
         ▼              ▼
    ┌─────────┐   ┌─────────┐   ┌─────────┐
    │  MySQL   │   │  Redis   │   │  MinIO   │
    │  :13306  │   │  :16379  │   │  :19000  │
    └─────────┘   └─────────┘   └─────────┘
```

### 5.2 请求-响应流程

```
用户浏览器
    │
    ▼
Next.js API Route (src/app/api/...)
    │
    ├── 同步操作 → Prisma → MySQL → 返回结果
    │
    └── 异步 AI 操作 → 创建 Task → 投递到 BullMQ 队列 → 返回 taskId
                                                        │
                                                        ▼
                                              BullMQ Worker 消费任务
                                                        │
                                                        ▼
                                              调用 AI Provider API
                                                        │
                                                        ▼
                                              结果写入 DB + MinIO
                                                        │
                                                        ▼
                                              SSE 推送状态更新到前端
```

### 5.3 图工作流引擎（Graph Workflow Engine）

对于多步骤 AI 流水线（如"小说→剧本→分镜"），系统使用图执行模型：

- `GraphRun`：一次工作流运行实例
- `GraphStep`：工作流中的一个步骤
- `GraphStepAttempt`：步骤执行尝试（支持重试）
- `GraphCheckpoint`：状态检查点（支持恢复）
- `GraphArtifact`：步骤产出物（分析结果、剧本数据等）

支持：租约执行、心跳监控、步骤重试、断点恢复、SSE 实时进度推送。

### 5.4 核心设计模式

| 模式 | 说明 | 关键文件 |
|------|------|---------|
| **任务队列** | 所有 AI 操作异步化，通过 BullMQ 队列处理 | `src/lib/task/`, `src/lib/workers/` |
| **可插拔 Provider** | AI 提供商通过工厂模式抽象，支持热切换 | `src/lib/generators/factory.ts` |
| **MediaObject 统一管理** | 所有媒体文件通过 SHA256 哈希去重，集中管理 | `prisma/schema.prisma` (MediaObject) |
| **配置优先级** | 项目配置 > 用户偏好 > 默认值 | `src/lib/config-service.ts` |
| **乐观更新** | 前端使用 optimistic UI + SSE 失效 | `src/lib/query/` |
| **Guard 守护** | 25+ 静态分析脚本守护架构不变质 | `scripts/guards/` |
| **提示词双语** | 所有 AI 提示词均有 .zh.txt / .en.txt 版本 | `lib/prompts/` |

---

## 6. 核心流水线：小说→视频（10 步）

这是系统的核心业务流程，从用户输入小说文本到输出完整视频：

```
Step 1: 小说导入
  用户粘贴小说文本
       │
       ▼
Step 2: 剧集拆分 (episode_split)
  LLM 将长文本拆分为多个剧集
       │
       ▼
Step 3: 角色分析 (agent_character_profile)
  LLM 从小说中提取角色信息（姓名、外貌、性格）
       │
       ▼
Step 4: 场景分析 (location_create)
  LLM 提取场景/地点信息
       │
       ▼
Step 5: 剧本转换 (agent_clip + screenplay_conversion)
  LLM 将文本拆分为镜头片段(clips)，每个片段转为剧本格式
       │
       ▼
Step 6: 分镜生成（3 阶段）
  Phase 1: 分镜规划 (agent_storyboard_plan)
    → 生成基础分镜面板（景别、运镜、描述、来源文本）
  Phase 2a: 摄影指导 (agent_cinematographer)
    → 为每个面板生成构图、光线、色调、氛围规则
  Phase 2b: 表演指导 (agent_acting_direction)
    → 为每个面板生成角色表演方向
  Phase 3: 细节填充 (agent_storyboard_detail)
    → 添加详细视频提示词、场景类型
       │
       ▼
Step 7: 角色/场景图生成
  为每个角色生成一致性形象图
  为每个场景生成参考图
       │
       ▼
Step 8: 分镜面板图生成
  AI 根据角色参考图 + 场景图 + 面板描述生成每帧图片
  支持：首帧模式、首尾帧模式（用于视频转场）
       │
       ▼
Step 9: 视频生成
  AI 根据面板图片 + 视频提示词生成短视频片段
  支持：普通模式、首尾帧模式
       │
       ▼
Step 10: 语音合成 + 唇形同步
  AI 为每句对白生成语音（声音克隆或 TTS）
  AI 将语音与视频进行唇形同步
       │
       ▼
Step 11: 视频编辑 & 导出
  使用 Remotion 时间线编辑器组装最终视频
  支持导出图片、视频、语音 ZIP 包
```

---

## 7. 数据库 Schema（Prisma）

数据库使用 MySQL 8.0，通过 Prisma ORM 管理。共 40+ 模型，按领域分组：

### 7.1 用户与认证

| 模型 | 说明 |
|------|------|
| `User` | 用户（name, email, password） |
| `Account` | OAuth 账户（NextAuth） |
| `Session` | 用户会话 |
| `VerificationToken` | 邮箱验证令牌 |
| `UserPreference` | 用户偏好（API Key、模型选择、自定义 Provider） |

### 7.2 项目层级

```
Project (顶层项目)
  └── NovelPromotionProject (小说转视频项目，1:1 关联)
        ├── NovelPromotionEpisode (剧集)
        │     ├── NovelPromotionClip (镜头片段)
        │     │     └── NovelPromotionStoryboard (分镜)
        │     │           └── NovelPromotionPanel (面板，含图片/视频/提示词)
        │     ├── NovelPromotionVoiceLine (语音行)
        │     └── NovelPromotionShot (镜头数据)
        ├── NovelPromotionCharacter (角色)
        │     └── CharacterAppearance (角色形象变体)
        ├── NovelPromotionLocation (场景/道具)
        │     └── LocationImage (场景图片变体)
        └── VideoEditorProject (视频编辑器项目数据)
```

### 7.3 全局素材库

| 模型 | 说明 |
|------|------|
| `GlobalAssetFolder` | 素材文件夹 |
| `GlobalCharacter` / `GlobalCharacterAppearance` | 全局角色库 |
| `GlobalLocation` / `GlobalLocationImage` | 全局场景库 |
| `GlobalVoice` | 全局声音库 |

### 7.4 媒体管理

| 模型 | 说明 |
|------|------|
| `MediaObject` | 统一媒体记录（publicId, storageKey, SHA256, MIME, 尺寸, 时长） |
| `LegacyMediaRefBackup` | 旧版媒体引用迁移备份 |

### 7.5 任务系统

| 模型 | 说明 |
|------|------|
| `Task` | 异步任务（type, status, progress, heartbeat, 重试计数, 计费信息） |
| `TaskEvent` | 任务生命周期事件 |

### 7.6 工作流引擎

| 模型 | 说明 |
|------|------|
| `GraphRun` | 工作流运行实例（workflowType, status, lease, checkpoint） |
| `GraphStep` | 工作流步骤 |
| `GraphStepAttempt` | 步骤执行尝试（含 LLM usage 追踪） |
| `GraphEvent` | 工作流事件（有序） |
| `GraphCheckpoint` | 状态检查点 |
| `GraphArtifact` | 步骤产出物 |

### 7.7 计费系统

| 模型 | 说明 |
|------|------|
| `UserBalance` | 用户余额（含冻结金额） |
| `BalanceFreeze` | 任务前余额冻结 |
| `BalanceTransaction` | 账本交易记录 |
| `UsageCost` | 使用成本记录 |

### 7.8 辅助模型

| 模型 | 说明 |
|------|------|
| `VoicePreset` | 声音预设（系统/自定义） |
| `SupplementaryPanel` | 补充面板（插入分镜） |

---

## 8. API 路由

所有 API 路由位于 `src/app/api/`，共 130+ 端点。使用 Next.js App Router 的 `route.ts` 约定。

### 8.1 认证 (`/api/auth/`)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/[...nextauth]` | NextAuth 处理器 |
| POST | `/api/auth/register` | 用户注册 |

### 8.2 项目管理 (`/api/projects/`)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/projects` | 项目列表 / 创建项目 |
| GET/PATCH/DELETE | `/api/projects/[projectId]` | 项目详情 / 更新 / 删除 |
| GET | `/api/projects/[projectId]/data` | 项目完整数据 |
| GET | `/api/projects/[projectId]/assets` | 项目素材 |
| GET | `/api/projects/[projectId]/costs` | 项目成本 |

### 8.3 小说转视频流水线 (`/api/novel-promotion/[projectId]/`)

这是最核心的 API 组，60+ 端点：

**分析与转换**：
- `POST /analyze` — 分析小说文本
- `POST /analyze-global` — 全局分析（跨剧集）
- `POST /story-to-script-stream` — 故事→剧本（SSE 流式）
- `POST /script-to-storyboard-stream` — 剧本→分镜（SSE 流式）
- `POST /screenplay-conversion` — 剧本格式转换

**剧集管理**：
- `GET/POST /episodes` — 剧集列表 / 创建
- `POST /episodes/split` — 拆分剧集
- `POST /episodes/batch` — 批量操作

**角色管理**：
- `GET/POST/PATCH /character` — 角色 CRUD
- `POST /character/appearance` — 角色形象管理
- `POST /character-profile` — AI 角色分析
- `POST /ai-create-character` — AI 创建角色
- `POST /ai-modify-appearance` — AI 修改形象
- `POST /reference-to-character` — 参考图→角色
- `POST /generate-character-image` — 生成角色图片
- `POST /select-character-image` — 选择角色图片

**场景管理**：
- `GET/POST/PATCH /location` — 场景 CRUD
- `POST /ai-create-location` — AI 创建场景
- `POST /ai-modify-location` — AI 修改场景
- `POST /ai-modify-prop` — AI 修改道具
- `POST /select-location-image` — 选择场景图片

**分镜管理**：
- `GET/POST /storyboards` — 分镜列表
- `GET/POST /storyboard-group` — 分镜组
- `POST /insert-panel` — 插入面板
- `POST /regenerate-storyboard-text` — 重新生成分镜文本
- `POST /photography-plan` — 摄影计划

**面板管理**：
- `GET/POST/PATCH /panel` — 面板 CRUD
- `POST /panel-variant` — 面板变体
- `POST /panel-link` — 面板链接
- `POST /regenerate-panel-image` — 重新生成面板图片
- `POST /regenerate-single-image` — 重新生成单张图片
- `POST /update-prompt` — 更新提示词

**媒体生成**：
- `POST /generate-image` — 生成图片
- `POST /generate-video` — 生成视频
- `POST /voice-generate` — 生成语音
- `POST /voice-design` — AI 声音设计
- `POST /voice-analyze` — AI 语音分析
- `POST /lip-sync` — 唇形同步
- `POST /modify-asset-image` — 修改素材图片

**下载与导出**：
- `POST /download-images` — 下载图片 ZIP
- `POST /download-videos` — 下载视频 ZIP
- `POST /download-voices` — 下载语音 ZIP
- `GET /video-proxy` — 视频代理
- `GET /video-urls` — 获取视频 URL

### 8.4 全局素材库 (`/api/asset-hub/`)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/asset-hub/characters` | 全局角色列表 / 创建 |
| GET/POST | `/api/asset-hub/locations` | 全局场景列表 / 创建 |
| GET/POST | `/api/asset-hub/voices` | 全局声音列表 / 创建 |
| POST | `/api/asset-hub/ai-design-character` | AI 设计角色 |
| POST | `/api/asset-hub/ai-design-location` | AI 设计场景 |
| POST | `/api/asset-hub/ai-modify-character` | AI 修改角色 |
| POST | `/api/asset-hub/generate-image` | 生成图片 |
| POST | `/api/asset-hub/voice-design` | 声音设计 |

### 8.5 任务管理 (`/api/tasks/`)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tasks` | 任务列表（支持按项目/状态/类型过滤） |
| GET | `/api/tasks/[taskId]` | 任务详情 |
| POST | `/api/tasks/dispatch` | 派发任务 |
| GET | `/api/task-target-states` | 任务目标状态 |

### 8.6 工作流运行 (`/api/runs/`)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/runs` | 运行列表 / 创建 |
| GET | `/api/runs/[runId]` | 运行详情 |
| POST | `/api/runs/[runId]/cancel` | 取消运行 |
| GET | `/api/runs/[runId]/events` | SSE 事件流 |
| POST | `/api/runs/[runId]/steps/[stepKey]/retry` | 重试步骤 |

### 8.7 用户 (`/api/user/`)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PATCH | `/api/user/api-config` | API 配置 |
| GET | `/api/user/balance` | 用户余额 |
| GET | `/api/user/costs` | 成本记录 |
| POST | `/api/user/assistant/chat` | AI 助手对话 |
| POST | `/api/user/ai-story-expand` | AI 故事扩展 |

### 8.8 其他

| 路径 | 说明 |
|------|------|
| `/api/sse` | Server-Sent Events 实时推送 |
| `/api/storage/sign` | 签名 URL 生成 |
| `/api/files/[...path]` | 文件服务 |
| `/api/cos/image` | COS 图片代理 |
| `/api/admin/download-logs` | 管理员日志下载 |

---

## 9. AI 提供商系统

### 9.1 支持的 Provider

| Provider | 用途 | SDK | 关键文件 |
|----------|------|-----|---------|
| **FAL.ai** | 图片生成、视频生成、唇形同步、声音克隆 (IndexTTS2) | `@fal-ai/client` | `src/lib/generators/fal.ts` |
| **Volcengine Ark** | 图片生成 (Seedream)、视频生成 (Seedance) | 自定义 | `src/lib/generators/ark.ts`, `src/lib/ark-api.ts` |
| **Google Gemini** | LLM 文本分析、图片生成、视频生成 | `@ai-sdk/google`, `@google/genai` | `src/lib/generators/image/google.ts`, `src/lib/generators/video/google.ts` |
| **OpenAI** | LLM 文本分析 | `openai`, `@ai-sdk/openai` | `src/lib/model-gateway/openai-compat/` |
| **OpenRouter** | LLM 路由 | `@openrouter/sdk` | — |
| **Alibaba Bailian** | TTS 语音合成 | 自定义 | `src/lib/generators/audio/bailian.ts` |
| **MiniMax** | 视频生成 | 自定义 | `src/lib/generators/minimax.ts` |
| **Vidu** | 视频生成 | 自定义 | `src/lib/generators/vidu.ts` |
| **OpenAI Compatible** | 通用兼容层 | — | `src/lib/model-gateway/openai-compat/` |

### 9.2 模型配置

模型配置通过 `src/lib/config-service.ts` 统一管理：

**模型 Key 格式**：`provider::modelId`（如 `google::gemini-2.5-flash`）

**7 个模型槽位**：
1. `analysisModel` — LLM 文本分析（剧本拆分、角色提取等）
2. `characterModel` — 角色图片生成
3. `locationModel` — 场景图片生成
4. `storyboardModel` — 分镜图片生成
5. `editModel` — 图片编辑
6. `videoModel` — 视频生成
7. `audioModel` — 语音合成

**配置优先级**：项目配置 (`NovelPromotionProject`) > 用户偏好 (`UserPreference`) > null

### 9.3 模型网关

`src/lib/model-gateway/router.ts` 负责路由请求：
- 官方 Provider API（如 Google、FAL）
- OpenAI Compatible 端点（用户自定义）

### 9.4 能力系统

每个模型有可配置的能力选项（分辨率、宽高比等），定义在：
- `standards/capabilities/image-video.catalog.json` — 能力目录
- `standards/pricing/image-video.pricing.json` — 价格目录
- `src/lib/model-capabilities/` — 运行时能力定义

---

## 10. 任务队列系统

### 10.1 四个 BullMQ 队列

| 队列名 | Worker 文件 | 处理的任务类型 | 默认并发 |
|--------|------------|---------------|---------|
| `waoowaoo-image` | `image.worker.ts` | IMAGE_CHARACTER, IMAGE_LOCATION, IMAGE_PANEL, PANEL_VARIANT, MODIFY_ASSET_IMAGE, ASSET_HUB_IMAGE, ASSET_HUB_MODIFY | 20 |
| `waoowaoo-video` | `video.worker.ts` | VIDEO_PANEL, LIP_SYNC | 4 |
| `waoowaoo-voice` | `voice.worker.ts` | VOICE_LINE, VOICE_DESIGN, ASSET_HUB_VOICE_DESIGN | 10 |
| `waoowaoo-text` | `text.worker.ts` | 20+ 类型（分析、剧本转换、分镜生成、角色设计等） | 10 |

### 10.2 任务生命周期

```
提交任务 (addTaskJob)
    │
    ▼
状态: QUEUED → PROCESSING → COMPLETED / FAILED
    │           │
    │           ├── 心跳监控 (10s 间隔)
    │           ├── 计费冻结
    │           └── SSE 状态推送
    │
    ▼
完成 → 计费结算，写入结果
失败 → 重试（指数退避，2s 基础，最多 5 次）→ 最终失败则回滚计费
```

核心封装在 `src/lib/workers/shared.ts` 的 `withTaskLifecycle()` 函数中，统一处理：
- 状态转换
- 心跳监控
- 计费结算/回滚
- SSE 事件发布
- 错误标准化
- Run 事件镜像

### 10.3 Worker 处理器

`src/lib/workers/handlers/` 目录下有 45+ 处理器文件，覆盖所有任务类型。关键处理器：

| 处理器文件 | 功能 |
|-----------|------|
| `story-to-script.ts` | 故事→剧本转换 |
| `script-to-storyboard.ts` | 剧本→分镜生成 |
| `analyze-novel.ts` | 小说分析 |
| `episode-split.ts` | 剧集拆分 |
| `screenplay-convert.ts` | 剧本格式转换 |
| `character-profile.ts` | 角色分析 |
| `panel-image-task-handler.ts` | 面板图片生成 |
| `shot-ai-prompt.ts` | 镜头 AI 提示词 |
| `voice-analyze.ts` | 语音分析 |
| `voice-design.ts` | 声音设计 |

### 10.4 用户并发控制

`src/lib/workers/user-concurrency-gate.ts` 实现每用户并发限制，防止单个用户垄断图片和视频生成资源。

### 10.5 Watchdog

`scripts/watchdog.ts` 后台进程定期检查任务心跳，恢复卡死的任务。配置：
- `WATCHDOG_INTERVAL_MS`：检查间隔（默认 30s）
- `TASK_HEARTBEAT_TIMEOUT_MS`：心跳超时（默认 90s）

---

## 11. 前端架构

### 11.1 路由结构（App Router）

所有页面位于 `src/app/[locale]/` 下，通过 `next-intl` 中间件实现 locale 前缀路由（`/zh/...`, `/en/...`）。

| 路由 | 页面文件 | 功能 |
|------|---------|------|
| `/[locale]/` | `page.tsx` | 落地页（已登录用户重定向到 /home） |
| `/[locale]/home` | `home/page.tsx` | 首页（快速创作 + 最近项目） |
| `/[locale]/auth/signin` | `auth/signin/page.tsx` | 登录 |
| `/[locale]/auth/signup` | `auth/signup/page.tsx` | 注册 |
| `/[locale]/workspace` | `workspace/page.tsx` | 项目列表（搜索、分页、CRUD） |
| `/[locale]/workspace/[projectId]` | `workspace/[projectId]/page.tsx` | 项目详情（多阶段工作区） |
| `/[locale]/workspace/asset-hub` | `workspace/asset-hub/page.tsx` | 全局素材库 |
| `/[locale]/profile` | `profile/page.tsx` | 用户设置（API 配置、计费） |

**工作区阶段**（通过 `?stage=` URL 参数控制）：
`config` → `script` → `assets` → `text-storyboard` → `storyboard` → `videos` → `voice` → `editor`

### 11.2 状态管理（三层架构）

1. **React Query (TanStack Query v5)** — 服务器状态管理
   - Hooks: `src/lib/query/hooks/` — 数据获取
   - Mutations: `src/lib/query/mutations/` — 25+ 变更模块
   - SSE 流: `src/lib/query/hooks/run-stream/` — 长任务实时进度

2. **React Context** — 全局 UI 状态
   - `SessionProvider` (NextAuth)
   - `QueryProvider` (TanStack Query)
   - `ToastProvider` (全局通知，支持 i18n 错误码翻译)
   - `WorkspaceProvider` (工作区状态)

3. **URL 状态** — 导航关键状态
   - 阶段选择 (`?stage=`)
   - 剧集选择 (`?episode=`)
   - 确保可分享的深链接和浏览器前进/后退支持

### 11.3 Glass 设计系统

自定义毛玻璃（Glassmorphism）设计系统：

**Token 层**：`src/styles/ui-tokens-glass.css`
- 70+ CSS 变量：表面、文本、描边、阴影、模糊、圆角、间距、5 色调色板

**语义层**：`src/styles/ui-semantic-glass.css`
- `.glass-page`, `.glass-surface`, `.glass-surface-elevated`, `.glass-surface-modal`
- `.glass-btn-primary`, `.glass-btn-secondary`, `.glass-btn-ghost`, `.glass-btn-danger`
- `.glass-chip-*`, `.glass-segmented`, `.glass-toggle`

**基础组件**：`src/components/ui/primitives/`
- `GlassSurface`, `GlassButton`, `GlassField`, `GlassInput`, `GlassTextarea`, `GlassChip`, `GlassModalShell`

### 11.4 核心组件

| 组件 | 路径 | 功能 |
|------|------|------|
| `Navbar` | `src/components/Navbar.tsx` | 顶部导航栏（Glass 风格） |
| `NovelPromotionWorkspace` | `workspace/[projectId]/modes/novel-promotion/` | 小说转视频主工作区 |
| `SmartImport` | `novel-promotion/components/smart-import/` | 智能导入向导 |
| `StoryboardView` | `novel-promotion/components/storyboard/` | 分镜编辑视图 |
| `VideoStage` | `novel-promotion/components/video-stage/` | 视频生成阶段 |
| `VoiceStage` | `novel-promotion/components/voice-stage/` | 语音生成阶段 |
| `VideoEditorStage` | `features/video-editor/` | Remotion 视频编辑器 |
| `AssistantChatModal` | `components/assistant/` | AI 助手对话弹窗 |
| `CharacterCreationModal` | `components/shared/assets/` | 角色创建弹窗 |
| `GlobalAssetPicker` | `components/shared/assets/` | 全局素材选择器 |

### 11.5 国际化 (i18n)

- 库：`next-intl v4.7.0`
- 语言：`zh`（中文，默认）、`en`（英文）
- 翻译文件：`messages/zh/` 和 `messages/en/`，各 33 个 JSON 模块
- 路由：始终带 locale 前缀（`/zh/...`, `/en/...`）
- 中间件：`middleware.ts` 处理 locale 重定向

---

## 12. Prompt 系统

### 12.1 提示词模板

所有 AI 提示词存储在 `lib/prompts/` 目录下，以 `.txt` 文件形式存在，每个模板有中英文两个版本（`.zh.txt` / `.en.txt`）。

**小说转视频流水线提示词**（`lib/prompts/novel-promotion/`）：

| 提示词 ID | 文件名 | 用途 |
|-----------|--------|------|
| `agent_storyboard_plan` | `agent_storyboard_plan` | 分镜规划（Phase 1） |
| `agent_cinematographer` | `agent_cinematographer` | 摄影指导（Phase 2a） |
| `agent_acting_direction` | `agent_acting_direction` | 表演指导（Phase 2b） |
| `agent_storyboard_detail` | `agent_storyboard_detail` | 分镜细节（Phase 3） |
| `agent_character_profile` | `agent_character_profile` | 角色分析 |
| `agent_character_visual` | `agent_character_visual` | 角色视觉设计 |
| `agent_clip` | `agent_clip` | 镜头片段拆分 |
| `screenplay_conversion` | `screenplay_conversion` | 剧本格式转换 |
| `episode_split` | `episode_split` | 剧集拆分 |
| `character_create` | `character_create` | 创建角色 |
| `character_modify` | `character_modify` | 修改角色 |
| `character_regenerate` | `character_regenerate` | 重新生成角色 |
| `character_description_update` | `character_description_update` | 更新角色描述 |
| `location_create` | `location_create` | 创建场景 |
| `location_modify` | `location_modify` | 修改场景 |
| `location_regenerate` | `location_regenerate` | 重新生成场景 |
| `location_description_update` | `location_description_update` | 更新场景描述 |
| `single_panel_image` | `single_panel_image` | 单面板图片提示词 |
| `voice_analysis` | `voice_analysis` | 语音分析 |
| `image_prompt_modify` | `image_prompt_modify` | 图片提示词修改 |
| `ai_story_expand` | `ai_story_expand` | AI 故事扩展 |
| `agent_shot_variant_analysis` | `agent_shot_variant_analysis` | 镜头变体分析 |
| `agent_shot_variant_generate` | `agent_shot_variant_generate` | 镜头变体生成 |
| `storyboard_edit` | `storyboard_edit` | 分镜编辑 |
| `agent_storyboard_insert` | `agent_storyboard_insert` | 分镜插入 |
| `select_location` | `select_location` | 选择场景 |
| `select_prop` | `select_prop` | 选择道具 |

### 12.2 提示词国际化

`src/lib/prompt-i18n/` 模块负责：
- 根据用户语言加载对应版本的提示词
- 模板变量替换（`{variable}` 占位符）
- Guard 脚本 `check:prompt-i18n` 确保所有提示词都有双语版本

---

## 13. 计费系统

计费子系统位于 `src/lib/billing/`，提供完整的成本管理：

### 13.1 计费模式

通过 `BILLING_MODE` 环境变量控制：
- `OFF` — 关闭计费（默认）
- `SHADOW` — 影子模式（仅记录，不阻断）
- `ENFORCE` — 强制模式（余额不足时阻断任务）

### 13.2 计费流程

```
任务提交 → 报价 → 冻结余额 (BalanceFreeze)
    │
    ▼
任务执行中...
    │
    ▼
完成 → 结算（扣除冻结金额，记录 BalanceTransaction）
失败 → 回滚（解冻冻结金额）
```

### 13.3 定价维度

- 按 Token（LLM 调用）
- 按图片数量
- 按视频数量
- 按音频时长（秒）
- 按 API 调用次数

定价定义在 `standards/pricing/image-video.pricing.json`。

---

## 14. 存储系统

### 14.1 可插拔存储

`src/lib/storage/` 提供统一的存储抽象层：

| Provider | 说明 | 配置 |
|----------|------|------|
| **MinIO** (默认) | S3 兼容对象存储 | `STORAGE_TYPE=minio` |
| **Local** | 本地文件系统（仅开发调试） | `STORAGE_TYPE=local` |
| **COS** | 腾讯云对象存储（预留） | `STORAGE_TYPE=cos` |

### 14.2 MediaObject 模式

所有媒体文件（图片、视频、音频）通过 `MediaObject` 模型统一管理：
- **SHA256 哈希**：自动去重
- **StorageKey**：存储路径
- **签名 URL**：通过 `/api/storage/sign` 生成临时访问 URL
- **外键引用**：所有业务表通过 `mediaId` 关联 MediaObject

### 14.3 图片 URL 规范化

`src/lib/media/` 负责：
- 图片 URL 规范化（确保一致的访问路径）
- 外部图片处理（下载、上传到存储）
- 哈希计算和去重

---

## 15. 关键文件速查表

### 配置与入口

| 文件 | 说明 |
|------|------|
| `package.json` | 项目配置、90+ npm scripts |
| `.env.example` | 环境变量模板 |
| `docker-compose.yml` | 4 服务 Docker 编排 |
| `next.config.ts` | Next.js 配置（集成 next-intl） |
| `middleware.ts` | next-intl locale 路由中间件 |
| `prisma/schema.prisma` | 数据库 Schema（40+ 模型） |

### 核心业务逻辑

| 文件 | 说明 |
|------|------|
| `src/lib/config-service.ts` | 统一配置服务（模型选择、优先级） |
| `src/lib/storyboard-phases.ts` | 3 阶段分镜生成流水线 |
| `src/lib/novel-promotion/story-to-script/orchestrator.ts` | 故事→剧本编排器 |
| `src/lib/workers/shared.ts` | 任务生命周期封装 (`withTaskLifecycle`) |
| `src/lib/workers/index.ts` | Worker 进程入口 |
| `src/lib/task/queues.ts` | BullMQ 队列定义 |

### AI Provider

| 文件 | 说明 |
|------|------|
| `src/lib/generators/factory.ts` | 生成器工厂 |
| `src/lib/generators/fal.ts` | FAL.ai Provider |
| `src/lib/generators/ark.ts` | Volcengine Ark Provider |
| `src/lib/model-gateway/router.ts` | 模型网关路由 |
| `src/lib/model-gateway/llm.ts` | LLM 调用封装 |
| `src/lib/ai-runtime/client.ts` | AI 执行层 |

### 前端核心

| 文件 | 说明 |
|------|------|
| `src/app/[locale]/workspace/[projectId]/page.tsx` | 项目详情页入口 |
| `src/app/[locale]/workspace/[projectId]/modes/novel-promotion/` | 小说转视频工作区 |
| `src/lib/query/hooks/index.ts` | React Query Hooks 入口 |
| `src/lib/query/mutations/` | 25+ Mutation 模块 |
| `src/components/ui/primitives/` | Glass 设计系统基础组件 |
| `src/styles/ui-tokens-glass.css` | Glass 设计系统 Token |
| `src/features/video-editor/` | Remotion 视频编辑器 |

### 运维与守护

| 文件 | 说明 |
|------|------|
| `scripts/watchdog.ts` | 任务心跳监控 |
| `scripts/bull-board.ts` | BullMQ 管理面板 |
| `scripts/guards/` | 25+ 架构守护脚本 |

---

## 16. 开发规范

### 16.1 npm Scripts（常用）

```bash
npm run dev              # 启动开发环境（4 进程）
npm run build            # 构建生产版本
npm run start            # 启动生产环境

npm run test:all         # 运行全部测试
npm run test:unit:all    # 运行单元测试
npm run test:integration:api   # API 集成测试
npm run test:system      # 系统测试

npm run lint:all         # ESLint 检查
npm run typecheck        # TypeScript 类型检查
npm run verify:commit    # pre-commit 验证（lint + typecheck + test）
npm run verify:push      # pre-push 验证（lint + typecheck + test + build）
```

### 16.2 Guard 脚本（架构守护）

`scripts/guards/` 目录下 25+ 静态分析脚本，在 CI 和 Git Hooks 中运行，防止架构退化：

| Guard | 说明 |
|-------|------|
| `no-api-direct-llm-call` | API 路由不得直接调用 LLM，必须通过任务队列 |
| `no-provider-guessing` | 禁止硬编码 Provider 判断 |
| `no-model-key-downgrade` | 禁止降级模型 Key 格式 |
| `no-hardcoded-model-capabilities` | 禁止硬编码模型能力 |
| `api-route-contract-guard` | API 路由契约检查 |
| `task-loading-guard` | 任务加载规范检查 |
| `prompt-i18n-guard` | 提示词必须有双语版本 |
| `file-line-count-guard` | 文件行数限制 |
| `test-route-coverage-guard` | 测试路由覆盖率 |
| `test-tasktype-coverage-guard` | 测试任务类型覆盖率 |
| `locale-navigation-guard` | 国际化导航检查 |
| `image-reference-normalization-guard` | 图片引用规范化检查 |

### 16.3 测试策略

```
tests/
├── unit/           # 单元测试：纯函数、组件、Worker 逻辑
├── integration/    # 集成测试：API 契约、Provider 对接、链路
├── system/         # 系统测试：端到端流程
├── regression/     # 回归测试：面板变体、任务去重、计费回滚
├── concurrency/    # 并发测试：计费账本并发安全
└── contracts/      # 契约测试：需求矩阵、行为矩阵
```

测试工具：
- `tests/helpers/` — Fake LLM、Fake Media、Fake Provider、DB 重置、Fixtures
- `BILLING_TEST_BOOTSTRAP` 环境变量控制计费测试模式
- `SYSTEM_TEST_BOOTSTRAP` 环境变量控制系统测试模式

### 16.4 Git Hooks (Husky)

- **pre-commit**: 运行 `verify:commit`（lint + typecheck + test:all）
- **pre-push**: 运行 `verify:push`（lint + typecheck + test:all + build）

### 16.5 CI/CD

`.github/workflows/docker-publish.yml`：
- 触发条件：push 到 `main` 分支或版本标签（`v*`）
- 构建多平台 Docker 镜像（linux/amd64, linux/arm64）
- 推送到 GitHub Container Registry (ghcr.io)

---

## 附录：环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATABASE_URL` | `mysql://root:waoowaoo123@localhost:13306/waoowaoo` | MySQL 连接串 |
| `REDIS_HOST` | `127.0.0.1` | Redis 主机 |
| `REDIS_PORT` | `16379` | Redis 端口 |
| `STORAGE_TYPE` | `minio` | 存储类型（minio/local/cos） |
| `MINIO_ENDPOINT` | `http://localhost:19000` | MinIO 端点 |
| `MINIO_BUCKET` | `waoowaoo` | MinIO 桶名 |
| `NEXTAUTH_URL` | `http://localhost:3000` | 认证 URL |
| `NEXTAUTH_SECRET` | — | 认证密钥（必须修改） |
| `INTERNAL_APP_URL` | `http://127.0.0.1:3000` | 内部自调用地址 |
| `BILLING_MODE` | `OFF` | 计费模式（OFF/SHADOW/ENFORCE） |
| `QUEUE_CONCURRENCY_IMAGE` | `50` | 图片队列并发 |
| `QUEUE_CONCURRENCY_VIDEO` | `50` | 视频队列并发 |
| `QUEUE_CONCURRENCY_VOICE` | `20` | 语音队列并发 |
| `QUEUE_CONCURRENCY_TEXT` | `50` | 文本队列并发 |
| `WATCHDOG_INTERVAL_MS` | `30000` | Watchdog 检查间隔 |
| `TASK_HEARTBEAT_TIMEOUT_MS` | `90000` | 任务心跳超时 |
| `LOG_LEVEL` | `ERROR` | 日志级别 |
| `LLM_STREAM_EPHEMERAL_ENABLED` | `true` | 流式输出 |
