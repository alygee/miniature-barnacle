# drone-telegram-mtproto

Замена [appleboy/drone-telegram](https://github.com/appleboy/drone-telegram) для CI-уведомлений в Telegram,
которая ходит не в Bot API (`api.telegram.org`), а по MTProto — через
[tg-ws-proxy](https://github.com/Flowseal/tg-ws-proxy), который туннелирует MTProto в WebSocket к `*.web.telegram.org`.

```
шаг пайплайна ──MTProto (MTProxy)──▶ сервис tg-ws-proxy ──WSS──▶ Telegram
```

Шаблоны сообщений, переменные (`{{build.number}}`, `{{commit.message}}` …), хелперы и параметры — как у
drone-telegram. Отличия собраны в [таблице](#отличия-от-drone-telegram).

Версия 1 отправляет только текст: фото, документы, стикеры, геолокация и `socks5` не поддерживаются
(указание такого параметра — ошибка конфигурации).

## Что понадобится

1. **Бот** — токен от [@BotFather](https://t.me/BotFather). Как и с Bot API, писать можно только тем, кто
   запустил бота, и в группы/каналы, где он состоит.
2. **`api_id` и `api_hash`** — на [my.telegram.org](https://my.telegram.org) → API development tools.
   MTProto требует их даже для ботов.
3. **Секрет прокси** — 32 hex-символа: `openssl rand -hex 16`.
4. **Образы в своём registry.** tg-ws-proxy не публикует образ:

   ```sh
   git clone https://github.com/Flowseal/tg-ws-proxy && cd tg-ws-proxy
   docker build -t registry.example.com/tg-ws-proxy:latest . && docker push registry.example.com/tg-ws-proxy:latest

   git clone <этот репозиторий> && cd drone-telegram-mtproto
   docker build -t registry.example.com/drone-telegram-mtproto:1 . && docker push registry.example.com/drone-telegram-mtproto:1
   ```

## Drone

Полный пример — [`examples/drone.yml`](examples/drone.yml). Суть миграции:

```yaml
services:
  - name: tg-ws-proxy
    image: registry.example.com/tg-ws-proxy:latest
    environment:
      TG_WS_PROXY_SECRET:
        from_secret: TG_PROXY_SECRET

tg-settings: &tg-settings
  token:        { from_secret: TG_BOT_TOKEN }
  to:           { from_secret: TG_BOT_CHATID }
  api_id:       { from_secret: TG_API_ID }
  api_hash:     { from_secret: TG_API_HASH }
  proxy_host:   tg-ws-proxy
  proxy_secret: { from_secret: TG_PROXY_SECRET }

steps:
  - name: notify
    image: registry.example.com/drone-telegram-mtproto:1
    failure: ignore
    settings:
      <<: *tg-settings
      message: |
        ✅ Сборка [#{{build.number}}]({{build.link}}) прошла успешно
```

> **Осторожно с `<<:`.** Слияние YAML неглубокое: если шаблон шага содержит `settings`, а шаг задаёт свой
> `settings:`, то шаблонный `settings` (с `token` и `to`) целиком заменяется. Сливайте именно карту
> настроек, как выше.

Плагин ждёт, пока сервис `tg-ws-proxy` начнёт принимать соединения (до `timeout` секунд), так что
отдельный шаг ожидания не нужен.

## Gitea / Forgejo Actions

Пример — [`examples/gitea.yml`](examples/gitea.yml): `services: tg-ws-proxy` в job и шаг
`uses: docker://registry.example.com/drone-telegram-mtproto:1` с параметрами в `with:`. Статус job
в Actions нет в переменных окружения — передайте его через `template_vars: '{"status": "${{ job.status }}"}'`.

## Параметры

Каждый параметр читается из `PLUGIN_<ИМЯ>`, `TELEGRAM_<ИМЯ>` или `INPUT_<ИМЯ>` (первое непустое):
`settings.api_id` в Drone → `PLUGIN_API_ID`, `with.api_id` в Actions → `INPUT_API_ID`.

| Параметр | По умолчанию | Описание |
|---|---|---|
| `token` | — | токен бота, **обязателен** |
| `to` | — | получатели через запятую, **обязателен**, см. ниже |
| `api_id`, `api_hash` | — | с my.telegram.org, **обязательны** |
| `proxy_host` | — | имя/адрес tg-ws-proxy; без него — прямое подключение к Telegram |
| `proxy_port` | `1443` | |
| `proxy_secret` | — | секрет tg-ws-proxy: 32 hex, `dd…` или `ee…` |
| `message` | сообщение drone-telegram | шаблон; если это ровно один `http(s)://` или `file://` URL — шаблон загружается оттуда |
| `message_file` | — | шаблон из файла (приоритетнее `message`) |
| `template_vars` | — | JSON-объект строк, доступен как `{{tpl.имя}}` |
| `template_vars_file` | — | то же из файла, перекрывает `template_vars` |
| `format` | `markdown` | `markdown` (легаси-Markdown Bot API) или `html` |
| `message_thread_id` | — | id темы форума |
| `disable_web_page_preview` | `false` | |
| `disable_notification` | `false` | беззвучная отправка |
| `only_match_email` | `false` | см. получатели; только `PLUGIN_`/`INPUT_` |
| `session` | — | StringSession, см. ниже |
| `timeout` | `60` | секунд на весь запуск: ожидание прокси, логин, отправка |
| `debug` | `false` | подробный лог teleproto |

### Получатели (`to`)

- `123456` — пользователь, `-100…` — канал/супергруппа, `-123…` — обычная группа, `@username`;
- `id:email` — получит сообщение, только если `email` совпадает с автором коммита;
- с `only_match_email: true` при совпадении хотя бы одного `id:email` сообщение уходит только совпавшим.

Ошибка отправки одному получателю не мешает остальным; шаг завершится с кодом 1.

### Сессия (`session`)

Без `session` бот логинится при каждом запуске. При частых сборках Telegram может ответить `FLOOD_WAIT`.
Сохраните сессию один раз и передавайте её как секрет:

```sh
docker run --rm -e PLUGIN_TOKEN=… -e PLUGIN_API_ID=… -e PLUGIN_API_HASH=… \
  registry.example.com/drone-telegram-mtproto:1 session
```

Команда печатает строку сессии. Она даёт полный доступ к боту — храните как токен.

## Шаблоны

Handlebars с правилами raymond (как в drone-telegram): поле доступно по Go-имени или с маленькой первой буквой —
`{{repo.FullName}}` и `{{repo.fullName}}` работают, `{{repo.fullname}}` — пусто.

| Объект | Поля |
|---|---|
| `repo` | `fullName`, `namespace`, `name` |
| `commit` | `sha`, `ref`, `branch`, `link`, `author`, `avatar`, `email`, `message` |
| `build` | `tag`, `event`, `number`, `status`, `link`, `started`, `finished`, `PR`, `deployTo` |
| `github` (`gitHub`) | `workflow`, `workspace`, `action`, `eventName`, `eventPath` |
| `tpl` | ваши `template_vars` |

Хелперы drone-template-lib: `success`, `failure`, `truncate`, `since`, `duration`, `datetime`,
`uppercasefirst`, `uppercase`, `lowercase`, `urlencode`, `regexReplace`, а также `equal`.

Подмножество [sprig](https://masterminds.github.io/sprig/) (аргументы как в sprig; `div`/`mod` — целочисленные):
`add add1 sub mul div mod max min floor ceil round`,
`trim trimAll trimPrefix trimSuffix upper lower title replace contains hasPrefix hasSuffix trunc abbrev substr repeat quote squote nospace indent nindent plural cat toString atoi int int64`,
`default empty coalesce ternary`, `now date dateInZone unixEpoch ago`, `regexMatch regexFind regexReplaceAll`,
`b64enc b64dec env expandenv`. Прочие функции sprig, вызванные с аргументами, завершают шаг ошибкой `helper "X" is not supported (sprig subset, see README)`; вызванные без аргументов (например `{{uuidv4}}`) — отображаются пустой строкой, так как Handlebars не отличает такой вызов от отсутствующего поля.

Пример: `{{ div (sub build.finished build.started) 60 }} мин {{ mod (sub build.finished build.started) 60 }} с`.

### Разметка

`markdown` — легаси-Markdown Bot API: `*жирный*`, `_курсив_`, `` `код` ``, ```` ```язык … ``` ````,
`[текст](url)`. Как и в drone-telegram, `_` в тексте и в полях коммита экранируется, так что `_курсив_` не
работает, зато имена веток вроде `fix_login` не ломают разметку. `html` — `<b>`, `<i>`, `<code>`, `<pre>`,
`<a href>` и т.д.

## tg-ws-proxy и дата-центры

По умолчанию tg-ws-proxy пускает через WebSocket только DC2 и DC4 (`TG_WS_PROXY_DC_IPS="2:149.154.167.220 4:149.154.167.220"`),
остальные DC идут через fallback (CfProxy или прямой TCP). Если бот живёт на другом DC и прямой доступ
закрыт, добавьте его в `TG_WS_PROXY_DC_IPS` сервиса.

## Отличия от drone-telegram

| Где | drone-telegram | Здесь |
|---|---|---|
| Транспорт | Bot API по HTTPS | MTProto через MTProxy; нужны `api_id`/`api_hash` |
| Незакрытая разметка (`*` в коммите) | ошибка, сообщение не уходит | символ остаётся текстом |
| `_` внутри ссылок и блоков кода | виден как `\_`, ссылки с `_` ломаются | `_` |
| `_` внутри `{{…}}` в markdown | ошибка разбора шаблона | не трогается |
| Ошибка одному получателю | остановка | остальные получают, код 1 |
| `to` | только числа | числа и `@username` |
| Поля в Actions (`repo.name`, `commit.branch/link`, `build.number/link/event`) | пустые | заполняются |
| `{{github.x}}` | пусто | работает |
| `{{config.x}}` | доступен (включая токен) | недоступен |
| sprig | все функции | подмножество |
| Медиа, location/venue, socks5, MarkdownV2 | есть | нет (ошибка конфигурации) |
| Голые env-имена (`FORMAT`, `DEBUG`, `PHOTO`) | читаются | только с префиксами |

## Разработка

```sh
npm ci
npm test            # unit-тесты, без сети
npm run typecheck
npm run build
E2E_TOKEN=… E2E_API_ID=… E2E_API_HASH=… E2E_TO=… npm run e2e   # реальная отправка через tg-ws-proxy
```
