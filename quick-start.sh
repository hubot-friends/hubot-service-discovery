#!/bin/bash
# filepath: quick-start.sh

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BOT_NAME="${1:-mybot}"
WORKER_NAME="${2:-worker-bot}"
DISCOVERY_PORT="${3:-3100}"
SERVER_INSTANCE_ID="${4:-server}"
WORKER_INSTANCE_ID="${5:-client-1}"

echo -e "${BLUE}🤖 Hubot Service Discovery Setup Script${NC}"
echo -e "${BLUE}======================================${NC}"
echo "Environment settings (or defaults):"
echo -e "Bot name: ${GREEN}${BOT_NAME}${NC}"
echo -e "Worker name: ${GREEN}${WORKER_NAME}${NC}"
echo -e "Discovery port: ${GREEN}${DISCOVERY_PORT}${NC}"
echo -e "Server instance ID: ${GREEN}${SERVER_INSTANCE_ID}${NC}"
echo -e "Worker instance ID: ${GREEN}${WORKER_INSTANCE_ID}${NC}"
echo ""
    
# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
echo -e "${YELLOW}📋 Checking prerequisites...${NC}"
if ! command_exists node; then
    echo -e "${RED}❌ Node.js is not installed. Please install Node.js first.${NC}"
    exit 1
fi

if ! command_exists npm; then
    echo -e "${RED}❌ npm is not installed. Please install npm first.${NC}"
    exit 1
fi

if ! command_exists npx; then
    echo -e "${RED}❌ npx is not available. Please update Node.js/npm.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Prerequisites check passed${NC}"
echo ""

# Function to create .env file
create_env_file() {
    local dir="$1"
    echo -e "${YELLOW}📝 Creating .env file in ${dir}...${NC}"
    
    if [ ! -f "${dir}/.env" ]; then
        read -p "Enter your Slack App Token: " slack_app_token
        read -p "Enter your Slack Bot Token: " slack_bot_token
        
        cat > "${dir}/.env" << EOF
HUBOT_SLACK_APP_TOKEN="${slack_app_token}"
HUBOT_SLACK_BOT_TOKEN="${slack_bot_token}"
HUBOT_NAME="${BOT_NAME}"
EOF
        echo -e "${GREEN}✅ .env file created${NC}"
    else
        echo -e "${YELLOW}⚠️  .env file already exists, skipping...${NC}"
    fi
}

# Function to setup server instance
setup_server() {
    read -p "Enter your Bot name: " BOT_NAME
    echo -e "${BLUE}🖥️  Setting up Server Instance (${BOT_NAME})...${NC}"
    echo ""
    
    # Create hubot instance
    if [ ! -d "${BOT_NAME}" ]; then
        echo -e "${YELLOW}📦 Creating hubot instance...${NC}"
        npx hubot --create "${BOT_NAME}"
        echo -e "${GREEN}✅ Hubot instance created${NC}"
    else
        echo -e "${YELLOW}⚠️  Directory ${BOT_NAME} already exists, skipping creation...${NC}"
    fi
    
    cd "${BOT_NAME}"
    
    # Install dependencies
    echo -e "${YELLOW}📦 Installing dependencies...${NC}"
    npm install @hubot-friends/hubot-service-discovery @hubot-friends/hubot-slack
    rm -Rf scripts
    echo -e "${GREEN}✅ Dependencies installed${NC}"
    
    # Create .env file
    create_env_file "."
    
    # Update external-scripts.json
    echo -e "${YELLOW}📝 Updating external-scripts.json...${NC}"
    cat > external-scripts.json << EOF
[
  "@hubot-friends/hubot-service-discovery/DiscoveryService.mjs"
]
EOF
    echo -e "${GREEN}✅ external-scripts.json updated${NC}"
    
    # Update package.json start script
    echo -e "${YELLOW}📝 Updating package.json start script...${NC}"
    
    # Create a temporary file with the updated package.json
    node -e "
const fs = require('fs')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
pkg.scripts = pkg.scripts || {}
pkg.scripts.start = 'HUBOT_DISCOVERY_PORT=${DISCOVERY_PORT} HUBOT_SERVICE_NAME=hubot HUBOT_INSTANCE_ID=${SERVER_INSTANCE_ID} node --env-file=.env node_modules/.bin/hubot -a @hubot-friends/hubot-slack'
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2))
"
    echo -e "${GREEN}✅ package.json start script updated${NC}"
    
    cd ..
    echo -e "${GREEN}✅ Server instance setup complete!${NC}"
    echo ""
}

# Function to setup worker instance
setup_worker() {
    echo -e "${BLUE}👷 Setting up Worker Instance (${WORKER_NAME})...${NC}"
    echo ""
    
    # Create hubot instance
    if [ ! -d "${WORKER_NAME}" ]; then
        echo -e "${YELLOW}📦 Creating worker hubot instance...${NC}"
        npx hubot --create "${WORKER_NAME}"
        echo -e "${GREEN}✅ Worker hubot instance created${NC}"
    else
        echo -e "${YELLOW}⚠️  Directory ${WORKER_NAME} already exists, skipping creation...${NC}"
    fi
    
    cd "${WORKER_NAME}"
    
    # Install dependencies
    echo -e "${YELLOW}📦 Installing dependencies...${NC}"
    npm install @hubot-friends/hubot-service-discovery
    echo -e "${GREEN}✅ Dependencies installed${NC}"
    
    # Update package.json start script
    echo -e "${YELLOW}📝 Updating package.json start script...${NC}"
    
    # Create a temporary file with the updated package.json
    node -e "
const fs = require('fs')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
pkg.scripts = pkg.scripts || {}
pkg.scripts.start = 'HUBOT_DISCOVERY_URL=ws://localhost:${DISCOVERY_PORT} HUBOT_SERVICE_NAME=hubot HUBOT_INSTANCE_ID=${WORKER_INSTANCE_ID} hubot -a @hubot-friends/hubot-service-discovery -n ${BOT_NAME}'
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2))
"
    echo -e "${GREEN}✅ package.json start script updated${NC}"
    
    cd ..
    echo -e "${GREEN}✅ Worker instance setup complete!${NC}"
    echo ""
}

# Function to display usage instructions
show_usage() {
    echo -e "${BLUE}🚀 Setup Complete!${NC}"
    echo -e "${BLUE}================${NC}"
    echo ""
    echo -e "${GREEN}To start the server instance:${NC}"
    echo -e "  cd ${BOT_NAME}"
    echo -e "  npm start"
    echo ""
    echo -e "${GREEN}To start the worker instance (in another terminal):${NC}"
    echo -e "  cd ${WORKER_NAME}"
    echo -e "  npm start"
    echo ""
    echo -e "${YELLOW}Message Flow:${NC}"
    echo -e "  User → Chat Provider → Server Hubot + Load Balance → Client Hubots"
    echo ""
    echo -e "${YELLOW}Configuration:${NC}"
    echo -e "  • Discovery Port: ${DISCOVERY_PORT}"
    echo -e "  • Service Name: hubot"
    echo -e "  • Server Instance ID: ${SERVER_INSTANCE_ID}"
    echo -e "  • Worker Instance ID: ${WORKER_INSTANCE_ID}"
    echo ""
    echo -e "${BLUE}💡 Tips:${NC}"
    echo -e "  • You can create multiple workers by running this script with different worker names"
    echo -e "  • Make sure to update HUBOT_DISCOVERY_URL if not running on localhost"
    echo -e "  • Check the .env files have your correct Slack tokens"
}

# Function to show help
show_help() {
    echo "Usage: $0 [BOT_NAME] [WORKER_NAME] [DISCOVERY_PORT] [SERVER_INSTANCE_ID] [WORKER_INSTANCE_ID]"
    echo ""
    echo "Arguments:"
    echo "  BOT_NAME           Name for the server bot instance (default: mybot)"
    echo "  WORKER_NAME        Name for the worker bot instance (default: worker-bot)"
    echo "  DISCOVERY_PORT     Port for service discovery (default: 3100)"
    echo "  SERVER_INSTANCE_ID Server instance identifier (default: server)"
    echo "  WORKER_INSTANCE_ID Worker instance identifier (default: client-1)"
    echo ""
    echo "Examples:"
    echo "  $0                                    # Use all defaults"
    echo "  $0 mybot worker-1                     # Custom bot and worker names"
    echo "  $0 chatbot worker-bot 3200            # Custom port"
    echo "  $0 mybot worker-1 3100 server client-2 # All custom values"
}

# Parse command line arguments
case "${1:-}" in
    -h|--help)
        show_help
        exit 0
        ;;
esac

# Main execution
echo -e "${YELLOW} Enter your Slack App and Bot tokens, and Bot name when prompted.${NC}"
echo -e "${YELLOW} Make sure you have created a Slack App with the necessary permissions.${NC}"
echo ""

echo -e "${YELLOW}🔍 This script will create:${NC}"
echo -e "  1. a Server instance with Slack adapter + Service Discovery"
echo -e "  2. a Worker instance with Service Discovery adapter"
echo ""

read -p "Continue? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Setup cancelled.${NC}"
    exit 0
fi

echo ""
# Go up one directory to avoid creating bots in this repo
cd ..

# Setup both instances
setup_server
setup_worker
show_usage

echo -e "${GREEN}🎉 All done! Happy botting!${NC}"