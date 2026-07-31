# Arduino Gate Control

Вебпанель для Arduino UNO зі шлагбаумом, ультразвуковим радаром, DHT11,
джойстиком, двома buzzer-ами та браузерною грою «Космічний захисник».

## Як працює застосунок

- `src/main.tsx` монтує React-застосунок із `app/page.tsx`.
- Сайт збирається Vite та публікується з каталогу `dist`.
- Chrome або Edge підключається до Arduino через Web Serial на 115200 baud.
- Arduino надсилає JSON-телеметрію, а сайт повертає текстові команди керування.
- Гра й фізика працюють у браузері; Arduino-джойстик керує кораблем.
- Passive Buzzer на D3 відтворює музику, Active Buzzer на D5 — ефекти гри.

Без Arduino можна запустити деморежим. Safari та браузери без Web Serial також
можуть використовувати демо, клавіатуру, touch-кнопки й віртуальний джойстик.

## Локальний запуск

Потрібен Node.js `>=22.13.0`.

```bash
npm ci
npm run dev
```

Після запуску відкрий адресу, яку покаже Vite.

## Перевірки

```bash
npm run lint       # ESLint
npm run typecheck  # TypeScript без генерації файлів
npm test           # production build + Node regression tests
npm run check      # усі перевірки разом
```

## Arduino

Готова прошивка: `public/arduino-smart-gate.ino`.

Українська інструкція зі схемою підключення:
`public/README-UK.md`.

Перед додаванням або переставлянням дротів від’єднай USB. Не подавай 9V на
контакти 5V, D2–D7, датчики, джойстик, сервопривід або buzzer-и.

## Додаткова інфраструктура

Файли `worker/`, `db/`, `examples/` і `app/chatgpt-auth.ts` залишаються як
опціональна Cloudflare/Next.js інфраструктура. Поточний Vercel-деплой
використовує Vite-конфігурацію та `vercel.json`.
