# STEMBot deployment

STEMBot is deployed as one Docker Compose service on TrueNAS. The service has
no inbound listener; it connects outbound to Discord, the Website RSS feed and
the configured STEMCraft status URL. Keep the deployment checkout, .env file
and persistent state directory on the TrueNAS host.

## Prerequisites

- Docker Engine with Docker Compose v2 on the deployment host.
- A TrueNAS dataset that the container's unprivileged node user can write to.
- A Discord application with a bot token and the applications.commands scope
  installed in the target server.
- A protected, reachable STEMCraft status endpoint. The default HTTP endpoint
  is suitable for compatibility testing only; production traffic needs the
  P0 transport, network and authentication work described in TODO.md.

The bot needs only the Discord Guilds gateway intent. Give it View Channel and
Send Messages in each configured notification channel, plus the permissions
required to use application commands.

## Configure the host

Check out the approved STEMBot commit, then create the deployment environment
file. Store the file in the deployment secret store or protect it with the
host's ACLs; it contains the Discord token and may contain the STEMCraft
bearer token.

    cp .env.example .env
    chmod 600 .env

Set at least DISCORD_TOKEN and DISCORD_CLIENT_ID. Set the workshop announcement
and reminder channel IDs before enabling those notifications. Set
STEMCRAFT_STATUS_URL and STEMCRAFT_STATUS_TOKEN to the protected STEMCraft
path agreed with the plugin and infrastructure owners. Do not expose port
8950 directly to the Internet.

The default WORKSHOP_ANNOUNCE_INITIAL_SYNC=false records the current feed
without sending a startup burst of lifecycle announcements. Set it to true
only when an initial announcement is intentional. The first synchronization
can still deliver reminders that are already due for future workshops.

## Validate and start

Use the same checkout and .env for command registration and the container.
Register commands from a workstation or CI environment with Node.js 24 and
dependencies installed:

    npm ci
    npm run register:commands

Set DISCORD_GUILD_ID while developing or staging so command changes appear
immediately. Omit it when registering global production commands.

Select the persistent dataset through the Compose variable, validate the
Compose file, build the image and start the service:

    export STEMBOT_DATA_DIR=/mnt/tank/appdata/stembot
    docker compose config --quiet
    docker compose build --pull
    docker compose up -d
    docker compose ps
    docker compose logs --tail=100 stembot

The Compose service sets STATE_PATH=/app/data/state.json and mounts
STEMBOT_DATA_DIR at /app/data. The application writes state atomically, so the
mounted directory must permit temporary-file creation and rename by the
container user. The state file contains workshop IDs, fingerprints, Discord
message IDs and reminder markers; it does not contain Discord credentials.

After startup, confirm the logs show a successful Discord connection and
workshop synchronization. Test /ping, /workshops, /schedule, /minecraft and
/players in a staging guild before enabling production notification channels.

## Operations

Inspect the running service and recent structured logs with:

    docker compose ps
    docker compose logs --tail=200 -f stembot

Apply an approved update with:

    docker compose build --pull
    docker compose up -d

The process handles SIGTERM and stops its scheduler and Discord client within
the configured SHUTDOWN_TIMEOUT_MS. To stop it for maintenance:

    docker compose stop stembot

Before moving the dataset or restoring an earlier deployment, stop the
container and copy state.json to a protected backup location. Restoring this
file preserves announcement and reminder deduplication across the deployment
change. Keep the old image or deployment commit available until the new
container has passed the smoke checks.

The current Compose file has no HTTP health endpoint. Treat docker compose ps,
startup logs, successful Discord connection and a successful manual command
check as the deployment health signal. A machine-readable health check and
metrics remain a P2 item in TODO.md.

## Troubleshooting

- **Slash commands are missing:** run npm run register:commands with the
  intended application and guild IDs, check the bot installation scope, and
  allow Discord time to propagate global commands.
- **No workshop announcements:** verify the announcement channel ID,
  WORKSHOP_ANNOUNCEMENTS_ENABLED, channel permissions and the state file.
  Existing feed entries are intentionally quiet on the first sync by default.
- **No reminders:** verify the reminder channel ID, the reminder flags, the
  workshop's future start time and the polling interval. Cancelled, private
  and hidden workshops are excluded.
- **/players reports names unavailable:** confirm that the configured protected
  STEMCraft response includes the username-only players array. The Website
  aggregate status response currently does not provide player names.
- **State write errors:** check the TrueNAS dataset ACL and confirm the
  container's node user can create and rename files in the mounted directory.

Streaming notification commands remain disabled and reserved until the
administrative workflow and voice-channel policy are agreed.
