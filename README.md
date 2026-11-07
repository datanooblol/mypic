# mypic

Self-hosted photo and video storage that runs in **your own AWS account**. It's private by default and designed to cost a few dollars a month.

> **Status: work in progress.** Done so far: infrastructure (auth, storage, CDN, budget alarm), the upload/list API, image processing (thumbnails, EXIF, HEIC, RAW previews), albums, tags and trash, and a web app with sign-in, bulk upload, a timeline, multi-select, "Download selected" and a lightbox. Production hosting (Amplify) comes next. Share links, ZIP export and video playback are deferred (see below). See the [milestones](docs/SPEC.md#10-milestones).

## Features

- Albums (one photo can be in many albums) and tags
- Bulk uploads straight to S3, up to 5 GB per file
- RAW support (CR3, NEF, ARW, DNG, …) using the embedded JPEG preview
- Sorting by EXIF date taken, and a 30-day trash
- **Download selected:** on desktop the originals download one after another; on phones, "Save" opens the share sheet to save them to Photos or Files in one step
- Invite-only accounts (Cognito), with optional authenticator-app MFA
- Responsive web UI for desktop and mobile

### Deferred until we learn more

- **Public share links.** How people actually share (a link or a password, expiry, which apps) should be understood before choosing a design. For now, invite people as users, or use "Download selected" and send the files. A draft design is in [docs/SPEC.md](docs/SPEC.md#48-share-links-deferred).
- **Album download as ZIP.** "Download selected" covers most needs. A server-side ZIP job is designed but not built ([SPEC §4.4](docs/SPEC.md#44-zip-export-deferred)).

### Videos: stored, but no playback yet

Videos can be uploaded, organized into albums and tags, trashed and downloaded like photos. The app doesn't transcode them or play them in the browser yet. They show as a video placeholder, and you download the original to watch it.

In-browser playback (MediaConvert transcoding to MP4, poster thumbnails, a player in the lightbox) is **deferred until more users ask for it**. The design is already written up in [docs/SPEC.md](docs/SPEC.md#45-video-playback-deferred). If you want it, please open an issue.

## Architecture

```
Next.js (Amplify Hosting) ─▶ API Gateway + Lambda ─▶ DynamoDB (metadata)
        │                                │
        ├── presigned upload ──────────▶ S3 (originals, Intelligent-Tiering)
        │                                │ upload complete → processing Lambda (thumbnails, EXIF)
        └── signed URLs ─▶ CloudFront ─▶ S3 (thumbnails, previews)
```

Full design: [docs/SPEC.md](docs/SPEC.md).

## Deploy to your own AWS account

### Prerequisites

- Node.js 22+
- AWS CLI v2, configured with credentials for the target account (`aws sts get-caller-identity` should work)
- Docker, running during `cdk deploy` (builds the image-processing Lambda container)

### 1. Configure

Edit the `context` section of [`infra/cdk.json`](infra/cdk.json):

```jsonc
"region": "ap-southeast-1",   // AWS region to deploy to
"budgetUsd": 10               // monthly budget alert threshold
```

### 2. Deploy

```bash
npm install
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>   # once per account/region (run in infra/)
npm run keys:dev        # creates your CloudFront URL-signing key pair (private key goes to SSM)
npm run deploy:dev      # Auth + Storage stacks -> infra/cdk-outputs.dev.json
npm run env:web         # writes web/.env.local from the stack outputs
npm run dev:web         # http://localhost:3000
```

Optional: a budget alert for the whole account (deploy once):

```bash
cd infra
npx cdk deploy MyPic-Budget -c alertEmail=you@example.com
```

> **PowerShell:** run CDK commands that take extra flags with `npx cdk ...` from `infra/`. PowerShell can swallow the `--` in `npm run cdk -- ...`, and then npm treats `-c` as its own option.

### 3. Create your user

Self sign-up is disabled. Create users with the AWS CLI. `<UserPoolId>` is in `infra/cdk-outputs.dev.json`.

```bash
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username you@example.com --group-name admin
```

Cognito emails you a temporary password, and you set a new one at first sign-in.

### Stages

`dev` and `prod` are separate stacks (`-c stage=dev|prod`). In `dev`, data is **deleted** when the stack is destroyed. In `prod`, the bucket and table are kept and have deletion protection. Run `npm run keys -w infra -- prod` before the first `npm run deploy:prod -w infra`.

### 4. Host the web app on Amplify

The web app is a **static export** (`output: 'export'`), so Amplify serves plain files from its CDN with no server runtime. Album and tag pages use query parameters (`/album?id=…`, `/tag?name=…`) because static exports can't serve dynamic URL segments.

1. Amplify console → **Create new app** → GitHub → your fork → branch `main`.
2. Tick **"My app is a monorepo"** with root directory `web`. Leave **"Amplify Gen2 backend"** unticked. The build settings come from [`amplify.yml`](amplify.yml).
3. After it's created, switch the app to static hosting (the console detects Next.js as SSR):
   ```bash
   aws amplify update-app --app-id <APP_ID> --platform WEB
   aws amplify update-branch --app-id <APP_ID> --branch-name main --framework "Next.js - SSG"
   ```
4. **Environment variables**, per branch (App settings → Environment variables), using the values from `infra/cdk-outputs.<stage>.json`:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_STAGE` | `prod` (or `dev`) |
   | `NEXT_PUBLIC_AWS_REGION` | `MyPic-<stage>-Auth.Region` |
   | `NEXT_PUBLIC_USER_POOL_ID` | `MyPic-<stage>-Auth.UserPoolId` |
   | `NEXT_PUBLIC_USER_POOL_CLIENT_ID` | `MyPic-<stage>-Auth.UserPoolClientId` |
   | `NEXT_PUBLIC_API_URL` | `MyPic-<stage>-Api.ApiUrl` |

5. Optional: add a `dev` branch pointing at the `dev` stack's values, so you can test on your phone before merging to `main`.

Uploads from the hosted site work out of the box: the bucket's CORS rule allows `https://*.amplifyapp.com`. If you add a custom domain, add it to `webOrigins` in [`infra/lib/config.ts`](infra/lib/config.ts) and redeploy the Storage stack.

### Clean up

```bash
cd infra
npx cdk destroy --all -c stage=dev
aws ssm delete-parameter --name /mypic/dev/cloudfront/private-key
```

## Cost

Storage is the main cost. The rough estimate for about 300 GB of originals plus light use is **$5–10/month**: the Intelligent-Tiering storage class moves files you rarely open to cheaper tiers, and the API, Lambda and CloudFront usage mostly fits in the free tier. See [the spec](docs/SPEC.md#9-cost-estimate-ap-southeast-1-rough-verify-with-the-aws-pricing-calculator) for the breakdown. Verify against your own usage with the AWS Pricing Calculator. You are responsible for the charges in your account.

## Repo layout (npm workspaces)

```
shared/     @mypic/shared    Domain types + DynamoDB/S3 key builders (used by services and web)
infra/      @mypic/infra     AWS CDK app
  bin/mypic.ts                 App entry: picks stage from -c stage=dev|prod
  lib/config.ts                Per-stage settings (reads infra/cdk.json context)
  lib/stacks/                  auth, storage, processing, api, budget (ops next)
  scripts/                     CloudFront key generation, web/.env.local writer
  keys/                        Your CloudFront public key (gitignored)
services/   @mypic/services  Lambda handlers (bundled by CDK with esbuild)
web/        @mypic/web       Next.js (App Router) + Tailwind
docs/                        Spec and notes
```

| Command | What it does |
|---|---|
| `npm run typecheck` | Type-check all workspaces |
| `npm test` | Run tests |
| `npm run synth` | `cdk synth` for dev |
| `npm run deploy:dev` | Deploy all dev stacks |
| `npm run dev:web` | Run Next.js locally |

## License

[MIT](LICENSE)
