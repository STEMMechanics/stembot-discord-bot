# STEMBot

STEMBot is the official STEMMechanics Discord bot. It is a TypeScript service designed for an independent Docker deployment on TrueNAS.

The current implementation connects Discord to the public STEMMechanics workshop RSS feed and the STEMCraft status endpoint. It provides read-only workshop and server commands, persistent workshop announcements, 24-hour and 1-hour reminders, an optional image-based counting-chain minigame, AI-generated STEM games, a reply-based number game, persistent channel-based Tic Tac Toe and Connect 4, an embed-based Mystery Lab, and a cooperative Global Chase location mystery, plus optional mention-based AI STEM answers, a persistent participation XP and level system, and optional join-date cake-day announcements. The deployed Website and STEMCraft response shapes were verified on 22 October 2026, and the adapters retain compatibility with older responses.

## Architecture

```text
src/
  app.ts                         Application composition and lifecycle
  index.ts                       Process entry point and shutdown handlers
  register-commands.ts           Explicit Discord slash-command sync entry point
  config/env.ts                  Validated environment configuration
  logging/logger.ts              Structured JSON logging with Pino
  discord/                       Client, commands, interactions, channel delivery
  integrations/                  Website, STEMCraft and OpenAI HTTP adapters
  services/                      Workshop notifications and minigames
  jobs/                          Background interval scheduler
  state/                         Atomic JSON-file persistent state
scripts/
  register-commands.ts           npm sync:commands wrapper
tests/                            Unit, parser, command, and notification tests
```

The command layer depends on `WebsiteIntegration` and `StemCraftIntegration` interfaces. The notification coordinator depends on those interfaces, the scheduler, Discord channel delivery, and the persistent state boundary. New integrations can be added behind the same boundaries without placing HTTP logic in Discord handlers.

## Project documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) — TrueNAS, Docker Compose, configuration,
  state backups and operational checks.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow, test boundaries
  and review expectations.
- [SECURITY.md](SECURITY.md) — credential, privacy and vulnerability
  reporting guidance.
- [TODO.md](TODO.md) — remaining implementation and cross-repository work.

## Commands

Synchronize these application commands with `npm run sync:commands`:

- `/ping` — Discord gateway latency.
- `/workshops` — upcoming public workshops, sorted by start time with local formatting and a `Details` link for each workshop.
- `/joke` — a randomly selected robot-themed joke from the local joke set.
- `/number` — STEMBot thinks of a number from 1 to 20; reply to its message with your one guess.
- `/review` — ask a moderator to review the last counting-chain post that ended the game.
- `/counting-chain number:<number>` — set the next counting-chain number; requires Manage Messages.
- `/minecraft` — server availability, player count, capacity, maintenance state, version, and online Minecraft usernames. If the configured STEMCraft response has no permitted player list, it reports that names are unavailable.
- `/level` — your persisted XP, level and activity counts, or the public level card for another member.
- `/leaderboard` — the top ten members by XP.
- `/status` — the current public Uptime Kuma service status, when enabled.
- `/scramble reset` — reset the active word scramble and start a new round; requires Manage Messages.
- `/mystery-lab reset` — reset the active Mystery Lab round and start a new one; requires Manage Messages.
- `/code-fix reset` — reset the active Code Fix challenge and start a new one; requires Manage Messages.

`/workshops` uses `WORKSHOP_TIME_ZONE`; feed timestamps retain their supplied offsets when converted to instants.

### Number game

Use `/number` to start a personal number-guessing challenge. STEMBot thinks of a number from 1 to 20, and the player gets one attempt by replying directly to that bot message. The first reply to that exact prompt consumes the challenge and reveals the answer.

### Channel board games

When enabled, Tic Tac Toe and Connect 4 post one persistent board in their configured
channels. Players click the board buttons; the first click claims the round and starts a
game against STEMBot. There are no slash commands to start or stop these games.

### Global Chase

When `STEM_GLOBAL_CHASE_ENABLED=true`, STEMBot posts a cooperative location
mystery in the configured channel. Each clue offers three possible destinations;
players reply with a location or `1`, `2`, or `3`. A case has three correct
locations to follow, while decoy choices add strikes. Three strikes ends the
case and starts a new one. Each player response posts a fresh board embed, keeping
earlier clues and choices visible in the channel while the latest embed shows the
current location, route, and strike count. Solved cases are recorded on the
minigame leaderboard.

### Counting-chain minigame

When `COUNTING_CHAIN_ENABLED=true`, STEMBot watches only
`COUNTING_CHAIN_CHANNEL_ID` for image attachments and HTTPS GIF/image URLs.
The first accepted image must contain `1`; each following image must contain the next number and come
from a different Discord member than the previous accepted image. Accepted
images receive a `👍` reaction and advance the persisted channel state.
Counting images are serialized and ordered by their Discord message IDs, so a
second GIF posted while the first is being recognized waits for the first
result and is then checked against the next number.

A wrong number or two consecutive images from the same member receives `❌`,
posts a short game-over message, and resets the channel to `1`. With review
disabled, an unreadable, unsupported or temporarily unavailable image receives
`⚠️` and a retry message; it does not change the game state. With review
enabled, an unreadable image from another member receives `🔎`, `✅` and `❌`,
STEMBot mentions the moderator role and pauses the chain until a moderator
decides. A second consecutive image from the same member always ends the round
immediately because that rule is unambiguous. Bot messages and messages outside
the configured channel are ignored.

Set `COUNTING_CHAIN_REVIEW_ENABLED=true` and provide
`COUNTING_CHAIN_REVIEW_ROLE_ID` to pause wrong-number or unreadable posts from
another member for moderator review instead of resetting or asking the member to
retry. STEMBot mentions that role and adds the three review reactions to the
target post. A moderator with that role, `Manage Messages`, or `Administrator`
can click `✅` to approve the proposed number or `❌` to confirm the reset on
either the original image post or the review request message. After a decision,
STEMBot removes the review reactions and leaves only the final `👍` or `❌`
result. If review is enabled after a normal reset, any member can
use `/review`; STEMBot resolves the persisted image that ended the game, so the
member does not need to know a Discord message ID. While a review is pending,
later posts are held until a moderator approves or rejects the pending post.
The pending review is persisted across restarts.
After the moderator reacts, STEMBot adds its final `👍` or `❌` reaction and
deletes the temporary review request message.
If Discord history cannot be read during startup or catch-up, STEMBot keeps a
recovery marker and retries the history reconciliation before handling the
next counting post, so a temporary Discord/API failure does not permanently
freeze the chain.

Moderators with `Manage Messages` can use `/counting-chain number:16` to set the
next number manually. This clears a pending review, refreshes the minigame
dashboard, and treats messages already in the channel as seen so the next new
image starts at the chosen number.

The bot downloads Discord CDN attachments, direct image URLs, and image URLs
supplied by Discord embeds, samples animated GIF frames as PNG images, and sends
those frames to the configured OpenAI model. It does not require a provider
allowlist. Remote URLs must use HTTPS, resolve only to public addresses, stay on
the default HTTPS port, and pass redirect, image-type, timeout, and size checks.
It stores the current number, score history and Discord IDs, but does not store
the image. Recognition accepts digits, spelled-out number words, and clear
corrective phrases such as `not one, but two!`; ambiguous or inferred values
return no number. If image recognition returns no number, STEMBot checks the
image filename and explicit `number`, `count` or `value` URL parameters for one
unambiguous positive integer before it asks a moderator for review or asks the
member to try again. Provider IDs, dimensions and URLs containing conflicting
numbers are ignored.
Discord GIF-picker embeds can arrive after the initial message event, so the
bot checks message updates and recent channel history. Recent human posts are
fed to the counting service in Discord message-ID order, and duplicate or older
events are ignored. This prevents a later GIF embed update from being judged
before an earlier post.
Enable the Message Content intent in the Discord Developer Portal and grant the
bot permission to view message history, add reactions, manage messages and send
messages in the counting channel.

For troubleshooting, the log entry `Counting chain Discord message received`
confirms that the gateway delivered a message from the configured channel. Its
`attachmentCount` should be greater than zero for an uploaded image. A GIF
picker post may instead have `attachmentCount: 0` and `imageUrlCount: 1`; a
direct image URL with an image extension may have both counts at zero and is
still processed from the message content. The receipt entry includes the
resolved image host; if a candidate is rejected, `Counting chain message had
no usable image source` is logged at info level with the candidate counts. If the entry is
absent, check `COUNTING_CHAIN_CHANNEL_ID`, the bot's channel access, and the
Message Content intent. If it is present but the image cannot be read,
the following warning identifies whether the Discord CDN download, image
conversion, or OpenAI response failed. OpenAI responses that are incomplete or
refused are reported with a safe response summary rather than the image or
full model payload. If an existing deployment still uses a higher reasoning
setting and exhausts its output budget, STEMBot retries that recognition once
with low reasoning effort.

### AI STEM question chain

When `STEM_QUIZ_ENABLED=true`, STEMBot posts one age-appropriate question
at a time in `STEM_QUIZ_CHANNEL_ID`. The question is aimed at ages 8–14, with
an optional harder-question rate for players up to the configured older-player
age. Members answer with
ordinary Discord messages. Questions may be short answer, true/false or multiple
choice. The first accepted answer earns one point, receives `✅`, and advances
the game. Incorrect answers receive `❌`; after the configured
number of wrong answers, STEMBot reveals the answer and explanation before
posting the next question. A wrong true/false answer ends that question
immediately, and a multiple-choice question ends once every option but one has
been tried incorrectly. Each prompt explains that members can type `hint` (or
`clue`/`help`) for an extra clue, or `skip` to reveal the answer and move on.
Hints do not use an answer attempt. Unclear answers receive `🤔` and leave the
question open without using an attempt. If answer evaluation fails temporarily,
the message receives `⚠️` and no attempt is counted, so the member can try again.

Generated questions are checked for accurate terminology and matching units.
Minecraft questions distinguish blocks, metres, seconds, game ticks and
redstone ticks; the generator is instructed to avoid uncertain or ambiguous
questions in favour of a clearer question. STEMBot persists the last 20
questions and answers, supplies them to the generator as exclusions, and
regenerates an exact duplicate before it is posted. Near-equivalent questions
are also discouraged by the generation prompt.

The active question, wrong-attempt count, tried multiple-choice options, hints,
scores, question sequence, recent question history and recent message IDs are
persisted in the shared JSON state file. A restart keeps an
active question instead of generating a replacement. Question generation and
natural-language answer checking use the existing `OPENAI_API_KEY`,
`OPENAI_MODEL`, `OPENAI_REASONING_EFFORT` and `OPENAI_TIMEOUT` settings. The
Responses API is used with strict structured output, and requests set `store` to
`false`. Member answers are sent for evaluation but are not written to state or
included in logs.

The default topic mix covers science, technology, engineering, mathematics,
space, nature, robotics and computing. If an existing deployment still has
`STEM_QUIZ_TOPIC=mixed STEM, Minecraft and engineering`, update that environment
value to the broader mix when deploying this version.

### STEM word scramble

When `STEM_SCRAMBLE_ENABLED=true`, STEMBot asks the shared OpenAI model for one
age-appropriate STEM word and a short hint, then scrambles the letters locally.
The answer is kept in persistent state; OpenAI never receives member guesses.
The first correct member receives `✅`, earns minigame XP and starts the next
round. Incorrect guesses receive `❌`; after five incorrect guesses the answer
is revealed and the game moves on. The last 50 words are retained and sent as
exclusions so the generator does not quickly repeat a word; exact duplicates
are also rejected locally and regenerated.
The active round is persistent across restarts. Moderators can use
`/scramble reset` to discard a stuck round and publish a replacement.

Set `STEM_SCRAMBLE_CHANNEL_ID` to the channel where the game should run. The
bot needs the Message Content intent and permission to add reactions there.

### Themed word chain

When `STEM_WORD_CHAIN_ENABLED=true`, STEMBot starts a persistent word chain in
`STEM_WORD_CHAIN_CHANNEL_ID`. Each word must be a STEM word from the displayed
theme and must start with the last letter of the previous word. Common bundled
terms are accepted immediately; OpenAI checks unfamiliar words against the
theme and replies with a short definition for accepted words. This feature
requires `OPENAI_API_KEY`. An invalid word ends the round,
records the streak, and rotates to the next theme. If the validator is
temporarily unavailable, the round stays open and the move is not counted. The
word checks and definitions are cached and rate limited per member and globally.
The
bundled themes are Space, Biology, Chemistry, Technology and Physics.

Answers for quiz, scramble and word-chain rounds are ordered against the
prompt message ID. If someone submitted an answer before STEMBot posted the
replacement prompt, that answer is marked as handled and skipped without a
wrong-answer penalty or an extra round change.

### Mystery Lab

When `STEM_MYSTERY_LAB_ENABLED=true`, STEMBot opens a Mystery Lab round with
one age-appropriate word and one clue. The board is a blue embed with the clue at
the top, a comma-separated code-style list of guessed letters, and the word shown
as blue circles for unknown positions and Discord `:regional_indicator_a:` through
`:regional_indicator_z:` names for revealed positions. The default `challenging`
difficulty uses longer words and clues that
require a little more thought without giving away the answer. Members can submit
one letter or the whole word. Every board update posts a fresh embed so earlier
guesses stay visible during a busy round. A completed word records the member's
solved-round score and starts the next word. After the idle timeout, the answer is
revealed and the game advances without changing the leaderboard.
`/mystery-lab reset` is available to moderators when a round needs to be
restarted.

### Code Fix

When `STEM_CODE_FIX_ENABLED=true`, STEMBot posts a child-friendly Python,
JavaScript or TypeScript example with one clear bug and asks what should be
fixed. `STEM_CODE_FIX_DIFFICULTY` defaults to `intermediate`, using small
functions, loops, conditions and collection logic instead of only one-line
operator mistakes; set it to `advanced` for longer multi-step tracing
challenges. Exact
canonical answers and equivalent variants are accepted locally; other
natural-language explanations are sent to OpenAI for a structured
`correct`, `incorrect` or `unclear` decision. Unclear answers do not consume an
attempt. After the wrong-answer limit, the fix and teaching explanation are
shown and the next challenge starts. `/code-fix reset` is available to
moderators. The challenge title and fix history are retained to reduce
repetition.

### Mention-based STEM answers

When `STEM_ASK_ENABLED=true`, members can mention STEMBot followed by a STEM
question in any channel. STEMBot answers with the shared OpenAI model without
storing the question text. Empty or oversized questions are ignored. A message
that mentions STEMBot is normally excluded from counting, quiz, scramble, word-chain,
Mystery Lab and Code Fix answer processing so the bot can answer it safely
anywhere. In the quiz, scramble and word-chain channels, `@STEMBot hint`
continues to route to the game hint behavior; quiz also accepts `@STEMBot skip`.
The service allows one request per user every 30 seconds, ten requests per user
per UTC day, and 100 requests across the bot per UTC day by default. Requests
that reach a limit receive a short playful cooldown or quota response without
calling OpenAI. Override these values with `STEM_ASK_USER_COOLDOWN_SECONDS`,
`STEM_ASK_USER_DAILY_LIMIT`, and `STEM_ASK_GLOBAL_DAILY_LIMIT`. The counters
and recent Discord message IDs are stored in the shared JSON state file so a
restart does not reset the limits.

### Participation XP and levels

When `STEM_LEVELS_ENABLED=true`, human messages earn XP with the configured
per-user cooldown, reactions earn XP with a separate cooldown, and accepted
counting-chain moves, quiz answers, scramble answers, word-chain moves, Word
Reveal solves and Code Fix solutions earn minigame XP.
Bot messages are ignored. XP and activity counts are stored in the shared JSON
state file. Levels use increasing thresholds: level 2 starts at 100 XP, level 3
at 400 XP, and so on. `/level` shows an individual profile and
`/leaderboard` shows the top ten members without pinging them.

Set `STEM_LEVELS_ANNOUNCEMENT_CHANNEL_ID` to post a public level-up message in
the specified channel. The announcement uses an embed with the new level, XP
progress and the member mention. Leave it unset to keep level-ups available
through the commands without public announcements. Announcement failures are
logged without discarding the XP award.

The level listener requires the Discord Message Content and Guild Message
Reactions intents. STEMBot requests these automatically when the feature is
enabled, but the privileged Message Content intent must also be enabled in the
Discord Developer Portal.

### Join-date cake days

When `STEM_CAKE_DAYS_ENABLED=true`, STEMBot checks current human guild members
during the hour configured by `STEM_CAKE_DAYS_HOUR` in `WORKSHOP_TIME_ZONE`.
The default is 8am in `Australia/Brisbane`. A member receives one announcement
on the month and day of their Discord join date after completing at least one
year. The daily sent-member list is stored in the shared JSON state file, so a
restart or a retry during the same morning does not repeat a successful post.

Each announcement includes the member mention and a personalized PNG card with
their current avatar, a STEMBot robot, a birthday cake and the completed years.
The card is rendered with `DejaVu Sans`, which is already installed by the
Docker image's `fonts-dejavu-core` package. The feature requests Discord's
privileged `GuildMembers` intent so it can read the current member list; enable
that intent in the Discord Developer Portal when cake days are enabled.

Set `COUNTING_CHAIN_INFO_CHANNEL_ID` to maintain a single STEMBot minigame
dashboard embed with the counting streak, best counting streak, a separate
top-three record leaderboard for counting, Number, quiz, scramble, word chain,
STEM Mystery Lab, Global Chase, Tic Tac Toe, Connect 4 and Code Fix, plus the last counting
round. The counting record is each member's highest number, Number records
correct guesses, quiz records correct answers, scramble records solved rounds,
and word chain records a member's best correct-guess streak in one round. Mystery
Lab and Global Chase record solved rounds, Tic Tac Toe and Connect 4 record wins,
and Code Fix records correct fixes. Set
`COUNTING_CHAIN_INFO_MESSAGE_ID` when an existing STEMBot message should be
edited. If the message ID is omitted, STEMBot searches the most recent 100
messages for its `STEMBot Minigames` embed (and can reuse the old counting
embed) and creates one only when it cannot find an existing message. The
dashboard is updated after game results and resets, and once when the service
starts.

Startup reconciliation paginates through the channel in 100-message pages. If
the game has a saved checkpoint, it processes image attachments and GIF URLs
newer than that checkpoint in chronological order, sending the normal
reactions and reset replies for missed posts. If the game has no saved record,
it recovers the newest relevant image without sending historical feedback;
a `❌`/`⚠️` reaction or game-over/read-failure reply starts the game at `1`.
Missing or unreadable history retains the last durable state and retries on the
next startup.

If the logs report `Unknown Channel` during startup recovery, the configured
`COUNTING_CHAIN_CHANNEL_ID` is not a readable channel for this bot. Check that
the ID is the channel ID rather than a message ID, that the channel still
exists in the configured guild, and that the bot has `View Channel` and `Read
Message History`. STEMBot records a reset at `1` and marks history recovery as
pending when history cannot be read. It retries recovery on the next startup,
so correcting the channel configuration and permissions does not require
manually editing the game fields.

### Minecraft Discord bridge

When `CHAT_DISCORD_BRIDGE_ENABLED=true`, STEMBot listens for authenticated
`POST` requests on `CHAT_DISCORD_BRIDGE_HOST`, `CHAT_DISCORD_BRIDGE_PORT` and
`CHAT_DISCORD_BRIDGE_PATH`. Put that listener behind the public HTTPS URL used
by the Minecraft plugin and keep the bearer token in the plugin secret store.
Every accepted event is posted to `CHAT_DISCORD_BRIDGE_CHANNEL_ID`; the
incoming `server` and `channel` values are accepted but the configured Discord
channel remains authoritative. The `X-STEMCraft-Event-Id` header must match the
JSON `event_id` when supplied, and retries with an already delivered event ID
are acknowledged without a second Discord message. The receiver accepts
`minecraft.chat`, `minecraft.player_join`, `minecraft.player_quit`,
`minecraft.player_death`, `minecraft.player_command`,
`minecraft.server_start`, `minecraft.server_stop`,
`minecraft.server_message`, `minecraft.minigame_start` and
`minecraft.minigame_end` on this same endpoint.

When `CHAT_DISCORD_BRIDGE_STEMCRAFT_URL` is set, the same channel also
forwards human Discord messages to STEMCraft with the same
`CHAT_DISCORD_BRIDGE_BEARER_TOKEN`. STEMBot sends only the message's text,
username, and display name. Bot/webhook messages and messages with no text are
ignored, so embeds, images, and attachments are not copied into Minecraft.
Messages containing text plus an attachment forward the text only.

Global chat and death events are plain text announcements. Player join and quit
events use compact embeds; command, minigame, server lifecycle, and server
message events use structured embeds. Server messages are rendered as a bold
message-only amber embed, with no additional label. Embed mentions are disabled,
and valid `occurred_at` timestamps appear in the embed timestamp.
The recommended path is `/minecraft/event`; requests with a trailing slash are
accepted as well. Existing deployments can keep `/minecraft/chat` when that
path is explicitly configured in both the bot and the Minecraft plugin.

The plugin can send:

```http
POST /minecraft/event
Authorization: Bearer replace-with-long-random-token
Content-Type: application/json; charset=utf-8
X-STEMCraft-Event-Id: 7b5e1d0e-8d86-4a93-9ea2-92a57fb1b40e

{
  "event": "minecraft.chat",
  "event_id": "7b5e1d0e-8d86-4a93-9ea2-92a57fb1b40e",
  "occurred_at": "2026-10-24T01:02:03Z",
  "server": "survival",
  "channel": "global",
  "player": {
    "name": "Alex",
    "uuid": "01234567-89ab-cdef-0123-456789abcdef"
  },
  "message": "Hello from Minecraft"
}
```

The structured event names are `minecraft.player_join`,
`minecraft.player_quit`, `minecraft.player_death`, `minecraft.player_command`,
`minecraft.minigame_start`, `minecraft.minigame_end`,
`minecraft.server_start`, `minecraft.server_stop`, and
`minecraft.server_message`. Player events carry the player object; server
events have no player; event-specific details are in `data`. A server message
uses `data.message` for text originating from the Minecraft server console,
plugins, scripts, or services.

STEMBot publishes chat as `Alex » Hello from Minecraft` with Discord mentions
disabled and no pickaxe prefix. Player join and quit events use compact embeds
with the player avatar and a green or red edge. Death events are plain text in
the form `💀 Alex was slain by Zombie`; the plugin's `data.message` is used when
present, with `Alex died` as the fallback. Commands are plain text in the form
`Alex » \`/spawn home\``. Server start/stop and minigame start events use
compact green/red embeds; a minigame start looks like `Mobarena - Forest
started`. Minigame end events retain their arena, status, participant and
winner details. The bridge
stores delivered event IDs in the shared state file so a plugin retry after a
network timeout is safe.

STEMBot posts Discord chat to the STEMCraft URL in this form:

```json
{
  "event": "discord.chat",
  "event_id": "123456789012345678",
  "username": "alex",
  "displayname": "Alex",
  "message": "Hello from Discord"
}
```

### Discord command synchronization

`npm run sync:commands` performs a complete Discord replacement with the
supported commands in the configured guild scope. It first removes existing
global command registrations for this application, then bulk-replaces the
global set with an empty list and the target guild set with the supported
commands. This single-server deployment therefore has one authoritative copy
of each command. Obsolete commands, including old `/schedule`, `/embed` and
`/countingchain` commands, are removed.

The script first verifies that the token belongs to `DISCORD_CLIENT_ID`. It
only uses that application ID and the explicitly configured guild ID, so it
cannot remove commands belonging to another Discord application. The same
replacement also runs automatically before the bot connects on every process
startup. If the synchronization fails, the bot does not start with a stale
command set.
The explicit command remains available for a one-off reconciliation without a
container restart.

If Discord still shows two copies after a synchronization, verify that only
one STEMBot container is running with the token. Two gateway processes using
the same application can race to acknowledge one interaction; the losing
process receives Discord error 10062 (`Unknown interaction`).

For a local or administration workstation, set the same credentials used by
the deployment and run:

```sh
DISCORD_GUILD_ID=123456789012345678 npm run sync:commands
```

The guild ID can instead be stored in `.env` and is required for this
single-server deployment. Guild changes are available quickly.

## External contracts

The Website adapter reads `title`, `link`, `guid`, `description`, `pubDate`, `enclosure`, `sm:id`, `sm:startDate`, `sm:endDate`, `sm:location`, `sm:price`, `sm:ages`, `sm:registrationType`, `sm:registrationUrl`, `sm:status`, `sm:statusCode`, and `sm:type`. `sm:id` is the stable identity and `guid` remains the fallback for older feeds. Registration types cover tickets, external links, interest, email, message, and none. The existing top-level start and end dates remain in use; nested `sm:sessions` data is intentionally not parsed yet.

The adapter keeps dates with their supplied offsets, skips malformed items, and retains a narrow compatibility fallback for older escaped XML declarations. `sm:statusCode` drives visibility, cancellation, and reminder decisions; `sm:status` is retained for display compatibility. Missing feed items are left in persistent state and are never treated as cancellations. Discord commands and workshop notifications include type-appropriate registration links or calls to action.

The STEMCraft adapter supports the deployed response (`online`, `players_online`, `max_players`, `version`, `maintenance`, `message`, `players`, `checked_at`). The live endpoint currently supplies a username-only `players` array when `web-server.status.players.enabled` is enabled. Older responses without that array remain supported; `/minecraft` reports that names are unavailable in that case. UUIDs and other identity fields are discarded.

## Requirements and local development

- Node.js 24 LTS and npm
- A Discord application and bot token
- Docker Engine and Docker Compose for deployment

The Docker image uses Node.js 24. Keep local development on the same major version where possible.

```sh
cp .env.example .env
npm ci
npm run dev
```

Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and the target `DISCORD_GUILD_ID` in
`.env`. The normal `npm run dev` startup synchronizes commands automatically.

Run the checks with:

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run validate
```

`npm run validate` runs formatting, linting, type checking, the complete test suite, and the production build.

## Configuration

| Variable                                    | Required            | Purpose                                                                                     |
| ------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`                             | Yes                 | Discord bot token. Keep it in the deployment secret store.                                  |
| `DISCORD_CLIENT_ID`                         | Yes                 | Discord application ID.                                                                     |
| `DISCORD_GUILD_ID`                          | Yes                 | The single Discord guild where STEMBot commands are registered.                             |
| `WORKSHOP_FEED_URL`                         | No                  | Website RSS URL; defaults to the STEMMechanics workshop feed.                               |
| `WEBSITE_REQUEST_TIMEOUT_MS`                | No                  | RSS request timeout; defaults to 15 seconds.                                                |
| `STEMCRAFT_STATUS_URL`                      | No                  | STEMCraft status URL; defaults to `http://play.stemcraft.com.au:8950/status`.               |
| `STEMCRAFT_STATUS_TOKEN`                    | No                  | Optional bearer token for a protected status endpoint.                                      |
| `STEMCRAFT_REQUEST_TIMEOUT_MS`              | No                  | Status request timeout; defaults to 5 seconds.                                              |
| `UPTIME_KUMA_ENABLED`                       | No                  | Enable the persistent Uptime Kuma Discord status card; defaults to `false`.                 |
| `UPTIME_KUMA_STATUS_PAGE_URL`               | When enabled        | Published Uptime Kuma URL such as `https://uptime.example.com/status/stemmechanics`.        |
| `UPTIME_KUMA_POLL_INTERVAL_MS`              | No                  | Status polling interval; defaults to 60 seconds.                                            |
| `UPTIME_KUMA_REQUEST_TIMEOUT_MS`            | No                  | Uptime Kuma request timeout; defaults to 10 seconds.                                        |
| `DISCORD_UPTIME_STATUS_CHANNEL_ID`          | When enabled        | Channel where the bot creates and continually edits the status card.                        |
| `OPENAI_API_KEY`                            | When enabled        | OpenAI API key; keep it in the deployment secret store.                                     |
| `OPENAI_MODEL`                              | No                  | Shared OpenAI model for recognition, games and STEM answers; defaults to `gpt-6-luna`.      |
| `OPENAI_REASONING_EFFORT`                   | No                  | Shared reasoning setting; defaults to `low` for routine calls.                              |
| `OPENAI_TIMEOUT`                            | No                  | OpenAI request timeout in seconds; defaults to 180.                                         |
| `COUNTING_CHAIN_ENABLED`                    | No                  | Enable the image-based minigame; defaults to `false`.                                       |
| `COUNTING_CHAIN_CHANNEL_ID`                 | When enabled        | Discord channel watched by the minigame.                                                    |
| `COUNTING_CHAIN_INFO_CHANNEL_ID`            | No                  | Channel containing the live STEMBot minigame dashboard embed.                               |
| `COUNTING_CHAIN_INFO_MESSAGE_ID`            | No                  | Existing STEMBot message to edit; if omitted, the bot discovers its embed.                  |
| `COUNTING_CHAIN_REVIEW_ENABLED`             | No                  | Pause uncertain counting posts and request moderator reactions; defaults to `false`.        |
| `COUNTING_CHAIN_REVIEW_ROLE_ID`             | When review enabled | Role to mention and authorize for counting-chain review.                                    |
| `COUNTING_CHAIN_MAX_ATTACHMENT_BYTES`       | No                  | Maximum downloaded image size; defaults to 8 MiB.                                           |
| `STEM_QUIZ_ENABLED`                         | No                  | Enable the AI STEM question chain; defaults to `false`.                                     |
| `STEM_QUIZ_CHANNEL_ID`                      | When enabled        | Discord channel where questions and answers are processed.                                  |
| `STEM_QUIZ_MAX_WRONG_ANSWERS`               | No                  | Wrong answers before the bot reveals the answer; defaults to `5`.                           |
| `STEM_QUIZ_TARGET_AGE_MIN`                  | No                  | Lower end of the main question age range; defaults to `8`.                                  |
| `STEM_QUIZ_TARGET_AGE_MAX`                  | No                  | Upper end of the main question age range; defaults to `14`.                                 |
| `STEM_QUIZ_OLDER_AGE_MAX`                   | No                  | Maximum age for harder questions; defaults to `18`, max `100`.                              |
| `STEM_QUIZ_OLDER_PLAYER_RATE`               | No                  | Fraction of generated questions that are harder; defaults to `0.15`.                        |
| `STEM_QUIZ_TOPIC`                           | No                  | Topic guidance for question generation.                                                     |
| `STEM_QUIZ_RETRY_INTERVAL_MS`               | No                  | Retry interval when a question cannot be generated or posted; defaults to 5 minutes.        |
| `STEM_SCRAMBLE_ENABLED`                     | No                  | Enable the AI word-scramble minigame; defaults to `false`.                                  |
| `STEM_SCRAMBLE_CHANNEL_ID`                  | When enabled        | Discord channel where the scramble runs.                                                    |
| `STEM_SCRAMBLE_RETRY_INTERVAL_MS`           | No                  | Retry interval when a scramble cannot be generated or posted; defaults to 5 minutes.        |
| `STEM_SCRAMBLE_TARGET_AGE_MIN`              | No                  | Lower end of the scramble age range; defaults to `8`.                                       |
| `STEM_SCRAMBLE_TARGET_AGE_MAX`              | No                  | Upper end of the scramble age range; defaults to `14`.                                      |
| `STEM_SCRAMBLE_TOPIC`                       | No                  | Topic guidance for scramble word generation.                                                |
| `STEM_WORD_CHAIN_ENABLED`                   | No                  | Enable the themed STEM word chain; defaults to `false`.                                     |
| `STEM_WORD_CHAIN_CHANNEL_ID`                | When enabled        | Discord channel where the word chain runs.                                                  |
| `STEM_WORD_CHAIN_RETRY_INTERVAL_MS`         | No                  | Retry interval when the word-chain prompt cannot be posted; defaults to 5 minutes.          |
| `STEM_MYSTERY_LAB_ENABLED`                  | No                  | Enable the masked-word letter guessing game; defaults to `false`.                           |
| `STEM_MYSTERY_LAB_CHANNEL_ID`               | When enabled        | Discord channel where Mystery Lab runs.                                                     |
| `STEM_MYSTERY_LAB_RETRY_INTERVAL_MS`        | No                  | Retry interval when a Mystery Lab word cannot be generated; defaults to 5 minutes.          |
| `STEM_MYSTERY_LAB_TOPIC`                    | No                  | Topic guidance for Mystery Lab word generation; it can cover general topics.                |
| `STEM_MYSTERY_LAB_DIFFICULTY`               | No                  | `standard` or `challenging`; defaults to `challenging`.                                     |
| `STEM_MYSTERY_LAB_TARGET_AGE_MIN`           | No                  | Lower end of the Mystery Lab age range; defaults to `8`.                                    |
| `STEM_MYSTERY_LAB_TARGET_AGE_MAX`           | No                  | Upper end of the Mystery Lab age range; defaults to `14`.                                   |
| `STEM_MYSTERY_LAB_MAX_WRONG_GUESSES`        | No                  | Wrong letters or whole-word guesses before the answer is shown; defaults to `8`.            |
| `STEM_MYSTERY_LAB_IDLE_TIMEOUT_MS`          | No                  | Time before an unanswered mystery is revealed; defaults to 3 days.                          |
| `STEM_CODE_FIX_ENABLED`                     | No                  | Enable the AI code debugging minigame; defaults to `false`.                                 |
| `STEM_CODE_FIX_CHANNEL_ID`                  | When enabled        | Discord channel where Code Fix runs.                                                        |
| `STEM_CODE_FIX_RETRY_INTERVAL_MS`           | No                  | Retry interval when a Code Fix challenge cannot be generated; defaults to 5 minutes.        |
| `STEM_CODE_FIX_DIFFICULTY`                  | No                  | Challenge difficulty: `beginner`, `intermediate` or `advanced`; defaults to `intermediate`. |
| `STEM_CODE_FIX_TOPIC`                       | No                  | Topic guidance for Code Fix challenge generation.                                           |
| `STEM_CODE_FIX_TARGET_AGE_MIN`              | No                  | Lower end of the Code Fix age range; defaults to `8`.                                       |
| `STEM_CODE_FIX_TARGET_AGE_MAX`              | No                  | Upper end of the Code Fix age range; defaults to `14`.                                      |
| `STEM_CODE_FIX_MAX_WRONG_ANSWERS`           | No                  | Wrong answers before the fix is shown; defaults to `5`.                                     |
| `STEM_CODE_FIX_IDLE_TIMEOUT_MS`             | No                  | Time before an unanswered challenge is revealed; defaults to 3 days.                        |
| `STEM_TICTACTOE_ENABLED`                    | No                  | Enable the persistent Tic Tac Toe channel game; defaults to `false`.                        |
| `STEM_TICTACTOE_CHANNEL_ID`                 | When enabled        | Discord channel where Tic Tac Toe posts its board.                                          |
| `STEM_TICTACTOE_RETRY_INTERVAL_MS`          | No                  | Retry interval for posting a Tic Tac Toe board; defaults to 5 minutes.                      |
| `STEM_TICTACTOE_IDLE_TIMEOUT_MS`            | No                  | Time before an idle Tic Tac Toe round is reset; defaults to 3 days.                         |
| `STEM_CONNECT4_ENABLED`                     | No                  | Enable the persistent Connect 4 channel game; defaults to `false`.                          |
| `STEM_CONNECT4_CHANNEL_ID`                  | When enabled        | Discord channel where Connect 4 posts its board.                                            |
| `STEM_CONNECT4_RETRY_INTERVAL_MS`           | No                  | Retry interval for posting a Connect 4 board; defaults to 5 minutes.                        |
| `STEM_CONNECT4_IDLE_TIMEOUT_MS`             | No                  | Time before an idle Connect 4 round is reset; defaults to 3 days.                           |
| `STEM_GLOBAL_CHASE_ENABLED`                 | No                  | Enable the cooperative Global Chase channel game; defaults to `false`.                      |
| `STEM_GLOBAL_CHASE_CHANNEL_ID`              | When enabled        | Discord channel where Global Chase posts its case board.                                    |
| `STEM_GLOBAL_CHASE_RETRY_INTERVAL_MS`       | No                  | Retry interval for posting a Global Chase case; defaults to 5 minutes.                      |
| `STEM_GLOBAL_CHASE_MAX_STRIKES`             | No                  | Wrong destination choices before a case ends; defaults to `3`.                              |
| `STEM_GLOBAL_CHASE_IDLE_TIMEOUT_MS`         | No                  | Time before an idle Global Chase case is reset; defaults to 3 days.                         |
| `STEM_ASK_ENABLED`                          | No                  | Enable mention-based AI STEM answers; defaults to `false`.                                  |
| `STEM_ASK_MAX_QUESTION_LENGTH`              | No                  | Maximum question length; defaults to 500 characters.                                        |
| `STEM_ASK_USER_COOLDOWN_SECONDS`            | No                  | Minimum time between a user's questions; defaults to 30 seconds.                            |
| `STEM_ASK_USER_DAILY_LIMIT`                 | No                  | Maximum questions per user per UTC day; defaults to `10`.                                   |
| `STEM_ASK_GLOBAL_DAILY_LIMIT`               | No                  | Maximum questions across the bot per UTC day; defaults to `100`.                            |
| `STEM_LEVELS_ENABLED`                       | No                  | Enable message, reaction and minigame XP; defaults to `false`.                              |
| `STEM_LEVELS_ANNOUNCEMENT_CHANNEL_ID`       | No                  | Channel for public level-up announcements; unset disables them.                             |
| `STEM_LEVELS_MESSAGE_XP`                    | No                  | XP for a message after cooldown; defaults to `5`.                                           |
| `STEM_LEVELS_REACTION_XP`                   | No                  | XP for a reaction after cooldown; defaults to `2`.                                          |
| `STEM_LEVELS_GAME_XP`                       | No                  | XP for an accepted minigame move; defaults to `15`.                                         |
| `STEM_LEVELS_MESSAGE_COOLDOWN_SECONDS`      | No                  | Per-user message XP cooldown; defaults to `60`.                                             |
| `STEM_LEVELS_REACTION_COOLDOWN_SECONDS`     | No                  | Per-user reaction XP cooldown; defaults to `30`.                                            |
| `STEM_CAKE_DAYS_ENABLED`                    | No                  | Enable join-date cake-day announcements; defaults to `false`.                               |
| `STEM_CAKE_DAYS_ANNOUNCEMENT_CHANNEL_ID`    | When enabled        | Channel for cake-day announcements.                                                         |
| `STEM_CAKE_DAYS_CHECK_INTERVAL_MS`          | No                  | Scheduler interval for the local-hour check; defaults to 60000 ms.                          |
| `STEM_CAKE_DAYS_HOUR`                       | No                  | Local hour for announcements in `WORKSHOP_TIME_ZONE`; defaults to `8`.                      |
| `CHAT_DISCORD_BRIDGE_ENABLED`               | No                  | Enable the bearer-authenticated Minecraft chat HTTP bridge; defaults to `false`.            |
| `CHAT_DISCORD_BRIDGE_HOST`                  | No                  | HTTP bind host; defaults to `0.0.0.0`.                                                      |
| `CHAT_DISCORD_BRIDGE_PORT`                  | No                  | HTTP bind port; defaults to `8080`.                                                         |
| `CHAT_DISCORD_BRIDGE_PATH`                  | No                  | HTTP path; defaults to `/minecraft/event`.                                                  |
| `CHAT_DISCORD_BRIDGE_BEARER_TOKEN`          | When enabled        | Bearer token required by the Minecraft plugin.                                              |
| `CHAT_DISCORD_BRIDGE_CHANNEL_ID`            | When enabled        | Discord channel receiving accepted Minecraft chat messages.                                 |
| `CHAT_DISCORD_BRIDGE_STEMCRAFT_URL`         | For reverse chat    | STEMCraft `POST /api/v1/chat/discord` URL for Discord-to-Minecraft chat.                    |
| `CHAT_DISCORD_BRIDGE_MAX_BODY_BYTES`        | No                  | Maximum request size; defaults to 64 KiB.                                                   |
| `WORKSHOP_TIME_ZONE`                        | No                  | IANA timezone for Discord output and notifications; defaults to `Australia/Brisbane`.       |
| `WORKSHOP_POLL_INTERVAL_MS`                 | No                  | Feed polling interval; defaults to 5 minutes.                                               |
| `WORKSHOP_ANNOUNCEMENTS_ENABLED`            | No                  | Enable new/update/cancellation announcements; defaults to `true`.                           |
| `WORKSHOP_ANNOUNCEMENT_WINDOW_DAYS`         | No                  | Only announce future workshops within this many days; defaults to 28.                       |
| `WORKSHOP_ANNOUNCEMENT_DELAY_MINUTES`       | No                  | Delay lifecycle announcements in minutes; defaults to 30. Set to `0` for immediate testing. |
| `WORKSHOP_ANNOUNCEMENT_DELAY_MS`            | No                  | Legacy millisecond setting; used only when the minutes setting is unset.                    |
| `WORKSHOP_REMINDERS_ENABLED`                | No                  | Enable workshop reminders; defaults to `true`.                                              |
| `WORKSHOP_REMINDER_24H_ENABLED`             | No                  | Enable the 24-hour reminder; defaults to `true`.                                            |
| `WORKSHOP_REMINDER_1H_ENABLED`              | No                  | Enable the 1-hour reminder; defaults to `true`.                                             |
| `WORKSHOP_REMINDER_LOCATIONS`               | No                  | Case-insensitive comma-separated locations; defaults to `STEMCraft`. Use `*` for all.       |
| `WORKSHOP_ANNOUNCE_INITIAL_SYNC`            | No                  | Announce all feed items on the first sync; defaults to `false` to avoid startup spam.       |
| `DISCORD_WORKSHOP_ANNOUNCEMENT_CHANNEL_ID`  | No                  | Channel for workshop lifecycle announcements.                                               |
| `DISCORD_WORKSHOP_REMINDER_CHANNEL_ID`      | No                  | Channel for 24-hour and 1-hour reminders.                                                   |
| `STREAMING_NOTIFICATIONS_ENABLED`           | No                  | Reserved setting for the streaming workflow; defaults to `false`.                           |
| `DISCORD_STREAMING_NOTIFICATION_CHANNEL_ID` | No                  | Reserved streaming notification channel.                                                    |
| `STATE_PATH`                                | No                  | Persistent JSON state path; defaults to `./data/state.json`.                                |
| `SHUTDOWN_TIMEOUT_MS`                       | No                  | Graceful shutdown deadline; defaults to 30 seconds.                                         |
| `NODE_ENV`                                  | No                  | `development`, `test`, or `production`; defaults to `production`.                           |
| `LOG_LEVEL`                                 | No                  | Pino level; defaults to `info`.                                                             |

The previous `STEM_WORD_REVEAL_*` environment names remain accepted as legacy aliases during migration.
The loader validates Discord IDs, URLs, positive intervals, booleans, and the IANA timezone. Blank optional values are treated as unset.

## Announcements, reminders, and state

The scheduler performs an initial synchronization after Discord connects and repeats it at `WORKSHOP_POLL_INTERVAL_MS`. It compares a SHA-256 fingerprint of meaningful workshop fields. A stable `sm:id` prevents duplicate records even when titles repeat; GUIDs remain compatible with older state and feeds. New workshops, meaningful updates, and `sm:statusCode=cancelled` transitions produce separate messages when announcements and a channel are configured. Missing or removed items are not cancellation events, while retained cancellation records can be processed after their scheduled date.

Workshop announcements and reminders use the same plain-message style as the existing STEMMechanics announcements. Each message has an emoji prefix and a bold linked title (`📣 New:`, `✏️ Updated:`, `❌ Cancelled:`, or `⏰ Starts in ...`), the available workshop description, a labelled details section, and the HTTPS hero image as a normal Discord attachment. Lifecycle workshop announcements are automatically published to followers when the configured channel is a Discord Announcement channel. The bot must be able to send messages there; ordinary text channels are left unchanged, and crosspost failures are logged without causing a duplicate retry. Future lifecycle announcements are held until the workshop is within `WORKSHOP_ANNOUNCEMENT_WINDOW_DAYS`; cancellation transitions remain eligible immediately. The registration call to action is separated from the details by blank lines; ticket links use `Book now`, while interest links use `Register interest`. The RSS adapter prefers `content:encoded` when a feed supplies it, then falls back to `description`. When the feed supplies a truncated summary, the adapter follows the existing workshop link and extracts the page's content article. Feed descriptions retain paragraph and basic emphasis formatting where supplied, exclude the generated date/location suffix, and stop before `Learning Outcomes`. The Website feed's `?md` image transform is removed before download.

The JSON state file stores the current workshop fingerprint, pending lifecycle event, pending announcement time, last delivered Discord message ID, reminder delivery markers, counting-chain state, AI quiz state, scramble state, themed word-chain state, Mystery Lab state, Code Fix state, STEM ask rate-limit counters, user-level profiles, delivered Minecraft event IDs and the Uptime Kuma status-card message ID. It is written atomically, mounted at `/app/data` in Compose, and survives container restarts. Lifecycle announcements wait for `WORKSHOP_ANNOUNCEMENT_DELAY_MINUTES` before delivery; a later feed poll can update the pending content during that window. Set it to `0` during testing to deliver on the next synchronization. The first synchronization records the current feed without announcing it unless `WORKSHOP_ANNOUNCE_INITIAL_SYNC=true`. The uptime service creates its status message when no saved message ID exists, then edits that message on every poll; if the message is deleted, it creates and persists a replacement.

The counting-chain record has this shape; keep the other top-level state keys
when editing it offline:

```json
{
  "countingChain": {
    "version": 1,
    "infoMessageId": "DISCORD_INFO_MESSAGE_ID",
    "playerHighScores": {
      "DISCORD_USER_ID": 66
    },
    "historyRecoveryPending": false,
    "expectedNumber": 67,
    "lastAuthorId": "DISCORD_USER_ID",
    "lastMessageId": "DISCORD_MESSAGE_ID",
    "lastProcessedMessageId": "DISCORD_MESSAGE_ID",
    "updatedAt": "2026-10-23T00:00:00.000Z",
    "highScore": 66,
    "highScoreAt": "2026-10-22T23:55:00.000Z",
    "lastRound": 66,
    "lastRoundAt": "2026-10-22T23:56:00.000Z",
    "lastRoundReason": "same-user",
    "lastGameEnding": {
      "messageId": "DISCORD_MESSAGE_ID",
      "authorId": "DISCORD_USER_ID",
      "expectedNumber": 67,
      "proposedNumber": 67,
      "reason": "same-user",
      "endedAt": "2026-10-22T23:56:00.000Z"
    },
    "pendingReview": {
      "messageId": "DISCORD_MESSAGE_ID",
      "authorId": "DISCORD_USER_ID",
      "expectedNumber": 67,
      "proposedNumber": 67,
      "reason": "wrong-number",
      "endedAt": "2026-10-23T00:00:00.000Z",
      "reviewMessageId": "DISCORD_REVIEW_REPLY_ID",
      "requestedAt": "2026-10-23T00:00:00.000Z"
    }
  }
}
```

`expectedNumber` is the next number accepted, `highScore` is the highest
accepted number, and `lastRound` is the score reached before the latest reset.
`lastRoundReason` may use `same-user` or `wrong-number`, or contain a custom
display note. `lastGameEnding` identifies the most recent image that caused a
normal reset and is retained so `/review` can reopen that image without a
message ID. A pending review contains the target message, the number the model
proposed, and the reason (`unreadable`, `wrong-number`, `same-user`, or
`manual`). While it exists, the service holds newer counting posts. Both
records are cleared after a moderator approves or confirms the reset.
`lastProcessedMessageId` is the Discord history scan checkpoint used for startup
reconciliation. It advances to the newest scanned message, including messages
without a supported image; `lastMessageId` remains the last accepted counting
image. This lets a restart resume from the newest message without changing the
game state for ordinary chat. The bot accepts older records without the score
fields or checkpoint and fills them in on the next state write. It also accepts
the previous nested `game` and channel-keyed `games` shapes and rewrites them to
this flat shape at startup.

On every startup, STEMBot reads the configured counting channel history and
processes image messages newer than `lastProcessedMessageId` in chronological
Discord message-ID order. This catches images posted while the container was
offline and preserves the normal reactions, resets, score updates, and info
message updates. The history reader paginates the channel rather than limiting
recovery to the most recent 50 messages. `historyRecoveryPending` is written
when Discord history or reconciliation cannot complete; it causes the next
startup to retry while retaining the last durable game state.

Reminders are due when polling observes the configured lead time and the workshop has not started. A late poll after downtime still sends a reminder if the workshop is still in the future. Cancelled, private, and hidden workshops do not receive reminders, and `WORKSHOP_REMINDER_LOCATIONS` filters reminders by case-insensitive location without affecting lifecycle announcements. A small process failure window remains between a Discord send and the following state write; the state marker is written immediately after each successful delivery.

Streaming scheduling/trigger commands are still a placeholder. The configuration flag and channel are reserved until the Discord workflow and voice-link policy are agreed.

## Docker and TrueNAS

Create `.env` on the deployment host and select a dataset for persistent state:

```sh
export STEMBOT_DATA_DIR=/mnt/tank/appdata/stembot
docker compose config --quiet
docker compose pull
docker compose up -d --no-build
docker compose logs -f stembot
```

The production Compose file pulls
`ghcr.io/stemmechanics/stembot-discord-bot:latest`, which is published by the
GitHub Actions workflow on `main` and version tags. Set `STEMBOT_IMAGE_TAG` to
an immutable SHA or release tag for controlled rollouts, and run `docker login
ghcr.io` first if the package is private.
Use a GitHub token with `read:packages` permission for a private package.

The Compose service uses the Node.js 24 slim image, runs as the unprivileged `node` user, mounts only the state directory for writes, uses a read-only root filesystem, drops Linux capabilities, enables `no-new-privileges`, and restarts unless stopped. It uses explicit configurable DNS resolvers by default (`1.1.1.1` and `9.9.9.9`); set `STEMBOT_DNS_PRIMARY` and `STEMBOT_DNS_SECONDARY` when the deployment network requires different resolvers. Give the dataset to the container user with permissions that allow the atomic state-file rename.

The bot synchronizes commands automatically before connecting to Discord. A
manual synchronization from the checked-out repository is still available:

```sh
npm run sync:commands
```

When the published image is already running on TrueNAS, run the compiled
entrypoint inside the service so it uses the container's exact credentials and
configuration:

```sh
docker compose exec -T stembot node dist/register-commands.js
```

The command uses the target `DISCORD_GUILD_ID` from the deployment `.env`. It
does not restart the container; the same operation also runs automatically on
the next container startup.

The Node.js runtime prefers IPv4 for outbound connections. This avoids a
dual-stack TrueNAS network waiting for an unavailable IPv6 route before
falling back to IPv4; that delay can exceed Discord's interaction response
deadline and produce error 10062 (`Unknown interaction`).

The Docker resolver configuration is also required when the TrueNAS host's
default container DNS is slow or unreachable. The Node.js setting cannot repair
DNS resolution by itself.

If TrueNAS manages the application without a Compose file in the current
directory, find the running container and invoke the compiled entrypoint
directly:

```sh
sudo docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
sudo docker exec <container-name> node /app/dist/register-commands.js
```

The JavaScript file must be passed to `node`; executing it directly can result
in `permission denied`. The error `no configuration file provided: not found`
from `docker compose` means the command was run outside the Compose project.

For local image builds, use `docker-compose.dev.yml` with the production file:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml build
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

The GitHub Actions container workflow builds and publishes the Dockerfile to
GHCR. This workspace could not run Docker Compose because the local Docker
Compose plugin is unavailable; run the pull and startup checks on TrueNAS or
in CI.

## Security and privacy

The bot uses only the `Guilds` gateway intent by default. Enabling cake-day announcements additionally enables the privileged `GuildMembers` intent so the bot can read the current guild member list. Enabling the counting-chain minigame, AI quiz, scramble, mention-based AI answers or user levels additionally enables `GuildMessages` and the privileged `MessageContent` intent. Counting-chain review or user levels also enables `GuildMessageReactions` and Discord partial message support. It needs channel permissions only where notifications or games are enabled. Secrets are environment variables and are excluded by `.gitignore`; never commit `.env`, tokens, OpenAI keys, or API credentials.

The configured direct STEMCraft URL is HTTP and the plugin’s embedded server defaults to loopback. Production deployment needs a protected reachable path, preferably HTTPS with network ACLs and an agreed bearer-token contract. Do not expose port 8950 broadly. The Website HTTPS status proxy can provide the aggregate `/minecraft` data but currently omits player names; `/minecraft` therefore requires an authenticated or network-protected STEMCraft path that includes the approved username array. Player data contains usernames only.

## Next phase

The remaining cross-repository work and recommended order are maintained in [`TODO.md`](TODO.md). The next external work is to publish stable registration metadata if required and agree/deploy a secure STEMCraft status path. The current XML and username-list fixes are deployed and verified.

STEMBot is licensed under the GNU General Public License, version 3. See
[LICENSE](LICENSE).
