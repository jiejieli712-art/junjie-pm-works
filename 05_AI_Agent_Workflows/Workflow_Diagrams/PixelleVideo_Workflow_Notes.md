# Pixelle-Video AI 视频工作流研究摘要

本摘要来自本地 `PixelleVideo_项目研究报告.md`，用于补充作品集中“AI 工具理解与工作流拆解”能力。

## 研究对象

Pixelle-Video 是一个 AI 短视频自动生成项目，核心链路是把主题或文案转化为分镜、配音、视觉素材和最终视频。

## 核心工作流

```text
用户主题 / 固定文案
        ↓
LLM 生成标题、分镜和提示词
        ↓
TTS 生成语音
        ↓
ComfyUI / RunningHub 生成图片或视频素材
        ↓
HTML 模板渲染画面和字幕
        ↓
FFmpeg 合成分镜片段
        ↓
合并输出 final.mp4
```

## 产品侧观察

- 适合短视频批量生产、图文解说、数字人口播、图生视频和动作迁移等场景。
- 对普通用户提供 Web UI，对开发者提供 Python SDK、REST API、模板和工作流扩展点。
- 产品价值不只在“生成视频”，而在把 LLM、TTS、媒体生成、模板渲染和视频合成组织成可复用流水线。

## 技术侧观察

- Web UI 使用 Streamlit。
- API 使用 FastAPI。
- LLM 使用 OpenAI SDK 兼容接口。
- 媒体生成依赖 ComfyUI / RunningHub。
- 视频合成依赖 FFmpeg。
- HTML 模板渲染依赖 Playwright。

## 对作品集的价值

这份研究材料可以证明：

- 能拆解 AI 产品的端到端流程。
- 能识别 AI 工具从 Demo 到生产化之间的关键差距。
- 能从产品、技术、部署、安全和成本多个维度评估工具可用性。
- 能把复杂 AI 工作流转化为可理解的结构化文档。
