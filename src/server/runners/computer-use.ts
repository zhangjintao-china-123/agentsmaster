import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  clickMouse,
  focusWindow,
  launchApplication,
  listWindows,
  logicalScreenSize,
  moveMouse,
  parseRegion,
  pressHotkey,
  pressKey,
  qwenToScreen,
  readPng,
  takeScreenshot,
  typeText,
  waitSeconds,
  type Shot,
} from "../desktop.js";
import { loadVisionLlm } from "../llm.js";
import { browserClick, browserOpen, browserState, browserType } from "../browser.js";

const onWindows = process.platform === "win32";
const GUIDELINES = onWindows
  ? [
    "你可以用 computer_use 工具操作这台 Windows：截图、定位、点击、输入、快捷键、打开应用、切换窗口。",
    "动手前先 take_screenshot。不确定坐标时用 find_element_position，把返回的 screen_x、screen_y 直接传给 click_mouse。",
    "打开应用用 launch_application，例如 notepad、explorer、calc。复制粘贴用 control，而不是 command。",
    "启动后 wait_seconds 2，再 focus_window。输入前先点击输入区域。删除文件、退出程序这类操作先向用户确认。",
    "要操作网页时用 browser_open、browser_click、browser_type。这和手机上看的是同一个 Chrome。手机如果开了「操作」，这些点击和输入会停下来。",
  ]
  : [
    "你可以用 computer_use 工具操作这台 Mac：截图、定位、点击、输入、快捷键、打开应用、切换窗口。",
    "动手前先 take_screenshot。不确定坐标时用 find_element_position，把返回的 screen_x、screen_y 直接传给 click_mouse。",
    "打开应用优先：截图后找 Dock 图标并点击；找不到再用 press_hotkey [command, space] 打开 Spotlight，type_text 应用名，press_key enter；仍不行再用 launch_application。",
    "启动后 wait_seconds 2，再 focus_window。输入前先点击输入区域。删除文件、退出程序这类操作先向用户确认。",
    "首次若截图或点击失败，请用户在「系统设置 → 隐私与安全」里给运行本服务的终端打开「屏幕录制」和「辅助功能」。",
    "要操作网页时用 browser_open、browser_click、browser_type。这和手机上看的是同一个 Chrome。手机如果开了「操作」，这些点击和输入会停下来。",
  ];

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : "操作失败";
  return ok({ success: false, message });
}

export function computerUseTools(): ToolDefinition[] {
  const screenshot = defineTool({
    name: "take_screenshot",
    label: "截图",
    description: "截取当前屏幕并保存为文件。region 可选，格式 x,y,width,height，不填则全屏。返回 file_path、width、height。",
    promptSnippet: "截取当前电脑的屏幕",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      region: Type.Optional(Type.String({ description: "可选区域 x,y,width,height" })),
    }),
    async execute(_id, params) {
      try {
        const shot = await takeScreenshot(params.region);
        return ok({
          success: true,
          file_path: shot.filePath,
          width: shot.width,
          height: shot.height,
          message: `截图成功，尺寸 ${shot.width}x${shot.height}，已保存到 ${shot.filePath}`,
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  const find = defineTool({
    name: "find_element_position",
    label: "定位元素",
    description: "用视觉模型在截图里找元素，返回可直接点击的 screen_x、screen_y。screenshot_path 用 take_screenshot 的 file_path。局部截图要把同一个 region 再传一次。",
    promptSnippet: "在截图里定位要点击的元素",
    parameters: Type.Object({
      screenshot_path: Type.String({ description: "截图文件路径" }),
      description: Type.String({ description: "要找的元素，越具体越好" }),
      region: Type.Optional(Type.String({ description: "若截图是局部的，传入相同 region" })),
    }),
    async execute(_id, params) {
      try {
        return ok(await locate(params.screenshot_path, params.description, params.region));
      } catch (error) {
        return fail(error);
      }
    },
  });

  const move = defineTool({
    name: "move_mouse",
    label: "移动鼠标",
    description: "把鼠标移到屏幕坐标。x、y 是逻辑像素，左上角为原点。",
    promptSnippet: "移动鼠标到坐标",
    parameters: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
    }),
    async execute(_id, params) {
      try {
        const point = await moveMouse(params.x, params.y);
        return ok({ success: true, ...point, message: `鼠标已移动到 (${point.x}, ${point.y})` });
      } catch (error) {
        return fail(error);
      }
    },
  });

  const click = defineTool({
    name: "click_mouse",
    label: "点击",
    description: "在坐标点击。button 为 left、right 或 middle，clicks 为 2 时双击。",
    promptSnippet: "在坐标点击鼠标",
    parameters: Type.Object({
      x: Type.Number(),
      y: Type.Number(),
      button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
      clicks: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      try {
        const result = await clickMouse(params.x, params.y, params.button ?? "left", params.clicks ?? 1);
        const action = result.clicks === 2 ? "双击" : "点击";
        return ok({ success: true, ...result, message: `${action} ${result.button} 键 (${result.x}, ${result.y}) 成功` });
      } catch (error) {
        return fail(error);
      }
    },
  });

  const type = defineTool({
    name: "type_text",
    label: "输入文字",
    description: "在当前焦点处输入文字。中文会通过剪贴板粘贴。调用前先点击输入框。",
    promptSnippet: "在当前焦点输入文字",
    parameters: Type.Object({
      text: Type.String(),
    }),
    async execute(_id, params) {
      try {
        const method = await typeText(params.text);
        return ok({ success: true, method, message: "文本输入成功" });
      } catch (error) {
        return fail(error);
      }
    },
  });

  const key = defineTool({
    name: "press_key",
    label: "按键",
    description: "按下并释放一个键，如 enter、escape、tab、space、delete、up、down、left、right。",
    promptSnippet: "按下单个键",
    parameters: Type.Object({
      key: Type.String(),
    }),
    async execute(_id, params) {
      try {
        const pressed = await pressKey(params.key);
        return ok({ success: true, key: pressed, message: `已按下 ${pressed}` });
      } catch (error) {
        return fail(error);
      }
    },
  });

  const hotkey = defineTool({
    name: "press_hotkey",
    label: "组合键",
    description: onWindows
      ? "同时按下多个键。复制是 [control, c]，粘贴 [control, v]，切换窗口 [alt, tab]。command 会按 control 处理。"
      : "同时按下多个键。Spotlight 是 [command, space]，复制 [command, c]，粘贴 [command, v]，切换应用 [command, tab]。",
    promptSnippet: "按下组合键",
    parameters: Type.Object({
      keys: Type.Array(Type.String()),
    }),
    async execute(_id, params) {
      try {
        const keys = await pressHotkey(params.keys);
        return ok({ success: true, keys, message: `已按下 ${keys.join(" + ")}` });
      } catch (error) {
        return fail(error);
      }
    },
  });

  const launch = defineTool({
    name: "launch_application",
    label: "打开应用",
    description: onWindows
      ? "用程序名或路径启动，例如 notepad、explorer、calc。"
      : "用应用英文名或 .app 路径启动，例如 TextEdit、Safari、Terminal、Calculator。",
    promptSnippet: onWindows ? "启动 Windows 程序" : "启动 macOS 应用",
    parameters: Type.Object({
      app: Type.String(),
      args: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      try {
        const app = await launchApplication(params.app, params.args);
        return ok({ success: true, app, message: `应用已启动: ${app}` });
      } catch (error) {
        return fail(error);
      }
    },
  });

  const windows = defineTool({
    name: "list_windows",
    label: "列出窗口",
    description: "列出当前可见应用和窗口标题。不确定应用名时先调用这个。",
    promptSnippet: "列出当前窗口",
    parameters: Type.Object({}),
    async execute() {
      try {
        const rows = await listWindows();
        return ok({
          success: true,
          windows: rows,
          count: rows.length,
          message: `找到 ${rows.length} 个窗口`,
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  const focus = defineTool({
    name: "focus_window",
    label: "切换窗口",
    description: "按应用名或窗口标题关键词把应用带到前台，例如 TextEdit、Safari。",
    promptSnippet: "把指定应用带到前台",
    parameters: Type.Object({
      title: Type.String(),
    }),
    async execute(_id, params) {
      try {
        const match = await focusWindow(params.title);
        return ok({
          success: true,
          app_name: match.appName,
          window_title: match.title,
          message: `应用「${match.appName}」已置于前台`,
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  const wait = defineTool({
    name: "wait_seconds",
    label: "等待",
    description: "等待 0.1 到 30 秒。打开应用后通常等 2 秒。",
    promptSnippet: "等待界面稳定",
    parameters: Type.Object({
      seconds: Type.Number(),
    }),
    async execute(_id, params) {
      const waited = await waitSeconds(params.seconds);
      return ok({ success: true, waited_seconds: waited, message: `已等待 ${waited} 秒` });
    },
  });

  const browserOpenTool = defineTool({
    name: "browser_open",
    label: "打开网页",
    description: "在受控 Chrome 中打开网址。手机上看的是同一个窗口。",
    promptSnippet: "打开一个网页",
    parameters: Type.Object({ url: Type.String({ description: "要打开的网址" }) }),
    async execute(_id, params) {
      try {
        return ok(await browserOpen(params.url));
      } catch (error) {
        return fail(error);
      }
    },
  });

  const browserStateTool = defineTool({
    name: "browser_state",
    label: "浏览器状态",
    description: "查看受控 Chrome 当前网址和视口大小。只看，不抢手机的操作。",
    promptSnippet: "看看浏览器现在在哪个页面",
    parameters: Type.Object({}),
    async execute() {
      try {
        return ok(await browserState());
      } catch (error) {
        return fail(error);
      }
    },
  });

  const browserClickTool = defineTool({
    name: "browser_click",
    label: "点击网页",
    description: "在受控 Chrome 当前页面里按描述点击元素。手机开着「操作」时会失败。",
    promptSnippet: "点击网页上的某个元素",
    parameters: Type.Object({ description: Type.String({ description: "要点击的元素，例如 搜索按钮" }) }),
    async execute(_id, params) {
      try {
        return ok(await browserClick(params.description));
      } catch (error) {
        return fail(error);
      }
    },
  });

  const browserTypeTool = defineTool({
    name: "browser_type",
    label: "在网页输入",
    description: "向受控 Chrome 当前焦点输入文字。先用 browser_click 点中输入框。",
    promptSnippet: "在网页输入框里打字",
    parameters: Type.Object({ text: Type.String({ description: "要输入的文字" }) }),
    async execute(_id, params) {
      try {
        return ok(await browserType(params.text));
      } catch (error) {
        return fail(error);
      }
    },
  });

  return [screenshot, find, move, click, type, key, hotkey, launch, windows, focus, wait, browserOpenTool, browserStateTool, browserClickTool, browserTypeTool];
}

async function locate(screenshotPath: string, description: string, region?: string) {
  parseRegion(region);
  const png = await readPng(screenshotPath);
  const vision = loadVisionLlm();
  const shot = await shotMeta(screenshotPath, region);
  const screen = await logicalScreenSize();
  const response = await fetch(`${vision.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${vision.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: vision.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
            {
              type: "text",
              text: [
                `请在图片中找到：${description}`,
                "坐标使用图片内的虚拟坐标系，宽高都归一化到 0~1000。",
                "只返回 JSON，不要 Markdown。",
                '找到时：{"found": true, "x1": 100, "y1": 200, "x2": 300, "y2": 400, "element": "简短描述"}',
                '找不到时：{"found": false, "element": "原因"}',
              ].join("\n"),
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    return { success: false, message: `视觉模型调用失败（HTTP ${response.status}）` };
  }
  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = body.choices?.[0]?.message?.content?.trim() ?? "";
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return { success: false, message: `模型返回无法解析：${raw.slice(0, 200)}` };
  const parsed = JSON.parse(jsonText) as {
    found?: boolean;
    element?: string;
    x1?: number | number[];
    y1?: number;
    x2?: number;
    y2?: number;
    bbox?: number[];
  };
  if (!parsed.found) {
    return { success: false, message: `未找到「${description}」：${parsed.element ?? "模型没说明原因"}` };
  }
  const box = readBox(parsed);
  const center = qwenToScreen((box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2, shot, screen);
  const topLeft = qwenToScreen(box.x1, box.y1, shot, screen);
  const bottomRight = qwenToScreen(box.x2, box.y2, shot, screen);
  return {
    success: true,
    screen_x: center.x,
    screen_y: center.y,
    bbox_screen: [topLeft.x, topLeft.y, bottomRight.x, bottomRight.y],
    description: parsed.element ?? description,
    message: `找到「${description}」，屏幕坐标 (${center.x}, ${center.y})`,
  };
}

function readBox(parsed: {
  x1?: number | number[];
  y1?: number;
  x2?: number;
  y2?: number;
  bbox?: number[];
}) {
  if (Array.isArray(parsed.x1) && parsed.x1.length === 4) {
    const [x1, y1, x2, y2] = parsed.x1;
    return { x1, y1, x2, y2 };
  }
  if (parsed.bbox?.length === 4) {
    const [x1, y1, x2, y2] = parsed.bbox;
    return { x1, y1, x2, y2 };
  }
  if ([parsed.x1, parsed.y1, parsed.x2, parsed.y2].every((value) => typeof value === "number")) {
    return { x1: parsed.x1 as number, y1: parsed.y1 as number, x2: parsed.x2 as number, y2: parsed.y2 as number };
  }
  throw new Error("视觉模型没有返回可用坐标");
}

async function shotMeta(filePath: string, region?: string): Promise<Shot> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const info = await promisify(execFile)("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath], { timeout: 10_000 });
  const width = Number(/pixelWidth:\s*(\d+)/.exec(info.stdout)?.[1] ?? 0);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(info.stdout)?.[1] ?? 0);
  if (!width || !height) throw new Error("读不到截图尺寸");
  return { filePath, width, height, region: parseRegion(region) };
}
