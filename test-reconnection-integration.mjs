#!/usr/bin/env node

/**
 * Integration test to verify reconnection and re-registration behavior
 * Run this manually to test the actual behavior
 */

import { DiscoveryService } from './DiscoveryService.mjs'
import { EventEmitter } from 'events'

// Mock robot
const mockRobot = {
  name: 'TestBot',
  version: '1.0.0',
  adapterName: 'test-adapter',
  logger: console,
  brain: { constructor: { name: 'MemoryBrain' } },
  parseHelp: () => {},
  respond: () => {},
  messageRoom: (room, text) => console.log(`Message to ${room}: ${text}`)
}

async function testReconnectionBehavior() {
  console.log('🚀 Starting Service Discovery Server...')
  
  // Start a server instance with a random port to avoid conflicts
  const serverPort = 3100 + Math.floor(Math.random() * 1000)
  const server = new DiscoveryService(mockRobot)
  server.discoveryUrl = null // Act as server
  server.discoveryPort = serverPort
  await server.start()
  
  console.log('✅ Server started on port', server.discoveryPort)
  
  // Wait a moment
  await new Promise(resolve => setTimeout(resolve, 1000))
  
  console.log('🔌 Starting Client instance...')
  
  // Configure client to connect to server via environment variable
  process.env.HUBOT_DISCOVERY_URL = `http://localhost:${serverPort}`
  
  // Start a client instance
  const clientRobot = {
    ...mockRobot,
    logger: {
      ...mockRobot.logger,
      info: (msg) => console.log('[CLIENT]', msg),
      warn: (msg) => console.log('[CLIENT WARN]', msg),
      error: (msg) => console.log('[CLIENT ERROR]', msg),
      debug: (msg) => console.log('[CLIENT DEBUG]', msg)
    }
  }
  const client = new DiscoveryService(clientRobot)
  client.instanceId = 'test-client-123'
  client.port = 8080 // Client port
  await client.start()
  
  console.log('✅ Client connected and should register as client')
  
  // Wait to see the registration
  await new Promise(resolve => setTimeout(resolve, 3000))
  
  console.log('📋 Checking registered services...')
  const services = server.registry.discoverAll()
  console.log('Services:', Object.keys(services))
  console.log('Hubot instances:', services.hubot?.length || 0)
  if (services.hubot) {
    services.hubot.forEach(instance => {
      console.log(`  - ${instance.instanceId} (${instance.host}:${instance.port})`)
    })
  }
  
  console.log('💥 Simulating server restart...')
  
  // Stop the server (simulating a restart)
  await server.stop()
  console.log('🔄 Server stopped, waiting 2 seconds then starting new server instance...')
  await new Promise(resolve => setTimeout(resolve, 2000))
  
  // Start a new server instance (simulating restart)
  const newServer = new DiscoveryService(mockRobot)
  newServer.discoveryUrl = null // Act as server
  newServer.discoveryPort = serverPort // Use same port
  await newServer.start()
  
  console.log('✅ New server instance started')
  
  // Wait for client to reconnect and re-register
  console.log('⏳ Waiting for client to reconnect and re-register...')
  await new Promise(resolve => setTimeout(resolve, 10000))
  
  console.log('📋 Checking services after reconnection...')
  const servicesAfterReconnect = newServer.registry.discoverAll()
  console.log('Services after reconnect:', Object.keys(servicesAfterReconnect))
  console.log('Hubot instances after reconnect:', servicesAfterReconnect.hubot?.length || 0)
  if (servicesAfterReconnect.hubot) {
    servicesAfterReconnect.hubot.forEach(instance => {
      console.log(`  - ${instance.instanceId} (${instance.host}:${instance.port})`)
    })
  }
  
  if (servicesAfterReconnect.hubot && servicesAfterReconnect.hubot.length > 0) {
    const clientInstance = servicesAfterReconnect.hubot.find(h => h.instanceId === 'test-client-123')
    if (clientInstance) {
      console.log('✅ SUCCESS: Client successfully reconnected and re-registered!')
      console.log('Client instance:', clientInstance.instanceId)
    } else {
      console.log('❌ FAILED: Client instance not found after reconnect')
      console.log('Available instances:', servicesAfterReconnect.hubot.map(h => h.instanceId))
    }
  } else {
    console.log('❌ FAILED: No hubot instances found after reconnect')
  }
  
  // Clean up
  console.log('🧹 Cleaning up...')
  await client.stop()
  await newServer.stop()
  console.log('✅ Test completed')
}

// Run the test
testReconnectionBehavior().catch(console.error)
