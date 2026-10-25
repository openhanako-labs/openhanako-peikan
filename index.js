/**
 * peikan / index.js — 奥菲莉娅 B站 工作室 · v2 App 入口（P0 骨架）
 *
 * 按官方 hana-app-creator 脚手架形态：defineApp(async sdk => ...) + ./sdk/app-contract/。
 * P0：只读骨架。工具/路由/定时任务全部注册，但不联网、不发布。
 */

import { defineApp } from "./sdk/app-contract/server-client.js";
import { registerTools } from "./lib/register-tools.js";
import { registerRoutes } from "./lib/register-routes.js";
import { registerTasks } from "./lib/register-tasks.js";
import { readConfig } from "./lib/config.js";

export const name = "peikan";

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir || "";
  await sdk.logger.info(`peikan P0 加载中 · dataDir=${dataDir || "(未提供)"}`);

  // 1) 卡片后端路由
  try {
    await registerRoutes(sdk);
    await sdk.logger.info("peikan 卡片路由已挂载");
  } catch (e) {
    await sdk.logger.error(`路由注册失败：${e && e.message ? e.message : e}`);
  }

  // 2) 工具（bili_*）
  try {
    await registerTools(sdk);
    await sdk.logger.info("peikan 工具已注册");
  } catch (e) {
    await sdk.logger.error(`工具注册失败：${e && e.message ? e.message : e}`);
  }

  // 3) 定时任务 handler + 惰性排程
  try {
    await registerTasks(sdk);
  } catch (e) {
    await sdk.logger.error(`定时任务注册失败：${e && e.message ? e.message : e}`);
  }

  // 4) 确认配置可读
  try {
    const cfg = await readConfig(sdk);
    await sdk.logger.info(`配置读取正常（autoPost=${cfg.autoPostEnabled === true}）`);
  } catch (e) {
    await sdk.logger.warn(`配置读取失败：${e && e.message ? e.message : e}`);
  }
});
