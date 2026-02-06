import { EventEmitter } from 'events'

export default class DiscoveryServiceClient extends EventEmitter {
  constructor(discoveryUrl, serviceName, instanceId, options = {}) {
    super()
    this.discoveryUrl = discoveryUrl
    this.serviceName = serviceName
    this.instanceId = instanceId
    this.host = options.host || 'localhost'
    this.port = options.port || 8080
    this.headers = options.headers || {}
    this.heartbeatInterval = options.heartbeatInterval || 15000
    this.metadata = options.metadata || {}
    this.WebSocketClass = options.WebSocketClass || null // Allow injecting WebSocket class for testing
    this.token = options.token || process.env.HUBOT_DISCOVERY_TOKEN || null // Authentication token
    
    // Reconnection configuration
    this.autoReconnect = options.autoReconnect !== false // Default to true
    this.reconnectInterval = options.reconnectInterval || parseInt(process.env.HUBOT_DISCOVERY_RECONNECT_INTERVAL || 5000)
    this.maxReconnectAttempts = options.maxReconnectAttempts || parseInt(process.env.HUBOT_DISCOVERY_MAX_RECONNECT_ATTEMPTS || 0) // 0 = infinite
    this.reconnectAttempts = 0
    
    this.ws = null
    this.heartbeatTimer = null
    this.reconnectTimer = null
    this.connected = false
    this.intentionalDisconnect = false // Track if disconnect was intentional
    this.registered = false // Track if we've successfully registered
    this.autoRegister = options.autoRegister === true // Auto-register on connect/reconnect (disabled by default)
  }

  async connect() {
    if (this.connected) {
      return
    }

    // Clear any existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    try {
      // Use injected WebSocket class for testing, or import ws for production
      const WebSocketConstructor = this.WebSocketClass || (await import('ws')).default
      // Convert HTTP(S) URLs to WS(S), but leave WS URLs as-is
      const wsUrl = this.discoveryUrl.startsWith('http') ? this.discoveryUrl.replace(/^http/, 'ws') : this.discoveryUrl
      this.ws = new WebSocketConstructor(wsUrl, { headers: this.headers })

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'))
        }, 10000)

        this.ws.on('open', () => {
          clearTimeout(timeout)
          this.connected = true
          this.reconnectAttempts = 0 // Reset reconnect attempts on successful connection
          this.startHeartbeat()
          this.emit('connected')
          resolve()
        })

        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString())
            this.handleMessage(message)
          } catch (error) {
            this.emit('error', new Error(`Failed to parse message: ${error.message}`))
          }
        })

        this.ws.on('close', (code, reason) => {
          const wasConnected = this.connected
          this.connected = false
          this.registered = false // Clear registration state on disconnect
          this.stopHeartbeat()
          
          const disconnectInfo = { code, reason: reason.toString() }
          this.emit('disconnected', disconnectInfo)
          
          // Attempt reconnection if it wasn't an intentional disconnect and auto-reconnect is enabled
          if (wasConnected && !this.intentionalDisconnect && this.autoReconnect) {
            this.scheduleReconnect()
          }
        })

        this.ws.on('error', (error) => {
          clearTimeout(timeout)
          this.emit('error', error)
          
          // If we weren't connected yet, this is a connection failure
          if (!this.connected && this.autoReconnect && !this.intentionalDisconnect) {
            this.scheduleReconnect()
          }
          
          reject(error)
        })
      })
    } catch (error) {
      this.emit('error', error)
      
      // Schedule reconnect on connection failure
      if (this.autoReconnect && !this.intentionalDisconnect) {
        this.scheduleReconnect()
      }
      
      throw error
    }
  }

  async register(host, port, metadata = {}) {
    if (!this.connected) {
      throw new Error('Not connected to service discovery')
    }

    const registerMessage = {
      type: 'register',
      token: this.token || undefined,
      data: {
        serviceName: this.serviceName,
        instanceId: this.instanceId,
        host: host || this.host,
        port: port || this.port,
        isServer: metadata.isServer || false,
        metadata: { ...this.metadata, ...metadata }
      }
    }

    await this.sendMessage(registerMessage)
    this.registered = true
    this.emit('registered')
  }

  async deregister() {
    if (!this.connected) {
      return
    }

    const deregisterMessage = {
      type: 'deregister',
      data: {
        serviceName: this.serviceName,
        instanceId: this.instanceId
      }
    }

    try {
      await this.sendMessage(deregisterMessage)
      this.registered = false
      this.emit('deregistered')
    } catch (error) {
      // Log error but don't throw to prevent issues during cleanup
      this.emit('error', new Error(`Deregistration failed: ${error.message}`))
    }
  }

  async discoverServices(serviceName = null) {
    if (!this.connected) {
      throw new Error('Not connected to service discovery')
    }

    const discoveryMessage = {
      type: 'discover',
      data: {
        serviceName: serviceName
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discovery request timeout'))
      }, 5000)

      const responseHandler = (response) => {
        if (response.type === 'discover_response') {
          clearTimeout(timeout)
          this.removeListener('response', responseHandler)
          resolve(response.data)
        }
      }

      this.on('response', responseHandler)
      this.sendMessage(discoveryMessage)
    })
  }

  async sendMessage(message) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) { // 1 = OPEN
      throw new Error('Not connected to service discovery')
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws.send(JSON.stringify(message), (error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  handleMessage(message) {
    switch (message.type) {
      case 'message':
        // Forward messages from the service discovery to the robot
        this.emit('message', message.data)
        break
      case 'discover_response':
      case 'register_response':
      case 'deregister_response':
        this.emit('response', message)
        break
      case 'health_check':
        // Respond to health checks
        this.sendMessage({
          type: 'health_response',
          data: {
            instanceId: this.instanceId,
            status: 'healthy',
            timestamp: Date.now()
          }
        })
        break
      default:
        this.emit('unknown_message', message)
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.connected && this.ws && this.ws.readyState === 1) { // 1 = OPEN
        const heartbeatMessage = {
          type: 'heartbeat',
          data: {
            serviceName: this.serviceName,
            instanceId: this.instanceId
          }
        }
        
        this.sendMessage(heartbeatMessage).catch((error) => {
          this.emit('error', new Error(`Heartbeat failed: ${error.message}`))
        })
      }
    }, this.heartbeatInterval)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  scheduleReconnect() {
    // Check if we've exceeded max reconnect attempts (if configured)
    if (this.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', new Error(`Max reconnection attempts (${this.maxReconnectAttempts}) exceeded`))
      return
    }

    // Clear any existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }

    this.reconnectAttempts++
    
    // Calculate backoff interval (exponential backoff with jitter)
    const baseInterval = this.reconnectInterval
    const backoffMultiplier = Math.min(this.reconnectAttempts, 10) // Cap at 10x
    const jitter = Math.random() * 1000 // Add up to 1 second of jitter
    const interval = baseInterval * backoffMultiplier + jitter

    this.emit('reconnecting', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      interval: Math.round(interval)
    })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(error => {
        // connect() will handle scheduling the next reconnect attempt
        this.emit('error', new Error(`Reconnection attempt ${this.reconnectAttempts} failed: ${error.message}`))
      })
    }, interval)
  }

  stopReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts = 0
  }

  async disconnect() {
    // Mark this as an intentional disconnect to prevent auto-reconnect
    this.intentionalDisconnect = true
    
    this.stopHeartbeat()
    this.stopReconnect()
    
    if (this.connected && this.registered) {
      try {
        await this.deregister()
      } catch (error) {
        // Log the error but don't prevent disconnection
        this.emit('error', new Error(`Failed to deregister during disconnect: ${error.message}`))
      }
    }
    
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    
    this.connected = false
    this.registered = false
  }

  // Method to enable auto-reconnect after intentional disconnect
  enableAutoReconnect() {
    this.intentionalDisconnect = false
  }

  // Method to disable auto-reconnect
  disableAutoReconnect() {
    this.autoReconnect = false
    this.stopReconnect()
  }
}
