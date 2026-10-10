import { useEffect, useRef, useState } from "react";
import { Button } from "antd-mobile";
import { pairFromScan, savePair } from "./link";

export function PairGate({ onCancel }: { onCancel?: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const [error, setError] = useState("");
  const [live, setLive] = useState(false);

  useEffect(() => () => controlsRef.current?.stop(), []);

  async function start() {
    const video = videoRef.current;
    if (!video) return;
    setError("");
    try {
      const streamPromise = navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const stream = await streamPromise;
      video.srcObject = stream;
      await video.play();
      setLive(true);
      const reader = new BrowserQRCodeReader();
      controlsRef.current = await reader.decodeFromStream(stream, video, (result) => {
        if (!result) return;
        const pair = pairFromScan(result.getText());
        if (!pair) {
          setError("这不是配对码");
          return;
        }
        controlsRef.current?.stop();
        savePair(pair);
        location.replace(location.pathname + location.search);
      });
    } catch {
      setError("打不开相机。请允许使用相机后再扫。");
    }
  }

  return (
    <div className="pair-gate">
      <video ref={videoRef} className={live ? "live" : ""} muted playsInline autoPlay />
      <h1>扫一扫</h1>
      <p>对准电脑管理页上的配对码</p>
      {error ? <p className="pair-error">{error}</p> : null}
      {live ? null : (
        <Button color="primary" block size="large" onClick={() => void start()}>
          扫一扫
        </Button>
      )}
      {onCancel ? (
        <Button fill="none" onClick={() => { controlsRef.current?.stop(); onCancel(); }}>
          取消
        </Button>
      ) : null}
    </div>
  );
}
