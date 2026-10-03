# Аудит — стан і результати

Дата: 2026-10-03. Зміни відновлено після зупинок без скидання робочого дерева.
Production міграція 0006 застосована та перевірена; код у main, GitHub і онлайн.
Основний коміт `8adabf6`, фінальна правка контрасту `07b25db`; обидва Vercel
production deployments успішні. Робоче дерево перевірене після відновлення.
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
| 7. Кнопки | Готово | Secondary на темних поверхнях, source controls, danger/disabled/focus, music select 44px; реальний огляд mobile/desktop. Фінальний онлайн-огляд також виявив і виправив контраст legacy notice у темному рейтингу. |
| 8. Arduino/демо | Готово | Launch provenance, checkpoint, v4 store, UI/API/SQL; старі події тільки legacy, старі canonical hashes збережено. |
| 9. Responsive | Готово у браузерних viewport | 390×844, 844×390, 820×1180, 1366×768; overflow/overlay/actions перевірено. Фізична екранна клавіатура й safe-area iPhone залишаються неперевіреними. |
| 10. Музика | Готово | auto/off/7 наявних композицій, локальне збереження, браузер/Arduino routing, uk/de/en. |
| 11. Sync | Готово | Виправлено два підтверджені збої, повторні ack, offline queue, source isolation, v3→v4 bridge та immutable retry payload. Живий API/БД тест пройшов. |
| 12. Supabase | Готово | Безкоштовний test project, 0001–0006; перевірка production, 0006, RLS/grants/functions/advisors. Наявний WARN: leaked-password protection вимкнена; платну Pro-опцію не активували. |
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
- Production після deploy: локальний consent, деморежим, збереження Щедрика
  після reload, усі три джерела рейтингу, пояснення legacy, uk/de/en.
- Production viewport 390×844, 844×390, 820×1180, 1366×768: horizontal overflow
  відсутній; селектор музики й source кнопки мають висоту 44px. Фінальний
  контраст legacy notice перевірено на mobile/desktop після `07b25db`.
- Скриншот production збережений локально в gitignored
  `outputs/production-audit-20261003.jpg`; тимчасові viewport overrides скинуто.
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
  не переводили на платний тариф: [захист від скомпрометованих паролів доступний
  на Pro і вище](https://supabase.com/docs/guides/auth/password-security).
- Новий production API: GET200 із `sources.demo/arduino/legacy`,
  {}400 INVALID_ACTION, connect400 INVALID_ACTION, bearerless session401
  AUTH_TOKEN_MISSING, retired-code400 ACCESS_CODE_RETIRED. Тестові профілі чи
  забіги у production не створювали.
- Основний код: `8adabf67b72dc5900b691f3722a4ee1cad25d7b1`.
  [Vercel production success](https://vercel.com/illgnap/arduino-gate-game/53jYAxKZqg4EoEj1ojjSnfbsSsaw).
- Фінальна CSS-правка: `07b25db93902ed42623b5e29380f79ab1d09d7f6`.
  [Vercel production success](https://vercel.com/illgnap/arduino-gate-game/DZUYp43tQAuUwWFNEtCeVGsiGqyy),
  GitHub deployment 6829173949, 2026-10-03T15:01:18Z.
- На [онлайн-сайті](https://arduino-gate-game.vercel.app) JS
  `index-CN6P4328.js` і CSS `index-CGK3TQF9.css` після `07b25db` байт у байт
  збіглися з локальною production збіркою. Це перевірка артефактів і безпечних
  API probes, а не production write E2E.
- Обидва code commits відправлені прямо в main за дозволом користувача,
  без переписування історії; HEAD та origin/main синхронні.

## Змінені файли

47 файлів від `c1399f2` до фінального code commit; залежності й firmware
не змінювали. Єдина нова production міграція — `0006_statistics_sources.sql`.

```text
AGENTS.md
ARCHITECTURE.md
AUDIT_PROGRESS.md
GAME_DESIGN.md
README.md
SUPABASE_SETUP.md
api/stats.ts
app/AccountPanel.tsx
app/GamePanel.tsx
app/PlayerStatsPanel.tsx
app/auth/client.ts
app/auth/errors.ts
app/auth/useAuthSession.ts
app/game/GameMenu.tsx
app/game/GameOverlays.tsx
app/game/audio.ts
app/game/balance.ts
app/game/controllerNavigation.ts
app/game/input.ts
app/game/persistence.ts
app/game/preferences.ts
app/game/resume.ts
app/game/runtime.ts
app/game/statsAdapter.ts
app/game/useControllerNavigation.ts
app/game/useGameAudio.ts
app/game/waves.ts
app/globals.css
app/i18n.ts
app/page.tsx
app/useGameStats.ts
db/migrations/0006_statistics_sources.sql
scripts/test-support/pglite-postgres.mjs
scripts/verify-statistics-db.mjs
shared/gameStats.ts
tests/auth-client.test.mjs
tests/auth-runtime.test.mjs
tests/game-controller-navigation.test.mjs
tests/game-engine.test.mjs
tests/game-input.test.mjs
tests/game-panel-lifecycle.test.mjs
tests/game-preferences.test.mjs
tests/game-resume.test.mjs
tests/game-stats-sources.test.mjs
tests/game-stats-storage.test.mjs
tests/rendered-html.test.mjs
tests/stats-sql-builder.test.mjs
```

## Зовнішні межі

Apple: потрібні Apple Developer Team/Services ID, signing key і client secret
у Dashboard, redirect URL зі SUPABASE_SETUP, потім APPLE_ENABLED=true; користувач
не хоче платних опцій, тому не купували Developer Program. Email-доставка
потребує налаштованого SMTP; без нього built-in Supabase SMTP обмежує одержувачів
учасниками команди. Google OAuth і WebAuthn лишаються для реального user/device
flow. Не заявляємо ці сценарії пройденими.

## Стан релізу

Код, перевірена міграція, main push та онлайн-перевірка виконані. Прогрес
збережено в цьому звіті; зовнішні межі наведено вище. Для rollback використовувати
новий `git revert`, не скидати Git або локальне сховище й не видаляти additive
міграцію 0006. Старі localStorage v1/v2/v3 залишені як read-only fallback.
