# BeautyGo Vibe Coding Operating System

这份文档定义 BeautyGo 从立项、研发到上线落地的协作框架。后续每一轮推进，都默认按这里的 agent 分工、skill 使用方式和进度同步节奏执行。

## 1. 核心原则

1. 先锁业务闭环，再扩功能广度。
2. 一次只推进一个可验收的垂直切片。
3. 产品规则先收紧，再进入架构和编码。
4. 所有重大决策都要可回溯。
5. 用户同步走事件触发，不刷屏，但关键变化必须及时同步。

## 2. 常驻 Agent

### Delivery Lead Agent

- 职责：负责里程碑、优先级、风险、任务编排和对你的统一同步。
- 不做：不直接吞掉大段具体实现。
- 常用 skill：`$beautygo-delivery-orchestrator`

### Architecture Agent

- 职责：负责技术方案、模块边界、数据模型、第三方集成边界。
- 不做：不替代前后端主实现。
- 常用 skill：`$beautygo-stack-implementation`

### Implementation Agent

- 职责：负责代码、配置、测试和交付说明。
- 不做：不私自改业务规则和关键边界。
- 常用 skill：`$beautygo-stack-implementation`

### QA & Release Agent

- 职责：负责验收、回归、提测、上线判断。
- 不做：不重写主业务逻辑。
- 常用 skill：`$beautygo-qa-release`

## 3. 按需 Agent

### Product Breakdown Agent

- 触发：新阶段开始、PRD 还不够细、要拆 epic/story/接口/页面时。
- 常用 skill：`$beautygo-prd-breakdown`

### Growth/Ops Agent

- 触发：首城冷启动、补贴策略、经营指标、上线后运营节奏。
- 常用 skill：`$beautygo-launch-ops`

### Research/Data/Design Agent

- 触发：法规调研、SDK 选型、埋点/看板、原型/交互细化等专题问题。
- 常用 skill：按专题组合调用，不长期常驻。

## 4. Skill 清单

| Skill | 用途 | 主要阶段 |
| --- | --- | --- |
| `beautygo-delivery-orchestrator` | 项目编排、阶段判断、里程碑与状态同步 | 全阶段 |
| `beautygo-prd-breakdown` | PRD 转 epic/story/验收/API/UI 规格 | 立项、需求拆解 |
| `beautygo-stack-implementation` | 技术骨架、模块边界、垂直切片实现 | 架构、编码 |
| `beautygo-qa-release` | 验收、回归、发布门禁 | 联调、提测、上线 |
| `beautygo-launch-ops` | 首城启动、冷启动、经营指标与上线后动作 | 发布前后 |

这些 skills 存放在 `~/.codex/skills/`，后续可持续增强。

## 5. 标准推进链路

每个里程碑默认走下面这条链路：

1. `Delivery Lead`
   定义当前阶段目标、本轮交付物、风险和同步格式。
2. `Product Breakdown`
   产出 epic、story、页面/流程、接口需求、验收口径。
3. `Architecture`
   锁技术边界、repo 结构、模块和集成点。
4. `Implementation`
   按切片完成代码与验证。
5. `QA & Release`
   做回归、缺陷收敛、go/no-go 判断。
6. `Delivery Lead`
   向你同步阶段结论、风险、下一步。

## 6. 项目阶段地图

### 阶段 0：项目准备

输出：

1. PRD v0.2 作为业务源文件
2. skills 与 agents 协作框架
3. 首个里程碑定义
4. repo 初始化方案

### 阶段 1：需求拆解

输出：

1. MVP 里程碑
2. epic/story backlog
3. 页面清单
4. 接口需求清单
5. 验收清单

### 阶段 2：架构与骨架

输出：

1. 仓库结构
2. 模块边界
3. 领域模型
4. 第三方集成预留

### 阶段 3：垂直切片开发

建议顺序：

1. repo bootstrap
2. 登录与角色
3. 化妆师入驻与服务配置
4. 搜索与详情
5. 下单与支付壳
6. 履约、评价、结算
7. 后台审核与纠纷

### 阶段 4：联调与发布

输出：

1. test matrix
2. bug list
3. release checklist
4. go/no-go 结论

### 阶段 5：首城上线与运营闭环

输出：

1. 首城 launch checklist
2. 冷启动动作
3. 经营驾驶舱
4. 上线后问题清单

## 7. 进度同步规则

默认采用事件触发同步。

必须同步的时点：

1. 开始新切片
2. 锁定关键决策
3. 出现 blocker
4. 准备提测/验收
5. 完成切片或里程碑

每次同步固定四段：

1. `Now`：当前在推进什么
2. `Done`：已完成什么
3. `Risk`：当前风险或阻塞
4. `Next`：下一步动作

## 8. 当前默认工作方式

从现在起，BeautyGo 默认采用下面的推进方式：

1. 我先作为 `Delivery Lead` 驱动整体节奏。
2. 进入具体模块前，先用 `Product Breakdown Agent` 把需求收紧。
3. 架构与实现分层推进，避免直接一把梭硬写。
4. 每个切片做完都要过 `QA & Release` 检查。
5. 到 MVP 可用后，切到 `Launch Ops` 衔接首城试点。
