import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const localEnvironment = parseEnv(await readFile(resolve(projectRoot, ".env"), "utf8"));
  for (const key of ["GROQ_API_KEY", "GROQ_MODEL", "PORT"]) {
    if (Object.hasOwn(localEnvironment, key)) process.env[key] = localEnvironment[key];
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const port = Number(process.env.PORT || 4173);
const maxBodyBytes = 32 * 1024;
const allowedCategories = new Set(["study", "homework", "tasks", "ideas", "reminders", "important", "documents", "other"]);
const allowedPriorities = new Set(["Высокий", "Средний", "Обычный"]);

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("Слишком большой текст заметки."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Некорректный JSON."), { status: 400 });
  }
}

function cleanAnalysis(value, sourceText) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI вернул ответ в неверном формате.");
  const categories = [...new Set(Array.isArray(value.categories) ? value.categories.filter(category => allowedCategories.has(category)) : [])];
  if (categories.length === 0) categories.push("other");
  const dueISO = typeof value.dueISO === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.dueISO) && !Number.isNaN(Date.parse(`${value.dueISO}T00:00:00Z`))
    ? value.dueISO
    : "";
  const priority = allowedPriorities.has(value.priority) ? value.priority : "Обычный";
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim().slice(0, 120) : sourceText.slice(0, 80);
  const summary = typeof value.summary === "string" && value.summary.trim() ? value.summary.trim().slice(0, 500) : sourceText.slice(0, 500);
  const nextAction = typeof value.nextAction === "string" ? value.nextAction.trim().slice(0, 180) : "";
  const status = categories.includes("ideas") ? "Новая идея" : "";
  return { title, description: summary, categories, priority, dueISO, nextAction, status };
}

async function analyzeWithGroq(text, attachments = []) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) return { error: "Добавь новый GROQ_API_KEY в файл .env и перезапусти сервер." };

  const model = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-20b";
  const attachmentContext = attachments.length ? `\nИмена вложений (их содержимое не передано): ${attachments.join(", ")}` : "";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_completion_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Ты помощник приложения Smart Notes. Кратко и точно разбери заметку, не меняя её смысл и не выдумывая факты. Верни только JSON-объект с полями: title (короткий заголовок), summary (краткое содержание), categories (массив из study, homework, tasks, ideas, reminders, important, documents, other; заметка может иметь несколько категорий), priority (Высокий, Средний или Обычный), dueISO (дата YYYY-MM-DD или пустая строка; относительную дату вычисли от текущей даты, если она однозначна), nextAction (следующий шаг или пустая строка). Для идеи укажи её в ideas. Если срок неоднозначен, оставь dueISO пустым. Не добавляй Markdown."
        },
        { role: "user", content: `Сегодня ${new Date().toISOString().slice(0, 10)}. Разбери эту информацию:\n${text}${attachmentContext}` }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    console.error(`Groq API returned ${response.status}: ${details.slice(0, 500)}`);
    return { error: "Groq не обработал запрос. Проверь ключ, модель и подключение к интернету.", status: 502 };
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") return { error: "Groq вернул пустой ответ.", status: 502 };
  try {
    return { analysis: cleanAnalysis(JSON.parse(content), text) };
  } catch (error) {
    console.error("Could not parse Groq analysis:", error.message);
    return { error: "Не удалось разобрать ответ Groq. Попробуй ещё раз.", status: 502 };
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, { status: "ok" });
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    return sendJson(response, 200, {
      configured: Boolean(process.env.GROQ_API_KEY?.trim()),
      model: process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-20b"
    });
  }

  if (request.method === "POST" && url.pathname === "/api/analyze") {
    if (!process.env.GROQ_API_KEY?.trim()) {
      return sendJson(response, 503, { error: "Добавь новый GROQ_API_KEY в файл .env и перезапусти сервер." });
    }
    try {
      const body = await readJson(request);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return sendJson(response, 400, { error: "Добавь текст для анализа." });
      if (text.length > 20000) return sendJson(response, 413, { error: "Заметка слишком длинная. Максимум 20 000 символов." });
      const attachments = Array.isArray(body.attachments)
        ? body.attachments.filter(name => typeof name === "string").slice(0, 10).map(name => name.slice(0, 160))
        : [];
      const result = await analyzeWithGroq(text, attachments);
      if (result.error) return sendJson(response, result.status || 503, { error: result.error });
      return sendJson(response, 200, result);
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        return sendJson(response, 504, { error: "Groq отвечает слишком долго. Попробуй ещё раз." });
      }
      return sendJson(response, error.status || 500, { error: error.status ? error.message : "Не удалось выполнить AI-анализ." });
    }
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = await readFile(resolve(projectRoot, "index.html"));
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin"
      });
      return response.end(html);
    } catch {
      return sendJson(response, 500, { error: "Не удалось загрузить приложение." });
    }
  }

  return sendJson(response, 404, { error: "Страница не найдена." });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Smart Notes running at http://localhost:${port}`);
  console.log(process.env.GROQ_API_KEY?.trim() ? "Groq API key is configured." : "Groq API key is missing. Add it to .env and restart the server.");
});
