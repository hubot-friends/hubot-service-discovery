# Hubot Service Discovery - Quick Reference

## Installation
```sh
npm install hubot-service-discovery
```

## Server Instance (Chat Provider + Service Discovery Script)

### 1. Add to external-scripts.json
```json
[
  "hubot-service-discovery/DiscoveryService.mjs"
]
```

### 2. Start with your chat adapter
```sh
HUBOT_DISCOVERY_PORT=3100 \
HUBOT_SERVICE_NAME=hubot \
HUBOT_INSTANCE_ID=server \
hubot -a slack
```

## Client Instance (Service Discovery Adapter)

### Start with service discovery adapter
```sh
HUBOT_DISCOVERY_URL=ws://server-host:3100 \
HUBOT_SERVICE_NAME=hubot \
HUBOT_INSTANCE_ID=client-1 \
hubot -a hubot-service-discovery
```

## Complete Example

### Terminal 1 - Server
```sh
echo '["hubot-service-discovery/DiscoveryService.mjs"]' > external-scripts.json

HUBOT_DISCOVERY_PORT=3100 \
HUBOT_SERVICE_NAME=hubot \
HUBOT_INSTANCE_ID=server \
hubot -a slack
```

### Terminal 2 - Client 1
```sh
HUBOT_DISCOVERY_URL=ws://localhost:3100 \
HUBOT_SERVICE_NAME=hubot \
HUBOT_INSTANCE_ID=client-1 \
HUBOT_PORT=8081 \
hubot -a hubot-service-discovery
```

### Terminal 3 - Client 2
```sh
HUBOT_DISCOVERY_URL=ws://localhost:3100 \
HUBOT_SERVICE_NAME=hubot \
HUBOT_INSTANCE_ID=client-2 \
HUBOT_PORT=8082 \
hubot -a hubot-service-discovery
```

## Available Commands (on server instance)
- `hubot discover services`
- `hubot discover hubots` 
- `hubot discovery status`
- `hubot brain peers`

## Message Flow
```
User → Chat Provider → Server Hubot → Load Balance → Client Hubots
```

The server receives messages from the chat provider and distributes them across healthy client instances for processing.
