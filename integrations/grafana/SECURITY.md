# Grafana Integration Security

The Grafana integration must be read-only by default and must not weaken Niagara station security.

## Credentials

- Store Niagara credentials in Grafana secure data source settings.
- Do not put Niagara usernames, passwords, or cookies in browser-side query JSON.
- Do not write credentials to plugin logs.
- Prefer a dedicated least-privilege Niagara user for Grafana.
- The Grafana user should only have permissions required for selected points, histories, and metadata.

## TLS

The plugin should support two explicit TLS modes:

| Mode                 | Behavior                                         |
| -------------------- | ------------------------------------------------ |
| `verify`             | Require a trusted station certificate.           |
| `insecureSkipVerify` | Allow self-signed or untrusted lab certificates. |

The insecure mode must be visible in configuration and documentation.

Station URLs should use `https://` by default. Plain `http://`/`ws://` is blocked unless the datasource explicitly enables the lab-only plain HTTP option.

## Station Scope

Use baskStream station-side controls:

- `allowedPathPatterns` for ORD scope.
- Niagara user permissions for read access.
- Module max point and subscription limits.
- Module history limits.

The plugin enforces its own conservative history, point count, and live lease limits before sending requests, but station-side limits remain authoritative.

## Read-Only V1

The first Grafana integration must not expose:

- point writes
- emergency overrides
- alarm acknowledgement
- alarm clearing
- schedule edits
- raw arbitrary operations

Grafana dashboards are not an appropriate first surface for control actions.

## Live Subscriptions

Live query streams must release or allow expiration of subscription groups when Grafana panels close.

Recommended safeguards:

- bounded `leaseSec`, capped by the data source Max live lease setting
- per-stream point caps, capped by both the data source Max point ORDs setting and station-advertised live subscription limits
- reconnect backoff
- no auto-subscribe-all behavior
- clear distinction between live current values and historical trends

## Plugin Distribution

Private/internal Grafana installs should use a private signed plugin package. Unsigned-plugin settings are for temporary local development only. Public or Grafana Cloud distribution has additional signing and review requirements.

Document the target distribution mode before packaging the plugin:

| Mode                 | Notes                                                                |
| -------------------- | -------------------------------------------------------------------- |
| Internal/private     | Use private signing and exact Grafana root URLs.                     |
| Unsigned development | Local development only; requires Grafana's unsigned-plugin allowlist. |
| Signed public plugin | Requires stronger packaging, support, and compatibility commitments. |
| Grafana Cloud        | Treat as a later product decision, not V1.                           |

## Logging

Plugin logs may include:

- station URL host
- data source UID
- query mode
- point counts
- elapsed time
- baskStream error code

Plugin logs must not include:

- passwords
- session cookies
- full request bodies containing secrets
- customer-sensitive point values unless explicitly enabled for diagnostics

## Legal And Branding

Keep the same boundary as the main repository:

- Do not imply Tridium, Honeywell, or Grafana endorsement.
- Use only authorized Niagara stations and licenses.
- Do not copy proprietary Niagara documentation or internals into the integration.
