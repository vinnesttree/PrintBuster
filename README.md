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
- **A grams tag** follows every print except cancelled or failed ones: the slicer's estimate of the filament it used. Bambu's estimate covers the whole job, which overstates what a cancelled print used, so the waterfall shows no amount for those, and they're never flagged as over the weight limit. The usage page still charges them pro rata. It sits after the bar, or inside it when the next print is too close, and is left off only when neither fits (the tooltip always has it). Prints longer than `FLAG_DURATION_HOURS` add the duration, e.g. `52 g · 12 h+`.
- **A bold, inverted tag with ▲** marks a print over `FLAG_WEIGHT_GRAMS` (default 200 g).
- **A striped blue, green and violet band** under a print marks multi-colour or multi-material prints. These colours never mean a print's status, which uses red and yellow.

Below the chart, a table lists every flagged print. The full table view lists every print and reservation.

The **Filament usage** page (`/usage.html`) totals the filament each member used in their reservations over a date range (last 30 days by default, up to 366 days). Search by name and sort by name, print count or filament used. Expand a member to see each of their reservations with every print charged to it, and whether each print counted. Next to the range figures, an **All time** column and tile show each member's total over all saved data. Below, the **All-time totals** table lists every member with saved usage, including those with no reservation in the selected range, with their prints, filament used, materials, prints not counted and last print. The name search and event checkbox apply to it too, and it sorts by name, prints, filament used or last print. **Recalculate** re-reads the selected range's reservations from Design Hub, recalculates and saves the result. **Recalculate total** recalculates every saved print from saved data only. See [Filament usage rules](#filament-usage-rules) and [Saved reservations and usage](#saved-reservations-and-usage).

The **Admin** page (`/admin.html`) holds admin tasks. For now that is **Import reservations**, which reads every day in a date range from Design Hub and saves its reservations. See [Importing reservations](#importing-reservations). The page will later also manage logins. Until then it is protected only by `APP_PASSWORD`, like the other pages.

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

## Running in Docker

You need Docker with the Compose plugin. Node.js isn't needed on the host.

```sh
cp .env.example .env   # fill in the logins, or skip this step for demo data
docker compose up -d --build
```

Open http://127.0.0.1:3000.

- **Logs:** `docker compose logs -f`
- **Stop:** `docker compose down`
- **Update after changing the code:** `docker compose up -d --build`

The container starts again whenever Docker starts (for example after a reboot), unless you stopped it yourself.

How the container uses `.env`:

- **Publishing address.** `HOST` and `PORT` in `.env` choose where the page is published on the host. The default `127.0.0.1:3000` means only that computer can open it. To share it on the network, set `HOST=0.0.0.0` and also set `APP_PASSWORD`. Inside the container the app always listens on `0.0.0.0:3000`.
- **Saved data.** The `printbuster-data` volume keeps the Bambu sign-in token, so restarts and rebuilds don't ask for a new email code. It also keeps the [print log](#print-log), the [saved reservations and usage](#saved-reservations-and-usage) and the prints staff assigned to members. `docker compose down -v` deletes the volume and everything in it.
- **Copying the saved data out.** `docker compose cp printbuster:/app/data/print-log.jsonl .` (likewise `reservations.json`, `usage.json` and `assignments.json`).
- **Health.** The container reports healthy or unhealthy in `docker ps`, using an unauthenticated `/healthz` endpoint that returns only `{"ok":true}`.
- **Uptime monitoring.** `/healthz/designhub` and `/healthz/bambu` answer 200 while PrintBuster can read that source and 503 when it can't, and PrintBuster can also push each source's state to Uptime Kuma. See [Monitoring with Uptime Kuma](docs/uptime-kuma.md).
- **Quoting.** Wrap passwords in single quotes in `.env`, e.g. `BAMBU_PASSWORD='p@ss$word#1'`. Compose treats an unquoted or double-quoted `$` as the start of a variable name, and `npm start` treats an unquoted `#` as the start of a comment. Single quotes keep the value exactly as typed in both.

Without Compose:

```sh
docker build -t printbuster .
docker run -d --name printbuster --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v "$PWD/.env:/app/.env:ro" \
  -v printbuster-data:/app/data \
  printbuster
```

Mount `.env` as shown rather than passing it with `--env-file`. `--env-file` keeps quote marks as part of the value, and its `HOST=127.0.0.1` would make the page unreachable from outside the container. Leave out the `.env` line to run with demo data. If `.env` doesn't exist when you mount it, Docker creates an empty folder with that name. The app then stops with a message telling you to delete the folder.

## Configuration (`.env`)

| Setting | What it does |
| --- | --- |
| `DESIGNHUB_USERNAME`, `DESIGNHUB_PASSWORD` | A **local (non-SSO)** Studio Manager account that is an **admin** with the **See Agenda** permission. |
| `DESIGNHUB_COOKIE` | For accounts that can only sign in through UNL SSO. The session cookie from a signed-in browser. See [Finding the Design Hub session cookie](#finding-the-design-hub-session-cookie). |
| `DESIGNHUB_BASE_URL` | Defaults to `https://designhub-manager.unl.edu`. |
| `DESIGNHUB_WORKSHOP_CATEGORY` | Optional. Limits the agenda to one "Reservation Category" (the value from that dropdown). |
| `BAMBU_EMAIL`, `BAMBU_PASSWORD` | The Bambu Lab account the printers are bound to. |
| `BAMBU_ACCESS_TOKEN` | Optional. Use a token instead of email and password. See [Finding a Bambu access token](#finding-a-bambu-access-token). |
| `BAMBU_REGION` | `global` (default) or `china`. |
| `PRINTER_MAP` | Needed only when a Bambu printer's name differs from its agenda "Model" name. Format: `Bambu name or serial=Model`, comma-separated. Example: `PRINTER_MAP=X1C-01=Ada,01S00C123456789=Archimedes`. |
| `PRINTER_ORDER` | Row order, comma-separated. Defaults to the list in design-hub-waterfall. |
| `MATCH_GRACE_MINUTES` | How many minutes a print may start before, or run past, a reservation and still count as reserved. Default 15. |
| `FLAG_WEIGHT_GRAMS` | Flag a print that uses more than this much filament. Default 200. `0` turns it off. |
| `FLAG_DURATION_HOURS` | Flag a print that runs longer than this. Default 12. `0` turns it off. |
| `TIMEZONE` | The time zone the agenda uses. Default `America/Chicago`. |
| `HOST`, `PORT` | Default `127.0.0.1:3000`, so only this computer can open the page. Use `HOST=0.0.0.0` to share it on the network. With Docker Compose, these choose where the container is published. |
| `APP_USERNAME`, `APP_PASSWORD` | Optional basic-auth login for the PrintBuster page. Set these before sharing the page on the network, because it shows member names. |
| `POLL_ACTIVE_MINUTES`, `POLL_IDLE_MINUTES` | How often the server [collects data](#data-collection) from Design Hub and Bambu: every `POLL_ACTIVE_MINUTES` (default 2) while anyone has a page open, every `POLL_IDLE_MINUTES` (default 15) while nobody does. Decimals are allowed. `0` turns that schedule off. `BAMBU_POLL_MINUTES` still works as the older name for `POLL_IDLE_MINUTES`. |
| `CACHE_SECONDS` | How long demo mode reuses its generated prints. Default 60. Live data is never re-read on page loads (see [data collection](#data-collection)). |
| `PRINT_LOG_PATH` | Where the print log is kept. Default `data/print-log.jsonl`. |
| `RESERVATION_LOG_PATH` | Where the saved reservations are kept. Default `data/reservations.json`. |
| `USAGE_LOG_PATH` | Where the calculated usage is kept. Default `data/usage.json`. |
| `ASSIGNMENT_LOG_PATH` | Where prints staff assigned to a member are kept. Default `data/assignments.json`. |
| `UPTIME_KUMA_PUSH_DESIGNHUB`, `UPTIME_KUMA_PUSH_BAMBU` | Optional. Uptime Kuma push URLs. After every collection PrintBuster reports to each whether it could read that source. See [Monitoring with Uptime Kuma](docs/uptime-kuma.md). |

### Bambu sign-in codes

Bambu often emails a verification code when an account signs in from a new place. When it does, PrintBuster shows a box at the top of the page. Type in the code from the email. Accounts with two-factor authentication get the same box for their authenticator code.

The resulting token is saved to `data/bambu-token.json` (git-ignored, readable only by the file's owner). It lasts about 3 months, so restarts don't ask again.

### Print log

Bambu's cloud only keeps about a day of print history, so PrintBuster saves every print it sees to `data/print-log.jsonl`. The server's [data collection](#data-collection) checks Bambu every 15 minutes even when nobody has a page open, and every 2 minutes while someone does. That lets you go back to any day since the log started and still compare it against the agenda.

- **What's in it.** One line of JSON per print, written when PrintBuster first sees the print and again whenever it changes (for example when it finishes). The last line for an `id` is the current one. Each line has the print's start and end times (UTC), the Bambu status, the printer, the job title and when it was recorded:

  ```json
  {"id":"123456","startTime":"2026-10-27T14:10:00Z","endTime":"2026-10-27T15:40:00Z","status":2,"deviceId":"01P00A350100003","deviceName":"Faraday","title":"Bracket batch","costTime":5400,"recordedAt":"2026-10-27T15:45:02.000Z"}
  ```

- **Gaps.** Next to it, `print-log.coverage.json` lists the time spans PrintBuster actually observed. If PrintBuster was off for longer than Bambu keeps history, some prints are never seen. The page then says which hours of the day have no data. It also won't mark reservations in those hours as "no print recorded", and before the log started it shows "—" instead of zero counts.
- **Unknown finishes.** If a print was still running the last time PrintBuster saw it, and Bambu forgot it before it finished, it shows as "Finish not recorded" and is drawn to its estimated end.
- **Size.** About one or two lines per print, so a busy year is a few megabytes.

### Finding the Design Hub session cookie

You only need this if your Design Hub account signs in through UNL SSO. PrintBuster can't complete the SSO login (and its two-factor check) by itself. Instead, it reuses the session of a browser where you are already signed in. Studio Manager keeps that session in a cookie named `rack.session`.

1. On a computer, sign in to https://designhub-manager.unl.edu and open the admin **Agenda** page (`/admin/agenda/`). If the agenda loads, the session has the access PrintBuster needs.
2. Open the developer tools: press **F12**, or **Ctrl+Shift+I** (**Cmd+Option+I** on a Mac).
3. Find the site's cookies:
   - **Chrome or Edge:** **Application** tab → **Storage** → **Cookies** → `https://designhub-manager.unl.edu`
   - **Firefox:** **Storage** tab → **Cookies** → `https://designhub-manager.unl.edu`
   - **Safari:** first turn on **Settings → Advanced → Show features for web developers**. Then use **Develop → Show Web Inspector** → **Storage** tab → **Cookies**.
4. Click the row named **`rack.session`** and copy its **Value**. It is long, and usually contains `%3D` and `--`. The cookie is HttpOnly, so typing `document.cookie` in the console will not show it.
5. Put it in `.env` inside single quotes, and leave `DESIGNHUB_USERNAME` and `DESIGNHUB_PASSWORD` empty:

   ```sh
   DESIGNHUB_COOKIE='rack.session=PASTE_THE_VALUE_HERE'
   ```

6. Restart PrintBuster: `npm start`, or `docker compose up -d` with Docker.

If the cookie list is hard to find, or shows more than one `rack.session` (other UNL sites can set one too), use the **Network** tab instead. Reload the agenda page, click the first request (`agenda/`), find **Request Headers → Cookie**, and copy that whole value into `DESIGNHUB_COOKIE`. PrintBuster picks out `rack.session` itself. It also accepts the bare value without `rack.session=`, and a value copied with Chrome's "Show URL-decoded" option turned on.

Things to know:

- **Treat the cookie like a password.** It gives the same admin access as your login. Signing out in the browser does not cancel a copy, because Studio Manager stores the whole session inside the cookie rather than on its server.
- **Copy a fresh one when it stops working.** Browsers keep the cookie for 30 days after its last use. While PrintBuster runs, it keeps the session refreshed, but after a restart it starts again from the value in `.env`. When the page says "The Design Hub session cookie is no longer valid", repeat the steps above.

### Finding a Bambu access token

You only need this if signing in with `BAMBU_EMAIL` and `BAMBU_PASSWORD` fails, for example when the page says Bambu's Cloudflare protection blocked the request. It also works if you'd rather not store the Bambu password.

1. Sign in at https://makerworld.com with the Bambu account the printers are bound to.
2. Open the developer tools (as above) and go to the cookies for `https://makerworld.com`.
3. Copy the **Value** of the cookie named **`token`**.
4. Put it in `.env` and restart:

   ```sh
   BAMBU_ACCESS_TOKEN='PASTE_THE_TOKEN_HERE'
   ```

Bambu's sign-in tokens usually last about 3 months. When the page says "Bambu rejected BAMBU_ACCESS_TOKEN", copy a new one. This token also gives full access to the Bambu account, so keep it private.

## How it works

### Data collection

The server, not the browser, fetches data from Design Hub and Bambu, on its own schedule:

- **Every 2 minutes while anyone has a page open** (`POLL_ACTIVE_MINUTES`), whether that's the waterfall or the usage page, in any number of browsers.
- **Every 15 minutes while nobody does** (`POLL_IDLE_MINUTES`), so the print log and saved reservations keep filling with no one watching.

Each collection reads Bambu's printers and recent prints into the print log. It reads yesterday's (until it's final), today's and tomorrow's agenda into the saved reservations. It also saves a few finished days that are still missing, back to the day before the print log began.

**Pages only ever read saved data:** the print log, the saved reservations and usage, and what the last collection found. Loading or reloading a page, changing the date or range, and the live updates never make a request to Design Hub or Bambu, so ten viewers cause no more requests than one. Only these do:

- the server's schedule;
- **Refresh**;
- **Recalculate** on the usage page, which re-reads its range;
- **Import reservations** on the Admin page, which reads its range;
- signing in to Bambu with an emailed code.

How it fits together:

- **How the server knows a page is open.** While a page is visible, it holds a connection to `/api/events`. A page in a background tab or a minimized window lets go of it, and so stops counting as open.
- **How pages learn about new data.** After each collection the server sends an update over that connection, and every open page redraws. The waterfall's **Live updates** box turns this off for that page.
- **When the first page opens.** The server switches to the 2-minute schedule. If its last collection was more than 2 minutes ago, the next one is already due and runs at once.
- **Refresh.** It starts a collection, unless one ran in the last 15 seconds, and reads any day on screen that isn't saved.
- **The status line.** "Checked 7:58 PM" shows when the server last collected. Hover over it for the schedule and how many pages are open.
- **Days that aren't saved.** A future date beyond tomorrow, or a past day from before the print log, shows "Reservations for this day aren't saved yet" until someone presses Refresh. The usage page lists any unsaved days in its range and leaves their prints out, rather than counting them as unreserved.
- **Saved days outside the collection.** A future day saved earlier by Refresh shows "Reservations as saved …" with the time it was read.
- **Errors.** If a collection fails, the pages show the error, and the server logs it once rather than on every run.
- **Monitoring.** Each collection's result for Design Hub and Bambu is also available to uptime monitors. See [Monitoring with Uptime Kuma](docs/uptime-kuma.md).

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

Every successful fetch is also saved to the [print log](#print-log), and the page draws prints from that log.

Task status `2` means finished and `3` means failed or cancelled. While a job is printing, the cloud reports its end time as equal to its start time. In that case the slicer's time estimate gives the expected finish, and the chart shows that part faded.

**Material usage.** Each print carries its filament weight, length, and a per-filament breakdown (type and colour), shown with colour swatches in the hover tooltip and the table view. These are the slicer's estimates, not measured usage, so an aborted or failed print still shows its full estimate. Prints over `FLAG_WEIGHT_GRAMS` (default 200 g) or `FLAG_DURATION_HOURS` (default 12 h) are flagged, with a badge on the chart and a warning in the tooltip and table. Prints that use more than one filament are labelled **multi-colour** (two or more filaments) and, when the filament types differ, **multi-material** (e.g. PLA + PETG).

### Matching rules

Each print is compared with the reservations on the same printer. A Bambu printer is matched to an agenda "Model" in this order:

1. A `PRINTER_MAP` entry.
2. An identical name.
3. A name that contains exactly one known model, e.g. `X1C - Ada` matches `Ada`.

Each print then gets one of these results:

| Result | Rule |
| --- | --- |
| No reservation | The print isn't *in a reservation* on its printer (below), or less than 10% of it was inside reservations (grace period included), or its printer can't be matched to any agenda model. A print that started outside every reservation and only ran into someone's booking near its end is **No reservation**, not a run-over. |
| Outside reservation | The print is in a reservation but spent more than a minute outside every reservation plus the grace period: it started early or ran late. Back-to-back reservations count as one block. |
| Within reservation | The print is in a reservation and is fully covered by reservations plus the grace period. |

A print is **in a reservation** if either of these holds:

- **It started in one:** between the grace period before the reservation (default 15 minutes) and the reservation's end. Starting after a reservation ended, even within the grace period after it, isn't starting in it. A minute of tolerance applies.
- **The middle of the print falls inside one:** halfway between its start and end, inside the reservation itself, not its grace period. So a print started early still counts when most of it ran in the booking; it shows as "Outside reservation" for the early part. Exactly 10% inside still counts as having a reservation. The tooltip and the flagged-prints table say which rule made a print "No reservation".

### Filament usage rules

The usage page charges prints to reservation holders:

- **A print that starts in the first half of a reservation**, or in the grace period (default 15 minutes) before it, is charged to that reservation, even if it then overlaps a later reservation more. The reservation's own midpoint counts as its first half.
- Any other print is charged to the reservation its middle falls in, else to the one on its printer that it overlaps most.
- **A print more than half outside the member's reservation isn't counted.** "Outside" means outside that member's own reservations on that printer, each widened by the grace period, so back-to-back bookings by the same person count as one block. This rule wins over the first one: a print started in Amy's slot that mostly runs in Ben's is Amy's, and isn't counted. It is listed under the member as "Not counted", and nobody else is charged. Exactly half outside still counts.
- **Every print in a reservation is tracked against it.** Expanding a member lists each reservation with its prints, grams and not-counted prints, including reservations with no prints.
- **A cancelled or failed print** counts in proportion to how long it ran, interpolated linearly: grams = estimated grams × (time printed ÷ estimated print time), capped at the full estimate. Each filament in the breakdown is scaled the same way. For example, a 120 g print cancelled 45 minutes into a 3-hour estimate counts 30 g. The share is added to the member's filament for that reservation, in the range and the all-time totals, like any other counted print (so a cancelled print more than half outside the member's reservation isn't counted either). The time printed runs from Bambu's start time to its end time, to the second, using Bambu's unrounded estimate. A print cancelled within a minute is still drawn a minute long but charged only for the seconds it ran. Time spent paused counts as printing, because Bambu doesn't report pauses. If Bambu gave no time estimate, or recorded no end time for the cancelled print, the full weight counts.
- **A print still running** counts the share of its estimated time that has elapsed.
- A print belongs to the date range its start time falls in, so adjacent ranges never count it twice.
- Prints the waterfall marks **No reservation** aren't charged to anyone. That includes prints that started outside every reservation and then ran into one, and prints less than 10% inside reservations. They're listed under "Prints with no reservation", with the reason.
- **Staff can assign a print with no reservation to a member.** In "Prints with no reservation", type the member's name under **Charge to** (the box suggests names already on the page) and press **Assign**. The print then counts toward that member's filament, prints and materials, in the selected range and in the all-time totals, under the same proration rules as any other print. It's listed under the member as "Assigned prints with no reservation", and a member with no reservation of their own gets a row too. **Remove** undoes it. Use the name exactly as Design Hub shows it, so it adds up with their reserved prints. A reservation always wins: if a later recalculation finds one for the print, it's charged to that reservation and the assignment is ignored. Assignments are saved in `data/assignments.json`.

The weights are the slicer's estimates. Prints come from the print log, so usage is only known for times the log covers. Gaps are shown as a warning.

### Saved reservations and usage

All three files are in `data/`, on the Docker volume, and readable only by the file's owner because they contain member names.

- **`reservations.json`** holds every Design Hub agenda day PrintBuster has read, with all of that day's reservations. A day read after it ended is final: the usage page uses the saved copy instead of asking Design Hub again, so past usage still works if Design Hub is down or a reservation later disappears from it. The server's [data collection](#data-collection) also saves each finished day since the print log started, a few days per run, even if nobody opens a page. If Design Hub can't be reached for a day that isn't final yet, an earlier saved copy is used and the page says so.
- **`usage.json`** holds the latest calculated usage of every print: who it was charged to, which reservation (or which member staff assigned it to), grams used, whether it counted and why.
- **`assignments.json`** holds the prints with no reservation that staff assigned to a member: the print id, the member's name and when it was assigned. Assigning or removing updates `usage.json` at once, so the all-time totals change without a recalculation. It is updated whenever usage is calculated; an entry's `calculatedAt` changes only when its result does. The **All time** figures are summed from it.

The buttons:

- **Refresh** asks the server to collect now (yesterday and today, and recent prints).
- **Recalculate** works on the selected range. It re-reads every day in the range from Design Hub, including saved final days, so corrections made in Design Hub afterwards are picked up. It then recalculates and saves both files. A 90-day range means about 90 agenda requests, and a year about 366, which can take several minutes. For a long range, the Admin page's [import](#importing-reservations) does the same reading in the background.
- **Recalculate total** recalculates every print in the print log against the saved reservations, with no Design Hub or Bambu requests, and saves the results to `usage.json`. Prints that started on a day with no saved reservations are left as they were, and the count of those is recorded. Use it after the rules change, or to bring all-time totals up to date for prints that no range view has covered yet.

`usage.json` records when each kind of recalculation last ran and for which dates. In demo mode all three are kept in memory only.

### Importing reservations

The server's collection saves finished days a few at a time, and only back to the day before the print log began, up to 92 days ago. To fill in more than that at once, or to pick up corrections made in Design Hub across many days, use **Import reservations** on the Admin page:

1. Pick **From** and **To** (at most 366 days). The default is the 30 days up to yesterday.
2. **Skip days already saved as final** (ticked by default) reads only days that aren't saved yet or were saved before they ended. Untick it to read every day again, as Recalculate does, so corrections in Design Hub replace the saved copy.
3. **Recalculate all-time usage afterwards** (ticked by default) runs **Recalculate total** once the import ends, so the all-time totals include the imported days.
4. Press **Import**.

Each day is one agenda request, read two at a time. The import runs on the server, so it keeps going if you close the page. Open the page again to see its progress. **Stop** ends it after the days being read. Only one import runs at a time. If Design Hub fails 5 days in a row, the import stops by itself. Days that failed are listed with the reason, and you can import them again later. Days read after they ended are saved as final, like any other saved day, and days still to come are saved as not final.

## Limitations

- **Only cloud prints are visible.** Prints sent over LAN-only mode or started from an SD card never reach the Bambu cloud. A reservation used that way shows as "no print recorded", not as a violation.
- **Untested against the live sites.** Neither site could be reached from the environment this was built in. The Design Hub side is based on the Studio Manager source and the userscript's parsing. The Bambu side is based on the community documentation above. The automated tests run both clients against simulations of that behavior.
- **The Bambu API may change.** Because it is unofficial, Bambu can change it at any time. If Bambu's Cloudflare protection blocks the login, the app explains how to use `BAMBU_ACCESS_TOKEN` instead.
- **Very long prints can be missed.** Prints that started more than 48 hours before the selected day are not fetched.

## Development

```sh
npm test
```

The tests cover the agenda parser, the Design Hub login and session handling, every Bambu sign-in path, task paging, the matching rules, the filament usage rules, and the HTTP API. Both upstream sites are replaced by a mock in `test/helpers/mock-upstream.js`, so the tests need no network access.

Project layout:

```
src/server.js      Express app and API (/api/compare, /api/usage, /api/usage/recalculate[-total], /api/usage/assign, /api/admin/import[/stop], /api/events, /api/config, /api/bambu/*, /healthz/*)
src/designhub.js   Studio Manager login + agenda parser
src/bambu.js       Bambu cloud client + task normalization
src/compare.js     Printer mapping and reservation matching
src/usage.js       Filament usage per reservation holder (attribution rules)
src/collector.js   Server-side collection schedule: 2 min with a page open, 15 min otherwise
src/uptime.js      Source health for uptime monitors (/healthz/designhub, /healthz/bambu) and Uptime Kuma pushes
src/service.js     Collects from both sources, caches, builds the comparison and usage
src/printlog.js    The saved Bambu print history (data/print-log.jsonl) and its coverage
src/reservations.js Saved agenda days (data/reservations.json)
src/usagelog.js    Saved per-print usage results (data/usage.json)
src/assignments.js Prints with no reservation that staff assigned to a member (data/assignments.json)
src/importer.js    The admin page's bulk reservation import, run in the background
src/files.js       Atomic, owner-only JSON file saving
src/demo.js        Demo data in the real upstream formats
public/            The pages: waterfall (index.html), filament usage (usage.html) and admin (admin.html), plus live.js for live updates; no build step
Dockerfile         Container image (Node 22 Alpine, runs as the non-root node user)
compose.yaml       Docker Compose service with the data volume and healthcheck
docs/              Setup guides: monitoring with Uptime Kuma (uptime-kuma.md)
```
