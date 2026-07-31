# Підключення Supabase до Arduino Gate

Ця інструкція налаштовує спільну PostgreSQL-базу для профілів, результатів і
таблиці лідерів. Після налаштування код профілю дозволяє відкрити ту саму
статистику на іншому пристрої.

## Що знадобиться

- акаунт [Supabase](https://supabase.com/dashboard);
- Vercel-проєкт, який деплоїть цей GitHub-репозиторій;
- доступ до Environment Variables і redeploy у Vercel.

Застосунок використовує пряме серверне підключення до PostgreSQL через
Supavisor. `SUPABASE_URL`, publishable/anon key і service-role key для поточної
реалізації не потрібні.

## 1. Створи Supabase-проєкт

1. Відкрий [Supabase Dashboard](https://supabase.com/dashboard) і натисни
   **New project**.
2. Вибери організацію, назву проєкту та регіон, близький до регіону Vercel.
3. Створи надійний пароль бази й збережи його в менеджері паролів.
4. Дочекайся завершення створення проєкту.

Не вставляй пароль або connection string у GitHub, вихідний код, скриншоти чи
чат. Якщо пароль втрачено, скинь його в налаштуваннях Supabase і онови змінну у
Vercel.

## 2. Створи таблиці

1. У Supabase відкрий **SQL Editor** → **New query**.
2. Відкрий у репозиторії файл
   [`db/migrations/0001_game_stats.sql`](db/migrations/0001_game_stats.sql).
3. Скопіюй весь SQL у редактор Supabase і натисни **Run**.
4. Переконайся, що запит завершився без помилок.
5. У **Table Editor** мають з’явитися:
   `game_players`, `game_runs`, `game_rate_limits`.

Міграція безпечна для повторного запуску. Для всіх трьох таблиць вмикається
Row Level Security без публічних policies. Це навмисно: браузер не повинен
читати або змінювати статистику напряму через Supabase Data API; усі операції
проходять через перевірки та rate limits у `/api/stats`.

## 3. Скопіюй правильний connection string

1. У Supabase натисни **Connect**.
2. Обери тип **URI**.
3. Обери **Transaction pooler** / Supavisor.
4. Переконайся, що в URI використовується порт `6543`, а не `5432`.
5. Скопіюй URI та підстав пароль бази замість `[YOUR-PASSWORD]`, якщо Dashboard
   не зробив цього автоматично.

Приблизний формат:

```text
postgres://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

Transaction pooler призначений для коротких serverless-з’єднань. Код уже
вимикає prepared statements (`prepare: false`), як вимагає цей режим. Докладніше:
[Supabase: Connect to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
і [Postgres.js](https://supabase.com/docs/guides/database/postgres-js).

Якщо пароль містить `@`, `:`, `/`, `#`, `%` або інші спеціальні символи, вони
мають бути percent-encoded у URI. Найнадійніше копіювати готовий рядок із
Dashboard після введення пароля.

## 4. Додай секрети у Vercel

1. Відкрий Vercel → потрібний проєкт → **Settings** →
   **Environment Variables**.
2. Додай:

   | Name | Value | Environments |
   | --- | --- | --- |
   | `SUPABASE_DATABASE_URL` | Transaction pooler URI з кроку 3 | Production; за потреби Preview і Development |
   | `RATE_LIMIT_SECRET` | окремий випадковий секрет щонайменше 32 символи | ті самі environments |

3. Для генерації `RATE_LIMIT_SECRET` локально можна виконати:

   ```bash
   openssl rand -hex 32
   ```

4. Не називай ці змінні з префіксом `VITE_`: Vite вбудовує такі значення в
   клієнтський JavaScript.
5. Збережи змінні та зроби **Redeploy** останнього deployment. Зміна environment
   variables не змінює вже створений deployment автоматично.

`RATE_LIMIT_SECRET` не є кодом профілю. Це серверний HMAC-ключ, який не можна
показувати користувачам. Якщо його не задати, API використає database URL як
резервний ключ, але окремий секрет спрощує майбутню ротацію пароля бази.

## 5. Перевір API

Після redeploy виконай, замінивши домен на свій:

```bash
curl -i https://YOUR-DOMAIN.vercel.app/api/stats
```

Для нової бази очікується HTTP `200` і приблизно така відповідь:

```json
{"leaderboard":[]}
```

Потім виконай повну перевірку:

1. Відкрий вкладку гри й створи профіль із власним або випадковим ніком.
2. Збережи показаний код профілю.
3. Запусти демо, зіграй і заверши гру.
4. Перезавантаж сторінку — результат має залишитися.
5. На іншому пристрої або в приватному вікні натисни підключення профілю та
   введи той самий код.
6. Переконайся, що нік і статистика збігаються, а результат є в рейтингу.

## 6. Локальна перевірка

Звичайний `npm run dev` запускає тільки Vite й не запускає `/api/stats`. Для
frontend та Vercel Function разом використовуй:

```bash
npx vercel link
npx vercel env pull .env.local
npx vercel dev
```

`.env.local` і каталог `.vercel` уже ігноруються Git. Перед будь-яким commit
перевір `git status` і ніколи не додавай env-файли примусово.

Можна також задати змінні лише для одного процесу, не записуючи їх у файл:

```bash
SUPABASE_DATABASE_URL='postgres://…:6543/postgres' \
RATE_LIMIT_SECRET='…' \
npx vercel dev
```

Такий спосіб може залишити секрет у shell history, тому Vercel environment або
локальний env-файл зазвичай безпечніші.

## Типові помилки

### `DATABASE_NOT_CONFIGURED`

У deployment немає `SUPABASE_DATABASE_URL`. Перевір назву, environment
(Production/Preview/Development) і зроби redeploy.

### `DATABASE_UNAVAILABLE`

Найчастіші причини: неправильний пароль, connection string не з Transaction
pooler, невірно закодовані спеціальні символи або тимчасово недоступний
Supabase-проєкт. Перевір Vercel Function Logs; connection string у лог не
копіюй.

### Помилка prepared statement

Для serverless URI має бути порт `6543`. У `api/stats.ts` уже встановлено
`prepare: false`; не прибирай цю опцію.

### API повертає `200`, але профіль не синхронізується

Перевір Network у DevTools для `POST /api/stats`, а також Vercel Function Logs.
Не публікуй у bug report повний request body: він містить секретний код профілю.

## Дані та відкат

- «Забути профіль» видаляє лише локальну копію в браузері, а не рядок у
  Supabase.
- Не видаляй таблиці для відкату коду: вони не заважають попередній версії й
  можуть містити статистику користувачів.
- Код відкочується окремим `git revert <commit>` і новим deploy.
- Перед руйнівними SQL-операціями зроби експорт даних.

Якщо в старій Neon-базі все ж є потрібні дані, спочатку перенеси їх через
`pg_dump`/`pg_restore`, а вже потім перемикай production URL. Офіційна довідка:
[Migrate Postgres to Supabase](https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres).
