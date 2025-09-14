# Hubot Service Discovery - Quick Reference

## Installation
```sh
npm install @hubot-friends/hubot-service-discovery
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
HUBOT_DISCOVERY_PORT=3100 HUBOT_SERVICE_NAME=hubot HUBOT_INSTANCE_ID=server hubot -a @hubot-friends/hubot-slack -n mybot
```

## Client Instance (Service Discovery Adapter)

### Start with service discovery adapter
```sh
HUBOT_DISCOVERY_URL=ws://server-host:3100 HUBOT_SERVICE_NAME=hubot HUBOT_INSTANCE_ID=client-1 hubot -a @hubot-friends/hubot-service-discovery  -n mybot
```

## Complete Example

### Terminal 1 - Server
```sh
echo '["hubot-service-discovery/DiscoveryService.mjs"]' > external-scripts.json

HUBOT_DISCOVERY_PORT=3100 HUBOT_SERVICE_NAME=hubot HUBOT_INSTANCE_ID=server hubot -a @hubot-friends/hubot-slack -n mybot
```

### Terminal 2 - Client 1
```sh
HUBOT_DISCOVERY_URL=ws://localhost:3100 HUBOT_SERVICE_NAME=hubot HUBOT_INSTANCE_ID=client-1 HUBOT_PORT=8081 hubot -a @hubot-friends/hubot-service-discovery -n mybot
```

### Terminal 3 - Client 2
```sh
HUBOT_DISCOVERY_URL=ws://localhost:3100 HUBOT_SERVICE_NAME=hubot HUBOT_INSTANCE_ID=client-2 HUBOT_PORT=8082 hubot -a @hubot-friends/hubot-service-discovery -n mybot
```

## Available Commands (on server instance)
- `@mybot discover services` - Show all registered services
- `@mybot discovery status` - Show service discovery status
- `@mybot help` - Displays all of the help commands that this bot knows about.
- `@mybot help <query>` - Displays all help commands that match <query>.
- `@mybot lb reset` - Reset round-robin counter
- `@mybot lb strategy <strategy>` - Change load balancing strategy
- `@mybot load balancer status` - Show load balancer statistics
- `@mybot test routing [message]` - Test message routing

## Message Flow
```
User → Chat Provider → Server Hubot + Load Balance → Client Hubots
```

The server receives messages from the chat provider and load balances them across healthy client instances for processing.
