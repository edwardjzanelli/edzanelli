# session-token Lambda

Mints LiveAvatar session tokens for the two avatar pages. Spec v1.2 sections 7, 8, 10.

Files: `index.mjs` (handler), `config.json` (allow-lists and IDs), `moderation-policy.txt` (the rules a read script is held to, read at cold start). All three must be in the deployment package. No dependencies; Node 20 has `fetch` built in.

## Request

```
POST <FunctionUrl>
{ "mode": "ask" | "read", "avatar": "ed|judy|dexter", "language": "en|it", "llm": "openai|claude|gemini", "speed": 1.00, "script": "..." }
```

`mode` defaults to `ask`. Every mode needs `avatar`; `speed` is optional everywhere (0.80 to 1.20
in steps of 0.05, defaulting to `voiceSpeed` in `config.json`, then 1).

| mode | token | `language` | `llm` | `script` | used by |
| --- | --- | --- | --- | --- | --- |
| `ask` | `FULL` with `context_id` and an LLM configuration, so the avatar converses | required | required | ignored | `ask.html` |
| `read` | `FULL` with **no** `context_id` and **no** `llm_configuration_id` | optional, defaults to `en` | ignored | required, 1500 characters at most | `read.html` |

`language` sets speech recognition, so it only matters where the avatar listens. Read mode never
listens, and the voice is multilingual: it reads an English or an Italian script correctly whatever
this field says. The Read page therefore has no language selector and sends none. A `language` that
*is* sent is still checked against the allow-list in both modes.

`read` exists because the Read page never asks the avatar anything: it calls the SDK's `repeat()`,
which speaks text verbatim. A `read` request with a missing, non-string, or over-length `script` is
a 400.

### Why read mode is FULL without a context, and not LITE

Omitting `context_id` from a FULL token is what HeyGen calls **restricted** mode: the avatar
generates nothing on its own and speaks only what the page sends with `repeat()`, while the vendor
voice still does the speaking. That is exactly what this page wants.

**LITE cannot do this job.** It was tried first and produced an avatar that appeared and then said
nothing. The reasons, from the LiveAvatar transport spike in the SeniorMinder repo
(`spike/lite-transport`, commits `1c3a3643` and `18445c98`):

- LITE validates only `avatar_id`. A bogus `voice_id` is accepted with a 200, so the voice on a
  LITE token is not actually being applied.
- A LITE session carries **no vendor text-to-speech**. The client is expected to supply its own
  audio as PCM. There is no voice on the far end for `repeat()` to use.
- `avatar.speak_text`, which is what `repeat()` sends, therefore produced no speech and no events
  on a LITE session.

**Cost.** FULL bills 2 credits per minute of open session, speaking or idle, against the
prepaid HeyGen balance. LITE would have been cheaper, but it cannot speak. A read session is
stopped by the page as soon as the last line is spoken, and `maxSessionDurationSeconds` (180) caps
a session that is not, so the worst case is 6 credits per read.

Both modes answer `{ "session_id": "...", "session_token": "..." }`. Read mode adds `refused`, and
a `message` when that is true:

```
{ "session_id": "...", "session_token": "...", "refused": false }
{ "session_id": "...", "session_token": "...", "refused": true,
  "message": "I'm sorry, but I'm unable to say that because it is <reason>." }
```

A refused script still gets a session: the avatar delivers the refusal in its own voice, which is
why a token is minted for it. The page speaks `message` in place of the script, so the refused text
itself never reaches the avatar.

## One-time setup in the LiveAvatar dashboard
1. Context: create `Ask Ed` from `prompts/ask-ed.txt`. Copy its ID into `config.json` as `context_id`. One context serves both languages; the prompt tells the avatar to answer in the visitor's language.
2. Avatars and voices: copy the three avatar IDs and the voice IDs (one per language) into `config.json`.
3. LLMs: for each of OpenAI, Anthropic, Google, store the vendor key as a secret, then create an LLM configuration (base_url and model_name from spec section 10). Copy the three configuration IDs into `config.json`.
4. Try each LLM configuration in a dashboard session before deploying.

## Deploy (AWS CLI, run from `lambda/session-token/`)
```
zip -j session-token.zip index.mjs config.json moderation-policy.txt

aws iam create-role --role-name askEdTokenRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name askEdTokenRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws lambda create-function --function-name askEdSessionToken \
  --runtime nodejs20.x --handler index.handler --zip-file fileb://session-token.zip \
  --role arn:aws:iam::<ACCOUNT_ID>:role/askEdTokenRole --timeout 15 \
  --environment "Variables={LIVEAVATAR_API_KEY=<key>,OPENAI_API_KEY=<key>,ALLOWED_ORIGINS=https://edzanelli.com,SANDBOX=1}"

aws lambda create-function-url-config --function-name askEdSessionToken --auth-type NONE \
  --cors '{"AllowOrigins":["https://edzanelli.com"],"AllowMethods":["POST"],"AllowHeaders":["content-type"],"MaxAge":3600}'
aws lambda add-permission --function-name askEdSessionToken --statement-id public-url \
  --action lambda:InvokeFunctionUrl --principal "*" --function-url-auth-type NONE
```
The `FunctionUrl` printed by `create-function-url-config` goes into `src/js/avatar-session.js` as `TOKEN_URL`, which both pages import.

For local testing add `http://localhost:8080` to `ALLOWED_ORIGINS` on both the environment variable and the function URL CORS list, and remove it before launch.

## Update
```
zip -j session-token.zip index.mjs config.json moderation-policy.txt
aws lambda update-function-code --function-name askEdSessionToken --zip-file fileb://session-token.zip
```
Going live: `aws lambda update-function-configuration --function-name askEdSessionToken --environment "Variables={...,SANDBOX=0}"`.

## Pause the demo
`aws lambda delete-function-url-config --function-name askEdSessionToken`. The page then shows the unavailable state; nothing else breaks.

## Moderation (read mode only)
Before a read token is minted, the script is sent to OpenAI (`gpt-4o-mini`, `temperature` 0, a
JSON-object response) with `moderation-policy.txt` as the system message and the script as the user
message. The answer is `{"allowed": true}` or `{"allowed": false, "reason": "<phrase>"}`, and the
reason completes the sentence the visitor sees.

- Refused: `200` with a token, `refused: true`, and `message` set to
  `"I'm sorry, but I'm unable to say that because it is <reason>."` The avatar says that message
  instead of the script, so the refusal is delivered in the same voice as everything else on the
  page. The refused script is never sent to the avatar.
- Cannot be checked (call failed, timed out after 10 s, or the answer was not usable):
  `502 {"error": "I can't check that script right now. Please try again in a moment."}`

A refusal mints; a failure does not. **The check still fails closed**: a verdict that could not be
reached is not a verdict to speak, so nothing is minted and the visitor's script is not read.
Deleting `OPENAI_API_KEY` therefore turns the Read page off while leaving Ask working, which is
the quickest way to pause just that page.

In neither case does the refused script reach the avatar. What a refusal buys is a session that
says why, which is what the Read page's "what it won't read" note promises.

`OPENAI_API_KEY` is set in the Lambda console (or with `update-function-configuration`) and is
never committed. Edit the policy in `moderation-policy.txt` and redeploy; it is read at cold start,
so it is versioned with the code rather than typed into a console.

## Test
The Lambda's side of the moderation contract is covered by `test/moderation.test.mjs`, which mocks
`fetch`. From the repository root:
```
npm test
```
Against the deployed function:
```
curl -X POST <FunctionUrl> -H "origin: https://edzanelli.com" -H "content-type: application/json" \
  -d '{"avatar":"ed","language":"en","llm":"claude"}'

curl -X POST <FunctionUrl> -H "origin: https://edzanelli.com" -H "content-type: application/json" \
  -d '{"mode":"read","avatar":"ed","language":"en","script":"Testing the read page."}'
```
Expect `{"session_id":"...","session_token":"..."}`. A 503 means an ID in `config.json` is still blank; a 502 means either LiveAvatar refused or, in read mode, the script could not be checked; a 403 on a read means the policy refused the script. Every one of them logs its reason to CloudWatch.