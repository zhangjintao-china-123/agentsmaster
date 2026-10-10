<script setup lang="ts">
import { computed, ref } from "vue";

type Frame = { data: string; width: number; height: number };

const props = defineProps<{ mode: "browser" | "desktop"; hint: string }>();
const emit = defineEmits<{
  input: [message: Record<string, unknown>];
}>();

const pictureUrl = ref("");
const layers = ref(["", ""]);
const front = ref(0);
const pictureSize = ref({ width: 0, height: 0 });
const pan = ref({ x: 0, y: 0 });
const zoom = ref(1);
const waiting = ref(true);
const pictureStyle = computed(() => ({
  width: pictureSize.value.width + "px",
  height: pictureSize.value.height + "px",
  transform: `translate(${pan.value.x}px, ${pan.value.y}px) scale(${zoom.value})`,
}));
let frame: Frame | null = null;
let panSize = { width: 0, height: 0 };
const pointers = new Map<number, { x: number; y: number; lastX: number; lastY: number; at: number }>();
let dragMoved = false;
let dragId = 0;
let pinchDist = 0;
let pinchMid = { x: 0, y: 0 };

function paint(next: Frame) {
  frame = next;
  const image = new Image();
  image.onload = () => {
    if (frame !== next) return;
    const width = next.width;
    const height = next.height;
    if (!width || !height) return;
    if (Math.abs(panSize.width - width) > 2 || Math.abs(panSize.height - height) > 2) {
      panSize = { width, height };
      pictureSize.value = { width, height };
      pan.value = { x: 0, y: 0 };
      zoom.value = 1;
    } else if (!pictureSize.value.width) {
      pictureSize.value = { width, height };
      panSize = { width, height };
    }
    const slot = front.value === 0 ? 1 : 0;
    const nextLayers = layers.value.slice();
    nextLayers[slot] = image.src;
    layers.value = nextLayers;
    pictureUrl.value = image.src;
    front.value = slot;
    waiting.value = false;
  };
  image.src = `data:image/jpeg;base64,${next.data}`;
}

function showLayer(index: number) {
  if (layers.value[index] && layers.value[index] === pictureUrl.value) front.value = index;
}

function pictureNode() {
  return document.querySelector(`.stage.${props.mode} .picture.on`) as HTMLElement | null;
}

function stageNode() {
  return document.querySelector(`.stage.${props.mode}`) as HTMLElement | null;
}

function picturePoint(clientX: number, clientY: number) {
  const image = pictureNode();
  if (!image) return null;
  const box = image.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const x = (clientX - box.left) / box.width;
  const y = (clientY - box.top) / box.height;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
    inside: x >= 0 && y >= 0 && x <= 1 && y <= 1,
  };
}

function touchPoint(touch: { clientX?: number; x?: number; clientY?: number; y?: number }) {
  return { x: touch.clientX ?? touch.x ?? 0, y: touch.clientY ?? touch.y ?? 0 };
}

function scrollBy(deltaX: number, deltaY: number, clientX: number, clientY: number) {
  const placed = picturePoint(clientX, clientY);
  if (!placed || Math.hypot(deltaX, deltaY) < 1) return;
  const scale = zoom.value || 1;
  emit("input", { kind: "wheel", x: placed.x, y: placed.y, deltaX: deltaX / scale, deltaY: deltaY / scale });
}

function contentSize() {
  const image = pictureNode();
  if (image?.offsetWidth && image.offsetHeight) return { width: image.offsetWidth, height: image.offsetHeight };
  return pictureSize.value;
}

function fitScale() {
  const stage = stageNode();
  const size = contentSize();
  if (!stage || !size.width || !size.height) return 1;
  return Math.min(stage.clientWidth / size.width, stage.clientHeight / size.height);
}

function clampZoom(next: number) {
  const min = Math.min(1, Math.max(0.05, fitScale()));
  return Math.min(4, Math.max(min, next));
}

function clampPan(x: number, y: number) {
  const stage = stageNode();
  const size = contentSize();
  if (!stage || !size.width || !size.height) return { x, y };
  const extraX = stage.clientWidth - size.width * zoom.value;
  const extraY = stage.clientHeight - size.height * zoom.value;
  return {
    x: extraX >= 0 ? extraX / 2 : Math.min(0, Math.max(extraX, x)),
    y: extraY >= 0 ? extraY / 2 : Math.min(0, Math.max(extraY, y)),
  };
}

function panView(deltaX: number, deltaY: number) {
  const next = clampPan(pan.value.x + deltaX, pan.value.y + deltaY);
  const edgeX = next.x === pan.value.x && deltaX !== 0;
  const edgeY = next.y === pan.value.y && deltaY !== 0;
  pan.value = next;
  return { edgeX, edgeY };
}

function zoomView(next: number, clientX: number, clientY: number) {
  const image = pictureNode();
  const stage = stageNode();
  if (!image || !stage) return;
  const box = stage.getBoundingClientRect();
  const current = zoom.value || 1;
  const scale = clampZoom(next);
  const localX = (clientX - box.left - pan.value.x) / current;
  const localY = (clientY - box.top - pan.value.y) / current;
  zoom.value = scale;
  pan.value = clampPan(clientX - box.left - localX * scale, clientY - box.top - localY * scale);
}

function rememberPinch(touches: Array<{ clientX?: number; x?: number; clientY?: number; y?: number }>) {
  if (touches.length < 2) {
    pinchDist = 0;
    return;
  }
  const first = touchPoint(touches[0]);
  const second = touchPoint(touches[1]);
  pinchDist = Math.hypot(second.x - first.x, second.y - first.y);
  pinchMid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function onStart(event: { touches: Array<{ identifier: number; clientX?: number; x?: number; clientY?: number; y?: number }>; timeStamp?: number }) {
  const now = event.timeStamp || Date.now();
  for (const touch of event.touches) {
    const point = touchPoint(touch);
    if (!pointers.has(touch.identifier)) pointers.set(touch.identifier, { ...point, lastX: point.x, lastY: point.y, at: now });
  }
  const touch = event.touches[0];
  if (!touch) return;
  const point = touchPoint(touch);
  dragId = touch.identifier;
  dragMoved = false;
  pointers.set(touch.identifier, { ...point, lastX: point.x, lastY: point.y, at: now });
  if (event.touches.length >= 2) rememberPinch(event.touches);
}

function onMove(event: { touches: Array<{ identifier: number; clientX?: number; x?: number; clientY?: number; y?: number }> }) {
  if ((event.touches?.length || 0) < 2) {
    const touch = event.touches.find((item) => item.identifier === dragId) || event.touches[0];
    const pointer = touch ? pointers.get(touch.identifier) : undefined;
    if (!touch || !pointer) return;
    const point = touchPoint(touch);
    const deltaX = point.x - pointer.lastX;
    const deltaY = point.y - pointer.lastY;
    if (!dragMoved && Math.hypot(point.x - pointer.x, point.y - pointer.y) < 8) return;
    dragMoved = true;
    const edge = panView(deltaX, deltaY);
    if (props.mode === "browser" && edge.edgeY) {
      scrollBy(deltaX, pointer.lastY - point.y, point.x, point.y);
    }
    pointer.lastX = point.x;
    pointer.lastY = point.y;
    return;
  }
  const first = touchPoint(event.touches[0]);
  const second = touchPoint(event.touches[1]);
  const dist = Math.hypot(second.x - first.x, second.y - first.y);
  const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  dragMoved = true;
  if (!pinchDist) {
    pinchDist = dist;
    pinchMid = mid;
    return;
  }
  const distDelta = Math.abs(dist - pinchDist);
  const midDelta = Math.hypot(mid.x - pinchMid.x, mid.y - pinchMid.y);
  if (dist > 0 && distDelta > 8 && distDelta >= midDelta) {
    zoomView(zoom.value * (dist / pinchDist), mid.x, mid.y);
    pinchDist = dist;
    pinchMid = mid;
    return;
  }
  const deltaX = mid.x - pinchMid.x;
  const deltaY = pinchMid.y - mid.y;
  pinchDist = dist;
  pinchMid = mid;
  scrollBy(deltaX, deltaY, mid.x, mid.y);
}

function onCancel() {
  pointers.clear();
  dragMoved = false;
  pinchDist = 0;
}

function onEnd(event: { changedTouches: Array<{ identifier: number; clientX?: number; x?: number; clientY?: number; y?: number }>; timeStamp?: number }) {
  const touch = event.changedTouches[0];
  if (!touch) return;
  const pointer = pointers.get(touch.identifier);
  pointers.delete(touch.identifier);
  if (pointers.size < 2) pinchDist = 0;
  if (!pointer || !frame) return;
  if (dragMoved || touch.identifier !== dragId) return;
  const placed = picturePoint(touchPoint(touch).x, touchPoint(touch).y);
  if (!placed?.inside) return;
  if (props.mode === "desktop") {
    const button = (event.timeStamp || Date.now()) - pointer.at > 450 ? "right" : "left";
    emit("input", { kind: "down", x: placed.x, y: placed.y, button });
    emit("input", { kind: "up", x: placed.x, y: placed.y, button });
    return;
  }
  emit("input", { kind: "click", x: placed.x, y: placed.y });
}

defineExpose({ paint });
</script>

<template>
  <view class="stage" :class="mode" @touchstart="onStart" @touchmove.stop.prevent="onMove" @touchend="onEnd" @touchcancel="onCancel">
    <view v-if="pictureSize.width" class="picture-box" :style="pictureStyle">
      <img v-if="layers[0]" class="picture" :class="{ on: front === 0 }" :src="layers[0]" alt="" @load="showLayer(0)" />
      <img v-if="layers[1]" class="picture" :class="{ on: front === 1 }" :src="layers[1]" alt="" @load="showLayer(1)" />
    </view>
    <view v-if="waiting" class="wait">{{ hint }}</view>
  </view>
</template>

<style scoped>
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: block;
  overflow: hidden;
  background: #111;
  touch-action: none;
}
.stage.browser {
  background: #f3f4f6;
}
.picture-box {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
}
.picture {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  display: block;
  max-width: none;
  max-height: none;
  opacity: 0;
}
.picture.on { opacity: 1; }
.wait {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #bbb;
  padding: 24px;
  text-align: center;
}
</style>
