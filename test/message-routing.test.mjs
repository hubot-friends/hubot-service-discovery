import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import LoadBalancer from '../lib/load-balancer.mjs'

// Mock registry for testing
class MockServiceRegistry extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.services = {}
    this.heartbeatTimeoutMs = options?.heartbeatTimeoutMs || 30000
  }

  async register(serviceName, data) {
    if (!this.services[serviceName]) {
      this.services[serviceName] = { instances: [] }
    }
    this.services[serviceName].instances.push(data)
  }

  discover(serviceName) {
    return this.services[serviceName] || { instances: [] }
  }

  discoverAll() {
    return this.services
  }

  getHealthyInstances(serviceName) {
    const serviceData = this.services[serviceName] || { instances: [] }
    // For testing, assume all instances are healthy and filter out servers
    return serviceData.instances.filter(instance => !instance.isServer)
  }
}

// Mock message routing class to test the functionality
class MessageRouter {
  constructor() {
    this.registry = new MockServiceRegistry({ heartbeatTimeoutMs: 30000 })
    this.loadBalancer = new LoadBalancer({ strategy: 'round-robin' })
    this.connectedClients = new Map()
    this.pendingResponses = new Map()
  }

  async routeMessage(messageData) {
    try {
      // Get healthy instances from registry (simulate the new pattern)
      const healthyInstances = this.registry.getHealthyInstances('hubot')
      const selectedInstance = this.loadBalancer.selectInstance(healthyInstances)
      
      if (!selectedInstance) {
        return { 
          success: false, 
          error: 'No healthy instances available',
          shouldProcessLocally: true
        }
      }

      const clientWs = this.connectedClients.get(selectedInstance.instanceId)
      
      if (!clientWs || clientWs.readyState !== 1) {
        return { 
          success: false, 
          error: 'Client connection not available',
          shouldProcessLocally: true
        }
      }

      const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      messageData.messageId = messageId

      this.pendingResponses.set(messageId, {
        timestamp: Date.now(),
        originalMessage: messageData,
        selectedInstance: selectedInstance.instanceId
      })

      const routedMessage = {
        type: 'message',
        data: messageData
      }

      clientWs.send(JSON.stringify(routedMessage))
      
      return { 
        success: true, 
        routedTo: selectedInstance.instanceId,
        messageId: messageId
      }
      
    } catch (error) {
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
      return { success: false, error: 'Missing messageId' }
    }

    const pendingMessage = this.pendingResponses.get(messageId)
    
    if (!pendingMessage) {
      return { success: false, error: 'Unknown messageId' }
    }

    this.pendingResponses.delete(messageId)
    
    return { success: true, processed: true }
  }

  cleanupPendingResponses() {
    const now = Date.now()
    const timeout = 30000 // 30 seconds timeout
    
    for (const [messageId, pendingMessage] of this.pendingResponses.entries()) {
      if (now - pendingMessage.timestamp > timeout) {
        this.pendingResponses.delete(messageId)
      }
    }
  }
}

// Mock WebSocket
class MockWebSocket extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1 // OPEN
    this.sentMessages = []
  }

  send(data) {
    this.sentMessages.push(JSON.parse(data))
  }
}

describe('Load Balancing Message Routing', () => {
  let messageRouter
  let mockLogger

  beforeEach(() => {
    mockLogger = {
      info: mock.fn(),
      debug: mock.fn(),
      error: mock.fn(),
      warn: mock.fn()
    }
    
    messageRouter = new MessageRouter()
    messageRouter.loadBalancer.logger = mockLogger
  })

  describe('Message Routing', () => {
    test('should route message to available instance', async () => {
      // Register a client instance
      await messageRouter.registry.register('hubot', {
        serviceName: 'hubot',
        instanceId: 'client-1',
        isServer: false,
        host: 'localhost',
        port: 8081,
        lastHeartbeat: Date.now()
      })

      // Mock WebSocket connection
      const mockWs = new MockWebSocket()
      messageRouter.connectedClients.set('client-1', mockWs)

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      const result = await messageRouter.routeMessage(messageData)

      assert.strictEqual(result.success, true)
      assert.strictEqual(result.routedTo, 'client-1')
      assert(result.messageId)

      // Check that message was sent to client
      assert.strictEqual(mockWs.sentMessages.length, 1)
      assert.strictEqual(mockWs.sentMessages[0].type, 'message')
      assert.strictEqual(mockWs.sentMessages[0].data.text, 'Hello world')
    })

    test('should return error when no healthy instances available', async () => {
      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      const result = await messageRouter.routeMessage(messageData)

      assert.strictEqual(result.success, false)
      assert.strictEqual(result.shouldProcessLocally, true)
      assert(result.error.includes('No healthy instances available'))
    })

    test('should return error when client connection not available', async () => {
      // Register instance but don't add WebSocket connection
      await messageRouter.registry.register('hubot', {
        serviceName: 'hubot',
        instanceId: 'client-1',
        isServer: false,
        lastHeartbeat: Date.now()
      })

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      const result = await messageRouter.routeMessage(messageData)

      assert.strictEqual(result.success, false)
      assert.strictEqual(result.shouldProcessLocally, true)
      assert(result.error.includes('Client connection not available'))
    })

    test('should handle multiple instances with round-robin', async () => {
      // Register multiple client instances
      await messageRouter.registry.register('hubot', {
        serviceName: 'hubot',
        instanceId: 'client-1',
        isServer: false,
        lastHeartbeat: Date.now()
      })
      await messageRouter.registry.register('hubot', {
        serviceName: 'hubot',
        instanceId: 'client-2',
        isServer: false,
        lastHeartbeat: Date.now()
      })

      // Mock WebSocket connections
      const mockWs1 = new MockWebSocket()
      const mockWs2 = new MockWebSocket()
      messageRouter.connectedClients.set('client-1', mockWs1)
      messageRouter.connectedClients.set('client-2', mockWs2)

      const messageData = {
        user: { id: 'user1', name: 'Test User' },
        text: 'Hello world',
        room: 'general'
      }

      // First message should go to client-1
      const result1 = await messageRouter.routeMessage(messageData)
      assert.strictEqual(result1.routedTo, 'client-1')

      // Second message should go to client-2
      const result2 = await messageRouter.routeMessage(messageData)
      assert.strictEqual(result2.routedTo, 'client-2')

      // Third message should go back to client-1
      const result3 = await messageRouter.routeMessage(messageData)
      assert.strictEqual(result3.routedTo, 'client-1')
    })
  })

  describe('Message Response Handling', () => {
    test('should handle message response successfully', () => {
      const messageId = 'test-msg-123'
      
      // Add pending response
      messageRouter.pendingResponses.set(messageId, {
        timestamp: Date.now(),
        originalMessage: { text: 'Hello' },
        selectedInstance: 'client-1'
      })

      const responseData = {
        messageId: messageId,
        text: 'Hello back!',
        room: 'general',
        user: { id: 'bot', name: 'Hubot' }
      }

      const result = messageRouter.handleMessageResponse(responseData)

      assert.strictEqual(result.success, true)
      assert.strictEqual(result.processed, true)

      // Check that pending response was cleaned up
      assert.strictEqual(messageRouter.pendingResponses.has(messageId), false)
    })

    test('should handle response without messageId', () => {
      const responseData = {
        text: 'Hello back!',
        room: 'general'
      }

      const result = messageRouter.handleMessageResponse(responseData)

      assert.strictEqual(result.success, false)
      assert(result.error.includes('Missing messageId'))
    })

    test('should handle response for unknown messageId', () => {
      const responseData = {
        messageId: 'unknown-msg-123',
        text: 'Hello back!',
        room: 'general'
      }

      const result = messageRouter.handleMessageResponse(responseData)

      assert.strictEqual(result.success, false)
      assert(result.error.includes('Unknown messageId'))
    })
  })

  describe('Pending Response Cleanup', () => {
    test('should clean up expired pending responses', () => {
      const now = Date.now()
      const oldTime = now - 60000 // 60 seconds ago

      // Add some pending responses
      messageRouter.pendingResponses.set('fresh-msg', {
        timestamp: now,
        originalMessage: { text: 'Fresh' },
        selectedInstance: 'client-1'
      })
      messageRouter.pendingResponses.set('old-msg', {
        timestamp: oldTime,
        originalMessage: { text: 'Old' },
        selectedInstance: 'client-1'
      })

      assert.strictEqual(messageRouter.pendingResponses.size, 2)

      messageRouter.cleanupPendingResponses()

      // Only fresh message should remain
      assert.strictEqual(messageRouter.pendingResponses.size, 1)
      assert.strictEqual(messageRouter.pendingResponses.has('fresh-msg'), true)
      assert.strictEqual(messageRouter.pendingResponses.has('old-msg'), false)
    })
  })
})
