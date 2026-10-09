# agentsmaster

跑在你自己电脑上的 Agent 主机。它在本机登记项目和编程代理，配对之后，把对话、浏览器和桌面操作留在这台电脑上执行。

这个仓库只有电脑端服务，以及它和手机之间的协议。手机页面和云端中转不在这里。

## 准备

- Node.js 22 或更新版本
- Git
- Chrome（要用浏览器时）
- 已登录的 Cursor CLI（命令 `agent`），要用 Cursor 时

## 启动

```bash
npm install
npm run server
```

浏览器打开 http://127.0.0.1:8787/setup ，在这里登记项目和代理。

手机配对要经过你自己的中转。启动前可以设置：

```bash
CLOUD_URL=
CLOUD_PUBLIC_URL=
```

看截图、以及 Pi 代理，需要模型密钥：

```bash
DASHSCOPE_API_KEY=
DASHSCOPE_BASE_URL=
VISION_MODEL=
LLM_API_KEY=
LLM_BASE_URL=
```

这些可以写在项目目录的 `.env` 里，启动时会自动读取。不要把 `.env` 提交到仓库。

## 许可

MIT
