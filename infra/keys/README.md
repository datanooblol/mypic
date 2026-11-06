CloudFront URL-signing public keys (`{stage}-public.pem`), one per deployment. These files are gitignored.
Run `npm run keys:dev` from the repo root to generate yours. The matching private key is stored only in SSM Parameter Store at `/mypic/{stage}/cloudfront/private-key`.
