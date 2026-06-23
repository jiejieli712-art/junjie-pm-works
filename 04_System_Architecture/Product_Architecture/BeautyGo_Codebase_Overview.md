# BeautyGo 技术与产品结构概览

BeautyGo 是一个上门美妆 O2O 平台方向的补充产品案例，重点展示从 PRD、MVP 边界、Agent 协作到前后端技术骨架的组织能力。

## 产品结构

- 客户侧：浏览化妆师、筛选服务、发起预约、支付、履约评价。
- 化妆师侧：认证、服务配置、接单、履约、结算。
- 管理端：供给审核、订单管理、异常处理、运营配置。
- 平台侧：角色权限、订单状态、履约规则、评价与结算。

## 技术结构

本项目采用多应用结构：

- `apps/admin-web`：管理后台前端。
- `apps/api`：服务端 API。
- `apps/super-app`：面向用户或多角色入口的前端应用。
- `packages/domain-types`：订单、角色、化妆师等领域类型定义。

仓库保留 package 依赖文件作为技术栈证据，不上传完整源代码树。

## AI 协作方法

BeautyGo 项目中沉淀了 Agent 分工与 Prompt 模板，用于把产品推进拆成稳定角色：

- Delivery Lead Agent：负责阶段目标、任务切片和风险控制。
- Product Breakdown Agent：把 PRD 拆成 epic、story、接口和验收标准。
- Architecture Agent：定义模块边界、数据模型和系统约束。
- Implementation Agent：按切片实现功能。
- QA & Release Agent：负责验收、回归和上线判断。

## 作品集价值

该案例不作为三大主项目之一，但可以补充说明：

- 能把一个新业务方向压缩成 MVP 范围。
- 能从产品规则推进到技术骨架。
- 能用 Agent 工作流提升需求拆解和交付协作效率。

