# session-token Lambda

Mints LiveAvatar session tokens for the two avatar pages. Spec v1.2 sections 7, 8, 10.

Files: `index.mjs` (handler), `config.json` (allow-lists and IDs). No dependencies; Node 20 has `fetch` built in.

## Request

```
POST <FunctionUrl>
{ "mode": "ask" | "read", "avatar": "ed|judy|dexter", "language": "en|it", "llm": "openai|claude|gemini", "speed": 1.00, "script": "..." }
```

`mode` defaults to `ask`. Every mode needs `avatar` and `language`; `speed` is optional everywhere
(0.80 to 1.20 in steps of 0.05, defaulting to `voiceSpeed` in `config.json`, then 1).

| mode | token | `llm` | `script` | used by |
| --- | --- | --- | --- | --- |
| `ask` | `FULL`: the context and an LLM configuration, so the avatar converses | required | ignored | `ask.html` |
| `read` | `LITE`: avatar and voice only, no context and no LLM | ignored | required, 1500 characters at most | `read.html` |

`read` exists because the Read page never asks the avatar anything: it calls the SDK's `repeat()`,
which speaks text verbatim, so a session carrying a context and an LLM would pay for machinery it
never uses. A `read` request with a missing, non-string, or over-length `script` is a 400.

Both modes answer `{ "session_id": "...", "session_token": "..." }`.

## One-time setup in the LiveAvatar dashboard
1. Context: create `Ask Ed` from `prompts/ask-ed.txt`. Copy its ID into `config.json` as `context_id`. One context serves both languages; the prompt tells the avatar to answer in the visitor's language.
2. Avatars and voices: copy the three avatar IDs and the voice IDs (one per language) into `config.json`.
3. LLMs: for each of OpenAI, Anthropic, Google, store the vendor key as a secret, then create an LLM configuration (base_url and model_name from spec section 10). Copy the three configuration IDs into `config.json`.
4. Try each LLM configuration in a dashboard session before deploying.

## Deploy (AWS CLI, run from `lambda/session-token/`)
```
zip -j session-token.zip index.mjs config.json

aws iam create-role --role-name askEdTokenRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name askEdTokenRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws lambda create-function --function-name askEdSessionToken \
  --runtime nodejs20.x --handler index.handler --zip-file fileb://session-token.zip \
  --role arn:aws:iam::<ACCOUNT_ID>:role/askEdTokenRole --timeout 15 \
  --environment "Variables={LIVEAVATAR_API_KEY=<key>,ALLOWED_ORIGINS=https://edzanelli.com,SANDBOX=1}"

aws lambda create-function-url-config --function-name askEdSessionToken --auth-type NONE \
  --cors '{"AllowOrigins":["https://edzanelli.com"],"AllowMethods":["POST"],"AllowHeaders":["content-type"],"MaxAge":3600}'
aws lambda add-permission --function-name askEdSessionToken --statement-id public-url \
  --action lambda:InvokeFunctionUrl --principal "*" --function-url-auth-type NONE
```
The `FunctionUrl` printed by `create-function-url-config` goes into `website/js/ask.js` as `TOKEN_URL`.

For local testing add `http://localhost:8080` to `ALLOWED_ORIGINS` on both the environment variable and the function URL CORS list, and remove it before launch.

## Update
```
zip -j session-token.zip index.mjs config.json
aws lambda update-function-code --function-name askEdSessionToken --zip-file fileb://session-token.zip
```
Going live: `aws lambda update-function-configuration --function-name askEdSessionToken --environment "Variables={...,SANDBOX=0}"`.

## Pause the demo
`aws lambda delete-function-url-config --function-name askEdSessionToken`. The page then shows the unavailable state; nothing else breaks.

## Test
```
curl -X POST <FunctionUrl> -H "origin: https://edzanelli.com" -H "content-type: application/json" \
  -d '{"avatar":"ed","language":"en","llm":"claude"}'

curl -X POST <FunctionUrl> -H "origin: https://edzanelli.com" -H "content-type: application/json" \
  -d '{"mode":"read","avatar":"ed","language":"en","script":"Testing the read page."}'
```
Expect `{"session_id":"...","session_token":"..."}`. A 503 means an ID in `config.json` is still blank; a 502 means LiveAvatar refused, and the reason is in CloudWatch.