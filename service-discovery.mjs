// Description:
//   Hubot service discovery script for distributed Hubot clusters
//
// Configuration:
//   HUBOT_SERVICE_NAME - Service name for registration (default: 'hubot')
//   HUBOT_INSTANCE_ID - Unique instance identifier (default: HOSTNAME or generated)
//   HUBOT_HOST - Host address for this instance (default: 'localhost')
//   HUBOT_PORT - Port for this instance (default: 8080)
//   HUBOT_HEARTBEAT_INTERVAL - Heartbeat interval in ms (default: 15000)
//   HUBOT_DISCOVERY_PORT - Port for the discovery server (default: 3100)
//   HUBOT_DISCOVERY_STORAGE - Storage directory for event store (default: ./discovery-data)
//   HUBOT_DISCOVERY_TIMEOUT - Heartbeat timeout in ms (default: 30000)
//   HUBOT_DISCOVERY_URL - URL of discovery server to connect to (optional, for client-only mode)
//   HUBOT_DISCOVERY_RECONNECT_INTERVAL - Client reconnection interval in ms (default: 5000)
//   HUBOT_DISCOVERY_MAX_RECONNECT_ATTEMPTS - Max reconnection attempts, 0 = infinite (default: 0)
//   HUBOT_LB_STRATEGY - Load balancing strategy: round-robin, random, least-connections (default: round-robin)
//
// Commands:
//   hubot discover services - Show all registered services
//   hubot discovery status - Show service discovery status
//   hubot connect to <host>:<port> - Connect brain to a peer
//   hubot brain peers - Show brain peer connections
//   hubot load balancer status - Show load balancer statistics (server only)
//   hubot lb strategy <strategy> - Change load balancing strategy (server only)
//   hubot lb reset - Reset round-robin counter (server only)
//   hubot test routing [message] - Test message routing (server only)
//
// Author:
//   Joey Guerra

import EventStore from './event-store.mjs'
import ServiceRegistry from './service-registry.mjs'
import LoadBalancer from './lib/load-balancer.mjs'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export class ServiceDiscovery {
  constructor(robot) {
    this.robot = robot
    this.serviceName = process.env.HUBOT_SERVICE_NAME || 'hubot'
    this.instanceId = process.env.HUBOT_INSTANCE_ID || process.env.HOSTNAME || `hubot-${Date.now()}`
    this.host = process.env.HUBOT_HOST || 'localhost'
    this.port = parseInt(process.env.HUBOT_PORT || process.env.PORT || 8080)
    this.heartbeatInterval = parseInt(process.env.HUBOT_HEARTBEAT_INTERVAL || 15000)
    
    // Service discovery server configuration (if this instance should run the server)
    this.discoveryPort = parseInt(process.env.HUBOT_DISCOVERY_PORT || 3100)
    this.storageDir = process.env.HUBOT_DISCOVERY_STORAGE || join(process.cwd(), 'discovery-data')
    this.heartbeatTimeoutMs = parseInt(process.env.HUBOT_DISCOVERY_TIMEOUT || 30000)
    this.discoveryUrl = process.env.HUBOT_DISCOVERY_URL
    
    // State
    this.registry = null
    this.wss = null
    this.discoveryWs = null
    this.heartbeatTimer = null
    this.isRegistered = false
    this.isServer = !this.discoveryUrl // If no discovery URL provided, act as server
    
    // Load balancing state
    this.loadBalancer = null
    this.connectedClients = new Map() // Map of client websockets by instance ID
    this.pendingResponses = new Map() // Map of pending message responses
  }

  async start() {
    try {
      if (this.isServer) {
        await this.startDiscoveryServer()
        
        // Start periodic cleanup of pending responses
        this.cleanupTimer = setInterval(() => {
          this.cleanupPendingResponses()
        }, 30000) // Clean up every 30 seconds
      } else {
        await this.registerWithDiscovery()
        this.startHeartbeat()
      }
      
      this.registerCommands()
      this.robot.logger.info(`Service discovery initialized for ${this.instanceId}`)
    } catch (error) {
      this.robot.logger.error('Failed to initialize service discovery:', error)
    }
  }

  async startDiscoveryServer() {
    this.robot.logger.info('Starting service discovery server...')
    
    this.registry = new ServiceRegistry({
      eventStore: {
        storageDir: this.storageDir
      },
      heartbeatTimeoutMs: this.heartbeatTimeoutMs
    })

    // Initialize load balancer
    this.loadBalancer = new LoadBalancer({
      strategy: process.env.HUBOT_LB_STRATEGY || 'round-robin',
      logger: this.robot.logger
    })

    // Start WebSocket server for service discovery
    this.wss = new WebSocketServer({ port: this.discoveryPort })
    
    this.wss.on('connection', (ws, req) => {
      const clientId = `${req.socket.remoteAddress}:${req.socket.remotePort}`
      this.robot.logger.debug(`Discovery client connected: ${clientId}`)
      
      // Store client connection for message routing
      ws.clientId = clientId
      ws.instanceId = null // Will be set during registration
      
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString())
          const response = await this.handleDiscoveryMessage(message, ws)
          if (response) {
            ws.send(JSON.stringify(response))
          }
        } catch (error) {
          this.robot.logger.error(`Error processing discovery message from ${clientId}:`, error)
          ws.send(JSON.stringify({ 
            success: false, 
            error: error.message 
          }))
        }
      })
      
      ws.on('close', () => {
        this.robot.logger.debug(`Discovery client disconnected: ${clientId}`)
        // Remove from connected clients if it was registered
        if (ws.instanceId) {
          this.connectedClients.delete(ws.instanceId)
        }
      })
    })
    
    this.wss.on('error', (error) => {
      this.robot.logger.error('Discovery WebSocket server error:', error)
    })

    this.robot.logger.info(`🔍 Service discovery server started on port ${this.discoveryPort}`)
    
    // Initialize the registry before registering self
    await this.registry.initialize()
    
    // Also register self if running as server
    await this.registerSelf()
  }

  async registerSelf() {
    // Register this instance locally in the registry
    const serviceData = {
      serviceName: this.serviceName,
      instanceId: this.instanceId,
      host: this.host,
      port: this.port,
      isServer: this.isServer,
      metadata: {
        adapter: this.robot.adapterName,
        brain: this.robot.brain?.constructor?.name || 'unknown',
        version: this.robot.version || '1.0.0',
        name: this.robot.name
      }
    }
    
    await this.registry.register(this.serviceName, serviceData)
    this.isRegistered = true
    this.robot.logger.info(`Self-registered as ${this.instanceId}`)
  }

  async handleDiscoveryMessage(message, ws = null) {
    switch (message.type) {
      case 'register':
        await this.registry.register(message.data.serviceName, message.data)
        
        // Store client connection for load balancing if it's not a server instance
        if (ws && !message.data.isServer) {
          ws.instanceId = message.data.instanceId
          this.connectedClients.set(message.data.instanceId, ws)
          this.robot.logger.debug(`Registered client instance for load balancing: ${message.data.instanceId}`)
        }
        
        return { success: true, message: 'Service registered successfully' }
        
      case 'deregister':
        await this.registry.deregister(message.data.serviceName, message.data.instanceId)
        
        // Remove from connected clients
        if (ws && ws.instanceId) {
          this.connectedClients.delete(ws.instanceId)
        }
        
        return { success: true, message: 'Service deregistered successfully' }
        
      case 'discover':
        if (message.data.serviceName) {
          const result = this.registry.discover(message.data.serviceName)
          return { success: true, data: result }
        } else {
          const result = this.registry.discoverAll()
          return { success: true, data: { services: result } }
        }
        
      case 'heartbeat':
        const result = await this.registry.heartbeat(message.data.serviceName, message.data.instanceId)
        return result
        
      case 'health':
        const allServices = this.registry.discoverAll()
        const lbStats = this.loadBalancer ? this.loadBalancer.getStats() : {}
        
        // Calculate healthy instances across all services
        let healthyInstances = 0
        for (const serviceName of Object.keys(allServices)) {
          healthyInstances += this.registry.getHealthyInstances(serviceName).length
        }
        
        return { 
          success: true, 
          data: { 
            status: 'healthy', 
            uptime: process.uptime(),
            totalServices: Object.keys(allServices).length,
            totalInstances: Object.values(allServices).reduce((sum, instances) => sum + instances.length, 0),
            healthyInstances,
            connectedClients: this.connectedClients.size,
            loadBalancer: lbStats
          }
        }
        
      case 'chat_message':
        // This is an incoming message from the chat provider that needs to be load balanced
        return await this.routeMessage(message.data)
        
      case 'message_response':
        // This is a response from a client instance back to the chat provider
        return this.handleMessageResponse(message.data)
        
      default:
        throw new Error(`Unknown message type: ${message.type}`)
    }
  }

  async registerWithDiscovery() {
    try {
      const wsUrl = this.discoveryUrl.replace('http', 'ws')
      const ws = new (await import('ws')).default(wsUrl)
      
      ws.on('open', async () => {
        this.robot.logger.info(`Connected to service discovery at ${wsUrl}`)
        
        const registrationMessage = {
          type: 'register',
          data: {
            serviceName: this.serviceName,
            instanceId: this.instanceId,
            host: this.host,
            port: this.port,
            isServer: this.isServer,
            metadata: {
              adapter: this.robot.adapterName,
              brain: this.robot.brain?.constructor?.name || 'unknown',
              version: this.robot.version || '1.0.0',
              name: this.robot.name
            }
          }
        }
        
        ws.send(JSON.stringify(registrationMessage))
      })
      
      ws.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString())
          if (response.success) {
            this.isRegistered = true
            this.robot.logger.info(`Registered with service discovery as ${this.instanceId}`)
          } else {
            this.robot.logger.error('Registration failed:', response.error)
          }
        } catch (error) {
          this.robot.logger.error('Error parsing registration response:', error)
        }
      })
      
      ws.on('error', (error) => {
        this.robot.logger.error('Discovery connection error:', error)
      })
      
      this.discoveryWs = ws
      
    } catch (error) {
      this.robot.logger.error('Failed to connect to service discovery:', error)
    }
  }

  startHeartbeat() {    
    this.heartbeatTimer = setInterval(() => {
      if (this.discoveryWs && this.discoveryWs.readyState === 1) { // WebSocket.OPEN
        const heartbeatMessage = {
          type: 'heartbeat',
          data: {
            serviceName: this.serviceName,
            instanceId: this.instanceId
          }
        }
        
        this.discoveryWs.send(JSON.stringify(heartbeatMessage))
      }
    }, this.heartbeatInterval)
  }

  async routeMessage(messageData) {
    try {
      // Get healthy instances from registry
      const healthyInstances = this.registry.getHealthyInstances(this.serviceName)
      
      // Select an instance using load balancer
      const selectedInstance = this.loadBalancer.selectInstance(healthyInstances)
      
      if (!selectedInstance) {
        this.robot.logger.warn('No healthy instances available for message routing')
        return { 
          success: false, 
          error: 'No healthy instances available',
          shouldProcessLocally: true // Suggest processing locally
        }
      }

      // Get the client connection for the selected instance
      const clientWs = this.connectedClients.get(selectedInstance.instanceId)
      
      if (!clientWs || clientWs.readyState !== 1) { // 1 = WebSocket.OPEN
        this.robot.logger.warn(`Client connection not available for instance: ${selectedInstance.instanceId}`)
        return { 
          success: false, 
          error: 'Client connection not available',
          shouldProcessLocally: true
        }
      }

      // Generate a unique message ID for tracking responses
      const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      messageData.messageId = messageId

      // Store the message for response tracking
      this.pendingResponses.set(messageId, {
        timestamp: Date.now(),
        originalMessage: messageData,
        selectedInstance: selectedInstance.instanceId
      })

      // Forward the message to the selected instance
      const routedMessage = {
        type: 'message',
        data: messageData
      }

      clientWs.send(JSON.stringify(routedMessage))
      
      this.robot.logger.debug(`Message routed to instance: ${selectedInstance.instanceId}`)
      
      return { 
        success: true, 
        routedTo: selectedInstance.instanceId,
        messageId: messageId
      }
      
    } catch (error) {
      this.robot.logger.error('Error routing message:', error)
      return { 
        success: false, 
        error: error.message,
        shouldProcessLocally: true
      }
    }
  }

  handleMessageResponse(responseData) {
    const messageId = responseData.messageId
    
    if (!messageId) {
      this.robot.logger.warn('Received message response without messageId')
      return { success: false, error: 'Missing messageId' }
    }

    const pendingMessage = this.pendingResponses.get(messageId)
    
    if (!pendingMessage) {
      this.robot.logger.warn(`Received response for unknown message: ${messageId}`)
      return { success: false, error: 'Unknown messageId' }
    }

    // Clean up pending response
    this.pendingResponses.delete(messageId)
    
    // Process the response (could forward back to chat provider, etc.)
    this.robot.logger.debug(`Received response for message ${messageId} from instance ${pendingMessage.selectedInstance}`)
    
    // If this server instance has a robot, emit the response
    if (this.robot && responseData.text) {
      // Create a user object if not provided
      const user = responseData.user || { id: 'system', name: 'Hubot' }
      
      // Send the response through the robot (this will go to the chat provider)
      this.robot.messageRoom(responseData.room || 'general', responseData.text)
    }
    
    return { success: true, processed: true }
  }

  /**
   * Process a message locally (fallback when no instances available)
   */
  async processMessageLocally(messageData) {
    if (!this.robot) {
      return
    }

    try {
      // Create a Hubot User object
      const user = this.robot.brain.userForId(messageData.user.id, messageData.user)
      
      // Create a Hubot TextMessage
      const message = new this.robot.TextMessage(
        user,
        messageData.text,
        messageData.id || messageData.messageId || `msg-${Date.now()}`
      )
      
      // Set the room if provided
      if (messageData.room) {
        message.room = messageData.room
      }
      
      // Receive the message into Hubot for local processing
      this.robot.receive(message)
      
      this.robot.logger.debug('Message processed locally')
    } catch (error) {
      this.robot.logger.error('Error processing message locally:', error)
    }
  }

  /**
   * Clean up old pending responses (call periodically)
   */
  cleanupPendingResponses() {
    const now = Date.now()
    const timeout = 30000 // 30 seconds timeout
    
    for (const [messageId, pendingMessage] of this.pendingResponses.entries()) {
      if (now - pendingMessage.timestamp > timeout) {
        this.robot.logger.warn(`Cleaning up expired pending response: ${messageId}`)
        this.pendingResponses.delete(messageId)
      }
    }
  }

  async discoverServices(serviceName = null) {
    if (this.isServer && this.registry) {
      // Local discovery if we're the server
      if (serviceName) {
        return this.registry.discover(serviceName)
      } else {
        const services = this.registry.discoverAll()
        return { services }
      }
    }
    
    if (!this.discoveryWs || this.discoveryWs.readyState !== 1) {
      throw new Error('Not connected to service discovery')
    }
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discovery request timeout'))
      }, 5000)
      
      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data.toString())
          if (response.success) {
            clearTimeout(timeout)
            this.discoveryWs.removeListener('message', messageHandler)
            resolve(response.data)
          }
        } catch (error) {
          // Ignore parse errors, might be other messages
        }
      }
      
      this.discoveryWs.on('message', messageHandler)
      
      const discoveryMessage = {
        type: 'discover',
        data: { serviceName }
      }
      
      this.discoveryWs.send(JSON.stringify(discoveryMessage))
    })
  }

  registerCommands() {
    // Command to discover other services
    this.robot.respond(/discover\s+services?(?<serviceName>.*)?/i, async (res) => {
      try {
        const serviceName = res.match.groups.serviceName?.toLowerCase() ?? null
        const result = await this.discoverServices(serviceName)

        if (serviceName) {
          const instances = result.instances?.filter(i => i.instanceId !== this.instanceId) || []
          if (instances.length === 0) {
            await res.reply('No other hubot instances found')
          } else {
            const list = instances.map(i => 
              `• ${i.instanceId} (${i.host}:${i.port}) - ${i.metadata?.adapter || 'unknown'} adapter`
            ).join('\n')
            await res.reply(`Found ${instances.length} other hubot instance(s):\n${list}`)
          }
        } else {
          const services = result.services || {}
          const serviceList = Object.entries(services).map(([name, instances]) => 
            `• ${name}: ${instances.length} instance(s)`
          ).join('\n')
          await res.reply(`All registered services:\n${serviceList}`)
        }
      } catch (error) {
        await res.reply(`Error discovering services: ${error.message}`)
      }
    })

    // Command to show discovery status
    this.robot.respond(/discovery\s+status/i, async (res) => {
      const status = []
      status.push(`Instance ID: ${this.instanceId}`)
      status.push(`Service Name: ${this.serviceName}`)
      status.push(`Mode: ${this.isServer ? 'Server' : 'Client'}`)
      status.push(`Registered: ${this.isRegistered ? 'Yes' : 'No'}`)

      if (this.registry) {
        const allServices = this.registry.discoverAll()
        const totalServices = Object.keys(allServices).length
        const totalInstances = Object.values(allServices).reduce((sum, instances) => sum + instances.length, 0)
        status.push(`Managing: ${totalServices} service(s), ${totalInstances} instance(s)`)
      }
      
      await res.reply(`🔍 Service Discovery Status:\n${status.join('\n')}`)
    })

    // Command to connect to a peer (for brain sync)
    this.robot.respond(/connect\s+to\s+(\S+):?(\d+)?/i, async (res) => {
      const host = res.match[1]
      const port = res.match[2] || 3001
      
      if (this.robot.brain && typeof this.robot.brain.connectToPeer === 'function') {
        try {
          await this.robot.brain.connectToPeer(host, port)
          await res.reply(`🔗 Attempting to connect brain to ${host}:${port}`)
        } catch (error) {
          await res.reply(`❌ Failed to connect to peer: ${error.message}`)
        }
      } else {
        await res.reply('❌ Brain does not support peer connections')
      }
    })

    // Command to show brain peer status
    this.robot.respond(/brain\s+peers/i, async (res) => {
      if (this.robot.brain && typeof this.robot.brain.getPeerCount === 'function') {
        const peerCount = this.robot.brain.getPeerCount()
        await res.reply(`🧠 Brain has ${peerCount} connected peer(s)`)
      } else {
        await res.reply('❌ Brain peer information not available')
      }
    })

    // Load balancing commands (only available on server instances)
    if (this.isServer && this.loadBalancer) {
      // Command to show load balancer status
      this.robot.respond(/(?:load.?balancer|lb)\s+status/i, async (res) => {
        const stats = this.loadBalancer.getStats()
        const allServices = this.registry.discoverAll()
        
        // Calculate total and healthy instances from registry
        const totalInstances = Object.values(allServices).reduce((sum, instances) => sum + instances.length, 0)
        let healthyInstances = 0
        for (const serviceName of Object.keys(allServices)) {
          healthyInstances += this.registry.getHealthyInstances(serviceName).length
        }
        
        const status = []
        status.push(`Strategy: ${stats.strategy}`)
        status.push(`Connected Clients: ${this.connectedClients.size}`)
        status.push(`Healthy Instances: ${healthyInstances}`)
        status.push(`Total Instances: ${totalInstances}`)
        status.push(`Pending Responses: ${this.pendingResponses.size}`)
        
        if (stats.strategy === 'round-robin') {
          status.push(`Round-Robin Index: ${stats.roundRobinIndex}`)
        }
        
        await res.reply(`⚖️ Load Balancer Status:\n${status.join('\n')}`)
      })

      // Command to change load balancing strategy
      this.robot.respond(/(?:load.?balancer|lb)\s+strategy\s+(\w+)/i, async (res) => {
        const newStrategy = res.match[1].toLowerCase()
        
        try {
          this.loadBalancer.setStrategy(newStrategy)
          await res.reply(`✅ Load balancing strategy changed to: ${newStrategy}`)
        } catch (error) {
          await res.reply(`❌ ${error.message}`)
        }
      })

      // Command to reset round-robin counter
      this.robot.respond(/(?:load.?balancer|lb)\s+reset/i, async (res) => {
        this.loadBalancer.resetRoundRobin()
        await res.reply('✅ Round-robin counter reset')
      })

      // Command to test message routing
      this.robot.respond(/test\s+routing(?:\s+(.+))?/i, async (res) => {
        const testMessage = res.match[1] || 'Test message'
        
        const messageData = {
          user: { id: 'test-user', name: 'Test User' },
          text: testMessage,
          room: res.message.room || 'general',
          id: `test-${Date.now()}`
        }
        
        const result = await this.routeMessage(messageData)
        
        if (result.success) {
          await res.reply(`✅ Test message routed to: ${result.routedTo}`)
        } else {
          await res.reply(`❌ Failed to route test message: ${result.error}`)
        }
      })
    }
  }

  async stop() {
    // Clear heartbeat timer
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    
    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    
    // Deregister from discovery
    if (this.discoveryWs && this.isRegistered) {
      try {
        const deregisterMessage = {
          type: 'deregister',
          data: {
            serviceName: this.serviceName,
            instanceId: this.instanceId
          }
        }
        this.discoveryWs.send(JSON.stringify(deregisterMessage))
      } catch (error) {
        this.robot.logger.debug('Error sending deregister message:', error)
      }
    }
    
    // Close discovery WebSocket
    if (this.discoveryWs) {
      this.discoveryWs.close()
      this.discoveryWs = null
    }
    
    // Close discovery server with timeout
    if (this.wss) {
      try {
        // Close all client connections first
        for (const client of this.wss.clients || []) {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.close()
          }
        }
        
        // Close the server with timeout
        const serverClosePromise = new Promise((resolve) => {
          this.wss.close(() => resolve())
        })
        const timeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('WebSocket server close timeout')), 1000)
        )
        await Promise.race([serverClosePromise, timeout])
      } catch (error) {
        this.robot?.logger?.debug('WebSocket server close error (continuing cleanup):', error.message)
      }
      this.wss = null
    }
    
    // Close registry with timeout
    if (this.registry) {
      try {
        // Add timeout to prevent hanging on registry.close()
        const registryClosePromise = this.registry.close()
        const timeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Registry close timeout')), 1000)
        )
        await Promise.race([registryClosePromise, timeout])
      } catch (error) {
        this.robot?.logger?.debug('Registry close error (continuing cleanup):', error.message)
      }
      this.registry = null
    }
    
    // Clear load balancer references
    this.loadBalancer = null
    this.connectedClients.clear()
    this.pendingResponses.clear()
    
    this.robot.logger.info('Service discovery stopped')
  }
}

export default async robot => {
  robot.parseHelp(__filename)
  const serviceDiscovery = new ServiceDiscovery(robot)
  robot.serviceDiscovery = serviceDiscovery
  await serviceDiscovery.start()
  return serviceDiscovery
}
