# StellarYield

> Notice: the original Vercel domain submitted during Drips Wave review was claimed by a squatter. The current live deployment is [stellaryield.vercel.app](https://stellaryield.vercel.app).

StellarYield is a Stellar-native DeFi dashboard and automated vault project. The repository includes a Vite frontend in `client/`, an Express backend in `server/`, and Soroban smart contracts in `contracts/`.

## Repository Layout

- `client/` - React + Vite frontend
- `server/` - Node.js + Express backend
- `contracts/` - Soroban smart contracts and Rust workspace
- `docs/` - contributor and release documentation
- `.github/workflows/ci.yml` - pull request validation workflow

## Getting Started

### Prerequisites

- Node.js 20+
- npm 10+
- Rust stable toolchain
- Soroban CLI for contract work

### Clone the Repository

```bash
git clone https://github.com/YOUR_GITHUB_NAME/StellarYield.git
cd StellarYield
```

### Frontend Setup

```bash
cd client
npm ci
cp .env.example .env.local
npm run dev
```

The frontend runs on `http://localhost:5173`.

### Backend Setup

```bash
cd server
npm ci
cp .env.example .env
npm run dev
```

The backend runs on `http://localhost:3001`.

#### Environment Variables

- `STELLAR_HORIZON_TIMEOUT_MS`: Timeout for Horizon API calls in milliseconds (default: `10000`)
- `SOROBAN_RPC_TIMEOUT_MS`: Timeout for Soroban RPC API calls in milliseconds (default: `10000`)
The example env files document required and optional values. Keep real secrets
out of git; frontend values must be public `VITE_` values only.

### API Documentation

The backend provides OpenAPI documentation:

- **Interactive Swagger UI**: http://localhost:3001/api/openapi/docs
- **Raw OpenAPI spec (YAML)**: http://localhost:3001/api/openapi

These are automatically available when the backend is running. The Swagger UI provides a visual, interactive interface to explore all API endpoints, request parameters, and response schemas.

### Contract Verification

```bash
cd contracts
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## Verification Commands

### Client

```bash
cd client
npm run lint
npm run build
npm run test
```

### Server

```bash
cd server
npm run lint
npm run build
npm test
```

### Contracts

```bash
cd contracts
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

### README Verification

The CI workflow also checks that the documented setup and verification commands in this README stay in sync with the repo:

```bash
node scripts/verify-readme-commands.js
```

## CI Failure Artifacts

When the pull request workflow fails, GitHub Actions uploads frontend failure artifacts and contract test logs for a short retention window. Open the failed workflow run in the GitHub Actions tab and look for the **Artifacts** section near the bottom of the run summary.

## Contributor and Release Docs

- [Contributing Guide](./CONTRIBUTING.md)
- [Pre-commit Formatting and Verification Guide](./docs/contributor-guide.md)
- [Release Checklist](./docs/release-checklist.md)

---

## ✅ Post-deploy smoke test

After merge/deploy, you can quickly verify the public app + API are reachable:

```bash
# Unix/Linux/macOS (Bash)
npm run smoke-test

# Windows/Cross-platform (Node.js)
npm run smoke-test:node
```

### Configuration

Override targets via environment variables:

```bash
# Unix/Linux/macOS
FRONTEND_URL="https://stellaryield.vercel.app" \
BACKEND_URL="https://your-backend.example.com" \
npm run smoke-test

# Windows PowerShell
$env:FRONTEND_URL="https://stellaryield.vercel.app"
$env:BACKEND_URL="https://your-backend.example.com"
npm run smoke-test:node

# Windows Command Prompt
set FRONTEND_URL=https://stellaryield.vercel.app
set BACKEND_URL=https://your-backend.example.com
npm run smoke-test:node
```

Optional path overrides:

- `BACKEND_HEALTH_PATH` (default: `/api/health`)
- `BACKEND_YIELDS_PATH` (default: `/api/yields`)
- `FRONTEND_ASSET_PATH` (default: `/favicon.svg`)

### CI Usage

Both smoke test variants support the same environment variables and produce identical output. The Node.js version (`smoke-test:node`) is recommended for CI environments and Windows contributors as it has no Bash dependency.

StellarYield is participating in the Stellar Wave Program via Drips. Contributors can pick up open issues, submit focused pull requests, and validate their work locally with the commands above before opening a PR.
