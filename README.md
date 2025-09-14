# Hubot Service Discovery

**hubot-service-discovery** is a hubot service discovery service with built-in load balancing to horizontally scale Hubot instances.

## Hubot Worker

This module is a [Hubot Adapter](https://hubotio.github.io/hubot/adapters.html). If you npm install it, you would start a Hubot instance with `-a @hubot-friends/hubot-service-discovery` and it will connect to a Hubot Service Discovery Server, register itself, and listen for incoming messages. The term "Adapter" here is just the fact that this connection utlizes Hubot's Adapter design – technically speaking. So in this part of the setup, a Hubot Service Discovery Server is the message input and the Hubot Worker connects to it for it's source of messages.

At this point, there's no running Hubot Service Discovery Server, so this worker does nothing until a Hubot Service Discovery Server is started and getting messages from the Chat app. Referring to the right side of the diagram below, we've started a Hubot Worker # 1.

![Architecture](architecture-image.png)

## Hubot with Chat Adapter (Adapter here refers to the adapter that connects to the chat app e.g. Discord, Slack, MS Teams)

The next part of the design is the left side of the diagram above – the input.

This Hubot instance's role is the adapter to the chat platoform (e.g. Slack, MS Teams, Discord). You'll still start this instance with something like `hubot -a @hubot-friends/hubot-discord` because the chat platform is how users interact with Hubot – the input. But now, this Hubot instance won't have all you're command handling scripts; it'll have the [Hubot script](DiscoveryService.mjs) located in this package.

The steps to manually install this script is:

- `npm i @hubot-friends/hubot-service-discovery`
- Add `hubot-service-discovery/DiscoveryService.mjs` to your `external-scripts.json` file

    ```json
    [
        "hubot-service-discovery/DiscoveryService.mjs"
    ]
    ```

If you want to start from scratch:

- `cd folder-to-have-mybot` Probably use a different folder name
- `npx hubot --create myhubot --adapter @hubot-friends/hubot-discord` Pick your adapter. Just using Discord as an example here.
- `cd myhubot`
- `npm i @hubot-friends/hubot-service-discovery`
- Add `hubot-service-discovery/DiscoveryService.mjs` to your `external-scripts.json` file

    ```json
    [
        "hubot-service-discovery/DiscoveryService.mjs"
    ]
    ```

Now when you start the Hubot Adapter instance as shown in the diagram above, incoming chat messages will be routed through load balancing logic which picks a Hubot Worker to send the message to. This lets you scale Hubot horizontally across processes or servers while keeping the UX seamless.

# How do I start the Discovery Service Server?

This is the Hubot that has the chat app adapter (e.g. `@hubot-friends/hubot-discord`).

```sh
hubot -a @hubot-friends/hubot-discord -n ${NAME_OF_YOUR_HUBOT}
```

The key is that your `external-scripts.json` file contains the `DiscoveryService.mjs` script like so:

```json
[
    "hubot-service-discovery/DiscoveryService.mjs"
]
```

It's a little weird because this is the **server** but it's loaded as a Hubot script. That's because it's just intercepting messages from the Hubot Adapter that's connected to the chat app.

# How do I start a Hubot Worker?

My assumption is that this is a Git repo that contains all of your Hubot scripts (i.e. in a folder called scripts).

```sh
HUBOT_DISCOVERY_URL=ws://localhost:3100 HUBOT_SERVICE_NAME=hubot HUBOT_INSTANCE_ID=worker-1 HUBOT_HEARTBEAT_INTERVAL=15000 npm start -- --name ${NAME_OF_YOUR_HUBOT}
```

`NAME_OF_YOUR_HUBOT` is the name you gave your Hubot instance that is connected to the chat app.

Say you're building a Discord bot with Hubot. You have a start task in your `package.json` file like so:

```json
{
    "scripts": {
        "start": "hubot --adapter @hubot-friends/hubot-discord"
    }
}
```

Starting the instance with: 

```sh
HUBOT_DISCOVERY_URL=ws://localhost:3100 HUBOT_SERVICE_NAME=hubot HUBOT_INSTANCE_ID=worker-1 HUBOT_HEARTBEAT_INTERVAL=15000 npm start -- --name ${NAME_OF_YOUR_HUBOT}
```

sets the name of your Hubot. So when you're on Discord and you want to send your Hubot a message, you'd do it like (where name is **mybot** in this example), `@mybot help`.

You might have the name set in the start script like so:

```json
{
    "scripts": {
        "start": "hubot --adapter @hubot-friends/hubot-discord --name mybot"
    }
}
```

In which case, you wouldn't need to include the `-- --name ${NAME_OF_YOUR_HUBOT}` becasue it's already set in the start task.


# What are the environment variables for the Discovery Service Server?

- `HUBOT_SERVICE_NAME` - Service name for registration (default: 'hubot')
- `HUBOT_INSTANCE_ID` - Unique instance identifier (default: generated as hubot-<Date.now()>)
- `HUBOT_HOST` - Host address for this instance (default: 'localhost')
- `HUBOT_PORT` - Port for this instance (default: 8080)
- `HUBOT_HEARTBEAT_INTERVAL` - Heartbeat interval in ms (default: 15000)
- `HUBOT_DISCOVERY_PORT` - Port for the discovery server (default: 3100)
- `HUBOT_DISCOVERY_STORAGE` - Storage directory for event store (default: ./data)
- `HUBOT_DISCOVERY_TIMEOUT` - Heartbeat timeout in ms (default: 30000)
- `HUBOT_LB_STRATEGY` - Load balancing strategy: `round-robin`, `random`, `least-connections` (default: `round-robin`)

# What are the environment variables for the Hubot Worker?

- `HUBOT_DISCOVERY_URL` - URL of discovery server to connect to (e.g., 'ws://discovery-server:3100')
- `HUBOT_INSTANCE_ID` - Unique instance identifier (default: hubot-{Date.now()})
- `HUBOT_HOST` - Hostname (default: localhost)
- `HUBOT_PORT` - Port that the http server binds to (default: 8080)

