# OpenShell/NemoClaw Dashboard

A web-based control plane dashboard for managing OpenShell and NemoClaw instances, with live telemetry and one-click actions.

## Features

- **Live Telemetry**: Real-time CPU, memory, disk, and GPU monitoring
- **One-Click Actions**: Quick actions to start/stop sandbox, create NemoClaw instances, and switch models
- **Configuration Management**: Update OpenShell, NemoClaw, and Ollama settings
- **Model Switcher**: Select and switch between available Ollama models
- **Local-first**: Runs entirely on your local machine

## Installation

### Quick Install (Recommended)

Run the installer script which checks prerequisites and sets up everything:

```bash
./install.sh
```

The installer will:
- ✅ Verify Node.js, npm, and Docker are installed
- ✅ Check that your OpenShell-Mark container is running
- ✅ Install npm dependencies
- ✅ Build the dashboard
- ✅ Create `.env.local` configuration file

### Manual Install

1. Navigate to the project directory:
```bash
cd nemo-shell-dashboard
```

2. Install dependencies:
```bash
npm install
```

## Prerequisites

- **Node.js** 18+ 
- **npm** 9+
- **Docker** (Docker Desktop on Mac, or native Docker on Linux)
- **OpenShell-Mark fork running**: `ghcr.io/nvidia/openshell/cluster:dev`

## Running the Dashboard

After running `./install.sh`:

1. Start the development server:
```bash
npm run dev
```

2. Open your browser and navigate to:
```
http://localhost:3000
```

> **Important**: Make sure your OpenShell-Mark container is running before starting the dashboard!

### On Mac
```bash
# Start OpenShell first
/Applications/Docker.app/Contents/Resources/bin/docker run -d --name openshell-cluster -p 8080:30051 ghcr.io/nvidia/openshell/cluster:dev

# Then start the dashboard
npm run dev
```

### On Linux
```bash
# Start OpenShell first
docker run -d --name openshell-cluster -p 8080:30051 ghcr.io/nvidia/openshell/cluster:dev

# Then start the dashboard
npm run dev
```

## Configuration

The dashboard will attempt to connect to:

- **OpenShell**: `http://localhost:8080`
- **Ollama**: `http://localhost:11434`

You can update these URLs in the configuration panel at the top of the dashboard.

## API Endpoints

The dashboard provides the following API endpoints (all mocked for development):

- `GET /api/telemetry` - Get system telemetry
- `GET /api/config/openshell` - Get OpenShell configuration
- `POST /api/config/openshell` - Update OpenShell configuration
- `GET /api/config/nemoclaw` - Get NemoClaw configuration
- `POST /api/config/nemoclaw` - Update NemoClaw configuration
- `GET /api/config/ollama` - Get Ollama configuration
- `POST /api/config/ollama` - Update Ollama configuration
- `POST /api/actions/sandbox-start` - Start the sandbox
- `POST /api/actions/sandbox-stop` - Stop the sandbox
- `POST /api/actions/nemoclaw-create` - Create a NemoClaw instance
- `POST /api/actions/model-switch` - Switch to a different model

## Development

This project uses:
- **Next.js 14** - React framework with App Router
- **TypeScript** - Type safety
- **Tailwind CSS** - Utility-first styling
- **React Use** - Custom hooks
- **Zustand** - State management
- **Axios** - HTTP client

## Production Build

Build the project for production:
```bash
npm run build
npm start
```

## Notes

- This is a development prototype. In production, you'll need to connect to real OpenShell and Ollama APIs.
- All API endpoints are currently mocked for demonstration purposes.
- Telemetry data is randomly generated for testing purposes.

## License

MIT