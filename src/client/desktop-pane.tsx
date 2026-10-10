import { useEffect, useRef, useState } from "react";
import { Button, TextArea } from "antd-mobile";

type Frame = { data: string; width: number; height: number };
type PointerButton = "left" | "right";
type DeskInput =
  | { kind: "down" | "up"; x: number; y: number; button: PointerButton }
  | { kind: "move"; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "type"; text: string };

export function DesktopPane({
  onWatch,
  onInput,
  bindFrame,
}: {
  onWatch: (on: boolean) => void;
  onInput: (message: DeskInput) => void;
  bindFrame: (sink: ((frame: Frame) => void) | null) => void;
}) {
  const [text, setText] = useState("");
  const [connected, setConnected] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<Frame | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number; lastX: number; lastY: number; at: number }>());
  const mouseDown = useRef(false);
  const lastMoveAt = useRef(0);

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
      mouseDown.current = false;
    };
  }, []);

  return (
    <div className="desktop-pane">
      <p className="browser-note">这是电脑整个屏幕。点按是左键，拖动是按住鼠标，双指滑动是滚动，长按是右键。</p>
      <div className="browser-stage">
        <canvas
            ref={canvasRef}
            className="browser-shot"
            style={{ visibility: connected ? "visible" : "hidden" }}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              pointers.current.set(event.pointerId, {
                x: event.clientX,
                y: event.clientY,
                lastX: event.clientX,
                lastY: event.clientY,
                at: event.timeStamp,
              });
              event.currentTarget.setPointerCapture(event.pointerId);
              const frame = frameRef.current;
              if (pointers.current.size > 1 && mouseDown.current && frame) {
                const box = imageBox(event.currentTarget, frame.width, frame.height);
                if (!box) return;
                const point = place(event.clientX, event.clientY, box);
                onInput({ kind: "up", x: point.x, y: point.y, button: "left" });
                mouseDown.current = false;
              }
            }}
            onPointerMove={(event) => {
              const pointer = pointers.current.get(event.pointerId);
              const frame = frameRef.current;
              if (!pointer || !frame) return;
              const box = imageBox(event.currentTarget, frame.width, frame.height);
              if (!box) return;
              if (pointers.current.size >= 2) {
                const deltaX = (event.clientX - pointer.lastX) * box.scaleX;
                const deltaY = (pointer.lastY - event.clientY) * box.scaleY;
                pointer.lastX = event.clientX;
                pointer.lastY = event.clientY;
                if (Math.hypot(deltaX, deltaY) < 1) return;
                const point = place(event.clientX, event.clientY, box);
                onInput({ kind: "wheel", x: point.x, y: point.y, deltaX, deltaY });
                return;
              }
              const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 8;
              const point = place(event.clientX, event.clientY, box);
              if (!mouseDown.current && moved) {
                const origin = place(pointer.x, pointer.y, box);
                onInput({ kind: "down", x: origin.x, y: origin.y, button: "left" });
                mouseDown.current = true;
              }
              pointer.lastX = event.clientX;
              pointer.lastY = event.clientY;
              if (!mouseDown.current) return;
              const now = Date.now();
              if (now - lastMoveAt.current < 30) return;
              lastMoveAt.current = now;
              onInput({ kind: "move", x: point.x, y: point.y });
            }}
            onPointerUp={(event) => {
              const pointer = pointers.current.get(event.pointerId);
              pointers.current.delete(event.pointerId);
              const frame = frameRef.current;
              if (!pointer || !frame) return;
              if (pointers.current.size > 0) return;
              const box = imageBox(event.currentTarget, frame.width, frame.height);
              if (!box) return;
              const point = place(event.clientX, event.clientY, box);
              if (mouseDown.current) {
                onInput({ kind: "move", x: point.x, y: point.y });
                onInput({ kind: "up", x: point.x, y: point.y, button: "left" });
                mouseDown.current = false;
                return;
              }
              if (!point.inside) return;
              if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 8) return;
              const button: PointerButton = event.timeStamp - pointer.at > 450 ? "right" : "left";
              onInput({ kind: "down", x: point.x, y: point.y, button });
              onInput({ kind: "up", x: point.x, y: point.y, button });
            }}
            onPointerCancel={() => {
              pointers.current.clear();
              mouseDown.current = false;
            }}
        />
        {connected ? null : <div className="empty">正在连接电脑桌面</div>}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text) return;
          onInput({ kind: "type", text });
          setText("");
        }}
      >
        <TextArea value={text} autoSize={{ minRows: 1, maxRows: 2 }} placeholder="输入到电脑当前焦点" onChange={setText} />
        <Button type="submit" color="primary" disabled={!text}>输入</Button>
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
  return {
    x,
    y,
    inside: clientX >= box.left && clientX <= box.left + box.drawW && clientY >= box.top && clientY <= box.top + box.drawH,
  };
}
