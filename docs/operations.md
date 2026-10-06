# Эксплуатация и диагностика

Что делать, когда уведомление не пришло или шаг упал. Настройка и параметры — в
[README](../README.md), внутреннее устройство — в [architecture.md](architecture.md).

## Как читать вывод шага

Плагин всегда завершается с кодом 0 или 1 и пишет одну строку на событие:

```
sent to -1001234567890 (message id 4812)      успех, по строке на получателя
warning: …                                     шаг продолжается, код 0
error: …                                       шаг упал, код 1
failed to send to <peer>: …                    этот получатель не получил, остальные получили, код 1
```

Токен, `api_hash`, proxy-секрет и строка сессии в выводе заменяются на `<redacted>`. Если вы видите
секрет в логах CI — это дефект, сообщите о нём.

**Важно про `failure: ignore`.** В примерах у шагов уведомления стоит `failure: ignore`, чтобы сломанное
уведомление не ломало сборку. Побочный эффект: ошибку шага легко не заметить. Если уведомления просто
не приходят — откройте лог самого шага, там будет строка `error:`.

## Ошибки конфигурации

Эти падают сразу, до всякой сети.

| Сообщение | Причина | Что делать |
|---|---|---|
| `missing required settings: token, to, api_id, api_hash` | перечисленные параметры не заданы или пусты | задать их; в Drone проверьте, что секрет существует и доступен этой сборке |
| `PLUGIN_PHOTO is not supported: drone-telegram-mtproto v1 sends text messages only` | задан параметр медиа (`photo`, `document`, `sticker`, `audio`, `voice`, `video`, `location`, `venue`) или `socks5` | убрать параметр: в v1 отправляется только текст |
| `PLUGIN_FORMAT: format "MarkdownV2" is not supported, use markdown or html` | `format: MarkdownV2` | `markdown` или `html` |
| `PLUGIN_FORMAT: invalid format "bbcode", expected markdown or html` | опечатка в `format` | исправить значение |
| `PLUGIN_API_ID: invalid integer "abc"` | нечисловое значение там, где ждут число | исправить; пустое значение считается незаданным |
| `PLUGIN_DEBUG: invalid boolean "yes"` | значение вне набора Go: `1 t T TRUE true True 0 f F FALSE false False` | написать `true` или `false` |
| `proxy_secret is required when proxy_host is set` | задан `proxy_host` без секрета | добавить `proxy_secret`, тот же, что у сервиса |
| `PLUGIN_PROXY_SECRET: must be 32 hex chars, "dd" + 32 hex, or "ee" + 32 hex + hex-encoded domain` | секрет не того формата | `openssl rand -hex 16`; подходят и ссылки `dd…`/`ee…` из логов прокси |
| `PLUGIN_PROXY_PORT: port must be 1..65535` | порт вне диапазона | исправить |
| `PLUGIN_API_ID: must be a positive integer` | `0` или отрицательное | взять настоящий `api_id` с my.telegram.org |
| `unknown command "foo", expected "session" or no command` | лишний аргумент у образа | убрать его либо оставить только `session` |

## Ошибки шаблона

| Сообщение | Причина | Что делать |
|---|---|---|
| `helper "semver" is not supported (sprig subset, see README)` | функция sprig вне поддерживаемых 53 | взять другую или посчитать значение заранее и передать через `template_vars` |
| `template error: …` | шаблон не разбирается | чаще всего незакрытая `{{`; проверьте переносы в YAML-блоке |
| `error loading message file 'msg.tpl': …` | `message_file` недоступен в контейнере | путь относительно рабочей директории шага; файл должен быть в репозитории или создан предыдущим шагом |
| `template_vars must be a JSON object with string values` | в JSON нечисловые типы: `{"n": 1}` | все значения строками: `{"n": "1"}` |
| `message too long (5000 > 4096)` | текст превысил лимит Telegram | укоротить, например `{{truncate commit.message 200}}` |

Пустое поле в сообщении вместо значения — это не ошибка, а поведение шаблонизатора: либо опечатка в
имени переменной, либо правило raymond (`{{repo.fullname}}` пусто, `{{repo.fullName}}` работает), либо
вызов неподдерживаемой функции sprig без аргументов, например `{{uuidv4}}`.

## Ошибки сети и Telegram

| Сообщение | Причина | Что делать |
|---|---|---|
| `proxy tg-ws-proxy:1443 is not reachable after 60s` | сервис MTProxy не поднялся или имя не разрешается | проверьте, что сервис объявлен в том же пайплайне и его имя совпадает с `proxy_host`; посмотрите лог самого сервиса |
| `timed out after 60s during login` | подключение или логин не успели | поднять `timeout`; если повторяется — смотрите раздел про дата-центры |
| `timed out after 60s during send` | Telegram не ответил на отправку | поднять `timeout`, проверить лог прокси |
| `Telegram FLOOD_WAIT of 300s exceeds the remaining time; set the "session" setting to avoid logging the bot in on every run` | слишком частые логины бота | завести `session`, см. ниже |
| `Telegram FLOOD_WAIT of 12s` | обычное ограничение частоты | повторить позже; при частых сборках помогает `session` |
| `failed to send to 123: Could not find the input entity for …` | сообщение от teleproto: бот не видит получателя | для личного чата получатель должен сам написать боту `/start`; для группы или канала бот должен быть участником, а id иметь вид `-100…` |
| `recipient id 99999999999999999999 is out of range` | id не похож на настоящий | проверьте значение; у каналов это `-100` плюс цифры |
| `skipping recipient "中文ID": not a numeric id or @username` | предупреждение: элемент `to` не распознан | только числовой id или `@username` длиной от 5 символов |

## Этапы и таймаут

`timeout` (по умолчанию 60 с) ограничивает весь запуск. В сообщении о таймауте всегда назван этап:
`render`, `proxy`, `login` или `send` — по нему понятно, где именно встали. Ошибки конкретного этапа
приоритетнее общего таймаута: если не поднялся прокси, вы увидите `proxy … is not reachable`, а не
безликое `timed out`.

## tg-ws-proxy и дата-центры

Это главный источник трудноуловимых проблем, и он вне кода плагина.

По умолчанию tg-ws-proxy туннелирует через WebSocket только DC2 и DC4:
`TG_WS_PROXY_DC_IPS="2:149.154.167.220 4:149.154.167.220"`. Остальные дата-центры идут в fallback —
CfProxy или прямой TCP. Если бот живёт на другом DC, а прямой доступ закрыт, логин будет истекать по
таймауту без внятной причины.

Что делать:

1. Запустите прокси с подробным логом и посмотрите строки с номером DC и словом `fallback`.
2. Добавьте нужный DC в `TG_WS_PROXY_DC_IPS` сервиса.
3. Проверьте, что секрет у сервиса и у плагина один и тот же.

Полезно: `docker logs <контейнер-прокси> | grep -E 'DC[0-9]|fallback|handshake'`.

## Режим `session`

Без `session` бот логинится при каждом запуске, и при частых сборках Telegram отвечает `FLOOD_WAIT`.
Получите строку сессии один раз:

```sh
docker run --rm \
  -e PLUGIN_TOKEN=… -e PLUGIN_API_ID=… -e PLUGIN_API_HASH=… \
  registry.example.com/drone-telegram-mtproto:1 session
```

Команда печатает строку в stdout. Положите её в секреты CI и передавайте параметром `session`.
Строка даёт полный доступ к боту — храните как токен.

## Подробный лог

`debug: true` включает подробный лог teleproto и печатает id отправленных сообщений. Токен в этот лог
не попадает: логгер teleproto печатает только имена типов запросов, не их содержимое.

## Чек-лист «уведомление не пришло»

1. Шаг вообще запускался? Проверьте `when`/`depends_on` и условия вроде `status: [failure]`.
2. В логе шага есть строка `error:` или `warning:`? Из-за `failure: ignore` шаг выглядит зелёным.
3. `warning: message is empty, nothing to send` — шаблон отрендерился пустым.
4. `warning: no recipients left after filtering, nothing to send` — все элементы `to` отфильтрованы:
   либо не распознаны, либо `only_match_email` не нашёл совпадения с автором коммита.
5. Шаблон слит правильно? В YAML слияние `<<:` неглубокое: если шаг задаёт свой `settings`, он целиком
   заменяет шаблонный вместе с `token` и `to`. Сливать нужно карту настроек —
   см. [`examples/drone.yml`](../examples/drone.yml).
6. Бот может писать получателю? Личный чат требует `/start` от пользователя, группа — участия бота.
7. Если всё выше в порядке — проверьте связку вживую: `npm run e2e` с вашими учётными данными.

## Проверка вживую

```sh
E2E_TOKEN=… E2E_API_ID=… E2E_API_HASH=… E2E_TO="<user_id>,-100<group_id>" npm run e2e
```

Поднимает tg-ws-proxy из его git-репозитория рядом с образом плагина и отправляет одно настоящее
сообщение. Без этих переменных тест пропускается с кодом 0, поэтому в CI без секретов он не мешает.
