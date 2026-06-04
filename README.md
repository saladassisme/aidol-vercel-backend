# Aidol Vercel Backend Starter

This is a minimal Vercel/Next.js backend for the App Store subscription version of Aidol.

It removes BYOK from the iOS app flow and moves AI/TTS calls behind your server:

- Apple subscription verification
- Daily quota checks
- AI chat reply proxy
- DashScope Qwen-TTS VC voice cloning
- DashScope Qwen-TTS synthesis
- TTS URL cache

## Product IDs

The iOS app should use these StoreKit product IDs:

- `aidol.membership.monthly`
- `aidol.membership.yearly`

## Free vs Member Limits

Current defaults:

- Free: 10 AI replies/day, 1 profile in the app, no Voice
- Member: 30 AI replies/day, Voice enabled, proactive messages enabled, 3 profiles in the app

The profile count is usually enforced in the app UI. The backend enforces AI/TTS/voice quotas.

## Deploy to Vercel

1. Create a Vercel project.
2. Connect **Supabase** Postgres.
3. Set `DATABASE_URL` to Supabase **Transaction pooler** URI (port **6543**, not the direct `db.*.supabase.co:5432` URI). In Supabase: **Connect → ORMs → URI → Mode: Transaction**.
4. Add the environment variables from `.env.example`.
4. Run the SQL in `migrations/001_init.sql` against your database.
5. Run `migrations/002_subscription_unique.sql` after `001_init.sql` (required for Apple subscription upsert).
6. Deploy.

### Verify deployment (important)

After deploy, run:

```bash
curl -sS "https://YOUR-PROJECT.vercel.app/api/v1/health"
```

You should see `"dbDriver":"postgres-js"`. If you still get `VercelPostgresError` on `/api/v1/quota/status`, the live deployment is **old** — open Vercel → Deployments, confirm the latest commit is **Ready**, and Redeploy with **Clear build cache**.

If `health` shows `"mode":"direct"`, change `DATABASE_URL` to the Supabase **Transaction pooler** URI (port 6543).

## Required Environment Variables

See `.env.example`. The backend accepts **either** the names below or their legacy aliases (both work).

| You configure (recommended) | Code alias (also accepted) |
|---|---|
| `DATABASE_URL` | `POSTGRES_URL` |
| `LLM_API_BASE_URL` | `AI_API_BASE_URL` |
| `LLM_API_KEY` | `AI_API_KEY` |
| `LLM_MODEL` | `AI_TEXT_MODEL` |
| `APPLE_BUNDLE_ID` | `AIDOL_BUNDLE_ID` |
| `APPLE_MONTHLY_PRODUCT_ID` | `AIDOL_PRODUCT_MONTHLY` |
| `APPLE_YEARLY_PRODUCT_ID` | `AIDOL_PRODUCT_YEARLY` |

Also required: `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `DASHSCOPE_API_KEY`.

Optional: `APPLE_ENVIRONMENT` (`sandbox` or `production`; the server will try both when verifying transactions), `DASHSCOPE_REGION`, `DASHSCOPE_TTS_VC_MODEL`, `FREE_DAILY_CHAT_LIMIT`, `MEMBER_DAILY_CHAT_LIMIT`, `MEMBER_DAILY_TTS_LIMIT`, `MEMBER_MONTHLY_VOICE_CLONE_LIMIT`.

**Apple keys checklist:** `AIDOL_BUNDLE_ID` must be `come.aidol.aidol`, product IDs must match the app, and `APPLE_PRIVATE_KEY` / `APPLE_ISSUER_ID` / `APPLE_KEY_ID` must be valid for App Store Connect API.

## API Endpoints

### POST `/api/v1/auth/session`

Create or fetch an anonymous user.

Headers or body:

```json
{
  "deviceId": "local-device-id-from-keychain"
}
```

### POST `/api/v1/subscription/sync`

Batch-sync StoreKit transaction IDs to the backend (use after Restore Purchases or before voice clone).

Headers:

```text
x-aidol-device-id: xxx
```

Body:

```json
{
  "transactionIds": ["1234567890"]
}
```

### POST `/api/v1/subscription/verify`

Verify an Apple StoreKit transaction.

Headers:

```text
x-aidol-device-id: xxx
```

Body:

```json
{
  "transactionId": "Apple transaction id"
}
```

### GET `/api/v1/quota/status`

Headers:

```text
x-aidol-device-id: xxx
```

Returns membership and today usage.

### POST `/api/v1/chat/reply`

Headers:

```text
x-aidol-device-id: xxx
```

Body:

```json
{
  "profileId": "optional",
  "nickname": "민준",
  "persona": "- 角色设定：...",
  "messages": [
    {"role":"user", "content":"오늘 너무 힘들어"}
  ]
}
```

Returns:

```json
{
  "ok": true,
  "data": {
    "reply": {
      "reply": "괜찮아. 오늘 정말 고생했어.",
      "translation_zh": "没关系。今天真的辛苦了。",
      "romanization": "gwaenchanha. oneul jeongmal gosaenghaesseo.",
      "vocabulary_notes": []
    },
    "quota": {"remaining": 29, "limit": 30}
  }
}
```

### POST `/api/v1/voice/clone`

Multipart form-data.

Headers:

```text
x-aidol-device-id: xxx
```

Fields:

- `audio`: audio file, <= 10MB
- `preferredName`: optional

### POST `/api/v1/tts/synthesize`

Headers:

```text
x-aidol-device-id: xxx
```

Body:

```json
{
  "text": "안녕하세요. 오늘도 만나서 반가워요.",
  "voiceId": "your-dashscope-voice-id",
  "model": "qwen3-tts-vc-2026-01-22"
}
```

Returns an HTTPS audio URL. Repeated same text + same voice + same model uses cache and does not consume TTS quota.

## Production Notes

- This starter decodes Apple signed transaction payload returned by App Store Server API after fetching it with your authenticated server token. For a high-security production app, add full JWS certificate-chain verification as an additional layer.
- Do not expose `AI_API_KEY` or `DASHSCOPE_API_KEY` in the iOS app.
- Add rate limiting before production launch.
- Store generated audio in your own object storage/CDN if you do not want to rely on temporary provider URLs.
- Add webhook handling for App Store Server Notifications V2 to keep subscriptions updated when users cancel, refund, renew, or upgrade outside the app.
