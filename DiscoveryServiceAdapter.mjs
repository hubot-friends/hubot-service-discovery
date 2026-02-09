import { Adapter, TextMessage } from 'hubot'
import DiscoveryServiceClient from './lib/DiscoveryServiceClient.mjs'

function serializeError(error) {
  if (error.name && error.message && error.stack) {
    return `${error.name}: ${error.message}\n${error.stack}`
  }
  if (error.message && error.stack) {
    return `${error.message}\n${error.stack}`
  }
  return error
}

export default class DiscoveryServiceAdapter extends Adapter {
  constructor(robot) {
    super(robot)
    
    // Required configuration
    this.discoveryUrl = process.env.HUBOT_DISCOVERY_URL
    if (!this.discoveryUrl) {
      throw new Error('HUBOT_DISCOVERY_URL is required for service discovery adapter')
    }
    
    this.serviceName = process.env.HUBOT_SERVICE_NAME || 'hubot'
    this.group = process.env.HUBOT_SERVICE_GROUP || 'hubot-group'
    this.instanceId = process.env.HUBOT_INSTANCE_ID || `hubot-${Date.now()}`
    this.host = process.env.HUBOT_HOST || 'localhost'
    this.port = parseInt(process.env.HUBOT_PORT || process.env.PORT || 8080)

    // Initialize client
    this.client = new DiscoveryServiceClient(
      this.discoveryUrl,
      this.serviceName,
      this.instanceId,
      {
        host: this.host,
        port: this.port,
        headers: process.env.HUBOT_DISCOVERY_HEADERS ? JSON.parse(process.env.HUBOT_DISCOVERY_HEADERS) : {},
        heartbeatInterval: parseInt(process.env.HUBOT_HEARTBEAT_INTERVAL || 15000),
        token: process.env.HUBOT_DISCOVERY_TOKEN || null, // Authentication token
        autoReconnect: true, // Enable auto-reconnection
        reconnectInterval: parseInt(process.env.HUBOT_DISCOVERY_RECONNECT_INTERVAL || 5000),
        maxReconnectAttempts: parseInt(process.env.HUBOT_DISCOVERY_MAX_RECONNECT_ATTEMPTS || 0),
        metadata: {
          adapter: 'service-discovery',
          version: process.env.npm_package_version || '1.0.0'
        }
      }
    )
    
    // Bind event handlers
    this.setupEventHandlers()
  }

  setupEventHandlers() {
    this.client.on('connected', () => {
      this.robot.logger.info(`Service discovery adapter connected to ${this.discoveryUrl}`)
      
      if(!this.client.registered) {
        this.client.register(this.host, this.port, {
          adapter: 'service-discovery',
          group: this.group,
          version: process.env.npm_package_version || '1.0.0',
          capabilities: ['chat', 'commands']
        }).catch(error => {
          this.emit('error', error)
        })
      }
      this.emit('connected')
    })

    this.client.on('disconnected', ({ code, reason }) => {
      this.robot.logger.warn(`Service discovery adapter disconnected: ${code} ${reason}`)
      this.emit('disconnected')
    })

    this.client.on('reconnecting', ({ attempt, maxAttempts, interval }) => {
      const attemptsText = maxAttempts > 0 ? `${attempt}/${maxAttempts}` : `${attempt}`
      this.robot.logger.info(`Service discovery adapter reconnecting (attempt ${attemptsText}) in ${interval}ms`)
    })

    this.client.on('error', (error) => {
      this.robot.logger.error(`Service discovery adapter error: ${serializeError(error)}`)
    })

    this.client.on('message', async (messageData) => {
      // Handle get_commands requests from discovery service
      if (messageData.type === 'get_commands') {
        const commands = this.extractCommandMetadata()
        await this.client.sendMessage({
          type: 'commands_response',
          messageId: messageData.messageId,
          commands: commands
        }).catch(error => {
          this.robot.logger.error(`Failed to send commands response: ${serializeError(error)}`)
        })
        return
      }
      
      // Convert service discovery message to Hubot message format
      await this.handleIncomingMessage(messageData)
    })
  }

  async run() {
    try {
      // Connect to service discovery
      await this.client.connect()

      this.robot.logger.info(`Service discovery adapter registered as client instance id = ${this.instanceId}`)
      
      // The 'connected' event is emitted by the client when connection is established

      // The adpater is required to emit the 'connected' event
      // so the Hubot boot process can continue.
      this.emit('connected', this)
    } catch (error) {
      this.robot.logger.error(`Failed to start service discovery adapter: ${serializeError(error)}`)
    }
  }

  async handleIncomingMessage(messageData) {
    try {
      const message = new TextMessage(
        { id: messageData.user.id, name: messageData.user.name || 'Unknown', room: messageData.room || 'general' },
        messageData.text,
        messageData.id
      )
      message.messageId = messageData.messageId
      await this.robot.receive(message)
    } catch (error) {
      this.robot.logger.error(`Error handling incoming message: ${serializeError(error)}`)
    }
  }

  async send(envelope, ...strings) {
    try {
      for (const str of strings) {
        const messageData = {
          type: 'chat_message',
          room: envelope.room,
          user: envelope.user,
          text: str,
          timestamp: Date.now(),
          instanceId: this.instanceId,
          id: envelope.message.id,
          messageId: envelope.message.messageId
        }
        
        await this.client.sendMessage({
          type: 'message_response',
          data: messageData
        })
      }
    } catch (error) {
      this.robot.logger.error(`Error sending message: ${serializeError(error)}`)
    }
  }

  async reply(envelope, ...strings) {
    // For replies, we might want to mention the user
    const mention = envelope.user.mention_name || envelope.user.name || envelope.user.id
    const replies = strings.map(str => `@${mention}: ${str}`)
    await this.send(envelope, ...replies)
  }

  async emote(envelope, ...strings) {
    // Handle emotes by prefixing with an action indicator
    const emotes = strings.map(str => `*${str}*`)
    await this.send(envelope, ...emotes)
  }

  async topic(envelope, ...strings) {
    // Handle topic changes if the underlying chat system supports it
    for (const str of strings) {
      const topicData = {
        type: 'topic_change',
        room: envelope.room,
        topic: str,
        user: envelope.user,
        timestamp: Date.now(),
        instanceId: this.instanceId
      }
      
      await this.client.sendMessage({
        type: 'message',
        data: topicData
      })
    }
  }

  extractCommandMetadata() {
    // Hubot 14+ uses CommandBus with listCommands() method
    if (!this.robot.commands?.listCommands || typeof this.robot.commands.listCommands !== 'function') {
      throw new Error('robot.commands must have a listCommands method (requires Hubot >= 14)')
    }
    
    const commands = this.robot.commands.listCommands()
    
    return commands.filter(cmd => cmd.id !== 'help').map(cmd => ({
      id: cmd.id,
      description: cmd.description || 'No description',
      aliases: cmd.aliases || [],
      args: cmd.args || {}
    }))
  }

  async close() {
    this.robot.logger.info('Closing service discovery adapter...')
    this.client.disableAutoReconnect() // Prevent reconnection during shutdown
    await this.client.disconnect()
  }
}

// Support both named and default exports for compatibility
export { DiscoveryServiceAdapter }
