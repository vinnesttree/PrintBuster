# PrintBuster

PrintBuster compares two lists:

- **Reservations** from the Engineering Design Hub admin agenda (Studio Manager, `designhub-manager.unl.edu`)
- **Print jobs** from the Bambu Lab cloud (what Bambu Studio and Bambu Handy send to the printers)

It draws both on one overlapping waterfall chart, with one row per printer. Prints that ran without a reservation are highlighted.

- **Reservations** are pale blue bands.
- **Print jobs** are solid bars drawn on top of the bands. A print that sits inside its reservation's band is fine.
- **A print with no reservation** is red, with a ✕ badge.
- **A print that ran outside its reservation** has an amber section showing the unreserved part, and a ! badge.
- **A hollow band** is a reservation on a Bambu printer where no print was recorded.

Below the chart, a table lists every flagged print. The full table view lists every print and reservation.

## Quick start

You need Node.js 22 or newer.

```sh
npm install
npm run demo        # generated sample data, no logins needed
```

Open http://127.0.0.1:3000. Demo mode shows each case the app detects: unreserved prints, a print that overran its reservation, an overnight print, a printer that isn't mapped, and a reservation with no print.

To use live data:

```sh
cp .env.example .env   # then fill in the logins
npm start
```

When neither source has credentials in `.env`, the app starts in demo mode. A banner and a "Demo data" badge say so.

## Configuration (`.env`)

| Setting | What it does |
| --- | --- |
| `DESIGNHUB_USERNAME`, `DESIGNHUB_PASSWORD` | A **local (non-SSO)** Studio Manager account that is an **admin** with the **See Agenda** permission. |
| `DESIGNHUB_COOKIE` | For SSO-only accounts. Sign in with a browser, then paste its `rack.session=…` cookie here. The cookie expires after 30 days. |
| `DESIGNHUB_BASE_URL` | Defaults to `https://designhub-manager.unl.edu`. |
| `DESIGNHUB_WORKSHOP_CATEGORY` | Optional. Limits the agenda to one "Reservation Category" (the value from that dropdown). |
| `BAMBU_EMAIL`, `BAMBU_PASSWORD` | The Bambu Lab account the printers are bound to. |
| `BAMBU_ACCESS_TOKEN` | Optional. Use an existing token instead of email and password. |
| `BAMBU_REGION` | `global` (default) or `china`. |
| `PRINTER_MAP` | Needed only when a Bambu printer's name differs from its agenda "Model" name. Format: `Bambu name or serial=Model`, comma-separated. Example: `PRINTER_MAP=X1C-01=Ada,01S00C123456789=Archimedes`. |
| `PRINTER_ORDER` | Row order, comma-separated. Defaults to the list in design-hub-waterfall. |
| `MATCH_GRACE_MINUTES` | How many minutes a print may start before, or run past, a reservation and still count as reserved. Default 15. |
| `TIMEZONE` | The time zone the agenda uses. Default `America/Chicago`. |
| `HOST`, `PORT` | Default `127.0.0.1:3000`, so only this computer can open the page. Use `HOST=0.0.0.0` to share it on the network. |
| `APP_USERNAME`, `APP_PASSWORD` | Optional basic-auth login for the PrintBuster page. Set these before sharing the page on the network, because it shows member names. |
| `CACHE_SECONDS` | How long fetched data is reused before the sites are asked again. Default 60. |

### Bambu sign-in codes

Bambu often emails a verification code when an account signs in from a new place. When it does, PrintBuster shows a box at the top of the page. Type in the code from the email. Accounts with two-factor authentication get the same box for their authenticator code.

The resulting token is saved to `data/bambu-token.json` (git-ignored, readable only by the file's owner). It lasts about 3 months, so restarts don't ask again.

## How it works

### Design Hub

This follows the same approach as [design-hub-waterfall](https://github.com/vinnesttree/design-hub-waterfall). Studio Manager is UNL's open-source [reservations app](https://github.com/unl/reservations), so the login and agenda handling are based on its source:

1. `POST /login/` with `username` and `password`. On success it redirects to `/home/` and sets the `rack.session` cookie.
2. `GET /admin/agenda/?date=YYYY-MM-DD` for the selected day and the day before. The day before is needed so overnight prints can be matched to the previous evening's reservation.
3. The "Today's Reservations" table is parsed (Name, Tool, Model, Time). Times like `Oct 27  9:00 am` are read in `TIMEZONE`. The year is taken from the page date, which handles New Year and DST correctly.

If the session expires, the app logs in again automatically. Studio Manager answers `/admin/*` with *404 Not Found* for accounts that are not admins. When that happens, the app shows a message explaining the account needs admin access.

### Bambu cloud

Bambu has no official public API. This uses the endpoints that Bambu's own apps use, as documented by the community ([OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md), [ha-bambulab](https://github.com/greghesp/ha-bambulab)):

- `POST /v1/user-service/user/login` to sign in (email code: `/user/sendemail/code`)
- `GET /v1/iot-service/api/user/bind` for the printers on the account
- `GET /v1/user-service/my/tasks` for print history, newest first, paged back to 48 hours before the selected day

Task status `2` means finished and `3` means failed or cancelled. While a job is printing, the cloud reports its end time as equal to its start time. In that case the slicer's time estimate gives the expected finish, and the chart shows that part faded.

### Matching rules

Each print is compared with the reservations on the same printer. A Bambu printer is matched to an agenda "Model" in this order:

1. A `PRINTER_MAP` entry.
2. An identical name.
3. A name that contains exactly one known model, e.g. `X1C - Ada` matches `Ada`.

Each print then gets one of these results:

| Result | Rule |
| --- | --- |
| No reservation | The print overlaps no reservation on its printer, or its printer can't be matched to any agenda model. |
| Outside reservation | The print overlaps a reservation but spends more than a minute outside every reservation plus the grace period. Back-to-back reservations count as one block. |
| Within reservation | The print is fully covered by reservations plus the grace period. |

## Limitations

- **Only cloud prints are visible.** Prints sent over LAN-only mode or started from an SD card never reach the Bambu cloud. A reservation used that way shows as "no print recorded", not as a violation.
- **Untested against the live sites.** Neither site could be reached from the environment this was built in. The Design Hub side is based on the Studio Manager source and the userscript's parsing. The Bambu side is based on the community documentation above. The automated tests run both clients against simulations of that behavior.
- **The Bambu API may change.** Because it is unofficial, Bambu can change it at any time. If Bambu's Cloudflare protection blocks the login, the app explains how to use `BAMBU_ACCESS_TOKEN` instead.
- **Very long prints can be missed.** Prints that started more than 48 hours before the selected day are not fetched.

## Development

```sh
npm test
```

The tests cover the agenda parser, the Design Hub login and session handling, every Bambu sign-in path, task paging, the matching rules, and the HTTP API. Both upstream sites are replaced by a mock in `test/helpers/mock-upstream.js`, so the tests need no network access.

Project layout:

```
src/server.js      Express app and API (/api/compare, /api/config, /api/bambu/*)
src/designhub.js   Studio Manager login + agenda parser
src/bambu.js       Bambu cloud client + task normalization
src/compare.js     Printer mapping and reservation matching
src/service.js     Fetches both sources in parallel, caches, builds the comparison
src/demo.js        Demo data in the real upstream formats
public/            The page (no build step)
```
