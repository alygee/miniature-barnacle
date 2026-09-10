# drone-telegram-mtproto — дизайн

Дата: 2026-09-10
Статус: черновик на ревью

## 1. Цель

Drop-in замена [appleboy/drone-telegram](https://github.com/appleboy/drone-telegram) для отправки
CI-уведомлений в Telegram, работающая не через Bot API (HTTPS к `api.telegram.org`), а через MTProto — чтобы трафик можно было пустить через [Flowseal/tg-ws-proxy](https://github.com/Flowseal/tg-ws-proxy) (локальный MTProxy, туннелирующий MTProto в WebSocket к `*.web.telegram.org`).

Критерий успеха: в существующем `.drone.yml` достаточно заменить `image`, добавить
`api_id`/`api_hash`/`proxy_host`/`proxy_secret` и сервис `tg-ws-proxy` — и те же шаблоны сообщений дают то же сообщение в Telegram.

Референсный пайплайн пользователя: `.drone.yml` в корне репозитория (шаблоны с `{{build.number}}`, `[…]({{build.link}})`, `{{ div (sub build.finished build.started) 60 }}`, `failure: ignore`).

## 2. Границы v1

Входит: текстовые сообщения, шаблоны, markdown/html, темы форумов, фильтр по email, Drone и Gitea/Forgejo Actions, Docker-образ.

Не входит (при указании — ошибка конфигурации с понятным текстом, а не молчаливый пропуск): `photo`, `document`, `sticker`, `audio`, `voice`, `video`, `location`, `venue`, `socks5`,
`format: MarkdownV2`. `env_file` не поддерживается (у оригинала он есть только в README).

## 3. Архитектура

TypeScript (strict), Node 22, ESM. Зависимости: `teleproto@1.229.0`, `handlebars`, `entities`.
Dev: `typescript`, `vitest`, `@types/node`.

```
src/
  env.ts          чтение env с алиасами, парсинг bool/int/list как urfave/cli
  config.ts       Config: сбор, валидация, запрет неподдерживаемых параметров
  ci-context.ts   DRONE_* / GITHUB_* → TemplateContext {repo, commit, build, gitHub, tpl}
  recipients.ts   порт parseTo() + @username
  helpers/        хелперы шаблонов: drone.ts (11 шт.), sprig.ts (подмножество), golang.ts
                  (Go-layout дат, Go-формат Duration, QueryEscape)
  template.ts     пайплайн рендера (§6.3) и сообщения по умолчанию
  markdown.ts     порт tdlib parse_markdown → {text, entities}
  telegram.ts     ожидание proxy, TelegramClient, логин бота, отправка, destroy
  redact.ts       маскирование секретов в любых строках логов/ошибок
  main.ts         оркестрация; режимы `send` (по умолчанию) и `session`
test/             vitest, по файлу на модуль
```

Поток `send`: env → Config + TemplateContext → рендер → разметка в entities → TCP-ожидание proxy → `TelegramClient.start({botAuthToken})` → `sendMessage` каждому получателю → `destroy()` → exit 0. Любая ошибка → строка в stderr с замаскированными секретами → exit 1.

Режим `session` (`docker run … image session`): логин ботом, печать StringSession в stdout, exit 0. Нужен, чтобы получить значение для параметра `session`.

## 4. Конфигурация

Каждый параметр `x_y` читается из env в порядке `PLUGIN_X_Y`, `TELEGRAM_X_Y`, `INPUT_X_Y` (первое непустое). Пустые/пробельные значения считаются незаданными. Bool — по правилам Go `strconv.ParseBool` (`1 t T TRUE true True 0 f F FALSE false False`), иное значение — ошибка. Списки — через запятую, элементы триммятся, пустые отбрасываются.

### 4.1. Как в drone-telegram

| Параметр | По умолчанию | Примечание |
|---|---|---|
| `token` | — | обязателен |
| `to` | — | обязателен, см. §8 |
| `message` | сообщение по умолчанию (§6.5) | может быть `http(s)://` или `file://` — тогда шаблон загружается |
| `message_file` | — | приоритетнее `message` |
| `template_vars` | — | JSON-объект строка→строка, доступен как `{{tpl.x}}` |
| `template_vars_file` | — | то же из файла; ключи файла перекрывают `template_vars` |
| `format` | `markdown` | `markdown` \| `html`, регистр не важен |
| `message_thread_id` | — | id темы форума |
| `disable_web_page_preview` | `false` | |
| `disable_notification` | `false` | |
| `only_match_email` | `false` | env: `PLUGIN_ONLY_MATCH_EMAIL`, `INPUT_ONLY_MATCH_EMAIL` |
| `debug` | `false` | подробный лог teleproto и id отправленных сообщений |

`template_vars` с нестроковыми значениями — ошибка (как `json.Unmarshal` в `map[string]string`).

### 4.2. Новые

| Параметр | По умолчанию | Примечание |
|---|---|---|
| `api_id` | — | обязателен, целое, с my.telegram.org |
| `api_hash` | — | обязателен |
| `proxy_host` | — | не задан → прямое MTProto-подключение без прокси |
| `proxy_port` | `1443` | |
| `proxy_secret` | — | обязателен при `proxy_host`; 32 hex, `dd`+32 hex или `ee`+32 hex+домен (hex или base64) |
| `session` | — | StringSession; если задан — повторного логина нет |
| `timeout` | `60` | секунды, общий дедлайн всего запуска |

## 5. CI-контекст

Режим Actions включается, если `GITHUB_ACTIONS=true` или `PLUGIN_GITHUB`/`GITHUB` истинно.

| Поле | Drone | Gitea/Forgejo Actions | Умолчание |
|---|---|---|---|
| `repo.FullName` | `DRONE_REPO` | `GITHUB_REPOSITORY` | |
| `repo.Namespace` | `DRONE_REPO_OWNER`, `DRONE_REPO_NAMESPACE` | `GITHUB_ACTOR` | |
| `repo.Name` | `DRONE_REPO_NAME` | часть `GITHUB_REPOSITORY` после `/` ¹ | |
| `commit.Sha` | `DRONE_COMMIT_SHA` | `GITHUB_SHA` | |
| `commit.Ref` | `DRONE_COMMIT_REF` | `GITHUB_REF` | |
| `commit.Branch` | `DRONE_COMMIT_BRANCH` | `GITHUB_REF_NAME` ¹ | `master` |
| `commit.Link` | `DRONE_COMMIT_LINK` | `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/commit/$GITHUB_SHA` ¹ | |
| `commit.Author` | `DRONE_COMMIT_AUTHOR` | — | |
| `commit.Email` | `DRONE_COMMIT_AUTHOR_EMAIL` | — | |
| `commit.Avatar` | `DRONE_COMMIT_AUTHOR_AVATAR` | — | |
| `commit.Message` | `DRONE_COMMIT_MESSAGE` | — | |
| `build.Event` | `DRONE_BUILD_EVENT` | `GITHUB_EVENT_NAME` ¹ | `push` |
| `build.Number` | `DRONE_BUILD_NUMBER` | `GITHUB_RUN_NUMBER` ¹ | `0` |
| `build.Status` | `DRONE_BUILD_STATUS` | — | `success` |
| `build.Link` | `DRONE_BUILD_LINK` | `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID` ¹ | |
| `build.Tag` | `DRONE_TAG` | — | |
| `build.PR` | `DRONE_PULL_REQUEST` | — | |
| `build.Started` | `DRONE_STAGE_STARTED` (sic, как в оригинале) | — | `0` |
| `build.Finished` | `DRONE_BUILD_FINISHED` | — | `0` |
| `build.DeployTo` | `DRONE_DEPLOY_TO` | — | |
| `gitHub.Workflow` / `Action` / `EventName` / `EventPath` / `Workspace` | — | `GITHUB_WORKFLOW` / `GITHUB_ACTION` / `GITHUB_EVENT_NAME` / `GITHUB_EVENT_PATH` / `GITHUB_WORKSPACE` | |

¹ — нет в оригинале (там эти поля в Actions пустые); добавлено, т.к. это бесплатно и полезно.
Числовые поля (`Number`, `Started`, `Finished`) — числа; нечисловое значение env → `0`.

## 6. Шаблоны

### 6.1. Поиск полей (как в raymond)

raymond ищет поле структуры по точному имени или по `strings.Title(name)`. Поэтому контекст строится так, что каждое поле доступно под двумя ключами: Go-именем и им же с первой строчной буквой. `{{repo.FullName}}` и `{{repo.fullName}}` работают, `{{repo.fullname}}` — пусто (как в оригинале). Корневые ключи: `repo`/`Repo`, `commit`/`Commit`, `build`/`Build`, `gitHub`/`GitHub`, `tpl`/`Tpl`, плюс алиас `github` ². Ключи `tpl` — точные (это map). `config` в контекст **не** попадает ² — в оригинале через `{{config.token}}` можно было вывести токен.

### 6.2. Хелперы

Все встроенные Handlebars (`if`, `unless`, `each`, `with`, `lookup`, `log`) и raymond `equal`.

drone-template-lib, семантика 1:1 с Go-кодом:
`success`, `failure` (блочные; `failure` истинен для `failure`/`error`/`killed`), `truncate`
(по рунам, отрицательная длина — отбросить N рун с начала), `since`, `duration` (Go
`Duration.String()` на целых секундах: `0s`, `45s`, `2m5s`, `1h0m0s`), `datetime` (Go-layout,
IANA-зона, неизвестная зона → локальная), `uppercasefirst`, `uppercase`, `lowercase`,
`urlencode` (блочный, Go `url.QueryEscape`), `regexReplace`.

Подмножество sprig (порядок аргументов как в sprig; `add`/`add1`/`sub`/`mul`/`div`/`mod`/`max`/`min` возвращают int64-семантику — `div` и `mod` целочисленные с усечением к нулю; аргументы приводятся как `toInt64`):
- математика: `add`, `add1`, `sub`, `mul`, `div`, `mod`, `max`, `min`, `floor`, `ceil`, `round`
- строки: `trim`, `trimAll`, `trimPrefix`, `trimSuffix`, `upper`, `lower`, `title`, `replace`,
  `contains`, `hasPrefix`, `hasSuffix`, `trunc`, `abbrev`, `substr`, `repeat`, `quote`, `squote`,
  `nospace`, `indent`, `nindent`, `plural`, `cat`, `toString`, `atoi`, `int`, `int64`
- значения по умолчанию: `default`, `empty`, `coalesce`, `ternary`
- даты: `now`, `date`, `dateInZone`, `unixEpoch`, `ago`
- regex: `regexMatch`, `regexFind`, `regexReplaceAll`
- прочее: `b64enc`, `b64dec`, `env`, `expandenv`

Прочие хелперы sprig — ошибка рендера вида `helper "X" is not supported (sprig subset, see README)`.

### 6.3. Пайплайн рендера (повторяет drone-telegram)

1. Источник: `message_file` → `message` → сообщение по умолчанию (тогда `format` принудительно `markdown`, как в оригинале). Если текст шаблона целиком — `http(s)://` или `file://` URL, он загружается здесь же, и дальше загруженный текст обрабатывается как обычный шаблон. (Оригинал грузит на шаге 4, поэтому экранирует `_` в самой строке URL и не экранирует загруженный шаблон — это баг, не воспроизводим.)
2. Трим пробельных символов; пустой шаблон → предупреждение, ничего не отправляется, exit 0.
3. Только `markdown`: `_` → `\_` (сначала `\_` → `_`, чтобы не удвоить) в тексте шаблона **вне
   `{{…}}`** ² и в полях `commit.Message/Branch/Link/Author/Email`, `build.Tag/Link/PR`,
   `repo.Namespace/Name`. (Оригинал экранирует и внутри `{{…}}`, из-за чего `{{tpl.deploy_env}}`
   даёт ошибку разбора шаблона.)
4. Handlebars с HTML-экранированием значений (как raymond), затем trim `" \n"` по краям.
5. HTML-unescape всего результата (`entities.decodeHTML`, аналог Go `html.UnescapeString`).
6. Разметка (§7).

### 6.4. Контекст рендера один на всех получателей

Рендер выполняется один раз; каждому получателю уходит один и тот же текст.

### 6.5. Сообщения по умолчанию (символ в символ)

Drone (иконка по `lower(build.Status)`: `success`→✅, `failure`→❌, `cancelled`→❕, иначе пусто):

```
{icon} Build #{build.Number} of `{repo.FullName}` {build.Status}.

📝 Commit by {commit.Author} on `{commit.Branch}`:
``` {commit.Message} ```

🌐 {build.Link}
```

Actions: `{repo.FullName}/{gitHub.Workflow} triggered by {repo.Namespace} ({gitHub.EventName})`.

Как и в оригинале, сообщение по умолчанию собирается подстановкой и затем проходит шаги 3–6.

## 7. Разметка

Сервер MTProto не разбирает разметку — клиент сам превращает текст в `MessageEntity[]`.
Markdown-парсер teleproto использует другой синтаксис (`**bold**`), поэтому свой.

### 7.1. `markdown` — порт tdlib `parse_markdown`

Эталон — `td/telegram/MessageEntity.cpp`, `parse_markdown(string &text)` (легаси `parse_mode=Markdown` в Bot API). Порт по шагам алгоритма:
- вне сущности `\` перед `_ * \` [` — экранирование; прочие символы копируются;
- `_…_` → Italic, `*…*` → Bold, `` `…` `` → Code, ```` ```lang\n…``` ```` → Pre/PreCode
  (язык до первого пробела/перевода строки, один перевод строки после открытия пропускается);
- `[text](url)` → TextUrl; `[url]` без `(…)` — текст используется как URL; URL проверяется как в `get_checked_link` (без схемы — `http://`; невалидный — сущность не создаётся, текст остаётся);
- внутри сущности символы копируются как есть до закрывающего, **кроме** ²: `\_` в любом месте —
  в тексте сущности (включая code/pre) и в URL — даёт `_`. Обоснование: после шага 3 §6.3 каждое
  `_` превращено в `\_`, и других `\_` не остаётся, так что это всегда наше экранирование. Это
  устраняет баги оригинала: видимый `\_` в `[{{commit.message}}](…)` и в блоке ``` сообщения по
  умолчанию, битые URL из `commit.Link`/`build.Link` с `_`. Прочие `\*`, `` \` ``, `\[` внутри
  сущностей — литерально, как в tdlib;
- пустая сущность не создаётся;
- смещения/длины в UTF-16 code units (строки JS — UTF-16 нативно; эмодзи = 2 единицы).

Второе отклонение ²: где tdlib возвращает ошибку `Can't find end of the entity`
(незакрытый разделитель), порт выводит открывающий символ как обычный текст и продолжает разбор с позиции сразу после него. Уведомление не должно теряться из-за `*` в сообщении коммита.

### 7.2. `html`

HTML-парсер teleproto (`extensions/html.ts`). Поддерживаемые теги — какие поддерживает он; некорректный HTML не приводит к ошибке.

### 7.3. Длина

Текст после разбора длиннее 4096 UTF-16 единиц → ошибка `message too long (N > 4096)`, без разбиения.

## 8. Получатели

Порт `parseTo(to, authorEmail, matchEmail)` 1:1, с одним расширением: кроме числа, идентификатором
может быть `@username` ².

- Элемент `id` → в общий список. Элемент `id:email` → учитывается, только если `email` совпадает
  с `commit.Email`.
- Если `only_match_email` и хотя бы один `id:email` совпал — отправка только совпавшим.
  Иначе — общий список, затем совпавшие по email.
- Нечисловой идентификатор без `@` — пропускается (как в оригинале), с предупреждением в лог.

Идентификаторы: `123` — пользователь; `-100…` — канал/супергруппа; `-123` — обычная группа;
`@name` — резолв через `contacts.resolveUsername`. Для числовых id бот использует `access_hash = 0`
(teleproto делает это сам: `client/users.ts`).

## 9. Подключение, отправка, ошибки

1. **Ожидание proxy.** Если задан `proxy_host` — TCP-connect к `host:port` раз в 1 с до дедлайна.
   Неудача → `proxy tg-ws-proxy:1443 is not reachable after 60s`.
2. **Клиент.** `new TelegramClient(new StringSession(session ?? ""), apiId, apiHash, {proxy:
   {ip, port, secret, MTProxy: true}, connectionRetries: 3, floodSleepThreshold: <остаток
   дедлайна, но не больше 60>})`. Логгер teleproto: `error`, при `debug` — `debug`.
3. **Логин.** `client.start({botAuthToken: token})` (при заданном `session` запросов логина нет).
4. **Отправка.** Для каждого получателя последовательно: `client.sendMessage(peer, {message: text,
   formattingEntities, linkPreview: !disable_web_page_preview, silent: disable_notification,
   replyTo: message_thread_id})`. Ошибка одного получателя не останавливает остальных ² (оригинал
   останавливался на первой); итоговый exit 1, если хоть одна отправка не удалась.
5. **Завершение.** В `finally` — `client.destroy()`, затем явный `process.exit(code)`.
6. **Дедлайн.** Всё выполнение обёрнуто в общий таймаут `timeout`; по истечении — exit 1 с
   указанием этапа (proxy / login / send).
7. **FLOOD_WAIT** длиннее остатка дедлайна → ошибка с подсказкой использовать `session`.
8. **Маскирование.** Значения `token`, `api_hash`, `proxy_secret`, `session` заменяются на
   `<redacted>` во всех выводимых строках.
9. **Лог** (stdout): по строке на получателя — `sent to <peer> (message id N)`.

## 10. Упаковка и примеры

- `Dockerfile`: multi-stage `node:22-alpine` (сборка `tsc`, затем runtime с prod-зависимостями),
  `USER node`, `ENTRYPOINT ["node", "/app/dist/main.js"]`. Full ICU в официальном образе Node —
  `datetime`/`dateInZone` с IANA-зонами работают без tzdata.
- tg-ws-proxy не публикует образ: README описывает сборку из
  `https://github.com/Flowseal/tg-ws-proxy` и пуш в свой registry.
- `examples/drone.yml` — миграция референсного пайплайна:

```yaml
services:
  - name: tg-ws-proxy
    image: <registry>/tg-ws-proxy:latest
    environment:
      TG_WS_PROXY_SECRET:
        from_secret: TG_PROXY_SECRET

notify-template: &notify-template
  image: <registry>/drone-telegram-mtproto:1
  settings:
    token:        { from_secret: TG_BOT_TOKEN }
    to:           { from_secret: TG_BOT_CHATID }
    api_id:       { from_secret: TG_API_ID }
    api_hash:     { from_secret: TG_API_HASH }
    proxy_host:   tg-ws-proxy
    proxy_secret: { from_secret: TG_PROXY_SECRET }
  failure: ignore
```

- `examples/gitea.yml` — job с `services: tg-ws-proxy` и шагом
  `uses: docker://<registry>/drone-telegram-mtproto:1` с параметрами в `with:` (→ `INPUT_*`).
- `README.md` на русском: параметры, миграция с drone-telegram, получение `api_id`/`api_hash`,
  режим `session`, таблица отклонений (§13), настройка `TG_WS_PROXY_DC_IPS`.

## 11. Тестирование

vitest, без сети:
- `env`/`config`: алиасы и приоритет, ParseBool, пустые значения, валидация обязательных,
  ошибки на неподдерживаемые параметры, форматы `proxy_secret`.
- `ci-context`: Drone и Actions из фиксированных env, умолчания, двойные ключи §6.1.
- `recipients`: кейсы `parseTo` из `plugin_test.go` оригинала + `@username`.
- `helpers`: каждый хелпер, отдельно `div`/`mod` на отрицательных и дробных, Go-layout, Go-Duration,
  QueryEscape.
- `template`: сообщения по умолчанию (эталонные строки), все три шаблона из референсного
  `.drone.yml` (эталонный результат, включая время сборки), экранирование `_`, unescape.
- `markdown`: табличные кейсы из `td/test/message_entities.cpp` (`parse_markdown`) — успешные
  1:1, ошибочные — по правилу §7.1; эмодзи и кириллица в смещениях; `\_` внутри
  Italic/Bold/Code/Pre, текста ссылки и URL → `_`.
- `redact`.

E2E (`npm run e2e`, только при заданных `E2E_TOKEN`, `E2E_API_ID`, `E2E_API_HASH`, `E2E_TO`):
docker compose — tg-ws-proxy (сборка из git URL) + образ плагина, реальная отправка.

## 12. Риски и первый шаг

**Первая задача плана — спайк** (одноразовый скрипт, в репозиторий не идёт): teleproto →
tg-ws-proxy (Docker, настройки по умолчанию: WS только для DC2/DC4) → бот → отправка в личку,
в `-100…`-группу и в тему форума. Проверяем:
- совместимость рукопожатия MTProxy (plain и `dd` secret);
- на какой DC попадает бот и уходит ли он в fallback (CfProxy/TCP) для DC1/3/5;
- `replyTo: message_thread_id` действительно пишет в тему;
- резолв `-100…` через `access_hash = 0` на пустой сессии.

Если что-то из этого не работает — возврат к дизайну до написания основного кода.

Прочие риски: достижимость сервиса по имени из шага `docker://` в Gitea act_runner (проверяется в e2e/на реальном раннере); лимиты Telegram на частый `importBotAuthorization` (смягчается `session`).

## 13. Отклонения от drone-telegram (сводка)

Помечены ² по тексту.

| Где | Оригинал | Здесь |
|---|---|---|
| Незакрытая markdown-сущность | ошибка Bot API, сообщение не уходит | символ выводится как текст, сообщение уходит |
| `_` внутри сущностей и URL (`[{{commit.message}}](…)`, ``` в сообщении по умолчанию, ссылки на репо с `_`) | виден `\_`, URL с `\_` | `_` |
| `_` внутри `{{…}}` (`{{tpl.deploy_env}}`) в markdown | экранируется → ошибка разбора шаблона | не трогается |
| Ошибка отправки одному получателю | остановка | остальные получают, exit 1 |
| `to` | только числа | числа и `@username` |
| Поля Actions (`repo.Name`, `commit.Branch/Link`, `build.Number/Link/Event`) | пустые | заполняются |
| `{{github.x}}` | пусто (raymond ищет `Github`) | работает (алиас) |
| `{{config.x}}` | доступен, включая токен | недоступен |
| sprig | весь GenericFuncMap | подмножество §6.2 |
| `format` | `Markdown` с экранированием `_`, `markdown` — без | экранирование при любом регистре |
| Медиа, location/venue, socks5, MarkdownV2 | есть | ошибка конфигурации (вне v1) |
| Голые env-имена (`FORMAT`, `DEBUG`, `PHOTO`…) | читаются | не читаются — только `PLUGIN_`/`TELEGRAM_`/`INPUT_` |
| Шаблон по URL | `_` экранируется в строке URL, загруженный текст — нет | загруженный текст обрабатывается как обычный шаблон |
| Учётные данные | `token` | `token` + `api_id` + `api_hash` (+ `session`) |
