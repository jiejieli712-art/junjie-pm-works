# 元来短剧平台代码证据概览

本文件用于说明短剧平台相关工程如何支撑“跨端业务流程与后台管理落地”的作品集叙事。仓库中仅收录轻量技术证据，不上传完整源码树。

## 代码材料来源

- 项目工程：`fastshort-main`
- 前端后台：`apps/admin`
- 服务端：`apps/server`
- 本仓库收录证据：前端后台 `package.json`、服务端 `package.json`、代码结构摘要

## 系统组成

短剧平台代码材料体现的是一套“内容平台 + 后台运营 + 多端播放/管理”的业务系统。

核心模块包括：

- 管理后台：内容、剧集、用户、运营配置、数据看板等后台管理能力。
- 服务端：Koa 服务、MongoDB、Redis、对象存储、JWT 鉴权、视频/图片资源处理。
- 管理端 UI：Vue 3、TypeScript、Vite、Naive UI、UnoCSS、Pinia、Vue Router。
- 部署支撑：MongoDB、Redis、MinIO、Node 服务的本地/容器化组合。

## 技术栈摘要

后台前端：

- Vue 3
- TypeScript
- Vite
- Naive UI
- UnoCSS
- Pinia
- Vue Router
- ECharts
- Fast CRUD

服务端：

- Node.js
- Koa
- MongoDB
- Redis
- JWT
- S3 / MinIO
- FFmpeg
- WeChat JSSDK

## 可支撑的作品集表达

- 能理解短剧平台从内容管理、用户链路到运营后台的系统协作关系。
- 能识别前端后台、服务端、对象存储、缓存和视频处理之间的技术边界。
- 能将二开 PRD、页面原型和代码结构串成“需求到交付”的证据链。
- 能在产品经理视角下解释跨端业务、后台配置和内容运营的落地方式。

## 不上传完整源码的原因

- 短剧项目包含大量模板、第三方框架、构建文件和可能涉及内部配置的内容。
- 公开作品集只需要证明技术理解与交付参与，不需要暴露完整业务系统。
- 当前收录方式保留了依赖结构和系统组成证据，同时降低敏感信息风险。
