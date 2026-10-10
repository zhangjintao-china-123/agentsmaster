export type Capture = {
  cancel: () => void;
  stop: () => Promise<string>;
};

export function startCapture(): Capture {
  let stopped = false;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  const chunks: Float32Array[] = [];
  let rate = 16000;
  let failure: Error | null = null;

  const starting = (async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不能录音");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (stopped) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      return;
    }
    context = new AudioContext();
    rate = context.sampleRate || 48000;
    const source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(context.destination);
    processor.onaudioprocess = (event) => {
      if (stopped) return;
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
  })().catch((error: unknown) => {
    failure = error instanceof Error ? friendlyMicError(error) : new Error("没有拿到麦克风");
  });

  async function release() {
    stopped = true;
    processor?.disconnect();
    processor = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    const closing = context?.close();
    context = null;
    await closing?.catch(() => undefined);
  }

  return {
    cancel() {
      void release();
    },
    async stop() {
      await starting;
      const heard = rate;
      const pcm = concat(chunks);
      await release();
      if (failure) throw failure;
      if (pcm.length < heard * 0.25) throw new Error("录音太短");
      return toBase64(encodeWav(downsample(pcm, heard, 16000), 16000));
    },
  };
}

function friendlyMicError(error: Error): Error {
  if (error.name === "NotAllowedError" || error.name === "SecurityError") return new Error("请允许使用麦克风");
  if (error.name === "NotFoundError") return new Error("没有找到麦克风");
  return new Error("没有拿到麦克风");
}

function concat(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from <= to) return input;
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j] || 0;
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  write(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(view, 8, "WAVE");
  write(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

function write(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }
  return btoa(binary);
}
