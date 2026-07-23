This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Cloudflare-first faithful translation

Configure a Cloudflare API token with the `Workers AI Read` and `Workers AI
Write` permissions in `.env.local`:

```env
CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
CLOUDFLARE_WORKERS_AI_API_TOKEN=your-workers-ai-token
AI_TEXT_PRIMARY_PROVIDER=cloudflare
CLOUDFLARE_TEXT_MODEL=@cf/meta/llama-4-scout-17b-16e-instruct
CLOUDFLARE_TEXT_TIMEOUT_MS=2500

# Required for the OpenAI fallback and the existing Realtime/TTS paths.
OPENAI_API_KEY=your-openai-api-key
OPENAI_FAST_TEXT_MODEL=gpt-4o-mini
```

The Flutter API contract does not change. `/api/conversation` applies this
order:

1. reviewed exact rule or V1 text cache;
2. Cloudflare multilingual text model with the faithful V1 prompt;
3. OpenAI Responses fallback when Cloudflare fails, times out, is rate-limited,
   or returns an invalid result;
4. the existing audio cache/TTS path.

`POST /api/audio/translate` remains an independent compatibility endpoint for
direct audio translation. It is not used by the Flutter conversation pipeline
because direct audio translation would bypass the Vietnamese exact-rule check.

The compatibility endpoint accepts `multipart/form-data`:

- `audio` (required): AAC, FLAC, M4A, MP3, MP4, OGG, WAV or WebM file;
- `sourceLanguage` (optional): ISO language code, defaults to `vi`.

The API calls Cloudflare with `task: "translate"` and returns an English result:

```json
{
  "sourceLanguage": "vi",
  "targetLanguage": "en",
  "englishText": "I would like some water.",
  "wordCount": 5,
  "model": "@cf/openai/whisper-large-v3-turbo"
}
```

## Admin dashboard

Open [http://localhost:3000/admin](http://localhost:3000/admin) to:

- filter conversation history by device and review status;
- label the current Android device and child profile;
- approve, reject, or correct an English sentence;
- save approved corrections as a client-scoped rule and warm its audio cache;
- request an AI review only when needed, reusing the saved result afterward.

Local development allows admin access without a token. Production requires
`ADMIN_API_TOKEN`; copy `.env.example` to `.env.local`, set a strong value, and
enter the same value in the admin dashboard for the current browser session.

## Storage modes

Local development remains the default, so the current emulator and existing
JSON/audio files continue to work without extra services:

```env
PERSISTENCE_BACKEND=local
AUDIO_STORAGE_BACKEND=local
```

For multiple backend instances, use Neon PostgreSQL for records and Vercel Blob
for generated English audio:

```env
PERSISTENCE_BACKEND=postgres
DATABASE_URL=postgresql://...
AUDIO_STORAGE_BACKEND=vercel-blob
GENERATED_AUDIO_BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
CRON_SECRET=use-a-long-random-secret
```

The Blob store is public because it only contains generated English TTS. The
child's uploaded voice chunks are transient and are stored in PostgreSQL with a
short TTL; they are never published as Blob URLs.

Before enabling managed storage, run:

```bash
npm run storage:migrate:dry-run
npm run storage:migrate
npm run storage:check
```

Migration first creates a local backup under `backups/`, copies data without
deleting local files, and is safe to repeat. To prepare a local rollback
snapshot, run `npm run storage:rollback`. Applying it to the live local folders
requires the explicit `npm run storage:rollback:apply` command.

The endpoint `GET /api/admin/storage-health` checks the selected storage
providers. Expired upload sessions are cleaned opportunistically and hourly by
the Vercel cron configured in `vercel.json`.

Upload defaults are 1 MiB per chunk, 16 MiB per session, 1,000 chunks and a
15-minute unfinished-session TTL. They can be adjusted through the environment
variables documented in `.env.example`.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
