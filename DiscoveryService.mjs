// Description:
//   Hubot service discovery script for distributed Hubot clusters
//
// Configuration (Discovery Service Server):
//   HUBOT_SERVICE_NAME - Service name for registration (default: 'hubot')
//   HUBOT_INSTANCE_ID - Unique instance identifier (default: generated as hubot-<Date.now()>)
//   HUBOT_HOST - Host address for this instance (default: 'localhost')
//   HUBOT_PORT - Port for this instance (default: 8080)
//   HUBOT_HEARTBEAT_INTERVAL - Heartbeat interval in ms (default: 15000)
//   HUBOT_DISCOVERY_PORT - Port for the discovery server (default: 3100)
//   HUBOT_DISCOVERY_STORAGE - Storage directory for event store (default: ../data from current working directory)
//   HUBOT_DISCOVERY_TIMEOUT - Heartbeat timeout in ms (default: 30000)
//   HUBOT_LB_STRATEGY - Load balancing strategy: round-robin, random, least-connections (default: round-robin)
//   HUBOT_ALLOWED_ORIGINS - Comma-separated list of allowed WebSocket origins for security (default: none, allows all)
//   HUBOT_DISCOVERY_TOKEN - Shared secret token for authentication (default: none, allows all)
//   HUBOT_MAX_CONNECTIONS_PER_IP - Maximum connections per IP address (default: 5)
//   HUBOT_RATE_LIMIT_WINDOW_MS - Rate limit window in ms (default: 60000 = 1 minute)
//   HUBOT_RATE_LIMIT_MAX_ATTEMPTS - Max connection attempts per window (default: 10)
//
// Commands:
//   hubot discover services - Show all registered services
//   hubot discovery status - Show service discovery status
//   hubot load balancer status - Show load balancer statistics
//   hubot lb strategy <strategy> - Change load balancing strategy
//   hubot lb reset - Reset round-robin counter
//   hubot test routing [message] - Test message routing
//
// Author:
//   Joey Guerra

import EventStore from './lib/EventStore.mjs'
import ServiceRegistry from './lib/ServiceRegistry.mjs'
import LoadBalancer from './lib/LoadBalancer.mjs'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { TextMessage, TextListener } from 'hubot'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export class DiscoveryService {
  constructor(robot) {
    this.robot = robot
    this.serviceName = process.env.HUBOT_SERVICE_NAME || 'hubot'
    this.instanceId = process.env.HUBOT_INSTANCE_ID || `hubot-${Date.now()}`
    this.host = process.env.HUBOT_HOST || 'localhost'
    this.port = parseInt(process.env.HUBOT_PORT || process.env.PORT || 8080)
    this.heartbeatInterval = parseInt(process.env.HUBOT_HEARTBEAT_INTERVAL || 15000)
    
    // Service discovery server configuration (if this instance should run the server)
    this.discoveryPort = parseInt(process.env.HUBOT_DISCOVERY_PORT || 3100)
    this.storageDir = process.env.HUBOT_DISCOVERY_STORAGE || join(process.cwd(), '../data')
    this.heartbeatTimeoutMs = parseInt(process.env.HUBOT_DISCOVERY_TIMEOUT || 30000)
    
    // State - DiscoveryService is always a server
    this.registry = null
    this.wss = null
    this.isRegistered = false
    
    // Load balancing state
    this.loadBalancer = null
    this.connectedWorkers = new Map() // Map of worker websockets by instance ID
    this.pendingResponses = new Map() // Map of pending message responses
    
    // Security configuration
    this.discoveryToken = process.env.HUBOT_DISCOVERY_TOKEN || null
    this.maxConnectionsPerIP = parseInt(process.env.HUBOT_MAX_CONNECTIONS_PER_IP || 5)
    this.rateLimitWindowMs = parseInt(process.env.HUBOT_RATE_LIMIT_WINDOW_MS || 60000)
    this.rateLimitMaxAttempts = parseInt(process.env.HUBOT_RATE_LIMIT_MAX_ATTEMPTS || 10)
    
    // Security tracking
    this.connectionsByIP = new Map() // Track connections per IP
    this.connectionAttempts = new Map() // Track connection attempts for rate limiting
  }

  async start() {
    try {
      await this.startDiscoveryServer()
      
      // Start periodic cleanup of pending responses
      this.cleanupTimer = setInterval(() => {
        this.cleanupPendingResponses()
      }, 30000) // Clean up every 30 seconds
      
      this.registerCommands()
      this.robot.logger.info(`Service discovery server initialized for ${this.instanceId}`)
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

    // Configure allowed origins for WebSocket connections
    const allowedOrigins = process.env.HUBOT_ALLOWED_ORIGINS 
      ? process.env.HUBOT_ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : null // null means no origin validation (backward compatible but insecure)

    // Log security configuration
    if (!allowedOrigins) {
      this.robot.logger.warn('⚠️  Origin validation is DISABLED. Set HUBOT_ALLOWED_ORIGINS for security.')
    }
    if (!this.discoveryToken) {
      this.robot.logger.warn('⚠️  Token authentication is DISABLED. Set HUBOT_DISCOVERY_TOKEN for security.')
    }
    if (allowedOrigins && this.discoveryToken) {
      this.robot.logger.info('✅ Security enabled: Origin validation + Token authentication')
    }

    // Start WebSocket server for service discovery
    this.wss = new WebSocketServer({ 
      port: this.discoveryPort,
      verifyClient: (info, callback) => {
        const ip = info.req.socket.remoteAddress
        
        // Rate limiting check
        if (!this.checkRateLimit(ip)) {
          this.robot.logger.warn(`❌ Rate limit exceeded for IP: ${ip}`)
          callback(false, 429, 'Too Many Requests')
          return
        }
        
        // Connection limit per IP check
        const currentConnections = this.connectionsByIP.get(ip) || 0
        if (currentConnections >= this.maxConnectionsPerIP) {
          this.robot.logger.warn(`❌ Connection limit exceeded for IP: ${ip} (${currentConnections}/${this.maxConnectionsPerIP})`)
          callback(false, 429, 'Too Many Connections')
          return
        }
        
        // Origin validation
        if (allowedOrigins) {
          const origin = info.origin || info.req.headers.origin
          
          // Allow connections without origin (direct WebSocket clients, not browser-based)
          if (origin) {
            // Validate origin against allowed list
            if (!allowedOrigins.includes(origin) && !allowedOrigins.includes('*')) {
              this.robot.logger.warn(`❌ Rejected connection from unauthorized origin: ${origin}`)
              callback(false, 403, 'Forbidden: Origin not allowed')
              return
            }
          }
        }
        
        // Track connection attempt
        this.trackConnection(ip)
        callback(true)
      }
    })
    
    this.wss.on('connection', (ws, req) => {
      const workerId = `${req.socket.remoteAddress}:${req.socket.remotePort}`
      const ip = req.socket.remoteAddress
      this.robot.logger.debug(`Discovery worker connected: ${workerId}`)
      this.robot.logger.debug(`Currently have ${this.connectedWorkers.size} workers in connectedWorkers map`)
      
      // Store worker connection for message routing
      ws.workerId = workerId
      ws.ip = ip
      ws.instanceId = null // Will be set during registration
      ws.authenticated = false // Will be set to true after token validation
      
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString())
          const response = await this.handleDiscoveryMessage(message, ws)
          if (response) {
            ws.send(JSON.stringify(response))
          }
        } catch (error) {
          this.robot.logger.error(`Error processing discovery message from ${workerId}:`, error)
          ws.send(JSON.stringify({ 
            success: false, 
            error: error.message 
          }))
        }
      })
      
      ws.on('close', () => {
        this.robot.logger.debug(`Discovery worker disconnected: ${workerId}`)
        
        // Decrement IP connection count
        this.untrackConnection(ws.ip)
        
        // Remove from connected workers if it was registered
        if (ws.instanceId) {
          this.connectedWorkers.delete(ws.instanceId)
          this.robot.logger.debug(`Removed ${ws.instanceId} from connectedWorkers. Remaining: ${this.connectedWorkers.size}`)
        }

        // Proactively deregister non-server instances on disconnect
        if (ws.instanceId && ws.serviceName && ws.isServer !== true) {
          this.registry.deregister(ws.serviceName, ws.instanceId)
            .catch(error => {
              this.robot.logger.warn(`Failed to deregister disconnected instance ${ws.instanceId}: ${error.message}`)
            })
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
      isServer: true, // DiscoveryService instances are always servers
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
    // Token validation (if configured)
    if (this.discoveryToken && ws && !ws.authenticated) {
      const providedToken = message.token || message.data?.token
      
      if (!providedToken) {
        this.robot.logger.warn(`❌ Authentication required but no token provided from ${ws.workerId}`)
        throw new Error('Authentication required: Missing token')
      }
      
      if (providedToken !== this.discoveryToken) {
        this.robot.logger.warn(`❌ Invalid token provided from ${ws.workerId}`)
        throw new Error('Authentication failed: Invalid token')
      }
      
      // Mark as authenticated
      ws.authenticated = true
      this.robot.logger.debug(`✅ Successfully authenticated ${ws.workerId}`)
    }
    
    switch (message.type) {
      case 'register':
        await this.registry.register(message.data.serviceName, message.data)
        
        // Store worker connection for load balancing if it's not a server instance
        if (ws) {
          ws.instanceId = message.data.instanceId
          ws.serviceName = message.data.serviceName
          ws.isServer = message.data.isServer === true
        }

        if (ws && !message.data.isServer) {
          this.connectedWorkers.set(message.data.instanceId, ws)
          this.robot.logger.debug(`Registered worker instance for load balancing: ${message.data.instanceId}, group: ${message.data.metadata?.group || 'default'}`)
          this.robot.logger.debug(`connectedWorkers now has ${this.connectedWorkers.size} entries`)
        } else if (ws && message.data.isServer) {
          this.robot.logger.debug(`Server instance registered: ${message.data.instanceId}, NOT added to connectedWorkers`)
        }
        
        return { success: true, message: 'Service registered successfully' }
        
      case 'deregister':
        await this.registry.deregister(message.data.serviceName, message.data.instanceId)
        
        // Remove from connected workers
        if (ws && ws.instanceId) {
          this.connectedWorkers.delete(ws.instanceId)
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
            connectedWorkers: this.connectedWorkers.size,
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

  async routeMessage(messageData) {
    try {
      // Get healthy instances from registry and ensure they are actively connected
      const healthyInstances = this.registry.getHealthyInstances(this.serviceName)
      this.robot.logger.debug(`Routing message: found ${healthyInstances.length} healthy instances`)
      healthyInstances.forEach(i => {
        this.robot.logger.debug(`  - Instance: ${i.instanceId}, Group: ${i.metadata?.group || 'default'}`)
      })
      
      this.robot.logger.debug(`Routing message: connectedWorkers has ${this.connectedWorkers.size} entries`)
      for (const [id, ws] of this.connectedWorkers.entries()) {
        this.robot.logger.debug(`  - ConnectedWorker: ${id}, WebSocket state: ${ws?.readyState || 'unknown'}`)
      }
      
      const connectedHealthyInstances = healthyInstances.filter(instance => {
        const workerWs = this.connectedWorkers.get(instance.instanceId)
        const isConnected = workerWs && workerWs.readyState === 1
        if (!isConnected) {
          this.robot.logger.debug(`  Instance ${instance.instanceId} NOT connected (found: ${!!workerWs}, readyState: ${workerWs?.readyState || 'n/a'})`)
        }
        return isConnected
      })
      this.robot.logger.debug(`Routing message: ${connectedHealthyInstances.length} instances are connected`)
      
      const oneInstancePerGroup = Object.groupBy(connectedHealthyInstances, i => i.metadata?.group || 'default')
      this.robot.logger.debug(`Routing message: grouped into ${Object.keys(oneInstancePerGroup).length} groups: ${Object.keys(oneInstancePerGroup).join(', ')}`)

      if (Object.keys(oneInstancePerGroup).length === 0) {
        this.robot.logger.warn('From discovery service route message, No healthy instances available for message routing')
        return [{ 
          success: false, 
          error: 'No healthy instances available',
          shouldProcessLocally: true, // Suggest processing locally
          messageId: null
        }]
      }

      const results = []
      // Generate a unique message ID for tracking responses
      const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      messageData.messageId = messageId

      for (const key in oneInstancePerGroup) {
        this.robot.logger.debug(`Group "${key}" has ${oneInstancePerGroup[key].length} instance(s): ${oneInstancePerGroup[key].map(i => i.instanceId).join(', ')}`)
        const selectedInstance = this.loadBalancer.selectInstance(oneInstancePerGroup[key], key)
        this.robot.logger.debug(`Selected instance from group "${key}": ${selectedInstance.instanceId}`)
        const workerWs = this.connectedWorkers.get(selectedInstance.instanceId)
        if (!workerWs || workerWs.readyState !== 1) { // 1 = WebSocket.OPEN
          this.robot.logger.warn(`Worker connection not available for selected instance: ${selectedInstance.instanceId}`)
          results.push({
            success: false,
            error: `Worker connection not available for instance: ${selectedInstance.instanceId}`,
            shouldProcessLocally: true,
            messageId: messageId
          })
          continue
        }

        // Store the message for response tracking
        // Initialize or add to existing pending response tracking (multiple instances can respond)
        if (!this.pendingResponses.has(messageId)) {
          this.pendingResponses.set(messageId, {
            timestamp: Date.now(),
            originalMessage: messageData,
            pendingInstances: new Set(),
            receivedResponses: new Map() // Track responses to avoid processing duplicates
          })
        }
        
        const pendingEntry = this.pendingResponses.get(messageId)
        pendingEntry.pendingInstances.add(selectedInstance.instanceId)

        // Forward the message to the selected instance
        const routedMessage = {
          type: 'message',
          data: messageData
        }
        workerWs.send(JSON.stringify(routedMessage))
        results.push({
          success: true,
          routedTo: selectedInstance.instanceId,
          instanceId: selectedInstance.instanceId,
          messageId: messageId
        })
        this.robot.logger.debug(`Message routed to instance: ${selectedInstance.instanceId}`)
      }

      return results
    } catch (error) {
      this.robot.logger.error('Error routing message:', error)
      return [{ 
        success: false, 
        error: error.message,
        shouldProcessLocally: true,
        messageId: null
      }]
    }
  }

  handleMessageResponse(responseData) {
    const messageId = responseData.messageId
    const instanceId = responseData.instanceId
    
    if (!messageId) {
      this.robot.logger.warn('Received message response without messageId')
      return { success: false, error: 'messageId is required for message responses' }
    }

    const pendingMessage = this.pendingResponses.get(messageId)
    
    if (!pendingMessage) {
      this.robot.logger.warn(`Received response for unknown message: ${messageId}`)
      return { success: false, error: 'Unknown messageId' }
    }

    // Check if we've already processed a response from this instance
    if (pendingMessage.receivedResponses.has(instanceId)) {
      this.robot.logger.debug(`Already processed response from instance ${instanceId} for message ${messageId}`)
      return { success: true, processed: true, duplicate: true }
    }

    // Mark this response as received
    pendingMessage.receivedResponses.set(instanceId, {
      timestamp: Date.now(),
      data: responseData
    })

    // Remove this instance from pending
    pendingMessage.pendingInstances.delete(instanceId)
    
    // Process the response (could forward back to chat provider, etc.)
    this.robot.logger.debug(`Received response for message ${messageId} from instance ${instanceId}. Pending: ${pendingMessage.pendingInstances.size}`)
    
    // If this server instance has a robot, emit the response
    if (this.robot && responseData.text) {
      // Create a user object if not provided
      const user = responseData.user || { id: 'system', name: 'Hubot' }
      
      // Send the response through the robot (this will go to the chat provider)
      this.robot.messageRoom(responseData.room || 'general', responseData.text)
    }
    
    // Only clean up the messageId entry if all instances have responded
    if (pendingMessage.pendingInstances.size === 0) {
      this.pendingResponses.delete(messageId)
      this.robot.logger.debug(`All responses received for message ${messageId}. Cleaned up pending entry.`)
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
      const message = new TextMessage(
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
        const pendingCount = pendingMessage.pendingInstances.size
        const receivedCount = pendingMessage.receivedResponses.size
        this.robot.logger.warn(`Cleaning up expired pending response: ${messageId} (received ${receivedCount}/${receivedCount + pendingCount} responses)`)
        this.pendingResponses.delete(messageId)
      }
    }
  }

  async discoverServices(serviceName = null) {
    // DiscoveryService is always a server with local registry
    if (serviceName) {
      return this.registry.discover(serviceName)
    } else {
      const services = this.registry.discoverAll()
      return { services }
    }
  }

  registerCommands() {
    // Discover services command
    this.robot.commands.register({
      id: 'discovery.discover',
      description: 'Discover registered services or instances of a service',
      aliases: ['discover services', 'discover'],
      args: {
        serviceName: { type: 'string', required: false }
      },
      handler: async (ctx) => {
        try {
          const serviceName = ctx.args.serviceName?.toLowerCase() ?? null
          const result = await this.discoverServices(serviceName)

          if (serviceName) {
            const instances = result.instances?.filter(i => i.instanceId !== this.instanceId) || []
            if (instances.length === 0) {
              return 'No other hubot instances found'
            } else {
              const list = instances.map(i => 
                `• ${i.instanceId} (${i.host}:${i.port}) - ${i.metadata?.adapter || 'unknown'} adapter`
              ).join('\n')
              return `Found ${instances.length} other hubot instance(s):\n${list}`
            }
          } else {
            const services = result.services || {}
            const serviceList = Object.entries(services).map(([name, instances]) => 
              `• ${name}: ${instances.length} instance(s)`
            ).join('\n')
            return `All registered services:\n${serviceList}`
          }
        } catch (error) {
          return `Error discovering services: ${error.message}`
        }
      }
    })

    // Discovery status command
    this.robot.commands.register({
      id: 'discovery.status',
      description: 'Show service discovery server status',
      aliases: ['discovery status'],
      handler: async (ctx) => {
        const status = []
        status.push(`Instance ID: ${this.instanceId}`)
        status.push(`Service Name: ${this.serviceName}`)
        status.push(`Mode: Server`)
        status.push(`Registered: ${this.isRegistered ? 'Yes' : 'No'}`)

        if (this.registry) {
          const allServices = this.registry.discoverAll()
          const totalServices = Object.keys(allServices).length
          const totalInstances = Object.values(allServices).reduce((sum, instances) => sum + instances.length, 0)
          status.push(`Managing: ${totalServices} service(s), ${totalInstances} instance(s)`)
        }
        
        return `🔍 Service Discovery Status:\n${status.join('\n')}`
      }
    })

    // Load balancer status command
    if (this.loadBalancer) {
      this.robot.commands.register({
        id: 'discovery.lb.status',
        description: 'Show load balancer status',
        aliases: ['load balancer status', 'lb status'],
        handler: async (ctx) => {
          const stats = this.loadBalancer.getStats()
          const allServices = this.registry.discoverAll()

          const totalInstances = Object.values(allServices).reduce((sum, instances) => sum + instances.length, 0)
          let healthyInstances = 0
          for (const serviceName of Object.keys(allServices)) {
            healthyInstances += this.registry.getHealthyInstances(serviceName).length
          }
          const status = []
          status.push(`Strategy: ${stats.strategy}`)
          status.push(`Connected Workers: ${this.connectedWorkers.size}`)
          status.push(`Healthy Instances: ${healthyInstances}`)
          status.push(`Total Instances: ${totalInstances}`)
          status.push(`Pending Responses: ${this.pendingResponses.size}`)
          
          if (stats.strategy === 'round-robin') {
            status.push(`Round-Robin Index: ${stats.roundRobinIndex}`)
          }
          
          return `⚖️ Load Balancer Status:\n${status.join('\n')}`
        }
      })

      // Load balancer strategy command
      this.robot.commands.register({
        id: 'discovery.lb.strategy',
        description: 'Change load balancing strategy',
        aliases: ['load balancer strategy', 'lb strategy'],
        args: {
          strategy: { 
            type: 'enum', 
            values: ['round-robin', 'random', 'least-connections'],
            required: true,
            description: 'Load balancing strategy to use'
          }
        },
        handler: async (ctx) => {
          try {
            const newStrategy = ctx.args.strategy.toLowerCase()
            this.loadBalancer.setStrategy(newStrategy)
            return `✅ Load balancing strategy changed to: ${newStrategy}`
          } catch (error) {
            return `❌ ${error.message}`
          }
        }
      })

      // Load balancer reset command
      this.robot.commands.register({
        id: 'discovery.lb.reset',
        description: 'Reset round-robin load balancer counter',
        aliases: ['load balancer reset', 'lb reset'],
        handler: async (ctx) => {
          this.loadBalancer.resetRoundRobin()
          return '✅ Round-robin counter reset'
        }
      })

      // Test routing command
      this.robot.commands.register({
        id: 'discovery.test.routing',
        description: 'Test message routing to worker instances',
        aliases: ['test routing'],
        args: {
          message: { type: 'string', required: false }
        },
        handler: async (ctx) => {
          const testMessage = ctx.args.message || 'Test message'
          const message = new TextMessage(
            { id: 'test-user', name: 'Test User', room: ctx.room },
            `@${this.robot.name} ${testMessage}`,
            `test-${Date.now()}`
          )

          const result = await this.routeMessage(message)

          if (result[0]?.success) {
            return `✅ Test message routed to: ${result[0].routedTo}`
          } else {
            return `❌ Failed to route test message: ${result[0]?.error || 'Unknown error'}`
          }
        }
      })

      // Message routing middleware - not a command, but part of the routing logic
      this.robot.receiveMiddleware(async context => {
        if (!this.robot.listeners.some(listener => {
          return listener instanceof TextListener && listener.matcher(context.response.message)
        })) {
          this.robot.logger.debug('Routing message')
          // The message journey begins here.
          const result = await this.routeMessage(context.response.message)
          return false
        }
        return true
      })
    }
  }

  async stop() {
    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
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
    this.connectedWorkers.clear()
    this.pendingResponses.clear()
    
    this.isRegistered = false
    
    this.robot.logger.info('Service discovery stopped')
  }
  
  // Security helper methods
  checkRateLimit(ip) {
    const now = Date.now()
    const attempts = this.connectionAttempts.get(ip) || []
    
    // Remove old attempts outside the window
    const recentAttempts = attempts.filter(timestamp => now - timestamp < this.rateLimitWindowMs)
    
    if (recentAttempts.length >= this.rateLimitMaxAttempts) {
      return false
    }
    
    // Add current attempt
    recentAttempts.push(now)
    this.connectionAttempts.set(ip, recentAttempts)
    
    return true
  }
  
  trackConnection(ip) {
    const count = this.connectionsByIP.get(ip) || 0
    this.connectionsByIP.set(ip, count + 1)
    this.robot.logger.debug(`IP ${ip} now has ${count + 1} connection(s)`)
  }
  
  untrackConnection(ip) {
    const count = this.connectionsByIP.get(ip) || 0
    if (count <= 1) {
      this.connectionsByIP.delete(ip)
      this.robot.logger.debug(`IP ${ip} removed from tracking`)
    } else {
      this.connectionsByIP.set(ip, count - 1)
      this.robot.logger.debug(`IP ${ip} now has ${count - 1} connection(s)`)
    }
  }
}

export default async robot => {
  const discoveryService = new DiscoveryService(robot)
  robot.discoveryService = discoveryService
  await discoveryService.start()
  return discoveryService
}
