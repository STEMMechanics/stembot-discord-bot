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
- Access to the published GitHub Container Registry image, or a local image
  mirror configured through STEMBOT_IMAGE.

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

The production Compose file pulls
ghcr.io/stemmechanics/stembot-discord-bot:latest by default. Set
STEMBOT_IMAGE_TAG to an immutable sha tag or release tag for a controlled
deployment. If the GHCR package is private, authenticate before pulling:

    echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

GHCR_TOKEN must be a GitHub token with `read:packages` permission. Store it
in the TrueNAS secret store and do not put it in the repository `.env` file.

The default WORKSHOP_ANNOUNCE_INITIAL_SYNC=false records the current feed
without sending a startup burst of lifecycle announcements. Set it to true
only when an initial announcement is intentional. The first synchronization
can still deliver reminders that are already due for future workshops.

## Validate and start

Use the same `.env` for the container and command synchronization. Set the
single target `DISCORD_GUILD_ID`; it is required for this deployment. The
running service synchronizes commands automatically before connecting to
Discord.

Select the persistent dataset through the Compose variable, validate the
Compose file, pull the published image and start the service:

    export STEMBOT_DATA_DIR=/mnt/tank/appdata/stembot
    docker compose config --quiet
    docker compose pull
    docker compose up -d --no-build
    docker compose ps
    docker compose logs --tail=100 stembot

The Compose service sets STATE_PATH=/app/data/state.json and mounts
STEMBOT_DATA_DIR at /app/data. The application writes state atomically, so the
mounted directory must permit temporary-file creation and rename by the
container user. The state file contains workshop IDs, fingerprints, Discord
message IDs and reminder markers; it does not contain Discord credentials.

After startup, confirm the logs show successful command synchronization, a
Discord connection and workshop synchronization. Test /ping, /workshops,
/schedule, /minecraft and /players in a staging guild before enabling
production notification channels.

## Discord command synchronization

The service synchronizes commands on every process startup, before the Discord
gateway connection is opened. It removes existing global command registrations
for this application, clears the global command set, and replaces the single
configured guild command set with `/ping`, `/workshops`, `/schedule`,
`/minecraft` and `/players`.

If synchronization fails, the process exits before the bot connects. The
Compose restart policy can then retry startup, preventing the bot from running
while Discord has an unverified command set.

1. Put `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and the target `DISCORD_GUILD_ID`
   in the deployment `.env`. The token and application ID must belong to the
   same Discord application.
2. Pull and start the approved image as shown above:

       docker compose pull
       docker compose up -d --no-build

3. Check the structured logs for `Discord application commands synchronized`
   and the reported global/guild counts.

To force a synchronization without restarting the container, run from the
directory containing the deployment `docker-compose.yml` and `.env`:

       docker compose exec -T stembot node dist/register-commands.js

This executes the compiled command synchronizer inside the running container
using its existing environment.

Guild commands should update quickly. Restart the Discord client or refresh the
server command picker after synchronization if it still displays an old cached
copy.

If commands continue to fail with `Unknown interaction` (error 10062), check
for more than one active STEMBot process before changing code or credentials:

    sudo docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

There must be one running container using the STEMBot token. Two gateway
processes can receive the same interaction; one acknowledges it and the other
gets 10062. The application now logs the interaction ID and age for this case,
and ignores duplicate deliveries within one process, but it cannot stop a
second container that is running outside the deployment.

If TrueNAS manages the application without a Compose file in the current
directory, use the running container directly:

    sudo docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
    sudo docker exec <container-name> node /app/dist/register-commands.js

Replace `<container-name>` with the name shown by `docker ps` (the repository
Compose file uses `stembot`). Invoke the JavaScript file through `node`; do
not execute `/app/dist/register-commands.js` as a standalone file. This direct
command uses the running container's existing environment and does not need a
Compose configuration file.

The message `no configuration file provided: not found` means that
`docker compose` was run outside the directory containing the Compose file.
Either change to that directory, pass `-f /path/to/docker-compose.yml` and
`--env-file /path/to/.env`, or use the direct `docker exec` form above.

The synchronizer only modifies the configured application and target guild. It
does not enumerate or modify other Discord applications or other guilds.

## Operations

Inspect the running service and recent structured logs with:

    docker compose ps
    docker compose logs --tail=200 -f stembot

Apply an approved update with:

    docker compose pull
    docker compose up -d --no-build

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

For a local Docker build, use the development override rather than changing
the production image selection:

    docker compose -f docker-compose.yml -f docker-compose.dev.yml build
    docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

## Troubleshooting

- **Slash commands are missing:** from the deployment directory, run:

      docker compose exec -T stembot node dist/register-commands.js

  Then check the intended application and guild IDs, the bot installation
  scope, and allow Discord time to remove old global registrations.

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
