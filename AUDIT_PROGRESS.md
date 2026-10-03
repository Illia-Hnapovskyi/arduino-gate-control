# Аудит — стан і результати

Дата: 2026-10-03. Зміни відновлено після зупинок без скидання робочого дерева.
Production міграція 0006 застосована та перевірена; код готовий до commit/push.
Дозвіл користувача: main → GitHub → перевірка онлайн; тільки безкоштовні сервіси.

## Статус 13 пунктів

| Пункт | Стан | Реально виконано / межа перевірки |
| --- | --- | --- |
| 1. Auth | Частково | PKCE, локалізація, consent, timeout, session/passkey races виправлено. Реальні password logins, refresh, local/global sign-out пройшли в тестовому Supabase. Apple підготовлений, але вимкнений без Developer credentials; Google/WebAuthn і доставку email не проходили наживо. |
| 2. Fullscreen | Готово в коді | Збережено 900×540, CSS overlay/iPhone fallback і вихід; браузерні viewport перевірки пройшли. Фізичних iPhone/Android не використовували. |
| 3. Джойстик UI | Готово в коді | Меню, вкладки, slider/select, upgrade, pause/back/result; видимий focus, SW release guard. Перевірено синтетичною телеметрією, без фізичної плати. |
| 4. Досягнення | Готово | Вбудований grid результату, responsive та overlay stacking перевірено в браузері. |
| 5. Головне меню | Готово | Result-кнопка вже існувала — дубль не додано. Додано лише відсутню дію паузи; локальний save перед виходом, блокування при помилці. |
| 6. Вороги | Готово | Детермінований budget ×1.1, без зміни physics/часу/HP; тести й документація узгоджені. |
| 7. Кнопки | Готово | Secondary на темних поверхнях, source controls, danger/disabled/focus, music select 44px; реальний огляд mobile/desktop. |
| 8. Arduino/демо | Готово | Launch provenance, checkpoint, v4 store, UI/API/SQL; старі події тільки legacy, старі canonical hashes збережено. |
| 9. Responsive | Готово у браузерних viewport | 390×844, 844×390, 820×1180, 1366×768; overflow/overlay/actions перевірено. Фізична екранна клавіатура й safe-area iPhone залишаються неперевіреними. |
| 10. Музика | Готово | auto/off/7 наявних композицій, локальне збереження, браузер/Arduino routing, uk/de/en. |
| 11. Sync | Готово | Виправлено два підтверджені збої, повторні ack, offline queue, source isolation, v3→v4 bridge та immutable retry payload. Живий API/БД тест пройшов. |
| 12. Supabase | Готово | Безкоштовний test project, 0001–0006; перевірка production, 0006, RLS/grants/functions/advisors. Збережений WARN leaked-password protection вимкнено. |
| 13. Архітектура | Готово | ARCHITECTURE.md зі схемою, README, AGENTS, GAME_DESIGN, SUPABASE_SETUP. |

## Причини sync error

1. Browser `postProfile()` відкидав `results` успішного sync. `postSync()` потім
   повідомляв `invalid_response`, хоча сервер уже застосував run. Декодер тепер
   перевіряє кожний event ID/status; applied або duplicate спорожняє лише
   підтверджені події, а помилка leaderboard не змінює стан запису профілю.
2. Живий тест 2026-10-03 знайшов три некоректні bulk INSERT-и power/sector facts.
   `sql(rows, columns)` стояв після явного списку колонок; Postgres.js обирав
   identifier builder та падав із TypeError до SQL. Helper тепер стоїть одразу
   після назви таблиці. PGlite adapter використовує справжній serializer
   Postgres.js; три regression тести виконують tags із compiled handler.

Plain Vite також не запускає `/api/stats`; HTML fallback тепер має окрему
локалізовану помилку. Production API працює; це не є причиною кожної помилки.

## Збереження локальних даних

- Новий ключ `arduino-gate-game-stats:v4`; v3/v2/v1 не видаляються й не пишуться.
- Окремий ключ захищає provenance нових events від sanitizer старої вкладки.
- Пізні v3 offline events імпортуються один раз, зі збереженням canonical JSON,
  власника й checkpointOwnerId. Import receipts переживають window 100 IDs та
  локальний forget; ack-нута стара черга не воскресає. v1/v2 — initial fallback.
- Забіг після невдалого local save має незмінний timestamp/payload при retry та
  recovery export. Меню/restart блокується до збереження.
- Мігрували legacy access codes losslessly, але orphaned профілі не надсилаються
  та не приписуються новому акаунту. Нічого не очищали для «ремонту» sync.

## Перевірки

- `npm ci` успішно виконаний при відновленні, 531 пакет; lockfile не змінено.
- Фінальний `npm run check`: lint, typecheck, Vite/API builds, **220/220 tests**.
- `npm audit --omit=dev`: **0 vulnerabilities**. `git diff --check`: чисто.
- PGlite з реальним Postgres.js builder: **45/45** assertions — 0001–0006,
  історичний backfill, API/client ack, response loss, sources, duplicate/conflict,
  RLS/grants, revoked session, migration rerun. Це ізольований PostgreSQL WASM.
- Live Supabase: **30/30** assertions — два password logins, codeless account
  profile/create retry, другий клієнт/session, три джерела, applied/duplicate/
  EVENT_ID_REUSED, powers, rename/leaderboard, invalid/retired/removed actions,
  grants, refresh, settings duplicate/conflict, HTTP429/Retry-After, local/global
  sign-out. Створено підтвердженого throwaway auth-user через admin API; це не
  перевірка публічного signup чи email-доставки.
- Live harness виконував compiled Vercel handler у Supabase Edge. Тільки в
  тимчасовій копії змінено issuer на test project, env access для Deno і
  перетворення ES256 P1363→DER через відмінність Deno node:crypto. Production
  JWT verifier не змінювали. Окремо **2/2** Node assertions: справжній Supabase
  JWT пройшов оригінальний verifier (override тільки issuer), зіпсований підпис
  відхилено. Це не твердження про write E2E у Vercel production.
- Throwaway профілі/runs/auth users видалено, count=0; тимчасовий Edge endpoint
  `audit-stats` замінений на HTTP410, JWT requirement збережено. Секрети не
  потрапили в Git або результати тесту.

## Браузер

- Локальний fixture зі синтетичними account/API/Arduino: чотири viewport,
  видимі меню/result/pause/upgrade, виправлена mobile stacking проблема;
  SW navigation, double-SW pause, музика та source selectors.
- Результат уже мав menu button у HEAD і у браузері; додано тільки pause action.
- Після останньої CSS правки селектор music: 332×44 на 390px і 463×44 на desktop,
  без horizontal page overflow. Ode to Joy зберігся після reload.
- Справжній локальний app: consent/account UI й localized empty-email validation.
- Фізичні Arduino/Web Serial/iPhone/touch/WebAuthn та provider OAuth не перевірені.

## Supabase / release

- Безкоштовний `arduino-gate-game-test` (`okbtookkqiuvdoeqsphu`) створено
  2026-09-29 в **Illia-Hnapovskyi**, get_cost=0/month, EU-central-1,
  ACTIVE_HEALTHY. Застосовані 0001–0006. Платних опцій не вмикали.
- Production `vullhduhswcnlpgnlrtp`: до 0006 було 13 game tables; 2026-10-03
  перед міграцією 1 профіль, 0 runs/events. Після 0006 — 17 tables, усі RLS,
  0 policies, 0 CRUD grants для anon/authenticated/service_role, 0 unsafe source
  trigger functions. Fingerprints 11 старих таблиць і кількість рядків незмінні.
  Read-only контрольні fingerprints у gitignored db/backups, без export PII.
- Advisors: очікуваний INFO RLS без policies (private API-only); INFO unused
  indexes; наявний WARN leaked password protection disabled. Security settings
  без узгодження платного тарифу не змінювали.
- Старий production API після міграції: GET200, {}400 INVALID_ACTION,
  connect400, bearerless session401, retired-code400. Новий deploy ще попереду.
- Гілка main, origin GitHub; до commit HEAD=origin/main=c1399f2. Код аудиту
  поки незакомічений. Дозвіл користувача на main commit/push/deploy чинний.

## Зовнішні межі

Apple: потрібні Apple Developer Team/Services ID, signing key і client secret
у Dashboard, redirect URL зі SUPABASE_SETUP, потім APPLE_ENABLED=true; користувач
не хоче платних опцій, тому не купували Developer Program. Email-доставка
потребує налаштованого SMTP; без нього built-in Supabase SMTP обмежує одержувачів
учасниками команди. Google OAuth і WebAuthn лишаються для реального user/device
flow. Не заявляємо ці сценарії пройденими.

## Що лишилося в цьому релізі

1. Final diff/secret check, commit main і push.
2. Дочекатися Vercel success; перевірити live asset hashes і safe API probes.
3. Відкрити production у браузері, перевірити ключові UI і локалізацію.
4. Записати точний commit/deploy outcome.
