# Space Defender — Game Design Document

Цей документ фіксує дизайн і числовий баланс оновленої гри **Space Defender / «Космічний захисник»**. Він описує лише те, що підтверджується кодом, і явно відділяє реалізовані можливості від відомих обмежень.

## Статус документа

Позначення:

- **Реалізовано** — механіка існує в `app/game/` і має виконувану модель або валідацію.
- **Контракт** — типи, баланс чи формат даних уже визначені, але не кожен візуальний або UX-аспект підключений до активної гри.
- **Наступний етап** — узгоджений напрям, якого ще не слід вважати наявною можливістю.

Детерміноване ядро, runtime, renderer, меню, HUD, input/audio/preferences і persistence-модулі розміщені в `app/game/`, під'єднані активним `app/GamePanel.tsx` та перевіряються окремими тестами. Це опис стану source tree, а не твердження про вже виконаний production deploy: v2 API потребує попередньо застосованої `db/migrations/0002_game_progression.sql`, а фізичний Arduino й live Supabase перевіряються окремо.

Головні джерела правди:

- ідентифікатори й типи: `app/game/types.ts`;
- числовий баланс: `app/game/balance.ts`;
- планування хвиль: `app/game/waves.ts`;
- симуляція бою: `app/game/runtime.ts`;
- вибір покращень і cooldown: `app/game/powerUps.ts`;
- досягнення: `app/game/achievements.ts`;
- безпечне продовження забігу: `app/game/persistence.ts`;
- довготривала синхронізація: `shared/gameStats.ts`, `app/game/statsAdapter.ts`, `app/useGameStats.ts`, `api/stats.ts`;
- автоматичні перевірки: `tests/game-engine.test.mjs` та інші `tests/game-*.test.mjs`.

Якщо числа в цьому документі розходяться з типізованою конфігурацією, код конфігурації є технічним джерелом правди, а документ треба оновити тією самою зміною.

## 1. Бачення гри

Space Defender — короткий процедурний arcade survival shooter, у якому гравець керує кораблем, читає телеграфовані загрози, стріляє, накопичує комбо й енергію, збирає суперсили та формує build між хвилями. Гра має бути зрозумілою за перші 30 секунд, але давати простір для майстерності через рух, точність, таймінг суперсил і вибір синергій.

Основний цикл:

```text
підготовка → попередження → бій → короткий перепочинок
           → вибір покращення → складніша хвиля
           → бос / нагорода → результат → нова спроба
```

Дизайн не використовує постійне збільшення сили за grind. Між забігами зберігаються профіль, рекорди, статистика, досягнення, відкриті можливості та доречні налаштування. Вирішальними залишаються навичка й рішення всередині поточного забігу.

## 2. Тривалість і структура сесії

### Базова структура хвилі

Кожна хвиля має три фази (`app/game/waves.ts`):

1. `telegraph` — попередження та підготовка;
2. `combat` — 22 секунди активного бою;
3. `rest` — очищення поля, часткове відновлення і, де дозволено, вибір покращення.

На початку відпочинку runtime:

- прибирає звичайних ворогів і ворожі снаряди;
- зараховує сектор без ушкодження;
- відновлює 24% максимального щита;
- додає 22 одиниці енергії.

Бос не дозволяє хвилі перейти до відпочинку, доки його не переможено. Тому босові хвилі можуть тривати довше за номінальні 22 секунди бою.

### Типова тривалість

Експедиція має 9 хвиль. Її базовий часовий каркас без урахування вибору карт і додаткового часу на босів становить 280,5 секунди — приблизно 4 хвилини 41 секунду. Реалістична ціль типової успішної сесії — **5–8 хвилин**. Survival і Classic не мають фіксованого фіналу, але будь-який забіг обмежений шістьма годинами контракту.

Безпечне продовження не зберігає довільний кадр бою. Snapshot дозволений лише у фазах `wave-rest` або `upgrade`, живе не довше семи днів і зберігається під ключем `arduino-gate-space-defender-run:v2` (`app/game/persistence.ts`).

## 3. Режими

| Режим | Призначення | Хвилі | Боси | Покращення | Фази, мс | Загроза |
| --- | --- | ---: | --- | --- | --- | --- |
| `expedition` | Завершена подорож через усі сектори | 9 | кожна 3-тя хвиля | так | 2500 / 22000 / 6000 | 7 + 3,2 за хвилю |
| `survival` | Нескінченна перевірка витривалості | до hard cap | кожна 3-тя хвиля | так | 1800 / 22000 / 4000 | 8 + 3,8 за хвилю |
| `classic` | Чистий score-attack без build-системи | до hard cap | немає | немає | 1200 / 22000 / 2500 | 6 + 2,7 за хвилю |

Босова хвиля додає 2000 мс до відпочинку. Expedition проходить дев'ять секторів один раз і завершується перемогою. Survival повторює дев'ятисекторний цикл. Classic завжди використовує `starfield`.

## 4. Складність

| Складність | HP ворогів | Швидкість | Шкода | Spawn budget | Очки | Recovery drops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `cadet` | ×0,86 | ×0,86 | ×0,75 | ×0,82 | ×0,8 | ×1,35 |
| `pilot` | ×1,0 | ×1,0 | ×1,0 | ×1,0 | ×1,0 | ×1,0 |
| `ace` | ×1,2 | ×1,16 | ×1,25 | ×1,22 | ×1,5 | ×0,78 |

`Cadet` дає м'якший onboarding і більше шансів на відновлення, але нижчий score multiplier. `Pilot` — еталонний баланс. `Ace` створює ризиковану гру за високий результат, а не просто косметичну складність.

## 5. Генерація хвиль

План хвилі детермінований: однакові `seed + mode + difficulty + wave + sector` дають однаковий план (`app/game/rng.ts`, `app/game/waves.ts`). Це потрібно для відтворюваних тестів і діагностики балансу.

Формула бюджету:

```text
round((threatBase + threatGrowth × (wave - 1)) × spawnBudgetMultiplier)
```

Правила генерації:

- тип доступний лише від своєї `unlockWave`;
- його вартість має вміщатися в залишок бюджету;
- preferred-вороги сектора отримують вагу ×1,9;
- босова хвиля витрачає на міньйонів 42% звичайного бюджету;
- за планом створюється не більше 48 spawn-записів;
- небезпека телеграфується до фактичної появи ворога;
- еліти з'являються з 5-ї хвилі, імовірність зростає до максимуму 22%;
- еліта має ×1,75 HP, ×1,12 швидкість і ×2 базові очки.

Runtime додатково обмежує одночасно активні сутності: 72 вороги, 140 снарядів гравця, 180 ворожих снарядів і 96 ефектів. Зовнішній frame delta обмежено 250 мс, а фізика рахується кроками до 20 мс (`app/game/runtime.ts`).

## 6. Сектори

| ID | Візуальна ідентичність контракту | Загроза | Preferred-вороги | Поточна runtime-механіка |
| --- | --- | --- | --- | --- |
| `starfield` | бірюзове зоряне поле | `none` | швидкі астероїди, scouts | без модифікатора |
| `nebula` | фіолетовий туман | `visibility-pulse` | hunters, support | пульсуючий mist-overlay; швидкість ворожих снарядів ×0,82 |
| `meteor-belt` | теплі камені й уламки | `debris-lanes` | splitters, armored, debris | додатковий debris кожні 3,7 с |
| `ice` | сині кристали | `cryo-drift` | fast, splitters | швидкість корабля ×0,86 |
| `ion-storm` | зелені іонні частинки | `ion-pulse` | gunners, support | мінус 12 енергії кожні 4,2 с |
| `ship-graveyard` | уламки кораблів | `minefield` | mines, debris, hunters | додаткова міна кожні 5 с |
| `solar` | жар, помаранчеві частинки | `solar-flare` | comets, armored | горизонтальний дрейф і 3 flare-снаряди кожні 4,6 с |
| `dark` | темні тіні | `limited-light` | mines, hunters, gunners | vignette світла; швидкість ворогів і ворожих снарядів ×1,12 |
| `boss` | червона арена | `boss-arena` | support, gunners | босова арена; окрема фонова небезпека не додається |

Для кожного сектора визначено accent, два кольори фону, стиль частинок і музичний стан `calm`, `drive`, `danger` або `boss` (`app/game/balance.ts`). `app/game/rendering.ts` процедурно малює ці палітри, частинки та hazard overlays, а `app/game/useGameAudio.ts` перемикає sector track/tempo між Web Audio у demo mode та `TRACK:TONE` з Arduino. Кількість ефектів обмежена, а `prefers-reduced-motion` зменшує рух і вимикає shake.

## 7. Вороги

| ID | Хвиля | Cost | HP | Speed | Score | Роль |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `swift-asteroid` | 1 | 1 | 1 | 175 | 10 | мала швидка ціль |
| `debris` | 1 | 1 | 1 | 125 | 10 | дешеве дрейфуюче заповнення поля |
| `splitter-asteroid` | 2 | 3 | 3 | 92 | 30 | після знищення розпадається на два малих астероїди |
| `scout-drone` | 2 | 2 | 2 | 145 | 30 | маневрена weaving-ціль |
| `armored-asteroid` | 3 | 4 | 6 | 78 | 50 | приймає лише 72% розрахованої шкоди |
| `comet` | 3 | 3 | 2 | 320 | 40 | телеграфований швидкий ривок |
| `mine` | 4 | 3 | 2 | 34 | 30 | сповільнюється, створює radial burst / вибух поблизу |
| `gunner-drone` | 4 | 4 | 4 | 94 | 50 | прицільні постріли; еліта стріляє ширшим залпом |
| `hunter-drone` | 5 | 4 | 4 | 132 | 60 | переслідує корабель |
| `support-drone` | 6 | 5 | 5 | 76 | 70 | лікує або підсилює сусідніх ворогів |

Радіуси, точні telegraph-часи, selection weights і право стати елітою визначені в `ENEMY_BALANCE`. Ворог не має бути складним лише через HP: кожен клас створює іншу задачу руху, пріоритету цілі або контролю простору.

## 8. Боси

В Expedition і Survival боси з'являються на хвилях 3, 6 і 9, після чого порядок циклічно повторюється. На зміні фази бос отримує 520 мс невразливості, відкладає наступну атаку й подає попередження.

| ID | Base HP | Score | Фази | Пороги HP | Поведінка |
| --- | ---: | ---: | ---: | --- | --- |
| `sentinel-array` | 80 | 500 | 3 | 66%, 33% | рухається дугою, розширює fan-залпи, викликає scouts/gunners, у 3-й фазі додає radial burst |
| `comet-leviathan` | 130 | 800 | 3 | 72%, 38% | прицільні ривки, radial burst, виклик debris/comets, швидші атаки у пізніх фазах |
| `void-dreadnought` | 190 | 1200 | 4 | 75%, 48%, 22% | осцилюючі залпи, виклик gunners/mines/support, radial burst, reposition у 4-й фазі |

HP додатково масштабується складністю та номером босової хвилі. Перемога над босом:

- додає босові очки;
- повністю відновлює енергію;
- одразу зараховує та екіпірує signature power: `laser` для
  `sentinel-array`, `time` для `comet-leviathan`, `charge` для
  `void-dreadnought`;
- генерує подію босової перемоги й окремий SFX.

Боси не є просто великими ворогами: зміни фаз змінюють просторову задачу й склад атак.

## 9. Корабель, ресурси й score

Базові параметри runtime (`app/game/runtime.ts`):

- 3 життя;
- 100 щита і 100 енергії;
- швидкість корабля 320 одиниць/с;
- базовий cooldown пострілу 220 мс;
- combo-window 2600 мс;
- score cap 100 000 000;
- рівень загрози 1–9.

Кожне знищення ворога оновлює combo. Кожні 5 значень combo додають 10% до score multiplier, максимум п'ять таких tier. Потім застосовується multiplier складності, а загальна сума квантується до десятків.

Звичайне знищення дає 6 енергії, елітне — 12. Energy pickup дає 28. Отримане ушкодження спершу знімає щит; втрата життя відновлює 35% максимального щита, скидає combo й дає базово 1300 мс невразливості. На одному житті вмикається low-health подія.

Рівень для серверного контракту залежить від записаного активного часу, а не від номера хвилі:

```text
level = min(9, 1 + floor(activeDurationMs / 22000))
```

Цей інваріант навмисно збігається з `shared/gameStats.ts` і SQL constraints. Не можна вводити server-side ceiling від темпу стрільби: фізика використовує capped delta, а firing — animation timestamps, тому такий ceiling уже відхиляв легітимні low-FPS забіги.

## 10. Суперсили

Pickup суперсили **екіпірує** її. Активація відбувається окремою дією; навіть тимчасові сили з нульовою ціною підкоряються власному cooldown.

| ID | Тип | Тривалість | Cooldown | Енергія | Ефект runtime |
| --- | --- | ---: | ---: | ---: | --- |
| `shield` | temporary | 10,0 с | 18 с | 0 | відновлює/підтримує захисний щит |
| `spread` | temporary | 9,0 с | 16 с | 0 | потрійний постріл |
| `laser` | active | 2,6 с | 18 с | 65 | швидкий piercing-лазер |
| `missiles` | active | 4,5 с | 20 с | 55 | автоматичні самонавідні ракети |
| `emp` | active | 2,4 с | 18 с | 60 | очищає ворожі снаряди, оглушує й ушкоджує ворогів |
| `time` | active | 5,0 с | 24 с | 70 | hostile time scale ×0,46 |
| `magnet` | temporary | 12,0 с | 16 с | 0 | притягує pickups |
| `drone` | temporary | 14,0 с | 24 с | 0 | дрон стріляє раз на 480 мс |
| `repair` | instant | 0 | 30 с | 0 | +1 життя та щонайменше 55% щита |
| `pulse` | active | 1,2 с | 20 с | 60 | відштовхує й ушкоджує ворогів, чистить близькі снаряди |
| `invulnerability` | active | 1,8 с | 26 с | 75 | повна коротка невразливість |
| `critical` | temporary | 8,0 с | 18 с | 0 | +32% шанс подвійної шкоди |
| `speed` | temporary | 9,0 с | 16 с | 0 | +90 швидкості |
| `charge` | active | 1,5 с | 24 с | 80 | один потужний laser-shot: damage 16, pierce 12 |

Канонічні ID — тільки наведені 14 значень (`app/game/types.ts`). Старі `triple-shot`, `time-slow`, `escort-drone` і `repulsor-wave` підтримуються лише як migration aliases snapshot-сховища; `escort-drone` водночас залишається чинним і окремим ID постійного upgrade.

Суперсила має видимий стан equipped/cooldown/energy у HUD, власну подію звуку та доступну кнопку для keyboard і touch. Фізичний Arduino switch зберігає стару сумісність із fire; утримання приблизно 650 мс додатково дає одноразовий power pulse на стороні браузера. Це не потребує нового піна, telemetry field або Serial-команди.

## 11. Покращення забігу

Після хвилі Expedition/Survival детерміновано пропонуються до трьох унікальних карт. Коли можливо, набір містить по одній карті з weapon, defense і utility. Максимальні stacks виключаються; вага повтору зменшується як `selectionWeight / (1 + currentStacks)` (`app/game/powerUps.ts`). Classic не показує карти, навіть якщо деякі upgrades позначені сумісними з усіма режимами.

| ID | Категорія | Max | Ефект |
| --- | --- | ---: | --- |
| `twin-shot` | weapon | 2 | +1 паралельний постріл за stack; `spread` додає ще два |
| `rapid-fire` | weapon | 3 | cooldown `220 × 0,84^stacks`, не нижче 95 мс |
| `piercing-rounds` | weapon | 2 | додаткове пробиття цілей |
| `critical-focus` | weapon | 3 | +8% crit chance за stack |
| `reinforced-shield` | defense | 3 | +25 max shield за stack і повне заповнення при виборі |
| `phase-plating` | defense | 2 | +350 мс невразливості після втрати життя за stack |
| `repair-nanites` | defense | 2 | regen щита 1,7/с за stack і періодичне відновлення життя |
| `engine-boost` | utility | 3 | +26 швидкості за stack |
| `missile-bay` | utility | 2 | автоматичні ракети; stacks скорочують інтервал |
| `emp-capacitor` | utility | 3 | −8 energy cost, −1 с cooldown і додаткова EMP-шкода за stack; інші сили не змінює |
| `magnet-array` | utility | 2 | +45 pickup range за stack |
| `escort-drone` | utility | 2 | +1 постійна флангова гармата за stack |

`repair-nanites`, `missile-bay`, `emp-capacitor`, `magnet-array` і `escort-drone` доступні лише в Expedition/Survival. Решта записані як сумісні з усіма режимами, але Classic навмисно вимикає весь вибір карт.

Build-и мають різні осі сили: темп і пробиття, crit, захист, мобільність, автоматичні ракети, EMP economy, pickup-control або companion. Мета — ситуативні синергії без єдиного безумовно найкращого вибору.

## 12. Досягнення

ID стабільні й є частиною shared/API контракту. Назва та опис мають жити у всіх трьох мовах `uk`, `de`, `en`; rarity та icon нижче мають збігатися між game core і `shared/gameStats.ts`.

| ID | Умова | Target | Rarity | Icon |
| --- | --- | ---: | --- | --- |
| `first_run` | завершити першу гру | 1 | common | `launch` |
| `first_enemy` | знищити першого ворога | 1 | common | `target` |
| `first_boss` | перемогти першого боса | 1 | rare | `boss` |
| `survivor_5m` | найдовший забіг ≥ 5 хвилин | 300 000 мс | rare | `timer` |
| `flawless_sector` | пройти сектор без ушкодження | 1 | rare | `shield` |
| `combo_25` | досягти combo 25 | 25 | rare | `combo` |
| `score_10000` | встановити high score ≥ 10 000 | 10 000 | epic | `star` |
| `sharpshooter` | best accuracy ≥ 70% | 700‰ | rare | `crosshair` |
| `arduino_pilot` | завершити забіг з Arduino або mixed input | 1 | rare | `controller` |
| `power_explorer` | використати всі 14 суперсил | 14 | legendary | `power` |
| `max_level` | досягти level 9 | 9 | epic | `level` |
| `veteran_10` | завершити 10 ігор | 10 | epic | `medal` |

Для run accuracy потрібно щонайменше 10 пострілів; `shotsHit` обмежується `shotsFired`. Прогрес монотонний, а `unlockedAt` після відкриття не переписується (`app/game/achievements.ts`).

Система підтримує progress, дату відкриття, rarity та icon. `ProgressPanels` показує колекцію, а `GamePanel` після синхронізації порівнює відомі unlocks, показує toast і відтворює `ACH`. Це потребує browser/live-API verification перед production твердженням, але інтеграція є в активному source path.

## 13. Довготривала progression

Поточна модель є **skill-first**:

- жодне досягнення не збільшує HP, damage або стартові ресурси;
- між забігами зберігаються майстерність гравця у вигляді рекордів, історії та колекції;
- поле `unlocks` дозволяє відкривати режими чи косметичні можливості, але конкретна система нагород/gating ще не визначена як реалізована;
- leaderboard залишається casual, бо сервер приймає результати браузерної симуляції, а не авторитетно відтворює бій.

Причини повертатися:

- перевершити high score і highest wave/level;
- пройти Expedition на вищій складності;
- дослідити різні build-и;
- закрити 12 досягнень;
- покращити accuracy, combo і boss statistics;
- порівняти результат у leaderboard;
- грати з різними способами керування, включно з фізичним Arduino.

Не слід додавати pay-to-win, daily grind або постійні stat boosts без окремого перегляду дизайну.

## 14. Меню, onboarding і результати

Реалізований menu flow, зібраний із окремих game-компонентів, такий:

1. профіль або пояснення, чому він потрібний;
2. `Грати` / `Продовжити` з безпечного checkpoint;
3. вибір режиму й складності;
4. передстартове summary: режим, складність, рекорди, керування, Arduino/demo status;
5. коротке навчання: рух → fire → pickup → power → telegraph;
6. забіг;
7. pause / upgrade / boss transition;
8. result: outcome, score, wave/level, новий рекорд, відкриті досягнення, повторна гра.

Розділи меню мають охоплювати play/continue, modes, profile, achievements, statistics, leaderboard, settings, controls, tutorial та Arduino info. Це інформаційна архітектура, а не вимога показувати десять однаково важливих кнопок на першому екрані.

Onboarding у перші 30 секунд:

- рух і стрільба доступні одразу;
- telegraph показує напрямок першої небезпеки;
- перші типи мають просту траєкторію;
- перший pickup пояснює equipped power і окрему кнопку activation;
- перша пауза або menu card пояснює demo mode та фізичний joystick;
- Cadet рекомендований новому гравцю, Pilot — стандартний вибір.

Pause зупиняє active clock і аудіо-стан. Втрата фокуса вкладки ставить гру на паузу, а terminal lifecycle захищений локальним recorded-ID set, offline queue та серверним event ledger від подвійного запису одного run.

## 15. Керування, доступність і платформи

Джерела input зводяться до нормалізованих `moveX`, `moveY`, `fire`, `power` і controller classification (`app/game/input.ts`): keyboard, touch, physical Arduino та mixed.

Базовий keyboard contract:

- рух: WASD;
- вогонь: Space;
- суперсила: E;
- mapping зберігається в preferences і може бути перепризначений.

Touch має окремий virtual joystick і доступні fire/power controls. Фізичний Arduino joystick зберігає рух та fire через наявний Serial-протокол; browser-side long press приблизно 650 мс активує power. Коротке натискання й усі старі firmware-команди залишаються сумісними, піни та обладнання не змінені.

Accessibility contract:

- music/effects volume 0–100;
- вимкнення screen shake;
- user reduced-motion, який логічно об'єднується з OS `prefers-reduced-motion`;
- видимий keyboard focus і семантичні назви меню;
- live-region для коротких статусів, які не перекривають гру;
- достатній контраст HUD;
- адаптивний layout для приблизно 1440 px і 390 px;
- demo mode без Web Serial залишається повноцінним способом гри.

Screen reader може керувати меню й отримувати статуси, але real-time canvas shooter сам по собі не є еквівалентно доступним без зору; не слід заявляти повну accessibility гри без окремої альтернативної механіки.

## 16. Persistence, статистика й синхронізація

### Локальний checkpoint

Snapshot v2 містить:

- `runId`, mode, difficulty, seed, поточний RNG state та entity counter;
- wave і **похідний**, а не довірений, sector;
- тільки phase `wave-rest` або `upgrade`;
- active/runtime duration, score, lives, shield, energy і всі використані
  controller sources;
- upgrade stacks і вже показаний набір upgrade choices;
- equipped power, активний стан/cooldown усіх сил і player timers;
- run metrics.

Loader відхиляє прострочені, пошкоджені або несумісні дані, обмежує stacks/cooldown і мігрує v1 та старі power aliases. Він не обіцяє відновлення позицій ворогів або середини бою (`app/game/persistence.ts`).

Після перемоги над босом його signature power не лишається live pickup, який
міг би зникнути при безпечному checkpoint: runtime одразу зараховує й екіпірує
нагороду. На terminal screen вихід і новий запуск доступні лише після надійного
локального запису результату; помилка `localStorage` показує retry без втрати
поточного підсумку (`app/game/runtime.ts`, `app/GamePanel.tsx`,
`app/game/GameOverlays.tsx`).

Якщо локальний запис результату неможливий, екран дозволяє завантажити
recovery JSON без access code. Відмова від такого результату з'являється лише
після спроби експорту й потребує окремого підтвердження, що файл справді є на
пристрої. Невдале видалення старого checkpoint не приховується: новий виліт
блокується, доки гравець повторно не очистить збережений забіг.

### Довготривалі факти

Shared/API модель підтримує:

- загальні games, score, high score, level і duration;
- enemies і bosses defeated;
- shots fired/hit та best accuracy permille;
- longest combo і longest run;
- powerups collected;
- wins і Arduino runs;
- mode+difficulty aggregates;
- power usage statistics;
- achievement progress/unlockedAt;
- unlocks;
- revisioned settings.

Завершення створює idempotent подію `run.completed` v2 зі стабільним event ID, рівним `runId`. Налаштування використовують `settings.updated` v1. Offline queue зберігає події до синхронізації; за один запит передається не більше п'яти game events (`shared/gameStats.ts`, `app/useGameStats.ts`, `api/stats.ts`). Повтор того самого retained event/run ID не повинен вдруге збільшувати агрегати.

Якщо deployment тимчасово випередив ручну `0002`, API read-only визначає v1
schema: базові profile/leaderboard операції залишаються доступними, а `sync`
повертає `SCHEMA_MIGRATION_REQUIRED`. Клієнт не викидає подію й повторює її
після міграції; DDL під час запиту не запускається.

Runtime накопичує точні per-power collection/activation counts, cumulative `livesLost` (включно з ушкодженнями, які пізніше компенсувала repair-сила) та фактичні duration/loss facts кожної хвилі. Adapter передає останні 64 sector facts у v2 event; для забігів довших за 64 хвилі старіші деталізовані записи відсікаються, але загальні lifetime totals залишаються точними.

Міграція `0002` backfill-ить тільки `first_run`, `score_10000`, `max_level` і `veteran_10`, які можна довести зі старих v1 aggregates, та створює їхні unlock rows. Точний історичний час невідомий, тому `unlocked_at` дорівнює часу міграції. Інші досягнення починають накопичуватися з v2 run facts. Revisioned `settings.updated` підтримується shared/API/SQL, але поточний UI зберігає preferences device-local і ще не ставить settings events в offline queue.

Не збираються і не мають збиратися координати кожного кадру, сирі значення joystick, access code, raw IP або інші персональні дані. Access code залишається паролем і зберігається в БД лише як SHA-256 digest; rate-limit scopes псевдонімізуються HMAC на сервері.

## 17. Валідаційні інваріанти

### Результат забігу

Browser, API та PostgreSQL повинні приймати той самий легітимний результат:

- `runId`: 8–64 ASCII-символи `[A-Za-z0-9_-]`;
- `score`: safe integer 0–100 000 000, кратний 10;
- `level`: safe integer 1–9;
- `durationMs`: safe integer 0–21 600 000;
- `level <= min(9, 1 + floor(durationMs / 22000))`;
- `highestWave <= min(mode === expedition ? 9 : 10000, 1 + floor(durationMs / 22000))`;
- final sector відповідає mode+wave, Classic не має bosses, а `victory` можливий тільки в Expedition wave 9;
- bosses не перевищують кількість трьохвильових boss intervals;
- enemies ≤ `floor(durationMs / 100)`, combo ≤ enemies, powerups ≤ enemies + bosses; cumulative `livesLost` обмежено консервативною repair-aware формулою `3 + powerups + highestWave + floor(durationMs / 30000)`;
- `shotsHit <= shotsFired`;
- сума sector durations не перевищує run duration, completed sectors вміщуються у wave/time, а per-power details не перевищують total/duration-derived межі;
- mode, difficulty, sector, power, achievement та controller — лише канонічні ID;
- повторний retained `runId/eventId` є idempotent.

### Runtime і snapshot

- run ID має той самий pattern;
- snapshot score має той самий cap і кратність 10;
- lives для resumable checkpoint: 1–3;
- wave: 1–981 (hard cap, похідний від 6 годин / 22 секунд);
- snapshot age: максимум 7 днів;
- sector відновлюється за mode+wave, а не приймається з недовіреного JSON;
- невідомі upgrades відкидаються, stacks і cooldown затискаються конфігурацією;
- симуляція завершується `duration-limit` на шести годинах.

Будь-яка зміна score, level, duration, IDs або метрик потребує синхронного оновлення game runtime, shared validation, API validation, SQL constraints, localStorage migration, тестів і трьох мов.

## 18. Тестовий контракт

Мінімальний deterministic coverage нового ядра (`tests/game-engine.test.mjs`):

- progression секторів і босових хвиль;
- deterministic enemy generation;
- difficulty scaling;
- bounded planner на hard cap;
- upgrade offers і max stacks;
- power cooldown;
- achievement accumulation/unlock;
- snapshot validation і migration aliases.

Суміжні тести мають покривати input, preferences, resume, stats adapter/storage, API idempotency, повторний runId, achievement sync, SQL constraints, access-code/nickname validation, translation-key parity та форму Vercel Web Fetch export.

Окрім автоматичних тестів, перед релізом потрібні ручні перевірки:

- desktop близько 1440 px і mobile близько 390 px;
- demo, keyboard і touch;
- контрольована симуляція Arduino protocol без фізичного пристрою;
- pause/resume та втрачений focus;
- offline run → reconnect → рівно один серверний запис;
- read-only production probes без створення профілю або результату.

Фізичну ергономіку Arduino, справжній Web Serial timing, Vercel environment variables і живу Supabase migration не можна довести unit-тестами репозиторію.

## 19. Явно не реалізоване або не завершене

Нижче — backlog, а не поточні можливості:

- повні per-sector details для понад 64 хвиль (зараз payload навмисно bounded останніми 64 записами);
- cross-device sync UI preferences через вже наявний `settings.updated` contract;
- формальні правила косметичних/unlock rewards;
- інтеракційні React-тести, фізичний hardware pass і live disposable-Supabase flow;
- серверно-авторитетний competitive anti-cheat.

До реалізації цих пунктів UI й документація не повинні подавати їх як гарантовані production-функції.

## 20. Правила подальшого балансу

1. Спочатку змінювати типізовану конфігурацію, потім runtime, validation, SQL і документацію.
2. Порівнювати не лише DPS/HP, а просторове навантаження, telegraph і доступні контрдії.
3. Не робити одну карту обов'язковою для виживання; пропозиція з трьох карт повинна залишати щонайменше дві змістовні стратегії.
4. Новий сектор мусить змінювати рішення гравця, а не тільки палітру.
5. Новий бос мусить мати щонайменше дві поведінково різні фази та читабельний перехід.
6. Новий power ID є контрактною зміною: потрібні types, balance, runtime, translations, persistence migration, shared/API/SQL validation, telemetry і тести.
7. Зберігати demo mode, keyboard, touch і Arduino; не ламати gate/radar режими.
8. Поважати reduced motion, performance caps і шестигодинний серверний контракт.
9. Не покладатися на client score як на захищений tournament result.
10. Після змін виконувати `npm run check`, `npm audit --omit=dev` і `git diff --check`, а БД перевіряти лише за встановленими Supabase/Postgres правилами.
