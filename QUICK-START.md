# Hubot Service Discovery - Quick Reference (Assuming your using @hubot-friends/hubot-slack)

## Installation

Assuming you've already create a Slack app for the bot and that the bot name is `mybot`.

### 1. Create a hubot instance

```sh
npx hubot --create mybot
cd mybot
npm install @hubot-friends/hubot-service-discovery @hubot-friends/hubot-slack
```

## Server Instance (Chat Provider + Service Discovery Script)

### 2. Secrets

Create a file called `.env` and add the folowing to it:

```sh
HUBOT_SLACK_APP_TOKEN="<the Slack app token you got from creating a Slack app>"
HUBOT_SLACK_BOT_TOKEN="<the Slack bot token>"
```

### 3. Add to external-scripts.json
```json
[
  "@hubot-friends/hubot-service-discovery/DiscoveryService.mjs"
]
```

### 4. Configure the start command

Add the following to the "start" scripts in `package.json` file:

```json
{
  "scripts": {
    "start": "HUBOT_DISCOVERY_PORT=3100 HUBOT_SERVICE_NAME=hubot HUBOT_INSTANCE_ID=server node --env-file=.env node_modules/.bin/hubot -a @hubot-friends/hubot-slack -n mybot",
  }
}
```

### 5. Start with your chat adapter

```sh
npm start
```

## Client Instance (Service Discovery Adapter)

### 1. Create a hubot instance (a "worker" bot instance)

```sh
npx hubot --create worker-bot
cd worker-bot
npm install @hubot-friends/hubot-service-discovery
```

### 2. Configure the start command

Add the following to the "start" scripts in `package.json` file:

**Note**: `localhost` assumes your running this on your local machine. It should be a routable name in your hosting environment.

**Note**: `mybot` should be the same name you gave the server instance bot above in the Server section of this doc.

```json
{
  "scripts": {
    "start": "HUBOT_DISCOVERY_URL=ws://localhost:3100 HUBOT_SERVICE_NAME=hubot HUBOT_INSTANCE_ID=client-1 hubot -a @hubot-friends/hubot-service-discovery -n mybot",
  }
}
```

## Message Flow
```
User → Chat Provider → Server Hubot + Load Balance → Client Hubots
```

The server receives messages from the chat provider and load balances them across healthy client instances for processing.
