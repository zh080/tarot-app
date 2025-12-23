/**
 * Stable Tarot Backend (Express)
 * - GET  /api/shuffle  -> { shuffleId, pool: [8 unique ids] }
 * - POST /api/reading  -> { cards: [{name,en,img,voice,desc}], closing }
 *
 * Notes:
 * - tarotDeck.json 可以包含 name/en/img/desc/text/keywords 任意字段
 * - 后端会“动态生成 voice”，不再依赖 tarotDeck.json 里的 voice（因为你说太重复）
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname))); // 直接把项目根目录作为静态资源目录

// -------------------------
// Load & normalize deck
// -------------------------
const DECK_PATH = path.join(__dirname, "tarotDeck.json");

function safeReadJson(filepath) {
  try {
    if (!fs.existsSync(filepath)) {
      return { ok: false, error: `找不到文件：${filepath}` };
    }
    const raw = fs.readFileSync(filepath, "utf-8").trim();
    if (!raw) {
      return { ok: false, error: "tarotDeck.json 是空文件（你之前遇到的就是这个）。" };
    }
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      return { ok: false, error: "tarotDeck.json 顶层必须是数组 []。" };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `解析 tarotDeck.json 失败：${e.message}` };
  }
}

function normalizeImg(img) {
  const fallback = "RWS_Tarot_00_Fool.jpg";
  if (!img || typeof img !== "string") return fallback;
  // 兼容你以前那种 "9/90/RWS_Tarot_00_Fool.jpg" 的写法：取最后的文件名
  if (img.includes("/")) {
    const last = img.split("/").pop();
    return last || fallback;
  }
  return img;
}

function toStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function normalizeCard(card, idx) {
  const name = toStr(card.name || card.cn || card.title || `Card ${idx}`);
  const en = toStr(card.en || card.enName || card.english || "");
  const desc = toStr(card.desc || card.description || "");
  const text = toStr(card.text || card.meaning || card.voice || "");
  const keywords = Array.isArray(card.keywords) ? card.keywords.map(toStr) : [];

  // img: 允许 card.img / card.image / card.pic
  const img = normalizeImg(card.img || card.image || card.pic || "");

  return {
    id: idx,
    name,
    en,
    img,
    desc,
    text,
    keywords,
  };
}

let deck = [];
const deckLoad = safeReadJson(DECK_PATH);

if (!deckLoad.ok) {
  console.error("❌ 加载 tarotDeck.json 失败：", deckLoad.error);
  console.error("➡️ 后端仍会启动，但只能用 1 张示例牌（建议修复 tarotDeck.json）。");

  deck = [
    normalizeCard(
      {
        name: "愚人",
        en: "The Fool",
        img: "RWS_Tarot_00_Fool.jpg",
        desc: "画面上的人<span class='highlight'>走向悬崖</span>，代表你愿意开始；小狗像是提醒：别忽略直觉与边界。",
        text: "你正站在一个新起点。",
        keywords: ["开始", "冒险", "直觉", "勇气"],
      },
      0
    ),
  ];
} else {
  deck = deckLoad.data.map(normalizeCard);
  if (deck.length !== 78) {
    console.warn(`⚠️ 提醒：你的 tarotDeck.json 目前是 ${deck.length} 张（标准是 78 张）。不影响运行，但建议补全。`);
  }
  console.log(`✅ 已加载 tarotDeck.json：${deck.length} 张牌`);
}

// -------------------------
// Shuffle sessions (in-memory)
// -------------------------
/**
 * sessions: shuffleId -> { pool:number[], createdAt:number }
 * 注意：这是内存存储，服务器重启会清空（对你本地开发完全够用）
 */
const sessions = new Map();

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function sampleUniqueIndices(max, count) {
  const n = Math.min(count, max);
  const set = new Set();
  while (set.size < n) {
    set.add(Math.floor(Math.random() * max));
  }
  return Array.from(set);
}

// 定期清理过期 session（防止内存增长）
setInterval(() => {
  const now = Date.now();
  const TTL = 1000 * 60 * 30; // 30分钟
  for (const [k, v] of sessions.entries()) {
    if (now - v.createdAt > TTL) sessions.delete(k);
  }
}, 1000 * 60 * 5);

// -------------------------
// "Tarot therapist" voice generator
// -------------------------
function detectTopic(question) {
  const q = question || "";
  const love = /爱|恋|他|她|感情|关系|暧昧|复合|分手|婚|伴侣/;
  const work = /工作|老板|同事|职业|跳槽|转行|事业|offer|面试|裁员/;
  const money = /钱|财|收入|投资|债|花销|存款|副业/;
  const study = /学习|考试|考研|论文|读书|课程|学校/;
  const self = /焦虑|内耗|自卑|情绪|抑郁|压力|失眠|恐惧|拖延|迷茫/;

  if (love.test(q)) return "关系";
  if (work.test(q)) return "事业";
  if (money.test(q)) return "金钱";
  if (study.test(q)) return "成长";
  if (self.test(q)) return "情绪";
  return "方向";
}

function cardTone(name, en) {
  const key = `${name} ${en}`.toLowerCase();
  const hard = [
    "death","tower","devil","3 of swords","ten of swords","five of cups","moon","7 of swords",
    "宝剑三","宝剑十","圣杯五","月亮","恶魔","塔","死神"
  ];
  const bright = [
    "sun","star","world","ten of cups","ace of cups","temperance","justice",
    "太阳","星星","世界","圣杯十","圣杯一","节制","正义"
  ];
  if (hard.some(k => key.includes(k))) return "challenge";
  if (bright.some(k => key.includes(k))) return "support";
  return "neutral";
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shortenQuestion(q) {
  const s = (q || "").trim();
  if (s.length <= 16) return s;
  return s.slice(0, 16) + "…";
}

// 生成更不重复：开场/映射/行动建议/收束（随机组合）
function generateVoice({ card, question }) {
  const topic = detectTopic(question);
  const tone = cardTone(card.name, card.en);
  const qShort = shortenQuestion(question);

  const openers = [
    "亲爱的，我看到你在这个问题上其实很认真。",
    "我能感受到你对这件事的在意，也能理解你的摇摆。",
    "听到你问“{Q}”，我先想邀请你把注意力放回自己。",
    "关于“{Q}”，我更想把它当作你内心的一次自我对话。",
    "亲爱的，你不是没答案，你只是还在练习相信自己。",
  ];

  const frames = {
    support: [
      "这张牌更像一盏灯：它在提醒你，你已经具备推进的条件。",
      "它的能量偏向支持：当你愿意迈一步，现实会给你回声。",
      "我看到一种“被托住”的感觉——不是运气，而是你准备好了。",
    ],
    neutral: [
      "这张牌像一面镜子：它让你看见当下的结构与选择。",
      "它不急着给结论，而是在帮你把问题拆成可行动的部分。",
      "它提醒你：先看清楚自己站在哪里，再决定往哪走。",
    ],
    challenge: [
      "这张牌不温柔，但它很诚实：它在指向你需要面对的那一块。",
      "它像一次提醒：如果继续用旧方式，你会更累；需要换一种应对。",
      "我看到这里有情绪/模式在拉扯你——先照顾好自己，再处理事情。",
    ],
  };

  const topicHints = {
    关系: [
      "在关系里，先问自己：我是在渴望连接，还是在害怕失去？",
      "把边界说清楚，会比反复猜测更能保护你。",
      "你可以把“期待”换成“请求”，沟通会轻很多。",
    ],
    事业: [
      "在事业上，先把目标缩小到“下一步可执行动作”。",
      "你不需要一次做对全部选择，只需要先做对下一件事。",
      "把精力从“别人怎么看”收回到“我想成为什么样的人”。",
    ],
    金钱: [
      "金钱议题背后常常是安全感：先稳住，再谈扩张。",
      "做预算不是限制，而是给自己可控感。",
      "把冲动消费/焦虑投资换成更小、更稳定的行动。",
    ],
    成长: [
      "学习/成长其实是建立节奏：今天做一点，长期就会很强。",
      "你不缺能力，缺的是一个能持续的计划。",
      "把目标拆到“可完成”，自信就会慢慢回到你身上。",
    ],
    情绪: [
      "先不急着解决问题，先安顿情绪：呼吸、睡眠、饮食是底盘。",
      "给自己一个允许：允许难过、允许不确定。",
      "把“我必须立刻想明白”换成“我可以一步步看清”。",
    ],
    方向: [
      "方向不是想出来的，是走出来的：先迈一小步再校准。",
      "你可以把选择当成实验：先验证，再决定。",
      "把注意力放在你能控制的部分，焦虑会下降很多。",
    ],
  };

  const actions = {
    support: [
      "今天就做一件小事：把你最想推进的那一步写下来，然后立刻开始 10 分钟。",
      "你可以允许自己更大胆一点：先行动，再优化，不必等完美。",
      "请把你的“想法”落到日程里——安排一个具体时间点去做。",
    ],
    neutral: [
      "建议你列出 2 个选项的“代价/收益”，然后选择更符合你价值观的那一个。",
      "先把信息补齐：你缺的不是勇气，而是一个更清晰的事实列表。",
      "给自己 48 小时：观察、记录、再决定，别在情绪峰值里拍板。",
    ],
    challenge: [
      "现在最重要的是止损：先停下让你持续消耗的那件事，给自己一点空间。",
      "建议你先做情绪清理：写下你最怕发生的 3 件事，然后逐一评估它们的真实概率。",
      "别硬撑。先找一个支持：朋友/咨询/教练，让你不必一个人扛。",
    ],
  };

  const closers = [
    "你不用一次变得很强，你只要对自己更诚实一点点就够了。",
    "你值得一个更轻松、更清醒的选择。",
    "把决定权收回来：你的人生，不需要向任何人证明。",
    "你会走过去的，而且会更明白自己要什么。",
  ];

  const opener = pick(openers).replace("{Q}", qShort);
  const frame = pick(frames[tone]);
  const hint = pick(topicHints[topic] || topicHints["方向"]);
  const act = pick(actions[tone]);
  const closer = pick(closers);

  // 加一点点牌面个性（来自 name/keywords）
  const kw = (card.keywords && card.keywords.length) ? pick(card.keywords) : "";
  const cardFlavor = kw ? `我还注意到一个关键词：${kw}。` : "";

  // 最终合成：尽量口语咨询风、且不迷信
  return `${opener} ${frame} 这意味着你当下更需要在「${topic}」上做更清晰的选择。${cardFlavor} ${hint} ${act} ${closer}`;
}

// 结语：原创“显化/当下/选择”的风格拼装，降低重复
function generateClosing() {
  const a = [
    "这是你的世界，",
    "亲爱的，",
    "此刻就是入口，",
    "你正在写下一条新的时间线，",
  ];
  const b = [
    "一切可能性都存在于当下。",
    "现实会跟随你持续的注意力移动。",
    "选择不是证明对错，而是决定你要体验什么。",
    "当你把心安住，路就会自己出现。",
  ];
  const c = [
    "把注意力放回你想成为的那个人。",
    "先选一个方向，然后让行动去确认它。",
    "别再等待“完全确定”，先迈出那一步。",
    "温柔但坚定地做决定。",
  ];
  const d = [
    "你会被你真正的选择托住。",
    "你并不缺力量，你只是在练习使用它。",
    "勇敢不是不怕，而是仍然愿意前进。",
    "现在就好——从这一刻开始。",
  ];

  return pick(a) + pick(b) + " " + pick(c) + " " + pick(d);
}

// -------------------------
// Routes
// -------------------------
app.get("/", (req, res) => {
  // 方便你直接访问根路径
  res.redirect("/tarot-pro.html");
});

app.get("/api/shuffle", (req, res) => {
  if (!deck || deck.length < 1) {
    return res.status(500).json({ error: "牌库为空：请检查 tarotDeck.json" });
  }
  const shuffleId = uuid();
  const pool = sampleUniqueIndices(deck.length, 8);
  sessions.set(shuffleId, { pool, createdAt: Date.now() });

  res.json({ shuffleId, pool });
});

app.post("/api/reading", (req, res) => {
  const { shuffleId, question, picks } = req.body || {};

  if (!shuffleId || typeof shuffleId !== "string") {
    return res.status(400).json({ error: "缺少 shuffleId" });
  }
  const sess = sessions.get(shuffleId);
  if (!sess) {
    return res.status(400).json({ error: "shuffleId 无效或已过期，请重新洗牌。" });
  }

  const q = (question || "").trim();
  if (!q) {
    return res.status(400).json({ error: "缺少 question（你的问题）" });
  }

  if (!Array.isArray(picks)) {
    return res.status(400).json({ error: "picks 必须是数组" });
  }
  if (picks.length !== 7) {
    return res.status(400).json({ error: "你需要选择 7 张牌（picks 长度必须为 7）" });
  }

  // picks 必须是 pool 的子集且不重复
  const pickSet = new Set();
  for (const v of picks) {
    const id = Number(v);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "picks 中包含非整数 id" });
    if (!sess.pool.includes(id)) return res.status(400).json({ error: "picks 中包含不在本次牌池的 id（请不要作弊/误传）" });
    if (pickSet.has(id)) return res.status(400).json({ error: "picks 里有重复 id（同一张牌不能选两次）" });
    pickSet.add(id);
  }

  const cards = picks.map((id) => {
    const base = deck[id] || {};
    const voice = generateVoice({ card: base, question: q });

    // desc：优先用 tarotDeck.json 的 desc，否则用 text 简化成教学说明
    const desc = base.desc
      ? base.desc
      : (base.text ? `这张牌的画面主题可以理解为：${base.text}` : "（暂无画面解码）");

    return {
      name: base.name || "",
      en: base.en || "",
      img: normalizeImg(base.img),
      voice,
      desc,
    };
  });

  res.json({
    cards,
    closing: generateClosing(),
  });
});

// -------------------------
// Start
// -------------------------
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`➡️ 打开： http://localhost:${PORT}/tarot-pro.html`);
  console.log(`➡️ API:  GET  /api/shuffle`);
  console.log(`➡️ API:  POST /api/reading`);
});
