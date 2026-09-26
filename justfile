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

# Validate Terraform without connecting to a remote state backend or applying.
terraform-validate:
    terraform -chdir=infra/local init -backend=false
    terraform -chdir=infra/local validate
