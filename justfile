# Start the local development server with `just`.
default: dev

# Install dependencies and create a local environment file if needed.
setup:
    npm install
    @if [ ! -e .env.local ]; then cp .env.example .env.local; fi

# Run the development server on 127.0.0.1:3000.
dev:
    npm run dev

# Run the development server with the selected Doppler config.
dev-doppler:
    doppler run -- npm run dev

# Preview local frontend against the shared AWS backend on port 3001.
dev-aws:
    doppler run --project hackgt --config dev -- npm run dev:aws

# Initialize authentication with the selected Doppler config.
auth-setup-doppler:
    doppler run -- npm run auth:setup

# Create a production build.
build:
    npm run build

# Serve an existing production build on 127.0.0.1:3000.
start:
    npm run start

# Check TypeScript types.
check:
    npm run check

# Run backend tests.
test:
    npm test

# Check design tokens.
tokens:
    npm run tokens:check

# Run all repository checks and create a production build.
verify: check test tokens build

# Install desktop package dependencies once.
desktop-setup:
    npm --prefix desktop install
    @if [ ! -e desktop/.env ]; then cp desktop/.env.example desktop/.env; fi

# Launch the desktop chat shell (Electron + Vite).
desktop:
    npm --prefix desktop run dev

# Launch desktop against the shared AGENTCLOUD_URL in Doppler dev.
desktop-doppler:
    doppler run -- npm --prefix desktop run dev

# Launch desktop with docked DevTools (AGENTCLOUD_DESKTOP_DEVTOOLS=1).
desktop-devtools:
    AGENTCLOUD_DESKTOP_DEVTOOLS=1 npm --prefix desktop run dev

# Typecheck the desktop package.
desktop-check:
    npm --prefix desktop run check

# Run desktop unit tests.
desktop-test:
    npm --prefix desktop test

# Production-build the desktop package.
desktop-build:
    npm --prefix desktop run build

# Typecheck, token-check desktop surfaces, test, and build the desktop package.
desktop-verify: desktop-check desktop-tokens desktop-test desktop-build

# Enforce design tokens on desktop CSS/TSX (same contract as web).
desktop-tokens:
    npm run tokens:check

# Run the isolated backend simulation (no cloud credentials or resources).
sim-up:
    docker compose up --build --detach --wait

# Stop containers while retaining local accounts and project data.
sim-down:
    docker compose down

# Show container health and the loopback port used by the simulation.
sim-status:
    docker compose ps

# Follow recent backend logs.
sim-logs:
    docker compose logs --tail=100 --follow backend

# Probe the running backend without creating an account or project.
sim-check:
    curl --fail --silent --show-error --output /dev/null http://127.0.0.1:${AGENTCLOUD_SIM_PORT:-3002}/sign-in

# Local frontend on port 3001, connected only to the Docker backend.
dev-docker:
    npm run dev:docker

# Build the local Docker sandbox image used by the docker-local worker.
sandbox-image:
    docker build --tag agentcloud-sandbox:dev infra/sandbox

# Run the docker-local run-box worker against the same local database as `just dev`.
worker-docker:
    node --env-file-if-exists=.env.local scripts/run-box-worker.mjs --loop docker-local

# Supervised local Runpod test (RUNPOD_SETUP.md). RUNPOD_API_KEY comes from Doppler
# project hackgt, config dev. Doppler access is scoped per directory: run `doppler setup`
# here, or point AGENTCLOUD_DOPPLER_SCOPE at a directory that already has access.
doppler_scope := env("AGENTCLOUD_DOPPLER_SCOPE", justfile_directory())
runpod_doppler := "doppler run --scope '" + doppler_scope + "' --project hackgt --config dev --"
# Operator SSH key for local Runpod tests; kept outside the repository.
runpod_local_dir := env("AGENTCLOUD_RUNPOD_LOCAL_DIR", home_directory() / ".agentcloud-runpod-local")

# Read-only: confirm Doppler supplies the Runpod key by counting Pods. Creates nothing.
runpod-local-check:
    {{runpod_doppler}} node --env-file-if-exists=.env.local scripts/runpod-local-watchdog.mjs --check

# Local cleanup guard: terminates managed Pods after `minutes` (default 15, max 120).
runpod-watchdog minutes="15":
    AGENTCLOUD_RUNPOD_LOCAL_MAX_MINUTES={{minutes}} {{runpod_doppler}} node --env-file-if-exists=.env.local scripts/runpod-local-watchdog.mjs

# Create the local operator SSH key if absent. Prints only the public key path.
runpod-local-key:
    @mkdir -p "{{runpod_local_dir}}" && chmod 700 "{{runpod_local_dir}}"
    @if [ ! -f "{{runpod_local_dir}}/id_ed25519" ]; then ssh-keygen -q -t ed25519 -N "" -C agentcloud-runpod-local -f "{{runpod_local_dir}}/id_ed25519" && echo "Created operator key. Add {{runpod_local_dir}}/id_ed25519.pub to Runpod."; fi

# Runpod worker in local mode. Allocates only while `just runpod-watchdog` is running.
worker-runpod-local: runpod-local-key
    AGENTCLOUD_RUNPOD_LOCAL=1 AGENTCLOUD_RUNPOD_SSH_KEY_FILE="{{runpod_local_dir}}/id_ed25519" AGENTCLOUD_RUNPOD_SSH_PUBLIC_KEY="$(cat "{{runpod_local_dir}}/id_ed25519.pub")" AGENTCLOUD_RUNPOD_KNOWN_HOSTS_FILE="{{runpod_local_dir}}/known_hosts" {{runpod_doppler}} node --env-file-if-exists=.env.local scripts/run-box-worker.mjs --loop runpod

# Validate Terraform without connecting to a remote state backend or applying.
terraform-validate:
    terraform -chdir=infra/local init -backend=false
    terraform -chdir=infra/local validate
