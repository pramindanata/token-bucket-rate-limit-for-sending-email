const dotenv = require('dotenv')
dotenv.config()

const Redis = require("ioredis")

async function main() {
    const redis = new Redis({
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT,
        password: process.env.REDIS_PASSWORD,
    })

    const config = {
        redis,
        emails: [
            {
                name: 'emailA',
                limit: 5,
                refillCount: 2,
                refillIntervalMs: 30 * 1000,
            },
            // {
            //     name: 'emailB',
            //     limit: 5,
            //     refillCount: 3,
            //     refillIntervalMs: 5 * 1000,
            // },
            // {
            //     name: 'emailC',
            //     limit: 5,
            //     refillCount: 2,
            //     refillIntervalMs: 2 * 1000,
            // }
        ]
    }

    // await deleteAllKeys(redis, config)

    const rateLimiter = new RateLimiter(config)
    await rateLimiter.start()

    await Promise.allSettled([
        runScenario(rateLimiter, 'emailA'),
        // runScenario(rateLimiter, 'emailB'),
        // runScenario(rateLimiter, 'emailC'),
    ])
}

async function runScenario(rateLimiter, key) {
    await consume(1, rateLimiter, key)
    await consume(2, rateLimiter, key)
    await consume(3, rateLimiter, key)
    await consume(4, rateLimiter, key)
    await consume(5, rateLimiter, key)
    await consume(6, rateLimiter, key)

    logWithTimestamp(`${key} - Sleep for 5s`)
    await sleep(5000)

    // await consume(7, rateLimiter, key)
    // await consume(8, rateLimiter, key)
    // await consume(9, rateLimiter, key)
    // await consume(10, rateLimiter, key)
    // await consume(11, rateLimiter, key)
    // await consume(12, rateLimiter, key)

    // logWithTimestamp(`${key} - Sleep for 5s`)
    // await sleep(5000)

    // await consume(13, rateLimiter, key)
    // await consume(14, rateLimiter, key)
    // await consume(15, rateLimiter, key)
    // await consume(16, rateLimiter, key)
    // await consume(17, rateLimiter, key)
    // await consume(18, rateLimiter, key)

    logWithTimestamp(`${key} - Finish`)
} 

async function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

async function consume(id, rateLimiter, email) {
    const result = await rateLimiter.consumeToken(email)

    logWithTimestamp({ id: 
        `${email}-${id}`, 
        result, 
        tokens: await rateLimiter.redis.hget(`rate-limiter:${email}`, 'tokens') 
    })
}

async function logWithTimestamp(data) {
    console.log(`${new Date().toISOString()} -`, data)
}

class RateLimiter {
    constructor(config) {
        this.redis = config.redis
        this.emails = config.emails
        this.prefix = 'rate-limiter'
    }

    async start() {
        const currentTimestamp = new Date()

        for (const email of this.emails) {
            // TODO lock start so only 1 process can start
            const key = this.generateKey(email.name)
            let finalEmailConfig = await this.redis.hgetall(key)
            let initialTimeout = 0

            if (Object.keys(finalEmailConfig).length === 0) {
                finalEmailConfig =  this.generateInitialConfig(email)
                initialTimeout = finalEmailConfig.refillIntervalMs

                await this.redis.hset(key, finalEmailConfig)
            } else {
                initialTimeout = parseInt(finalEmailConfig.refillIntervalMs) - (currentTimestamp - new Date(finalEmailConfig.refilledAt))
    
                if (initialTimeout < 0) {
                    initialTimeout = 0
                }
            }

            let refillTokenIntervalFunction = null
            let needToResetInitialTimeout = true

            // Use timeout for the first refill to avoid it running many times if the interval is too short
            refillTokenIntervalFunction = setTimeout(() => {
                return this.refillTokens({
                    config: finalEmailConfig,
                    onSuccess: async () => {
                        if (needToResetInitialTimeout) {
                            logWithTimestamp(`${finalEmailConfig.name} - RESET INTERVAL`)
                            clearInterval(refillTokenIntervalFunction)

                            needToResetInitialTimeout = false
                            refillTokenIntervalFunction = setInterval(
                                () => this.refillTokens({ config: finalEmailConfig }), 
                                finalEmailConfig.refillIntervalMs,
                            )
                        }
                    }
                })
            }, initialTimeout)
        }
    }

    async refillTokens(props) {
        const {
            config,
            onSuccess
        } = props

        logWithTimestamp(`${config.name} - REFILL TOKENS`)

        const lockKey = this.generateRefillLockKey(config.name)
        const lockExpirationTimeMs = 20 * 1000 
        const lock = await this.redis.set(lockKey, "lock", 'NX', 'PX', lockExpirationTimeMs)
        
        if (lock !== 'OK') {
            logWithTimestamp("OTHER PROCESS IS REFILLING TOKENS")
            return
        }

        const stateKey = this.generateKey(config.name)
        const state = await this.redis.hgetall(stateKey)
        let configKeyCount = Object.keys(config).length 

        if (Object.keys(state).length < configKeyCount) {
            logWithTimestamp("STATE IS EMPTY WHILE REFILLING")

            await this.redis.hset(stateKey, this.generateInitialConfig(config))
        } else {
            let newCurrentLimit = parseInt(state.refillCount) + parseInt(state.tokens)

            if (parseInt(state.tokens) < 0) {
                newCurrentLimit = parseInt(state.refillCount)
            }

            if (newCurrentLimit > parseInt(state.limit)) {
                newCurrentLimit = parseInt(state.limit)
            }

            await this.redis.hset(stateKey, 'tokens', newCurrentLimit, 'refilledAt', new Date().toISOString())
        }

        await this.redis.del(lockKey)
        await onSuccess()
    }

    generateInitialConfig(config) {
        return {
            name: config.name,
            limit: config.limit,
            tokens: config.limit,
            refillCount: config.refillCount,
            refillIntervalMs: config.refillIntervalMs,
            refilledAt: new Date().toISOString()
        }
    }

    generateKey(key) {
        return `${this.prefix}:${key}`
    }

    generateRefillLockKey(key) {
        return `${this.prefix}:${key}:refill`
    }

    async consumeToken(key) {
        // TODO cek lock refill, jika ada maka pause
        const refillLockReleased = await this.isRefillLockReleased(key)

        if (!refillLockReleased) {
            logWithTimestamp("CANT CONSUME. LOCKED BY REFILL.")

            return false
        }
        
        // ALlow decrement below 0 to keep this increment process simple & atomic
        const result = await this.redis.hincrby(this.generateKey(key), 'tokens', -1)

        if (result === 0) {
            // TODO emit event "tokensDepleted" jika count adalah 0
        }

        if (result < 0) {
            return false
        }

        return true
    }

    async isRefillLockReleased(key) {
        const maxAttempts = 5
        const initialSleepMs = 100
        let attempts = 0 
        
        async function check() {
            const lockKey = this.generateRefillLockKey(key)
            const lock = await this.redis.get(lockKey)

            if (lock === 'lock') {
                if (attempts >= maxAttempts) {
                    return false
                }

                attempts += 1
                await sleep(initialSleepMs * 2)
                return check.apply(this, [])
            }

            return true
        }

        return check.apply(this, [])
    }
}

async function deleteAllKeys(redis, config) {
    for (const email of config.emails) {
        await redis.del(`rate-limiter:${email.name}`)
    }
}

main().then(() => {
    process.exit(0)
}).catch((err) => {
    console.error(err)
    process.exit(1)
})