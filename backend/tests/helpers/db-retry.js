/**
 * 测试用数据库访问包装：对「数据库接口限流（429）」做退避重试（M3.3 review 第五轮）。
 *
 * 背景：平台数据库接口限制约 **400 请求 / 60 秒**。全量测试（尤其跨进程额度测试会并发起 5 个子进程）
 * 可能触到该限制，返回：
 *
 *   API error 429: {"error":{"code":"RATE_LIMITED",...}}
 *
 * 这是**请求被拒绝、并未执行**，因此重试是安全的；生产代码（lib/db.js）保持原样（失败即 fail-closed），
 * 本包装只用于测试，避免把环境限流误报成代码失败。
 */
const { dbQuerySafe } = require('../../lib/db');

const RATE_LIMIT_RE = /RATE_LIMITED|429|rate limit/i;
const MAX_ATTEMPTS = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 与 dbQuerySafe 同签名；仅对限流错误重试（其它错误立即抛出，保持 fail-closed 语义） */
async function dbQueryRetry(sql, params = []) {
  let lastError = null;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await dbQuerySafe(sql, params);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (!RATE_LIMIT_RE.test(msg)) throw e;
      lastError = e;
      await sleep(2000 * (i + 1)); // 2s / 4s / 6s / 8s
    }
  }
  throw lastError;
}

/** 与 @surf-ai/sdk/db 的 dbQuery 同签名（返回 { rows, rowCount, fields }） */
async function dbQuery(sql, params = []) {
  return dbQueryRetry(sql, params);
}

module.exports = { dbQueryRetry, dbQuery, RATE_LIMIT_RE, MAX_ATTEMPTS };
