import http from "node:http";
import { WebSocketServer } from "ws";
import { RUNNERS, type RunnerId } from "../shared/protocol.js";
import { addSocket, broadcastCatalog } from "./hub.js";
import { setupPage } from "./setup-page.js";
import { listCursorModels } from "./cursor-models.js";
import { pairingCard } from "./identity.js";
import { startTunnel } from "./tunnel.js";
import {
  addAgent,
  setAgentModel,
  addProject,
  bindProject,
  listAgents,
  listProjects,
  loadStore,
  releaseOrphanedRuns,
  removeAgent,
  removeProject,
} from "./store.js";

const port = Number(process.env.PORT || 8787);

await loadStore();
await releaseOrphanedRuns();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (url.pathname === "/setup" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(setupPage(await pairingCard(), await listCursorModels()));
      return;
    }
    if (url.pathname === "/api/catalog" && req.method === "GET") {
      return json(res, 200, { projects: listProjects(), agents: listAgents() });
    }
    if (url.pathname === "/api/projects" && req.method === "POST") {
      const body = await readJson(req);
      const agentId = String(body.agentId || "");
      const project = await addProject(String(body.path || ""), agentId, body.name ? String(body.name) : undefined);
      broadcastCatalog();
      return json(res, 200, project);
    }
    if (url.pathname === "/api/projects/bind" && req.method === "POST") {
      const body = await readJson(req);
      const project = await bindProject(String(body.id || ""), String(body.agentId || ""));
      broadcastCatalog();
      return json(res, 200, project);
    }
    if (url.pathname === "/api/projects" && req.method === "DELETE") {
      const id = url.searchParams.get("id") || "";
      await removeProject(id);
      broadcastCatalog();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/agents" && req.method === "POST") {
      const body = await readJson(req);
      const runner = String(body.runner || "") as RunnerId;
      if (!RUNNERS.includes(runner)) return json(res, 400, { message: "不支持的通道" });
      const name = String(body.name || "").trim();
      if (!name) return json(res, 400, { message: "名称是空的" });
      const agent = await addAgent(name, runner, body.model ? String(body.model) : undefined);
      broadcastCatalog();
      return json(res, 200, agent);
    }
    if (url.pathname === "/api/agents/model" && req.method === "POST") {
      const body = await readJson(req);
      const agent = await setAgentModel(String(body.id || ""), String(body.model || ""));
      broadcastCatalog();
      return json(res, 200, agent);
    }
    if (url.pathname === "/api/agents" && req.method === "DELETE") {
      const id = url.searchParams.get("id") || "";
      await removeAgent(id);
      broadcastCatalog();
      return json(res, 200, { ok: true });
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    json(res, 400, { message: error instanceof Error ? error.message : "请求失败" });
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (socket) => addSocket(socket));

server.listen(port, "0.0.0.0", () => {
  console.log(`agentsmaster server http://0.0.0.0:${port}`);
  console.log(`setup http://127.0.0.1:${port}/setup`);
  startTunnel(port);
});

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
