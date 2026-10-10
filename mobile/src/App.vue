<script setup lang="ts">
import { onLaunch, onShow, onHide } from "@dcloudio/uni-app";
onLaunch(() => {
  console.log("App Launch");
});
onShow(() => {
  console.log("App Show");
});
onHide(() => {
  console.log("App Hide");
});
</script>
<style>
page, uni-page-body {
  width: 100%;
  max-width: 100%;
  height: 100%;
  overflow-x: hidden;
  box-sizing: border-box;
  background: #f5f6f8;
  color: #1f2329;
  font-size: 16px;
}
</style>
