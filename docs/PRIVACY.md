# Privacy

This project is local-first and does not include telemetry, analytics, hosted
accounts, or a remote baskStream service operated by this repository.

## Data Handled

Depending on enabled features and station permissions, clients may process:

- station URL, username, and password or session cookies
- station tree names, ORDs, types, tags, relations, and metadata
- point values, statuses, facets, histories, schedules, and alarms
- write descriptions and explicitly requested write or alarm actions

## Where Data Goes

- The Niagara module runs on the user's Niagara station.
- The companion app talks to the configured station through the local helper
  server when used outside the station origin.
- The MCP server runs as a local stdio process and sends tool results to the
  MCP client selected by the user.
- If the MCP client is connected to a hosted AI model, station data returned by
  tools may be transmitted to that AI service under that service's terms.

## Credentials

Do not commit real station credentials. Store credentials in local environment
variables, MCP client settings, operating-system secret storage where supported,
or ignored local files such as `tools/mcp/config.json`.

## Operator Responsibilities

Users are responsible for choosing an appropriate AI client, reviewing that
client's privacy and data-use terms, limiting station permissions, and obtaining
authorization before connecting to customer systems.
