<center align="center" style="text-align: center;justify-content:center;">
<div align="center" style="text-align: center;justify-content:center;">
<h1 align="center" style="text-align: center;justify-content:center;">

Timely MCP server

<img style="justify-content:center;text-align: center;width: 95px; height: auto;" width="793" height="411" alt="image" src="https://github.com/user-attachments/assets/abed1a04-d69b-4ab4-a490-d606064df72d" />
<img style="justify-content:center;text-align: center;width: 190px; height: auto;" alt="image" src="https://timely.com/cdn/timely_logo.svg" />

</h1>

![Version](https://img.shields.io/badge/version-2.0.0-7c5cfc.svg?style=for-the-badge) ![Bun](https://img.shields.io/badge/Bun-000000?style=for-the-badge&logo=bun&logoColor=white) ![Node](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white) ![OAuth](https://img.shields.io/badge/OAuth_2.1-EB5424?style=for-the-badge&logo=auth0&logoColor=white)

</div>
</center>

<hr>

Read and write your [Timely](https://www.timely.com) time tracking from Claude.ai and Claude Code. Covers the whole account: hours, projects, clients, users, labels, teams, planned work and reports. An OAuth 2.1 login sits in front so it can be added to Claude.ai as a custom connector, and Claude Code can use a plain token instead.

<hr>

## Tools

### Reading

| Tool | What you get |
| --- | --- |
| `timely_me` | The signed-in user and reachable accounts |
| `timely_account` | Account settings: currency, week start, capacity |
| `timely_list_users` / `timely_get_user` | People, with rates, capacity and role |
| `timely_list_teams` | Teams and their members |
| `timely_list_roles` | Roles and what each may do |
| `timely_list_clients` / `timely_get_client` | Clients, active and archived |
| `timely_list_projects` / `timely_get_project` | Projects with budget and rate |
| `timely_list_labels` / `timely_get_label` | Labels and their nesting |
| `timely_list_events` / `timely_get_event` | Logged time, filtered by day, user or project |
| `timely_user_events` | One person's entries over a period |
| `timely_list_forecasts` / `timely_get_forecast` | Planned work |
| `timely_report` | Totals for a period, grouped and filtered |
| `timely_list_reports` | Saved reports |
| `timely_activities` | Recent account activity |
| `timely_list_webhooks` | Registered webhooks |

### Writing

| Tool | What it does |
| --- | --- |
| `timely_create_event` | Log time to a project |
| `timely_update_event` | Change hours, note, labels or day |
| `timely_delete_event` | Delete a time entry |
| `timely_create_client` / `timely_update_client` | Add or change a client |
| `timely_create_project` / `timely_update_project` | Add or change a project |
| `timely_create_label` / `timely_update_label` / `timely_delete_label` | Manage labels |
| `timely_create_forecast` / `timely_update_forecast` / `timely_delete_forecast` | Manage planned work |
| `timely_create_webhook` / `timely_delete_webhook` | Manage webhooks |

Every update is a patch: only what you pass changes, so a rename never blanks the other fields.

### Reports

`timely_report` returns totals grouped by client, user, label and day. It summarises by default, because a month across an account is hundreds of kilobytes of repeated duration and cost objects, which is rarely what a summary needs:

```json
{"since": "2026-08-01", "upto": "2026-08-31"}
```

Pass `detail: true` for every underlying entry.

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
