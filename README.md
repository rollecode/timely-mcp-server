<center align="center" style="text-align: center;justify-content:center;">
<div align="center" style="text-align: center;justify-content:center;">
<h1 align="center" style="text-align: center;justify-content:center;">

Timely MCP server

<img style="justify-content:center;text-align: center;width: 95px; height: auto;" width="793" height="411" alt="image" src="https://github.com/user-attachments/assets/abed1a04-d69b-4ab4-a490-d606064df72d" />
<img style="justify-content:center;text-align: center;width: 190px; height: auto;" alt="image" src="https://github.com/user-attachments/assets/14a10692-00e0-420a-bcf7-0485f3c7239d" />
</h1>

![Version](https://img.shields.io/badge/version-2.1.0-7c5cfc.svg?style=for-the-badge) ![Bun](https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white) ![Node](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white) ![OAuth](https://img.shields.io/badge/OAuth_2.1-EB5424?style=for-the-badge&logo=auth0&logoColor=white)

</div>
</center>

<hr>

Read and write your [Timely](https://www.timely.com) time tracking from Claude.ai and Claude Code. Covers the whole account: hours, projects, clients, users, labels, teams, planned work and reports. An OAuth 2.1 login sits in front so it can be added to Claude.ai as a custom connector, and Claude Code can use a plain token instead.

<hr>

## Tools

### Reading

| Tool | What you get |
| --- | --- |
| `timely_me` | Reachable accounts, and which one the server acts on |
| `timely_account` | Account settings: currency, week start, capacity, default rate |
| `timely_list_users` / `timely_get_user` | People, with rates, capacity and role |
| `timely_user_capacities` | A person's contracted hours, and when each applied |
| `timely_list_teams` | Teams and their members |
| `timely_list_roles` | Roles and what each may do |
| `timely_list_clients` / `timely_get_client` | Clients, active and archived |
| `timely_list_projects` / `timely_get_project` | Projects with budget and rate |
| `timely_project_rates` | What a project charges against what its people cost |
| `timely_list_labels` / `timely_get_label` | Labels and their nesting |
| `timely_list_events` / `timely_get_event` | Logged time, by day, person, project, label or billing state |
| `timely_user_events` | One person's entries over a period |
| `timely_list_forecasts` / `timely_get_forecast` | Planned work |
| `timely_report` | Totals for a period, grouped and filtered |
| `timely_unrated_work` | Projects billing hours at no rate |
| `timely_list_reports` | Saved reports |
| `timely_activities` | Recent account activity |
| `timely_list_webhooks` | Registered webhooks |

### Writing

| Tool | What it does |
| --- | --- |
| `timely_create_event` | Log time to a project |
| `timely_update_event` | Change hours, note, labels or day |
| `timely_delete_event` | Delete a time entry |
| `timely_set_events_billable` | Flip billable across a whole project or period at once |
| `timely_create_client` / `timely_update_client` | Add or change a client |
| `timely_create_project` / `timely_update_project` / `timely_delete_project` | Add, change or remove a project |
| `timely_update_user` | Set a person's charge-out and internal rates |
| `timely_create_label` / `timely_update_label` / `timely_delete_label` | Manage labels |
| `timely_create_forecast` / `timely_update_forecast` / `timely_delete_forecast` | Manage planned work |
| `timely_create_webhook` / `timely_delete_webhook` | Manage webhooks |

Every update is a patch: only what you pass changes, so a rename never blanks the other fields.

Writes are checked against what Timely returns. Timely answers `200` for a field it silently drops, so a rate that did not land now raises an error instead of reporting a success that never happened.

### Rates and billing

A project charges in one of three ways, set with `rate_type`: `project` bills every hour at the project rate, `user` bills each person at their own rate, and `non-billable` bills nothing. Timely refuses to create a project without one.

`timely_project_rates` puts the charge-out rate next to what each person costs, which is the difference the reports call profit:

```json
{"user_id": 20991, "charged": 105, "costs": 87.17, "margin_per_hour": 17.83}
```

If profit looks wrong everywhere, check `timely_get_user`: when `default_hour_rate` equals `internal_hour_rate` every hour breaks even by construction. `timely_update_user` sets them apart.

`timely_unrated_work` lists projects that logged billable hours and earned nothing, with the reason for each. `timely_set_events_billable` fixes entries in bulk; Timely has no bulk endpoint, so it updates each entry in turn and leaves invoiced or locked ones alone. Preview with `dry_run: true`.

### Budgets

`budget_type` takes `hours` or `fees`. Timely's own API wants the letters `H` and `M` and rejects the words its docs use, so the tools take the word and send the letter.

### Reports

`timely_report` returns totals grouped by client, user, label, team and day. It summarises by default, because a month across an account is hundreds of kilobytes of repeated duration and cost objects, which is rarely what a summary needs:

```json
{"since": "2026-08-01", "upto": "2026-08-31"}
```

Each row carries hours split by billable and invoiced state, revenue, internal cost and profit, so what was earned and what it cost sit side by side. Pass `detail: true` for every underlying entry.

### Filtering time entries

Timely's own `/events` endpoint accepts `project_ids`, `user_ids`, `label_ids` and `billable` and then ignores them, answering `200` with the entire account. `timely_list_events` reads through the routes that do filter and applies the rest itself, so asking for one person's hours returns one person's hours. Note it takes `per_page`, not `limit`, which Timely ignores here.

## How it fits together

```
Claude.ai / Claude Code
        |  HTTPS
   Cloudflare Tunnel, or any proxy that gives you HTTPS
        |
   nginx  127.0.0.1:8451
        |
   auth-server.cjs  :8452    handles the login and the tokens
        |
   timely-mcp  :8450         the server itself, local only
        |
   api.timelyapp.com
```

The MCP has no login of its own and refuses to listen on anything but the local machine, so everything reaching it has already passed the login. That login takes either an OAuth token, which is what Claude.ai negotiates, or a fixed token, which is quicker for Claude Code.

## Setup

Create an OAuth app at `https://app.timelyapp.com/<account_id>/oauth_applications` with redirect URI `http://localhost:3000/callback`, then:

```bash
git clone https://github.com/rollecode/timely-mcp-server.git
cd timely-mcp-server
bun install && npm install --omit=dev

cp .env.example .env      # add TIMELY_CLIENT_ID and TIMELY_CLIENT_SECRET
bun auth.ts               # opens the browser, writes .tokens.json
```

For the remote setup, move the tokens somewhere the service can write and set a password:

```bash
mkdir -p ~/.config/timely-mcp && chmod 700 ~/.config/timely-mcp
cp .tokens.json ~/.config/timely-mcp/tokens.json
chmod 600 ~/.config/timely-mcp/tokens.json

CONFIG_DIR=~/.config/timely-mcp node set-password.cjs 'your-password-here'
openssl rand -hex 32 > ~/.config/timely-mcp/token
chmod 600 ~/.config/timely-mcp/token
```

Fill in `YOUR_USER` and the hostname in `systemd/*.service` and `nginx/timely-mcp.conf`, then:

```bash
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now timely-mcp timely-mcp-auth

sudo cp nginx/timely-mcp.conf /etc/nginx/sites-enabled/timely-mcp
sudo nginx -t && sudo systemctl reload nginx
```

Point a tunnel or an HTTPS proxy at `127.0.0.1:8451`. OAuth needs HTTPS.

Check from outside: discovery returns metadata, and `/mcp` without a token must return `401`.

```bash
curl https://your-host/.well-known/oauth-authorization-server
curl -o /dev/null -w '%{http_code}\n' -X POST https://your-host/mcp
```

## Connecting

Claude.ai: Settings, Connectors, Add custom connector, `https://your-host/mcp`, client ID and secret blank.

Claude Code:

```bash
claude mcp add --transport http timely https://your-host/mcp \
  --header "Authorization: Bearer $(cat ~/.config/timely-mcp/token)" --scope user
```

Without a server, Claude Code can run it directly over stdio:

```bash
claude mcp add timely -- bun /path/to/timely-mcp-server/server.ts
```

## Settings

| Variable | What it is for |
| --- | --- |
| `TIMELY_CLIENT_ID` | OAuth app client id |
| `TIMELY_CLIENT_SECRET` | OAuth app client secret |
| `TIMELY_ACCOUNT_ID` | Timely account the tools act on |
| `TIMELY_TOKENS_PATH` | Where the refresh token lives |
| `MCP_PUBLIC_URL` | Public address, used to advertise the icon |
| `ISSUER` | Public origin of the login server |
| `PORT` | Login server port, 8452 by default |
| `UPSTREAM` | MCP server URL, `http://127.0.0.1:8450` by default |
| `CONFIG_DIR` | Where the password, token and OAuth database live |

The Timely access token refreshes itself when it expires; the refresh token is written back to `TIMELY_TOKENS_PATH`.

## Credits

The login layer comes from [rollecode/obsidian-remote-mcp](https://github.com/rollecode/obsidian-remote-mcp). Timely and its logo belong to [Memory AS](https://www.timely.com).
