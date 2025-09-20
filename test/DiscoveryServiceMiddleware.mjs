import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'events'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import DiscoveryServiceScript from '../DiscoveryService.mjs'
import { TextMessage, TextListener, Robot, Adapter, Middleware} from 'hubot'


class MockAdapter extends Adapter {
  constructor (robot) {
    super(robot)
    this.name = 'MockAdapter'
  }

  async send (envelope, ...strings) {
    this.emit('send', envelope, ...strings)
  }

  async reply (envelope, ...strings) {
    this.emit('reply', envelope, ...strings)
  }

  async topic (envelope, ...strings) {
    this.emit('topic', envelope, ...strings)
  }

  async play (envelope, ...strings) {
    this.emit('play', envelope, ...strings)
  }

  run () {
    // This is required to get the scripts loaded
    this.emit('connected')
  }

  close () {
    this.emit('closed')
  }
}

describe('Incoming Message Handling as Server', () => {
  let robot
  let testDir
  let originalEnv

  beforeEach(async () => {
    // Save original environment
    originalEnv = { ...process.env }
    
    // Setup test environment with more unique directory naming
    const timestamp = Date.now()
    const random = Math.floor(Math.random() * 10000)
    testDir = join(process.cwd(), 'test-data', `message-test-${timestamp}-${random}`)
    mkdirSync(testDir, { recursive: true })
    
    process.env.HUBOT_DISCOVERY_STORAGE = testDir
    process.env.HUBOT_DISCOVERY_PORT = '0' // Use random port
    process.env.HUBOT_INSTANCE_ID = 'test-instance'
    process.env.HUBOT_HOST = 'localhost'
    process.env.HUBOT_PORT = '8080'
    process.env.NODE_ENV = 'test'
    
    robot = new Robot({
        async use(robot) {
            return new MockAdapter(robot)
        }
    }, false, 'MockityMcMockFace')
    await robot.loadAdapter()
    await robot.run()
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

    robot.shutdown()
  })

  test('Server can handle messages and not route them to the workers', async () => {
    await DiscoveryServiceScript(robot)
    let wasRouted = false
    robot.discoveryService.routeMessage = async (message) => {
      wasRouted = true
    }
    robot.respond(/handled by server/, async res => {
      await res.reply('This message was handled by the server')
      assert.ok(!wasRouted)
    })
    const testMessage = new TextMessage({ user: { id: 'U123', name: 'tester', room: 'general' } }, '@MockityMcMockFace handled by server', Date.now())
    await robot.receive(testMessage)
    assert.ok(!wasRouted)
  })
})