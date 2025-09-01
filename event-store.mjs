import { EventEmitter } from 'events'
import { readFile, writeFile, access, mkdir } from 'fs/promises'
import { join, dirname } from 'path'

export class EventStore extends EventEmitter {
  constructor(options = {}) {
    super()
    this.storageDir = options.storageDir || './data'
    this.snapshotInterval = options.snapshotInterval || 6 * 60 * 60 * 1000 // 6 hours
    this.maxEventsBeforeSnapshot = options.maxEventsBeforeSnapshot || 1000
    
    this.currentEventLog = join(this.storageDir, 'events.ndjson')
    this.snapshotFile = join(this.storageDir, 'snapshot.json')
    this.eventCount = 0
    this.lastSnapshotTime = Date.now()
    this.initialized = false
  }

  async initialize() {
    if (this.initialized) return
    
    try {
      await mkdir(this.storageDir, { recursive: true })
      this.initialized = true
    } catch (error) {
      console.error('Error initializing event store:', error)
      throw error
    }
  }

  async #doesExist(filePath) {
    var doesExist = false
    try {
        await access(filePath)
        doesExist = true
    } catch {
        doesExist = false
    }
    return doesExist
  }

  async appendEvent(event) {
    await this.initialize()
    
    const eventWithTimestamp = {
      ...event,
      timestamp: Date.now(),
      id: this.generateEventId()
    }

    const eventLine = JSON.stringify(eventWithTimestamp) + '\n'
    
    try {
      await writeFile(this.currentEventLog, eventLine, { flag: 'a' })
      this.eventCount++
      this.emit('event', eventWithTimestamp)
      
      // Check if we need to create a snapshot
      await this.checkSnapshotConditions()
      
      return eventWithTimestamp
    } catch (error) {
      this.emit('error', error)
      throw error
    }
  }

  async loadEventsSinceSnapshot() {
    await this.initialize()
    
    const events = []
    
    try {
      // Get snapshot timestamp to filter events
      const snapshot = await this.loadSnapshot()
      const snapshotTimestamp = snapshot ? snapshot.timestamp : 0
      
      // Load events since snapshot
      if (await this.#doesExist(this.currentEventLog)) {
        const eventData = await readFile(this.currentEventLog, 'utf-8')
        const lines = eventData.trim().split('\n').filter(line => line.trim())
        
        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            // Only include events after the snapshot
            if (event.timestamp > snapshotTimestamp) {
              events.push(event)
            }
          } catch (parseError) {
            console.error('Error parsing event line:', line, parseError)
          }
        }
      }

      this.eventCount = events.length
      return events
    } catch (error) {
      console.error('Error loading events since snapshot:', error)
      return []
    }
  }

  async loadEvents() {
    await this.initialize()
    
    const events = []
    
    try {
      // First try to load from snapshot
      const snapshot = await this.loadSnapshot()
      if (snapshot) {
        events.push(...snapshot.events)
        this.lastSnapshotTime = snapshot.timestamp
      }

      // Then load events since snapshot
      if (await this.#doesExist(this.currentEventLog)) {
        const eventData = await readFile(this.currentEventLog, 'utf-8')
        const lines = eventData.trim().split('\n').filter(line => line.trim())
        
        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            // Only include events after the snapshot
            if (!snapshot || event.timestamp > snapshot.timestamp) {
              events.push(event)
            }
          } catch (parseError) {
            console.error('Error parsing event line:', line, parseError)
          }
        }
      }

      this.eventCount = events.length
      return events
    } catch (error) {
      console.error('Error loading events:', error)
      return []
    }
  }

  async loadSnapshot() {
    await this.initialize()
    
    try {
      if (await this.#doesExist(this.snapshotFile)) {
        const snapshotData = await readFile(this.snapshotFile, 'utf-8')
        return JSON.parse(snapshotData)
      }
    } catch (error) {
      console.error('Error loading snapshot:', error)
    }
    return null
  }

  async createSnapshot(currentState) {
    await this.initialize()
    
    try {
      const snapshot = {
        timestamp: Date.now(),
        events: [], // We don't store events in snapshot, just the current state
        state: currentState
      }

      await writeFile(this.snapshotFile, JSON.stringify(snapshot, null, 2))
      
      // Archive current event log and start fresh
      const archiveFile = join(this.storageDir, `events-${Date.now()}.ndjson`)
      if (await this.#doesExist(this.currentEventLog)) {
        const eventData = await readFile(this.currentEventLog, 'utf-8')
        await writeFile(archiveFile, eventData)
        await writeFile(this.currentEventLog, '') // Clear current log
      }

      this.eventCount = 0
      this.lastSnapshotTime = Date.now()
      
      this.emit('snapshot-created', { snapshot, archiveFile })
      
    } catch (error) {
      this.emit('error', error)
      console.error('Error creating snapshot:', error)
    }
  }

  async checkSnapshotConditions() {
    const timeSinceSnapshot = Date.now() - this.lastSnapshotTime
    const shouldSnapshot = 
      timeSinceSnapshot >= this.snapshotInterval || 
      this.eventCount >= this.maxEventsBeforeSnapshot

    if (shouldSnapshot) {
      // Emit event to trigger snapshot creation with current state
      this.emit('snapshot-needed')
    }
  }

  generateEventId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }
}

export default EventStore
