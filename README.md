# Arduino Gate Control + Space Defender

Вебпанель для Arduino UNO зі шлагбаумом, ультразвуковим радаром, DHT11,
джойстиком, двома buzzer-ами та процедурною браузерною грою **Space Defender / «Космічний захисник»**.

## Що вміє проєкт

- керує шлагбаумом вручну або за показами HC-SR04;
- перетворює сервопривід і HC-SR04 на радар та показує кліматичну телеметрію;
- запускає повноцінний arcade survival shooter із keyboard, touch або фізичним
  Arduino-джойстиком;
- працює в demo mode без плати й у браузерах без Web Serial;
- зберігає профіль і результати offline-first та синхронізує їх між пристроями
  через акаунт Supabase Auth і Supabase PostgreSQL;
- відтворює музику через Passive Buzzer D3 або Web Audio, а короткі ефекти —
  через Active Buzzer D5.

Шлагбаум, радар і гра є взаємовиключними режимами пристрою. Прошивка та UI
зберігають старі Serial-команди, тому оновлення гри не змінює піни чи схему
підключення.

## Space Defender v2

Короткий цикл гри:

```text
підготовка → попередження → бій → перепочинок → покращення
           → складніша хвиля → бос/нагорода → результат → нова спроба
```

Реалізоване ядро містить:

- 3 режими: дев'ятихвильова `Expedition`, нескінченний `Survival` і чистий
  score-attack `Classic`;
- 3 складності: `Cadet`, `Pilot`, `Ace`;
- 9 процедурних секторів, 10 класів звичайних загроз і 3 багатофазних босів;
- 14 суперсил, які треба зібрати, екіпірувати та вчасно активувати;
- 12 stackable-покращень забігу й 12 довготривалих досягнень;
- combo, щит, енергію, телеграфовані атаки, перепочинки, гарантовані й
  одразу екіпіровані boss rewards,
  результат забігу й повідомлення про рекорд/досягнення;
- remappable keyboard controls, virtual touch joystick, окремі fire/power
  кнопки, screen shake toggle, volume controls і `prefers-reduced-motion`;
- паузу при втраті фокуса та безпечне «Продовжити» лише з checkpoint між
  хвилями. Середина бою навмисно не відновлюється;
- екран результату не дозволяє випадково піти або почати новий забіг, доки
  результат не записаний у локальну offline queue; у разі помилки є явний retry.
- recovery JSON не містить жодного credential; остаточна відмова від незаписаного
  результату потребує експорту й окремого підтвердження, а помилка очищення
  checkpoint блокує новий запуск замість прихованого відновлення старого стану;

Повний дизайн, числовий баланс, інваріанти й відомі межі описані в
[`GAME_DESIGN.md`](GAME_DESIGN.md). Канонічні числа живуть у
`app/game/balance.ts`, а стабільні ID — у `app/game/types.ts` і
`shared/gameStats.ts`.

## Активна архітектура

```text
src/main.tsx → app/page.tsx → app/GamePanel.tsx → app/game/*
                        │
                        ├─ Web Serial 115200 → public/arduino-smart-gate.ino
                        ├─ localStorage → profile/event queue/preferences/
                        │                 checkpoint/consent/auth-сесія
                        ├─ Supabase Auth /auth/v1 (PKCE) → єдина ідентичність
                        └─ /api/stats → Vercel Web Fetch Function
                                         └─ Postgres.js
                                            └─ Supavisor Transaction Pooler
                                               └─ Supabase PostgreSQL
```

Основні game-підсистеми винесені з React-компонента:

- `runtime.ts`, `waves.ts`, `rng.ts`, `balance.ts` — детермінована симуляція;
- `rendering.ts` — процедурний Canvas-рендер;
- `powerUps.ts`, `achievements.ts` — progression у забігу й між забігами;
- `input.ts`, `audio.ts`, `useGameAudio.ts` — усі контролери та звук;
- `persistence.ts`, `resume.ts`, `statsAdapter.ts` — checkpoint і статистика;
- `GameMenu.tsx`, `GameHud.tsx`, `GameOverlays.tsx`, `ProgressPanels.tsx` — UI.

Next.js, Cloudflare worker, D1, Drizzle і vinext-файли лишаються опціональним
legacy/scaffolding. Production frontend — React 19 + Vite, output — `dist/`.

## Локальний запуск

Потрібен Node.js `>=22.13.0`.

```bash
npm ci
npm run dev
```

`npm run dev` запускає лише Vite. Для frontend і `api/stats.ts` разом потрібні
локальні Vercel environment variables та:

```bash
npx vercel dev
```

Не вставляй database URL або інші секрети в команду, якщо shell history може їх
зберегти. Використовуй `.env.local`/Vercel CLI environment store; ці файли не
можна комітити.

## Профіль, offline-first і синхронізація

- профіль існує лише разом з акаунтом Supabase Auth: власний або локалізований
  випадковий нік прив'язується до auth-користувача у приватній таблиці
  `game_account_links`;
- 20-символьний access code скасовано. Сервер його не приймає, не генерує й не
  повертає, а запит із полем `accessCode` отримує 400 `ACCESS_CODE_RETIRED`;
- активне сховище статистики — `arduino-gate-game-stats:v3`: сховище кількох
  профілів з активним профілем; валідні v2 та v1 дані мігрують один раз без
  втрати старого коду, pending rename або pending runs, а старі ключі ніколи не
  видаляються й не перезаписуються;
- старий профіль, який має код і не має `authUserId`, стає **orphaned**: він
  назавжди лишається у сховищі, статистику видно, чергу подій збережено, але
  синхронізація нічого не відправляє й показує код `code_login_retired`. Його
  totals не переносяться в новий акаунтний профіль, бо немає credential, яким
  можна довести право власності;
- кожен профіль має незмінний `checkpointOwnerId`: він створюється один раз і
  ніколи не переобчислюється з серверних даних, тому старі checkpoint-и
  переживають і прив'язку акаунта, і rollback коду;
- checkpoint зберігається окремо для кожного власника:
  `arduino-gate-space-defender-run:v2:<checkpointOwnerId>`, а безсуфіксний
  `arduino-gate-space-defender-run:v2` лишається legacy-слотом (працює до
  міграції й після rollback). Legacy-слот переноситься у власний ключ лише тим
  профілем, який у ньому названий; чужий checkpoint не читається й не
  видаляється;
- профіль, прийнятий через акаунт, додатково зберігає `authUserId` — auth-user,
  для якого його адоптували. Це не credential: воно потрібне, щоб bearer-sync не
  відправив чергу одного акаунта сесією іншого після повторного входу;
- під час deploy зі зміною версії сховища можлива змішана ситуація: стара
  вкладка й далі пише у ключ `:v2`, а новий build читає його лише один раз під
  час міграції. Такі результати не втрачаються (старі ключі ніколи не
  видаляються), але з'являться тільки після перезавантаження тієї вкладки —
  після deploy перезавантаж усі відкриті вкладки;
- завершення спершу оптимістично записується локально як `run.completed` v2,
  потім відправляється чергою пакетами до п'яти подій; кожен такий запит іде
  тільки з bearer-токеном акаунта;
- `eventId === runId`; однакова повторна подія є idempotent, а повторне
  використання ID з іншим payload відхиляється;
- у базі синхронізуються базові totals, режим/складність, бойові метрики,
  power statistics, achievements, unlocks і рекорди;
- volumes, shake, reduced-motion override і remapped keys у поточному UI є
  device-local. API/SQL уже мають revisioned settings contract, але клієнтське
  cross-device settings sync ще не підключене;
- «Забути профіль» видаляє лише локальну копію й приховується, поки є
  несинхронізований результат. Воно ніколи не видаляє remote profile.

Таблиця лідерів показує top 25 профілів із `games_played > 0`. Порожній рейтинг
не доводить, що `game_players` порожня.

## Акаунт (Supabase Auth) — єдиний спосіб мати профіль

Акаунт Supabase Auth (email+пароль, за бажанням passkey або Google) — тепер
єдина ідентичність. Нік лишається єдиним публічним ім'ям, email ніде не
показується.

- акаунт і профіль зв'язані строго 1:1 у приватній таблиці
  `game_account_links`; сервер ніколи не зливає і не перепризначає профілі.
  Повторний `create` для того самого акаунта повертає той самий профіль
  (idempotent 200), бо клієнт повторює його при нестабільній мережі;
- вхід потрібен, щоб мати профіль, а профіль потрібен, щоб почати забіг. Demo
  mode, панель шлагбаума й радар працюють зовсім без акаунта;
- перший вхід у цьому браузері потребує мережі. Далі сесія лежить у
  localStorage, тому гравець, який уже входив, може грати offline — забіги стають
  у чергу й синхронізуються після відновлення зв'язку;
- повністю без cookies: consent-вибір і auth-сесія живуть у localStorage;
  Google/Apple ставлять cookies лише на власних доменах під час входу;
- публічний publishable key вже закомічено в `app/auth/supabaseConfig.ts`, тому
  `authAvailable === true` і акаунтний UI активний. Email+пароль і підтвердження
  email, Google і passkeys — усі увімкнені в живому проєкті (станом на
  2026-08-22);
- graceful degradation лишається обов'язковою, бо той самий build працює і з
  проєктами, де провайдер вимкнений: якщо виклик OAuth завершується помилкою, UI
  показує спокійне пояснення, а не сирий текст помилки;
- passkeys реалізовані в клієнті й не коштують нічого додатково; тумблер
  **Authentication → Passkeys** у живому проєкті увімкнений. Там, де його немає,
  кожен виклик повертає `passkey_disabled`, і UI просто пропонує email+пароль.
  Supabase позначає цей API як експериментальний, тому клієнт вмикає його явно
  через `auth.experimental.passkey`;
- **зміна Relying Party ID пізніше знецінює всі наявні passkeys** — гравцям
  доведеться реєструвати їх заново. RP ID — це чистий production-домен без
  схеми, порту й шляху;
- вбудований Supabase SMTP доставляє листи (підтвердження, скидання пароля)
  лише учасникам команди проєкту, доки не налаштовано custom SMTP;
- Apple sign-in вимкнено за замовчуванням: він потребує платної Apple
  Developer Program, а client secret треба перевипускати приблизно кожні
  6 місяців.

Коди помилок credential-шляху: `ACCESS_CODE_RETIRED` (400),
`AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`,
`AUTH_SESSION_REVOKED` (401), `AUTH_KEYS_UNAVAILABLE` (503) і
`AUTH_NOT_LINKED` (404) — останній означає «акаунт валідний, профілю ще немає»,
і клієнт відповідає на нього викликом `create`.

Дії `connect`, `link` і `unlink` прибрані разом із кодом доступу й повертають
400 `INVALID_ACTION`. Разом з ними зникли коди `MIXED_CREDENTIALS`,
`PROFILE_ACCOUNT_CONFLICT` і `ACCOUNT_PROFILE_CONFLICT`.

## Supabase і Vercel

Повний runbook: [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md).

Міграції ручні й виконуються **до** deployment відповідного API:

1. `db/migrations/0001_game_stats.sql`;
2. `db/migrations/0002_game_progression.sql`;
3. `db/migrations/0003_base_table_grants.sql` — лише `REVOKE`, без нових
   об'єктів, тому порядок для нього не критичний;
4. `db/migrations/0004_account_links.sql` — additive `public_id`, приватна
   1:1 таблиця `game_account_links` і розширений allowlist rate-limit
   buckets. **Застосована в production 2026-08-04.**
5. `db/migrations/0005_account_only_identity.sql` — скасування коду доступу:
   `access_code_hash` стає NULLABLE (колонку навмисно **не** видалено, щоб
   rollback коду до `0004`-API залишався можливим), додається
   `game_players_reachable_check`
   (`access_code_hash IS NOT NULL OR profile_schema_version >= 3`), діапазон
   `profile_schema_version` розширено до 1–3, а counters `profile_record` і
   `profile_rename` очищено, бо їхні HMAC-scopes перейшли з digest коду на
   auth-користувача. Жоден профіль чи run не видаляється.
   **Застосована в production 2026-08-04.**

`0005` треба застосувати **до** deploy account-only API: цей API вставляє
профілі без digest і не пройшов би старий `NOT NULL`.

Для вже налаштованої v1 production-бази виконай відсутні `0002`—`0005`.
Запасного шляху для бази без `0002` більше немає: account-only профіль
потребує `profile_schema_version = 3` (колонка з `0002`), тому без v2-таблиць
працює лише GET leaderboard — `create` і `sync` повертають
`SCHEMA_MIGRATION_REQUIRED`, а `session`, `rename` і `record` — `AUTH_NOT_LINKED`.
Браузер не втрачає run, а тримає його в offline queue. Для `0004` і `0005`
запасного шляху теж немає:
без них account-only API не знайде профіль і не зможе його створити. `0002`
зберігає старі дані та backfill-ить чотири досягнення, які можна довести з v1
totals; точні старі дати й детальні бойові факти відновити неможливо. DDL під
час API-запиту не виконується.

Vercel потребує серверні secrets:

- `SUPABASE_DATABASE_URL` — Supavisor **Transaction pooler** URI, порт `6543`;
- `RATE_LIMIT_SECRET` — окремий випадковий HMAC-secret, бажано ≥32 символів.

Postgres.js використовує TLS, одну connection на теплий instance і
`prepare: false`, що сумісно з transaction pooling. Не додавай префікс `VITE_`
до secrets. Всі таблиці мають RLS deny-by-default і не мають публічних grants/policies:
`0002` робить `REVOKE` для v2 таблиць, `0003` — для трьох базових, `0004` — для
`game_account_links`; `0005` не створює об'єктів, тому нових grants не потребує.
Браузер працює тільки через `/api/stats`; для auth (включно з WebAuthn-церемонією
passkey) він додатково звертається напряму лише до Supabase Auth (`/auth/v1`).

Rate limits у фіксованому одногодинному вікні: 600 mutation events з IP
(`ip_write`), 30 create з IP (`ip_create`), 240 completed runs, 30 rename, 300
total v2 sync events на профіль і 10 акаунтних операцій на auth-акаунт
(`account_link`). `create` списує `ip_create` + `account_link`;
`rename`/`record`/`sync` списують `ip_write` плюс свій `profile_*` bucket. Назви
buckets не змінилися (тому нової міграції не треба), змінився scope: усе, що було
`profile:<accessCodeHash>`, тепер `account:<userId>`. Batch списує counters за
кожну подію. Ні raw IP, ні raw auth user id у БД не потрапляють: scope спочатку
HMAC-псевдонімізується.

Leaderboard є дружнім, а не tournament-grade: сервер перевіряє формат,
діапазони й rate limits, але браузерний run не має криптографічного доказу.

## Перевірки

```bash
npm run lint
npm run typecheck
npm test
npm run check
npm audit --omit=dev
git diff --check
```

Автотести покривають deterministic waves/enemies, power cooldown, achievements,
checkpoint migration, stats storage v1/v2→v3, credential matrix, API
validation/idempotency, SQL контракти, Arduino protocol, translation parity та
форму Vercel Web Fetch export. Вони не доводять фізичний Web Serial timing,
реальний Supabase deploy, WebAuthn-церемонію passkey або UI у конкретному
браузері — ці перевірки виконуються окремо й не мають вважатися пройденими без
фактичного тесту.

## Arduino

Прошивка: `public/arduino-smart-gate.ino`. Схема, безпека та повний протокол:
[`public/README-UK.md`](public/README-UK.md).

Старі `SFX:SHOT|SCORE|CRASH|OVER` збережені. Додані короткі non-blocking ефекти
`POWER`, `SHIELD`, `BOSS`, `WARN`, `ACH`, `LASER`, `MISSILE`, `EMP`, `RECORD`,
`LOW` і `MENU`; patterns виконуються через `millis()`, без довгих `delay`. Командний
буфер приймає не більше 40 символів.

Перед переставлянням дротів від'єднай USB. Не подавай 9 V на 5 V, D2–D7,
датчики, джойстик, сервопривід або buzzer-и.

## Rollback

Точка перед Space Defender v2:

- tag `pre-space-defender-overhaul-20260801`;
- branch `backup/pre-space-defender-overhaul-20260801`;
- commit `7764d15f89d7cb0581ee72216498ed3b541ec278`.

Для shared `main` використовуй новий `git revert`, а не переписування історії.
Не видаляй additive v2 таблиці під час code rollback: вони можуть уже містити
користувацькі дані й idempotency ledger.

`0004` і `0005` теж мають лишатися застосованими під час code rollback. `0005`
навмисно не видаляє `access_code_hash`, а лише знімає з неї `NOT NULL`, тому
старіший `0004`-API, який ще читає й пише digest, працює далі. Небезпечний
напрямок — відкат самої міграції: акаунтні профілі мають NULL у цій колонці й
порушили б відновлений `NOT NULL`.
