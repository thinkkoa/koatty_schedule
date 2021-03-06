/**
 * @ author: richen
 * @ copyright: Copyright (c) - <richenlin(at)gmail.com>
 * @ license: MIT
 * @ version: 2020-07-06 10:30:11
 */
// tslint:disable-next-line: no-import-side-effect
import "reflect-metadata";
import { CronJob } from "cron";
import * as helper from "koatty_lib";
import { DefaultLogger as logger } from "koatty_logger";
import { Application, IOCContainer } from "koatty_container";
import { Locker } from "./locker";
import { recursiveGetMetadata } from "./lib";

const SCHEDULE_KEY = 'SCHEDULE_KEY';
// const APP_READY_HOOK = "APP_READY_HOOK";

/**
 * 
 *
 * @interface CacheStoreInterface
 */
interface ScheduleLockerInterface {
    locker?: LockerInterface;
}
interface LockerInterface {
    getClient?: () => Promise<any>;
    lock?: (key: string, expire?: number) => Promise<boolean>;
    waitLock?: (key: string, expire: number, interval?: number, waitTime?: number) => Promise<boolean>;
    unLock?: (key: string) => Promise<boolean>;
}
// 
const ScheduleLocker: ScheduleLockerInterface = {
    locker: null,
};

/**
 * initiation CacheStore connection and client.
 *
 * @param {Application} app
 * @returns {*}  {Promise<LockerInterface>}
 */
async function InitCacheStore(app: Application): Promise<LockerInterface> {
    if (!ScheduleLocker.locker) {
        const opt = app.config("CacheStore", "db") ?? {};
        if (helper.isEmpty(opt)) {
            logger.Warn(`Missing CacheStore server configuration. Please write a configuration item with the key name 'CacheStore' in the db.ts file.`);
        }
        const locker = Locker.getInstance(opt);
        if (locker && helper.isFunction(locker.getClient)) {
            await locker.getClient();
            ScheduleLocker.locker = locker;
        } else {
            throw Error(`CacheStore connection failed. `);
        }
    }

    return ScheduleLocker.locker;
}

/**
 * Schedule task
 *
 * @export
 * @param {string} cron
 * * Seconds: 0-59
 * * Minutes: 0-59
 * * Hours: 0-23
 * * Day of Month: 1-31
 * * Months: 0-11 (Jan-Dec)
 * * Day of Week: 0-6 (Sun-Sat)
 * 
 * @returns {MethodDecorator}
 */
export function Scheduled(cron: string): MethodDecorator {
    if (helper.isEmpty(cron)) {
        // cron = "0 * * * * *";
        throw Error("ScheduleJob rule is not defined");
    }

    return (target, propertyKey: string, descriptor: PropertyDescriptor) => {
        const componentType = IOCContainer.getType(target);
        if (componentType !== "SERVICE" && componentType !== "COMPONENT") {
            throw Error("This decorator only used in the service、component class.");
        }
        // IOCContainer.attachPropertyData(SCHEDULE_KEY, {
        //     cron,
        //     method: propertyKey
        // }, target, propertyKey);
        execInjectSchedule(target, propertyKey, cron);
    };
}

/**
 * Redis-based distributed locks. Redis server config from db.ts.
 *
 * @export
 * @param {string} [name] The locker name. If name is duplicated, lock sharing contention will result.
 * @param {number} [lockTimeOut] Automatic release of lock within a limited maximum time.
 * @param {number} [waitLockInterval] Try to acquire lock every interval time(millisecond).
 * @param {number} [waitLockTimeOut] When using more than TimeOut(millisecond) still fails to get the lock and return failure.
 * 
 * @returns {MethodDecorator}
 */
export function SchedulerLock(name?: string, lockTimeOut?: number, waitLockInterval?: number, waitLockTimeOut?: number): MethodDecorator {
    return (target: any, methodName: string, descriptor: PropertyDescriptor) => {
        const componentType = IOCContainer.getType(target);
        if (componentType !== "SERVICE" && componentType !== "COMPONENT") {
            throw Error("This decorator only used in the service、component class.");
        }
        const { value, configurable, enumerable } = descriptor;
        if (helper.isEmpty(name)) {
            const identifier = IOCContainer.getIdentifier(target) || (target.constructor ? target.constructor.name : "");
            name = `${identifier}_${methodName}`;
        }

        descriptor = {
            configurable,
            enumerable,
            writable: true,
            async value(...props: any[]) {
                const lockerCls = ScheduleLocker.locker;
                let lockerFlag = false;
                if (!lockerCls) {
                    throw Error(`Cache lock '${name}' acquisition failed. The method ${methodName} is not executed.`);
                }
                if (waitLockInterval || waitLockTimeOut) {
                    lockerFlag = await lockerCls.waitLock(name,
                        lockTimeOut,
                        waitLockInterval,
                        waitLockTimeOut
                    ).catch((er: any) => {
                        logger.Error(er);
                        return false;
                    });
                } else {
                    lockerFlag = await lockerCls.lock(name, lockTimeOut).catch((er: any) => {
                        logger.Error(er);
                        return false;
                    });
                }
                if (lockerFlag) {
                    try {
                        logger.Info(`The locker '${name}' executed.`);
                        // tslint:disable-next-line: no-invalid-this
                        const res = await value.apply(this, props);
                        return res;
                    } catch (e) {
                        return Promise.reject(e);
                    } finally {
                        if (lockerCls.unLock) {
                            await lockerCls.unLock(name).catch((er: any) => {
                                logger.Error(er);
                            });
                        }
                    }
                } else {
                    logger.Warn(`Cache lock '${name}' acquisition failed. The method ${methodName} is not executed.`);
                    return;
                }
            }
        };

        // bind app_ready hook event 
        bindSchedulerLockInit();
        return descriptor;
    };
}

/**
 * Redis-based distributed locks. Redis server config from db.ts.
 *
 * @export
 * @param {string} [name] The locker name. If name is duplicated, lock sharing contention will result.
 * @param {number} [lockTimeOut] Automatic release of lock within a limited maximum time.
 * @param {number} [waitLockInterval] Try to acquire lock every interval time(millisecond).
 * @param {number} [waitLockTimeOut] When using more than TimeOut(millisecond) still fails to get the lock and return failure.
 *
 * @returns {MethodDecorator}
 */
export const Lock = SchedulerLock;

/**
 * bind scheduler lock init event
 *
 */
const bindSchedulerLockInit = function () {
    const app = IOCContainer.getApp();
    app && app.once("appStart", async function () {
        await InitCacheStore(app);
    })
}

/**
 * 
 *
 * @param {*} target
 * @param {Container} container
 * @param {string} method
 * @param {string} cron
 */
const execInjectSchedule = function (target: any, method: string, cron: string) {
    const app = IOCContainer.getApp();
    app && app.once("appStart", () => {
        const identifier = IOCContainer.getIdentifier(target);
        const componentType = IOCContainer.getType(target);
        const instance: any = IOCContainer.get(identifier, componentType);

        if (instance && helper.isFunction(instance[method]) && cron) {
            logger.Debug(`Register inject ${identifier} schedule key: ${method} => value: ${cron}`);
            new CronJob(cron, async function () {
                logger.Info(`The schedule job ${identifier}_${method} started.`);
                try {
                    const res = await instance[method]();
                    return res;
                } catch (e) {
                    logger.Error(e);
                }
            }).start();
        }
    });
};

/**
 * Inject schedule job
 *
 * @export
 * @param {*} target
 */
export function injectSchedule(target: any) {
    const metaDatas = recursiveGetMetadata(SCHEDULE_KEY, target);
    // tslint:disable-next-line: forin
    for (const meta in metaDatas) {
        for (const val of metaDatas[meta]) {
            if (val.cron && meta) {
                execInjectSchedule(target, meta, val.cron);
            }
        }
    }
}
