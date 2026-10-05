# 榫卯结构拆解图鉴

面向传统木作学习者与家具设计人员的纯前端单页应用。项目把榫卯类型、构件尺寸、配合公差、拆装步骤、内联 SVG 示意图与适用家具整理为一套可查询、可编排、可追溯的本地图鉴，所有数据均保存在当前浏览器中。

## Docker 一键启动

```bash
cp .env.example .env && docker compose up -d --build
```

服务启动后访问：`http://localhost:21804`

停止服务：

```bash
docker compose down
```

## 技术栈

| 类别 | 技术 |
| --- | --- |
| UI | React 18、TypeScript 5 |
| 构建 | Vite 5 |
| 样式 | Tailwind CSS 3 |
| 路由 | React Router 6 |
| 状态 | Zustand 4 |
| 本地数据 | Dexie 4、IndexedDB |
| 容器 | Docker 多阶段构建、Nginx |

## 访问地址

- 宿主机端口：`21804`
- 页面地址：`http://localhost:21804`
- 前端路由回退由 Nginx 的 `try_files` 规则处理。

## 本地开发方式

```bash
cd frontend
npm install
npm run dev
```

类型检查与生产构建：

```bash
cd frontend
npm run build
```

本地开发默认使用 Vite 的 `5173` 端口；应用数据由浏览器中的 Dexie 数据库维护，不需要后端服务。

## 目录结构

```text
.
├── frontend/
│   ├── public/
│   ├── src/
│   │   ├── components/common/   共享 SVG、步骤轨道、尺寸字段和标签
│   │   ├── hooks/               步序编排与 SVG 热区解析
│   │   ├── pages/               图鉴、详情、步序、绘制台与家具反查
│   │   ├── router/              前端路由
│   │   ├── stores/              Zustand 状态与数据落库
│   │   ├── types/               核心数据模型
│   │   ├── utils/               Dexie、尺寸换算与 JSON 导出
│   │   ├── App.tsx
│   │   ├── index.css
│   │   └── main.tsx
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
├── docker-compose.yml
├── .env.example
└── README.md
```

## 数据存储说明

应用使用 IndexedDB，数据库封装库为 Dexie 4，库名为 `gbmortise-db`。

- `version(1)`：建立 `joints`、`members`、`steps`、`diagrams`、`furniture` 五张表及查询索引。
- `version(2)`：执行升级迁移，为五张表回填 `schemaRev = 2` 字段。
- `version(3)`：新增 `leases`（编辑租约）与 `stages`（未确认修改暂存区）两张表，支撑多标签页单写者交接。
- 首次创建数据库时通过 Dexie `populate` 回调写入榫卯、构件、步骤、内联 SVG 与家具关联的种子数据。
- 构件尺寸、步序拖拽、SVG 保存与家具关系登记不再实时写正表，而是先进入租约名下的暂存区；只有点击“确认写入图鉴”且租约守卫通过时，才在单个事务内写回五张正表。

## 单写者租约交接

同一榫卯被两个标签页同时编辑时，后一次保存覆盖前一次内容是要解决的核心问题。机制如下：

- **进入编辑先领租约**：打开类型详情、步序编排或示意图绘制台时，以标签页为单位（身份存于 `sessionStorage`）领取该榫卯的租约；家具反查页只在打开登记表单时领取。
- **心跳与超时**：租约 TTL 15 秒，持有者每 5 秒续期一次；标签页崩溃或被强杀后心跳停止，等待页在 TTL 到期后自动接管。正常关闭页面时通过 `pagehide` 与路由延迟释放尽快交接，他页可立即接管。
- **fencing token**：`leases` 表以自增主键 `fence` 作为租约世代号，每次接管换发更大的值。所有暂存与入库都在同一 IndexedDB 事务内复核 `fence` 与持有者；旧标签页的迟到保存既写不进正表，也覆盖不了新暂存，而是被停放为“迟到保存 · 未入库”条目等待人工复核。
- **修改归属同一份租约**：构件尺寸、拆装动作（步序重排）、内联 SVG 与家具关系统一写入 `stages` 表中该榫卯的暂存区。
- **交接保留上一版**：接管者首次修改同一对象时，上一任持有者的未确认版本自动保留为“交接备份”，在待复核面板中可“采纳为待确认”或丢弃。
- **失败可找回**：确认入库在单事务内完成，租约失效会整笔回滚；写入失败、标签页崩溃或刷新重开后，暂存区中的待确认与待复核内容都仍可找回，图鉴总览卡片上会显示待确认/待复核角标。
- 跨标签页的即时通知使用 `BroadcastChannel`（租约领取、心跳、释放、暂存更新、入库）；通道不可用时租约判定仍以 IndexedDB 为准。

租约交接的端到端断言可通过 `npm run test:lease`（Node + fake-indexeddb）运行，覆盖互斥领取、暂存不入库、守卫拦截迟到保存、交接备份采纳、崩溃恢复与旧 fence 入库回滚等场景。

## 核心功能与路由表

| 路由 | 页面 | 核心功能 |
| --- | --- | --- |
| `/` | 入口重定向 | 自动进入榫卯图鉴 |
| `/joints` | 榫卯图鉴总览 | 按家族与难度分组，新建类型，显示构件数与步骤数，导出全部数据 |
| `/joints/:id` | 类型详情 | 查看尺寸表、公差校验、适用家具与步骤；导出当前类型 |
| `/joints/:id/steps` | 拆装步序编排 | 原生拖拽调序并落库，逐步预览内联 SVG 与风险提醒 |
| `/joints/:id/diagram` | 示意图绘制台 | 点击热区回填构件，编辑构件名称、尺寸与 SVG 源 |
| `/furniture` | 家具榫卯反查 | 按家具聚合使用部位与承力说明，新建家具关联 |
