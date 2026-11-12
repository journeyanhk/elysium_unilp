#!/usr/bin/env bash
# 后端全量测试运行器（M3.3 review 第五/六轮）。
#
# 目标：把「全量测试 fail=0」做成可复现、可信任的一键验证。
#
# 背景：平台数据库接口限制约 **400 请求 / 60 秒**。全量测试（尤其跨进程额度测试会并发 5 个子进程）
# 接近该量级，连续快速运行会触到限流，表现为 `API error 429 RATE_LIMITED`（**环境限制，不是代码失败**）。
#
# 本脚本：
#   1. 串行运行测试文件（--test-concurrency=1），降低瞬时压力；
#   2. 每次运行之间等待 GAP 秒，避开 60 秒限流窗口；
#   3. **完整环境的判据是 `fail=0` 且 `skipped=0`**：
#      - 只有两者都为 0 才算一次 clean run（缺表/连不上导致用例被跳过 → 一律不算通过，防「假绿」）；
#      - `fail=0` 但 `skipped>0` → 明确报告「不是完整环境」，**不重跑、不掩盖**；
#   4. 只有「**存在失败**且输出里明确出现 RATE_LIMITED」才当作环境限流，等待后重跑该次（最多 RETRY 次）；
#      数据库缺表、连接错误、断言失败等一律按真实失败处理，绝不归类为限流后重跑。
#
# 用法：
#   cd backend && bash scripts/run-backend-tests.sh [运行次数] [间隔秒数]
#   默认：3 次，间隔 75 秒
set -u

RUNS="${1:-3}"
GAP="${2:-75}"
RETRY="${3:-3}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1

clean=0
run_no=0
while [ "$run_no" -lt "$RUNS" ]; do
  run_no=$((run_no + 1))
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    out="/tmp/backend-tests-run-${run_no}-${attempt}.txt"
    echo "── 第 $run_no/$RUNS 次（第 $attempt 次尝试）：node --test --test-concurrency=1 tests/*.test.js"
    node --test --test-concurrency=1 tests/*.test.js > "$out" 2>&1
    echo "   $(grep -E '^# (tests|pass|fail|skipped)' "$out" | tr '\n' ' ')"
    fails="$(grep -E '^# fail ' "$out" | awk '{print $3}')"
    skipped="$(grep -E '^# skipped ' "$out" | awk '{print $3}')"
    fails="${fails:-1}"; skipped="${skipped:-1}"

    # ① 完整环境判据：fail=0 且 skipped=0
    if [ "$fails" = "0" ] && [ "$skipped" = "0" ]; then
      clean=$((clean + 1))
      break
    fi

    # ② 有失败 + 明确限流 → 环境限制，等待后重跑（只在这种情况下重跑）
    if [ "$fails" != "0" ] && grep -q "RATE_LIMITED" "$out"; then
      if [ "$attempt" -lt "$RETRY" ]; then
        echo "   ⚠ 数据库接口限流（429 RATE_LIMITED）——环境限制，等待 120 秒后重跑本次"
        sleep 120
        continue
      fi
      echo "   ⚠ 连续 $attempt 次均因限流失败：属环境限制（非代码失败），详见 $out"
      break
    fi

    # ③ fail=0 但有跳过 → 不是完整环境：不重跑、不掩盖
    if [ "$fails" = "0" ] && [ "$skipped" != "0" ]; then
      echo "   ✗ 不是完整环境（skipped=$skipped）：用例被跳过说明数据库/表不可用，本次**不计为通过**"
      echo "     自检：cd backend && bun run db:ensure ；随后重跑 bun run test:full"
      break
    fi

    # ④ 其余 → 真实失败
    echo "   ✗ 本次存在**非限流**失败（fail=$fails, skipped=$skipped），详见 $out"
    break
  done
  if [ "$run_no" -lt "$RUNS" ]; then sleep "$GAP"; fi
done

echo
if [ "$clean" -eq "$RUNS" ]; then
  echo "✓ 完整环境：$RUNS 次连续运行均为 fail=0、skipped=0（无失败、无跳过、无限流干扰）"
  exit 0
fi
echo "✗ 完整环境未通过：仅 $clean/$RUNS 次满足 fail=0 且 skipped=0 —— 请查看 /tmp/backend-tests-run-*.txt"
exit 1
