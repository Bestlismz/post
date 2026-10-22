# Facebook Groups staging and session recovery

The Group browser is an isolated Compose service. It has no database URL, OpenAI key, Meta Page token, Facebook password, or host-published port. Its Chromium profile is the protected `browser-profile` volume. Never add a Facebook username, password, cookie, or exported storage state to `.env`, Compose, logs, fixtures, or source control.

## Safe staging sequence

1. Configure `GROUP_COMMAND_KEYS` as a JSON map whose values are canonical base64 encodings of exact 32-byte keys, select one with `GROUP_COMMAND_KEY_ID`, and set the numeric `GROUP_SOURCE_ALLOWLIST`. Generate a key with `openssl rand -base64 32`; never use the displayed base64 text itself as HMAC bytes.
2. Leave `STAGING_FACEBOOK_SEND=false` and `STAGING_FACEBOOK_SOURCE_ALLOWLIST=`. Start the stack and run `docker compose --profile tools run --rm staging-check --no-send` for health only. After manual login, run `docker compose --profile tools run --rm staging-check --no-send --source <group-id>` for an allow-listed read-only scan report containing coverage, count, and evidence hashes but no customer text. The one-shot tool joins only the private browser network; the Group worker remains unpublished. Neither command sends anything.
3. Sign in manually through an admin recovery session. The application pauses the source before returning the short-lived tunnel. Complete Facebook login or checkpoint screens yourself; credential entry is never automated. Close the recovery session when finished. Expiry closes the tunnel automatically, while the source remains paused.
4. Run a read-only scan, inspect its coverage and evidence, and confirm session and selector health. Do not enable delivery when coverage is partial, the selector circuit is open, or the source reports `auth_required`, `checkpoint`, `expired`, or `quarantined`.
5. For one authorized test group only, set `STAGING_FACEBOOK_SEND=true` and set `STAGING_FACEBOOK_SOURCE_ALLOWLIST` to that exact numeric group ID. Restart only the isolated worker, then run `docker compose --profile tools run --rm staging-check --send --source <group-id>`. The check reports readiness; it does not submit a post or reply.
6. Re-enable the source only after the read-only evidence is correct. Remove the send flag and allowlist immediately after the test.

## Recovery cases

- **Session expired or login required:** pause the source, start an admin recovery session, sign in manually, close recovery, run a read-only scan, then explicitly resume.
- **Facebook checkpoint:** keep the source paused and resolve the checkpoint manually. Do not work around or automate the challenge.
- **Selector drift:** keep the selector circuit open. Preserve partial observations, update and validate the recorded DOM contract, deploy, then use the explicit recovery scan path.
- **Profile busy or quarantined:** stop issuing commands. Confirm the previous Chromium/client process terminated before restarting the isolated worker. The kernel profile lock is the ownership authority.
- **Unknown send:** never resend automatically. Inspect the destination, sender identity, attempt time window, exact content, and remote permalink. Reconcile only with matching evidence; `not_found` remains unknown.

## Tunnel boundary

The browser and noVNC endpoints exist only on the Compose `browser` network. The web server proxies noVNC assets and WebSocket traffic only for an authenticated admin and an unexpired recovery session. `/novnc` is intentionally not routed. A web restart forgets all tunnels; the worker lease still expires independently. Source pause is durable and is not automatically cleared by tunnel expiry.
