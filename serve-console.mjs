import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8080

const server = createServer(async (req, res) => {
    console.log(`${req.method} ${req.url}`)

    try {
        let filePath
        if (req.url === '/' || req.url === '/worker-console.html') {
            filePath = resolve(__dirname, 'worker-console.html')
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Not Found')
            return
        }

        const content = await readFile(filePath, 'utf8')
        
        res.writeHead(200, {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache'
        })
        res.end(content)
    } catch (error) {
        console.error('Error serving file:', error)
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
    }
})

server.listen(PORT, () => {
    console.log(`Worker Console server running at:`)
    console.log(`  http://localhost:${PORT}`)
    console.log(``)
    console.log(`Press Ctrl+C to stop`)
})

process.on('SIGINT', () => {
    console.log('\nShutting down server...')
    server.close(() => {
        console.log('Server closed')
        process.exit(0)
    })
})
