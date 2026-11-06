# mypic

Self-hosted photo and video storage that runs in **your own AWS account**. It's private by default and designed to cost a few dollars a month.

> **Status: work in progress.** Done so far: infrastructure (auth, storage, CDN, budget alarm), the upload/list API, image processing (thumbnails, EXIF, HEIC, RAW previews), and a web app with sign-in, bulk upload, a timeline and a lightbox. Albums and tags come next. See the [milestones](docs/SPEC.md#10-milestones).

## Features (planned for v1)

- Albums (one photo can be in many albums) and tags
- Bulk, resumable uploads straight to S3, up to 5 GB per file
- RAW support (CR3, NEF, ARW, DNG, …) using the embedded JPEG preview
- Video playback (transcoded to 1080p MP4 with MediaConvert)
- Sorting by EXIF date taken, a 30-day trash, and album download as ZIP
- Public share links with optional expiry and password
- Invite-only accounts (Cognito), with optional authenticator-app MFA
- Responsive web UI for desktop and mobile

## Architecture

```
Next.js (Amplify Hosting) ─▶ API Gateway + Lambda ─▶ DynamoDB (metadata)
        │                                │
        ├── presigned upload ──────────▶ S3 (originals, Intelligent-Tiering)
        │                                │ ObjectCreated → processing Lambda / MediaConvert
        └── signed URLs ─▶ CloudFront ─▶ S3 (thumbnails, previews, video)
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
