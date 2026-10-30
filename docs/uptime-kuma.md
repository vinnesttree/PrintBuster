# Monitoring with Uptime Kuma

PrintBuster depends on two upstream sites:

- **Design Hub** (Studio Manager, `designhub-manager.unl.edu`) for the reservations
- **Bambu cloud** (the service behind Bambu Studio and Bambu Handy) for the print jobs

[Uptime Kuma](https://github.com/louislam/uptime-kuma) can tell you when PrintBuster stops being able to read either one, for example when the Design Hub session cookie expires, the Bambu token runs out, Bambu asks for an emailed sign-in code, or a site is down.

PrintBuster judges each source by its own [data collection](../README.md#data-collection), which runs every 2 minutes while a page is open and every 15 minutes otherwise. A source is:

| State | Meaning |
| --- | --- |
| `up` | The last collection read the source. |
| `down` | The last collection couldn't read it. The response includes an error code such as `designhub_auth` or `bambu_code_required`. |
| `pending` | PrintBuster has just started and hasn't collected yet (usually a few seconds). |
| `stale` | No collection for over twice the longer of `POLL_ACTIVE_MINUTES` and `POLL_IDLE_MINUTES`, plus 5 minutes (35 minutes with the defaults). With both set to `0` this check is off. |

There are two ways to connect Kuma. Pick one per source, or use both.

| | **Pull**: Kuma checks PrintBuster | **Push**: PrintBuster reports to Kuma |
| --- | --- | --- |
| Kuma monitor type | HTTP(s) | Push |
| Kuma needs to reach PrintBuster | Yes | No. PrintBuster needs to reach Kuma. |
| Works with the default `HOST=127.0.0.1` | Only if Kuma runs on the same computer, outside Docker | Yes |
| Notices PrintBuster itself being down | Yes (connection refused) | Yes (the pushes stop) |
| Error message in Kuma's alert | Error code only | The full message and what to do about it |

**Push is usually simpler**, because PrintBuster normally publishes its page only on `127.0.0.1`.

## Option A: Push monitors (recommended)

PrintBuster calls a Kuma push URL after every collection, with `status=up` or `status=down`, a message and the source's response time.

1. In Uptime Kuma, click **Add New Monitor**.
2. Set **Monitor Type** to **Push**.
3. Set **Friendly Name** to e.g. `PrintBuster – Design Hub`.
4. Set **Heartbeat Interval** longer than PrintBuster's longest gap between collections. With the default `POLL_IDLE_MINUTES=15`, use **1200** seconds (20 minutes). If no push arrives within this time, Kuma marks the monitor down. That catches PrintBuster itself being stopped.
5. Copy the **Push URL** Kuma shows, e.g. `https://kuma.example.com/api/push/Ab12Cd34Ef?status=up&msg=OK&ping=`. Copy it as is. PrintBuster replaces `status`, `msg` and `ping` on each push.
6. Click **Save**.
7. Repeat steps 1–6 for a second monitor named e.g. `PrintBuster – Bambu cloud`.
8. Put both URLs in PrintBuster's `.env`, in single quotes:

   ```sh
   UPTIME_KUMA_PUSH_DESIGNHUB='https://kuma.example.com/api/push/Ab12Cd34Ef?status=up&msg=OK&ping='
   UPTIME_KUMA_PUSH_BAMBU='https://kuma.example.com/api/push/Gh56Ij78Kl?status=up&msg=OK&ping='
   ```

9. Restart PrintBuster: `npm start`, or `docker compose up -d` with Docker. The startup log says `Reporting to Uptime Kuma after each collection: designhub, bambu.`

Within a minute both monitors should turn green. Each heartbeat shows `OK` and the time PrintBuster took to read that source. When a source fails, the heartbeat message is the same error the PrintBuster page shows, e.g. `Bambu emailed a verification code to s***@example.com. Enter it to finish signing in.`

Things to know:

- **Alerts come at once.** PrintBuster sends `status=down` on the first failed collection. Recent Uptime Kuma versions treat an explicit `down` push as final and skip the monitor's **Retries**. If brief blips are too noisy, use pull monitors instead, where Kuma's Retries setting applies.
- **Only collections push.** If you set both `POLL_ACTIVE_MINUTES` and `POLL_IDLE_MINUTES` to `0`, PrintBuster only collects when someone presses **Collect now** on the Admin page, so Kuma will report the monitors down.
- **PrintBuster must reach Kuma.** If Kuma runs in Docker on the same computer, use an address PrintBuster can reach, e.g. the computer's LAN address and Kuma's published port (`http://192.168.1.20:3001/api/push/…`). From inside PrintBuster's container, `127.0.0.1` means the container itself, not the computer.
- **A failed push doesn't affect PrintBuster.** It logs `Uptime Kuma push for Bambu cloud failed: …` once, and `… resumed.` when it works again. An unknown or paused monitor shows as `HTTP 404: Monitor not found or not active.`
- **Treat the push URLs like passwords.** Anyone with one can mark that monitor up or down.
- **Demo mode** pushes `OK (demo data)` for both sources.

## Option B: HTTP monitors (pull)

PrintBuster answers these without a login, even when `APP_PASSWORD` is set, like the container's `/healthz`:

| Endpoint | 200 when | 503 when |
| --- | --- | --- |
| `/healthz/designhub` | Design Hub is up | it's down, pending or stale |
| `/healthz/bambu` | Bambu cloud is up | it's down, pending or stale |
| `/healthz/sources` | both are up | either one isn't |
| `/healthz` | PrintBuster is running | — |

The responses are small JSON objects. They contain no member names and no error messages, only the state, an error code and when PrintBuster last checked:

```json
{"source":"bambu","name":"Bambu cloud","ok":false,"status":"down","checkedAt":"2026-10-27T23:00:00.000Z","code":"bambu_code_required"}
```

```json
{"source":"designhub","name":"Design Hub (Studio Manager)","ok":true,"status":"up","checkedAt":"2026-10-27T23:00:00.000Z","responseMs":840}
```

`responseMs` is how long the last collection took to read that source.

### First, let Kuma reach PrintBuster

With the default `HOST=127.0.0.1`, only programs running on the same computer, outside Docker, can open PrintBuster. Choose one:

- **Kuma on the same computer, not in Docker:** use `http://127.0.0.1:3000`. Nothing to change.
- **Kuma on another computer or in its own Docker container:** set `HOST=0.0.0.0` in `.env` and restart, then use `http://<printbuster-computer's address>:3000`. This shares the PrintBuster page on the network too, so also set `APP_USERNAME` and `APP_PASSWORD` (the page shows member names). The `/healthz` endpoints stay open without the password.
- **Kuma in the same Docker Compose project:** add an `uptime-kuma` service to `compose.yaml` and use `http://printbuster:3000`. Services in one Compose project share a network, so `HOST` can stay `127.0.0.1`.

Check from the Kuma computer or container:

```sh
curl -i http://<address>:3000/healthz/bambu
```

### Add the monitors

1. In Uptime Kuma, click **Add New Monitor**.
2. Set **Monitor Type** to **HTTP(s)**.
3. Set **Friendly Name** to e.g. `PrintBuster – Design Hub`.
4. Set **URL** to `http://<address>:3000/healthz/designhub`.
5. Set **Heartbeat Interval** to **60** seconds. Checking more often than PrintBuster collects is fine: the endpoint only reads PrintBuster's last result and never contacts Design Hub or Bambu itself.
6. Set **Retries** to **1** or **2**. Right after PrintBuster restarts, the endpoints answer 503 (`pending`) until the first collection finishes, which usually takes a few seconds. A retry keeps that from alerting.
7. Leave **Accepted Status Codes** at `200-299`.
8. Click **Save**.
9. Repeat for `PrintBuster – Bambu cloud` with `/healthz/bambu`.

Optionally add a third monitor on `/healthz` to tell "PrintBuster is down" apart from "a source is down".

Kuma's alert for a pull monitor says only that the status code was 503. To see why, open `/healthz/<source>` for its `code` (below), or open the PrintBuster page for the full message. Push monitors carry the full message in the alert itself.

## What the error codes mean

| Code | Source | What to do |
| --- | --- | --- |
| `designhub_unreachable` | Design Hub | The site couldn't be reached: it's down, or a network or DNS problem. |
| `designhub_auth` | Design Hub | The login or session cookie stopped working. See [Finding the Design Hub session cookie](../README.md#finding-the-design-hub-session-cookie). |
| `designhub_forbidden` | Design Hub | Signed in, but the account can't open the admin agenda. It needs admin access with the **See Agenda** permission. |
| `designhub_unexpected_page` | Design Hub | Design Hub answered with a page that isn't the agenda, e.g. a maintenance or sign-in page. |
| `designhub_not_configured` | Design Hub | Add `DESIGNHUB_USERNAME` and `DESIGNHUB_PASSWORD`, or `DESIGNHUB_COOKIE`, to `.env`. |
| `bambu_unreachable` | Bambu | The Bambu cloud couldn't be reached: it's down, or a network or DNS problem. |
| `bambu_code_required`, `bambu_tfa_required` | Bambu | Open PrintBuster and type in the code Bambu emailed, or the authenticator code. |
| `bambu_auth` | Bambu | The sign-in or `BAMBU_ACCESS_TOKEN` was rejected. See [Finding a Bambu access token](../README.md#finding-a-bambu-access-token). |
| `bambu_cloudflare` | Bambu | Bambu's Cloudflare protection blocked the request. Use `BAMBU_ACCESS_TOKEN` (same link). |
| `bambu_api` | Bambu | Bambu's API returned an error. Usually temporary. |
| `bambu_not_configured` | Bambu | Add `BAMBU_EMAIL` and `BAMBU_PASSWORD`, or `BAMBU_ACCESS_TOKEN`, to `.env`. |
| `error` | Either | Another unexpected error. PrintBuster's log and page show the details. |

For any code, the PrintBuster page shows the full message, and the server log records it once when the problem starts and again when it clears.
