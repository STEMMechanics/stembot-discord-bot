# STEMBot

STEMBot is the official STEMMechanics Discord bot. It is a TypeScript service designed for an independent Docker deployment on TrueNAS.

The current implementation connects Discord to the public STEMMechanics workshop RSS feed and the STEMCraft status endpoint. It provides read-only workshop and server commands, persistent workshop announcements, and 24-hour and 1-hour reminders. The deployed Website and STEMCraft response shapes were verified on 22 October 2026, and the adapters retain compatibility with older responses.

## Architecture

```text
src/
  app.ts                         Application composition and lifecycle
  index.ts                       Process entry point and shutdown handlers
  register-commands.ts           Explicit Discord slash-command sync entry point
  config/env.ts                  Validated environment configuration
  logging/logger.ts              Structured JSON logging with Pino
  discord/                       Client, commands, interactions, channel delivery
  integrations/                  Website RSS and STEMCraft HTTP adapters
  services/                      Workshop notifications and streaming boundary
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
- `/workshops` — upcoming public workshops, sorted by start time with local formatting and registration/details links.
- `/schedule` — upcoming workshops whose feed `sm:type` is `stemcraft`.
- `/minecraft` — server availability, player count, capacity, maintenance state, and version.
- `/players` — online Minecraft usernames only. It is available to all members. If the configured STEMCraft response has no permitted player list, the command reports that names are unavailable.

`/workshops` and `/schedule` use `WORKSHOP_TIME_ZONE`; feed timestamps retain their supplied offsets when converted to instants.

### Discord command synchronization

`npm run sync:commands` performs a complete Discord replacement with the five
supported commands in the configured guild scope. It first removes existing
global command registrations for this application, then bulk-replaces the
global set with an empty list and the target guild set with the supported
commands. This single-server deployment therefore has one authoritative copy
of each command. Obsolete commands, including old `/joke`, `/embed` and
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

The STEMCraft adapter supports the deployed response (`online`, `players_online`, `max_players`, `version`, `maintenance`, `message`, `players`, `checked_at`). The live endpoint currently supplies a username-only `players` array when `web-server.status.players.enabled` is enabled. Older responses without that array remain supported; `/players` reports that names are unavailable in that case. UUIDs and other identity fields are discarded.

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

| Variable                                    | Required | Purpose                                                                               |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`                             | Yes      | Discord bot token. Keep it in the deployment secret store.                            |
| `DISCORD_CLIENT_ID`                         | Yes      | Discord application ID.                                                               |
| `DISCORD_GUILD_ID`                          | Yes      | The single Discord guild where STEMBot commands are registered.                       |
| `WORKSHOP_FEED_URL`                         | No       | Website RSS URL; defaults to the STEMMechanics workshop feed.                         |
| `WEBSITE_REQUEST_TIMEOUT_MS`                | No       | RSS request timeout; defaults to 15 seconds.                                          |
| `STEMCRAFT_STATUS_URL`                      | No       | STEMCraft status URL; defaults to `http://play.stemcraft.com.au:8950/status`.         |
| `STEMCRAFT_STATUS_TOKEN`                    | No       | Optional bearer token for a protected status endpoint.                                |
| `STEMCRAFT_REQUEST_TIMEOUT_MS`              | No       | Status request timeout; defaults to 5 seconds.                                        |
| `WORKSHOP_TIME_ZONE`                        | No       | IANA timezone for Discord output and notifications; defaults to `Australia/Brisbane`. |
| `WORKSHOP_POLL_INTERVAL_MS`                 | No       | Feed polling interval; defaults to 5 minutes.                                         |
| `WORKSHOP_ANNOUNCEMENTS_ENABLED`            | No       | Enable new/update/cancellation announcements; defaults to `true`.                     |
| `WORKSHOP_REMINDERS_ENABLED`                | No       | Enable workshop reminders; defaults to `true`.                                        |
| `WORKSHOP_REMINDER_24H_ENABLED`             | No       | Enable the 24-hour reminder; defaults to `true`.                                      |
| `WORKSHOP_REMINDER_1H_ENABLED`              | No       | Enable the 1-hour reminder; defaults to `true`.                                       |
| `WORKSHOP_ANNOUNCE_INITIAL_SYNC`            | No       | Announce all feed items on the first sync; defaults to `false` to avoid startup spam. |
| `DISCORD_WORKSHOP_ANNOUNCEMENT_CHANNEL_ID`  | No       | Channel for workshop lifecycle announcements.                                         |
| `DISCORD_WORKSHOP_REMINDER_CHANNEL_ID`      | No       | Channel for 24-hour and 1-hour reminders.                                             |
| `STREAMING_NOTIFICATIONS_ENABLED`           | No       | Reserved setting for the streaming workflow; defaults to `false`.                     |
| `DISCORD_STREAMING_NOTIFICATION_CHANNEL_ID` | No       | Reserved streaming notification channel.                                              |
| `STATE_PATH`                                | No       | Persistent JSON state path; defaults to `./data/state.json`.                          |
| `SHUTDOWN_TIMEOUT_MS`                       | No       | Graceful shutdown deadline; defaults to 30 seconds.                                   |
| `NODE_ENV`                                  | No       | `development`, `test`, or `production`; defaults to `production`.                     |
| `LOG_LEVEL`                                 | No       | Pino level; defaults to `info`.                                                       |

The loader validates Discord IDs, URLs, positive intervals, booleans, and the IANA timezone. Blank optional values are treated as unset.

## Announcements, reminders, and state

The scheduler performs an initial synchronization after Discord connects and repeats it at `WORKSHOP_POLL_INTERVAL_MS`. It compares a SHA-256 fingerprint of meaningful workshop fields. A stable `sm:id` prevents duplicate records even when titles repeat; GUIDs remain compatible with older state and feeds. New workshops, meaningful updates, and `sm:statusCode=cancelled` transitions produce separate messages when announcements and a channel are configured. Missing or removed items are not cancellation events, while retained cancellation records can be processed after their scheduled date.

The JSON state file stores the current workshop fingerprint, pending lifecycle event, last delivered Discord message ID, and reminder delivery markers. It is written atomically, mounted at `/app/data` in Compose, and survives container restarts. The first synchronization records the current feed without announcing it unless `WORKSHOP_ANNOUNCE_INITIAL_SYNC=true`.

Reminders are due when polling observes the configured lead time and the workshop has not started. A late poll after downtime still sends a reminder if the workshop is still in the future. Cancelled workshops do not receive reminders. A small process failure window remains between a Discord send and the following state write; the state marker is written immediately after each successful delivery.

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

The Compose service uses the Node.js 24 slim image, runs as the unprivileged `node` user, mounts only the state directory for writes, uses a read-only root filesystem, drops Linux capabilities, enables `no-new-privileges`, and restarts unless stopped. Give the dataset to the container user with permissions that allow the atomic state-file rename.

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

The bot uses only the `Guilds` gateway intent. It needs channel permissions only where notifications are enabled. Secrets are environment variables and are excluded by `.gitignore`; never commit `.env`, tokens, or API credentials.

The configured direct STEMCraft URL is HTTP and the plugin’s embedded server defaults to loopback. Production deployment needs a protected reachable path, preferably HTTPS with network ACLs and an agreed bearer-token contract. Do not expose port 8950 broadly. The Website HTTPS status proxy can provide the aggregate `/minecraft` data but currently omits player names; `/players` therefore requires an authenticated or network-protected STEMCraft path that includes the approved username array. `/players` emits usernames only.

## Next phase

The remaining cross-repository work and recommended order are maintained in [`TODO.md`](TODO.md). The next external work is to publish stable registration metadata if required and agree/deploy a secure STEMCraft status path. The current XML and username-list fixes are deployed and verified.

STEMBot is licensed under the GNU General Public License, version 3. See
[LICENSE](LICENSE).
