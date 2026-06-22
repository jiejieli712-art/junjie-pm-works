# Pixelle-Video 项目研究报告

研究时间：2026-05-25  
研究对象：GitHub 仓库 `AIDC-AI/Pixelle-Video`  
代码快照：`main` 分支提交 `db2e43a121a60b5042f72bec3f2627772dd401d6`，提交时间 2026-05-18  
当前版本：`pyproject.toml` 声明 `0.1.15`，GitHub 最新 Release 为 `v0.1.15`

## 1. 项目概览

Pixelle-Video 是一个 AI 全自动短视频生成引擎。它的核心目标是把“一句话主题”转换为可发布的短视频：自动生成文案、分镜、图片或视频素材、语音解说、字幕画面，再合成为最终视频。

官方定位：

- 输入一个主题，自动完成视频文案、AI 配图/视频、语音解说、背景音乐和视频合成。
- 面向无剪辑经验用户，也允许开发者通过 Python API、REST API、HTML 模板和 ComfyUI 工作流进行二次开发。
- 支持本地部署和云端 RunningHub 工作流。

GitHub 元数据（2026-05-25 查询）：

- 仓库：`AIDC-AI/Pixelle-Video`
- 描述：AI 全自动短视频引擎 / AI Fully Automated Short Video Engine
- Stars：19,580
- Forks：2,775
- Open issues/PR：110
- 许可证：Apache-2.0
- 默认分支：`main`
- 仓库创建时间：2025-11-07
- 最近 push：2026-05-18
- 最新 Release：`v0.1.15 - Windows 一键整合包`
- Release 资产：`Pixelle-Video-v0.1.15-win64.zip`，约 398.6 MB，SHA256 为 `12f110ad26df1cda2cf3fdc5009c458c4a1b1e3091af23209f79ae3168ab00f3`

## 2. 适用场景

Pixelle-Video 适合以下内容生产场景：

- 抖音、快手、小红书等竖屏短视频批量创作。
- B站、YouTube 等横屏图文解说视频。
- 书单号、知识科普、情绪文案、养生科普、历史解说、成长类内容。
- 使用自有图片/视频素材，生成旁白、解说和成片。
- 商品口播、数字人口播、图生视频、动作迁移等 AI 视频实验。
- 企业或个人搭建内部短视频生产流水线，通过 API 自动生成视频。

不太适合的场景：

- 对画面精确控制要求很高的专业剪辑。
- 完全离线使用但没有本地模型、没有 Ollama、没有 ComfyUI 的环境。
- 对稳定性、安全性要求很高的生产级 SaaS，除非先补充鉴权、文件访问隔离、队列、任务持久化、监控和测试。

## 3. 核心功能

### 3.1 快速创作

用户输入主题，例如“为什么要养成阅读习惯”，系统会：

1. 用 LLM 生成标题和多段分镜文案。
2. 根据每段文案生成图片或视频提示词。
3. 调用 TTS 生成每段语音。
4. 根据模板渲染每个分镜画面。
5. 把画面和语音合成为片段。
6. 合并所有片段并可叠加 BGM。
7. 输出 `output/<task_id>/final.mp4`。

### 3.2 固定文案模式

如果你已经有完整文案，可以选择固定文案模式。系统不会重新生成文案，而是按规则切分：

- 按段落切分。
- 按行切分。
- 按句子切分。

这个模式适合小说解说、口播稿、课程脚本、固定台词类视频。

### 3.3 自定义素材

Web UI 的“自定义素材”标签页允许上传图片或视频，AI 会围绕这些素材生成脚本和配音。适合：

- 产品图解说。
- 旅行照片成片。
- 个人素材二创。
- 素材混剪类自动化。

支持上传格式包括 `jpg`、`jpeg`、`png`、`gif`、`webp`、`mp4`、`mov`、`avi`、`mkv`、`webm`。

### 3.4 数字人口播

Web UI 的“数字人口播”标签页用于生成数字人视频。代码里支持两类模式：

- `digital`：偏智能带货或商品讲解，可以上传人物形象和商品图片，让 AI 生成旁白。
- `customize`：使用自定义口播文本生成数字人口播。

默认 RunningHub 工作流：

- `workflows/runninghub/digital_image.json`
- `workflows/runninghub/digital_combination.json`
- `workflows/runninghub/digital_customize.json`

### 3.5 图生视频

图生视频标签页允许上传首帧图片，并输入视频提示词。它会调用 `i2v_*.json` 工作流。

当前仓库内置：

- `workflows/runninghub/i2v_LTX2.json`

适合：

- 图片动效化。
- 产品图变视频。
- 插画首帧转动态画面。

### 3.6 动作迁移

动作迁移标签页需要：

- 一个参考动作视频：`mp4`、`mkv`、`mov`。
- 一张待迁移动作图片：`jpg`、`jpeg`、`png`、`webp`。
- 一段动作提示词。

代码中限制/提示：

- 参考视频建议单人动作明显。
- 如果参考视频大于 30 秒，只取前 30 秒。
- 当前 RunningHub 工作流为 `workflows/runninghub/af_scail.json`。

## 4. 技术栈与目录结构

### 4.1 主要技术栈

- Python：项目包声明要求 `>=3.11`。
- Streamlit：Web UI。
- FastAPI + Uvicorn：HTTP API。
- OpenAI SDK 兼容接口：接入 Qwen、OpenAI、Claude、DeepSeek、Ollama、Moonshot 等。
- ComfyKit / ComfyUI：执行图片、视频、TTS 工作流。
- RunningHub：云端 ComfyUI 工作流服务。
- FFmpeg / ffmpeg-python / MoviePy：音视频合成、拼接、叠加、探测时长。
- Playwright Chromium：把 HTML 模板渲染成视频帧图片。
- Pydantic：配置和 API Schema。
- YAML：配置文件。

### 4.2 目录结构

核心目录：

```text
api/                 FastAPI 服务、路由、请求/响应模型、任务管理
web/                 Streamlit Web UI
pixelle_video/       核心服务、配置、流水线、模型、工具函数、Prompt
templates/           HTML 视频模板
workflows/           ComfyUI / RunningHub 工作流
bgm/                 内置背景音乐
resources/           README 和 Web UI 资源图
docs/                MkDocs 文档
packaging/windows/   Windows 便携包构建脚本和模板
output/              运行后生成，存放成片与中间产物
data/                Docker/用户自定义资源挂载目录
temp/                上传素材临时目录
```

核心代码文件：

- `pixelle_video/service.py`：`PixelleVideoCore` 总入口。
- `pixelle_video/pipelines/standard.py`：标准视频生成流水线。
- `pixelle_video/pipelines/asset_based.py`：自定义素材流水线。
- `pixelle_video/services/frame_processor.py`：单分镜处理，负责 TTS、媒体生成、模板合成、片段生成。
- `pixelle_video/services/video.py`：FFmpeg 视频合成服务。
- `pixelle_video/services/frame_html.py`：HTML 模板渲染服务。
- `pixelle_video/services/tts_service.py`：本地 Edge TTS 和 ComfyUI TTS。
- `pixelle_video/services/media.py`：图片/视频媒体生成。
- `api/app.py`：FastAPI 入口。
- `web/app.py`：Streamlit 多页面入口。

## 5. 架构分析

Pixelle-Video 是分层结构：

```text
Web UI / REST API
        ↓
PixelleVideoCore
        ↓
Pipeline 层
        ↓
LLM / TTS / Media / Frame / Video Services
        ↓
OpenAI-compatible LLM、Edge-TTS、ComfyUI、RunningHub、FFmpeg、Playwright
```

### 5.1 PixelleVideoCore

`PixelleVideoCore` 是服务聚合层，初始化后会挂载：

- `llm`：LLM 服务。
- `tts`：TTS 服务。
- `media` / `image`：图片或视频生成服务。
- `image_analysis`：图片分析服务。
- `video_analysis`：视频分析服务。
- `video`：视频合成服务。
- `frame_processor`：分镜处理服务。
- `persistence`：结果持久化服务。
- `history`：历史记录管理。
- `pipelines`：流水线注册表。

核心流水线包括：

- `standard`
- `custom`
- `asset_based`

Web UI 还注册了以下用户界面级 pipeline：

- 快速创作：`quick_create`
- 自定义素材：`custom_media`
- 数字人口播：`digital_human`
- 图生视频：`image_to_video`
- 动作迁移：`action_transfer`

### 5.2 标准视频生成流水线

`StandardPipeline` 的实际流程：

1. 创建任务目录：`output/<timestamp>_<random>/`
2. 生成/切分文案。
3. 生成或确定标题。
4. 根据模板类型决定是否需要图片/视频生成：
   - `static_*.html`：跳过媒体生成。
   - `image_*.html`：生成图片。
   - `video_*.html`：生成视频。
5. 创建 Storyboard。
6. 分镜处理：
   - 生成语音。
   - 生成图片或视频。
   - 通过 HTML 模板合成画面。
   - 生成单段视频。
7. 合并全部视频片段。
8. 可选叠加 BGM。
9. 保存 metadata、storyboard 和最终 `final.mp4`。

### 5.3 分镜处理细节

每个分镜由 `FrameProcessor` 处理：

1. TTS 生成 `audio.mp3`。
2. 图片或视频工作流生成媒体。
3. `HTMLFrameGenerator` 用模板渲染字幕、标题和媒体。
4. 如果是图片分镜，用静态图片 + 音频生成视频片段。
5. 如果是视频分镜，先叠加 HTML 透明层，再替换或合并语音。

关键设计点：

- 视频工作流会把 TTS 音频时长传给媒体生成，用来尽量保持音画同步。
- RunningHub 工作流支持并发，配置项为 `runninghub_concurrent_limit`，范围 1-10。
- 视频合成强依赖 FFmpeg。
- HTML 渲染强依赖 Playwright Chromium。

## 6. 安装教程

### 6.1 Windows 推荐方式：一键整合包

适合普通 Windows 用户。

步骤：

1. 打开 GitHub Releases。
2. 下载最新版 Windows 整合包：`Pixelle-Video-v0.1.15-win64.zip`。
3. 解压到一个不含特殊权限限制的目录，例如 `D:\Apps\Pixelle-Video`。
4. 双击 `start.bat`。
5. 浏览器打开 Web UI，一般是 `http://localhost:8501`。
6. 在系统配置中填写 LLM 和 RunningHub/ComfyUI 配置。

Windows 整合包包含：

- Python 3.11 嵌入式运行时。
- FFmpeg。
- 项目依赖。
- Web 启动脚本。
- API 启动脚本。
- `data/` 用户资源目录。
- `output/` 输出目录。

最低要求：

- Windows 10/11 64-bit。
- 4GB RAM，建议 8GB+。
- 可访问 LLM API 和 RunningHub/ComfyUI 的网络。
- Chrome、Edge 或 Firefox。

### 6.2 从源码安装

适合 macOS、Linux、开发者或需要改代码的用户。

建议环境：

- Python 3.11 或更高。
- `uv` 包管理器。
- FFmpeg。
- Playwright Chromium。
- 如需本地 ComfyUI：NVIDIA GPU，建议 6GB+ 显存，复杂视频模型通常需要更高显存。

安装步骤：

```bash
git clone https://github.com/AIDC-AI/Pixelle-Video.git
cd Pixelle-Video

# 安装 uv，如果尚未安装
curl -LsSf https://astral.sh/uv/install.sh | sh

# 同步依赖
uv sync

# 安装 Playwright Chromium，源码运行时建议执行
uv run playwright install --with-deps chromium
```

安装 FFmpeg：

```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt update
sudo apt install ffmpeg
```

Windows 源码用户可以从 FFmpeg 官网下载，并把 `bin` 目录加入 `PATH`。

启动 Web UI：

```bash
uv run streamlit run web/app.py
```

访问：

```text
http://localhost:8501
```

启动 API：

```bash
uv run uvicorn api.app:app --host 0.0.0.0 --port 8000
```

访问 API 文档：

```text
http://localhost:8000/docs
```

### 6.3 Docker 部署

仓库提供 `Dockerfile` 和 `docker-compose.yml`，会启动两个服务：

- `pixelle-video-api`：端口 `8000`
- `pixelle-video-web`：端口 `8501`

启动：

```bash
docker compose up -d
```

中国大陆网络环境可使用镜像参数：

```bash
USE_CN_MIRROR=true docker compose up -d
```

Docker 挂载：

- `./config.yaml:/app/config.yaml`
- `./data:/app/data`
- `./output:/app/output`

`init` 容器会在 `config.yaml` 不存在时从 `config.example.yaml` 复制一份。

注意：

- 如果 Docker 内访问宿主机 ComfyUI，Mac/Windows 通常用 `host.docker.internal:8188`。
- Linux Docker 需要使用宿主机 IP 或额外网络配置。

## 7. 配置教程

配置文件示例是 `config.example.yaml`。首次运行后，Web UI 会保存到 `config.yaml`。

### 7.1 LLM 配置

Pixelle-Video 支持 OpenAI SDK 兼容接口。内置预设：

| 预设 | Base URL | 默认模型 |
|---|---|---|
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-max` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Claude | `https://api.anthropic.com/v1/` | `claude-sonnet-4-5` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| Ollama | `http://localhost:11434/v1` | `llama3.2` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |

示例配置：

```yaml
llm:
  api_key: "你的 API Key"
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  model: "qwen-max"
```

Web UI 支持：

- 快速选择预设。
- 填写 API Key。
- 加载模型列表。
- 测试连接。
- 自定义模型名。

### 7.2 ComfyUI / RunningHub 配置

图片、视频和 ComfyUI TTS 能力由 `comfyui` 配置控制。

示例：

```yaml
comfyui:
  comfyui_url: http://127.0.0.1:8188
  comfyui_api_key: ""
  runninghub_api_key: ""
  runninghub_concurrent_limit: 1
  runninghub_instance_type: ""

  tts:
    inference_mode: local
    local:
      voice: zh-CN-YunjianNeural
      speed: 1.2
    comfyui:
      default_workflow: selfhost/tts_edge.json

  image:
    default_workflow: runninghub/image_flux.json
    prompt_prefix: "Minimalist black-and-white matchstick figure style illustration, clean lines, simple sketch style"

  video:
    default_workflow: runninghub/video_wan2.1_fusionx.json
    prompt_prefix: "Minimalist black-and-white matchstick figure style illustration, clean lines, simple sketch style"
```

两种媒体生成方式：

- RunningHub：推荐新手，无需本地 GPU，但需要 RunningHub API Key 和云端费用。
- 本地 ComfyUI：适合有 GPU 和模型部署能力的用户，可控性更强。

### 7.3 TTS 配置

TTS 支持两种模式：

1. `local`：本地 Edge TTS，默认模式，使用 `edge-tts==7.2.7`。
2. `comfyui`：通过 ComfyUI/RunningHub 的 TTS 工作流。

本地 Edge TTS 示例：

```yaml
comfyui:
  tts:
    inference_mode: local
    local:
      voice: zh-CN-YunjianNeural
      speed: 1.2
```

ComfyUI TTS 示例：

```yaml
comfyui:
  tts:
    inference_mode: comfyui
    comfyui:
      default_workflow: runninghub/tts_edge.json
```

声音克隆：

- Edge TTS 不支持声音克隆。
- 需要选择支持声音克隆的 TTS 工作流，例如 `tts_index2.json`。
- 参考音频建议 10-30 秒，清晰、无噪音，格式可用 MP3/WAV/FLAC。

### 7.4 模板配置

默认模板：

```yaml
template:
  default_template: "1080x1920/image_default.html"
```

模板类型：

- `static_*.html`：纯文字/静态模板，不需要图片或视频生成，速度快、成本低。
- `image_*.html`：图片模板，需要图片生成工作流。
- `video_*.html`：视频模板，需要视频生成工作流。

## 8. Web UI 使用教程

启动后打开：

```text
http://localhost:8501
```

Web UI 是多页应用：

- Home：生成视频。
- History：历史记录。

Home 页面包含：

- 系统配置。
- FAQ 侧边栏。
- 多个创作标签页。

### 8.1 首次配置

1. 展开“系统配置”。
2. 在 LLM 配置中选择预设，例如 Qwen 或 OpenAI。
3. 填入 API Key。
4. 可点击“测试连接”。
5. 在 ComfyUI 配置里：
   - 如果用 RunningHub：填 RunningHub API Key。
   - 如果用本地 ComfyUI：填 `http://127.0.0.1:8188`，点击测试连接。
6. 设置 RunningHub 并发数，普通用户建议先保持 `1`。
7. 保存配置。

### 8.2 快速创作：从主题生成视频

适合新手的最短路径：

1. 进入“快速创作”标签页。
2. 左侧选择“AI 生成内容”。
3. 输入主题：

   ```text
   为什么要养成阅读习惯
   ```

4. 设置分镜数量，建议首次使用 `3-5`。
5. 选择 BGM，或先不选。
6. 中间配置语音：
   - 新手建议本地 Edge TTS。
   - 选择音色和语速。
7. 中间配置视觉：
   - 新手建议先用 `static_*.html` 模板验证流程。
   - 需要图片效果时选择 `image_default.html`。
   - 需要动态背景时选择 `video_default.html`。
8. 点击“生成视频”。
9. 等待进度：
   - 生成标题/文案。
   - 生成图片提示词。
   - 逐分镜生成语音和媒体。
   - 合成片段。
   - 拼接最终视频。
10. 右侧预览视频。
11. 输出文件在 `output/<task_id>/final.mp4`。

### 8.3 固定文案生成视频

适合已有脚本。

示例文案：

```text
真正拉开差距的，不是一天的努力。
而是每天重复的小习惯。
阅读，就是最容易被低估的复利。
```

步骤：

1. 进入“快速创作”。
2. 选择“固定文案内容”。
3. 粘贴完整文案。
4. 选择切分方式：
   - 短句型文案：按行。
   - 段落型文案：按段落。
   - 长文章：按句子。
5. 配置语音、模板、BGM。
6. 生成视频。

注意：固定文案模式会忽略 `n_scenes`，实际分镜数量由切分结果决定。

### 8.4 自定义素材成片

步骤：

1. 进入“自定义素材”标签页。
2. 上传图片或视频素材。
3. 填写视频标题。
4. 填写创作意图，例如：

   ```text
   做成适合小红书发布的旅行治愈短视频，语气温柔，突出傍晚海边的松弛感。
   ```

5. 选择时长，范围 15-120 秒。
6. 选择 RunningHub 或 selfhost。
7. 配置 TTS 音色和语速。
8. 选择 BGM。
9. 生成视频。

### 8.5 数字人口播

步骤：

1. 进入“数字人口播”。
2. 上传人物形象图片，建议清晰正面图。
3. 选择 RunningHub 或 selfhost。
4. 选择模式：
   - `digital`：商品/带货型。
   - `customize`：自定义口播。
5. 如果是商品口播，上传商品图并填写商品名或商品介绍。
6. 如果是自定义口播，直接输入完整口播文案。
7. 选择 TTS/音频配置。
8. 生成视频。

建议：

- 商品图和人物图尽量清晰。
- 口播文案不要过长，先用 15-30 秒测试。
- RunningHub 模式更适合新手。

### 8.6 图生视频

步骤：

1. 进入“图生视频”。
2. 上传首帧图像。
3. 输入视频提示词，例如：

   ```text
   镜头缓慢推进，人物头发轻微飘动，背景有柔和光影变化，整体电影感，暖色调。
   ```

4. 选择图生视频工作流，例如 `runninghub/i2v_LTX2.json`。
5. 生成视频。

提示词建议包含：

- 镜头运动。
- 主体动作。
- 背景变化。
- 画面风格。
- 节奏和时长要求。

### 8.7 动作迁移

步骤：

1. 进入“动作迁移”。
2. 上传参考动作视频，建议单人、动作清晰、30 秒以内。
3. 上传目标图片，建议单人主体清晰。
4. 输入提示词，例如：

   ```text
   模仿参考视频跳舞，人物位置保持稳定，动作节奏一致，背景尽量不变。
   ```

5. 选择动作迁移工作流。
6. 生成视频。

## 9. API 使用教程

Pixelle-Video 提供 Python SDK 和 HTTP REST API。

### 9.1 Python SDK

基础示例：

```python
import asyncio
from pixelle_video.service import PixelleVideoCore

async def main():
    pixelle = PixelleVideoCore()
    await pixelle.initialize()

    result = await pixelle.generate_video(
        text="为什么要养成阅读习惯",
        mode="generate",
        n_scenes=5,
        frame_template="1080x1920/image_default.html",
        media_workflow="runninghub/image_flux.json",
        tts_inference_mode="local",
        tts_voice="zh-CN-YunjianNeural",
        tts_speed=1.2,
        bgm_path="bgm/default.mp3",
        bgm_volume=0.3,
    )

    print(result.video_path)
    print(result.duration)
    print(result.file_size)

    await pixelle.cleanup()

asyncio.run(main())
```

固定文案示例：

```python
import asyncio
from pixelle_video.service import PixelleVideoCore

script = """真正拉开差距的，不是一天的努力。
而是每天重复的小习惯。
阅读，就是最容易被低估的复利。"""

async def main():
    pixelle = PixelleVideoCore()
    await pixelle.initialize()

    result = await pixelle.generate_video(
        text=script,
        mode="fixed",
        split_mode="line",
        title="阅读的复利",
        frame_template="1080x1920/static_default.html",
        tts_inference_mode="local",
    )

    print(result.video_path)
    await pixelle.cleanup()

asyncio.run(main())
```

常用参数：

| 参数 | 说明 |
|---|---|
| `text` | 主题或完整文案 |
| `mode` | `generate` 或 `fixed` |
| `n_scenes` | AI 生成模式下的分镜数量，1-20 |
| `split_mode` | 固定文案切分方式：`paragraph`、`line`、`sentence` |
| `title` | 视频标题，不传会自动生成 |
| `min_narration_words` / `max_narration_words` | 每段文案长度约束 |
| `min_image_prompt_words` / `max_image_prompt_words` | 图片提示词长度约束 |
| `media_workflow` | 图片或视频工作流 |
| `frame_template` | HTML 模板路径 |
| `template_params` | 自定义模板变量 |
| `video_fps` | 帧率，API Schema 限制 15-60 |
| `tts_inference_mode` | `local` 或 `comfyui` |
| `tts_voice` / `voice_id` | 音色 |
| `tts_speed` | 语速 |
| `tts_workflow` | ComfyUI TTS 工作流 |
| `ref_audio` | 声音克隆参考音频 |
| `prompt_prefix` | 媒体提示词风格前缀 |
| `bgm_path` | 背景音乐路径 |
| `bgm_volume` | BGM 音量，0.0-1.0 |

### 9.2 启动 REST API

```bash
uv run uvicorn api.app:app --host 0.0.0.0 --port 8000
```

访问：

```text
http://localhost:8000/docs
```

### 9.3 同步生成视频

接口：

```text
POST /api/video/generate/sync
```

示例：

```bash
curl -X POST http://localhost:8000/api/video/generate/sync \
  -H "Content-Type: application/json" \
  -d '{
    "text": "为什么要养成阅读习惯",
    "mode": "generate",
    "n_scenes": 5,
    "frame_template": "1080x1920/image_default.html",
    "media_workflow": "runninghub/image_flux.json",
    "video_fps": 30,
    "title": "阅读的力量",
    "bgm_path": "bgm/default.mp3",
    "bgm_volume": 0.3
  }'
```

响应：

```json
{
  "success": true,
  "message": "Success",
  "video_url": "http://localhost:8000/api/files/<task_id>/final.mp4",
  "duration": 45.5,
  "file_size": 12345678
}
```

注意：

- `frame_template` 在当前路由实现里是必需的，因为接口会从模板 meta 标签推断媒体尺寸。
- 同步接口适合短视频。长视频建议使用异步接口。

### 9.4 异步生成视频

接口：

```text
POST /api/video/generate/async
```

请求体与同步接口基本相同。

响应：

```json
{
  "success": true,
  "message": "Task created successfully",
  "task_id": "abc123"
}
```

查询任务：

```bash
curl http://localhost:8000/api/tasks/abc123
```

任务状态包括：

- `pending`
- `running`
- `completed`
- `failed`
- `cancelled`

取消任务：

```bash
curl -X DELETE http://localhost:8000/api/tasks/abc123
```

### 9.5 LLM 接口

```text
POST /api/llm/chat
```

示例：

```bash
curl -X POST http://localhost:8000/api/llm/chat \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "给我 5 个关于阅读习惯的短视频标题",
    "temperature": 0.7,
    "max_tokens": 500
  }'
```

### 9.6 内容生成接口

生成分镜文案：

```text
POST /api/content/narration
```

生成图片提示词：

```text
POST /api/content/image-prompt
```

生成标题：

```text
POST /api/content/title
```

这些接口适合把 Pixelle-Video 拆成“脚本生成”和“视频生成”两段流水线。

### 9.7 TTS 接口

```text
POST /api/tts/synthesize
```

示例：

```bash
curl -X POST http://localhost:8000/api/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{
    "text": "欢迎使用 Pixelle-Video",
    "workflow": "runninghub/tts_edge.json"
  }'
```

声音克隆示例：

```json
{
  "text": "这是一段克隆声音测试",
  "workflow": "runninghub/tts_index2.json",
  "ref_audio": "path/to/reference.wav"
}
```

### 9.8 图片生成接口

```text
POST /api/image/generate
```

示例：

```bash
curl -X POST http://localhost:8000/api/image/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a minimalist black-and-white illustration of a person reading",
    "width": 1024,
    "height": 1024,
    "workflow": "runninghub/image_flux.json"
  }'
```

### 9.9 资源发现接口

列出 TTS 工作流：

```text
GET /api/resources/workflows/tts
```

列出媒体工作流：

```text
GET /api/resources/workflows/media
```

列出图片工作流：

```text
GET /api/resources/workflows/image
```

列出模板：

```text
GET /api/resources/templates
```

列出 BGM：

```text
GET /api/resources/bgm
```

### 9.10 模板渲染接口

渲染单帧：

```text
POST /api/frame/render
```

查看模板可配置参数：

```text
GET /api/frame/template/params?template=1080x1920/image_default.html
```

这个接口会解析模板里的 DSL：

```html
{{accent_color:color=#ff0000}}
{{custom_text:text=Hello World}}
{{show_title:bool=true}}
{{font_size:number=48}}
```

支持参数类型：

- `text`
- `number`
- `color`
- `bool`

## 10. 模板教程

### 10.1 内置模板

仓库当前有 31 个 HTML 模板。

竖屏 `1080x1920`：

- `asset_default.html`
- `image_blur_card.html`
- `image_book.html`
- `image_cartoon.html`
- `image_default.html`
- `image_elegant.html`
- `image_excerpt.html`
- `image_fashion_vintage.html`
- `image_full.html`
- `image_healing.html`
- `image_health_preservation.html`
- `image_life_insights.html`
- `image_life_insights_light.html`
- `image_long_text.html`
- `image_modern.html`
- `image_neon.html`
- `image_psychology_card.html`
- `image_purple.html`
- `image_satirical_cartoon.html`
- `image_simple_black.html`
- `image_simple_line_drawing.html`
- `static_default.html`
- `static_excerpt.html`
- `video_default.html`
- `video_healing.html`

横屏 `1920x1080`：

- `image_book.html`
- `image_film.html`
- `image_full.html`
- `image_ultrawide_minimal.html`
- `image_wide_darktech.html`

方形 `1080x1080`：

- `image_minimal_framed.html`

### 10.2 模板命名规则

- `static_`：不生成 AI 媒体，适合纯文字、金句、低成本批量生成。
- `image_`：每个分镜生成图片，再合成视频。
- `video_`：每个分镜生成动态视频，再叠加字幕和语音。

### 10.3 创建自定义模板

步骤：

1. 复制一个现有模板。
2. 放到对应尺寸目录，例如 `templates/1080x1920/my_style.html`。
3. 修改 HTML/CSS。
4. 在 Web UI 或 API 里选择 `1080x1920/my_style.html`。

最小模板示例：

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="template:media-width" content="1024">
  <meta name="template:media-height" content="1024">
  <style>
    body {
      width: 1080px;
      height: 1920px;
      margin: 0;
      font-family: Arial, sans-serif;
      background: #111;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .text {
      font-size: 54px;
      line-height: 1.5;
      padding: 80px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="text">{{ text }}</div>
</body>
</html>
```

如果模板需要 AI 图片，应使用 `{{ image }}`：

```html
<img src="{{ image }}" class="background">
<div class="caption">{{ text }}</div>
```

### 10.4 模板开发注意事项

- `body` 的宽高必须与目录尺寸一致。
- 建议添加 `template:media-width` 和 `template:media-height`，API 会读取它们来决定生成媒体尺寸。
- 字体要考虑中文显示，Docker 镜像已安装 `fonts-noto-cjk`。
- 文字区域必须留足空间，避免长文案溢出。
- 视频模板通常需要透明叠加层，避免遮挡主体。
- 自定义模板参数可以通过 `template_params` 注入。

## 11. 工作流教程

### 11.1 工作流目录

工作流分为：

```text
workflows/runninghub/   云端 RunningHub 工作流
workflows/selfhost/     本地 ComfyUI 工作流
```

当前 RunningHub 工作流：

- `af_scail.json`
- `analyse_image.json`
- `digital_combination.json`
- `digital_customize.json`
- `digital_image.json`
- `i2v_LTX2.json`
- `image_flux.json`
- `image_flux2.json`
- `image_qwen.json`
- `image_qwen_chinese_cartoon.json`
- `image_sd3.5.json`
- `image_sdxl.json`
- `image_Z-image.json`
- `tts_edge.json`
- `tts_index2.json`
- `tts_spark.json`
- `video_qwen_wan2.2.json`
- `video_understanding.json`
- `video_wan2.1_fusionx.json`
- `video_wan2.2.json`
- `video_Z_image_wan2.2.json`

当前 selfhost 工作流：

- `analyse_image.json`
- `analyse_video.json`
- `image_flux.json`
- `image_nano_banana.json`
- `image_qwen.json`
- `tts_edge.json`
- `tts_index2.json`
- `video_wan2.1_fusionx.json`

### 11.2 工作流类型

- `tts_*.json`：文本转语音。
- `image_*.json`：文生图。
- `video_*.json`：文生视频或视频生成。
- `i2v_*.json`：图生视频。
- `af_*.json`：动作迁移。
- `analyse_*.json`：图片/视频分析。
- `digital_*.json`：数字人相关。

### 11.3 RunningHub 工作流

RunningHub JSON 通常包含 `workflow_id`。Pixelle-Video 执行时会把 `workflow_id` 交给 ComfyKit，由 ComfyKit 调用 RunningHub。

优点：

- 新手友好。
- 不需要本地 GPU。
- 复杂视频模型更容易跑通。

缺点：

- 依赖外部服务。
- 可能产生费用。
- 网络和服务排队会影响速度。

### 11.4 selfhost 工作流

selfhost JSON 是 ComfyUI 原生工作流。执行时会把工作流文件路径交给本地 ComfyUI。

优点：

- 可控性强。
- 长期成本可低。
- 可以自定义模型、节点、LoRA、采样器。

缺点：

- 部署复杂。
- 需要安装 ComfyUI 自定义节点。
- 需要下载模型。
- 对 GPU 显存要求较高。

### 11.5 自定义工作流步骤

1. 在 ComfyUI 中设计工作流。
2. 用明确的变量节点标题暴露参数，例如：
   - `$prompt.value!`
   - `$width.value`
   - `$height.value`
   - `$text.value!`
   - `$ref_audio.audio`
3. 导出 JSON。
4. 放入：
   - `workflows/selfhost/`
   - 或 `data/workflows/`，如果使用用户自定义资源目录。
5. 文件名按能力前缀命名，例如 `image_my_model.json`。
6. 在 Web UI 或 API 中选择该工作流。

## 12. 推荐使用方案

### 12.1 新手最低成本试跑

目标：先确认整个软件能跑通。

推荐：

- LLM：Qwen 或 DeepSeek。
- TTS：本地 Edge TTS。
- 模板：`1080x1920/static_default.html`。
- 媒体生成：不启用，因为 static 模板不需要。
- 分镜：3。

优点：

- 不依赖 ComfyUI/RunningHub。
- 成本低。
- 失败点少。

### 12.2 常规图文短视频

目标：批量生成抖音/小红书图文视频。

推荐：

- LLM：Qwen。
- TTS：本地 Edge TTS。
- 模板：`1080x1920/image_default.html`、`image_modern.html`、`image_book.html`。
- 媒体工作流：`runninghub/image_flux.json` 或本地 `selfhost/image_flux.json`。
- BGM：低音量，`0.15-0.3`。
- 分镜：5-8。

### 12.3 动态 AI 视频

目标：每个分镜背景是动态视频。

推荐：

- 模板：`1080x1920/video_default.html` 或 `video_healing.html`。
- 媒体工作流：`runninghub/video_wan2.1_fusionx.json`、`video_wan2.2.json` 等。
- 分镜：先用 3 个测试。
- RunningHub 并发：先 1，稳定后再提高。

### 12.4 本地私有化部署

目标：数据和模型尽量本地化。

推荐：

- LLM：Ollama，本地 `llama3.2` 或更强模型。
- TTS：本地 Edge TTS，或本地 ComfyUI TTS。
- 媒体：本地 ComfyUI。
- API：内网部署 FastAPI。
- Web：内网部署 Streamlit。

仍需注意：

- Edge TTS 本身可能依赖网络服务。
- 如果完全离线，需要替换为本地 TTS 工作流。

## 13. 常见问题与排查

### 13.1 `ffmpeg not found`

原因：系统没有安装 FFmpeg，或未加入 PATH。

解决：

```bash
ffmpeg -version
```

如果命令不存在，按系统安装 FFmpeg。

### 13.2 Playwright / Chrome executable not found

现象：生成失败，提示找不到 Chrome/Chromium。

解决：

```bash
uv run playwright install --with-deps chromium
```

Windows 整合包理论上应内置相关依赖；源码运行更容易遇到此问题。

### 13.3 LLM API 调用失败

检查：

- API Key 是否正确。
- Base URL 是否匹配 provider。
- 模型名是否存在。
- 账户余额。
- 网络代理。

Web UI 中可以使用“测试连接”。

### 13.4 ComfyUI 连接失败

检查：

- ComfyUI 是否启动。
- URL 是否正确，默认 `http://127.0.0.1:8188`。
- Docker 内访问宿主机是否应使用 `host.docker.internal`。
- 防火墙是否阻止。
- ComfyUI API Key 是否需要填写。

### 13.5 工作流导入缺模型

常见于 selfhost 视频工作流，例如 WAN/FusionX。

解决思路：

- 在 ComfyUI 中打开对应 JSON，看缺失节点和模型。
- 安装所需自定义节点。
- 下载模型到正确目录。
- 先在 ComfyUI 中手动跑通，再交给 Pixelle-Video 调用。

### 13.6 生成速度慢

优化：

- 减少分镜数量。
- 先用 static 模板。
- 使用更快的图片模型。
- 使用本地 ComfyUI。
- RunningHub 用户可适当提高 `runninghub_concurrent_limit`。
- 降低媒体尺寸或选择更轻的工作流。

### 13.7 视频效果不满意

可调整：

- 主题写得更具体。
- 固定文案替代 AI 生成文案。
- 调整 `prompt_prefix`。
- 更换模板。
- 更换 LLM。
- 更换 TTS 音色。
- 更换媒体工作流。

## 14. 代码质量与风险评估

### 14.1 优点

- 功能覆盖完整：从主题到成片的链路已经打通。
- 模块边界清晰：LLM、TTS、Media、Frame、Video、Pipeline 分层明显。
- 同时支持 Web UI、Python SDK、REST API。
- 模板系统灵活，用 HTML/CSS 即可扩展视觉风格。
- 工作流系统开放，能接 RunningHub 和本地 ComfyUI。
- 对新手友好，Windows 一键包降低环境门槛。
- RunningHub 并发处理逻辑已经考虑到批量任务效率。
- 输出任务目录隔离，便于历史记录和问题排查。

### 14.2 主要不足

- 官方文档仍偏简略，很多真实参数和行为需要读代码。
- `docs` 中写 Python 3.10+，但 `pyproject.toml` 声明 `>=3.11`；实际建议按 3.11+。
- 仓库没有实际测试目录，虽然声明了 pytest 配置和 dev 依赖。
- Web UI 中部分高级 pipeline 的实现和文档不完全同步。
- 生产部署缺少认证、权限、用户隔离和配额控制。
- 文件服务需要特别关注路径访问安全。
- 任务管理更偏内存型，长期生产运行需要持久化队列或任务存储。
- 错误处理对普通用户仍可能不够可读，尤其是 ComfyUI 节点/模型缺失。

### 14.3 安全注意点

当前 `api/routers/files.py` 提供 `/api/files/{file_path}` 文件访问。代码意图限制访问 `output/`、`workflows/`、`templates/`、`bgm/`、`data/bgm/`、`data/templates/`、`resources/`。

但 GitHub 当前有一个开放 PR：`#175 fix(files): prevent path traversal in file serving endpoint`。这说明维护者或贡献者已经注意到文件服务可能存在路径遍历问题。若你要公网部署，不建议直接暴露当前 API，至少应：

- 等待并合并路径遍历修复。
- 增加鉴权。
- 对文件路径做 `resolve()` 后的白名单目录校验。
- 禁止访问工作流和模板源码，除非业务确实需要。
- 通过反向代理限制可访问路径。

### 14.4 生产化建议

如果要把 Pixelle-Video 用作团队生产工具，建议补齐：

- 登录鉴权。
- 用户级 output/data 隔离。
- 文件访问签名 URL。
- 任务队列，例如 Celery、RQ、Arq 或自建队列。
- Redis/Postgres 持久化任务状态。
- API 限流。
- LLM/RunningHub Key 加密存储。
- 统一日志与错误码。
- 自动清理 temp/output。
- 基础测试覆盖。
- Docker 镜像版本锁定。
- 监控：任务耗时、失败率、外部服务错误、磁盘占用。

## 15. 二次开发指南

### 15.1 增加一个新模板

1. 复制 `templates/1080x1920/image_default.html`。
2. 改名为 `templates/1080x1920/image_my_brand.html`。
3. 修改 CSS。
4. 可增加自定义参数：

```html
<div style="color: {{brand_color:color=#ff3366}}">
  {{ text }}
</div>
```

5. API 调用时传：

```json
{
  "frame_template": "1080x1920/image_my_brand.html",
  "template_params": {
    "brand_color": "#00aaff"
  }
}
```

### 15.2 增加一个新图片工作流

1. 在 ComfyUI 中做一个文生图工作流。
2. 暴露参数：
   - prompt
   - width
   - height
3. 导出 JSON。
4. 保存为 `workflows/selfhost/image_my_model.json`。
5. 在配置或 API 中使用：

```json
{
  "media_workflow": "selfhost/image_my_model.json"
}
```

### 15.3 增加一个新 Web UI Pipeline

可参考 `web/pipelines/base.py` 和现有 pipeline：

1. 新建 `web/pipelines/my_pipeline.py`。
2. 继承 `PipelineUI`。
3. 设置 `name`、`icon`、`display_name`、`description`。
4. 实现 `render(self, pixelle_video)`。
5. 调用 `register_pipeline_ui(MyPipelineUI)`。
6. 在 `web/pipelines/__init__.py` import 新模块。

### 15.4 增加 REST API 能力

1. 在 `api/schemas/` 中定义请求/响应模型。
2. 在 `api/routers/` 中新增路由。
3. 在 `api/app.py` include router。
4. 复用 `PixelleVideoDep` 获取核心服务。
5. 在 Swagger UI 验证。

## 16. 最佳实践

### 16.1 提示词写法

主题不要太泛，例如：

差：

```text
阅读
```

好：

```text
为什么每天睡前阅读 15 分钟，会悄悄改变一个人的表达能力和思考深度
```

图片风格前缀建议明确：

```text
clean editorial illustration, warm light, soft contrast, realistic paper texture, no text in image
```

视频提示词建议包含动作：

```text
slow camera push in, gentle wind, warm sunset light, subtle background motion, cinematic color grading
```

### 16.2 分镜数量

- 测试：3。
- 常规短视频：5-8。
- 长文案：10-20。

分镜越多，LLM、TTS、媒体生成和 FFmpeg 合成时间都会增加。

### 16.3 模板选择

- 测试流程：`static_default.html`。
- 知识科普：`image_book.html`、`image_psychology_card.html`。
- 情绪/疗愈：`image_healing.html`、`video_healing.html`。
- 商务/科技：`image_modern.html`、`1920x1080/image_wide_darktech.html`。
- B站/YouTube：`1920x1080/image_film.html`、`image_full.html`。
- 小红书方图：`1080x1080/image_minimal_framed.html`。

### 16.4 成本控制

最低成本：

- Ollama + static 模板 + Edge TTS。

中等成本：

- Qwen/DeepSeek + RunningHub 图片工作流 + Edge TTS。

高成本：

- OpenAI/Claude + RunningHub 视频工作流 + 声音克隆 + 多分镜。

### 16.5 调试顺序

遇到失败时，不要直接跑完整视频。建议按顺序拆开：

1. 测试 LLM。
2. 测试 TTS。
3. 测试图片或视频工作流。
4. 测试模板渲染。
5. 测试 1 个分镜。
6. 测试完整视频。

## 17. 结论

Pixelle-Video 是一个完成度较高的 AI 短视频自动生成项目，最大的价值是把 LLM、TTS、ComfyUI/RunningHub、HTML 模板和 FFmpeg 串成了可用的端到端流水线。它对普通用户提供 Windows 一键包和 Streamlit Web UI，对开发者提供 Python SDK、REST API、模板和工作流扩展点。

如果你的目标是快速搭建“批量短视频生成工具”，它值得重点尝试。建议先用 static 模板跑通，再逐步接入图片工作流、视频工作流、数字人和动作迁移。若要生产化或公网部署，需要重点补强安全、鉴权、任务持久化和测试。

## 18. 参考来源

- GitHub 仓库：https://github.com/AIDC-AI/Pixelle-Video
- 最新 Release：https://github.com/AIDC-AI/Pixelle-Video/releases/tag/v0.1.15
- 官方中文文档：https://aidc-ai.github.io/Pixelle-Video/zh
- GitHub 最新提交：https://github.com/AIDC-AI/Pixelle-Video/commit/db2e43a121a60b5042f72bec3f2627772dd401d6
- GitHub Issues：https://github.com/AIDC-AI/Pixelle-Video/issues
- 路径遍历修复 PR：https://github.com/AIDC-AI/Pixelle-Video/pull/175
- uv 安装文档：https://docs.astral.sh/uv/getting-started/installation/
- ComfyUI 仓库：https://github.com/comfyanonymous/ComfyUI
- FFmpeg 官网：https://ffmpeg.org/download.html
