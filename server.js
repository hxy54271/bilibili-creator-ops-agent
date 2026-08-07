// ============================================================
//  B 站创作者运营 Agent —— 本地服务（vibe coding · RAG 升级）
//  职责：
//   1) 静态托管前端（index.html / app.js / data.js）
//   2) POST /api/rag  —— 知识库稀疏检索 → 组装 prompt → 调用大模型
//      真实模式：调用 OpenAI 兼容接口（多 provider 预设）
//      演示模式：无 API Key 时返回标注清晰的 mock 响应，便于离线演示完整 RAG 流程
//  说明：API Key 仅存在于服务端（config.json / 环境变量），绝不进入前端。
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

// ---------- 1. 配置：provider 预设 + config.json / 环境变量 ----------
const PROVIDERS = {
  openai:   { base: "https://api.openai.com/v1",                          model: "gpt-4o-mini" },
  deepseek: { base: "https://api.deepseek.com/v1",                       model: "deepseek-chat" },
  qwen:     { base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  zhipu:    { base: "https://open.bigmodel.cn/api/paas/v4",              model: "glm-4-flash" },
  custom:   { base: process.env.LLM_BASE_URL || "",                      model: process.env.LLM_MODEL || "" },
};

let cfg = { provider: "openai", base_url: "", api_key: "", model: "" };
try {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  Object.assign(cfg, c);
} catch (e) { /* 无 config.json 则用默认值 / 环境变量 */ }

cfg.provider = process.env.LLM_PROVIDER || cfg.provider || "openai";
cfg.api_key = process.env.LLM_API_KEY || cfg.api_key || "";
cfg.base_url = process.env.LLM_BASE_URL || cfg.base_url || (PROVIDERS[cfg.provider] || {}).base || "";
cfg.model   = process.env.LLM_MODEL   || cfg.model   || (PROVIDERS[cfg.provider] || {}).model || "";

// ---------- 2. 载入知识库与核心逻辑 ----------
const DATA = require("./data.js");
global.DATA = DATA;
const app = require("./app.js");

// ---------- 3. 静态文件 ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".md": "text/markdown; charset=utf-8" };

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ""));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end("Not Found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

// ---------- 4. /api/rag 主逻辑 ----------
function buildLabelsList() {
  return DATA.labels.map((l) => `${l.id} : ${l.name}（${l.desc}）`).join("\n");
}

function buildSystemPrompt() {
  return [
    "你是 B 站创作者运营团队的「进线分类与总结」Agent。",
    "下面是与该进线最相关的【运营域结构化知识库】检索结果（含进线标签体系、业务 FAQ、维护口径）。",
    "请严格依据知识库与进线原文，输出一个 JSON 对象，不要输出任何额外文字。",
    "JSON 字段定义：",
    "  label_id  : 必须是给定候选标签 id 之一；无法确定时用 'other'",
    "  confidence: 0~1 的浮点数，表示你对该分类的把握",
    "  user_type : 'UP 主/创作者' 或 '普通用户/粉丝'",
    "  core_need : 一句话概括核心诉求",
    "  emotion   : '低' / '中' / '高'",
    "  priority  : '高' / '中' / '低'（投诉/违规/账号被盗等紧急事项为高）",
    "  action    : 依据知识库维护口径给出的下一步建议动作",
    "  reason    : 中文，简要说明分类依据，并引用检索到的知识库来源",
  ].join("\n");
}

function buildUserPrompt(context, text) {
  return [
    "【候选标签 id 列表】\n" + buildLabelsList(),
    "",
    "【检索到的知识库切片】\n" + context,
    "",
    "【进线原文】\n" + text,
    "",
    "请输出 JSON。",
  ].join("\n");
}

// 稳健提取 JSON（兼容模型偶尔包裹 markdown 代码块的情况）
function extractJSON(str) {
  if (!str) return null;
  const m = str.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

function toSummary(j, labelName) {
  return {
    用户类型: j.user_type || "普通用户/粉丝",
    核心诉求: j.core_need || labelName,
    情绪等级: j.emotion || "低",
    优先级: j.priority || "中",
    建议动作: j.action || "",
    检索命中FAQ: [],
  };
}

async function callLLM(text, context) {
  const url = (cfg.base_url.replace(/\/$/, "") + "/chat/completions");
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(context, text) },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.api_key },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error("LLM HTTP " + resp.status + " " + txt.slice(0, 200));
  }
  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const j = extractJSON(content);
  if (!j) throw new Error("无法解析大模型返回的 JSON：" + String(content).slice(0, 200));
  return j;
}

function handleRag(req, res) {
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
  req.on("end", async () => {
    let payload = {};
    try { payload = JSON.parse(raw || "{}"); } catch (e) { /* ignore */ }
    const text = (payload.text || "").trim();
    const mock = !!payload.mock;
    if (!text) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "缺少 text 字段" })); return; }

    const { context, sources } = app.retrieveContext(text, 6);
    const useReal = !mock && !!cfg.api_key;

    try {
      if (!useReal) {
        // —— 演示模式（mock）：复用规则基线生成结构化结果，标注清晰，不调用真实大模型 ——
        const r = app.classify(text);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          mode: "mock",
          predicted: r.predicted,
          labelName: r.labelName,
          confidence: r.confidence,
          summary: r.summary,
          retrieved: sources,
          reason: "（演示模式·模拟大模型）基于检索到的知识库切片 + 规则基线生成，未调用真实大模型 API；配置 API Key 后自动切换为真实 RAG。",
        }, null, 2));
        return;
      }
      // —— 真实 RAG 模式 ——
      const j = await callLLM(text, context);
      const labelObj = DATA.labels.find((l) => l.id === j.label_id) || DATA.labels.find((l) => l.id === "other");
      const predicted = labelObj ? labelObj.id : "other";
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        mode: "rag",
        provider: cfg.provider,
        predicted,
        labelName: labelObj ? labelObj.name : "其他/兜底",
        confidence: typeof j.confidence === "number" ? +j.confidence.toFixed(2) : 0.8,
        summary: toSummary(j, labelObj ? labelObj.name : "其他/兜底"),
        retrieved: sources,
        reason: j.reason || "",
      }, null, 2));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "RAG 调用失败：" + e.message, mode: "error" }));
    }
  });
}

// ---------- 5. 路由 ----------
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.split("?")[0] === "/api/rag") return handleRag(req, res);
  if (req.method === "GET" && req.url.split("?")[0] === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, llmConfigured: !!cfg.api_key, provider: cfg.provider, model: cfg.model }));
    return;
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405); res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log("==============================================");
  console.log("  B 站创作者运营 Agent 本地服务已启动");
  console.log("  打开:  http://localhost:" + PORT);
  console.log("  大模型: " + (cfg.api_key ? "已配置 (" + cfg.provider + " / " + cfg.model + ")" : "未配置 → /api/rag 走演示模式(mock)"));
  console.log("  配置方式: 复制 config.example.json 为 config.json 并填入 api_key，或设置环境变量 LLM_API_KEY / LLM_PROVIDER");
  console.log("==============================================");
});
