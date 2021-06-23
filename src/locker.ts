/**
 * @ author: richen
 * @ copyright: Copyright (c) - <richenlin(at)gmail.com>
 * @ license: MIT
 * @ version: 2020-06-05 09:40:35
 */
import * as crypto from "crypto";
import { Store, RedisStore } from "koatty_store";
import { DefaultLogger as logger } from "koatty_logger";

/**
 * Wait for a period of time (ms)
 *
 * @param {number} ms
 * @returns
 */
const delay = function (ms = 1000) {
    return new Promise((resolve: Function) => setTimeout(() => resolve(), ms));
};

export class Locker {
    lockMap: Map<any, any>;
    options: any;

    private static instance: Locker;
    client: any;


    /**
     * 
     *
     * @static
     * @param {RedisStore} options
     * @param {boolean} [force=false]
     * @returns
     * @memberof Locker
     */
    static getInstance(options: RedisStore, force = false) {
        if (!this.instance || force) {
            this.instance = new Locker(options);
        }
        return this.instance;
    }

    /**
     * Creates an instance of Locker.
     * @param {RedisStore} options
     * @memberof Locker
     */
    private constructor(options: RedisStore) {
        this.lockMap = new Map();
        this.options = options;

        this.client = null;
    }

    /**
     * 
     *
     * @returns
     * @memberof Locker
     */
    async defineCommand() {
        try {
            if (!this.client || this.client.status !== 'ready') {
                //Lua scripts execute atomically
                const redisStore = Store.getInstance(this.options);
                this.client = await redisStore.getConnection();
                if (this.client && !this.client.lua_unlock) {
                    this.client.defineCommand('lua_unlock', {
                        numberOfKeys: 1,
                        lua: `
                            local remote_value = redis.call("get",KEYS[1])
                            
                            if (not remote_value) then
                                return 0
                            elseif (remote_value == ARGV[1]) then
                                return redis.call("del",KEYS[1])
                            else
                                return -1
                            end
                `});
                }
            }
            return this.client;
        } catch (e) {
            logger.Error(`Redis connection failed. at ScheduleLocker.InitRedisConn. ${e.message}`);
            return null;
        }
    }

    /**
     * Get a locker.
     *
     * @param {string} key
     * @param {number} [expire=10000]
     * @returns
     * @memberof Locker
     */
    async lock(key: string, expire = 10000): Promise<boolean> {
        try {
            const client = await this.defineCommand();
            key = `${this.options.key_prefix}${key}`;
            const value = crypto.randomBytes(16).toString('hex');
            const result = await client.set(key, value, 'NX', 'PX', expire);
            if (result === null) {
                logger.Error('lock error: key already exists');
                return false;
            }

            this.lockMap.set(key, { value, expire, time: Date.now() });
            return true;
        } catch (e) {
            logger.Error(e);
            return false;
        }
    }

    /**
     * Get a locker.
     * Attempts to lock once every interval time, and fails when return time exceeds waitTime
     *
     * @param {string} key
     * @param {number} expire
     * @param {number} [interval=500]
     * @param {number} [waitTime=5000]
     * @returns
     * @memberof Locker
     */
    async waitLock(key: string, expire: number, interval = 50, waitTime = 15000): Promise<boolean> {
        try {
            const start_time = Date.now();
            let result;
            while ((Date.now() - start_time) < waitTime) {
                result = await this.lock(key, expire).catch((err: any) => {
                    logger.Error(err.stack || err.message);
                });
                if (result) {
                    return true;
                } else {
                    await delay(interval);
                }
            }
            logger.Error('waitLock timeout');
            return false;
        } catch (e) {
            logger.Error(e);
            return false;
        }
    }

    /**
     * Release lock.
     * Regardless of whether the key exists and the unlock is successful, no error will be thrown (except for network reasons). 
     * 
     * The specific return value is:
     * 
     * null: key does not exist locally
     * 
     * 0: key does not exist on redis
     * 
     * 1: unlocked successfully
     * 
     * -1: value does not correspond and cannot be unlocked
     *
     * @param {*} key
     * @returns
     * @memberof Locker
     */
    async unLock(key: string): Promise<boolean> {
        try {
            const client = await this.defineCommand();
            key = `${this.options.key_prefix}${key}`;
            if (!this.lockMap.has(key)) {
                return null;
            }
            const { value } = this.lockMap.get(key);
            await client.lua_unlock(key, value);
            this.lockMap.delete(key);
            return true;
        } catch (e) {
            logger.Error(e);
            return false;
        }
    }
}