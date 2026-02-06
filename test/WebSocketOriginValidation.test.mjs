import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter } from 'events'

describe('WebSocket Origin Validation', () => {
  let wss
  let port

  beforeEach(async () => {
    port = 3000 + Math.floor(Math.random() * 1000)
  })

  afterEach(() => {
    if (wss) {
      wss.close()
      wss = null
    }
  })

  it('should reject connections from unauthorized origins', async () => {
    const allowedOrigins = ['http://localhost:3000', 'https://trusted-domain.com']
    
    wss = new WebSocketServer({ 
      port,
      verifyClient: (info, callback) => {
        const origin = info.origin || info.req.headers.origin
        
        if (!origin) {
          callback(true)
          return
        }
        
        if (allowedOrigins.includes(origin)) {
          callback(true)
        } else {
          callback(false, 403, 'Forbidden: Origin not allowed')
        }
      }
    })

    await new Promise(resolve => wss.on('listening', resolve))

    // Test unauthorized origin
    const unauthorizedPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`, {
        headers: {
          'Origin': 'http://malicious-site.com'
        }
      })

      ws.on('error', (error) => {
        assert.ok(error.message.includes('403') || error.message.includes('Unexpected server response'))
        resolve()
      })

      ws.on('open', () => {
        ws.close()
        reject(new Error('Connection should have been rejected'))
      })

      setTimeout(() => {
        ws.close()
        resolve()
      }, 1000)
    })

    await unauthorizedPromise
  })

  it('should accept connections from authorized origins', async () => {
    const allowedOrigins = ['http://localhost:3000', 'https://trusted-domain.com']
    
    wss = new WebSocketServer({ 
      port,
      verifyClient: (info, callback) => {
        const origin = info.origin || info.req.headers.origin
        
        if (!origin) {
          callback(true)
          return
        }
        
        if (allowedOrigins.includes(origin)) {
          callback(true)
        } else {
          callback(false, 403, 'Forbidden: Origin not allowed')
        }
      }
    })

    await new Promise(resolve => wss.on('listening', resolve))

    // Test authorized origin
    const authorizedPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`, {
        headers: {
          'Origin': 'http://localhost:3000'
        }
      })

      ws.on('error', reject)
      ws.on('open', () => {
        ws.close()
        resolve()
      })

      setTimeout(() => {
        ws.close()
        reject(new Error('Connection timeout'))
      }, 1000)
    })

    await authorizedPromise
  })

  it('should accept connections without origin header (direct WebSocket clients)', async () => {
    const allowedOrigins = ['http://localhost:3000']
    
    wss = new WebSocketServer({ 
      port,
      verifyClient: (info, callback) => {
        const origin = info.origin || info.req.headers.origin
        
        // Allow connections without origin (direct WebSocket clients)
        if (!origin) {
          callback(true)
          return
        }
        
        if (allowedOrigins.includes(origin)) {
          callback(true)
        } else {
          callback(false, 403, 'Forbidden: Origin not allowed')
        }
      }
    })

    await new Promise(resolve => wss.on('listening', resolve))

    // Test connection without origin header
    const noOriginPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`)

      ws.on('error', reject)
      ws.on('open', () => {
        ws.close()
        resolve()
      })

      setTimeout(() => {
        ws.close()
        reject(new Error('Connection timeout'))
      }, 1000)
    })

    await noOriginPromise
  })

  it('should accept all origins when wildcard is configured', async () => {
    const allowedOrigins = ['*']
    
    wss = new WebSocketServer({ 
      port,
      verifyClient: (info, callback) => {
        const origin = info.origin || info.req.headers.origin
        
        if (!origin) {
          callback(true)
          return
        }
        
        if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
          callback(true)
        } else {
          callback(false, 403, 'Forbidden: Origin not allowed')
        }
      }
    })

    await new Promise(resolve => wss.on('listening', resolve))

    // Test any origin
    const wildcardPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`, {
        headers: {
          'Origin': 'http://any-domain.com'
        }
      })

      ws.on('error', reject)
      ws.on('open', () => {
        ws.close()
        resolve()
      })

      setTimeout(() => {
        ws.close()
        reject(new Error('Connection timeout'))
      }, 1000)
    })

    await wildcardPromise
  })
})
