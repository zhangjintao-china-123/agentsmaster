import os from "node:os";
import path from "node:path";
import { chromeDebugPort } from "./browser.js";
import { ensurePublicUrl } from "./identity.js";

export function setupPage(pairing: { url: string; svg: string } | null = null, models: { id: string; name: string }[] = []): string {
  const debugPort = chromeDebugPort();
  const browserUrl = `http://127.0.0.1:${debugPort}`;
  const profileDir = path.join(os.homedir(), ".agentsmaster", "chrome");
  const phoneUrl = phoneDomain(ensurePublicUrl());
  const modelOptions = models
    .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`)
    .join("");
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
  <p>登记项目时绑定一个 agent。手机上点项目就会和这个 agent 会话。</p>
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
    <h2>Agent</h2>
    <form id="agent-form">
      <input name="name" placeholder="名称，例如 写代码的 Cursor" required />
      <select name="runner" id="agent-runner">
        <option value="pi">Pi</option>
        <option value="cursor">Cursor</option>
        <option value="opencode">OpenCode</option>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <select name="model" id="agent-model" hidden>
        ${modelOptions || '<option value="">Auto</option>'}
      </select>
      <button>登记</button>
    </form>
    <ul id="agents"></ul>
  </section>
  <section>
    <h2>项目</h2>
    <form id="project-form">
      <input name="name" placeholder="显示名称，可空" />
      <input name="path" placeholder="电脑上的文件夹路径" required />
      <select name="agentId" id="project-agent" required></select>
      <button>登记</button>
    </form>
    <ul id="projects"></ul>
  </section>
</main>
<script>
  const models = ${JSON.stringify(models)};
  const err = document.querySelector("#err");
  const showError = (error) => { err.textContent = error?.message || String(error || ""); };
  async function api(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || "请求失败");
    return body;
  }
  function row(title, detail, onRemove) {
    const item = document.createElement("li");
    const text = document.createElement("div");
    text.innerHTML = "<b></b><small></small>";
    text.querySelector("b").textContent = title;
    text.querySelector("small").textContent = detail;
    const button = document.createElement("button");
    button.className = "ghost";
    button.textContent = "移除";
    button.onclick = onRemove;
    item.append(text, button);
    return item;
  }
  async function load() {
    const data = await api("/api/catalog");
    const agents = document.querySelector("#agents");
    const projects = document.querySelector("#projects");
    const manageable = data.agents.filter((agent) => agent.id !== "pi-admin");
    agents.replaceChildren(...manageable.map((agent) => {
      const modelName = agent.model ? (models.find((model) => model.id === agent.model)?.name || agent.model) : "";
      const item = row(agent.name, agent.runner + (modelName ? " · " + modelName : ""), async () => {
        await api("/api/agents?id=" + encodeURIComponent(agent.id), { method: "DELETE" });
        await load();
      });
      if (agent.runner === "cursor") {
        const select = document.createElement("select");
        for (const model of models) {
          const option = document.createElement("option");
          option.value = model.id;
          option.textContent = model.name;
          if ((agent.model || "") === model.id) option.selected = true;
          select.append(option);
        }
        select.onchange = async () => {
          try {
            await api("/api/agents/model", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: agent.id, model: select.value }),
            });
            await load();
          } catch (error) { showError(error); }
        };
        item.insertBefore(select, item.lastChild);
      }
      return item;
    }));
    const agentSelect = document.querySelector("#project-agent");
    const selected = agentSelect.value;
    agentSelect.replaceChildren(...manageable.map((agent) => {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.name;
      return option;
    }));
    if ([...agentSelect.options].some((option) => option.value === selected)) agentSelect.value = selected;
    projects.replaceChildren(...data.projects.map((project) => {
      const item = document.createElement("li");
      const text = document.createElement("div");
      const bound = data.agents.find((agent) => agent.id === project.agentId);
      text.innerHTML = "<b></b><small></small>";
      text.querySelector("b").textContent = project.name;
      text.querySelector("small").textContent = (bound ? bound.name : "未绑定") + " · " + project.path;
      const select = document.createElement("select");
      for (const agent of manageable) {
        const option = document.createElement("option");
        option.value = agent.id;
        option.textContent = agent.name;
        if (agent.id === project.agentId) option.selected = true;
        select.append(option);
      }
      select.onchange = async () => {
        try {
          await api("/api/projects/bind", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: project.id, agentId: select.value }),
          });
          await load();
        } catch (error) { showError(error); }
      };
      const button = document.createElement("button");
      button.className = "ghost";
      button.textContent = "移除";
      button.onclick = async () => {
        await api("/api/projects?id=" + encodeURIComponent(project.id), { method: "DELETE" });
        await load();
      };
      item.append(text, select, button);
      return item;
    }));
  }
  document.querySelector("#agent-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: data.get("name"), runner: data.get("runner"), model: data.get("model") }) });
      event.currentTarget.reset();
      await load();
    } catch (error) { showError(error); }
  };
  document.querySelector("#project-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: data.get("name"), path: data.get("path"), agentId: data.get("agentId") }) });
      event.currentTarget.reset();
      await load();
    } catch (error) { showError(error); }
  };
  const runner = document.querySelector("#agent-runner");
  const model = document.querySelector("#agent-model");
  const syncModel = () => {
    const cursor = runner.value === "cursor";
    model.hidden = !cursor;
    model.disabled = !cursor;
  };
  runner.onchange = syncModel;
  syncModel();
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
