# Rate Limit Solution for Sending Email

Note:

- It use token bucket algorithm to limit the rate of process. This algorithm also allow controlled burst.
- It use Redis to store the data so this rate limiter can be used by multiple services.
- Each email can has its own rate limit so it allow this email to be processed even another email already emptied the token bucket.

Setup:

1. Run `npm install` to install all dependencies.
2. Create the `.env` file based on the `.env.example`.
3. Run `npm run start` to start this script to demo the rate limit.
