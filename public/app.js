import { SAMPLES } from "./samples.js";

const HISTORY_KEY = "kedaibiao.history";
const SETTINGS_KEY = "kedaibiao.settings";
const DRAFT_KEY = "kedaibiao.draft";
const MODES = { notes: "课堂笔记", brief: "精简速览", review: "考前复习" };

const $ = (selector) => document.querySelector(selector);

let settings = loadSettings();
let historyItems = loadHistory();
let current = null;
let pendingVideo = null;
let busy = false;
let asking = false;
let abortGenerate = null;
let progressTimer = 0;
let toastTimer = 0;

const home = $("#view-home");
const reportView = $("#view-report");
const reportRoot = $("#report");
const errorBox = $("#form-error");
const progressBox = $("#progress");
const progressDetail = $("#progress-detail");
const generateButton = $("#generate");
const transcript = $("#transcript");
const videoHint = $("#video-hint");

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      baseUrl: saved.baseUrl || "",
      apiKey: saved.apiKey || "",
      model: saved.model || "",
      temperature: Number.isFinite(saved.temperature) ? saved.temperature : 0.4,
      sendTemperature: saved.sendTemperature !== false,
    };
  } catch {
    return { baseUrl: "", apiKey: "", model: "", temperature: 0.4, sendTemperature: true };
  }
}

function loadHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* 浏览器配额满时仍以电脑存档为准 */ }
  return apiJson("/api/settings", { settings });
}

function persistHistory() {
  const save = (items) => localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  try {
    save(historyItems);
  } catch {
    historyItems = historyItems.slice(0, 8).map((item) => ({
      ...item,
      material: { ...item.material, transcript: (item.material?.transcript || "").slice(0, 4000) },
    }));
    try { save(historyItems); } catch { /* 浏览器放不下时，仍写入电脑存档 */ }
  }
  return apiJson("/api/history", { history: historyItems }).catch(() => {
    toast("笔记没有写进电脑存档");
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch { /* 非链接就不当作链接 */ }
  return "";
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
}

function setError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message || "";
}

function paintSetup() {
  $("[data-action='settings']").classList.toggle("needs-setup", !settings.baseUrl || !settings.model);
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || "notes";
}

function setTab(tab) {
  for (const name of ["video", "text", "file"]) {
    const button = $(`#tab-${name}`);
    const panel = $(`#panel-${name}`);
    const selected = name === tab;
    button.setAttribute("aria-selected", selected ? "true" : "false");
    panel.hidden = !selected;
  }
  const writing = tab !== "video";
  $("#course-field").hidden = !writing;
  $("#transcript-field").hidden = !writing;
  if (tab === "video") videoHint.hidden = !pendingVideo;
}

function countTranscript() {
  const count = transcript.value.trim().length;
  $("#char-count").textContent = count ? `${count} 字` : "";
}

function parseCaption(name, raw) {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r/g, "");
  const lower = name.toLowerCase();
  if (lower.endsWith(".srt")) return parseTimed(text) || text.trim();
  if (lower.endsWith(".vtt")) return parseTimed(text.replace(/^WEBVTT[^\n]*\n/i, "")) || text.trim();
  if (lower.endsWith(".ass") || lower.endsWith(".ssa")) {
    const lines = text.split("\n").flatMap((line) => {
      if (!line.startsWith("Dialogue:")) return [];
      const parts = line.split(",");
      if (parts.length < 10) return [];
      const spoken = parts.slice(9).join(",").replace(/\{[^}]*\}/g, "").replace(/\\N/gi, " ").trim();
      return spoken ? [`[${parts[1]}] ${spoken}`] : [];
    });
    return lines.join("\n") || text.trim();
  }
  return text.trim();
}

function parseTimed(text) {
  const blocks = text.split(/\n{2,}/);
  const lines = [];
  for (const block of blocks) {
    const rows = block.split("\n").map((row) => row.trim()).filter(Boolean);
    const timeIndex = rows.findIndex((row) => row.includes("-->"));
    if (timeIndex < 0) continue;
    const start = rows[timeIndex].split("-->")[0].trim().slice(0, 12);
    const spoken = rows.slice(timeIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (spoken) lines.push(`[${start}] ${spoken}`);
  }
  return lines.join("\n");
}

async function readFile(file) {
  if (!file) return;
  if (file.size > 2_000_000) {
    setError("文件超过 2MB。可以先剪成这一节课的字幕。");
    return;
  }
  const text = parseCaption(file.name, await file.text());
  transcript.value = text;
  countTranscript();
  $("#file-note").textContent = `${file.name} · ${text.length} 字`;
  setTab("file");
  $("#transcript-field").hidden = false;
  setError("");
}

function fillSettingsForm() {
  $("#base-url").value = settings.baseUrl;
  $("#api-key").value = settings.apiKey;
  $("#model").value = settings.model;
  $("#temperature").value = String(settings.temperature);
  $("#temperature-out").textContent = Number(settings.temperature).toFixed(1);
  $("#send-temperature").checked = settings.sendTemperature;
}

function readSettingsForm() {
  return {
    baseUrl: $("#base-url").value.trim(),
    apiKey: $("#api-key").value,
    model: $("#model").value.trim(),
    temperature: Number($("#temperature").value),
    sendTemperature: $("#send-temperature").checked,
  };
}

function openSettings(hint) {
  fillSettingsForm();
  $("#settings-hint").textContent = hint || (settings.baseUrl && settings.model ? "已保存在这台电脑上，换浏览器也能用。" : "");
  $("#settings").showModal();
  $("#base-url").focus();
}

function openHistory() {
  $("#history-search").value = "";
  paintHistory();
  $("#history").showModal();
  $("#history-search").focus();
}

function paintHistory() {
  const query = $("#history-search").value.trim().toLowerCase();
  const items = historyItems.filter((item) => item.title.toLowerCase().includes(query) || item.report?.title?.toLowerCase().includes(query));
  const list = $("#history-list");
  if (!items.length) {
    list.innerHTML = `<p class="empty">${historyItems.length ? "没有匹配的笔记。" : "还没有笔记。整理完一节课，会留在这台电脑上。"}</p>`;
    return;
  }
  list.innerHTML = items.map((item) => `
    <article class="history-item">
      <button type="button" data-go="#/h/${escapeHtml(item.id)}">
        <strong>${escapeHtml(item.report.title)}</strong>
        <span>${MODES[item.mode] || "笔记"} · ${formatWhen(item.createdAt)}</span>
      </button>
      <button type="button" class="textish" data-delete="${escapeHtml(item.id)}">删除</button>
    </article>
  `).join("");
}

function formatWhen(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function remember(item) {
  historyItems = [item, ...historyItems.filter((entry) => entry.id !== item.id)].slice(0, 20);
  persistHistory();
}

function storeMaterial(material) {
  return {
    title: material.title || "",
    author: material.author || "",
    url: material.url || "",
    durationText: material.durationText || "",
    intro: (material.intro || "").slice(0, 500),
    transcript: (material.transcript || "").slice(0, 20000),
  };
}

async function apiJson(path, body, signal) {
  let response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("连不上本机的课代表服务。");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.message || "请求失败");
  return data;
}

async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");
      let event = "message";
      const data = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) onEvent(event, JSON.parse(data.join("\n")));
    }
  }
}

function setStage(stage, detail) {
  document.querySelectorAll("[data-step]").forEach((node) => {
    const index = Number(node.dataset.step);
    node.classList.toggle("done", index < stage);
    node.classList.toggle("active", index === stage);
  });
  if (detail) progressDetail.textContent = detail;
}

function startProgress() {
  const started = Date.now();
  progressBox.hidden = false;
  generateButton.hidden = true;
  setStage(0, "正在读取材料");
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    const base = progressDetail.dataset.base || progressDetail.textContent.replace(/ · \d+ 秒$/, "");
    progressDetail.dataset.base = base;
    progressDetail.textContent = `${base} · ${seconds} 秒`;
  }, 500);
}

function stopProgress() {
  clearInterval(progressTimer);
  progressBox.hidden = true;
  generateButton.hidden = false;
  delete progressDetail.dataset.base;
}

function ensureModel() {
  if (settings.baseUrl && settings.model) return true;
  openSettings("先填写接口地址和模型名。");
  return false;
}

async function resolveVideo(signal) {
  const input = $("#video-input").value.trim();
  if (!input) throw new Error("先粘贴视频链接、分享文案或 BV 号。");
  setStage(0, "正在读取视频");
  const resolved = await apiJson("/api/resolve", { input }, signal);
  pendingVideo = resolved;
  if (!resolved.transcript) {
    videoHint.hidden = false;
    videoHint.textContent = resolved.warning || "已读到这个视频，但没有公开字幕。把文字稿贴进来后，仍会带上标题。";
    if (!$("#course-title").value) $("#course-title").value = resolved.title || "";
    setTab("text");
    transcript.focus();
    throw new Error(videoHint.textContent);
  }
  videoHint.hidden = true;
  return {
    title: resolved.title,
    author: resolved.author,
    url: resolved.url,
    durationText: resolved.durationText,
    intro: resolved.intro,
    transcript: resolved.transcript,
    notice: resolved.basis === "description" ? resolved.warning : "",
  };
}

function materialFromDraft() {
  const title = $("#course-title").value.trim();
  return {
    title: title || pendingVideo?.title || "",
    author: pendingVideo?.author || "",
    url: pendingVideo?.url || "",
    durationText: pendingVideo?.durationText || "",
    intro: pendingVideo?.intro || "",
    transcript: transcript.value.trim(),
  };
}

async function runGenerate(material, mode) {
  if (!material.transcript) throw new Error("先放进这节课的文字稿或字幕。");
  if (!ensureModel()) return;
  const controller = new AbortController();
  abortGenerate = () => controller.abort();
  busy = true;
  setError("");
  startProgress();
  setStage(1, material.title ? `正在理解《${material.title}》` : "正在理解这节课");
  let chars = 0;
  let donePayload = null;
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ material, mode, llm: settings }),
      signal: controller.signal,
    });
    const type = response.headers.get("content-type") || "";
    if (!type.includes("text/event-stream")) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || "整理失败");
    }
    await readEvents(response, (event, data) => {
      if (event === "delta") {
        chars = data.chars || chars;
        setStage(2, `正在写笔记，已写 ${chars} 字`);
      } else if (event === "status") {
        setStage(2, data.message || "正在写笔记");
      } else if (event === "error") {
        throw new Error(data.message || "整理失败");
      } else if (event === "done") {
        donePayload = data;
      }
    });
  } finally {
    busy = false;
    abortGenerate = null;
    stopProgress();
  }
  if (!donePayload?.report) throw new Error("笔记没有写完。");
  const report = donePayload.report;
  report.truncated = Boolean(donePayload.truncated);
  report.notice = [donePayload.notice, material.notice].filter(Boolean).join(" ");
  report.model = settings.model;
  const item = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    mode,
    title: report.title,
    report,
    material: storeMaterial(material),
  };
  current = item;
  remember(item);
  location.hash = `#/h/${item.id}`;
}

async function onGenerate() {
  if (busy) return;
  if (!ensureModel()) return;
  const mode = selectedMode();
  const tab = document.querySelector(".tabs button[aria-selected='true']")?.dataset.tab || "text";
  const controller = new AbortController();
  abortGenerate = () => controller.abort();
  busy = true;
  setError("");
  startProgress();
  try {
    const material = tab === "video" ? await resolveVideo(controller.signal) : materialFromDraft();
    busy = false;
    abortGenerate = null;
    stopProgress();
    await runGenerate(material, mode);
  } catch (error) {
    busy = false;
    abortGenerate = null;
    stopProgress();
    if (error.name === "AbortError") setError("已停下来。");
    else setError(error.message || "整理失败");
  }
}

function renderBlocks(blocks) {
  return (blocks || []).map((block) => {
    if (block.type === "compare") {
      const columns = block.columns || [];
      return `<div class="compare ${columns.length > 2 ? "cols-3" : ""}">
        ${block.caption ? `<p class="caption">${escapeHtml(block.caption)}</p>` : ""}
        ${columns.map((column) => `<div>
          ${column.label ? `<span class="col-label">${escapeHtml(column.label)}</span>` : ""}
          ${column.title ? `<h3>${escapeHtml(column.title)}</h3>` : ""}
          <p>${escapeHtml(column.text)}</p>
        </div>`).join("")}
      </div>`;
    }
    if (block.type === "callout") {
      return `<aside class="callout"><strong>${escapeHtml(block.title)}</strong><p>${escapeHtml(block.text)}</p></aside>`;
    }
    if (block.type === "quote") return `<blockquote class="quote">${escapeHtml(block.text)}</blockquote>`;
    if (block.type === "steps") {
      return `<ol class="steps">${block.items.map((item, index) => `<li>
        <span class="step-no">${index + 1}</span>
        <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p></div>
      </li>`).join("")}</ol>`;
    }
    return "";
  }).join("");
}

function renderReport(item) {
  const report = item.report;
  const url = safeUrl(item.material?.url);
  const sections = report.sections || [];
  return `
    ${report.sample ? `<p class="banner">这是一份示例，用来看笔记长什么样。</p>` : ""}
    ${report.notice ? `<p class="banner">${escapeHtml(report.notice)}</p>` : ""}
    <p class="badge">${escapeHtml(MODES[report.mode] || "课堂笔记")}</p>
    <h1>${escapeHtml(report.title)}</h1>
    ${report.summary ? `<p class="summary">${escapeHtml(report.summary)}</p>` : ""}
    <p class="source">${escapeHtml(report.sourceLine || "")}${url ? ` · <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">打开视频</a>` : ""}</p>
    ${sections.map((section, index) => `<section class="section">
      <h2><span class="num">${String(index + 1).padStart(2, "0")}</span><span>${escapeHtml(section.heading)}</span></h2>
      ${(section.paragraphs || []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}
      ${renderBlocks(section.blocks)}
    </section>`).join("")}
    ${report.takeaways?.length ? `<section class="tail"><h2>带走这几句</h2><ul class="remember">${report.takeaways.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></section>` : ""}
    ${report.pitfalls?.length ? `<section class="tail"><h2>容易混</h2><ul class="pitfall">${report.pitfalls.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></section>` : ""}
    ${report.quiz?.length ? `<section class="tail quiz"><h2>课后自测</h2>${report.quiz.map((item, index) => `<details>
      <summary>${index + 1}. ${escapeHtml(item.question)}</summary>
      <p>${escapeHtml(item.answer || "笔记里没有写出答案。")}</p>
    </details>`).join("")}</section>` : ""}
    <section class="ask">
      <h2>问课代表</h2>
      <div class="chips">
        <button type="button" data-ask="这节课最该记住的是哪一句？">最该记住的一句</button>
        <button type="button" data-ask="用一个例子再讲一遍。">用例子再讲一遍</button>
        <button type="button" data-ask="我最容易混的是哪里？">哪里容易混</button>
      </div>
      <form id="ask-form" class="ask-row">
        <input id="ask-input" type="text" placeholder="对着这节课发问" maxlength="500" />
        <button class="primary" type="submit">提问</button>
      </form>
      <div id="ask-answer"></div>
    </section>
    ${item.material?.transcript ? `<div class="rewrite"><span>换一种整理</span>
      <button type="button" data-rewrite="notes">课堂笔记</button>
      <button type="button" data-rewrite="brief">精简速览</button>
      <button type="button" data-rewrite="review">考前复习</button>
    </div>` : ""}
    <details class="fineprint">
      <summary>来源与整理说明</summary>
      <p>${report.sample ? "示例笔记是写好放在页面里的，没有调用模型。" : `笔记由你配置的模型「${escapeHtml(report.model || settings.model || "未命名")}」根据文字稿整理。`}</p>
      ${report.truncated ? "<p>文字稿较长，中间有一段没有送进模型。</p>" : ""}
      <p>模型名称、接口和笔记保存在这台电脑上。整理结果请再对着原课核对。</p>
    </details>
  `;
}

function showHome() {
  current = null;
  home.hidden = false;
  reportView.hidden = true;
}

function paintReport() {
  home.hidden = true;
  reportView.hidden = false;
  reportRoot.innerHTML = renderReport(current);
  window.scrollTo(0, 0);
}

function route() {
  const hash = location.hash || "#/";
  const sampleId = /^#\/s\/([\w-]+)$/.exec(hash)?.[1];
  if (sampleId) {
    const sample = SAMPLES.find((item) => item.id === sampleId);
    if (!sample) return showHome();
    current = {
      id: sample.id,
      sample: true,
      mode: sample.report.mode,
      report: structuredClone(sample.report),
      material: sample.material,
    };
    paintReport();
    return;
  }
  const historyId = /^#\/h\/([\w-]+)$/.exec(hash)?.[1];
  if (historyId) {
    const item = historyItems.find((entry) => entry.id === historyId);
    if (!item) return showHome();
    current = item;
    paintReport();
    return;
  }
  showHome();
}

function reportToMarkdown(report) {
  const lines = [`# ${report.title}`, ""];
  if (report.summary) lines.push(report.summary, "");
  if (report.sourceLine) lines.push(report.sourceLine, "");
  (report.sections || []).forEach((section, index) => {
    lines.push(`## ${String(index + 1).padStart(2, "0")} ${section.heading}`, "");
    for (const paragraph of section.paragraphs || []) lines.push(paragraph, "");
    for (const block of section.blocks || []) {
      if (block.type === "compare") {
        if (block.caption) lines.push(`**${block.caption}**`, "");
        for (const column of block.columns) {
          lines.push(`- ${column.label ? `${column.label} · ` : ""}${column.title}：${column.text}`);
        }
        lines.push("");
      } else if (block.type === "callout") {
        lines.push(`> **${block.title}** ${block.text}`, "");
      } else if (block.type === "quote") {
        lines.push(`> ${block.text}`, "");
      } else if (block.type === "steps") {
        block.items.forEach((item, index) => lines.push(`${index + 1}. **${item.title}** ${item.text}`));
        lines.push("");
      }
    }
  });
  if (report.takeaways?.length) {
    lines.push("## 带走这几句", "", ...report.takeaways.map((line) => `- ${line}`), "");
  }
  if (report.pitfalls?.length) {
    lines.push("## 容易混", "", ...report.pitfalls.map((line) => `- ${line}`), "");
  }
  if (report.quiz?.length) {
    lines.push("## 课后自测", "");
    report.quiz.forEach((item, index) => lines.push(`${index + 1}. ${item.question}`, "", `答案：${item.answer}`, ""));
  }
  return `${lines.join("\n").trim()}\n`;
}

async function copyMarkdown() {
  if (!current) return;
  const markdown = reportToMarkdown(current.report);
  try {
    await navigator.clipboard.writeText(markdown);
    toast("已复制 Markdown");
  } catch {
    toast("复制失败，可以改用下载");
  }
}

function downloadMarkdown() {
  if (!current) return;
  const markdown = reportToMarkdown(current.report);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${current.report.title || "课堂笔记"}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function submitAsk(question) {
  if (asking || !current) return;
  const text = (question || $("#ask-input")?.value || "").trim();
  if (!text) return;
  if (!ensureModel()) return;
  asking = true;
  const box = $("#ask-answer");
  box.innerHTML = `<div class="answer"><span>课代表</span><p>正在翻笔记…</p></div>`;
  try {
    const data = await apiJson("/api/ask", {
      question: text,
      report: current.report,
      transcript: current.material?.transcript || "",
      llm: settings,
    });
    box.innerHTML = `<div class="answer"><span>课代表</span><p>${escapeHtml(data.answer)}</p></div>`;
  } catch (error) {
    box.innerHTML = `<div class="answer"><span>课代表</span><p>${escapeHtml(error.message || "没有问出来")}</p></div>`;
  } finally {
    asking = false;
  }
}

document.body.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "settings") openSettings();
  if (action === "history") openHistory();
  if (action === "close") event.target.closest("dialog")?.close();

  const destination = event.target.closest("[data-go]")?.dataset.go;
  if (destination) {
    $("#history").close();
    location.hash = destination;
  }

  const tab = event.target.closest("[data-tab]")?.dataset.tab;
  if (tab) setTab(tab);

  const removeId = event.target.closest("[data-delete]")?.dataset.delete;
  if (removeId) {
    historyItems = historyItems.filter((item) => item.id !== removeId);
    persistHistory();
    paintHistory();
    if (current?.id === removeId) location.hash = "#/";
  }

  const ask = event.target.closest("[data-ask]")?.dataset.ask;
  if (ask) {
    const input = $("#ask-input");
    if (input) input.value = ask;
    submitAsk(ask);
  }

  const rewrite = event.target.closest("[data-rewrite]")?.dataset.rewrite;
  if (rewrite && current?.material?.transcript && !busy) {
    const material = current.material;
    location.hash = "#/";
    runGenerate(material, rewrite).catch((error) => {
      if (error.name !== "AbortError") setError(error.message || "整理失败");
    });
  }
});

$("#generate").addEventListener("click", onGenerate);
$("#cancel").addEventListener("click", () => abortGenerate?.());
$("#copy-md").addEventListener("click", copyMarkdown);
$("#download-md").addEventListener("click", downloadMarkdown);
$("#clear-history").addEventListener("click", () => {
  if (!historyItems.length) return;
  if (!confirm("清空这台电脑上的笔记？其他浏览器里也会一起清空。")) return;
  historyItems = [];
  persistHistory().catch(() => toast("笔记没有从电脑存档里清掉"));
  paintHistory();
  if (location.hash.startsWith("#/h/")) location.hash = "#/";
});
$("#history-search").addEventListener("input", paintHistory);
$("#test-model").addEventListener("click", async () => {
  const button = $("#test-model");
  const hint = $("#settings-hint");
  settings = readSettingsForm();
  paintSetup();
  button.disabled = true;
  button.textContent = "正在测试…";
  hint.textContent = "";
  try {
    await persistSettings();
    const data = await apiJson("/api/test", { llm: settings });
    hint.textContent = `通了。模型回复：${data.reply}`;
  } catch (error) {
    hint.textContent = error.message || "没有连上";
  } finally {
    button.disabled = false;
    button.textContent = "测试连接";
  }
});
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  settings = readSettingsForm();
  paintSetup();
  try {
    await persistSettings();
    $("#settings-hint").textContent = "已保存在这台电脑上，换浏览器也能用。";
    $("#settings").close();
    toast("模型已保存");
  } catch (error) {
    $("#settings-hint").textContent = error.message || "没有写进电脑存档";
  }
});
$("#temperature").addEventListener("input", () => {
  $("#temperature-out").textContent = Number($("#temperature").value).toFixed(1);
});
transcript.addEventListener("input", () => {
  countTranscript();
  sessionStorage.setItem(DRAFT_KEY, transcript.value);
});
$("#file-input").addEventListener("change", (event) => readFile(event.target.files?.[0]));
const dropzone = $("#dropzone");
["dragenter", "dragover"].forEach((name) => {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.add("over");
  });
});
["dragleave", "drop"].forEach((name) => {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.remove("over");
  });
});
dropzone.addEventListener("drop", (event) => readFile(event.dataTransfer?.files?.[0]));

window.addEventListener("hashchange", route);

const draft = sessionStorage.getItem(DRAFT_KEY);
if (draft) {
  transcript.value = draft;
  countTranscript();
}

function applySettings(saved) {
  settings = {
    baseUrl: saved?.baseUrl || "",
    apiKey: saved?.apiKey || "",
    model: saved?.model || "",
    temperature: Number.isFinite(saved?.temperature) ? saved.temperature : 0.4,
    sendTemperature: saved?.sendTemperature !== false,
  };
}

async function boot() {
  const localSettings = loadSettings();
  const localHistory = loadHistory();
  try {
    const response = await fetch("/api/library");
    if (!response.ok) throw new Error("存档没有读到");
    const remote = await response.json();
    if (remote.initialized) {
      applySettings(remote.settings);
      historyItems = Array.isArray(remote.history) ? remote.history : [];
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      localStorage.setItem(HISTORY_KEY, JSON.stringify(historyItems));
    } else if (localSettings.baseUrl || localSettings.model || localSettings.apiKey || localHistory.length) {
      applySettings(localSettings);
      historyItems = localHistory;
      await persistSettings();
      await persistHistory();
    }
  } catch {
    applySettings(localSettings);
    historyItems = localHistory;
  }
  paintSetup();
  route();
}

boot();
