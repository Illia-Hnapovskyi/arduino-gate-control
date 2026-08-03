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
  через Supabase PostgreSQL;
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
- recovery JSON не містить access code; остаточна відмова від незаписаного
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
                        ├─ localStorage → profile/event queue/preferences/checkpoint
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

- власний або локалізований випадковий нік прив'язується до 20-символьного
  access code; цей код є паролем;
- raw access code залишається в браузері та запиті, у PostgreSQL зберігається
  лише SHA-256 digest;
- активне сховище статистики — `arduino-gate-game-stats:v2`; валідний v1
  профіль, pending rename і pending runs мігрують без втрати access code;
- завершення спершу оптимістично записується локально як `run.completed` v2,
  потім відправляється чергою пакетами до п'яти подій;
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

## Supabase і Vercel

Повний runbook: [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md).

Міграції ручні й виконуються **до** deployment відповідного API:

1. `db/migrations/0001_game_stats.sql`;
2. `db/migrations/0002_game_progression.sql`;
3. `db/migrations/0003_base_table_grants.sql` — лише `REVOKE`, без нових
   об'єктів, тому порядок для нього не критичний.

Для вже налаштованої v1 production-бази виконай відсутні `0002` і `0003`.
До її застосування API лишає leaderboard/create/connect/rename і legacy record
сумісними з `0001`, а новий `sync` повертає `SCHEMA_MIGRATION_REQUIRED`; браузер
не втрачає run, а тримає його в offline queue. `0002` зберігає старі дані та backfill-ить чотири
досягнення, які можна довести з v1 totals; точні старі дати й детальні бойові
факти відновити неможливо. DDL під час API-запиту не виконується.

Vercel потребує серверні secrets:

- `SUPABASE_DATABASE_URL` — Supavisor **Transaction pooler** URI, порт `6543`;
- `RATE_LIMIT_SECRET` — окремий випадковий HMAC-secret, бажано ≥32 символів.

Postgres.js використовує TLS, одну connection на теплий instance і
`prepare: false`, що сумісно з transaction pooling. Не додавай префікс `VITE_`
до secrets. Всі таблиці мають RLS deny-by-default і не мають публічних grants/policies:
`0002` робить `REVOKE` для v2 таблиць, `0003` — для трьох базових. Браузер
працює тільки через `/api/stats`.

Rate limits у фіксованому одногодинному вікні: 600 mutation events з IP,
30 create з IP, 240 completed runs, 30 rename/create-upsert та 300 total v2
sync events на профіль. Batch списує counters за кожну подію. Raw IP у БД не
потрапляє: scope спочатку HMAC-псевдонімізується.

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
checkpoint migration, stats storage v1→v2, API validation/idempotency, SQL
контракти, Arduino protocol, translation parity та форму Vercel Web Fetch
export. Вони не доводять фізичний Web Serial timing, реальний Supabase deploy
або UI у конкретному браузері — ці перевірки виконуються окремо й не мають
вважатися пройденими без фактичного тесту.

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
