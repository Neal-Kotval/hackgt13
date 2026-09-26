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
