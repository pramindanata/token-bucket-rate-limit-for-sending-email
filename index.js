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

    const rateLimiter = new RateLimiter(config)

    console.log("YEET")
}

class RateLimiter {
    constructor(config) {
        this.redis = config.redis
        this.emails = config.emails
    }

    start() {
        // TODO check if all keys are present and set if not
    }


    consumeToken() {
        // TODO decrement token count. If count less than 0, return set status to paused, set timeout untuk restore status, & return false
        // TODO emit event "tokensDepleted" jika count adalah 0
        return
    }

    refillTokens() {
        // TODO start interval untuk refill token per konfig. Perlu cek jumlah token yg tersisa dari redis
        // TODO hmm interval perlu ditentukan dari refill terakhir. Ini untuk handle semisal service restart. Biar engga kejauhan waktu refill berikutnya
        // semisal sebelumnya sempat refill
        return
    }
}

main().then(() => {
    process.exit(0)
}).catch((err) => {
    console.error(err)
})