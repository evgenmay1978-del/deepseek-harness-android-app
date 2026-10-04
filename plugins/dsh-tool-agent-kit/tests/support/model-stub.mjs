#!/usr/bin/env node
/**
 * model-stub.mjs — тестовый стенд: ОДИН HTTP-сервер на два дела (инъекция памяти и ретраи).
 * Все тела запросов пишутся в jsonl, чтобы утверждать по содержимому, а не по логам клиента.
 *
 * env:
 *   STUB_PORT  — порт (по умолчанию 3099)
 *   STUB_MODE  — ok | retry-3 | fail-always | quota-402 | stream-break
 *   STUB_LOG   — путь jsonl (по умолчанию stub-requests.jsonl)
 *
 * Сценарии:
 *   retry-3      — первые 3 запроса рвут соединение, затем валидный ответ (ждём 3 повтора)
 *   fail-always  — всегда рвём (ход должен завершиться внятной ошибкой)
 *   quota-402    — всегда 402 (ровно одна попытка, повтор не помогает)
 *   stream-break — отдаём начало SSE и обрываем (частичный ответ не склеивается с повтором)
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.STUB_PORT || 3099);
const MODE = process.env.STUB_MODE || "ok";
const LOG = process.env.STUB_LOG || "stub-requests.jsonl";
let n = 0;

const completion = (text) => ({
  id: "stub", object: "chat.completion", model: "stub",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
});

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    n++;
    try { appendFileSync(LOG, JSON.stringify({ n, url: req.url, mode: MODE, body: raw.slice(0, 200000) }) + "\n"); } catch { /* лог не критичен */ }
    if (MODE === "quota-402") {
      res.writeHead(402, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Insufficient Balance", code: "QUOTA" } }));
    }
    if (MODE === "fail-always" || (MODE === "retry-3" && n <= 3)) { req.socket.destroy(); return; }
    if (MODE === "stream-break") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"part"}}]}\n\n');
      return req.socket.destroy();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(completion("ok")));
  });
}).listen(PORT, "127.0.0.1", () => console.log("stub on " + PORT + " mode=" + MODE + " log=" + LOG));
