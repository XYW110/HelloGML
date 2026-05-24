## GLM-Free-API Worker

智谱清言网页版私有 API 的 Cloudflare Worker 代理层，提供 OpenAI / Claude / Gemini 三种协议兼容接口。

## Overview

本项目将智谱清言（chatglm.cn）网页端的私有流式 API 转换为标准的大语言模型服务接口，使任何支持 OpenAI、Claude 或 Gemini 协议的客户端都能直接调用 GLM 系列模型的能力。采用 Cloudflare Workers 运行时，具备零服务器成本、全球边缘部署、无状态架构和即时扩缩容等优势。

核心架构基于认证与资源分离设计：API Key 仅用于身份验证，所有 refresh_token 组成统一池子按轮询策略调度。支持自动补池、Token 健康检查、流式 SSE 转发、工具调用协议转换等高级功能，一次部署后完全自主运行。

## Technology Stack

- **Language/Runtime**: TypeScript / Cloudflare Workers (V8 Isolate)
- **Framework(s)**: Wrangler (Cloudflare Workers 开发框架)
- **Key Dependencies**: @cloudflare/workers-types, wrangler
- **Build Tools**: Wrangler CLI, TypeScript Compiler
- **Storage**: Cloudflare KV (Token 映射), Cache API (access_token 缓存)
- **Streaming**: Web Streams API + 手写 SSE 解析器

## Project Structure

```
HelloGML/
├── src/
│   ├── index.ts          # Worker 入口，路由分发，认证，Token 池管理，内存缓存
│   ├── chat.ts           # 智谱 API 调用，签名算法，SSE 流处理，工具调用解析
│   ├── adapters.ts       # Claude/Gemini 协议适配层，格式转换
│   ├── admin-panel.ts    # 管理面板 HTML/API，Token/ApiKey/AutoFill 管理接口
│   ├── sse.ts            # SSE 流式响应工具函数
│   ├── token-health.ts   # Token 健康检查，失败分类，上报机制
│   ├── utils.ts          # 通用工具函数
│   └── welcome.ts        # 欢迎页面 HTML
├── dist/                 # 构建输出目录
├── .wrangler/            # Wrangler 本地开发状态
├── wrangler.toml         # Cloudflare Workers 配置文件
├── tsconfig.json         # TypeScript 配置
├── package.json          # 项目依赖与脚本
└── README.md             # 完整项目文档
```

## Key Features

- 多协议兼容：同时支持 OpenAI / Claude / Gemini 三种请求格式
- 流式响应：完整 SSE 流式输出，支持 reasoning_content 思考过程
- 动态 Token 管理：认证与资源分离，Token 池轮询调度
- 自动补池：自动抓取游客 Token，定时巡检清理失效 Token
- AI 绘图与视频生成：对接智谱清言多媒体智能体
- 工具调用：Prompt Engineering + 后处理解析实现 Function Calling
- 联网搜索：模型自动触发，结果通过 reasoning_content 返回
- 长文档/图像解析：支持 BASE64 图像上传与长文本上下文

## Getting Started

### Prerequisites

- Node.js 18+
- Cloudflare 账号（免费版即可）
- 智谱清言账号及 chatglm_refresh_token

### Installation

```bash
npm install
```

### Usage

```bash
# 本地开发（自动模拟 KV 和 Cache）
npm run dev

# 部署到 Cloudflare
npm run deploy
```

本地服务默认运行在 `http://localhost:8787`。

## Development

### Available Scripts

- `npm run dev` - 启动本地开发服务器 (wrangler dev)
- `npm run start` - 同 dev
- `npm run deploy` - 部署到 Cloudflare Workers

### Development Workflow

1. 修改 `src/` 下的 TypeScript 源码
2. `npm run dev` 启动本地预览，Wrangler 自动热重载
3. 使用 curl 或 Postman 测试 API 端点
4. `npm run deploy` 发布到生产环境

## Configuration

关键配置位于 `wrangler.toml`：

- `SIGN_SECRET` - 智谱请求签名密钥
- `ADMIN_KEY` - 管理接口保护密钥（生产环境务必修改）
- `AUTO_FILL_ENABLED` - 是否启用自动补池
- `AUTO_FILL_TARGET` - 目标 Token 数量
- `AUTO_FILL_CRON` - 定时巡检 Cron 表达式
- `[[kv_namespaces]]` - KV Namespace 绑定（需先创建）

## Architecture

```
客户端 → Cloudflare Worker (V8) → chatglm.cn 私有 API
              │
              ├── KV: api_key 映射 + Token 池
              ├── Cache: access_token 缓存
              ├── 内存缓存: 减少 KV 读取
              ├── 签名算法: 请求鉴权
              └── 协议适配层: OpenAI/Claude/Gemini ↔ 智谱格式
```

请求流程：验证 API Key → 轮询选择 refresh_token → 换取 access_token → 构造签名请求 → 调用智谱流式接口 → 协议转换返回。

## Contributing

1. Fork 本仓库
2. 创建特性分支
3. 提交更改并确保 TypeScript 编译通过
4. 发起 Pull Request

## License

参见 LICENSE 文件。本项目仅供学习研究交流使用。
