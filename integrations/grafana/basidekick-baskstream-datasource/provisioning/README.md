# baskStream Grafana Provisioning

`datasources/datasources.yml` provisions the local development data source used by `npm run server` and `npm run e2e`.

Set these environment variables before starting Grafana:

```bash
export BASKSTREAM_STATION_URL=https://station.example.com
export BASKSTREAM_USERNAME=grafana
export BASKSTREAM_PASSWORD='station password'
```

Passwords stay in `secureJsonData`. The checked-in provisioning defaults to TLS verification and does not enable plain HTTP.
