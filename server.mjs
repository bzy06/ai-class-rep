import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMessages,
  chatCompletionsUrl,
  contentFromDelta,
  contentFromMessage,
  reasoningFromDelta,
  reasoningFromMessage,
  visibleAnswer,
  fallbackReport,
  normalizeReport,
  parseModelJson,
  reportIsUseful,
  reportToPlain,
  resolveBilibili,
} from "./lib.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(ROOT, "public");
const DATA_DIR = process.env.KEDAIBIAO_DATA
  ? path.resolve(process.env.KEDAIBIAO_DATA)
  : path.resolve(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const PORT = Number(process.env.PORT) || 8787;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function defaultSettings() {
  return { baseUrl: "", apiKey: "", model: "", temperature: 0.4, sendTemperature: true };
}

function normalizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const temperature = Number(source.temperature);
  return {
    baseUrl: String(source.baseUrl || "").trim().slice(0, 500),
    apiKey: String(source.apiKey || "").slice(0, 500),
    model: String(source.model || "").trim().slice(0, 200),
    temperature: Number.isFinite(temperature) ? Math.min(1, Math.max(0, temperature)) : 0.4,
    sendTemperature: source.sendTemperature !== false,
  };
}

function normalizeHistory(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item && typeof item === "object" && item.id)
    .slice(0, 40);
}

async function readStore() {
  try {
    const data = JSON.parse(await readFile(STORE_FILE, "utf8"));
    return {
      initialized: true,
      settings: normalizeSettings(data.settings),
      history: normalizeHistory(data.history),
    };
  } catch {
    return { initialized: false, settings: defaultSettings(), history: [] };
  }
}

let storeQueue = Promise.resolve();

function updateStore(change) {
  storeQueue = storeQueue.then(async () => {
    const current = await readStore();
    const next = {
      settings: normalizeSettings(change.settings === undefined ? current.settings : change.settings),
      history: normalizeHistory(change.history === undefined ? current.history : change.history),
    };
    await mkdir(path.dirname(STORE_FILE), { recursive: true });
    const temporary = `${STORE_FILE}.tmp`;
    await writeFile(temporary, JSON.stringify(next));
    await rename(temporary, STORE_FILE);
  });
  return storeQueue;
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 1_500_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("内容太长了，缩短文字稿再试。"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error("请求格式不对。"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function llmErrorMessage(error) {
  const cause = error?.cause?.code || error?.code;
  if (cause === "ECONNREFUSED") return "连不上这个接口。如果是本机模型，先确认服务已经启动。";
  if (cause === "ENOTFOUND") return "找不到这个接口地址。检查有没有写错域名。";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return "模型太久没有写完。可以缩短文字稿，或换一个更快的模型。";
  }
  return error?.message || "模型接口没有完成这次整理。";
}

function absorbChoice(choice, state, onDelta) {
  const delta = choice?.delta;
  const message = choice?.message;
  const contentPiece = contentFromDelta(delta);
  const reasoningPiece = reasoningFromDelta(delta);
  if (contentPiece) state.content += contentPiece;
  if (reasoningPiece) state.reasoning += reasoningPiece;
  if (!contentPiece && !reasoningPiece && message) {
    if (!state.content) state.content = contentFromMessage(message);
    if (!state.reasoning) state.reasoning = reasoningFromMessage(message);
  }
  const visible = visibleAnswer(state.content, state.reasoning);
  if (visible) onDelta?.(visible);
  return state;
}

async function readUpstream(response, onDelta) {
  const type = response.headers.get("content-type") || "";
  if (type.includes("text/html")) {
    throw new Error("这个地址打开的是网页，不是聊天接口。请填到 /v1，例如 https://api.openai.com/v1");
  }
  const state = { content: "", reasoning: "" };
  if (type.includes("application/json")) {
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || data.error || "模型接口报错");
    if (!data.choices) throw new Error(data.message || "接口没有返回笔记内容");
    const message = data.choices[0]?.message || {};
    state.content = contentFromMessage(message);
    state.reasoning = reasoningFromMessage(message);
    return visibleAnswer(state.content, state.reasoning);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload);
        if (event.error) throw new Error(event.error.message || "模型接口报错");
        absorbChoice(event.choices?.[0] || {}, state, onDelta);
      } catch (error) {
        if (error.message && !error.message.startsWith("Unexpected")) throw error;
      }
    }
  }
  return visibleAnswer(state.content, state.reasoning);
}

async function completeChat(llm, messages, { maxTokens, signal, onDelta }) {
  const url = chatCompletionsUrl(llm.baseUrl);
  if (!llm.model) throw Object.assign(new Error("先填写模型名。"), { status: 400 });
  let useStream = true;
  let tokenKey = "max_tokens";
  let useTemperature = llm.sendTemperature !== false;
  let disableThinking = true;
  const tried = new Set();
  let lastError = null;

  while (tried.size < 8) {
    const key = `${useStream}|${tokenKey}|${useTemperature}|${disableThinking}`;
    if (tried.has(key)) break;
    tried.add(key);
    const body = {
      model: llm.model,
      messages,
      stream: useStream,
      [tokenKey]: maxTokens,
    };
    if (disableThinking) body.thinking = { type: "disabled" };
    if (useTemperature) body.temperature = Number(llm.temperature ?? 0.4);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const raw = await response.text();
        let message = `模型接口返回 ${response.status}`;
        if (raw.trim().startsWith("<")) {
          message = "这个地址打开的是网页，不是聊天接口。请填到 /v1，例如 https://api.openai.com/v1";
        } else {
          try {
            const data = JSON.parse(raw);
            message = data.error?.message || data.message || message;
          } catch {
            if (raw) message = raw.slice(0, 300);
          }
        }
        const error = new Error(message);
        if (adjustAttempt(error)) continue;
        throw error;
      }
      const text = await readUpstream(response, onDelta);
      if (!text.trim()) {
        throw new Error("模型没有返回正文。deepseek-flash 会先把篇幅用在思考上，这次思考占满了输出。请再测一次。");
      }
      return text;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (adjustAttempt(error)) continue;
      throw error;
    }
  }

  function adjustAttempt(error) {
    const message = error?.message || "";
    if (disableThinking && /thinking/i.test(message)) {
      disableThinking = false;
      return true;
    }
    if (useTemperature && /temperature/i.test(message)) {
      useTemperature = false;
      return true;
    }
    if (tokenKey === "max_tokens" && /max_tokens/i.test(message)) {
      tokenKey = "max_completion_tokens";
      return true;
    }
    if (useStream && /stream/i.test(message)) {
      useStream = false;
      return true;
    }
    return false;
  }

  throw lastError || new Error("模型接口没有完成这次请求。");
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleGenerate(req, res) {
  const body = await readBody(req);
  const material = body.material || {};
  const mode = ["notes", "brief", "review"].includes(body.mode) ? body.mode : "notes";
  const llm = body.llm || {};
  if (!String(material.transcript || "").trim()) {
    json(res, 400, { message: "没有文字稿，还不能整理。" });
    return;
  }
  if (!llm.baseUrl || !llm.model) {
    json(res, 400, { message: "先在右上角填写接口地址和模型名。" });
    return;
  }

  const facts = { mode, title: material.title || "", material };
  const built = buildMessages(material, mode);
  const maxTokens = mode === "brief" ? 2500 : 4500;
  const upstream = new AbortController();
  const timer = setTimeout(() => upstream.abort(), 180000);
  let clientGone = false;
  req.on("close", () => {
    clientGone = true;
    upstream.abort();
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  sendEvent(res, "status", { message: "正在写笔记" });

  try {
    let raw = await completeChat(llm, built.messages, {
      maxTokens,
      signal: upstream.signal,
      onDelta: (text) => {
        if (!clientGone) sendEvent(res, "delta", { chars: text.length });
      },
    });
    let report;
    let notice = "";
    try {
      report = normalizeReport(parseModelJson(raw), facts);
      if (!report.sections.length) throw new Error("空笔记");
    } catch {
      try {
        raw = await completeChat(
          llm,
          [
            ...built.messages,
            { role: "assistant", content: raw.slice(0, 12000) },
            { role: "user", content: "上次的输出无法解析。请只重新输出一个合法 JSON 对象，不要围栏，不要解释。" },
          ],
          { maxTokens, signal: upstream.signal },
        );
        report = normalizeReport(parseModelJson(raw), facts);
        if (!report.sections.length) throw new Error("空笔记");
      } catch {
        report = fallbackReport(raw, facts);
        notice = "模型没有按笔记结构返回，下面保留了它写出的内容。";
      }
    }
    if (!reportIsUseful(report)) {
      report = fallbackReport(raw, facts);
      notice = "模型没有按笔记结构返回，下面保留了它写出的内容。";
    }
    if (!clientGone) {
      sendEvent(res, "done", { report, truncated: built.truncated, notice });
    }
  } catch (error) {
    if (!clientGone) sendEvent(res, "error", { message: llmErrorMessage(error) });
  } finally {
    clearTimeout(timer);
    res.end();
  }
}

async function handleAsk(req, res) {
  const body = await readBody(req);
  const question = String(body.question || "").trim().slice(0, 500);
  const llm = body.llm || {};
  if (!question) {
    json(res, 400, { message: "先写下想问的问题。" });
    return;
  }
  if (!llm.baseUrl || !llm.model) {
    json(res, 400, { message: "先填写接口地址和模型名。" });
    return;
  }
  const notes = reportToPlain(body.report || {}).slice(0, 12000);
  const transcript = String(body.transcript || "").slice(0, 12000);
  const upstream = new AbortController();
  const timer = setTimeout(() => upstream.abort(), 90000);
  try {
    const answer = await completeChat(
      llm,
      [
        {
          role: "system",
          content: "你是这节课的课代表。只根据笔记和文字稿回答。笔记里没有的就直接说没有，不要编。用清楚的口语，两到六句。",
        },
        {
          role: "user",
          content: `笔记：\n${notes}\n\n文字稿：\n${transcript || "（没有另附文字稿）"}\n\n问题：${question}`,
        },
      ],
      { maxTokens: 800, signal: upstream.signal },
    );
    json(res, 200, { ok: true, answer: answer.trim() });
  } catch (error) {
    json(res, 502, { message: llmErrorMessage(error) });
  } finally {
    clearTimeout(timer);
  }
}

async function handleTest(req, res) {
  const body = await readBody(req);
  const llm = body.llm || {};
  const upstream = new AbortController();
  const timer = setTimeout(() => upstream.abort(), 30000);
  try {
    const reply = await completeChat(
      llm,
      [
        { role: "system", content: "只回复两个字：课代表" },
        { role: "user", content: "请回复" },
      ],
      { maxTokens: 256, signal: upstream.signal },
    );
    json(res, 200, { ok: true, reply: reply.replace(/\s+/g, " ").trim().slice(0, 80) });
  } catch (error) {
    json(res, 502, { message: llmErrorMessage(error) });
  } finally {
    clearTimeout(timer);
  }
}

function insidePublic(file) {
  const relative = path.relative(PUBLIC, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === "/" ? "/index.html" : pathname));
  if (!insidePublic(file)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("找不到页面");
  }
}

const server = createServer(async (req, res) => {
  const rawUrl = (req.url || "/").replace(/^\/+/, "/");
  const url = new URL(rawUrl, "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/library") {
      json(res, 200, { ok: true, ...(await readStore()) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      const body = await readBody(req);
      await updateStore({ settings: body.settings });
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/history") {
      const body = await readBody(req, 8_000_000);
      await updateStore({ history: body.history });
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/resolve") {
      const body = await readBody(req);
      const material = await resolveBilibili(body.input);
      json(res, 200, material);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/generate") {
      await handleGenerate(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/ask") {
      await handleAsk(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/test") {
      await handleTest(req, res);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      json(res, 404, { message: "没有这个接口" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    await serveStatic(res, decodeURIComponent(url.pathname));
  } catch (error) {
    if (res.headersSent) {
      sendEvent(res, "error", { message: error.message || "整理中断了" });
      res.end();
      return;
    }
    json(res, error.status || 500, { message: error.message || "服务出错了" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`课代表 http://127.0.0.1:${PORT}`);
});
