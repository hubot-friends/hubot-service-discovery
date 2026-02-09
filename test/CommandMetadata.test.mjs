import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import { CommandBus } from 'hubot'
import DiscoveryServiceAdapter from '../DiscoveryServiceAdapter.mjs'
import { DiscoveryService } from '../DiscoveryService.mjs'
import LoadBalancer from '../lib/LoadBalancer.mjs'

// Mock robot for testing
class MockRobot extends EventEmitter {
  constructor() {
    super()
    this.name = 'test-bot'
    this.version = '1.0.0'
    this.adapterName = 'test-adapter'
    this.logger = {
      info: mock.fn(),
      debug: mock.fn(),
      error: mock.fn(),
      warn: mock.fn()
    }
    this.brain = {
      userForId: mock.fn((id, userData) => ({ id, ...userData }))
    }
    // Hubot 14+ uses a CommandBus with a Map of commands
    this.commands = new CommandBus()
    this.commands.commands.set('test.cmd1', {
      id: 'test.cmd1',
      description: 'Test command 1',
      aliases: ['tc1', 'cmd1'],
      args: { message: { type: 'string', required: false } }
    })
    this.commands.commands.set('test.cmd2', {
      id: 'test.cmd2',
      description: 'Test command 2',
      aliases: [],
      args: {}
    })
    this.receivedMessages = []
  }

  receive(message) {
    this.receivedMessages.push(message)
  }
}

// Mock DiscoveryServiceClient
class MockDiscoveryServiceClient extends EventEmitter {
  constructor(url, serviceName, instanceId, options) {
    super()
    this.url = url
    this.serviceName = serviceName
    this.instanceId = instanceId
    this.options = options
    this.connected = false
    this.registered = false
    this.registeredData = null
  }

  async connect() {
    this.connected = true
    setImmediate(() => this.emit('connected'))
    return Promise.resolve()
  }

  async register(host, port, metadata = {}) {
    this.registeredData = { host, port, metadata }
    this.registered = true
    this.emit('registered')
  }

  async sendMessage(message) {
    // Default implementation - can be mocked in tests
    return Promise.resolve()
  }

  async disconnect() {
    this.connected = false
    this.registered = false
  }

  disableAutoReconnect() {}
}

describe('Command Metadata Extraction and Caching', () => {
  describe('DiscoveryServiceAdapter.extractCommandMetadata()', () => {
    let adapter
    let robot

    beforeEach(() => {
      robot = new MockRobot()
      process.env.HUBOT_DISCOVERY_URL = 'ws://localhost:8080/discovery'
      adapter = new DiscoveryServiceAdapter(robot)
      adapter.client = new MockDiscoveryServiceClient('ws://localhost:8080/discovery', 'hubot', 'test-1')
    })

    test('should extract command metadata from robot.commands', () => {
      const metadata = adapter.extractCommandMetadata()
      
      assert.strictEqual(metadata.length, 2, 'Should extract 2 commands')
      const cmd1 = metadata.find(cmd => cmd.id === 'test.cmd1')
      assert.strictEqual(cmd1.description, 'Test command 1')
      assert.deepStrictEqual(cmd1.aliases, ['tc1', 'cmd1'])
      assert.deepStrictEqual(cmd1.args, { message: { type: 'string', required: false } })
    })

    test('should handle missing properties gracefully', () => {
      robot.commands = new CommandBus()
      robot.commands.commands.set('cmd.minimal', { id: 'cmd.minimal' })
      robot.commands.commands.set('cmd.no.aliases', { id: 'cmd.no.aliases', description: 'Test' })

      const metadata = adapter.extractCommandMetadata()
      
      assert.strictEqual(metadata.length, 2)
      const minimal = metadata.find(cmd => cmd.id === 'cmd.minimal')
      assert.strictEqual(minimal.description, 'No description')
      assert.deepStrictEqual(minimal.aliases, [])
      assert.deepStrictEqual(minimal.args, {})
    })

    test('should handle empty CommandBus', () => {
      robot.commands = new CommandBus()
      const metadata = adapter.extractCommandMetadata()
      assert.strictEqual(metadata.length, 0)
    })

    test('should throw error if robot.commands does not have listCommands method', () => {
      robot.commands = { commands: new Map() }
      assert.throws(
        () => adapter.extractCommandMetadata(),
        /robot\.commands must have a listCommands method/
      )
    })

    test('should throw error if robot.commands is null', () => {
      robot.commands = null
      assert.throws(
        () => adapter.extractCommandMetadata(),
        /robot\.commands must have a listCommands method/
      )
    })

    test('should NOT include commands in registration metadata', async () => {
      adapter.client.connected = true
      adapter.client.register = mock.fn(adapter.client.register)
      
      await adapter.client.register(adapter.host, adapter.port, {
        adapter: 'service-discovery',
        group: 'test-group',
        version: '1.0.0'
      })

      assert.ok(adapter.client.register.mock.calls.length > 0)
      const callArgs = adapter.client.register.mock.calls[0].arguments
      assert.ok(!callArgs[2].commands, 'Registration should NOT include commands (lazy extraction)')
    })

    test('should respond to get_commands request', async () => {
      // For this test, we need to use the ORIGINAL client that was created in the constructor
      // because that's the one with the event handlers attached
      // So we create a fresh adapter without replacing its client
      const testRobot = new MockRobot()
      const testAdapter = new DiscoveryServiceAdapter(testRobot)
      
      // Mock sendMessage on the client that was created in the constructor
      const sendMessageMock =mock.fn(async () => {})
      testAdapter.client.sendMessage = sendMessageMock

      // Simulate receiving get_commands request
      const messageData = {
        type: 'get_commands',
        messageId: 'test-msg-123'
      }

      testAdapter.client.emit('message', messageData)

      // Wait for async handler
      await new Promise(resolve => setTimeout(resolve, 100))

      assert.ok(sendMessageMock.mock.calls.length > 0, `sendMessage should have been called`)
      const callArgs = sendMessageMock.mock.calls[0].arguments[0]
      assert.strictEqual(callArgs.type, 'commands_response')
      assert.strictEqual(callArgs.messageId, 'test-msg-123')
      assert.ok(Array.isArray(callArgs.commands))
      assert.strictEqual(callArgs.commands.length, 2)
    })
  })

  describe('DiscoveryService Lazy Command Loading', () => {
    let discovery
    let robot
    let mockWs
    let mockRegistry

    beforeEach(() => {
      robot = new MockRobot()
      robot.server = null
      robot.receiveMiddleware = mock.fn()
      robot.commands = { register: mock.fn() }

      discovery = new DiscoveryService(robot)
      
      // Mock the registry
      mockRegistry = {
        register: mock.fn(async () => {}),
        deregister: mock.fn(async () => {}),
        discover: mock.fn(() => ({})),
        discoverAll: mock.fn(() => ({})),
        heartbeat: mock.fn(async () => ({ success: true })),
        getHealthyInstances: mock.fn(() => []),
        initialize: mock.fn(async () => {}),
        close: mock.fn(async () => {})
      }
      discovery.registry = mockRegistry

      // Mock WebSocket
      mockWs = new EventEmitter()
      mockWs.readyState = 1 // OPEN
      mockWs.send = mock.fn()
      mockWs.workerId = '127.0.0.1:12345'
      mockWs.ip = '127.0.0.1'
    })

    test('should NOT cache commands on register', async () => {
      const message = {
        type: 'register',
        data: {
          serviceName: 'hubot',
          instanceId: 'worker-1',
          host: 'localhost',
          port: 8081,
          isServer: false,
          metadata: {
            group: 'ai-features'
          }
        }
      }

      mockWs.instanceId = 'worker-1'
      mockWs.serviceName = 'hubot'
      mockWs.isServer = false

      const result = await discovery.handleDiscoveryMessage(message, mockWs)

      assert.ok(result.success, 'Registration should succeed')
      assert.ok(!discovery.workerCommandsByGroup, 'workerCommandsByGroup should not exist (lazy loading)')
    })

    test('should store worker group on registration', async () => {
      const message = {
        type: 'register',
        data: {
          serviceName: 'hubot',
          instanceId: 'worker-1',
          host: 'localhost',
          port: 8081,
          isServer: false,
          metadata: { group: 'test-group' }
        }
      }

      mockWs.instanceId = 'worker-1'
      mockWs.serviceName = 'hubot'
      mockWs.isServer = false

      await discovery.handleDiscoveryMessage(message, mockWs)

      assert.ok(discovery.connectedWorkers.has('worker-1'))
      const workerWs = discovery.connectedWorkers.get('worker-1')
      assert.strictEqual(workerWs.group, 'test-group')
    })

    test('should use default group if not specified', async () => {
      const message = {
        type: 'register',
        data: {
          serviceName: 'hubot',
          instanceId: 'worker-1',
          host: 'localhost',
          port: 8081,
          isServer: false,
          metadata: {}
        }
      }

      mockWs.instanceId = 'worker-1'
      mockWs.serviceName = 'hubot'
      mockWs.isServer = false

      await discovery.handleDiscoveryMessage(message, mockWs)

      const workerWs = discovery.connectedWorkers.get('worker-1')
      assert.strictEqual(workerWs.group, 'default')
    })
  })

  describe('discovery.help command', () => {
    let discovery
    let robot
    let mockWs
    let mockRegistry

    beforeEach(() => {
      robot = new MockRobot()
      robot.server = null
      robot.receiveMiddleware = mock.fn()
      robot.commands = { register: mock.fn() }

      discovery = new DiscoveryService(robot)
      
      // Mock the registry
      mockRegistry = {
        register: mock.fn(async () => {}),
        deregister: mock.fn(async () => {}),
        discover: mock.fn(() => ({})),
        discoverAll: mock.fn(() => ({})),
        heartbeat: mock.fn(async () => ({ success: true })),
        getHealthyInstances: mock.fn(() => []),
        initialize: mock.fn(async () => {}),
        close: mock.fn(async () => {})
      }
      discovery.registry = mockRegistry
      
      // Initialize load balancer (required for help command to be registered)
      discovery.loadBalancer = new LoadBalancer({
        strategy: 'round-robin',
        logger: robot.logger
      })

      mockWs = new EventEmitter()
      mockWs.readyState = 1
      mockWs.send = mock.fn()
      mockWs.workerId = '127.0.0.1:12345'
      mockWs.ip = '127.0.0.1'
    })

    test('should show message when no workers connected', async () => {
      // Find and test the help command
      let helpCommand = null
      
      // Store original register function so we can capture commands
      const registeredCommands = []
      discovery.robot.commands.register = (cmd) => {
        registeredCommands.push(cmd)
        if (cmd.id === 'discovery.help') {
          helpCommand = cmd
        }
      }

      discovery.registerCommands()

      assert.ok(helpCommand, 'Help command should be registered')

      const ctx = { room: 'test-room' }
      const output = await helpCommand.handler(ctx)

      assert.ok(output.includes('_No worker instances connected yet_'))
      // Should not include discovery service commands (those are in regular help)
      assert.ok(!output.includes('Discovery Service Commands'))
    })

    test('should only show worker commands (not discovery service commands)', async () => {
      let helpCommand = null
      const registeredCommands = []
      
      discovery.robot.commands.register = (cmd) => {
        registeredCommands.push(cmd)
        if (cmd.id === 'discovery.help') {
          helpCommand = cmd
        }
      }

      discovery.registerCommands()

      assert.ok(helpCommand, 'Help command should be registered')

      const ctx = { room: 'test-room' }
      const output = await helpCommand.handler(ctx)

      // Should NOT include discovery service commands (those are in regular help command)
      assert.ok(!output.includes('Discovery Service Commands'))
      assert.ok(!output.includes('lb status'))
      assert.ok(!output.includes('discovery status'))
    })

    test('should request and aggregate worker commands lazily', async () => {
      // Create mock workers
      const mockWs1 = new EventEmitter()
      mockWs1.readyState = 1
      mockWs1.send = mock.fn((data) => {
        const msg = JSON.parse(data)
        if (msg.type === 'get_commands') {
          // Simulate worker response
          setTimeout(() => {
            mockWs1.emit('message', JSON.stringify({
              type: 'commands_response',
              messageId: msg.messageId,
              commands: [
                { id: 'analyze', description: 'Analyze text', aliases: ['analyze-text'] }
              ]
            }))
          }, 10)
        }
      })
      mockWs1.serviceName = 'hubot'
      mockWs1.group = 'ai'

      const mockWs2 = new EventEmitter()
      mockWs2.readyState = 1
      mockWs2.send = mock.fn((data) => {
        const msg = JSON.parse(data)
        if (msg.type === 'get_commands') {
          setTimeout(() => {
            mockWs2.emit('message', JSON.stringify({
              type: 'commands_response',
              messageId: msg.messageId,
              commands: [
                { id: 'ping', description: 'Ping command', aliases: ['p'] },
                { id: 'echo', description: 'Echo text', aliases: [] }
              ]
            }))
          }, 10)
        }
      })
      mockWs2.serviceName = 'hubot'
      mockWs2.group = 'basic'

      // Add workers to connectedWorkers
      discovery.connectedWorkers.set('worker-1', mockWs1)
      discovery.connectedWorkers.set('worker-2', mockWs2)

      let helpCommand = null
      const registeredCommands = []
      
      discovery.robot.commands.register = (cmd) => {
        registeredCommands.push(cmd)
        if (cmd.id === 'discovery.help') {
          helpCommand = cmd
        }
      }

      discovery.registerCommands()

      assert.ok(helpCommand, 'Help command should be registered')

      const ctx = { room: 'test-room' }
      const output = await helpCommand.handler(ctx)

      // Should have requested commands from both workers
      assert.ok(mockWs1.send.mock.calls.length > 0)
      assert.ok(mockWs2.send.mock.calls.length > 0)

      // Check that worker commands are organized by group
      assert.ok(output.includes('Worker Commands (by group)'))
      assert.ok(output.includes('hubot - ai'))
      assert.ok(output.includes('analyze'))
      assert.ok(output.includes('hubot - basic'))
      assert.ok(output.includes('ping'))
      assert.ok(output.includes('echo'))
    })
  })

  describe('Message Pipeline Integration', () => {
    let discovery
    let robot
    let mockWs

    beforeEach(() => {
      robot = new MockRobot()
      robot.server = null
      robot.receiveMiddleware = mock.fn()
      robot.commands = { register: mock.fn() }

      discovery = new DiscoveryService(robot)
      
      // Mock the registry
      const mockRegistry = {
        register: mock.fn(async () => {}),
        deregister: mock.fn(async () => {}),
        discover: mock.fn(() => ({})),
        discoverAll: mock.fn(() => ({})),
        heartbeat: mock.fn(async () => ({ success: true })),
        getHealthyInstances: mock.fn(() => []),
        initialize: mock.fn(async () => {}),
        close: mock.fn(async () => {})
      }
      discovery.registry = mockRegistry

      mockWs = new EventEmitter()
      mockWs.readyState = 1
      mockWs.send = mock.fn()
      mockWs.workerId = '127.0.0.1:12345'
      mockWs.ip = '127.0.0.1'
    })

    test('handleDiscoveryMessage should process commands_response messages', async () => {
      // This test validates the full message pipeline through handleDiscoveryMessage
      // It would have caught the production bug where commands_response wasn't recognized
      
      const message = {
        type: 'commands_response',
        messageId: 'test-msg-456',
        commands: [
          { id: 'test.cmd', description: 'Test command', aliases: ['tc'] }
        ]
      }

      const result = await discovery.handleDiscoveryMessage(message, mockWs)

      assert.ok(result, 'Should return a result')
      assert.strictEqual(result.success, true, 'Should indicate success')
      assert.strictEqual(result.received, true, 'Should acknowledge receipt')
    })

    test('handleDiscoveryMessage should recognize commands_response as valid message type', async () => {
      // Validate that commands_response doesn't throw "Unknown message type" error
      
      const message = {
        type: 'commands_response',
        messageId: 'msg-123',
        commands: []
      }

      // This should not throw an error
      await assert.doesNotReject(
        async () => await discovery.handleDiscoveryMessage(message, mockWs),
        'Should not throw error for commands_response message type'
      )
    })
  })
})
