# Встраивание в существующий пайплайн Drone

Пошаговый перенос уведомлений с `appleboy/drone-telegram` на этот плагин. Рабочий пример целиком — в [`examples/drone.yml`](../examples/drone.yml), разбор ошибок — в [operations.md](operations.md).

## Что меняется, а что остаётся

Остаются: тексты шаблонов сообщений, секреты с токеном и получателем, `when`, `depends_on`, `failure: ignore` — всё это переносится без правок. Меняются: образ шага, три новых параметра (`api_id`, `api_hash`, `proxy_secret`), указание на прокси (`proxy_host`) и новый сервис `tg-ws-proxy` в пайплайне.

## 1. Соберите два образа

tg-ws-proxy не публикует готовый образ, поэтому собираются оба и кладутся в ваш registry:

```sh
git clone https://github.com/Flowseal/tg-ws-proxy && cd tg-ws-proxy
docker build -t registry.example.com/tg-ws-proxy:latest . && docker push registry.example.com/tg-ws-proxy:latest
cd ..

git clone <этот-репозиторий> && cd drone-telegram-mtproto
docker build -t registry.example.com/drone-telegram-mtproto:1 . && docker push registry.example.com/drone-telegram-mtproto:1
```

## 2. Добавьте секреты

Существующие `TG_BOT_TOKEN` и `TG_BOT_CHATID` не трогаются. Нужны три новых:

```sh
export DRONE_SERVER=https://drone.example.com DRONE_TOKEN=…
R=org/repo

drone secret add --repository $R --name TG_API_ID       --data 12345678
drone secret add --repository $R --name TG_API_HASH     --data <32-hex>
drone secret add --repository $R --name TG_PROXY_SECRET --data $(openssl rand -hex 16)
```

`api_id` и `api_hash` берутся на [my.telegram.org](https://my.telegram.org) → API development tools. Это идентификатор приложения, а не бота: MTProto требует, чтобы клиент представился, поэтому Bot API их и не спрашивал. Одна пара годится для любого числа ботов и не истекает.

`TG_PROXY_SECRET` — произвольные 32 hex-символа. Он нужен лишь для того, чтобы плагин и прокси внутри пайплайна узнали друг друга, и наружу не уходит.

Если секреты общие для нескольких репозиториев, используйте `drone orgsecret add`. Учтите, что в сборках по `pull_request` секреты по умолчанию недоступны — уведомления в таких пайплайнах не заработают.

## 3. Проверьте доступ раннера

Плагин ходит в Telegram через прокси, а прокси — на `149.154.167.220:443`. С хоста раннера:

```sh
timeout 5 bash -c 'echo > /dev/tcp/149.154.167.220/443' && echo доступен || echo закрыт
```

Если закрыт, дело не в плагине: нужно разбираться с сетью раннера. Прямые адреса MTProto (`149.154.167.51` и подобные) при этом закрыты почти всегда — это нормально, именно поэтому и нужен туннель.

## 4. Правка `.drone.yml`

**Добавьте сервис** на уровень пайплайна, рядом с `steps:`:

```yaml
services:
  - name: tg-ws-proxy
    image: registry.example.com/tg-ws-proxy:latest
    environment:
      TG_WS_PROXY_SECRET:
        from_secret: TG_PROXY_SECRET
```

Сервис поднимается на весь пайплайн, и шаги видят его по имени `tg-ws-proxy`. Отдельный шаг ожидания не нужен: плагин сам ждёт, пока порт начнёт принимать соединения, до `timeout` секунд.

**Замените шаблон шага на шаблон настроек.** Было:

```yaml
notify-template: &notify-template
  image: appleboy/drone-telegram:1
  settings:
    token:
      from_secret: TG_BOT_TOKEN
    to:
      from_secret: TG_BOT_CHATID
  failure: ignore
```

Стало:

```yaml
tg-settings: &tg-settings
  token:
    from_secret: TG_BOT_TOKEN
  to:
    from_secret: TG_BOT_CHATID
  api_id:
    from_secret: TG_API_ID
  api_hash:
    from_secret: TG_API_HASH
  proxy_host: tg-ws-proxy
  proxy_secret:
    from_secret: TG_PROXY_SECRET
```

**Перепишите notify-шаги.** Было:

```yaml
  - <<: *notify-template
    name: notify-build-success
    depends_on:
      - Deploy
    when:
      status: [success]
    settings:
      message: |
        ✅ Сборка [#{{build.number}}]({{build.link}}) прошла успешно
```

Стало:

```yaml
  - name: notify-build-success
    image: registry.example.com/drone-telegram-mtproto:1
    failure: ignore
    depends_on:
      - Deploy
    when:
      status: [success]
    settings:
      <<: *tg-settings
      message: |
        ✅ Сборка [#{{build.number}}]({{build.link}}) прошла успешно
```

Текст шаблона остаётся прежним.

## Ловушка слияния `<<:`

Это важнее самой миграции, и ошибка эта встречается в существующих пайплайнах.

Слияние YAML неглубокое. Если якорь описывает шаг целиком вместе с `settings`, а шаг задаёт свой `settings:`, то шаблонный блок **заменяется целиком**, а не дополняется. `image` и `failure` из якоря доедут, а `token` и `to` — нет. Старый плагин в такой конфигурации падает с `missing telegram token or user list`, а `failure: ignore` делает шаг зелёным, так что поломка остаётся незамеченной годами.

Проверить свой файл можно так:

```sh
python3 -c "
import yaml
for d in [d for d in yaml.safe_load_all(open('.drone.yml')) if d]:
    for s in d.get('steps', []):
        if 'notify' in str(s.get('name', '')):
            print(s['name'], sorted((s.get('settings') or {}).keys()))
"
```

Если в выводе только `['message']` — секреты в шаг не попадают. Поэтому якорь нужно вешать на карту настроек и сливать её внутри `settings:`, как показано выше.

## 5. Права бота в целевом чате

Бот не может писать первым. Для личного чата получатель должен сам отправить боту `/start`. В группу бота достаточно добавить участником. В канал — только администратором с правом «Публикация сообщений»; обычным подписчиком бота в канал добавить нельзя. Иначе отправка падает с `You can't write in this chat`.

Если уведомления раньше не работали из-за ловушки выше, права могли никогда и не настраиваться — проверьте их отдельно.

## 6. Первый запуск

Запустите сборку и смотрите лог notify-шага. Ожидаемая строка — `sent to -100… (message id 1234)`. При ошибке в логе будет `error:` или `warning:`, расшифровка — в [operations.md](operations.md). Из-за `failure: ignore` шаг выглядит успешным в любом случае, поэтому первый раз лог нужно прочитать глазами.

## 7. Необязательная настройка

**`session`** — без неё бот логинится при каждой сборке, и при частых сборках Telegram отвечает `FLOOD_WAIT`. Получите строку сессии один раз и положите в секрет:

```sh
docker run --rm -e PLUGIN_TOKEN=… -e PLUGIN_API_ID=… -e PLUGIN_API_HASH=… \
  registry.example.com/drone-telegram-mtproto:1 session
```

Затем добавьте в `&tg-settings` строку `session: { from_secret: TG_SESSION }`. Строка сессии равна по чувствительности токену.

**`timeout`** — по умолчанию 60 секунд на всё: ожидание прокси, логин и отправку. На медленном раннере поставьте больше.

**`TG_WS_PROXY_DC_IPS`** у сервиса — только если в логах прокси появилось слово `fallback`. По умолчанию через WebSocket идут DC2 и DC4; если бот живёт на другом дата-центре, добавьте его туда.

## 8. Откат

Изменения затрагивают только `.drone.yml`, поэтому откат — это `git revert` коммита с правкой. Старый образ при этом остаётся доступным.
