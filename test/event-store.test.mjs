import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import EventStore from '../event-store.mjs'

describe('EventStore', () => {
  let eventStore
  let testDir

  beforeEach(() => {
    testDir = join(process.cwd(), 'test-data', `test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
    
    eventStore = new EventStore({
      storageDir: testDir,
      snapshotInterval: 1000, // 1 second for testing
      maxEventsBeforeSnapshot: 5
    })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('should create storage directory', () => {
    assert(existsSync(testDir))
  })

  test('should append and load events', async () => {
    const event1 = { type: 'TEST_EVENT', data: 'test1' }
    const event2 = { type: 'TEST_EVENT', data: 'test2' }

    await eventStore.appendEvent(event1)
    await eventStore.appendEvent(event2)

    const events = await eventStore.loadEvents()
    
    assert.strictEqual(events.length, 2)
    assert.strictEqual(events[0].type, 'TEST_EVENT')
    assert.strictEqual(events[0].data, 'test1')
    assert.strictEqual(events[1].data, 'test2')
    assert(events[0].id)
    assert(events[0].timestamp)
  })

  test('should emit events when appended', async () => {
    let emittedEvent = null
    eventStore.on('event', (event) => {
      emittedEvent = event
    })

    const testEvent = { type: 'TEST_EVENT', data: 'test' }
    await eventStore.appendEvent(testEvent)

    assert(emittedEvent)
    assert.strictEqual(emittedEvent.type, 'TEST_EVENT')
    assert.strictEqual(emittedEvent.data, 'test')
  })

  test('should trigger snapshot after max events', async () => {
    let snapshotNeeded = false
    eventStore.on('snapshot-needed', () => {
      snapshotNeeded = true
    })

    // Append more events than the threshold
    for (let i = 0; i < 6; i++) {
      await eventStore.appendEvent({ type: 'TEST_EVENT', data: `test${i}` })
    }

    assert(snapshotNeeded)
  })

  test('should create and load snapshots', async () => {
    // Add some events
    await eventStore.appendEvent({ type: 'EVENT1', data: 'data1' })
    await eventStore.appendEvent({ type: 'EVENT2', data: 'data2' })

    // Create snapshot
    const testState = { services: { 'test-service': ['instance1'] } }
    await eventStore.createSnapshot(testState)

    // Load snapshot
    const snapshot = await eventStore.loadSnapshot()
    
    assert(snapshot)
    assert.deepStrictEqual(snapshot.state, testState)
    assert(snapshot.timestamp)
  })

  test('should handle corrupted event lines gracefully', async () => {
    const fs = await import('fs/promises')
    
    // Write valid event
    await eventStore.appendEvent({ type: 'VALID_EVENT' })
    
    // Manually append corrupted line
    await fs.writeFile(eventStore.currentEventLog, 'invalid json line\n', { flag: 'a' })
    
    // Write another valid event
    await eventStore.appendEvent({ type: 'ANOTHER_VALID_EVENT' })
    
    // Should load only valid events
    const events = await eventStore.loadEvents()
    const validEvents = events.filter(e => e.type === 'VALID_EVENT' || e.type === 'ANOTHER_VALID_EVENT')
    
    assert.strictEqual(validEvents.length, 2)
  })
})
