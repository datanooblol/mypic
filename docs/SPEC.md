# mypic — Specification (v1)

Personal media storage for one owner and a few invited users. Stores photos (including RAW files) and videos, organizes them into albums and tags, and can share albums by link. Works on desktop and mobile through a responsive web UI.

---

## 1. Decisions (from interview)

| Topic | Decision |
|---|---|
| Users | Owner plus a few invited users. No self sign-up. Each user's library is private. |
| Auth | Cognito User Pool, MFA optional (TOTP) |
| Sharing | Public share links per album, with optional expiry and optional password |
| Content | Photos (JPEG/PNG/HEIC/WebP), **RAW** (CR3, CR2, NEF, ARW, DNG, RAF, ORF, RW2), **video** |
| RAW handling | Extract the **embedded JPEG preview** for display. The RAW file is the downloadable original. |
| Video handling | MediaConvert transcodes to a **single 1080p H.264 MP4** plus a poster frame |
| Organization | **Albums (many-to-many) + tags**. One file can be in several albums without being stored twice. |
| v1 features | Bulk upload (resumable), EXIF parsing + sort by date taken, trash (30-day soft delete), download album as ZIP |
| API | API Gateway **HTTP API** + Lambda (Node.js/TypeScript), Cognito JWT authorizer |
| Region / budget | `ap-southeast-1`, target **< $10/month**, with an AWS Budget alarm |
| Environments | `dev` and `prod` CDK stages, S3 versioning on |
| Frontend | Next.js (App Router) + **Tailwind only**, hosted on Amplify Hosting with Git CI/CD |
| IaC | AWS CDK (TypeScript) |

---

## 2. Architecture

```
                    ┌────────────── Amplify Hosting (Next.js) ──────────────┐
  Browser ─────────▶│  UI, Cognito sign-in (aws-amplify Auth only)           │
     │              └────────────────────────────────────────────────────────┘
     │ JWT
     ├────────────▶ API Gateway HTTP API ──▶ Lambda handlers ──▶ DynamoDB (metadata)
     │                                            │
     │ presigned PUT (multipart)                  │ presign / sign URLs
     ├────────────▶ S3 bucket  originals/…  ◀─────┘
     │                 │   API async-invokes on upload complete / reprocess
     │                 ▼
     │          Processing Lambda (container: sharp + heic-decode + exiftool)
     │            ├─ image/RAW → thumb.webp, preview.webp, EXIF → DynamoDB
     │            └─ video     → MediaConvert job → mp4 + poster → DynamoDB
     │
     └────────────▶ CloudFront (signed URLs) ──▶ S3 derived/…   (view only)
                    S3 presigned GET (Content-Disposition) for original downloads
```

### Principles
- **Image bytes never pass through the API.** Uploads go straight to S3 with presigned URLs. Views go through CloudFront. Downloads use presigned S3 GETs.
- **DynamoDB is the source of truth for listings.** The app never lists S3 to build a page.
- **Derived files are disposable.** They can always be regenerated from the originals.
- **Everything is scoped to a user.** Every key and every DynamoDB partition includes `userId` (the Cognito `sub`).

---

## 3. Storage

### 3.1 S3 bucket (one per stage, private, Block Public Access on)

```
originals/{userId}/{mediaId}/{originalFilename}
derived/{userId}/{mediaId}/thumb.webp      # 400px short edge (square grid crops)
derived/{userId}/{mediaId}/preview.webp    # ~2048px long edge, lightbox
derived/{userId}/{mediaId}/video.mp4       # 1080p H.264/AAC
derived/{userId}/{mediaId}/poster.jpg      # video poster frame
zips/{userId}/{jobId}.zip                  # temporary album exports
```

**Lifecycle rules**
- `originals/`: move to **S3 Intelligent-Tiering** on day 0. It moves files to the cheaper Infrequent and Archive Instant Access tiers automatically, and there are no retrieval fees.
- `derived/`: S3 Standard (small files, read often).
- `zips/`: expire after 1 day.
- Noncurrent versions (from versioning): expire after 30 days.
- Abort incomplete multipart uploads after 7 days.

**CORS:** allow `PUT` (and reading the `ETag` header back) from the Amplify domain and `localhost:3000`.

### 3.2 CloudFront
- Origin: the S3 bucket via Origin Access Control, restricted to the `derived/*` path.
- Access: **CloudFront signed URLs** (RSA key pair, private key kept in SSM Parameter Store as a SecureString). The API signs one **custom policy per user** covering `https://{cdn}/{userId}/*` and appends the same signature to every URL in a response. The expiry is rounded up to a 6-hour window, so URLs stay identical across requests (browser cache hits) and are valid for 6–12 hours.
- Signed *cookies* are an option later if a custom domain is added. Cookies only work when the app and CloudFront share a parent domain.
- Cache policy: long TTL. Derived keys never change, so they can be cached for a long time.

### 3.3 DynamoDB (single table, on-demand)

| Entity | PK | SK | Notes |
|---|---|---|---|
| Media | `USER#{uid}` | `MEDIA#{mediaId}` | type (`image`/`raw`/`video`), status, s3 keys, size, mime, width/height, duration, exif{}, takenAt, tags[], albumIds[], deletedAt? |
| Album | `USER#{uid}` | `ALBUM#{albumId}` | name, description, coverMediaId, itemCount, createdAt |
| Album item | `ALBUM#{albumId}` | `ITEM#{takenAt}#{mediaId}` | Membership record, sorted by date |
| Tag item | `USER#{uid}#TAG#{tag}` | `ITEM#{takenAt}#{mediaId}` | Membership record |
| Share link | `SHARE#{token}` | `META` | albumId, ownerId, expiresAt (DynamoDB TTL), passwordHash? |
| Zip job | `USER#{uid}` | `ZIP#{jobId}` | status, s3Key, TTL 1 day |

**GSIs**
- `GSI1` (timeline): PK `USER#{uid}`, SK `TAKEN#{takenAt}#{mediaId}`. Only items that are *not* in the trash carry this key (sparse index).
- `GSI2` (trash): PK `USER#{uid}#TRASH`, SK `{deletedAt}#{mediaId}`. Present only when the item is in the trash.

`mediaId` is a ULID. `takenAt` is a UTC instant from EXIF (`DateTimeOriginal`, then other date tags). If EXIF is missing, the file's last-modified time is used. `takenAtOffset` holds minutes east of UTC where the photo was taken: from EXIF when recorded, otherwise the browser's offset at upload. Camera times with no time zone are stored as wall clock in UTC with offset 0. The UI always shows `takenAt + takenAtOffset`, so every viewer sees the time the camera showed.

---

## 4. Processing pipeline

### 4.1 Upload flow
1. The client asks `POST /uploads` with `{filename, size, mime}`. The API creates a Media record with `status=UPLOADING` and returns a `mediaId`.
   - Files ≤ 16 MB: a single presigned PUT URL.
   - Files > 16 MB: `CreateMultipartUpload` plus presigned part URLs (16 MB parts, more parts requested as needed).
2. The browser uploads directly to S3, with 3–4 files in parallel and progress shown per file. Upload state (`uploadId`, finished parts) is saved in IndexedDB, so an interrupted upload can **resume**.
3. The client calls `POST /uploads/{mediaId}/complete`, which completes the multipart upload and sets `status=PROCESSING`.
4. The API then **async-invokes the processing Lambda** with `{userId, mediaId}`. This replaced the original plan of S3 ObjectCreated events via EventBridge: with a single PUT, S3 fires its event *before* the client calls `complete`, so the processor would see a half-finished upload. `POST /media/{id}/reprocess` and `npm run reprocess -w infra -- <stage>` (backfill) use the same invoke.

### 4.2 Processing Lambda (container image, x86_64, 2 GB memory, 4 GB /tmp, max 10 concurrent)
Contains `sharp` (prebuilt libvips), `exiftool` (via `exiftool-vendored` + perl) and `heic-decode` (libheif WASM). Prebuilt sharp can't decode HEVC-based HEIC because of patent licensing, so HEIC goes through libheif. x86_64 avoids ARM emulation when building on most developer machines. Async retries: 2; final failures go to an SQS DLQ.
- **Image (JPEG/PNG/WebP/HEIC):** read EXIF, apply rotation, write `thumb.webp` and `preview.webp`, save width, height, and EXIF fields, set `status=READY` and `derived=[...]`. Derived files have no metadata (GPS is stripped).
- **RAW:** extract both `JpgFromRaw` and `PreviewImage` and use the larger. It then goes through the same steps as an image. EXIF, including orientation, is read from the RAW file itself.
- **Video (M5):** `ffprobe` reads duration, dimensions, and creation time. Then a **MediaConvert** job is submitted (1080p MP4 plus a frame capture for the poster). The record stays `status=TRANSCODING`. *Until M5, videos are marked READY with no derived files (download only).*
- Failures set `status=FAILED` with an error message, and the original is kept. The UI shows a retry option, which calls `POST /media/{id}/reprocess`.

### 4.3 MediaConvert completion
An EventBridge rule on `MediaConvert Job State Change` (COMPLETE/ERROR) runs a Lambda that sets the derived keys and `status=READY` or `FAILED`.

### 4.4 ZIP export
`POST /albums/{id}/zip` creates a ZipJob and invokes a zip Lambda asynchronously. That Lambda streams each original from S3 through `archiver` into an S3 multipart upload, which keeps memory use constant. The client polls `GET /zips/{jobId}` and then downloads with a presigned GET.
- Limit: Lambda can run for at most 15 minutes. The v1 cap is about **20 GB per ZIP**; the API rejects anything larger and suggests downloading in parts. Moving the job to Fargate is the fix if this becomes a problem.

### 4.5 Trash & purge
- Delete sets `deletedAt`, removes the GSI1 keys, and adds the GSI2 keys. Album and tag membership records stay so that a restore is lossless. Listing queries skip trashed items.
- A daily **EventBridge Scheduler** job runs a purge Lambda that permanently deletes items trashed more than 30 days ago: the S3 originals and derived files plus all DynamoDB records.
- `POST /media/{id}/restore` reverses a delete. "Empty trash" purges immediately.

---

## 5. API (HTTP API, JWT authorizer unless marked public)

| Method | Path | Purpose |
|---|---|---|
| POST | `/uploads` | Start an upload. Returns a presigned URL or multipart info. |
| POST | `/uploads/{mediaId}/parts` | Get more presigned part URLs |
| POST | `/uploads/{mediaId}/complete` | Complete the upload |
| GET | `/media?cursor=&type=&from=&to=` | Timeline (GSI1, newest first, page size 100) |
| GET | `/media/{id}` | Details, including signed preview/video URLs and EXIF |
| PATCH | `/media/{id}` | Update tags or takenAt |
| DELETE | `/media/{id}` | Move to trash |
| POST | `/media/{id}/restore` | Restore from trash |
| POST | `/media/{id}/reprocess` | Retry processing after a failure |
| GET | `/media/{id}/download` | Presigned GET for the original (`Content-Disposition: attachment`) |
| POST | `/media/batch` | Batch actions: delete, tag, add to or remove from an album |
| GET | `/trash?cursor=` | List trashed items |
| DELETE | `/trash` | Empty the trash |
| GET/POST | `/albums` | List or create albums |
| GET/PATCH/DELETE | `/albums/{id}` | Read, update, or delete an album (deleting an album does not delete its media) |
| GET | `/albums/{id}/items?cursor=` | Album contents |
| POST | `/albums/{id}/zip` | Start a ZIP export |
| GET | `/zips/{jobId}` | ZIP job status and download URL |
| GET | `/tags` / `/tags/{tag}/items` | Tag list and tag contents |
| POST/GET/DELETE | `/albums/{id}/shares` | Manage share links |
| GET | `/public/shares/{token}` *(public)* | Share metadata (whether a password is required) |
| POST | `/public/shares/{token}/items` *(public)* | Album items with signed URLs. The body carries the password if one is set. Rate-limited. |
| GET | `/me` | Profile and storage usage |

Every handler gets `userId` from the JWT `sub` and builds keys from it. Request bodies are never trusted to say whose data is being accessed.

---

## 6. Authentication

- Cognito User Pool with self sign-up **disabled**. The owner invites users by email using `AdminCreateUser`. In v1 this is done from the AWS console or CLI; an admin page is planned for v2.
- MFA: **optional**, TOTP (authenticator app). Users set it up on the Settings page. SMS is not used, to avoid SMS costs.
- An `admin` group for the owner. It is reserved for future admin pages.
- Frontend uses the `aws-amplify` v6 **Auth category only**, configured from the CDK outputs (user pool ID and client ID). Tokens are kept in the browser, and the API is called with `Authorization: Bearer <idToken|accessToken>`.
- Share links: the token is 128-bit random. The password is hashed with argon2/bcrypt. The public share endpoints are throttled at the API Gateway route level.

---

## 7. Frontend (Next.js App Router + Tailwind)

### Routes
| Route | Content |
|---|---|
| `/login` | Sign in, MFA challenge, forced password change on first login |
| `/` | Timeline: justified grid grouped by month, infinite scroll |
| `/albums`, `/albums/[id]` | Album grid and album contents |
| `/tags`, `/tags/[tag]` | Tags |
| `/trash` | Trash with restore and delete-forever actions |
| `/upload` (or a global drawer) | Drag-and-drop or file picker, upload queue with per-file progress, resume |
| `/settings` | MFA setup, profile, storage usage |
| `/s/[token]` | Public view of a shared album (no login) |

### Display
- **Grid:** `thumb.webp` only, with `loading="lazy"` and a virtualized list (e.g. `@tanstack/react-virtual`) so thousands of items stay smooth. The grid has 3 columns on mobile and 6–8 on desktop.
- **Lightbox:** `preview.webp`, with swipe on mobile and arrow keys on desktop, an EXIF info panel, and download and delete buttons. Videos play in a `<video>` element using `video.mp4` with `poster.jpg`.
- **Placeholders** while processing, with automatic refresh by polling items whose status is `PROCESSING` or `TRANSCODING`.
- **Multi-select** (long-press on mobile, shift-click on desktop) for batch tag, album, and delete actions.
- Signed URLs are valid for 6–12 hours. Refetching expired URLs on long-open tabs is planned for M7.
- Use plain `<img>` tags rather than `next/image`'s optimizer. Images are already resized, and the optimizer would add Amplify compute cost.

---

## 8. Infrastructure (CDK, TypeScript)

### Repo layout (npm workspaces)
```
/shared       @mypic/shared: domain types, DynamoDB/S3 key builders (TS source, used by services + web)
/infra        CDK app (bin/, lib/stacks/, scripts/, keys/)
/services     Lambda handlers (TypeScript) + processing container (Dockerfile)
/web          Next.js app
/docs         Specs and notes
```

### Stacks (per stage: `MyPic-dev-*`, `MyPic-prod-*`)
1. **AuthStack**: User Pool, app client, `admin` group
2. **StorageStack**: S3 bucket (versioning, lifecycle, CORS), DynamoDB table + GSIs, CloudFront distribution + key group
3. **ProcessingStack**: processing Lambda (container image), MediaConvert IAM role, EventBridge rules, completion Lambda, zip Lambda, daily purge schedule
4. **ApiStack**: HTTP API, JWT authorizer, route Lambdas, throttling
5. **OpsStack**: CloudWatch alarms for Lambda errors and DLQ depth, SNS email topic

Account-wide (not per stage): **BudgetStack** (`MyPic-Budget`), a $10/month cost budget that emails at 80% of actual spend and at a forecast of 100%. It is only created when deployed with `-c alertEmail=…`.

- Stage is chosen with `cdk deploy -c stage=dev|prod`.
- `prod` uses `RemovalPolicy.RETAIN` on the bucket and table. `dev` uses `DESTROY` with `autoDeleteObjects`.
- Stack outputs (API URL, user pool ID and client ID, CloudFront domain) are written to `web/.env.local` for local development and set as Amplify environment variables for the hosted app.
- Amplify Hosting app is connected to GitHub: the `main` branch deploys prod, and a `dev` branch deploys dev. It can be created manually or with CDK (`@aws-cdk/aws-amplify-alpha`). Starting manually is fine.

---

## 9. Cost estimate (ap-southeast-1, rough; verify with the AWS Pricing Calculator)

Assumes 300 GB of originals (RAW-heavy), about 30k items, 60 minutes of new video per month, and light traffic.

| Item | Est. / month |
|---|---|
| S3 originals in Intelligent-Tiering (most of the data ends up in Infrequent or Archive Instant Access tiers after 30–90 days) | ~$3–6 |
| S3 derived files (about 15 GB) plus requests | ~$0.50 |
| Intelligent-Tiering monitoring fee (30k objects) | ~$0.08 |
| MediaConvert, 60 min of 1080p | ~$1–2 |
| DynamoDB on-demand, Lambda, API Gateway | < $1 (mostly free tier) |
| CloudFront | ~$0 (1 TB/month always-free tier) |
| Cognito (fewer than 50k monthly active users) | $0 |
| Amplify Hosting (build minutes + SSR) | ~$0–1 |
| **Total** | **~$5–10** |

⚠️ **Storage is the main cost.** At about 1 TB of RAW files you will exceed $10/month even with tiering. The budget alarm will warn you before that happens.

---

## 10. Milestones

1. **M1 – Infra foundation:** monorepo, CDK Auth + Storage stacks deploy to `dev`, budget alarm.
2. **M2 – Upload + list:** upload API (single + multipart), basic timeline listing, Next.js login + grid running locally against `dev`.
3. **M3 – Processing:** container Lambda for images, HEIC, and RAW; EXIF; CloudFront signed URLs; lightbox.
4. **M4 – Organization:** albums, tags, batch actions, trash + purge.
5. **M5 – Video:** MediaConvert pipeline, video playback.
6. **M6 – Sharing + ZIP:** share links (expiry and password), public view, ZIP export.
7. **M7 – Ship:** Amplify Hosting CI/CD, `prod` stage, alarms, resumable upload polish.

---

## 11. Resolved questions

- **Domain:** use the default Amplify URL (`*.amplifyapp.com`) for now, so CloudFront uses signed URLs, not cookies. A custom domain can be added later.
- **Max file size:** 5 GB per file (`MAX_UPLOAD_BYTES` in `shared/`).
- **Per-user quota:** none for now. Show usage only.
- **GPS in public shares:** removed from derived images served through share links.

## 12. Still open (later versions)

- Duplicate detection (content hash on upload): v2.
- Map view from GPS: v2.
- Live Photos / Motion Photos: handled as a separate image and video in v1.
