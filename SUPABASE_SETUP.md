# Підключення Supabase до Arduino Gate / Space Defender

Цей runbook налаштовує спільну PostgreSQL-базу для профілів, результатів,
довготривалої progression, досягнень і leaderboard. До бази браузер не
підключається напряму: всі запити статистики проходять через Vercel Function
`/api/stats`. Напряму до Supabase він звертається лише за автентифікацією
(`/auth/v1`).

## Що знадобиться

- акаунт і проєкт у [Supabase Dashboard](https://supabase.com/dashboard);
- Vercel-проєкт, пов'язаний із цим репозиторієм;
- доступ до Vercel Environment Variables і redeploy;
- для повної integration-перевірки — окремий disposable Supabase project.

Активний backend використовує Postgres.js і пряме серверне підключення через
Supavisor Transaction Pooler; для нього publishable/anon і service-role keys
не потрібні. Акаунтам (Supabase Auth) потрібен лише **публічний** publishable
key, і він **уже закомічений** у `app/auth/supabaseConfig.ts` — це публічне
значення. Ніколи не додавай database URL, пароль, `RATE_LIMIT_SECRET`,
service-role/secret key або дані користувачів у Git, логи, скриншоти чи чат.

Акаунт Supabase Auth — єдиний спосіб мати профіль. 20-символьний access code
скасовано: сервер його не приймає, не генерує й не повертає, а запит із полем
`accessCode` отримує 400 `ACCESS_CODE_RETIRED`. Історичні SHA-256 digest-и
лишаються в колонці `game_players.access_code_hash`: після відмови від кодів це
вже не робочий credential, але логувати їх усе одно не треба.

`db/backups/` ігнорується Git (репозиторій публічний) і містить експорт
`2026-08-04-pre-account-only.json`, зроблений перед переходом на account-only.
Ніколи не додавай його в Git.

## 1. Створи Supabase-проєкт

1. Відкрий Dashboard і натисни **New project**.
2. Вибери регіон поблизу Vercel deployment.
3. Створи надійний пароль бази та збережи його в password manager.
4. Дочекайся повної готовності проєкту.

Якщо пароль скинуто, у Vercel потрібно замінити **весь**
`SUPABASE_DATABASE_URL` і зробити redeploy. Спеціальні символи пароля в URI
мають бути percent-encoded.

## 2. Застосуй міграції у правильному порядку

DDL ніколи не виконується під час API-запиту. Схему треба підготувати до deploy.

### Нова порожня база

У Supabase **SQL Editor** послідовно виконай повний вміст:

1. [`db/migrations/0001_game_stats.sql`](db/migrations/0001_game_stats.sql);
2. [`db/migrations/0002_game_progression.sql`](db/migrations/0002_game_progression.sql);
3. [`db/migrations/0003_base_table_grants.sql`](db/migrations/0003_base_table_grants.sql);
4. [`db/migrations/0004_account_links.sql`](db/migrations/0004_account_links.sql);
5. [`db/migrations/0005_account_only_identity.sql`](db/migrations/0005_account_only_identity.sql).

Не об'єднуй і не міняй їх місцями. Після кожного файлу дочекайся успішного
завершення перед переходом далі.

`0004` — additive: додає `game_players.public_id`, приватну 1:1 таблицю
`game_account_links` для зв'язку профіль↔auth-акаунт і розширює allowlist
rate-limit buckets до семи значень. Вона має бути застосована **до** deploy
API з account-linking. **У production цю міграцію застосовано 2026-08-04.**

`0005` скасовує access code і має бути застосована **до** deploy account-only
API: той API вставляє профілі без digest і не пройшов би старий `NOT NULL`.
**У production цю міграцію застосовано 2026-08-04.** Що вона робить:

- знімає `NOT NULL` з `game_players.access_code_hash`. Колонку навмисно **не**
  видалено: видалення необоротне й зламало б rollback коду до `0004`-API, а
  UNIQUE-індекс лишається й далі захищає історичні digest-и, бо Postgres не
  застосовує UNIQUE до NULL;
- додає `game_players_reachable_check`
  (`access_code_hash IS NOT NULL OR profile_schema_version >= 3`) спочатку як
  `NOT VALID`, потім `VALIDATE`. Отже кожен account-only профіль **зобов'язаний**
  писатися з `profile_schema_version = 3` — саме це значення позначає профіль без
  коду;
- розширює діапазон `profile_schema_version` з `0002` до 1–3;
- видаляє counters `profile_record` і `profile_rename` з `game_rate_limits`: їхні
  HMAC-scopes перейшли з digest коду на auth-користувача й більше ніколи не
  будуть обчислені;
- не створює жодної таблиці й не видаляє жодного профілю чи run.

`0003` не створює й не змінює жодного об'єкта: він лише робить `REVOKE` для
базових таблиць з `0001`, які раніше трималися тільки на RLS. Його можна
застосувати в будь-який момент і повторно.

### База, де v1 статистика вже працює

Якщо `0001_game_stats.sql` раніше застосовано і наявні
`game_players`, `game_runs`, `game_rate_limits`, зроби backup та виконай
відсутні `0002`—`0005`. Міграція additive: вона не видаляє
профілі, старі runs або lifetime totals; додає колонки, ledger і progression
таблиці. Вона backfill-ить `first_run`, `score_10000`, `max_level` і
`veteran_10`, якщо їх можна довести з v1 aggregates, та створює відповідні
unlock rows. Для таких рядків `unlocked_at` є часом міграції, а не втраченою
історичною датою. Детальні enemy/boss/power/accuracy/controller milestones
неможливо чесно відновити без v2 run facts.

`0002`—`0005` запускаються у транзакції, беруть той самий advisory lock
і використовують короткі `lock_timeout`/`statement_timeout`; `0002` і `0005`
додають constraints явно. `IF NOT EXISTS` не
може виправити вже наявний несумісний об'єкт. Якщо міграція завершується
помилкою, не повторюй її навмання: зафіксуй SQLSTATE/назву constraint без
значень запиту та перевір фактичну схему.

### Що створюють міграції

| Таблиця | Призначення |
| --- | --- |
| `game_players` | Nickname/language, базові lifetime aggregates/revision, `public_id` і `profile_schema_version`. Після `0005` колонка `access_code_hash` — NULLABLE історичний digest: account-only профіль має тут NULL і `profile_schema_version = 3`. |
| `game_runs` | Один детальний результат на `(player_id, run_id)` і зв'язок із sync event. |
| `game_rate_limits` | HMAC-псевдонімізовані fixed-window counters. |
| `game_sync_events` | Постійний idempotency ledger: event type/version і SHA-256 canonical payload. |
| `game_run_power_stats` | Collected/activated counts power-ів для конкретного run. |
| `game_run_sector_stats` | Підсумки секторів конкретного run. |
| `game_player_totals` | Enemies, bosses, shots, combo, duration, wins, Arduino runs і accuracy. |
| `game_player_mode_stats` | Aggregates за mode+difficulty. |
| `game_player_power_stats` | Lifetime collected/activated counts для 14 power IDs. |
| `game_player_achievements` | Progress і перший `unlocked_at` для 12 stable achievement IDs. |
| `game_player_unlocks` | Нормалізований журнал відкритих можливостей/нагород. |
| `game_player_settings` | Revisioned volume/motion settings contract. |
| `game_account_links` | Приватний 1:1 зв'язок профіль↔Supabase Auth user: `player_id` PRIMARY KEY, `auth_user_id` UNIQUE, обидва FK з `ON DELETE CASCADE`. Видалення auth-користувача прибирає лише зв'язок, не профіль. |

Серверний ledger не обрізається до 512 runs: retained event ID забезпечує
довготривалу ідемпотентність. Для великого обсягу спочатку спроєктуй безпечну
архівацію, яка не дозволить повторно застосувати стару подію.

### Read-only перевірка схеми

У SQL Editor можна виконати безпечну перевірку без читання user rows:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name like 'game_%'
order by table_name;

select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname like 'game_%'
order by c.relname;

select tablename, policyname
from pg_policies
where schemaname = 'public'
  and tablename like 'game_%';

select c.relname as table_name, r.rolname as role_name, p.privilege
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(privilege)
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname like 'game_%'
  and has_table_privilege(r.rolname, c.oid, p.privilege)
order by c.relname, r.rolname, p.privilege;
```

Очікується 13 таблиць (12 після `0002`/`0003`, плюс `game_account_links`
після `0004`), `rls_enabled = true` для кожної та відсутність public
policies. Останній запит має вернути **нуль рядків після застосування `0003`**;
до нього три базові таблиці з `0001` ще мають Data API grants. Він свідомо
використовує `has_table_privilege`, а не `information_schema.role_table_grants`:
той view показує лише grants, видані поточно доступними ролями, і може дати
хибне «все чисто».

Data API grants і RLS — різні захисні рівні: `0002` робить `REVOKE` для нових
таблиць/sequence, `0003` — для трьох базових, `0004` — для `game_account_links`.
`0005` не створює об'єктів, тому нічого не потребує. Ці міграції знімають права
станом на момент виконання; вони **не** змінюють `ALTER DEFAULT PRIVILEGES`, тому
будь-яка майбутня таблиця в `public` знову отримає grants і потребуватиме
власного `REVOKE`. Не додавай grants або policies без окремого security review.

Швидка однорядкова перевірка стану схеми:

```sql
select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name like 'game_%')  as tables_found,
  (to_regclass('public.game_sync_events') is not null)            as migration_0002_applied,
  (to_regclass('public.game_account_links') is not null)          as migration_0004_applied,
  (select exists (select 1 from pg_constraint
     where conname = 'game_players_reachable_check'
       and conrelid = 'public.game_players'::regclass
       and convalidated))                                         as migration_0005_applied,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename like 'game_%')      as public_policies,
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname like 'game_%' and not c.relrowsecurity)       as tables_without_rls;
```

Здоровий стан після `0005`: `13 | true | true | true | 0 | 0`. Якщо
`migration_0002_applied = false`, то працює лише GET leaderboard: `create` і
`sync` повертають `503 SCHEMA_MIGRATION_REQUIRED`, а `session`, `rename` і
`record` — `404 AUTH_NOT_LINKED`, бо без `profile_schema_version` account-only
профіль неможливо створити. Браузери накопичують завершені забіги в
offline-черзі — дані не втрачені, але жодна дія з профілем не проходить.
Якщо `migration_0004_applied` або `migration_0005_applied` дорівнює `false`,
account-only API не запрацює зовсім: він шукає профіль через
`game_account_links` і вставляє його без digest.

## 3. Скопіюй Transaction Pooler URI

1. У Supabase натисни **Connect**.
2. Обери **URI** → **Transaction pooler / Supavisor**.
3. Переконайся, що URI використовує порт `6543`, не direct/session `5432`.
4. Підстав database password, якщо Dashboard цього не зробив.

Формат приблизно такий:

```text
postgres://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

Transaction mode підходить коротким serverless-транзакціям, але named prepared
statements прив'язані до фізичного connection. Тому `api/stats.ts` використовує
`prepare: false`, TLS, максимум одну connection на теплий Vercel instance,
connect timeout 5 с та idle timeout 20 с. Не прибирай ці параметри без окремого
pooling review.

Офіційна довідка:
[Supabase: Connect to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
і [Postgres.js](https://supabase.com/docs/guides/database/postgres-js).

## 4. Додай server-only secrets у Vercel

Vercel → Project → **Settings** → **Environment Variables**:

| Name | Value | Environments |
| --- | --- | --- |
| `SUPABASE_DATABASE_URL` | Transaction Pooler URI з кроку 3 | Production; за потреби Preview/Development |
| `RATE_LIMIT_SECRET` | незалежний випадковий HMAC-secret, бажано ≥32 символів | ті самі environments |

Згенерувати `RATE_LIMIT_SECRET` локально можна так:

```bash
openssl rand -hex 32
```

- не додавай префікс `VITE_`: Vite вбудовує такі значення в public bundle;
- якщо `RATE_LIMIT_SECRET` відсутній, API використовує database URL як fallback
  HMAC key, але окремий secret спрощує ротацію;
- зміна environment variables потребує нового deployment.

## 5. Безпечний порядок production deployment

1. Зроби backup або підтвердь доступну point-in-time recovery.
2. Застосуй відсутні міграції: `0001` → `0002` → `0003` → `0004` → `0005`.
3. Виконай read-only перевірку схеми/RLS/grants.
4. Deploy account-only API/frontend лише після підтверджених `0004` і `0005`.
5. Виконай безпечні probes нижче.
6. Перевір Vercel runtime logs без виведення secrets або request payloads.

Якщо frontend/API уже розгорнуто раніше, сервер read-only перевіряє наявність
v2 schema. Аварійної сумісності з базою без `0002` більше немає: account-only
профіль визначається `profile_schema_version = 3` (колонка з `0002`) плюс рядком
у `game_account_links`, тому без v2-таблиць профіль неможливо ні створити, ні
знайти. Без `0002` працює лише GET leaderboard; `create` і `sync` повертають
HTTP 503 `SCHEMA_MIGRATION_REQUIRED`, а `session`, `rename` і `record` —
HTTP 404 `AUTH_NOT_LINKED`. Браузер залишає v2 events у локальній черзі й
повторює їх після міграції, тому дані не втрачаються, але жодна дія з профілем
не проходить. Міграцію не можна виконувати через request-time DDL. Для
`0004`/`0005` аварійної сумісності теж немає — їх треба застосувати до deploy,
причому `0005` без `0002` навіть не застосується (його CHECK посилається на
`profile_schema_version`).

Збережи правильну Vercel handler-форму:

```ts
export default {
  fetch(request: Request) {
    return handleRequest(request);
  },
};
```

Server import shared contract має лишатися runtime-сумісним
`../shared/gameStats.js`. Не повертай legacy Node adapter із
`Readable.toWeb()`: у попередньому інциденті Vercel уже прочитав JSON body, тому
GET працював, а всі JSON POST зависали на disturbed stream.

## 6. Безпечні production probes

Ці запити не створюють профіль або run і не потребують жодного credential:

```bash
curl --max-time 10 -i \
  https://arduino-gate-game.vercel.app/api/stats

curl --max-time 10 -i \
  -H 'Content-Type: application/json' \
  --data '{}' \
  https://arduino-gate-game.vercel.app/api/stats

curl --max-time 10 -i \
  -H 'Content-Type: application/json' \
  --data '{"action":"connect"}' \
  https://arduino-gate-game.vercel.app/api/stats

curl --max-time 10 -i \
  -H 'Content-Type: application/json' \
  --data '{"action":"session","accessCode":"00000-00000-00000-00000"}' \
  https://arduino-gate-game.vercel.app/api/stats
```

Очікування:

- GET → HTTP 200 і `leaderboard` array;
- `{}` → HTTP 400 `INVALID_ACTION`;
- `connect` → HTTP 400 `INVALID_ACTION` (дію прибрано);
- запит із `accessCode` → HTTP 400 `ACCESS_CODE_RETIRED`;
- `{"action":"session"}` без заголовка `Authorization` → HTTP 401
  `AUTH_TOKEN_MISSING`.

Жоден із цих запитів не доходить до SQL. Старий probe `connect` із синтетичним
кодом, який раніше давав `404 PROFILE_NOT_FOUND`, більше не актуальний — його
`400` не є регресією.

Порожній leaderboard не доводить, що `game_players` порожня: SQL навмисно не
показує zero-game profiles. Успішний GET доводить connection і SELECT path, але
не JSON-body чи mutation path.

Не створюй diagnostic profile/result у production без окремого дозволу. Навіть
mutation, яка не створила gameplay result, змінює rate-limit counters.

## 7. Повна інтеграційна перевірка — тільки disposable project

Для persistence/API/SQL зміни застосуй `0001`—`0005` до порожнього
disposable Supabase project і перевір:

1. GET порожнього leaderboard;
2. sign up акаунта і `create` профілю з його bearer-токеном;
3. у рядку `game_players` перевір `access_code_hash IS NULL` і
   `profile_schema_version = 3`;
4. повторний `create` тим самим акаунтом → HTTP 200 з тим самим профілем;
5. `session` як другий клієнт із тим самим акаунтом;
6. `sync` одного валідного `run.completed` v2 (`eventId === runId`);
7. точний retry тієї ж події → `duplicate`, totals не змінюються вдруге;
8. той самий event ID з іншим payload → HTTP 409 `EVENT_ID_REUSED`;
9. rename і nickname conflict;
10. achievement progress/unlock і mode/power totals;
11. revision conflict для `settings.updated` → HTTP 409 `SETTINGS_CONFLICT`;
12. будь-який запит із полем `accessCode` → HTTP 400 `ACCESS_CODE_RETIRED`, а
    `connect`/`link`/`unlink` → HTTP 400 `INVALID_ACTION`;
13. bearer без профілю → HTTP 404 `AUTH_NOT_LINKED`;
14. invalid ranges/IDs і cross-field plausibility (duration↔wave,
    mode↔boss/victory/sector, enemies/combo/powers/lives/sectors), 64 KiB body
    limit і weighted-per-event rate limiting;
15. відсутність connection string, JWT, email, raw IP і payload у логах.

`sync` приймає 1–5 подій. `run.completed` має version 2; legacy `record`
залишається сумісним і сервер перетворює його на v2 event. Canonical payload
hash означає: same ID/same data — безпечний retry; same ID/different data —
конфлікт, а не мовчазне перезаписування.

Не стверджуй, що live Supabase flow пройдено, якщо були виконані тільки unit або
mocked API tests.

## 8. Локальна перевірка

`npm run dev` не запускає Vercel Function. Для повного локального stack:

```bash
npx vercel link
npx vercel env pull .env.local
npx vercel dev
```

`.env.local` і `.vercel` ігноруються Git. Перед commit перевір `git status` і не
додавай env-файли примусово. Не передавай секрети аргументами shell, якщо вони
можуть залишитися в history.

Репозиторні перевірки:

```bash
npm run check
npm audit --omit=dev
git diff --check
```

Вони перевіряють shared/browser/API validation, credential matrix, v1/v2→v3
localStorage migration, idempotency model, SQL shape/RLS, translation parity і
Web Fetch export, але не замінюють disposable database flow. WebAuthn-церемонію
passkey вони теж не перевіряють — це ручний браузерний тест.

## 9. Offline-first і відновлення помилок

Активний browser key — `arduino-gate-game-stats:v3` (сховище кількох профілів).
Валідні `:v2` і `:v1` об'єкти мігрують один раз і без втрат: переносяться старий
код, `remoteConfirmed`, pending nickname, pending runs і known event IDs. Старі
ключі ніколи не видаляються й не перезаписуються, тому лишаються fallback-ом.

Для непідтвердженого акаунтного профілю з pending результатом порядок такий, і
кожен крок іде з bearer-токеном:

```text
POST create (idempotent: для вже зв'язаного акаунта повертає наявний профіль)
  → optional rename
  → POST sync по 1–5 pending events
  → GET leaderboard
```

Якщо create/sync не відповідає, queue залишається у localStorage. Не радь
«забути профіль»: це може видалити єдину копію непідтвердженого результату.
Спочатку виправ API/deploy, потім hard refresh за потреби й один раз натисни
retry. Серверний ledger захищає retry після втраченої відповіді. Якщо сесії
немає, прохід зупиняється ще до мережі з кодом `auth_session_missing` — нічого не
губиться.

Старий профіль із кодом і без `authUserId` — **orphaned**: він лишається у
сховищі назавжди, статистику видно, чергу збережено, але sync не відправляє про
нього нічого й показує `code_login_retired` (публічний leaderboard усе одно
оновлюється). Перенести його totals у новий
акаунтний профіль неможливо: не лишилося credential, яким можна довести право
власності. Гравцеві доступний існуючий recovery export.

Checkpoint забігу (`arduino-gate-space-defender-run:v2`) — окремий від profile
storage. Він валідний не довше семи днів і лише у фазі rest/upgrade. Mid-combat
закриття записує завершений run замість серіалізації ворогів.

## 10. Rate limiting і приватність

Фіксовані одногодинні ліміти:

- 600 mutation events на Vercel client IP (`ip_write`);
- 30 create на IP (`ip_create`);
- 240 completed runs на profile, разом для legacy `record` і v2 sync;
- 30 rename на profile;
- 300 total v2 sync events на profile; batch витрачає counters на кожну подію;
- 10 акаунтних операцій на auth-акаунт (`account_link`); `create` списує
  `ip_create` + `account_link`.

Назви buckets не змінилися після `0005`, тому allowlist з `0004` і далі
підходить. Змінився scope: усе, що раніше було `profile:<accessCodeHash>`, тепер
`account:<userId>`.

Vercel перезаписує `x-forwarded-for`, а API перед БД HMAC-хешує scope з
`RATE_LIMIT_SECRET`. Ні raw IP, ні raw auth user id не вставляються в PostgreSQL.
Старі counters видаляються через дві доби. HTTP 429 містить `Retry-After`; клієнт
не повинен робити aggressive blind loop.

Відновлення доступу тепер тримається на email акаунта, а не на коді. Це означає
пряму залежність від доставки листів: вбудований SMTP пише лише учасникам команди
проєкту (див. розділ 13). «Забути профіль» не є remote deletion endpoint.

## 11. Типові помилки

### `DATABASE_NOT_CONFIGURED`

У deployment немає `SUPABASE_DATABASE_URL`. Перевір environment і redeploy.

### `DATABASE_UNAVAILABLE`

Дивись найновіший Vercel runtime log і SQLSTATE, не старий build log:

- `28P01` — неправильний database password/URI;
- `42P01` — відсутня таблиця, найімовірніше не застосовано потрібну migration;
- `42703` — stale/incompatible column;
- `42P10` — немає unique/primary constraint для `ON CONFLICT`;
- `42501` — privilege/RLS проблема;
- `23505` — unique conflict, зазвичай nickname;
- `23514` — check constraint відхилив дані. API віддає це як HTTP 400
  `STATISTICS_REJECTED`, а не як 503, і логує SQLSTATE. Це означає розходження
  між shared-валідацією і SQL, а не збій бази;
- `080xx`, `53300`, `57P03` — connection/capacity/availability.

Лог має містити тільки context і SQLSTATE. Не копіюй туди query values,
database URL, JWT, email, raw IP або request body.

`23514` від `game_players_reachable_check` означає щось інше, ніж дані гравця:
профіль спробували вставити без digest і без `profile_schema_version = 3`. Це
розходження між API і `0005`, а не помилка користувача.

### GET працює, JSON POST зависає

Це не доказ Supabase outage. Перевір, що handler — Web Fetch object, shared
server import закінчується `.js`, а legacy `Readable.toWeb()` adapter відсутній.
Саме змішування Vercel Node і Web handler моделей спричинило outage 2026-07-31.

### `STATISTICS_REJECTED`

HTTP 400. Shared-валідація прийняла забіг, а table CHECK у Postgres його
відхилив (SQLSTATE `23514`). Це означає розходження між `shared/gameStats.ts` і
`db/migrations/*.sql`, а не збій бази — тому код навмисно не 503. Мапиться лише
для apply-шляхів `record`/`sync`: те саме SQLSTATE від інфраструктурних
constraint-ів (наприклад `game_rate_limits_bucket_check`) лишається 503, бо це не
проблема даних гравця.

Клієнт не викидає подію при 400: вона лишається в offline-черзі й буде
повторюватися. Тому детерміновану `23514` треба виправляти в контракті, інакше
черга не просунеться.

### `RANDOM_NICKNAME_UNAVAILABLE`

HTTP 503 від `create`, коли гравець не задав нік і обидві спроби згенерувати
випадковий натрапили на зайнятий. Це не збій бази — досить повторити запит. Якщо
нік задав сам гравець і він зайнятий, сервер натомість віддає 409
`NICKNAME_TAKEN` і навмисно не підміняє вибір гравця.

### `EVENT_ID_REUSED`

Клієнт повторно використав event/run ID з іншим validated payload. Не змінюй
стару pending подію; з'ясуй джерело mutation. Сервер правильно не застосував її.

### `SETTINGS_CONFLICT`

`baseRevision` застарів. Потрібно перечитати profile/progression і сформувати
новий settings event; не повторювати конфліктну ревізію нескінченно.

### `ACCESS_CODE_RETIRED` і `AUTH_*`

- `ACCESS_CODE_RETIRED` (400) — запит містить поле `accessCode`. Код доступу
  скасовано; сервер відповідає явною помилкою, а не тихо ігнорує поле, щоб стара
  закешована версія бандла дала діагностовану помилку, а не незрозумілий 401.
  Найімовірніша причина — відкрита стара вкладка: досить hard refresh;
- `AUTH_TOKEN_MISSING` (401) — дія вимагає bearer JWT, а заголовка
  `Authorization` немає;
- `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` (401) — токен не пройшов
  верифікацію підпису/claims або протермінований; анонімні Supabase-сесії
  також відхиляються цим кодом;
- `AUTH_SESSION_REVOKED` (401) — сесію відкликано (наприклад, глобальний
  sign-out); користувач має увійти знову. Перевіряється всередині транзакції для
  `create` і `rename` — двох дій, які створюють або змінюють ідентичність;
- `AUTH_KEYS_UNAVAILABLE` (503) — сервер не зміг отримати публічний JWKS;
  тимчасова проблема, повтор пізніше;
- `AUTH_NOT_LINKED` (404) — акаунт валідний, але профілю ще немає. Це не помилка:
  клієнт відповідає на нього викликом `create`;
- `INVALID_ACTION` (400) для `connect`, `link` або `unlink` — ці дії прибрані
  разом із кодом доступу. Разом з ними зникли `MIXED_CREDENTIALS`,
  `PROFILE_ACCOUNT_CONFLICT` і `ACCOUNT_PROFILE_CONFLICT`.

### `passkey_disabled` (Supabase Auth, не `/api/stats`)

Passkeys вимкнені в проєкті, де не увімкнено тумблер із розділу 13 (у живому
проєкті він увімкнений з 2026-08-22). Це очікуваний стан; UI має пропонувати
email+пароль, а не показувати сиру помилку.
Інші коди церемонії WebAuthn — `too_many_passkeys`,
`webauthn_credential_exists`, `webauthn_credential_not_found`,
`webauthn_challenge_not_found`, `webauthn_challenge_expired`,
`webauthn_verification_failed`.

### API 200, але UI показує sync error

У DevTools перевір конкретний operation у `stats.error.operation` і Network.
Profile sync та leaderboard ще ділять один hook-level status, тому стан однієї
операції може виглядати як проблема іншої.

## 12. Відкат і збереження даних

- code rollback роби через новий `git revert <commit>` і deploy;
- rollback point перед Space Defender v2:
  `pre-space-defender-overhaul-20260801` і
  `backup/pre-space-defender-overhaul-20260801`, target
  `7764d15f89d7cb0581ee72216498ed3b541ec278`;
- не видаляй `0002` таблиці/колонки під час code rollback: старий code їх
  ігнорує, а таблиці можуть містити progression та idempotency ledger;
- `0004` і `0005` теж лишай застосованими. `0005` навмисно **не** видаляє
  `access_code_hash`, а лише знімає `NOT NULL`, тому старіший `0004`-API, який
  ще читає й пише digest, працює далі. Небезпечний напрямок — відкат самої
  міграції: account-only профілі мають NULL у цій колонці й порушили б
  відновлений `NOT NULL`;
- у `db/backups/` (ігнорується Git) лежить експорт
  `2026-08-04-pre-account-only.json`, зроблений перед переходом на account-only;
- destructive SQL потребує окремого backup/recovery plan і явного дозволу;
- перед перенесенням із іншого PostgreSQL використовуй перевірений
  `pg_dump`/`pg_restore` flow у disposable середовищі.

Довідка з міграції:
[Migrate Postgres to Supabase](https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres).

## 13. Supabase Auth: чекліст у Dashboard (ручні кроки)

Уже зроблено й нічого не вимагає:

- **publishable key** закомічений у `app/auth/supabaseConfig.ts`, тому
  `authAvailable === true` і акаунтний UI активний. Це публічне значення; ніколи
  не встав туди secret/service-role key;
- **email+пароль і підтвердження email** увімкнені в живому проєкті;
- **Google provider** налаштований у Dashboard (станом на 2026-08-22) — крок 2
  нижче лишається як опис того, що саме зроблено, і як це повторити в іншому
  проєкті;
- **passkeys** увімкнені в живому проєкті (станом на 2026-08-22) разом із
  relying-party параметрами — крок 1 нижче лишається з тієї ж причини.

Перед іншими кроками перевір, що Dashboard → **Authentication** →
**URL Configuration** містить Site URL `https://arduino-gate-game.vercel.app`, а
Redirect URLs — цей самий домен (і, за потреби, локальний
`http://localhost:3000`). Auth-редиректи працюють лише на URL з цього списку.

Далі — кроки для нового проєкту (у живому проєкті 1 і 2 вже виконані). Крок 1
варто робити першим, бо його параметри треба зафіксувати назавжди; кроки 3–4
опційні.

1. **Passkeys (один тумблер).** Dashboard → **Authentication** → **Passkeys** →
   *Enable Passkey authentication*, і заповни WebAuthn relying party:

   - **Relying Party Display Name** — назва для запиту в браузері;
   - **Relying Party ID** — **чистий домен без схеми, порту й шляху**:
     `arduino-gate-game.vercel.app`;
   - **Relying Party Origins** — список через кому, обов'язково HTTPS (виняток
     лише loopback: `localhost`, `127.0.0.1`, `[::1]`). Hostname кожного origin
     має дорівнювати RP ID або бути його піддоменом. **Максимум 5 origins.**

   > **Зміна Relying Party ID пізніше знецінює всі наявні passkeys.** Вони
   > криптографічно прив'язані до RP ID: після зміни жоден існуючий passkey не
   > працює для входу, і кожен користувач мусить зареєструвати новий. Вибери
   > RP ID до того, як хтось почне реєструватися, і не змінюй його.

   Passkeys нічого не коштують — це частина Supabase Auth, не платний add-on.
   Supabase позначає цей API як **експериментальний** і попереджає, що він може
   змінитися без анонсу, тому клієнт вмикає його явно через
   `auth: { experimental: { passkey: true } }` у `app/auth/client.ts`
   (`@supabase/supabase-js@2.112.0` задовольняє вимогу ≥ 2.105.0). У живому
   проєкті тумблер увімкнений; там, де його немає, кожен виклик повертає
   `passkey_disabled`, і UI просто пропонує email+пароль. Обмеження Supabase: користувачі SSO та анонімні користувачі не
   можуть реєструвати passkey; реєстрація вимагає активної сесії, а вхід —
   уже зареєстрованого passkey на підтвердженому й не заблокованому акаунті.
   Vercel preview deployments мають власний hostname на кожен deploy, який не є
   піддоменом production RP ID, тому passkeys там не працюють — це очікувано.
2. **Google provider (у живому проєкті вже налаштований).** Dashboard →
   **Authentication** → **Sign In / Up** → **Google** → Enable. У
   [Google Cloud Console](https://console.cloud.google.com/)
   створи OAuth 2.0 Client ID (тип Web application) і вкажи **точний**
   authorized redirect URI:

   ```text
   https://vullhduhswcnlpgnlrtp.supabase.co/auth/v1/callback
   ```

   Отримані Client ID і Client secret встав у форму провайдера в Supabase.
   Client secret живе лише в Dashboard — не в Git. Там, де провайдер не
   налаштований, кнопка Google у UI є, але виклик OAuth завершується помилкою, і
   UI показує спокійне пояснення замість сирого тексту — цей шлях лишається
   обов'язковим.
3. **Custom SMTP (опційно, але потрібне для реальних користувачів).**
   Dashboard → **Project Settings** → **Authentication** → SMTP Settings.
   Вбудований SMTP доставляє листи (підтвердження email, скидання пароля)
   **лише учасникам команди проєкту** — реальні користувачі не отримають
   нічого, доки не налаштовано власний SMTP-провайдер. Оскільки відновлення
   доступу тримається саме на email, це блокер перед публічним анонсом.
4. **Apple (опційно, за замовчуванням вимкнено).** Потребує платної Apple
   Developer Program. Client secret для Apple — це підписаний JWT, який треба
   перегенеровувати приблизно **кожні 6 місяців**, інакше вхід мовчки
   зламається. Вмикай лише разом із зобов'язанням вести цю ротацію, і лише
   тоді переключай `APPLE_ENABLED` у `app/auth/supabaseConfig.ts`.

Свідомі межі поточної реалізації:

- cookies не використовуються взагалі: auth-сесія і consent-вибір живуть у
  localStorage; Google/Apple ставлять власні cookies лише на своїх доменах
  під час входу. Passkey-церемонія cookies не потребує;
- passkey живе на одному пристрої або в password manager, тому email+пароль
  лишається обов'язковим fallback і сценарієм відновлення.
