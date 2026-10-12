import os from "node:os";
import path from "node:path";
import { chromeDebugPort } from "./browser.js";

export function setupPage(pairing: { url: string; svg: string } | null = null, models: { id: string; name: string }[] = []): string {
  const debugPort = chromeDebugPort();
  const browserUrl = `http://127.0.0.1:${debugPort}`;
  const profileDir = path.join(os.homedir(), ".agentsmaster", "chrome");
  const phoneUrl = phoneDomain(process.env.CLOUD_PUBLIC_URL || process.env.CLOUD_URL || "https://agents.pptxgen.com");
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agentsmaster 配置</title>
<style>
  body { margin: 0; font: 16px/1.5 "IBM Plex Sans", "PingFang SC", sans-serif; background: #121410; color: #f4f1ea; }
  main { max-width: 760px; margin: 0 auto; padding: 28px 20px 64px; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  p { color: #c8c2b4; }
  section { margin-top: 28px; }
  form, .row { display: flex; gap: 8px; align-items: center; }
  form.stack { flex-direction: column; align-items: stretch; }
  .section-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .section-head h2 { margin: 0; }
  dialog { width: min(440px, calc(100vw - 32px)); border: 0; border-radius: 16px; padding: 20px; background: #1c1f18; color: inherit; }
  dialog::backdrop { background: rgba(8, 9, 7, 0.72); }
  dialog h2 { margin: 0 0 4px; font-size: 20px; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .dialog-error { min-height: 1.5em; margin: 0; color: #e6a15c; }
  .project { flex-direction: column; align-items: stretch; gap: 8px; }
  .project-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
  .project small { word-break: break-all; }
  .runner { display: block; margin-top: 4px; color: #c8c2b4; }
  input, select, button { font: inherit; border-radius: 10px; padding: 10px 12px; }
  input, select { flex: 1; background: #1c1f18; color: inherit; border: 1px solid #34382d; }
  button { background: #e6a15c; color: #1a140e; border: 0; }
  button.ghost { background: transparent; color: inherit; border: 1px solid #34382d; }
  ul { list-style: none; padding: 0; }
  li { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #34382d; }
  small { display: block; color: #9c968a; }
  .pair { display: flex; gap: 16px; align-items: center; width: fit-content; max-width: 100%; margin-top: 12px; background: #f4f1ea; color: #121410; border-radius: 12px; padding: 12px; }
  .pair svg { width: 180px; height: 180px; flex: none; }
  .pair a { color: #1a140e; word-break: break-all; }
  .phone-url { margin: 12px 0 0; padding: 12px 14px; background: #1c1f18; border-radius: 10px; }
  .phone-url a { color: #e6a15c; font-size: 18px; word-break: break-all; }
</style>
<main>
  <h1>配置</h1>
  <p>每个项目自带一个通道。手机上点项目，就和这个通道会话。</p>
  <section>
    <h2>手机配对</h2>
    <p>手机访问域名</p>
    <p class="phone-url"><a href="${escapeHtml(phoneUrl)}">${escapeHtml(phoneUrl)}</a></p>
    ${pairing ? `<p>用手机打开上面这一行域名，再扫这个码。每台电脑有自己的配对码，扫哪台就连哪台。</p><div class="pair">${pairing.svg}<a href="${escapeHtml(pairing.url)}">${escapeHtml(pairing.url)}</a></div>` : ""}
  </section>
  <section>
    <h2>浏览器</h2>
    <p>手机上看的是这台电脑 ${browserUrl} 上的 Google Chrome。这个端口已经有 Chrome 在听，就接上现有的那个；否则本服务用配置目录 ${escapeHtml(profileDir)} 启动 Chrome。</p>
    <p>Agent 操作网页时，必须使用 Chrome 的 MCP，并连接到 ${browserUrl}。这才是手机正在看的那个浏览器。Cursor 自带的浏览器是另一个窗口，手机上看不到。</p>
  </section>
  <p class="err" id="err"></p>
  <section>
    <div class="section-head">
      <h2>项目</h2>
      <button type="button" id="open-project">登记项目</button>
    </div>
    <ul id="projects"></ul>
  </section>
  <dialog id="project-dialog">
    <form id="project-form" class="stack">
      <h2>登记项目</h2>
      <input name="name" placeholder="显示名称，可空" />
      <input name="path" placeholder="电脑上的文件夹路径" required />
      <select name="runner">
        <option value="cursor">Cursor</option>
        <option value="opencode">OpenCode</option>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <p class="dialog-error" id="dialog-err"></p>
      <div class="dialog-actions">
        <button type="button" class="ghost" id="close-project">取消</button>
        <button>登记</button>
      </div>
    </form>
  </dialog>
</main>
<script>
  const err = document.querySelector("#err");
  const showError = (error) => { err.textContent = error?.message || String(error || ""); };
  async function api(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || "请求失败");
    return body;
  }
  const runners = [
    ["cursor", "Cursor"],
    ["opencode", "OpenCode"],
    ["claude", "Claude"],
    ["codex", "Codex"],
  ];
  async function load() {
    const data = await api("/api/catalog");
    const projects = document.querySelector("#projects");
    projects.replaceChildren(...data.projects.map((project) => {
      const item = document.createElement("li");
      item.className = "project";
      const head = document.createElement("div");
      head.className = "project-head";
      const text = document.createElement("div");
      text.innerHTML = "<b></b><small></small>";
      text.querySelector("b").textContent = project.name;
      text.querySelector("small").textContent = project.path;
      const runner = document.createElement("span");
      runner.className = "runner";
      runner.textContent = Object.fromEntries(runners)[project.runner] || "Cursor";
      text.append(runner);
      const button = document.createElement("button");
      button.className = "ghost";
      button.textContent = "移除";
      button.onclick = async () => {
        await api("/api/projects?id=" + encodeURIComponent(project.id), { method: "DELETE" });
        await load();
      };
      head.append(text, button);
      item.append(head);
      return item;
    }));
  }
  const dialog = document.querySelector("#project-dialog");
  const dialogErr = document.querySelector("#dialog-err");
  document.querySelector("#open-project").onclick = () => {
    dialogErr.textContent = "";
    dialog.showModal();
  };
  document.querySelector("#close-project").onclick = () => dialog.close();
  const projectForm = document.querySelector("#project-form");
  projectForm.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(projectForm);
    try {
      await api("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: data.get("name"), path: data.get("path"), runner: data.get("runner") }) });
      projectForm.reset();
      dialog.close();
      await load();
    } catch (error) { dialogErr.textContent = error?.message || String(error || ""); }
  };
  load().catch(showError);
</script>
`;
}

function phoneDomain(raw: string): string {
  const normalized = raw.trim().replace(/^ws/, "http");
  try {
    return new URL(normalized).origin;
  } catch {
    return normalized.split(/[?#]/)[0].replace(/\/$/, "");
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}
