import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import DiscoveryServiceScript from '../DiscoveryService.mjs'
import { TextListener } from 'hubot'

// Mock robot for testing
class MockRobot extends EventEmitter {
  constructor(name = 'test-bot') {
    super()
    this.name = name
    this.adapterName = 'shell'
    this.version = '1.0.0'
    this.logger = {
      info: mock.fn(),
      debug: mock.fn(),
      error: mock.fn(),
      warn: mock.fn()
    }
    this.DiscoveryService = null
    this.brain = {
      connectToPeer: mock.fn(),
      getPeerCount: mock.fn(() => 0)
    }
    this.listeners = []
  }

  parseHelp(fileName) {
    // Mock help parsing
  }

  respond(regex, options, callback) {
    // Mock respond method for command registration
    this.hear(regex, options, callback)
  }
  hear(regex, options, callback) {
    this.listeners.push(new TextListener(this, regex, options, callback))
  }
}

// Mock response for testing commands
class MockResponse {
  constructor() {
    this.replies = []
    this.match = null
  }

  async reply(message) {
    this.replies.push(message)
  }

  async send(message) {
    this.replies.push(message)
  }
}

describe('DiscoveryService Script', () => {
  let robot
  let testDir
  let originalEnv

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env }
    
    // Setup test environment with more unique directory naming
    const timestamp = Date.now()
    const random = Math.floor(Math.random() * 10000)
    testDir = join(process.cwd(), 'test-data', `script-test-${timestamp}-${random}`)
    mkdirSync(testDir, { recursive: true })
    
    process.env.HUBOT_DISCOVERY_STORAGE = testDir
    process.env.HUBOT_DISCOVERY_PORT = '0' // Use random port
    process.env.HUBOT_INSTANCE_ID = 'test-instance'
    process.env.HUBOT_HOST = 'localhost'
    process.env.HUBOT_PORT = '8080'
    process.env.NODE_ENV = 'test'
    
    robot = new MockRobot()
  })

  afterEach(async () => {
    // Restore environment
    process.env = originalEnv
    
    // Cleanup service discovery
    if (robot.discoveryService) {
      await robot.discoveryService.stop()
    }
    
    // Cleanup test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should initialize service discovery script', async () => {
    await DiscoveryServiceScript(robot)
    assert(robot.discoveryService, 'Should attach DiscoveryService to robot')
    assert.strictEqual(robot.discoveryService.instanceId, 'test-instance')
    assert.strictEqual(robot.discoveryService.serviceName, 'hubot')
    assert(robot.discoveryService.registry, 'Should have a registry (always a server)')
  })

  test('should register commands', async () => {
    await DiscoveryServiceScript(robot)
    
    // Check that commands were registered
    assert(robot.listeners.length > 0, 'Should have registered some commands')

    // Check for specific command regexes based on current design
    const regexes = robot.listeners.map(cmd => cmd.regex.toString())
    assert(regexes.some(r => r.includes('discover')), 'Should register discover command')
    assert(regexes.some(r => r.includes('status')), 'Should register status command')

    // Load balancer commands are always available (DiscoveryService is always a server)
    const DiscoveryService = robot.discoveryService
    if (DiscoveryService.loadBalancer) {
      assert(regexes.some(r => r.includes('load') || r.includes('lb')), 'Should register load balancer commands')
      assert(regexes.some(r => r.includes('routing')), 'Should register routing test command')
    }
  })

  test('should start as server when no discovery URL provided', async () => {
    await DiscoveryServiceScript(robot)
    
    assert(robot.discoveryService.registry, 'Should have registry (always a server)')
  })

  test('should always start as server', async () => {
    // Set discovery URL to test that it's ignored (DiscoveryService is always a server)
    process.env.HUBOT_DISCOVERY_URL = 'ws://localhost:3100'
    
    await DiscoveryServiceScript(robot)
    
    assert(robot.discoveryService.registry, 'Should still have registry (always a server)')
  })

  test('should handle discovery messages as server', async () => {
    await DiscoveryServiceScript(robot)
    
    // Start as server

    const DiscoveryService = robot.discoveryService

    // Test register message
    const registerMessage = {
      type: 'register',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-1',
        host: 'localhost',
        port: 8080,
        metadata: { version: '1.0.0' }
      }
    }

    const response = await DiscoveryService.handleDiscoveryMessage(registerMessage)
    assert.strictEqual(response.success, true)
    assert(response.message.includes('registered'))

    // Test discover message
    const discoverMessage = {
      type: 'discover',
      data: { serviceName: 'test-service' }
    }

    const discoverResponse = await DiscoveryService.handleDiscoveryMessage(discoverMessage)
    assert.strictEqual(discoverResponse.success, true)
    assert.strictEqual(discoverResponse.data.serviceName, 'test-service')
    assert(Array.isArray(discoverResponse.data.instances))
  })

  test('should handle heartbeat messages', async () => {
    await DiscoveryServiceScript(robot)
    
    // Start as server

    const DiscoveryService = robot.discoveryService

    // Register a service first
    await DiscoveryService.handleDiscoveryMessage({
      type: 'register',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-1',
        host: 'localhost',
        port: 8080
      }
    })

    // Send heartbeat
    const heartbeatResponse = await DiscoveryService.handleDiscoveryMessage({
      type: 'heartbeat',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-1'
      }
    })

    assert.strictEqual(heartbeatResponse.success, true)
  })

  test('should handle health check messages', async () => {
    await DiscoveryServiceScript(robot)
    
    // Start as server

    const DiscoveryService = robot.discoveryService

    const healthResponse = await DiscoveryService.handleDiscoveryMessage({
      type: 'health',
      data: {}
    })

    assert.strictEqual(healthResponse.success, true)
    assert.strictEqual(healthResponse.data.status, 'healthy')
    assert(typeof healthResponse.data.uptime === 'number')
    assert(typeof healthResponse.data.totalServices === 'number')
    assert(typeof healthResponse.data.totalInstances === 'number')
  })

  test('should list healthy instances when 2 out of 3 are healthy', async () => {
    await DiscoveryServiceScript(robot)

    const DiscoveryService = robot.discoveryService

    // Register 3 instances, 2 healthy and 1 unhealthy
    await DiscoveryService.handleDiscoveryMessage({
      type: 'register',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-1',
        host: 'localhost',
        port: 8080
      }
    })

    await DiscoveryService.handleDiscoveryMessage({
      type: 'register',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-2',
        host: 'localhost',
        port: 8081
      }
    })

    await DiscoveryService.handleDiscoveryMessage({
      type: 'register',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-3',
        host: 'localhost',
        port: 8082
      }
    })

    // Simulate heartbeats for only 2 instances (making the 3rd unhealthy)
    await DiscoveryService.handleDiscoveryMessage({
      type: 'heartbeat',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-1'
      }
    })

    await DiscoveryService.handleDiscoveryMessage({
      type: 'heartbeat',
      data: {
        serviceName: 'test-service',
        instanceId: 'test-instance-2'
      }
    })

    // Make test-instance-3 unhealthy by setting an old heartbeat timestamp
    const oldTimestamp = Date.now() - 70000 // 70 seconds ago (past the 60-second timeout)
    DiscoveryService.registry.instanceHeartbeats.set('test-instance-3', oldTimestamp)

    // List healthy instances using the new pattern
    const healthyInstances = DiscoveryService.registry.getHealthyInstances('test-service')
    assert.strictEqual(healthyInstances.length, 2)
    assert(healthyInstances.some(instance => instance.instanceId === 'test-instance-1'))
    assert(healthyInstances.some(instance => instance.instanceId === 'test-instance-2'))
  })

  test('should execute discover services command', async () => {
    await DiscoveryServiceScript(robot)
    
    // Start as server

    // Find the discover command
    const discoverCommand = robot.listeners.find(cmd => 
      cmd.regex.toString().includes('discover')
    )
    assert(discoverCommand, 'Should have discover command')

    // Mock response
    const res = new MockResponse()
    res.match = ['discover services', 'services']

    // Execute command
    await discoverCommand.callback(res)

    assert(res.replies.length > 0, 'Should have sent a reply')
    assert(res.replies[0].includes('services'), 'Reply should mention services')
  })

  test('should execute discovery status command', async () => {
    await DiscoveryServiceScript(robot)
    
    // Start as server

    // Find the status command
    const statusCommand = robot.listeners.find(cmd => 
      cmd.regex.toString().includes('status')
    )
    assert(statusCommand, 'Should have status command')

    // Mock response
    const res = new MockResponse()
    res.match = ['discovery status']

    // Execute command
    await statusCommand.callback(res)

    assert(res.replies.length > 0, 'Should have sent a reply')
    assert(res.replies[0].includes('Instance ID'), 'Reply should include instance ID')
    assert(res.replies[0].includes('test-instance'), 'Reply should include the test instance ID')
  })

  test('should clean up properly', async () => {
    await DiscoveryServiceScript(robot)
    
    // Start as server

    const DiscoveryService = robot.discoveryService

    // Verify everything is initialized
    assert(DiscoveryService.registry)
    assert(DiscoveryService.wss)

    // Stop and verify cleanup
    await DiscoveryService.stop()
    
    assert.strictEqual(DiscoveryService.registry, null)
    assert.strictEqual(DiscoveryService.wss, null)
    assert.strictEqual(DiscoveryService.cleanupTimer, null)
  })

  test('should handle unknown message types', async () => {
    await DiscoveryServiceScript(robot)
    
    // Start as server

    const DiscoveryService = robot.discoveryService

    try {
      await DiscoveryService.handleDiscoveryMessage({
        type: 'unknown-type',
        data: {}
      })
      assert.fail('Should have thrown an error')
    } catch (error) {
      assert(error.message.includes('Unknown message type'))
    }
  })

  test('should register self when acting as server', async () => {
    await DiscoveryServiceScript(robot)
    
    // Start as server

    const DiscoveryService = robot.discoveryService

    // Should be registered
    assert.strictEqual(DiscoveryService.isRegistered, true)

    // Should be able to discover itself
    const result = await DiscoveryService.discoverServices('hubot')
    assert(result.instances.length >= 1, 'Should find at least itself')
    
    const selfInstance = result.instances.find(i => i.instanceId === 'test-instance')
    assert(selfInstance, 'Should find itself in the registry')
    assert.strictEqual(selfInstance.host, 'localhost')
    assert.strictEqual(selfInstance.port, 8080)
  })
})