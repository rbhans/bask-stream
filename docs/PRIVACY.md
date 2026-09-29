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
- The bask CLI and apps built on the TypeScript SDK talk directly to the
  configured station. bask stores only session cookies, in
  `~/.config/baskstream/profiles.json` (Windows: `%APPDATA%\baskstream`), and
  never the password.

## Credentials

Do not commit real station credentials. Store credentials in local environment
variables, operating-system secret storage where supported, or ignored local
files.

## Operator Responsibilities

Users are responsible for choosing an appropriate AI client, reviewing that
client's privacy and data-use terms, limiting station permissions, and obtaining
authorization before connecting to customer systems.
