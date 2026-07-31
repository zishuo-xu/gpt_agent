# MyAgent - 无人值守编码 Agent

MyAgent 是一个面向长时间自主运行任务的本机编码 Agent。目前处于第一期开发阶段。

## 当前里程碑

- 结构化事件流与 JSONL 会话存储
- strict / normal / trust 权限引擎
- Read / Edit / MultiEdit / Write / Bash 工具
- 原子文件编辑与可验证的 EditJournal 回滚
- 模型与工具的统一硬中止信号
- 可交互 CLI 骨架
- 本地 Web 模型设置页
- Anthropic 与 OpenAI-compatible 第三方渠道配置
- main / cheap / explore 角色模型选择
- 真实最小模型请求的连接测试（认证、模型、延迟与错误分类）
- CLI 读取 main 角色配置执行真实自然语言编码任务
- Anthropic tool_use 与 OpenAI-compatible function calling 统一适配
- Web 新建会话、连续追问、实时事件流、工具过程与远程审批

## 本地开发

```bash
npm install
npm test
npm run build
npm run dev
```

先在 Web 页面保存并测试 main 模型，再运行：

```bash
npm run dev
```

直接输入自然语言任务。模型可以调用 Read、Edit、MultiEdit、Write 和 Bash；需要审批时 CLI 会暂停询问，运行中按 `Ctrl+C` 可中止模型与当前工具。

启动 Web 设置页：

```bash
npm run web
```

终端会打印实际访问地址，默认是 `http://127.0.0.1:3000`；端口被占用时会自动选择下一个可用端口。API Key 会写入本机配置文件，但读取配置时不会回传明文。

Web 默认进入监控台，可直接输入任务创建会话；会话运行时页面实时显示模型文本、工具调用、token 用量和审批请求。任务完成后可在同一会话继续追问。
