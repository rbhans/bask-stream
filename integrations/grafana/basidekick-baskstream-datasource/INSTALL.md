# baskStream Grafana Install

The normal install path is a private signed Grafana plugin package. Use unsigned packages only for local development.

## Build A Signed Package

From this plugin directory:

```bash
npm ci
export GRAFANA_ACCESS_POLICY_TOKEN='<grafana cloud access policy token>'
GRAFANA_ROOT_URLS=http://127.0.0.1:3000 npm run package:signed
```

This creates:

```text
artifacts/basidekick-baskstream-datasource-1.0.0-signed.zip
```

`GRAFANA_ROOT_URLS` must match Grafana's configured `server.root_url`, including scheme, host, port, and path. For multiple private Grafana servers, use a comma-separated list:

```bash
GRAFANA_ROOT_URLS=http://127.0.0.1:3000,https://grafana.example.com npm run package:signed
```

The package includes backend binaries for:

| Platform | Binary |
| --- | --- |
| Windows x64 | `gpx_bask_stream_windows_amd64.exe` |
| Linux x64 | `gpx_bask_stream_linux_amd64` |
| Linux arm64 | `gpx_bask_stream_linux_arm64` |
| macOS Intel | `gpx_bask_stream_darwin_amd64` |
| macOS Apple Silicon | `gpx_bask_stream_darwin_arm64` |

## Unsigned Development Package

For temporary local development only:

```bash
npm run package:all
```

This creates:

```text
artifacts/basidekick-baskstream-datasource-1.0.0-unsigned-all.zip
```

Unsigned packages require Grafana's development allowlist:

```ini
[plugins]
allow_loading_unsigned_plugins = basidekick-baskstream-datasource
```

Do not use the unsigned allowlist for normal signed installs.

## Build Notes

If you are building on Windows, use WSL or another filesystem that supports npm symlinks. Installing the final plugin into native Windows Grafana is supported, but running `npm ci` from a mounted filesystem that rejects symlink creation can fail.

## Windows Install

1. Extract the zip so this folder exists:

   ```text
   C:\Program Files\GrafanaLabs\grafana\data\plugins\basidekick-baskstream-datasource
   ```

2. Edit Grafana's custom config file, usually here:

   ```text
   C:\Program Files\GrafanaLabs\grafana\conf\custom.ini
   ```

3. Confirm `server.root_url` matches one of the URLs used when signing:

   ```ini
   [server]
   root_url = http://127.0.0.1:3000/
   ```

4. Restart Grafana:

   ```powershell
   Restart-Service grafana
   ```

5. In Grafana, add the `BaskStream` data source and configure the station URL, Niagara username, and password.

For unsigned development packages only, also add the unsigned allowlist from the unsigned section above.

## Linux Install

Extract the zip to:

```text
/var/lib/grafana/plugins/basidekick-baskstream-datasource
```

Set `server.root_url` in `grafana.ini` to one of the URLs used when signing:

```ini
[server]
root_url = http://127.0.0.1:3000/
```

Restart Grafana:

```bash
sudo systemctl restart grafana-server
```

## macOS Install

For a Homebrew Grafana install, extract the zip under Grafana's plugin directory, commonly:

```text
/opt/homebrew/var/lib/grafana/plugins/basidekick-baskstream-datasource
```

For Intel Homebrew installs, the prefix may be:

```text
/usr/local/var/lib/grafana/plugins/basidekick-baskstream-datasource
```

For signed packages, configure `server.root_url` instead of the unsigned allowlist. The configured root URL must match one of the URLs used when signing. Restart Grafana after changing the config.

## Docker Install

For a local Docker Grafana test container:

```bash
docker run -d \
  --name baskstream-grafana \
  -p 127.0.0.1:3000:3000 \
  -v baskstream-grafana-storage:/var/lib/grafana \
  -e GF_SERVER_ROOT_URL=http://127.0.0.1:3000/ \
  -e GF_SECURITY_ADMIN_USER=admin \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  grafana/grafana-oss:latest
```

Copy the extracted signed plugin directory into the container:

```bash
docker cp basidekick-baskstream-datasource baskstream-grafana:/var/lib/grafana/plugins/
docker restart baskstream-grafana
```

Do not set `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` for signed package verification.

## First Data Source Setup

Use:

| Field | Recommended value |
| --- | --- |
| Station URL | `https://<station-host>` |
| Username | Dedicated least-privilege Niagara user |
| Password | Niagara password, stored by Grafana as secure data |
| TLS mode | `verify` for production |
| Allow plain HTTP | Off unless this is an isolated lab station |

Click **Save & test**. A successful check confirms Niagara login, `/stream/health`, WebSocket connection, and `capabilities`.

## Using The Data Source

Create or edit a panel and choose the `BaskStream` data source.

| Mode | Use for | Required fields |
| --- | --- | --- |
| History | Trend charts from Niagara histories | `ord` |
| Snapshot | Current values in table panels | `ords` |
| Live | Live current-value panels through Grafana Live | `ords` |

Use the point search or browse controls to select point ORDs. For history panels, pick a point with history available or enter a history ORD directly.

## Verification

After restart, the plugin settings API or Grafana UI should show:

```text
signature = valid
signatureType = private
```

Save & Test should return:

```text
Connected to baskStream apiVersion=<version> user=<user>
```
