import { useEffect, useRef, useState } from "react";
import { Button, TextArea } from "antd-mobile";

type Frame = { data: string; width: number; height: number };
type Owner = "idle" | "phone" | "agent";
type Tab = { id: string; title: string; url: string };

export function BrowserPane({
  owner,
  pageUrl,
  tabs,
  activeId,
  onWatch,
  onControl,
  onNav,
  onSwitch,
  onInput,
  bindFrame,
}: {
  owner: Owner;
  pageUrl: string;
  tabs: Tab[];
  activeId: string;
  onWatch: (on: boolean) => void;
  onControl: (on: boolean) => void;
  onNav: (url: string) => void;
  onSwitch: (targetId: string) => void;
  onInput: (
    message:
      | { kind: "click"; x: number; y: number }
      | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
      | { kind: "type"; text: string },
  ) => void;
  bindFrame: (sink: ((frame: Frame) => void) | null) => void;
}) {
  const controlRef = useRef(false);
  const dragRef = useRef<{ id: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<Frame | null>(null);
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [control, setControl] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let current = 0;
    bindFrame((next) => {
      frameRef.current = next;
      const token = ++current;
      const image = new Image();
      image.onload = () => {
        if (token !== current) return;
        paintFrame(canvasRef.current, image);
        setConnected(true);
      };
      image.src = `data:image/jpeg;base64,${next.data}`;
    });
    onWatch(true);
    return () => {
      current += 1;
      bindFrame(null);
      onWatch(false);
      if (controlRef.current) onControl(false);
    };
  }, []);

  return (
    <div className="browser-pane">
      <div className="browser-bar">
        <strong>电脑浏览器</strong>
        <Button
          size="small"
          color={control ? "danger" : "primary"}
          fill={control ? "solid" : "outline"}
          disabled={owner === "agent" && !control}
          onClick={() => {
            const next = !control;
            controlRef.current = next;
            setControl(next);
            onControl(next);
          }}
        >
          {control ? "结束操作" : "操作"}
        </Button>
      </div>
      <form
        className="browser-url"
        onSubmit={(event) => {
          event.preventDefault();
          if (!url.trim() || owner === "agent") return;
          onNav(url.trim());
        }}
      >
        <TextArea value={url} autoSize={{ minRows: 1, maxRows: 2 }} placeholder={pageUrl || "输入网址"} onChange={setUrl} />
        <Button type="submit" size="small" color="primary" disabled={owner === "agent"}>打开</Button>
      </form>
      {tabs.length > 1 ? (
        <div className="browser-tabs">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              className={tab.id === activeId ? "on" : ""}
              onClick={() => {
                if (tab.id !== activeId) onSwitch(tab.id);
              }}
            >
              {tabLabel(tab, index)}
            </button>
          ))}
        </div>
      ) : null}
      <p className="browser-note">
        {owner === "agent" ? "电脑上的 agent 正在操作，画面继续更新，暂时不能点。" : control ? "点按是点击，按住拖动是滚动。" : "正在观看。点「操作」后可以点击或滚动页面。"}
      </p>
      <div className="browser-stage">
        <canvas
            ref={canvasRef}
            className="browser-shot"
            style={{ visibility: connected ? "visible" : "hidden" }}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (!control || owner === "agent") return;
              dragRef.current = { id: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: false };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.id !== event.pointerId || !control || owner === "agent") return;
              const frame = frameRef.current;
              const box = frame ? imageBox(event.currentTarget, frame.width, frame.height) : null;
              if (!box) return;
              const deltaX = (event.clientX - drag.lastX) * box.scaleX;
              const deltaY = (drag.lastY - event.clientY) * box.scaleY;
              if (!drag.moved && Math.hypot(event.clientX - drag.lastX, event.clientY - drag.lastY) < 8) return;
              drag.moved = true;
              drag.lastX = event.clientX;
              drag.lastY = event.clientY;
              const point = place(event.clientX, event.clientY, box);
              if (Math.hypot(deltaX, deltaY) < 1) return;
              onInput({ kind: "wheel", x: point.x, y: point.y, deltaX, deltaY });
            }}
            onPointerUp={(event) => {
              const drag = dragRef.current;
              dragRef.current = null;
              if (!drag || drag.id !== event.pointerId || drag.moved || !control || owner === "agent") return;
              const frame = frameRef.current;
              const box = frame ? imageBox(event.currentTarget, frame.width, frame.height) : null;
              if (!box) return;
              const point = place(event.clientX, event.clientY, box);
              if (!point.inside) return;
              onInput({ kind: "click", x: point.x, y: point.y });
            }}
            onPointerCancel={() => {
              dragRef.current = null;
            }}
        />
        {connected ? null : <div className="empty">正在连接电脑上的浏览器</div>}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || owner === "agent") return;
          onInput({ kind: "type", text: text.trim() });
          setText("");
        }}
      >
        <TextArea value={text} autoSize={{ minRows: 1, maxRows: 2 }} placeholder="输入到网页焦点" onChange={setText} />
        <Button type="submit" color="primary" disabled={!text.trim() || owner === "agent"}>输入</Button>
      </form>
    </div>
  );
}

function paintFrame(canvas: HTMLCanvasElement | null, image: HTMLImageElement) {
  if (!canvas || !image.width || !image.height) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (Math.abs(canvas.width - width) > 2 || Math.abs(canvas.height - height) > 2) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  const scale = Math.min(width / image.width, height / image.height);
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  context.drawImage(image, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);
}

function imageBox(element: HTMLElement, width: number, height: number) {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height || !width || !height) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const drawW = width * scale;
  const drawH = height * scale;
  return {
    left: rect.left + (rect.width - drawW) / 2,
    top: rect.top + (rect.height - drawH) / 2,
    drawW,
    drawH,
    scaleX: width / drawW,
    scaleY: height / drawH,
  };
}

function place(clientX: number, clientY: number, box: NonNullable<ReturnType<typeof imageBox>>) {
  const x = Math.min(1, Math.max(0, (clientX - box.left) / box.drawW));
  const y = Math.min(1, Math.max(0, (clientY - box.top) / box.drawH));
  return { x, y, inside: clientX >= box.left && clientX <= box.left + box.drawW && clientY >= box.top && clientY <= box.top + box.drawH };
}

function tabLabel(tab: Tab, index: number) {
  const title = tab.title.trim();
  if (title && title !== "about:blank") return title;
  if (tab.url && tab.url !== "about:blank") {
    try {
      return new URL(tab.url).host;
    } catch {
      return tab.url;
    }
  }
  return `标签 ${index + 1}`;
}
