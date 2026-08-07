import path from 'node:path';

import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';

import { getRedisUrl } from '@nangohq/kvstore';
import { flagHasAPIRateLimit, flagHasPlan, flagHasRateLimitPerEnvironment, getLogger } from '@nangohq/utils';

import { envs } from '../env.js';
import { createRateLimiterRedisClient } from '../utils/rateLimiterRedisClient.js';

import type { RequestLocals } from '../utils/express.js';
import type { DBPlan } from '@nangohq/types';
import type { NextFunction, Request, Response } from 'express';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';

const logger = getLogger('RateLimiter');

const defaultLimit = envs.DEFAULT_RATE_LIMIT_PER_MIN;
const rateLimiterSize: Record<DBPlan['api_rate_limit_size'], number> = {
    s: defaultLimit / 2,
    m: defaultLimit,
    l: defaultLimit * 5,
    xl: defaultLimit * 10,
    '2xl': defaultLimit * 25,
    '3xl': defaultLimit * 50,
    '4xl': defaultLimit * 75,
    '5xl': defaultLimit * 100,
    '6xl': defaultLimit * 125,
    '7xl': defaultLimit * 150,
    '8xl': defaultLimit * 175,
    '9xl': defaultLimit * 200,
    '10xl': defaultLimit * 225,
    '11xl': defaultLimit * 250,
    '12xl': defaultLimit * 275
};
const limiters = new Map<DBPlan['api_rate_limit_size'], RateLimiterAbstract>();

/**
 * Dynamically get a rate limiter based on the plan size
 */
async function getRateLimiter(size: DBPlan['api_rate_limit_size']) {
    if (limiters.has(size)) {
        return limiters.get(size)!;
    }

    const opts = {
        keyPrefix: 'middleware',
        points: rateLimiterSize[size],
        duration: 60,
        blockDuration: 0
    };

    const url = getRedisUrl();
    let limiter: RateLimiterAbstract;
    if (url) {
        const redisClient = await createRateLimiterRedisClient(url);
        redisClient.on('error', (err) => {
            logger.error(`Redis (rate-limiter) error: ${err}`);
        });
        limiter = new RateLimiterRedis({ storeClient: redisClient, useRedisPackage: true, ...opts });
    } else {
        limiter = new RateLimiterMemory(opts);
    }

    limiters.set(size, limiter);
    return limiter;
}

/**
 * Rate limit api calls
 */
export const rateLimiterMiddleware = async (req: Request, res: Response<any, RequestLocals>, next: NextFunction) => {
    if (!flagHasAPIRateLimit) {
        next();
        return;
    }

    function setXRateLimitHeaders(maxPoints: number, rateLimiterRes: RateLimiterRes) {
        const resetEpoch = Math.floor(new Date(Date.now() + rateLimiterRes.msBeforeNext).getTime() / 1000);

        res.setHeader('X-RateLimit-Limit', maxPoints);
        res.setHeader('X-RateLimit-Remaining', rateLimiterRes.remainingPoints);
        res.setHeader('X-RateLimit-Reset', resetEpoch);
    }

    const size = res.locals.plan?.api_rate_limit_size || 'm';
    const maxPoints = rateLimiterSize[size];
    const key = getKey(req, res);
    const pointsToConsume = getPointsToConsume(req, res, maxPoints);

    try {
        const rateLimiter = await getRateLimiter(size);
        const resConsume = await rateLimiter.consume(key, pointsToConsume);

        setXRateLimitHeaders(rateLimiter.points, resConsume);
        next();
    } catch (err) {
        if (err instanceof RateLimiterRes) {
            // blockDuration is 0, so msBeforeNext is routinely sub-second and Math.floor
            // serialises as `Retry-After: 0`, hot-looping clients that honour it.
            const retryAfterSeconds = Math.max(1, Math.ceil(err.msBeforeNext / 1000));
            // Rejections short-circuit before the request handler, so they leave no activity
            // log; stdout is the only trace. Warn so they are alertable, and name the
            // environment so the responsible tenant is identifiable without decoding the key.
            logger.warning(
                `Rate limit exceeded for ${key} (env=${res.locals['environment']?.name ?? 'none'} authType=${res.locals.authType ?? 'none'} retryAfter=${retryAfterSeconds}s). Request: ${req.method} ${req.path})`
            );

            setXRateLimitHeaders(maxPoints, err);
            res.setHeader('Retry-After', retryAfterSeconds);
            res.status(429).send({ error: { code: 'too_many_request', method: req.method, path: req.path } });
            return;
        }

        logger.error('Failed to compute rate limit', { error: err });
        // If we can't get the rate limit (ex: redis is unreachable), we should not block the request
        next();
    }
};

function getKey(req: Request, res: Response<any, RequestLocals>): string {
    if ('account' in res.locals) {
        let key = `account-${res.locals.authType === 'secretKey' ? 'secret' : 'global'}-${res.locals['account'].id}`;
        // Optionally give each environment its own bucket. Off by default: on Cloud this
        // would multiply an account's effective ceiling by its environment count. Self-hosted
        // deployments typically run one account with an environment per tenant, where a single
        // account-wide bucket lets one tenant's burst throttle every other tenant.
        // res.locals['environment'] is populated alongside 'account' on every auth path that
        // sets it. Keyed on id, not name, so renaming an environment cannot re-key a live bucket.
        if (flagHasRateLimitPerEnvironment && res.locals['environment']?.id !== undefined) {
            key += `-env-${res.locals['environment'].id}`;
        }
        // customers requests and requests from scripts fall into different buckets
        if (req.get('Nango-Is-Script') === 'true') {
            key += `-script`;
        }
        return key;
    } else if (req.user) {
        return `user-${req.user.id}`;
    }
    return `ip-${req.ip}`; // Fallback to IP address for unauthenticated requests
}

const specialPaths = ['/api/v1/account', '/api/v1/admin/impersonate'];
function getPointsToConsume(req: Request, res: Response<any, RequestLocals>, maxPoints: number): number {
    const fullPath = path.join(req.baseUrl, req.route.path);

    if (specialPaths.some((p) => fullPath.startsWith(p))) {
        // limiting to 6 requests per period to avoid brute force attacks
        return Math.floor(maxPoints / 6);
    } else if (fullPath === '/providers.json') {
        // Special case because it's hit by all runners with the same ip
        return 1;
    } else if (!res.locals.account || (flagHasPlan && !res.locals.plan)) {
        // Throttle api calls without valid credentials
        return 10;
    }

    return 1;
}
