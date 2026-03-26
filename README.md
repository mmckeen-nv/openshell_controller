# OpenShell/NemoClaw Dashboard

A web-based control plane dashboard for managing OpenShell and NemoClaw instances, with live telemetry and one-click actions.

## Features

- **Live Telemetry**: Real-time CPU, memory, disk, and GPU monitoring
- **One-Click Actions**: Quick actions to start/stop sandbox, create NemoClaw instances, and switch models
- **Configuration Management**: Update OpenShell, NemoClaw, and Ollama settings
- **Model Switcher**: Select and switch between available Ollama models
- **Local-first**: Runs entirely on your local machine

## Installation

1. Navigate to the project directory:
```bash
cd nemo-shell-dashboard
```

2. Install dependencies:
```bash
npm install
```

## Running the Dashboard

1. Start the development server:
```bash
npm run dev
```

2. Open your browser and navigate to:
```
http://localhost:3000
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