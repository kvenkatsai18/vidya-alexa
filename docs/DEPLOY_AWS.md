# Hosting Vidya on AWS

One small server runs everything:

- **The MCP server** at `https://mcp.<your-domain>/mcp`. This is what an AI assistant (Claude Code, an Alexa+ add-on, any MCP client) connects to.
- **The demo device page** at `https://device.<your-domain>`. It's password-protected.
- **Caddy** in front, which gets HTTPS certificates automatically. HTTPS is required for the microphone in the browser.

The image is in `Dockerfile`, and the server setup is in `deploy/` (`docker-compose.yml`, `Caddyfile`, `env.example`).

## Why one server and not Lambda or App Runner

The MCP server keeps live state in memory:

- Streamable HTTP sessions
- server-to-client streams for elicitation and live game updates
- online Study Together games shared across homes

That state needs one long-running process with a disk:

- **Lambda doesn't fit.** Requests have a time limit, and there's no shared memory between invocations.
- **App Runner, or anything that autoscales to several instances, doesn't fit either.** Each instance would see different sessions and games.
- **Use one instance.** A single Lightsail or EC2 instance is the simplest setup that's correct.

Scaling out later means moving sessions and games to a shared store (DynamoDB or ElastiCache), and learner data to DynamoDB or EFS.

## Cost

| Item | Rough cost |
|---|---|
| Lightsail instance with 1 GB RAM and a static IP | About $5–7 a month (check current pricing). New accounts may get free months. |
| Or EC2 t4g.small or t3.small | About the same; free-tier credits may cover it. |
| Bedrock (Amazon Nova) | Pay per use, and Nova Lite is among the cheapest models. Demo testing is likely cents to a few dollars. Pick the model with `BUDDY_MODEL`. |
| Polly (generative voice) | Pay per character. New accounts have a free allowance. |

**Set a billing alert first.** Go to Billing → Budgets → Create budget → "Zero spend" or a $5 monthly budget, with an email alert.

## Option A: Lightsail (simplest)

1. **Create the instance.** In the Lightsail console, choose Linux/Unix, OS only, Ubuntu 24.04, and the 1 GB plan.
2. **Networking.** Create a static IP and attach it. Under IPv4 firewall, keep 22 open and add **80** and **443**.
3. **DNS.** Point two hostnames at the static IP. With no domain, use sslip.io. For IP `3.91.20.7`, the names are `mcp.3-91-20-7.sslip.io` and `device.3-91-20-7.sslip.io`. No DNS setup is needed.
4. **AWS access for Bedrock and Polly.** Lightsail instances can't use IAM roles, so create an IAM user just for this.
   - Give it Bedrock model invocation (for example the managed `AmazonBedrockLimitedAccess` policy) and `polly:SynthesizeSpeech`.
   - Create an access key and put it in `deploy/.env` (step 6).
   - Amazon Nova models need no access request. New AWS accounts can be blocked from Bedrock for a few hours while the account is verified.
5. **Install Docker and copy the code.** The repo is private, so copy it from your machine instead of cloning:
   ```bash
   # on the server
   sudo apt update && sudo apt install -y docker.io docker-compose-v2 && sudo usermod -aG docker ubuntu
   # on your Mac, from the repo root
   rsync -az --exclude node_modules --exclude .data --exclude .env --exclude .archive --exclude .git \
     ./ ubuntu@<static-ip>:study-buddy/
   ```
6. **Configure.**
   ```bash
   cd ~/study-buddy && cp deploy/env.example deploy/.env && nano deploy/.env
   openssl rand -hex 24                                                  # -> BUDDY_ACCESS_TOKEN
   docker run --rm caddy:2.8 caddy hash-password --plaintext 'pick-a-password'   # -> DEVICE_PASSWORD_HASH ($ -> $$)
   ```
7. **Start.**
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   docker compose -f deploy/docker-compose.yml logs -f app
   curl https://mcp.<your-domain>/healthz
   ```

## Option B: EC2 (no keys on disk)

Use this if you'd rather not store access keys on the server.

- Launch a t4g.small or t3.small with Ubuntu 24.04.
- Attach an **IAM instance role** with the same Bedrock and Polly permissions.
- In the security group, allow 80 and 443 (and 22 from your IP).
- Attach an Elastic IP.
- Then follow steps 5–7 above, and leave `AWS_ACCESS_KEY_ID` out of `deploy/.env`. Keep `BUDDY_LLM=bedrock`, because with a role there's no key file to auto-detect.

## Connect an AI assistant to the hosted server

```bash
claude mcp add --transport http study-buddy https://mcp.<your-domain>/mcp \
  --header "Authorization: Bearer <BUDDY_ACCESS_TOKEN>" \
  --header "x-study-buddy-home: my-family"
```

## Try Study Together across homes

1. **Open two devices.** Open `https://device.<your-domain>/?home=kapoor` on one laptop and `https://device.<your-domain>/?home=rao` on another, or in another browser profile. Each `home` is a separate household with its own memory.
2. **Host.** On the first device, say "Hi, I'm Priya, I'm in 10th grade", share notes, then say "let's play an online quiz battle with my friend".
3. **Join.** On the second device, a parent sets up a child, says "allow online games for Leo", and then the child says "join game Tiger 4 2". Use the code the host's device shows.
4. **Play.** The host says "start the game". Each device announces whose turn it is when the other home plays.

## Production notes

- **Accounts.** The shared `BUDDY_ACCESS_TOKEN` and the `x-study-buddy-home` header are for the demo. In production, each family signs in (MCP authorization, or Alexa account linking), and the home comes from that account.
- **Backups.** Learner data is under the `buddy-data` volume (`/data` in the container). Lightsail snapshots, or EBS snapshots on EC2, back it up.
- **Updates.** `rsync` again, then `docker compose ... up -d --build`.
- **Demo controls.** The clock and reset under `/admin` are behind the access token. Set `BUDDY_ADMIN=off` to remove them.
- **School sync in live mode.** Add `https://mcp.<your-domain>/school/oauth/callback` as an authorized redirect URI in the Google Cloud OAuth client, and set `BUDDY_PUBLIC_URL`.
