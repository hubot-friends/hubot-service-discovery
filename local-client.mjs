import { resolve } from 'node:path'
import Hubot from 'hubot'

const robot = Hubot.loadBot('DiscoveryService', false, 'Hubot', null)
await robot.loadAdapter('./index.mjs')
const tasks = ['./client-scripts'].map((scriptPath) => {
    if (scriptPath[0] === '/') {
        return robot.load(scriptPath)
    }
    return robot.load(resolve('.', scriptPath))
})
robot.adapter.once('connected', async () => {
    await Promise.all(tasks)
    robot.emit('scripts have loaded', robot)
})
await robot.run()

async function cleanup() {
    await robot.shutdown()
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
process.on('uncaughtException', async (error) => {
    console.error('Uncaught exception:', error)
    await cleanup()
})
