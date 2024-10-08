const dotenv = require('dotenv')
dotenv.config()

const crypto = require('crypto')
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
                refillIntervalMs: 5 * 1000,
            }
        ]
    }

    await deleteAllKeys(redis, config)

    const rateLimiter = new RateLimiter(config)
    await rateLimiter.start()

    await consume(1, rateLimiter, 'emailA')
    await consume(2, rateLimiter, 'emailA')
    await consume(3, rateLimiter, 'emailA')
    await consume(4, rateLimiter, 'emailA')
    await consume(5, rateLimiter, 'emailA')
    await consume(6, rateLimiter, 'emailA')

    logWithTimestamp("Sleep for 5s")
    await sleep(5000)

    await consume(7, rateLimiter, 'emailA')
    await consume(8, rateLimiter, 'emailA')
    await consume(9, rateLimiter, 'emailA')
    await consume(10, rateLimiter, 'emailA')
    await consume(11, rateLimiter, 'emailA')
    await consume(12, rateLimiter, 'emailA')

    logWithTimestamp("Sleep for 5s")
    await sleep(5000)

    await consume(13, rateLimiter, 'emailA')
    await consume(14, rateLimiter, 'emailA')
    await consume(15, rateLimiter, 'emailA')

    logWithTimestamp("Finish")
}

async function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

async function consume(id, rateLimiter, email) {
    const result = await rateLimiter.consumeToken(email)

    logWithTimestamp({ id, result, tokens: await rateLimiter.redis.hget(`rate-limiter:${email}`, 'tokens') })
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
        for (const email of this.emails) {
            const key = this.generateKey(email.name)
            const value = await this.redis.hgetall(key)
            let finalEmailConfig = null

            if (Object.keys(value).length === 0) {
                finalEmailConfig =  {
                    limit: email.limit,
                    tokens: email.limit,
                    refillCount: email.refillCount,
                    refillIntervalMs: email.refillIntervalMs,
                    refilledAt: new Date().toISOString()
                }

                await this.redis.hset(key, finalEmailConfig)
            }
            
            // TODO semisal ada n replica maka perlu 1 aja yg bisa refill token

            let refillTokenIntervalFunction = null
            let needToResetRefillInitialInterval = true

            async function refillToken() {
                logWithTimestamp("REFILL TOKENS")

                // TODO pakai transaction dan pasang lock supaya consume token yg lain pause.
                const lockKey = this.generateRefillLockKey(email.name)
                const lockExpirationTimeMs = 5 * 1000 
                const lock = await this.redis.set(lockKey, "lock", 'NX', 'PX', lockExpirationTimeMs)
                
                if (lock !== 'OK') {
                    logWithTimestamp("OTHER PROCESS IS REFILLING TOKENS")
                    return
                }

                const state = await this.redis.hgetall(key)

                if (Object.keys(state).length === 0) {
                    logWithTimestamp("STATE IS EMPTY WHILE REFILLING")
                    // TODO reset if the value is empty. Edge case
                    return
                }

                let newCurrentLimit = parseInt(state.refillCount) + parseInt(state.tokens)

                if (parseInt(state.tokens) < 0) {
                    newCurrentLimit = parseInt(state.refillCount)
                }

                if (newCurrentLimit > parseInt(state.limit)) {
                    newCurrentLimit = parseInt(state.limit)
                }

                await this.redis.hset(key, 'tokens', newCurrentLimit, 'refilledAt', new Date().toISOString())
                await this.redis.del(this.generateRefillLockKey(email.name))

                if (needToResetRefillInitialInterval) {
                    logWithTimestamp("RESET INTERVAL")
                    clearInterval(refillTokenIntervalFunction)
                    needToResetRefillInitialInterval = false
                    refillTokenIntervalFunction = setInterval(refillToken.bind(this), finalEmailConfig.refillIntervalMs)
                }
            }

            let initialInterval = (new Date() - new Date(finalEmailConfig.refilledAt)) - finalEmailConfig.refillIntervalMs

            if (initialInterval <= 0) {
                initialInterval = finalEmailConfig.refillIntervalMs
                needToResetRefillInitialInterval = false
            }

            refillTokenIntervalFunction = setInterval(refillToken.bind(this), initialInterval)
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
        const refillLockReleased = await this.isRefillLockReleased()

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
                return check()
            }

            return true
        }

        return check.bind(this)()
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