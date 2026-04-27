# Quick Start Guide

## Installation & Setup

1. **Navigate to project directory:**
```bash
cd /path/to/nemoclaw-dashboard
```

2. **Install dependencies:**
```bash
npm install
```

3. **Start the development server:**
```bash
npm run dev
```

4. **Open your browser:**
```
http://localhost:3000
```

## What You'll See

- **Configuration Panel** at the top - set your OpenShell and Ollama URLs
- **Telemetry Cards** - CPU, memory, disk, and GPU usage (updates every 3 seconds)
- **One-Click Actions** - Start Sandbox, Stop Sandbox, Create Instance, Switch Model buttons
- **Model Switcher** - Dropdown to select Ollama models
- **Configuration Panels** - View settings for OpenShell, NemoClaw, and Ollama

## Testing the Dashboard

### Test 1: Verify Dashboard Loads
1. Open `http://localhost:3000`
2. All sections should render without errors
3. Telemetry should show values (randomly generated)

### Test 2: Configuration Panel
1. Edit the OpenShell URL field
2. Edit the Ollama URL field
3. Settings are saved to localStorage (persists on refresh)

### Test 3: One-Click Actions
1. Click "Start Sandbox"
2. Click "Stop Sandbox"
3. Click "Create Instance"
4. Click "Switch Model"
5. Check that status messages appear

### Test 4: Model Switcher
1. Select a different model from the dropdown
2. Click "Switch Model"
3. Verify success message

### Test 5: Telemetry Updates
1. Wait 3 seconds
2. Telemetry values should update automatically
3. No console errors should appear

## Troubleshooting

### Dashboard won't load
- Check if port 3000 is already in use: `lsof -ti:3000`
- Kill process: `kill -9 $(lsof -ti:3000)`
- Restart the server

### API endpoints returning errors
- This is expected - endpoints are mocked for development
- Check browser console for specific errors
- No real connection to OpenShell/Ollama is required

### Dependencies not installing
- Make sure you're running Node.js 18 or later
- Clear npm cache: `npm cache clean --force`
- Try reinstalling: `rm -rf node_modules package-lock.json && npm install`

## Next Steps (Production)

To make this production-ready:

1. Replace mock API routes with real API calls to OpenShell (port 8080) and Ollama (port 11434)
2. Add authentication to API routes
3. Implement proper error handling
4. Add loading states and skeletons
5. Add dark mode toggle
6. Add more detailed telemetry charts
7. Add deployment configuration (Docker, Vercel, etc.)

## Support

For issues or questions:
- Check the main README.md
- Review API route files for endpoint details
- Check browser console for errors
