# Image-processing Lambda. Build context: services/processing (dist/ is produced by
# esbuild during `cdk synth`, see infra/lib/stacks/processing-stack.ts).
FROM public.ecr.aws/lambda/nodejs:22

# exiftool-vendored runs ExifTool (Perl); batch-cluster uses `ps` to supervise it.
RUN dnf install -y perl procps-ng && dnf clean all

WORKDIR ${LAMBDA_TASK_ROOT}
COPY package.json ./
# Installs Linux builds of sharp (libvips), exiftool-vendored.pl and libheif (WASM).
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY dist/ ./
CMD ["index.handler"]
