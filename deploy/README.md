# Deploying the team server

Full guide: [`docs/team-server.md`](../docs/team-server.md). This page is only
"which file do I use."

1. **Have Docker already, or want the least host setup?** Use
   `docker-compose.yml`. `cp team.env.example team.env`, fill it in, then
   `docker compose -f docker-compose.yml up -d`.
2. **Prefer a plain host process, no container runtime?** Use
   `tokenflow-team.service` (systemd). It expects Node 22.5+ installed and
   `tokenflow` on PATH; see its own header comment for the setup commands.
3. **Either way, need TLS or the GitHub App webhook public?** Add a reverse
   proxy in front: `Caddyfile` (automatic certificates) or `nginx.conf` (a
   site config for an nginx you already run). Both document two variants
   inline: everything private, or only `/github/webhook` public.
4. `team.env.example` lists every environment variable the server reads,
   required and optional, for both deployment paths above.

Nothing here needs internet access except: an inbound path for the optional
GitHub App webhook, Caddy's outbound certificate request if you choose it,
and the server's own outbound calls to the GitHub API once the App is
configured (posting a check run and a PR comment). With the App left
unconfigured, the server makes no outbound calls at all.
