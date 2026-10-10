<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../markdown";

const props = defineProps<{ text: string; tone?: "user" | "agent" }>();
const html = computed(() => renderMarkdown(props.text));
</script>

<template>
  <div class="markdown" :class="tone" v-html="html" />
</template>

<style scoped>
.markdown {
  max-width: 100%;
  line-height: 1.45;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
  -webkit-user-select: text;
  user-select: text;
}
.markdown :deep(p) { margin: 0; }
.markdown :deep(p + p) { margin-top: 8px; }
.markdown :deep(ul),
.markdown :deep(ol) { margin: 0 0 8px; padding-left: 1.2em; }
.markdown :deep(li) { margin: 2px 0; }
.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) { margin: 0 0 8px; font-size: 16px; line-height: 1.4; }
.markdown :deep(blockquote) {
  margin: 0 0 8px;
  padding-left: 8px;
  border-left: 3px solid rgba(0, 0, 0, 0.16);
}
.markdown.user :deep(blockquote) { border-left-color: rgba(255, 255, 255, 0.55); }
.markdown :deep(pre) {
  margin: 0 0 8px;
  padding: 8px;
  border-radius: 8px;
  overflow-x: auto;
  background: rgba(0, 0, 0, 0.06);
}
.markdown.user :deep(pre) { background: rgba(255, 255, 255, 0.18); }
.markdown :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
}
.markdown :deep(p code),
.markdown :deep(li code) {
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.06);
}
.markdown.user :deep(p code),
.markdown.user :deep(li code) { background: rgba(255, 255, 255, 0.18); }
.markdown :deep(a) { color: inherit; text-decoration: underline; }
.markdown :deep(table) { border-collapse: collapse; max-width: 100%; }
.markdown :deep(th),
.markdown :deep(td) { padding: 4px 6px; border: 1px solid rgba(0, 0, 0, 0.12); }
.markdown.user :deep(th),
.markdown.user :deep(td) { border-color: rgba(255, 255, 255, 0.35); }
</style>
