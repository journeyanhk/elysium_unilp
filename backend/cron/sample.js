/**
 * cron 任务：每 5 分钟采样池状态 + 被跟踪头寸的待领费用（只读 RPC 调用）。
 */
const { samplePool, sampleTrackedPositions } = require('../lib/sampling');

exports.handler = async () => {
  const pool = await samplePool();
  const res = await sampleTrackedPositions(25);
  return { poolTick: pool.tick, ...res };
};
