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
                limit: 10,
                durationBeforeResetMs: 5 * 1000,
            }
        ]
    }

    await deleteAllKeys(redis, config)

    const rateLimiter = new RateLimiter(config)
    await rateLimiter.start()

    for (let i = 0; i < 13; i++) {
        const result = await rateLimiter.consumeToken('emailA')
        console.log({result})
    }

    console.log("Sleep for 5s")
    await sleep(5000)

    for (let i = 0; i < 13; i++) {
        const result = await rateLimiter.consumeToken('emailA')
        console.log({result})
    }

    console.log("YEET")
}

async function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

// TODO handle read/write perlu atomic. Perlu buat proses untuk atomic write
// TODO handle key perlu ada expiration time dan proses untuk refresh exp time-nya.
class RateLimiter {
    constructor(config) {
        this.redis = config.redis
        this.emails = config.emails
        this.prefix = 'rate-limiter'
    }

    async start() {
        // TODO check if all keys are present and set if 
        for (const email of this.emails) {
            const key = this.generateKey(email.name)
            const value = await this.redis.hgetall(key)
            let finalEmailConfig = null

            if (Object.keys(value).length === 0) {
                finalEmailConfig =  {
                    limit: email.limit,
                    durationBeforeResetMs: email.durationBeforeResetMs,
                    status: 'active',
                    refilledAt: new Date().toISOString()
                }

                await this.redis.hset(key, finalEmailConfig)
            }

            // TODO start interval untuk refill token per konfig. Perlu cek jumlah token yg tersisa dari redis
            // TODO hmm interval perlu ditentukan dari refill terakhir. Ini untuk handle semisal service restart. Biar engga kejauhan waktu refill berikutnya
            // semisal sebelumnya sempat refill

            let refillTokenIntervalFunction = null
            let needToResetRefillInitialInterval = true

            async function refillToken() {
                console.log("REFILL TOKENS")

                // TODO refill token
                const state = await this.redis.hgetall(key)

                if (Object.keys(state).length === 0) {
                    // TODO reset if the value is empty. Edge case
                }

                await this.redis.hset(key, 'limit', finalEmailConfig.limit, 'refilledAt', new Date().toISOString())

                if (needToResetRefillInitialInterval) {
                    console.log("RESET INTERVAL")
                    clearInterval(refillTokenIntervalFunction)
                    needToResetRefillInitialInterval = false
                    refillTokenIntervalFunction = setInterval(refillToken.bind(this), finalEmailConfig.durationBeforeResetMs)
                }
            }

            let initialInterval = (new Date() - new Date(finalEmailConfig.refilledAt)) - finalEmailConfig.durationBeforeResetMs

            if (initialInterval <= 0) {
                initialInterval = finalEmailConfig.durationBeforeResetMs
                needToResetRefillInitialInterval = false
            }

            refillTokenIntervalFunction = setInterval(refillToken.bind(this), initialInterval)
        }

    }

    generateKey(key) {
        return `${this.prefix}:${key}`
    }

    async consumeToken(key) {
        // TODO decrement token count. If count less than 0, return set status to paused, set timeout untuk restore status, & return false
        const result = await this.redis.hincrby(this.generateKey(key), 'limit', -1)

        if (result === 0) {
            // TODO emit event "tokensDepleted" jika count adalah 0
            await this.redis.hset(this.generateKey(key), 'status', 'paused')
        }

        if (result < 0) {
            return false
        }

        return true
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