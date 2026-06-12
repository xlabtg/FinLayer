# Повторный аудит логики FinLayer после закрытия #13-#37

- **Дата:** 2026-06-12
- **Issue:** [#64 «Check GPT 5.5»](https://github.com/xlabtg/FinLayer/issues/64)
- **PR:** [#65](https://github.com/xlabtg/FinLayer/pull/65)
- **База для сравнения:** предыдущий аудит [docs/audit/2026-06-01-logic-audit.md](./2026-06-01-logic-audit.md), закрытые issues #13-#37 и соответствующие remediation PRs #38-#63.
- **Объём:** повторный сквозной разбор текущего состояния `auth`, `swap`, `payments`, `earn`, `wallet`, `affiliate`, `analytics`, провайдеров, миграций БД, SDK и runtime wiring после закрытия первого набора замечаний.

## Резюме

Предыдущие 25 findings из аудита #11 были сопоставлены с закрытыми issues/PRs и выборочно проверены в текущем коде. Базовые проблемы первого аудита в основном исправлены: API-key lookup больше не сканирует произвольные 20 bcrypt hashes, swap/payment webhook paths получили проверки подписи и state guards, idempotency reservation перенесена до provider side effects, CORS и graceful shutdown усилены, payout scheduler использует row locking, analytics SQL больше не интерполирует period напрямую.

Повторный аудит нашёл **11 новых подтверждённых defects**, которые не дублируют старые issues: **1 critical**, **5 high**, **4 medium**, **1 low**. По каждому создан отдельный GitHub issue с `severity:*`, `domain:*` и `phase:*` labels.

## Трассируемость

| ID | Находка | Severity | Domain | Phase | Issue |
|----|---------|----------|--------|-------|-------|
| C1 | Свежая миграция падает из-за FK на `transactions` до создания таблицы | critical | infra | phase:1-critical-fixes | [#66](https://github.com/xlabtg/FinLayer/issues/66) |
| H1 | Инвойсы не передают провайдерам внутренний webhook URL | high | payments | phase:1-critical-fixes | [#67](https://github.com/xlabtg/FinLayer/issues/67) |
| H2 | MoonPay и Transak сохраняют синтетические `provider_invoice_id` | high | payments | phase:2-hardening | [#68](https://github.com/xlabtg/FinLayer/issues/68) |
| H3 | Default Aave/Compound adapters всегда недоступны даже с RPC env | high | earn | phase:2-hardening | [#69](https://github.com/xlabtg/FinLayer/issues/69) |
| H4 | Earn-позиции застревают `pending` и допускают withdraw до `active` | high | earn | phase:2-hardening | [#70](https://github.com/xlabtg/FinLayer/issues/70) |
| H5 | `MockBalance` регистрируется в production и возвращает фиктивные нули | high | wallet | phase:2-hardening | [#71](https://github.com/xlabtg/FinLayer/issues/71) |
| M1 | `underpaid` считается terminal в SDK и не дополливается до `paid` | medium | payments/sdk | phase:2-hardening | [#72](https://github.com/xlabtg/FinLayer/issues/72) |
| M2 | `getSwapStatus` обходит status transition guard и может откатить статус | medium | swap | phase:2-hardening | [#73](https://github.com/xlabtg/FinLayer/issues/73) |
| M3 | `affiliate_links.conversions` никогда не увеличивается | medium | affiliate/analytics | phase:3-tech-debt | [#74](https://github.com/xlabtg/FinLayer/issues/74) |
| M4 | `lint` и `typecheck` падают на `TS6059` из-за `rootDir=src` | medium | infra | phase:3-tech-debt | [#76](https://github.com/xlabtg/FinLayer/issues/76) |
| L1 | `executeSwap` возвращает `provider_tx_id: null` после успешного provider execute | low | swap | phase:3-tech-debt | [#75](https://github.com/xlabtg/FinLayer/issues/75) |

## Критичная находка

### C1. Свежая миграция падает из-за FK на `transactions` до создания таблицы

- **Issue:** [#66](https://github.com/xlabtg/FinLayer/issues/66)
- **Где:** `apps/api/src/db/migrations/001_initial_schema.sql:91-103`, `apps/api/src/db/migrations/001_initial_schema.sql:112-152`
- **Корневая причина:** `revenue_events` создаётся до `transactions`, но `transaction_id` сразу объявляет `REFERENCES transactions(id)`. Позже тот же FK добавляется повторно через `ALTER TABLE revenue_events ADD CONSTRAINT fk_revenue_events_transaction`.
- **Воздействие:** новая установка не сможет применить базовую миграцию на пустой PostgreSQL database, что блокирует fresh deploy, CI/integration environments и восстановление окружения с нуля.
- **Рекомендация:** убрать inline FK из `revenue_events.transaction_id` и добавлять constraint только после создания обеих таблиц, либо изменить порядок создания таблиц. Для существующих инсталляций нужна корректирующая идемпотентная миграция.

## Высокие находки

### H1. Инвойсы не передают провайдерам внутренний webhook URL

- **Issue:** [#67](https://github.com/xlabtg/FinLayer/issues/67)
- **Где:** `modules/payments/service.ts:181-191`, `modules/providers/nowpayments/adapter.ts:88-100`, `modules/providers/moonpay/adapter.ts:75-89`, `modules/providers/transak/adapter.ts:84-97`, `modules/payments/service.ts:637-662`, `modules/payments/routes.ts:158-203`
- **Корневая причина:** `PaymentsService.createInvoice` передаёт adapter `callbackUrl: request.callback_url`. Для NowPayments это становится `ipn_callback_url`, а для MoonPay/Transak - `redirectURL`. При этом внутренний URL `/v1/payments/webhook/:provider`, который API возвращает как `webhook_url` и реально обрабатывает, провайдерам не передаётся.
- **Воздействие:** provider notifications либо не приходят в FinLayer, либо уходят в пользовательский callback. Invoice/ledger остаются `pending`, status update и revenue event не применяются автоматически.
- **Рекомендация:** разделить provider webhook URL и пользовательский callback/redirect. Провайдерским API передавать только canonical FinLayer webhook URL, пользовательский callback хранить и вызывать отдельно после применения статуса.

### H2. MoonPay и Transak сохраняют синтетические `provider_invoice_id`

- **Issue:** [#68](https://github.com/xlabtg/FinLayer/issues/68)
- **Где:** `modules/providers/moonpay/adapter.ts:75-101`, `modules/providers/moonpay/adapter.ts:136-143`, `modules/providers/transak/adapter.ts:84-109`, `modules/providers/transak/adapter.ts:141-150`, `modules/payments/service.ts:219-231`, `modules/payments/service.ts:450-468`
- **Корневая причина:** MoonPay/Transak adapters генерируют локальные IDs вида `mp_<timestamp>_<random>` и `tk_<timestamp>_<random>` как `providerInvoiceId`. Эти IDs сохраняются в `invoices.provider_invoice_id`, но webhook parsing возвращает реальные provider order/transaction IDs из payload, а polling вызывает provider API по синтетическому ID.
- **Воздействие:** webhook не находит invoice, polling обращается к provider API с несуществующим ID. Fiat on-ramp invoices через эти providers невозможно надёжно перевести из `pending` в paid/expired.
- **Рекомендация:** использовать provider-supported correlation key: external order id, metadata, signed state или заранее созданный provider order. Добавить тест create invoice -> simulated provider webhook with real provider id -> invoice status changes.

### H3. Default Aave/Compound adapters всегда недоступны даже с RPC env

- **Issue:** [#69](https://github.com/xlabtg/FinLayer/issues/69)
- **Где:** `modules/earn/routes.ts:193-249`
- **Корневая причина:** `buildDefaultAdapters()` читает `AAVE_RPC_URL` и `COMPOUND_RPC_URL`, но независимо от наличия env vars создаёт adapters с `makeUnavailableAaveRpc(...)` и `makeUnavailableCompoundRpc(...)`. Эти clients всегда бросают `ValidationError`.
- **Воздействие:** стандартные `/v1/earn` routes выглядят сконфигурированными, но deposit/withdraw/live position refresh не работают в runtime даже при заданных RPC env vars.
- **Рекомендация:** реализовать реальные RPC clients при наличии env vars или не регистрировать providers как доступные для write operations. Health/status endpoints должны явно показывать unavailable state.

### H4. Earn-позиции застревают `pending` и допускают withdraw до `active`

- **Issue:** [#70](https://github.com/xlabtg/FinLayer/issues/70)
- **Где:** `modules/earn/service.ts:192-227`, `modules/earn/service.ts:255-265`, `modules/earn/service.ts:291-304`, `modules/earn/service.ts:362-384`, `modules/earn/service.ts:476-503`
- **Корневая причина:** deposit пишет `transactions.status = depositResult.status`, но новую `earn_positions` всегда создаёт со статусом `pending`. `buildPositionFromRow` обновляет live position только если status уже `active`, поэтому pending position с `provider_position_id` не переходит в active через read path. Withdraw запрещает только `withdrawn`, lock и отсутствие `provider_position_id`, но не требует `active`; после provider withdraw позиция безусловно становится `withdrawn`, даже если transaction ещё `processing`.
- **Воздействие:** position API может навсегда показывать `pending`, при этом withdrawal можно инициировать до подтверждённого active state, а локальная позиция будет закрыта до финальности provider transaction.
- **Рекомендация:** ввести state machine для earn positions, разрешить refresh для non-terminal states, запретить withdraw до `active`, и переводить в `withdrawn` только после terminal withdrawal.

### H5. `MockBalance` регистрируется в production и возвращает фиктивные нули

- **Issue:** [#71](https://github.com/xlabtg/FinLayer/issues/71)
- **Где:** `modules/wallet/routes.ts:21-36`, `modules/wallet/service.ts:241-246`, `modules/providers/mock-balance/adapter.ts:34-87`, `modules/providers/alchemy/adapter.ts:14-39`
- **Корневая причина:** `buildBalanceProviders()` всегда добавляет `MockBalanceProvider`. Mock provider поддерживает основные сети и по умолчанию возвращает `0` для любых адресов/токенов. Если `ALCHEMY_API_KEY` отсутствует, mock обслуживает все balance requests; если Alchemy настроен, сети вне его списка всё равно уходят в mock.
- **Воздействие:** production API может отдавать правдоподобные, но фиктивные нулевые балансы вместо ошибки `no provider configured`.
- **Рекомендация:** регистрировать mock только в test/development или за явным env flag. В production при отсутствии реального provider возвращать provider unavailable error.

## Средние находки

### M1. `underpaid` считается terminal в SDK и не дополливается до `paid`

- **Issue:** [#72](https://github.com/xlabtg/FinLayer/issues/72)
- **Где:** `modules/payments/service.ts:68-81`, `modules/payments/service.ts:286-318`, `packages/sdk/src/modules/payments.ts:56-77`
- **Корневая причина:** API state machine разрешает `underpaid -> paid/overpaid/expired`, но `getInvoice()` refreshes provider status только для `pending`. SDK `waitForPayment()` считает `underpaid` terminal и прекращает polling.
- **Воздействие:** клиент может получить `underpaid` как финальный результат, хотя provider позже доведёт оплату до `paid` или `overpaid`.
- **Рекомендация:** согласовать terminal semantics между API и SDK. Если `underpaid` recoverable, refresh должен работать для всех non-terminal statuses, а SDK не должен завершать polling на `underpaid`.

### M2. `getSwapStatus` обходит status transition guard и может откатить статус

- **Issue:** [#73](https://github.com/xlabtg/FinLayer/issues/73)
- **Где:** `modules/swap/service.ts:99-120`, `modules/swap/service.ts:491-504`, `modules/swap/service.ts:588-604`
- **Корневая причина:** swap webhook handler использует `isValidSwapStatusTransition`, но `getSwapStatus()` при provider polling напрямую записывает `statusResult.status` для `pending`/`processing` rows. Например, `processing -> pending` будет записан, хотя state machine запрещает такой переход.
- **Воздействие:** read endpoint может изменять состояние в обход правил, которые защищают webhook path. Это даёт статусные откаты и нестабильный ledger state.
- **Рекомендация:** использовать общий transition guard для webhook и polling refresh. Invalid transitions логировать и игнорировать.

### M3. `affiliate_links.conversions` никогда не увеличивается

- **Issue:** [#74](https://github.com/xlabtg/FinLayer/issues/74)
- **Где:** `apps/api/src/db/migrations/001_initial_schema.sql:75-87`, `modules/affiliate/service.ts:71-78`, `modules/affiliate/service.ts:114-119`, `modules/affiliate/service.ts:132-148`, `modules/marketplace/service.ts:5-9`, `modules/swap/revenue.ts:52-90`, `modules/analytics/service.ts:287-314`
- **Корневая причина:** schema и stats имеют поле `conversions`, но код увеличивает только `clicks`. Revenue events хранят `affiliate_id`, но не `affiliate_link_id`, поэтому conversion невозможно привязать к конкретной ссылке.
- **Воздействие:** affiliate dashboard возвращает `total_conversions = 0` и per-link conversions = 0 независимо от реальных платящих транзакций. Marketplace link performance недостоверен.
- **Рекомендация:** сохранять attribution source на transaction/revenue event уровне, например `affiliate_link_id` или signed referral token, и инкрементить conversion ровно один раз при создании revenue event.

### M4. `lint` и `typecheck` падают на `TS6059` из-за `rootDir=src`

- **Issue:** [#76](https://github.com/xlabtg/FinLayer/issues/76)
- **Где:** `package.json` scripts `lint`/`typecheck`, `apps/api/package.json` script `lint`, `tsconfig.json:2-26`
- **Корневая причина:** root `tsconfig.json` задаёт `compilerOptions.rootDir = "src"`, но `tsc` запускается в монорепозитории и включает файлы из `apps/`, `modules/` и `packages/`. Эти файлы ожидаемо находятся вне несуществующего root `src`.
- **Воздействие:** `bun run typecheck` и `bun run lint` падают на `TS6059` до полноценной проверки типов. Локальный и CI quality gate не может подтвердить PR независимо от содержимого изменения.
- **Рекомендация:** разделить TypeScript configs по workspaces или сделать root config монорепозиторным: убрать/изменить `rootDir`, добавить явные `include`/`references`, и запускать workspace-specific config для `apps/api`.

## Низкая находка

### L1. `executeSwap` возвращает `provider_tx_id: null` после успешного provider execute

- **Issue:** [#75](https://github.com/xlabtg/FinLayer/issues/75)
- **Где:** `modules/swap/service.ts:421-464`, `modules/swap/service.ts:611-655`
- **Корневая причина:** после успешного `provider.executeSwap(...)` сервис записывает `executeResult.providerTxId` в БД, но response строится через `buildSwapTransaction(...)`, где `provider_tx_id` жёстко равен `null`.
- **Воздействие:** initial `POST /v1/swap/execute` response теряет provider tracking id. После refetch тот же swap уже содержит provider id, то есть API contract непоследователен.
- **Рекомендация:** передавать `executeResult.providerTxId` в `buildSwapTransaction` и покрыть response contract unit test.

## Проверенные области без нового issue

- Повторно проверены закрытые high-risk темы из первого аудита: API-key lookup, idempotency reservation до provider calls, swap webhook authentication, payment status transitions, payout row locking, CORS allow-list, graceful shutdown, analytics parameterization и SDK idempotency header support.
- Не создавались speculative issues без прямой воспроизводимой связи с текущим кодом. Например, post-provider local finalization failures в нескольких flows требуют отдельного design discussion по transaction/outbox pattern, но в текущем аудите не оформлялись как подтверждённый defect без минимального failure case.

## Рекомендуемый порядок исправлений

1. **Phase 1:** #66 и #67. Они блокируют fresh deployment и автоматическое payment settlement.
2. **Phase 2:** #68-#73. Это корректность provider correlation, earn/wallet runtime wiring и state-machine consistency.
3. **Phase 3:** #74-#76. Это analytics/contract/tooling debt, который не должен блокировать критические fixes, но нужен для достоверности продукта, SDK/API consistency и рабочих quality gates.
