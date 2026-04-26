# Example human flow

## 1. Start the daemon

```sh
npm install
npx tsx src/cli.ts start-server
# [attention-router] listening on http://127.0.0.1:7777
```

## 2. Submit a valid ask (HTTP)

```sh
curl -sS -XPOST http://127.0.0.1:7777/asks \
  -H 'content-type: application/json' \
  --data-binary @examples/valid-ask.json | jq .
```

Response (queued, council escalated because expected_loss_if_wrong=250 and reversibility=git_revert with low default confidence):

```json
{
  "status": "queued",
  "ask_id": "ask_demo_001",
  "council": { "predicted_human_choice": "A", "entropy": 0.971, "escalate": true, "..." : "..." },
  "bid":     { "score": 412.5, "show_now": true, "reason": "expected loss is high; council split" }
}
```

## 3. Submit a naked ask (gets rejected)

```sh
curl -sS -XPOST http://127.0.0.1:7777/asks \
  -H 'content-type: application/json' \
  --data-binary @examples/naked-ask.json | jq .
```

Response:

```json
{
  "status": "rejected",
  "rejected": {
    "id": "ask_naked_001",
    "project_id": "checkout-api",
    "reason": "no options provided",
    "repair_instructions": [
      "generate at least 2 (ideally 3) options",
      "add evidence per option",
      "pick a default option",
      "estimate confidence (0..1)",
      "estimate cost if wrong (numeric)",
      "explain predicted next step per option"
    ]
  }
}
```

## 4. Pull the next decision card

```sh
npx tsx src/cli.ts next
```

```
checkout-api · ~30s requested · expires in 30m

PICK RATE-LIMIT STRATEGY FOR /CHECKOUT ENDPOINT

Context:
  We just saw a burst of 5x normal traffic from one IP block...

A. Token bucket per user_id (Redis)
Evidence:
  - redis already in stack
  - per-user fairness preferred over per-IP for logged-in users
  ...
Next:
  - add middleware checkout.ts with redis token bucket...
Risk:
  - false-positive blocks of legit power users; reversible by raising limit

B. IP-based fixed window in nginx
...

C. Do nothing, watch dashboards
...

Agent default: A
Council prediction: A
Why this reached you:
  - expected loss is high
  - council split

Reply:  A / B / C / override: <text> / skip
```

## 5. Decide and (optionally) save a rule

```sh
npx tsx src/cli.ts decide ask_demo_001 A
# → returns { rule_draft: { id: "rule_…", status: "draft", prefer: "redis", ... } }

npx tsx src/cli.ts rules                # see drafts
npx tsx src/cli.ts accept-rule rule_xxx # promote draft to accepted
```

The accepted rule will be loaded by `runCouncil()` for future asks in this project, biasing the council toward `prefer` and away from `avoid`.

## 6. Inspect

```sh
npx tsx src/cli.ts status
npx tsx src/cli.ts projects
```
