#!/bin/bash
# NemoClaw Dashboard Installer
# Installs and configures the OpenShell/NemoClaw control dashboard

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== NemoClaw Dashboard Installer ===${NC}"

# Check for required tools
check_command() {
    if ! command -v $1 &> /dev/null; then
        echo -e "${RED}Error: $1 is required but not installed.${NC}"
        exit 1
    fi
}

check_command node
check_command npm
check_command docker

# Check if running on Mac or Linux
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo -e "${YELLOW}Detected macOS${NC}"
    DOCKER_CMD="/Applications/Docker.app/Contents/Resources/bin/docker"
    OPEN_SHELL_NS="agent-sandbox-system"
else
    echo -e "${YELLOW}Detected Linux${NC}"
    DOCKER_CMD="docker"
    OPEN_SHELL_NS="agent-sandbox-system"
fi

# Check if Docker is running
echo -e "${YELLOW}Checking Docker...${NC}"
if ! $DOCKER_CMD ps &> /dev/null; then
    echo -e "${RED}Error: Docker is not running.${NC}"
    echo "Please start Docker Desktop and try again."
    exit 1
fi

# Check if OpenShell container is running
echo -e "${YELLOW}Checking OpenShell cluster...${NC}"
if ! $DOCKER_CMD ps | grep -q openshell; then
    echo -e "${RED}Error: OpenShell cluster container not found.${NC}"
    echo "Please start your OpenShell-Mark fork first:"
    echo "  $DOCKER_CMD run -d --name openshell-cluster -p 8080:30051 ghcr.io/nvidia/openshell/cluster:dev"
    exit 1
fi

# Install dependencies
echo -e "${GREEN}Installing dependencies...${NC}"
npm install

# Build the dashboard
echo -e "${GREEN}Building dashboard...${NC}"
npm run build

# Configure environment
if [ ! -f .env.local ]; then
    echo -e "${YELLOW}Creating .env.local...${NC}"
    cat > .env.local <<EOF
# NemoClaw Dashboard Configuration
# OpenShell/Kubernetes namespace to monitor
NEXT_PUBLIC_KUBERNETES_NAMESPACE=agent-sandbox-system

# Docker container name running OpenShell
OPEN_SHELL_CONTAINER=openshell-cluster-openshell

# Dashboard port
NEXT_PUBLIC_DASHBOARD_PORT=3000

# API endpoints
NEXT_PUBLIC_API_BASE=/api

# Enable Create/Destroy operations
NEXT_PUBLIC_ENABLE_SANDBOX_OPERATIONS=true
EOF
    echo -e "${GREEN}Created .env.local - review and customize if needed${NC}"
fi

# Configure SSH for GitHub if needed
if [ -f ~/.ssh/github ]; then
    echo -e "${GREEN}SSH key found - ready for GitHub operations${NC}"
else
    echo -e "${YELLOW}No GitHub SSH key found. Add one if you want to push to GitHub.${NC}"
fi

echo ""
echo -e "${GREEN}=== Installation Complete ===${NC}"
echo ""
echo "To start the dashboard:"
echo "  npm run dev"
echo ""
echo "Then open: http://localhost:3000"
echo ""
echo "The dashboard will connect to your running OpenShell cluster and show:"
echo "  - Active sandboxes from $OPEN_SHELL_NS namespace"
echo "  - Real-time telemetry (CPU, memory, disk)"
echo "  - Create/Destroy controls (with confirmation)"
echo ""
echo "Make sure your OpenShell-Mark fork is running before starting the dashboard!"
