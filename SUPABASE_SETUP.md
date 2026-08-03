# Підключення Supabase до Arduino Gate / Space Defender

Цей runbook налаштовує спільну PostgreSQL-базу для профілів, результатів,
довготривалої progression, досягнень і leaderboard. Браузер не підключається до
Supabase напряму: всі запити проходять через Vercel Function `/api/stats`.

## Що знадобиться

- акаунт і проєкт у [Supabase Dashboard](https://supabase.com/dashboard);
- Vercel-проєкт, пов'язаний із цим репозиторієм;
- доступ до Vercel Environment Variables і redeploy;
- для повної integration-перевірки — окремий disposable Supabase project.

Активний backend використовує Postgres.js і пряме серверне підключення через
Supavisor Transaction Pooler. `SUPABASE_URL`, publishable/anon key і
service-role key не потрібні. Ніколи не додавай database URL, пароль, access
code, `RATE_LIMIT_SECRET`, service-role/secret key або дані користувачів у Git,
логи, скриншоти чи чат.

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
3. [`db/migrations/0003_base_table_grants.sql`](db/migrations/0003_base_table_grants.sql).

Не об'єднуй і не міняй їх місцями. Після кожного файлу дочекайся успішного
завершення перед переходом далі.

`0003` не створює й не змінює жодного об'єкта: він лише робить `REVOKE` для
базових таблиць з `0001`, які раніше трималися тільки на RLS. Його можна
застосувати в будь-який момент і повторно.

### База, де v1 статистика вже працює

Якщо `0001_game_stats.sql` раніше застосовано і наявні
`game_players`, `game_runs`, `game_rate_limits`, зроби backup та виконай
відсутні `0002_game_progression.sql` і `0003_base_table_grants.sql`. Міграція additive: вона не видаляє
профілі, старі runs або lifetime totals; додає колонки, ledger і progression
таблиці. Вона backfill-ить `first_run`, `score_10000`, `max_level` і
`veteran_10`, якщо їх можна довести з v1 aggregates, та створює відповідні
unlock rows. Для таких рядків `unlocked_at` є часом міграції, а не втраченою
історичною датою. Детальні enemy/boss/power/accuracy/controller milestones
неможливо чесно відновити без v2 run facts.

`0002` і `0003` запускаються у транзакції, беруть той самий advisory lock і
використовують короткі `lock_timeout`/`statement_timeout`; `0002` додає
constraints явно. `IF NOT EXISTS` не
може виправити вже наявний несумісний об'єкт. Якщо міграція завершується
помилкою, не повторюй її навмання: зафіксуй SQLSTATE/назву constraint без
значень запиту та перевір фактичну схему.

### Що створюють міграції

| Таблиця | Призначення |
| --- | --- |
| `game_players` | SHA-256 access-code digest, nickname/language і базові lifetime aggregates/revision. |
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

Очікується 12 таблиць, `rls_enabled = true` для кожної та відсутність public
policies. Останній запит має вернути **нуль рядків після застосування `0003`**;
до нього три базові таблиці з `0001` ще мають Data API grants. Він свідомо
використовує `has_table_privilege`, а не `information_schema.role_table_grants`:
той view показує лише grants, видані поточно доступними ролями, і може дати
хибне «все чисто».

Data API grants і RLS — різні захисні рівні: `0002` робить `REVOKE` для нових
таблиць/sequence, `0003` — для трьох базових. Обидві міграції знімають права
станом на момент виконання; вони **не** змінюють `ALTER DEFAULT PRIVILEGES`, тому
будь-яка майбутня таблиця в `public` знову отримає grants і потребуватиме
власного `REVOKE`. Не додавай grants або policies без окремого security review.

Швидка однорядкова перевірка стану схеми:

```sql
select
  (select count(*) from information_schema.tables
     where table_schema = 'public' and table_name like 'game_%')  as tables_found,
  (to_regclass('public.game_sync_events') is not null)            as migration_0002_applied,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename like 'game_%')      as public_policies,
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname like 'game_%' and not c.relrowsecurity)       as tables_without_rls;
```

Здоровий стан: `12 | true | 0 | 0`. Якщо `migration_0002_applied = false`, то
`sync` повертає `503 SCHEMA_MIGRATION_REQUIRED`, а браузери накопичують
завершені забіги в offline-черзі — дані не втрачені, але progression не працює.

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
- не використовуй access code профілю як `RATE_LIMIT_SECRET`;
- якщо `RATE_LIMIT_SECRET` відсутній, API використовує database URL як fallback
  HMAC key, але окремий secret спрощує ротацію;
- зміна environment variables потребує нового deployment.

## 5. Безпечний порядок production deployment

1. Зроби backup або підтвердь доступну point-in-time recovery.
2. Застосуй відсутні міграції: `0001` → `0002` → `0003`.
3. Виконай read-only перевірку схеми/RLS/grants.
4. Бажано лише після підтвердженої `0002` deploy v2 API/frontend.
5. Виконай безпечні probes нижче.
6. Перевір Vercel runtime logs без виведення secrets або request payloads.

Якщо frontend/API уже розгорнуто раніше, сервер read-only перевіряє наявність
v2 schema. На базі лише з `0001` leaderboard, create, connect, rename і legacy
record продовжують працювати, а `sync` повертає HTTP 503
`SCHEMA_MIGRATION_REQUIRED`. Браузер залишає v2 events у локальній черзі й
повторює їх після міграції. Це аварійна сумісність, а не заміна правильного
порядку; міграцію не можна виконувати через request-time DDL.

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

Ці запити не створюють профіль або run і не потребують реального access code:

```bash
curl --max-time 10 -i \
  https://arduino-gate-game.vercel.app/api/stats

curl --max-time 10 -i \
  -H 'Content-Type: application/json' \
  --data '{}' \
  https://arduino-gate-game.vercel.app/api/stats

curl --max-time 10 -i \
  -H 'Content-Type: application/json' \
  --data '{"action":"connect","accessCode":"00000-00000-00000-00000"}' \
  https://arduino-gate-game.vercel.app/api/stats
```

Очікування:

- GET → HTTP 200 і `leaderboard` array;
- `{}` → HTTP 400 `INVALID_ACTION`;
- synthetic connect → HTTP 404 `PROFILE_NOT_FOUND`.

Порожній leaderboard не доводить, що `game_players` порожня: SQL навмисно не
показує zero-game profiles. Успішний GET доводить connection і SELECT path, але
не JSON-body чи mutation path.

Не створюй diagnostic profile/result у production без окремого дозволу. Навіть
mutation, яка не створила gameplay result, змінює rate-limit counters.

## 7. Повна інтеграційна перевірка — тільки disposable project

Для persistence/API/SQL зміни застосуй `0001`, `0002` і `0003` до порожнього
disposable Supabase project і перевір:

1. GET порожнього leaderboard;
2. create profile з локально згенерованим кодом;
3. connect тим самим кодом як другий клієнт;
4. `sync` одного валідного `run.completed` v2 (`eventId === runId`);
5. точний retry тієї ж події → `duplicate`, totals не змінюються вдруге;
6. той самий event ID з іншим payload → HTTP 409 `EVENT_ID_REUSED`;
7. rename і nickname conflict;
8. achievement progress/unlock і mode/power totals;
9. revision conflict для `settings.updated` → HTTP 409 `SETTINGS_CONFLICT`;
10. invalid ranges/IDs і cross-field plausibility (duration↔wave,
    mode↔boss/victory/sector, enemies/combo/powers/lives/sectors), 64 KiB body
    limit і weighted-per-event rate limiting;
11. відсутність connection string, raw access code, raw IP і payload у логах.

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

Вони перевіряють shared/browser/API validation, v1→v2 localStorage migration,
idempotency model, SQL shape/RLS, translation parity і Web Fetch export, але не
замінюють disposable database flow.

## 9. Offline-first і відновлення помилок

Активний browser key — `arduino-gate-game-stats:v2`. Якщо існує валідний v1
об'єкт, клієнт переносить profile/access code, `remoteConfirmed`, pending
nickname, pending runs і known IDs у v2 events. Старий ключ лишається fallback,
якщо v2 write перервався.

Для непідтвердженого профілю з pending результатом порядок такий:

```text
POST create з тим самим access code
  → optional rename
  → POST sync по 1–5 pending events
  → GET leaderboard
```

Якщо create/sync не відповідає, access code й queue залишаються у
localStorage. Не радь «забути профіль»: це може видалити єдину копію
непідтвердженого коду та результату. Спочатку виправ API/deploy, потім hard
refresh за потреби й один раз натисни retry. Серверний ledger захищає retry
після втраченої відповіді.

Checkpoint забігу (`arduino-gate-space-defender-run:v2`) — окремий від profile
storage. Він валідний не довше семи днів і лише у фазі rest/upgrade. Mid-combat
закриття записує завершений run замість серіалізації ворогів.

## 10. Rate limiting і приватність

Фіксовані одногодинні ліміти:

- 600 mutation events на Vercel client IP;
- 30 create/create-upsert на IP;
- 240 completed runs на profile, разом для legacy `record` і v2 sync;
- 30 rename/create-upsert на profile;
- 300 total v2 sync events на profile; batch витрачає counters на кожну подію.

Vercel перезаписує `x-forwarded-for`, а API перед БД HMAC-хешує scope з
`RATE_LIMIT_SECRET`. Raw IP не вставляється в PostgreSQL. Старі counters
видаляються через дві доби. HTTP 429 містить `Retry-After`; клієнт не повинен
робити aggressive blind loop.

Профільний access code — пароль без email recovery. Втрата коду означає втрату
доступу; raw значення не логують і не зберігають у БД. «Забути профіль» не є
remote deletion endpoint.

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
database URL, access code, raw IP або request body.

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

### `EVENT_ID_REUSED`

Клієнт повторно використав event/run ID з іншим validated payload. Не змінюй
стару pending подію; з'ясуй джерело mutation. Сервер правильно не застосував її.

### `SETTINGS_CONFLICT`

`baseRevision` застарів. Потрібно перечитати profile/progression і сформувати
новий settings event; не повторювати конфліктну ревізію нескінченно.

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
- destructive SQL потребує окремого backup/recovery plan і явного дозволу;
- перед перенесенням із іншого PostgreSQL використовуй перевірений
  `pg_dump`/`pg_restore` flow у disposable середовищі.

Довідка з міграції:
[Migrate Postgres to Supabase](https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres).
