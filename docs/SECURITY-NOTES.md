# Заметки по безопасности (DSH на Android)

- **Песочница bash не активна в режиме `danger-full-access`.** Проверка `dsh-tool-bash/lib/index.js:347`
  (`defaultMode !== void 0 && sandboxPolicy === void 0` → `throw`) срабатывает ТОЛЬКО в confining-режиме.
  При `danger-full-access` условие не выполняется, и bash грузится **вообще без песочницы**.
  Поэтому «в `plugins.log` нет ошибки `sandboxPolicy is missing`» НЕ значит «bash изолирован»;
  это лишь значит, что режим не требует политики. Реальная защита в этом режиме — подтверждения
  и разметка недоверенных источников (taint/origin), а не песочница.

- **Ретраи: отсутствие явной `retryPolicy` у провайдера — не ошибка.** Ядро подставляет дефолт:
  `dsh-llm/lib/index.js:1867` → `adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(void 0, …)`,
  то есть нормальная политика с `maxRetries=5` и кодами `EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT`.
  Проверка конфига — `~/maestro/tools/check-retry-policy.mjs` (маркер применённого патча + контроль
  содержимого явных политик: без 401/402/403, с ограниченными повторами и backoff).
