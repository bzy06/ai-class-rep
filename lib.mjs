import { createHash } from "node:crypto";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WBI_MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

export function chatCompletionsUrl(base) {
  const raw = String(base || "").trim();
  if (!raw) throw new Error("先填写模型接口地址");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("接口地址格式不对");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("接口地址只支持 http 或 https");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/chat/completions")) {
    path = path === "" ? "/v1/chat/completions" : `${path}/chat/completions`;
  }
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function extractVideoRef(input) {
  const text = String(input || "");
  const bv = text.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return { bvid: bv[0] };
  const av = text.match(/(?:video\/av|av)(\d{3,})/i);
  if (av) return { aid: av[1] };
  return null;
}

export function pageNumber(input) {
  const matched = String(input || "").match(/(?:[?&]p=|\/p)(\d+)/i);
  const n = matched ? Number(matched[1]) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function clipTranscript(text, limit = 28000) {
  const raw = String(text || "").replace(/\u0000/g, "").trim();
  if (raw.length <= limit) return { text: raw, truncated: false };
  const head = Math.floor(limit * 0.82);
  const marker = "\n……中间省略……\n";
  const tail = Math.max(0, limit - head - marker.length);
  return {
    text: `${raw.slice(0, head)}${marker}${raw.slice(-tail)}`,
    truncated: true,
  };
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remain = seconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分 ${String(remain).padStart(2, "0")} 秒`;
}

function text(value, limit = 4000) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const clean = String(value).replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}…`;
}

function textList(value, limit = 8) {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\n+/)
      : [];
  return list
    .map((item) => {
      if (typeof item === "string" || typeof item === "number") return text(item, 500);
      if (item && typeof item === "object") return text(item.text || item.title || item.content, 500);
      return "";
    })
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeBlock(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "compare") {
    const source = Array.isArray(block.columns)
      ? block.columns
      : [block.left, block.right].filter(Boolean);
    const columns = source
      .slice(0, 3)
      .map((column) => ({
        label: text(column?.label, 24),
        title: text(column?.title, 80),
        text: text(column?.text, 400),
      }))
      .filter((column) => column.title || column.text);
    if (!columns.length) return null;
    return { type: "compare", caption: text(block.caption, 80), columns };
  }
  if (block.type === "callout") {
    const body = text(block.text, 500);
    if (!body) return null;
    return { type: "callout", title: text(block.title, 40) || "老师强调的", text: body };
  }
  if (block.type === "steps") {
    const items = (Array.isArray(block.items) ? block.items : block.steps || [])
      .slice(0, 8)
      .map((item) => ({
        title: text(item?.title, 80),
        text: text(item?.text, 400),
      }))
      .filter((item) => item.title || item.text);
    if (!items.length) return null;
    return { type: "steps", items };
  }
  if (block.type === "quote") {
    const body = text(block.text, 400);
    if (!body) return null;
    return { type: "quote", text: body };
  }
  return null;
}

function normalizeSection(section) {
  if (!section || typeof section !== "object") return null;
  const paragraphs = textList(section.paragraphs || section.body, 8).map((item) => text(item, 1200));
  const blocks = (Array.isArray(section.blocks) ? section.blocks : [])
    .map(normalizeBlock)
    .filter(Boolean)
    .slice(0, 6);
  const heading = text(section.heading || section.title, 80);
  if (!heading && !paragraphs.length && !blocks.length) return null;
  return { heading: heading || "这一段", paragraphs, blocks };
}

export function sourceLine(material = {}) {
  const bits = [];
  if (material.author) bits.push(material.author);
  if (material.title) bits.push(`《${material.title}》`);
  if (material.durationText) bits.push(material.durationText);
  if (material.url) bits.push(material.url);
  return bits.join("；") || "课堂文字稿";
}

export function normalizeReport(input, facts = {}) {
  const source = input && typeof input === "object" ? input : {};
  const sections = (Array.isArray(source.sections) ? source.sections : [])
    .slice(0, 12)
    .map(normalizeSection)
    .filter(Boolean);
  const quiz = (Array.isArray(source.quiz) ? source.quiz : [])
    .slice(0, 8)
    .map((item) => ({
      question: text(item?.question || item?.q || item?.prompt, 300),
      answer: text(item?.answer || item?.a, 500),
    }))
    .filter((item) => item.question);
  return {
    title: text(source.title, 80) || facts.title || "课堂笔记",
    summary: text(source.summary, 600),
    sourceLine: sourceLine(facts.material || {}) || text(source.sourceLine, 400),
    mode: facts.mode || "notes",
    sections,
    takeaways: textList(source.takeaways, 6),
    pitfalls: textList(source.pitfalls, 6),
    quiz,
  };
}

export function parseModelJson(rawText) {
  let raw = String(rawText || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("模型没有返回笔记结构");
  }
  raw = raw.slice(start, end + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1"));
  }
}

export function reportIsUseful(report) {
  return Boolean(
    report.sections.length || report.takeaways.length || report.quiz.length || report.summary,
  );
}

export function fallbackReport(rawText, facts = {}) {
  const raw = String(rawText || "").trim();
  const parts = raw.split(/\n(?=#{1,3} )/);
  if (parts.length > 1) {
    const sections = parts
      .map((part) => {
        const lines = part.trim().split("\n");
        const heading = lines[0].replace(/^#{1,3}\s*/, "");
        const paragraphs = lines.slice(1).join("\n").split(/\n{2,}/);
        return { heading, paragraphs, blocks: [] };
      })
      .filter((section) => section.heading);
    return normalizeReport(
      {
        title: facts.title || sections[0]?.heading || "课堂笔记",
        summary: "模型这次没有按笔记结构返回，下面按它写出的小标题收好了。",
        sections,
      },
      facts,
    );
  }
  return normalizeReport(
    {
      title: facts.title || "课堂笔记",
      summary: "模型这次没有按笔记结构返回，下面保留原文。",
      sections: [{ heading: "整理原文", paragraphs: raw.split(/\n{2,}/), blocks: [] }],
    },
    facts,
  );
}

const MODE_GUIDE = {
  notes: "写 5 到 7 节。每节用完整的话把推导和例子留下来，不要只列提纲。blocks 里至少放一个 compare、steps 或 callout。",
  brief: "写 3 到 4 节，句子短。用一个 steps 块把这节课的骨架摆出来。takeaways 正好 3 条。quiz 出 2 题。",
  review: "写成考前复习。写 4 到 6 节，每节对准一个考点。pitfalls 至少 3 条。quiz 出 5 题，答案要具体到能对照。",
};

export function buildMessages(material, mode) {
  const clipped = clipTranscript(material.transcript);
  const system = [
    "你是课代表，负责把一节课的文字稿收成同学能复习的笔记。",
    "只根据文字稿里出现过的内容来写。文字稿没讲的不要补，不要编造老师的原话。",
    "视频简介只是背景，和文字稿冲突时以文字稿为准。",
    "用中文。文风像把课收成文章：句子具体，有例子，少用“首先、其次、总之”。",
    "不要自称课代表，不要写开场白。",
    MODE_GUIDE[mode] || MODE_GUIDE.notes,
    "只输出一个 JSON 对象，不要 Markdown 围栏，不要解释。字符串里的引号要转义。",
    "JSON 形状如下：",
    JSON.stringify({
      title: "笔记标题，清楚即可，不用视频的夸张标题",
      summary: "一段话，说明这节课在讲什么",
      sections: [
        {
          heading: "小节标题",
          paragraphs: ["完整的一段话"],
          blocks: [
            {
              type: "compare",
              caption: "可省略",
              columns: [{ label: "短标签", title: "对比点", text: "说明" }],
            },
            { type: "callout", title: "老师强调的", text: "一句具体的话" },
            { type: "steps", items: [{ title: "步骤名", text: "这一步做什么" }] },
            { type: "quote", text: "文字稿里确实值得记下的意思，不要编引语" },
          ],
        },
      ],
      takeaways: ["离开教室还该记得的短句"],
      pitfalls: ["容易混的一点，写清错在哪、应该怎么想"],
      quiz: [{ question: "问法像作业，不要含糊", answer: "答案写完整" }],
    }),
  ].join("\n");

  const lines = [
    `整理方式：${mode === "brief" ? "精简速览" : mode === "review" ? "考前复习" : "课堂笔记"}`,
    material.title ? `课程或视频：${material.title}` : "",
    material.author ? `作者：${material.author}` : "",
    material.durationText ? `时长：${material.durationText}` : "",
    material.url ? `链接：${material.url}` : "",
    material.intro ? `简介（只作背景）：\n${String(material.intro).slice(0, 1200)}` : "",
    clipped.truncated ? "文字稿较长，中间已省略一段。" : "",
    "文字稿：",
    clipped.text,
  ].filter(Boolean);

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: lines.join("\n\n") },
    ],
    truncated: clipped.truncated,
  };
}

export function reportToPlain(report) {
  const lines = [report.title, report.summary];
  for (const section of report.sections || []) {
    lines.push(section.heading, ...(section.paragraphs || []));
    for (const block of section.blocks || []) {
      if (block.type === "compare") {
        lines.push(block.caption || "");
        for (const column of block.columns) lines.push(`${column.title} ${column.text}`);
      } else if (block.type === "callout" || block.type === "quote") {
        lines.push(block.title || "", block.text || "");
      } else if (block.type === "steps") {
        for (const item of block.items) lines.push(`${item.title} ${item.text}`);
      }
    }
  }
  lines.push(...(report.takeaways || []), ...(report.pitfalls || []));
  for (const item of report.quiz || []) lines.push(item.question, item.answer);
  return lines.filter(Boolean).join("\n");
}

function cuesToText(body) {
  if (!Array.isArray(body)) return "";
  return body
    .map((cue) => {
      const content = String(cue?.content || "").replace(/\s+/g, " ").trim();
      if (!content) return "";
      const total = Math.max(0, Math.floor(Number(cue.from) || 0));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      const stamp = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      return `[${stamp}] ${content}`;
    })
    .filter(Boolean)
    .join("\n");
}

function pickSubtitle(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const rank = (item) => {
    const lang = `${item?.lan || ""} ${item?.lan_doc || ""}`;
    if (/zh-CN|中文（中国）|简体/.test(lang)) return 0;
    if (/zh|中文/.test(lang)) return 1;
    return 2;
  };
  return [...list].sort((a, b) => rank(a) - rank(b))[0];
}

function readSetCookies(response) {
  const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  return raw.map((item) => String(item).split(";")[0]).filter((item) => item.includes("="));
}

function mixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  return WBI_MIXIN.map((index) => raw[index] || "").join("").slice(0, 32);
}

function wbiQuery(params, mixin) {
  const filtered = {};
  for (const [key, value] of Object.entries({ ...params, wts: Math.floor(Date.now() / 1000) })) {
    filtered[key] = String(value).replace(/[!'()*]/g, "");
  }
  const sorted = Object.keys(filtered)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(filtered[key])}`)
    .join("&");
  const rid = createHash("md5").update(sorted + mixin).digest("hex");
  return `${sorted}&w_rid=${rid}`;
}

async function fetchRetry(url, options) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
    }
  }
  const wrapped = new Error("连不上 B 站。可以改用字幕文件或文字稿。");
  wrapped.status = 502;
  wrapped.cause = lastError;
  throw wrapped;
}

async function openBilibili() {
  const home = await fetchRetry("https://www.bilibili.com/", {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  const cookies = readSetCookies(home);
  const headersFor = (bvid) => ({
    "User-Agent": UA,
    Referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : "https://www.bilibili.com/",
    Origin: "https://www.bilibili.com",
    Accept: "application/json, text/plain, */*",
    Cookie: cookies.join("; "),
  });
  const navResponse = await fetchRetry("https://api.bilibili.com/x/web-interface/nav", {
    headers: headersFor(""),
  });
  cookies.push(...readSetCookies(navResponse));
  const nav = await navResponse.json().catch(() => null);
  const imgKey = nav?.data?.wbi_img?.img_url?.split("/").pop()?.split(".")[0] || "";
  const subKey = nav?.data?.wbi_img?.sub_url?.split("/").pop()?.split(".")[0] || "";
  if (!imgKey || !subKey) {
    const error = new Error("连不上 B 站。可以改用字幕文件或文字稿。");
    error.status = 502;
    throw error;
  }
  const mixin = mixinKey(imgKey, subKey);

  async function getJson(pathname, params, { sign = false, bvid = "" } = {}) {
    const query = sign ? wbiQuery(params, mixin) : new URLSearchParams(params).toString();
    const response = await fetchRetry(`https://api.bilibili.com${pathname}?${query}`, {
      headers: headersFor(bvid),
    });
    const raw = await response.text();
    if (!raw.trim().startsWith("{")) {
      const error = new Error("B 站没有返回可用的视频信息。");
      error.status = 502;
      throw error;
    }
    return JSON.parse(raw);
  }

  return { getJson };
}

export async function resolveBilibili(input) {
  let text = String(input || "").trim();
  if (!text) {
    const error = new Error("先粘贴视频链接、分享文案或 BV 号。");
    error.status = 400;
    throw error;
  }
  const short = text.match(/https?:\/\/b23\.tv\/[A-Za-z0-9]+/i);
  if (short && !extractVideoRef(text)) {
    try {
      const response = await fetch(short[0], {
        redirect: "manual",
        headers: { "User-Agent": UA },
      });
      text += `\n${response.headers.get("location") || ""}`;
    } catch {
      /* 短链打不开时，继续用用户原文找 BV 号。 */
    }
  }
  const ref = extractVideoRef(text);
  if (!ref) {
    const error = new Error("没有找到 BV 号或 av 号。可以粘贴链接、分享文案，或改用文字稿。");
    error.status = 400;
    throw error;
  }
  const page = pageNumber(text);
  const bili = await openBilibili();
  const viewParams = ref.bvid ? { bvid: ref.bvid } : { aid: ref.aid };
  const view = await bili.getJson("/x/web-interface/wbi/view", viewParams, {
    sign: true,
    bvid: ref.bvid || "",
  });
  if (view.code !== 0 || !view.data) {
    const error = new Error(view.message || "没有读到这个视频");
    error.status = view.code === -404 ? 404 : 502;
    throw error;
  }
  const data = view.data;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const part = pages[page - 1] || pages[0] || { cid: data.cid, part: data.title, duration: data.duration };
  const bvid = data.bvid || ref.bvid || "";
  let transcript = "";
  let subtitleLang = "";
  let warning = "";
  let basis = "none";
  try {
    const player = await bili.getJson("/x/player/wbi/v2", { bvid, cid: part.cid }, { sign: true, bvid });
    const picked = pickSubtitle(player.data?.subtitle?.subtitles || []);
    if (picked?.subtitle_url) {
      let subtitleUrl = picked.subtitle_url;
      if (subtitleUrl.startsWith("//")) subtitleUrl = `https:${subtitleUrl}`;
      const subtitleResponse = await fetchRetry(subtitleUrl, {
        headers: { "User-Agent": UA, Referer: `https://www.bilibili.com/video/${bvid}/` },
      });
      const subtitle = await subtitleResponse.json();
      transcript = cuesToText(subtitle.body);
      subtitleLang = picked.lan_doc || picked.lan || "";
      if (transcript) basis = "subtitle";
    }
  } catch {
    transcript = "";
  }
  const intro = String(data.desc || "").slice(0, 4000);
  if (!transcript && intro.trim().length >= 40) {
    transcript = `以下不是口播字幕，是这个视频的公开简介。只根据简介里写到的内容整理，简介没写的不要编。\n\n${intro.trim()}`;
    basis = "description";
    warning = "这个视频的口播字幕没有公开。笔记会按标题和简介来写。若要按讲解写，把字幕文件拖进来再整理一次。";
  } else if (!transcript) {
    warning = data.title
      ? `已读到《${data.title}》，但没有公开字幕。把字幕文件拖进来，或把文字稿贴进来。`
      : "这个视频没有公开字幕。把字幕文件拖进来，或把文字稿贴进来。";
  }
  const id = bvid || `av${data.aid}`;
  const title = pages.length > 1 && part.part ? `${data.title} · ${part.part}` : data.title;
  return {
    ok: true,
    title,
    author: data.owner?.name || "",
    url: `https://www.bilibili.com/video/${id}${page > 1 ? `?p=${page}` : ""}`,
    durationText: formatDuration(part.duration || data.duration),
    intro,
    transcript,
    subtitleLang,
    basis,
    warning,
  };
}

function textPiece(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => part?.text || part?.content || "").join("");
  return "";
}

export function contentFromMessage(message) {
  return textPiece(message?.content);
}

export function contentFromDelta(delta) {
  return textPiece(delta?.content);
}

export function reasoningFromMessage(message) {
  return textPiece(message?.reasoning_content || message?.reasoning);
}

export function reasoningFromDelta(delta) {
  return textPiece(delta?.reasoning_content || delta?.reasoning);
}

export function visibleAnswer(content, reasoning) {
  const answer = String(content || "");
  if (answer.trim()) return answer;
  return String(reasoning || "");
}
