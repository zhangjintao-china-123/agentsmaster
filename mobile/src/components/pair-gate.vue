<script setup lang="ts">
import { BrowserQRCodeReader } from "@zxing/browser";
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { pairFromScan, savePair } from "../link";

const props = defineProps<{ cancelable?: boolean }>();
const emit = defineEmits<{ done: []; cancel: [] }>();

const live = ref(false);
const scanError = ref("");
let controls: { stop: () => void } | null = null;
let video: HTMLVideoElement | null = null;
let photoInput: HTMLInputElement | null = null;

onMounted(() => {
  const host = document.getElementById("pair-file");
  if (!host) return;
  photoInput = document.createElement("input");
  photoInput.type = "file";
  photoInput.accept = "image/*";
  photoInput.capture = "environment";
  photoInput.className = "file";
  photoInput.addEventListener("change", onPhoto);
  host.appendChild(photoInput);
});

onUnmounted(stop);

async function start() {
  const host = document.getElementById("pair-camera");
  if (!host) return;
  scanError.value = "";
  stop();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    scanError.value = "请用手机自带浏览器打开 https://agents.pptxgen.com 后再扫。";
    return;
  }
  const streamPromise = openCamera();
  try {
    const stream = await streamPromise;
    video = document.createElement("video");
    video.className = "lens";
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");
    video.srcObject = stream;
    live.value = true;
    await nextTick();
    host.replaceChildren(video);
    await video.play();
    const reader = new BrowserQRCodeReader();
    controls = await reader.decodeFromStream(stream, video, (result) => {
      if (!result) return;
      accept(result.getText());
    });
  } catch (error) {
    stop();
    scanError.value = cameraMessage(error);
  }
}

function openCamera() {
  const videoConstraints = { facingMode: { ideal: "environment" } };
  return navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints }).catch((error: unknown) => {
    const name = error instanceof DOMException ? error.name : "";
    if (name !== "OverconstrainedError" && name !== "NotFoundError") throw error;
    return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  });
}

async function onPhoto(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  scanError.value = "";
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const result = await new BrowserQRCodeReader().decodeFromImageElement(image);
    accept(result.getText());
  } catch {
    scanError.value = "没有识别到配对码，请对准二维码再拍一张。";
  } finally {
    URL.revokeObjectURL(url);
  }
}

function accept(text: string) {
  const pair = pairFromScan(text);
  if (!pair) {
    scanError.value = "这不是配对码";
    return;
  }
  stop();
  savePair(pair);
  emit("done");
}

function cameraMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "没有相机权限。请在浏览器设置里允许相机，然后重新打开页面再扫。";
  if (name === "NotFoundError") return "这台手机没有可用的相机，可以改用拍照识别。";
  if (name === "NotReadableError") return "相机正被别的应用占用，关掉后再扫。";
  return "打不开相机。可以允许相机后再扫，或改用拍照识别。";
}

function stop() {
  controls?.stop();
  controls = null;
  const stream = video?.srcObject;
  if (stream instanceof MediaStream) {
    for (const track of stream.getTracks()) track.stop();
  }
  video = null;
  live.value = false;
}

function cancel() {
  stop();
  emit("cancel");
}
</script>

<template>
  <view class="gate">
    <view id="pair-camera" class="camera" :class="{ live }" />
    <text class="pair-title">扫一扫</text>
    <text class="pair-hint">对准电脑管理页上的配对码</text>
    <text v-if="scanError" class="pair-error">{{ scanError }}</text>
    <text v-if="!live" class="pair-button" @click="start">扫一扫</text>
    <view id="pair-file" class="pair-file">拍照识别</view>
    <text v-if="props.cancelable" class="pair-cancel" @click="cancel">取消</text>
  </view>
</template>

<style scoped>
.gate {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 16px;
  padding: 24px 20px 40px;
}
.camera { display: none; width: 100%; aspect-ratio: 1; border-radius: 16px; overflow: hidden; background: #111; }
.camera.live { display: block; }
.camera :deep(.lens) { width: 100%; height: 100%; object-fit: cover; display: block; }
.pair-title { text-align: center; font-size: 22px; font-weight: 600; }
.pair-hint, .pair-error, .pair-cancel { text-align: center; color: #8c8c8c; }
.pair-error { color: #cf1322; }
.pair-button, .pair-file {
  margin: 0 12px;
  padding: 12px 0;
  border-radius: 10px;
  background: #1677ff;
  color: #fff;
  text-align: center;
  font-size: 16px;
}
.pair-file { position: relative; overflow: hidden; background: #f2f3f5; color: #1677ff; }
.pair-file :deep(.file) { position: absolute; inset: 0; opacity: 0; }
</style>
