/**
 * Hermes Mini — a serverless Persian Telegram assistant on Cloudflare Workers.
 *
 * Single-file worker (course hard constraint): secure webhook, D1 persistence,
 * Workers-AI natural-language understanding and a short conversation memory.
 *
 * Flow:  Telegram → Worker (webhook) → Workers AI (LLM decision) → D1 → Telegram
 */

// ============================================================================
// Configuration constants
// ============================================================================

/** Workers AI model used as the intelligence layer (free-plan allocation, no payment method required). */
const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MAX_BODY_BYTES = 128 * 1024; // webhook payload size limit
const MAX_TASK_TEXT = 200;
const MAX_REPLY_CHARS = 700;
const HISTORY_KEEP = 20; // rows kept per user in conversation_history
const HISTORY_IN_PROMPT = 12; // rows sent to the model as context
const TASKS_IN_PROMPT = 30; // tasks sent to the model as context
const DEDUP_RETENTION_MS = 48 * 60 * 60 * 1000; // processed_updates pruning window
const LLM_TIMEOUT_MS = 25_000;

const ACTIONS = new Set(["add", "done", "undone", "del", "list", "chat"]);

/** Prefix of our deterministic "delete everything?" confirmation reply. */
const DELETE_ALL_MARKER = "⚠️ تأیید حذف همه:";

const MSG = {
  nonText: "فعلاً فقط پیام متنی می‌فهمم 🙏",
  llmFailed: "🤖 الان نمی‌تونم پیامت رو تحلیل کنم. لطفاً یه بار دیگه بفرست.",
  internalError: "⛔ یه خطای داخلی پیش اومد. کمی بعد دوباره تلاش کن.",
  emptyList: "هنوز کاری برای امروز ثبت نکردی ✨",
  listTitle: "📋 کارهای امروز:",
  overdueTitle: "🗂 عقب‌افتاده:",
  alreadyDone: "ℹ️ این وظیفه از قبل انجام شده بود:",
  alreadyPending: "ℹ️ این وظیفه از قبل باز (انجام‌نشده) بود:",
  duplicateTask: "⚠️ این وظیفه قبلاً ثبت شده:",
  whichTask: "چنین وظیفه‌ای توی لیست امروزت نیست. بگو دقیقاً کدوم رو می‌خوای؟",
  deleteAllEmpty: "چیزی برای حذف نیست 🙂",
};

// ============================================================================
// Small utilities
// ============================================================================

/** Constant-time string comparison (webhook secret). */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const TEHRAN_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tehran", // UTC+03:30 fixed — Iran abolished DST in 2022
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The calendar day a given instant falls on, in Tehran.
 * Returns a 'YYYY-MM-DD' string. This is the project's single definition of
 * "today" — never the server clock, never UTC.
 */
function tehranToday(instant = new Date()) {
  return TEHRAN_DATE_FMT.format(instant);
}

/** Tehran calendar day of tomorrow ('YYYY-MM-DD'). */
function tomorrowTehran(instant = new Date()) {
  const today = tehranToday(instant);
  const noonUtc = new Date(`${today}T12:00:00Z`); // noon UTC = late afternoon in Tehran
  return TEHRAN_DATE_FMT.format(new Date(noonUtc.getTime() + 86_400_000));
}

function nowIso() {
  return new Date().toISOString();
}

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

/** Convert ASCII digits to Persian digits for user-facing text. */
function toPersianDigits(input) {
  return String(input).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

/** Normalize Persian text for deterministic comparisons (drop ZWNJ/diacritics/punctuation). */
function normalizeFa(text) {
  return String(text)
    .replace(/[\u200c\u064b-\u0652\u0670]/g, "")
    .replace(/[،.,!?؛:「」«»()\s]+/g, " ")
    .trim();
}

const AFFIRMATIVE = new Set([
  "بله",
  "آره",
  "اره",
  "بلی",
  "باشه",
  "اوکی",
  "اوکیه",
  "تایید",
  "تأیید",
  "حذف کن",
  "همه رو حذف کن",
  "همه رو پاک کن",
  "بله حذف کن",
  "بله همه رو حذف کن",
  "پاکشون کن",
  "حذفشون کن",
]);

/** True only for an explicit confirmation word/phrase (used for the delete-all gate). */
function isAffirmative(text) {
  const t = normalizeFa(text);
  if (AFFIRMATIVE.has(t)) return true;
  if (t.includes("همه") && (t.includes("حذف کن") || t.includes("پاک کن"))) return true;
  return false;
}

function cleanTaskText(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, MAX_TASK_TEXT);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ============================================================================
// Telegram Bot API
// ============================================================================

async function sendMessage(env, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(`Telegram sendMessage failed (HTTP ${response.status})`);
  }
}

// ============================================================================
// D1 data access — all statements are prepared statements
// ============================================================================

/**
 * Task context for the LLM prompt and reply formatting:
 * every pending task (any day) plus today's completed tasks.
 */
async function loadTaskContext(env, userId, today) {
  const { results: pending } = await env.DB
    .prepare(
      `SELECT id, task_text, task_day FROM tasks
       WHERE user_id = ? AND status = 'pending'
       ORDER BY task_day ASC, id ASC LIMIT ?`
    )
    .bind(userId, TASKS_IN_PROMPT)
    .all();
  const { results: doneToday } = await env.DB
    .prepare(
      `SELECT id, task_text FROM tasks
       WHERE user_id = ? AND status = 'done' AND task_day = ?
       ORDER BY completed_at ASC LIMIT ?`
    )
    .bind(userId, today, TASKS_IN_PROMPT)
    .all();
  return { pending, doneToday };
}

async function getTaskById(env, userId, taskId) {
  return env.DB
    .prepare(`SELECT id, task_text, status FROM tasks WHERE id = ? AND user_id = ?`)
    .bind(taskId, userId)
    .first();
}

async function insertTask(env, userId, taskText, taskDay) {
  const result = await env.DB
    .prepare(
      `INSERT INTO tasks (user_id, task_text, status, task_day, created_at)
       VALUES (?, ?, 'pending', ?, ?)`
    )
    .bind(userId, taskText, taskDay, nowIso())
    .run();
  return result.meta.last_row_id;
}

async function setTaskStatus(env, userId, taskId, status) {
  const completedAt = status === "done" ? nowIso() : null;
  const result = await env.DB
    .prepare(`UPDATE tasks SET status = ?, completed_at = ? WHERE id = ? AND user_id = ?`)
    .bind(status, completedAt, taskId, userId)
    .run();
  return result.meta.changes > 0;
}

async function deleteTaskById(env, userId, taskId) {
  const result = await env.DB
    .prepare(`DELETE FROM tasks WHERE id = ? AND user_id = ? RETURNING task_text`)
    .bind(taskId, userId)
    .first();
  return result?.task_text ?? null;
}

async function deleteAllPending(env, userId) {
  const before = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status = 'pending'`)
    .bind(userId)
    .first();
  await env.DB.prepare(`DELETE FROM tasks WHERE user_id = ? AND status = 'pending'`).bind(userId).run();
  return before?.n ?? 0;
}

async function findDuplicatePending(env, userId, taskText, taskDay) {
  return env.DB
    .prepare(
      `SELECT id FROM tasks
       WHERE user_id = ? AND status = 'pending' AND task_text = ? AND task_day = ?
       LIMIT 1`
    )
    .bind(userId, taskText, taskDay)
    .first();
}

/** Record one update_id; returns false when it was already processed (Telegram retry). */
async function markUpdateProcessed(env, updateId) {
  const result = await env.DB
    .prepare(
      `INSERT INTO processed_updates (update_id, processed_at) VALUES (?, ?)
       ON CONFLICT (update_id) DO NOTHING`
    )
    .bind(updateId, nowIso())
    .run();
  return result.meta.changes > 0;
}

async function pruneStatement(env) {
  return env.DB
    .prepare(`DELETE FROM processed_updates WHERE processed_at < ?`)
    .bind(new Date(Date.now() - DEDUP_RETENTION_MS).toISOString());
}

async function getHistory(env, userId, limit = HISTORY_IN_PROMPT) {
  const { results } = await env.DB
    .prepare(
      `SELECT role, content FROM conversation_history
       WHERE user_id = ? ORDER BY id DESC LIMIT ?`
    )
    .bind(userId, limit)
    .all();
  return (results ?? []).reverse(); // oldest → newest
}

/** Store the user/assistant turn and trim history + dedup table in one batch. */
async function appendHistory(env, userId, userText, assistantText) {
  const iso = nowIso();
  await env.DB.batch([
    env.DB
      .prepare(`INSERT INTO conversation_history (user_id, role, content, created_at) VALUES (?, 'user', ?, ?)`)
      .bind(userId, userText, iso),
    env.DB
      .prepare(`INSERT INTO conversation_history (user_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)`)
      .bind(userId, assistantText, iso),
    env.DB
      .prepare(
        `DELETE FROM conversation_history WHERE user_id = ? AND id NOT IN (
           SELECT id FROM conversation_history WHERE user_id = ? ORDER BY id DESC LIMIT ?
         )`
      )
      .bind(userId, userId, HISTORY_KEEP),
    await pruneStatement(env),
  ]);
}

// ============================================================================
// Reply formatting (deterministic, Persian)
// ============================================================================

function buildListText(today, pending, doneToday) {
  const todayPending = pending.filter((t) => t.task_day === today);
  const overdue = pending.filter((t) => t.task_day !== today);
  if (todayPending.length === 0 && doneToday.length === 0 && overdue.length === 0) {
    return MSG.emptyList;
  }
  const parts = [];
  if (todayPending.length > 0 || doneToday.length > 0) {
    const lines = [];
    let n = 1;
    for (const t of todayPending) lines.push(`⬜ ${toPersianDigits(n++)}. ${t.task_text}`);
    for (const t of doneToday) lines.push(`✅ ${toPersianDigits(n++)}. ${t.task_text}`);
    parts.push(`${MSG.listTitle}\n${lines.join("\n")}`);
  }
  if (overdue.length > 0) {
    const lines = overdue.map(
      (t, i) => `⬜ ${toPersianDigits(i + 1)}. ${t.task_text} (${toPersianDigits(t.task_day)})`
    );
    parts.push(`${MSG.overdueTitle}\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

// ============================================================================
// LLM — structured decision over free-form Persian text
// ============================================================================

const JSON_SHAPE =
  '{"action":"add|done|undone|del|list|chat","task_text":string|null,"task_id":number|null,"task_day":"today"|"tomorrow"|null,"reply":string|null,"needs_clarification":boolean}';

function buildSystemPrompt(todayStr, taskCtx) {
  const lines = [];
  let n = 1;
  for (const t of taskCtx.pending) {
    lines.push(`${n}. [id=${t.id}] ${t.task_text} — وضعیت: انجام‌نشده (${t.task_day})`);
    n++;
  }
  for (const t of taskCtx.doneToday) {
    lines.push(`${n}. [id=${t.id}] ${t.task_text} — وضعیت: انجام‌شده (امروز)`);
    n++;
  }
  const taskList = lines.length ? lines.join("\n") : "(لیست وظایف خالی است)";

  return [
    'You are the natural-language understanding unit of a Persian personal todo bot named "Hermes Mini".',
    "The user writes free-form Persian. You NEVER touch the database — you only decide what the bot should do.",
    `TODAY in Tehran timezone: ${todayStr}`,
    "",
    "CURRENT TASK LIST (position. [id=...] title — status (day)):",
    taskList,
    "",
    "Return EXACTLY ONE LINE of valid JSON — no markdown, no code fences, no explanation — with exactly this shape:",
    JSON_SHAPE,
    "",
    "Rules:",
    '1. action="add": the user records a new task. task_text = a short Persian task title without conversational words («شیر بخر» → "خرید شیر"). task_day = "tomorrow" ONLY if فردا is explicitly mentioned, otherwise null (means today).',
    '2. action="done": the user finished something («شیر رو خریدم», «تمرین رو انجام دادم»). Pick the task from the CURRENT TASK LIST whose title (or the conversation context) matches best and put its id number in task_id. If nothing matches, set needs_clarification=true and ask in Persian.',
    '3. action="undone": the user says they did NOT do it or wants to reopen («شیر رو نخریدم», «اشتباه بود، برش گردون»). Same matching rule as done.',
    '4. action="del": delete ONE specific task; task_id is required. NEVER delete everything: if the user asks to delete all tasks, set action="del", task_id=null, needs_clarification=true and put a Persian confirmation question in reply — the system asks for confirmation itself.',
    '5. action="list": the user asks to see their tasks («کارام چیه؟»). Everything else null.',
    '6. action="chat": greetings, thanks, small talk, questions, or anything not about tasks. Put a short, friendly, natural Persian reply (1-2 sentences) in reply.',
    "7. Use the conversation history to resolve references like «همین رو حذف کن» or «اون کار رو انجام دادم».",
    "8. task_id MUST be copied from the [id=...] values of the CURRENT TASK LIST above — never invent one. If the user gives a NUMBER («شماره ۳ رو حذف کن»), it is the position number in the list above; map it to that position's id. If that number does not exist in the list, set needs_clarification=true.",
    "9. Whenever the message is ambiguous or you cannot uniquely identify the task: needs_clarification=true with a Persian clarifying question in reply. Never guess between several similar tasks.",
    "10. reply must always be natural, friendly Persian.",
    "Output the single JSON line and nothing else.",
  ].join("\n");
}

/**
 * Extract a JSON object from a model reply.
 * Tolerates markdown fences / surrounding prose; returns null when nothing parses.
 */
export function extractJson(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate a parsed LLM decision against our schema and the real task list.
 * Returns the normalized decision, or null when it is unusable.
 */
export function validateDecision(raw, validIds) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const action = typeof raw.action === "string" ? raw.action.trim().toLowerCase() : "";
  if (!ACTIONS.has(action)) return null;

  const taskText =
    typeof raw.task_text === "string" && raw.task_text.trim().length > 0
      ? cleanTaskText(raw.task_text)
      : null;
  const reply =
    typeof raw.reply === "string" && raw.reply.trim().length > 0
      ? raw.reply.trim().slice(0, MAX_REPLY_CHARS)
      : null;
  const taskDay = raw.task_day === "today" || raw.task_day === "tomorrow" ? raw.task_day : null;
  const needsClarification = raw.needs_clarification === true;

  // An id that is not an integer present in the real list is a hallucination → unusable.
  if (raw.task_id != null && !Number.isInteger(raw.task_id)) return null;
  if (raw.task_id != null && Number.isInteger(raw.task_id) && !validIds.has(raw.task_id)) return null;
  const taskId = raw.task_id != null && validIds.has(raw.task_id) ? raw.task_id : null;

  if (action === "add" && !taskText) return null;
  if ((action === "done" || action === "undone" || action === "del") && !taskId && !needsClarification) {
    return null; // destructive/status actions need a verified target or an explicit clarification
  }
  return {
    action,
    task_text: taskText,
    task_id: taskId,
    task_day: taskDay,
    reply,
    needs_clarification: needsClarification,
  };
}

/** Call Workers AI and return the raw response text (null on any failure/timeout). */
async function callLLM(env, messages) {
  if (!env.AI || typeof env.AI.run !== "function") return null;
  try {
    const result = await env.AI.run(AI_MODEL, {
      messages,
      max_tokens: 300,
      temperature: 0.2,
    });
    let text = typeof result === "string" ? result : (result?.response ?? null);
    // Some Workers AI bindings auto-parse JSON-looking model output and hand
    // back an object; re-serialize so the extraction/validation works on text.
    if (text && typeof text === "object") text = JSON.stringify(text);
    return typeof text === "string" && text.length > 0 ? text : null;
  } catch (error) {
    console.error("LLM call failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Ask the model for a decision. One corrective retry is attempted when the
 * first reply does not validate. Returns the normalized decision or null.
 */
async function decide(env, todayStr, taskCtx, history, userText) {
  const validIds = new Set([...taskCtx.pending, ...taskCtx.doneToday].map((t) => t.id));
  const messages = [
    { role: "system", content: buildSystemPrompt(todayStr, taskCtx) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userText },
  ];

  let text = await callLLM(env, messages);
  let decision = validateDecision(extractJson(text ?? ""), validIds);
  if (decision) return decision;

  // Safe retry: instruct the model to emit only the JSON line (R3 fallback path).
  const retryMessages = [
    ...messages,
    { role: "assistant", content: (text ?? "").slice(0, 200) || "(invalid)" },
    {
      role: "user",
      content: "پاسخ قبلی‌ات JSON معتبر نبود. فقط و فقط همان یک خط JSON را برگردان، بدون هیچ متن اضافه.",
    },
  ];
  text = await callLLM(env, retryMessages);
  decision = validateDecision(extractJson(text ?? ""), validIds);
  return decision;
}

// ============================================================================
// Action execution — the only code path that mutates task data
// ============================================================================

async function executeDecision(env, userId, today, decision, taskCtx) {
  switch (decision.action) {
    case "add": {
      const taskText = decision.task_text;
      const taskDay = decision.task_day === "tomorrow" ? tomorrowTehran() : today;
      const dup = await findDuplicatePending(env, userId, taskText, taskDay);
      if (dup) return `${MSG.duplicateTask} «${taskText}»`;
      await insertTask(env, userId, taskText, taskDay);
      const dayNote = taskDay === today ? "" : " 📅 فردا";
      return `✅ ثبت شد: «${taskText}»${dayNote}`;
    }
    case "done": {
      const task = await getTaskById(env, userId, decision.task_id);
      if (!task) return MSG.whichTask;
      if (task.status === "done") return `${MSG.alreadyDone} «${task.task_text}»`;
      await setTaskStatus(env, userId, decision.task_id, "done");
      return `✅ انجام شد: «${task.task_text}»`;
    }
    case "undone": {
      const task = await getTaskById(env, userId, decision.task_id);
      if (!task) return MSG.whichTask;
      if (task.status !== "done") return `${MSG.alreadyPending} «${task.task_text}»`;
      await setTaskStatus(env, userId, decision.task_id, "pending");
      return `↩️ برگشت به حالت انجام‌نشده: «${task.task_text}»`;
    }
    case "del": {
      const deletedText = await deleteTaskById(env, userId, decision.task_id);
      if (!deletedText) return MSG.whichTask;
      return `🗑 حذف شد: «${deletedText}»`;
    }
    case "list":
      return buildListText(today, taskCtx.pending, taskCtx.doneToday);
    case "chat":
      return decision.reply ?? MSG.llmFailed;
    default:
      return MSG.llmFailed;
  }
}

// ============================================================================
// Update processing
// ============================================================================

async function handleAuthorizedMessage(env, message) {
  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = String(message.text).trim();

  const today = tehranToday();
  const history = await getHistory(env, userId);

  // ---- deterministic delete-all confirmation gate --------------------------
  // «همه را حذف کن» never deletes directly; the bot asks, and only an explicit
  // affirmative reply to OUR confirmation message executes the bulk delete.
  const lastAssistant = [...history].reverse().find((h) => h.role === "assistant");
  if (lastAssistant && lastAssistant.content.startsWith(DELETE_ALL_MARKER) && isAffirmative(text)) {
    const n = await deleteAllPending(env, userId);
    const reply = n > 0 ? `🗑 ${toPersianDigits(n)} وظیفه‌ی انجام‌نشده حذف شد.` : MSG.deleteAllEmpty;
    await appendHistory(env, userId, text, reply);
    await sendMessage(env, chatId, reply);
    return;
  }

  // ---- LLM decision --------------------------------------------------------
  const taskCtx = await loadTaskContext(env, userId, today);
  const decision = await decide(env, today, taskCtx, history, text);

  let reply;
  if (!decision) {
    // Invalid/malformed model output → safe fallback, no DB mutation (R3).
    reply = MSG.llmFailed;
  } else if (decision.needs_clarification) {
    reply =
      decision.reply ??
      "منظورت رو دقیق‌تر بگو لطفاً.";
    if (decision.action === "del" && !decision.task_id) {
      // Bulk delete request → deterministic confirmation question.
      const pendingCount = taskCtx.pending.length;
      reply =
        pendingCount > 0
          ? `${DELETE_ALL_MARKER} می‌خوای هر ${toPersianDigits(pendingCount)} تا وظیفه‌ی انجام‌نشده حذف بشن؟ برای تأیید بنویس «بله».`
          : MSG.deleteAllEmpty;
    }
  } else {
    reply = await executeDecision(env, userId, today, decision, taskCtx);
  }

  await appendHistory(env, userId, text, reply);
  await sendMessage(env, chatId, reply);
}

/** Process one Telegram update. Any thrown error is handled by the caller. */
async function processUpdate(env, update) {
  const updateId = update?.update_id;
  if (!Number.isInteger(updateId)) return;

  const message = update.message;
  if (!message || typeof message !== "object") return;
  if (update.edited_message || message.via_bot) return;

  const fromId = message.from?.id;
  if (!Number.isInteger(fromId)) return;

  // Single whitelisted user (R5). Unauthorized senders are ignored completely —
  // no LLM call, no database access, no reply (silent 200).
  if (String(fromId) !== String(env.TELEGRAM_ALLOWED_USER_ID)) {
    console.log("ignored unauthorized user");
    return;
  }

  // Dedup is only recorded for the whitelisted user, so unauthorized traffic
  // never touches the database.
  const isNew = await markUpdateProcessed(env, updateId);
  if (!isNew) return; // duplicate delivery — already handled once
  // From here the update is recorded as processed; we always answer Telegram
  // 200 so it stops retrying (retries would be deduplicated anyway).

  if (typeof message.text !== "string" || message.text.trim().length === 0) {
    await sendMessage(env, message.chat.id, MSG.nonText);
    return;
  }

  await handleAuthorizedMessage(env, message);
}

// ============================================================================
// HTTP handlers
// ============================================================================

async function handleHealth(env) {
  let database = "ok";
  try {
    await env.DB.prepare("SELECT 1").first();
  } catch {
    database = "error";
  }
  if (database !== "ok") return json({ status: "degraded", database }, 503);
  return json({ status: "ok", database, time: nowIso() });
}

async function handleWebhook(request, env) {
  const required = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_ALLOWED_USER_ID"];
  if (!env.DB || !env.AI || !required.every((k) => env[k])) {
    return new Response("Server configuration error", { status: 500 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // R6: every request without a valid secret header gets 403.
  const receivedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!safeEqual(receivedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }

  // Payload size limit.
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }

  let update;
  try {
    update = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  try {
    await processUpdate(env, update);
  } catch (error) {
    // Never crash on a single update; try to tell the user something went wrong.
    console.error("update processing failed:", error instanceof Error ? error.stack : String(error));
    const chatId = update?.message?.chat?.id;
    if (chatId) {
      await sendMessage(env, chatId, MSG.internalError).catch(() => {});
    }
  }

  // Always 2xx once authenticated: Telegram stops retrying; the update_id
  // deduplication guarantees at-most-once processing.
  return new Response("OK");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      return handleHealth(env);
    }

    if (url.pathname !== "/telegram-webhook") {
      return new Response("Not Found", { status: 404 });
    }

    return handleWebhook(request, env);
  },

  /** Bonus — daily reminder: every morning the bot sends today's task list. */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const userId = String(env.TELEGRAM_ALLOWED_USER_ID);
          const today = tehranToday();
          const taskCtx = await loadTaskContext(env, userId, today);
          const todayPending = taskCtx.pending.filter((t) => t.task_day === today);
          let body;
          if (todayPending.length === 0) {
            body = "🌅 صبح بخیر! برای امروز هیچ کاری ثبت نشده. 🌱";
          } else {
            const lines = todayPending.map((t, i) => `⬜ ${toPersianDigits(i + 1)}. ${t.task_text}`);
            body = `🌅 صبح بخیر! کارهای امروزت:\n${lines.join("\n")}`;
          }
          await sendMessage(env, userId, body);
        } catch (error) {
          console.error("scheduled reminder failed:", error instanceof Error ? error.stack : String(error));
        }
      })()
    );
  },
};

// Pure helpers exported for the test suite.
export {
  safeEqual,
  tehranToday,
  tomorrowTehran,
  toPersianDigits,
  normalizeFa,
  isAffirmative,
  cleanTaskText,
  buildListText,
};
