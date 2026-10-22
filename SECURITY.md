# Security policy

STEMBot handles a Discord bot credential, external service credentials and
Minecraft usernames in an educational community. Treat configuration,
persistent state and operational logs as private deployment data.

## Reporting a vulnerability

Please report security issues privately to the STEMMechanics maintainers
through the GitHub organisation's private security reporting mechanism or
another private maintainer channel. Do not open a public issue for an unfixed
vulnerability, token, credential or personal data.

Include the affected commit or deployment version, the impact, reproduction
steps and any relevant logs with secrets and personal data removed. If a
credential may have been exposed, say which kind so it can be rotated quickly.

## Security expectations

- Keep DISCORD_TOKEN, STEMCRAFT_STATUS_TOKEN and any deployment secrets in
  the host secret store or protected environment file. Never commit them or
  include them in issue reports.
- Use a protected STEMCraft status path with network access controls and
  authentication. The default HTTP URL exists for compatibility and testing;
  it is not a production security boundary.
- Grant the Discord bot only the Guilds intent and the channel permissions it
  needs. Review notification channel access when the bot is installed or
  moved.
- /players exposes Minecraft usernames only and is intended for authorised
  access to the protected STEMCraft response. Do not add UUIDs, account
  metadata, Discord identities or other personal information to public
  messages.
- Keep the persistent state directory private. It contains workshop identity
  data, fingerprints, Discord message IDs and reminder delivery markers.
- Review structured logs before sharing them. They should not contain tokens,
  response bodies or unnecessary player information.
- Keep the Docker service unprivileged, read-only at the root filesystem,
  without added capabilities and without an exposed inbound port.

If a Discord token, bearer token or host secret is exposed, revoke or rotate
it immediately, stop affected notification delivery if necessary, preserve
the minimum evidence needed for investigation and notify the maintainers
privately.
