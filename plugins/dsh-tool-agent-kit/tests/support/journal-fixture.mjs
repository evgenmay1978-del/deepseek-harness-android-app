/**
 * Фрагменты РЕАЛЬНОГО журнала сессии session-7db2f18c-a914-40c6-85f5-d78c256ce0df
 * (payload/dshhome/sessions/.../session.v4.jsonl.zstd, событие user/message, 04.10.2026).
 *
 * Зафиксированный факт: UserMessage.content — ВСЕГДА массив блоков
 * (@deepseek-ai/dsh-llm: readonly ContentBlock[]), а не строка. Блоки бывают
 * text / file / image. Поэтому контрактный тест инъекции обязан брать эту форму,
 * иначе он проверяет несуществующий путь (строка контента) и врёт зелёным.
 */
export const REAL_TURN34 = Object.freeze({
  role: "user",
  id: "9dcadfba-8d18-4012-bd71-c14f8c57660a",
  content: Object.freeze([Object.freeze({ type: "text", text: "Перезагрузил" })])
});

export const REAL_TURN1_WITH_FILE = Object.freeze({
  role: "user",
  id: "turn1-file+text",
  content: Object.freeze([
    Object.freeze({ type: "file", attachment: Object.freeze({ attachmentId: "sha256:55d81ae2c62ca75ff559e2b715699dd149d297ad23d4bd38af167b98a0876ebb", name: "polzaai", bytes: 36 }) }),
    Object.freeze({ type: "text", text: "Добавить этот апи можно?" })
  ])
});
