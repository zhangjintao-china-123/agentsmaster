# agentsmaster

跑在你自己电脑上的 Agent 主机。它在本机登记项目和编程代理，配对之后，把对话、浏览器和桌面操作留在这台电脑上执行。

这个仓库只有电脑端服务，以及它和手机之间的协议。手机页面和云端中转不在这里。

## 依赖

运行服务只需要 **Node.js 22** 或更新版本。下面这些程序是按功能选用的。没装时服务照常启动，不会退出；用到那一项时，会在当次操作里说明缺什么。

- **Cursor CLI**：命令 `agent`，并已执行 `agent login`。只用 Cursor 通道时需要。安装说明见 [Cursor CLI](https://cursor.com/docs/cli/overview)。
- **Git**：查看改动和提交时需要。
- **Google Chrome**：使用浏览器时需要。
- **swiftc**（macOS 命令行工具）：使用桌面画面和键鼠时需要。
- **csc**（Windows 上的 .NET Framework 编译器）：在 Windows 上使用桌面画面和键鼠时需要。
- **opencode**、**claude**、**codex**：使用对应通道时需要，并且要在本机登录。

Pi 通道和看截图不依赖上面的命令，改读环境变量里的模型密钥，见下方启动说明。

## 启动

```bash
npm install
npm run server
```

浏览器打开 http://127.0.0.1:8787/setup ，在这里登记项目和代理。

## 浏览器

手机上看的是本机 `127.0.0.1:9222` 上的 Google Chrome。手机浏览器页里的「端口」可以改这个调试端口，改过之后会记住。也可以在启动前用 `CHROME_DEBUG_PORT` 指定初始端口。这个端口已经有 Chrome 在听，就接上现有的那个；否则用配置目录 `~/.agentsmaster/chrome` 启动。

Agent 操作网页时必须使用 Chrome 的 MCP，并连接到这个调试地址。这才是手机正在看的那个浏览器。Cursor 自带的浏览器是另一个窗口，手机上看不到。

手机配对地址在启动时写入 `CLOUD_PUBLIC_URL`。没另外指定时，默认是 `https://agents.pptxgen.com`。要换成自己的地址，启动前设置这个变量。电脑连上中转还要设置 `CLOUD_URL`。

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
