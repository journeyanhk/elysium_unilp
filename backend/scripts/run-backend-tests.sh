#!/usr/bin/env bash
# 后端全量测试运行器（M3.3 review 第五轮）。
#
# 用途：把「全量测试必须 fail=0」做成可复现的一键验证。
#
# 背景：平台的数据库接口限制约 **400 请求 / 60 秒**。全量测试（含跨进程额度测试）会大量访问数据库，
# 连续多次运行可能触到限流（429）。本脚本：
#   1. 串行运行测试文件（--test-concurrency=1），降低瞬时压力；
#   2. 每次运行之间等待 70 秒，避开 60 秒限流窗口；
#   3. 检测输出中的 RATE_LIMITED，并在报告里明确标注（避免把环境限流误读成代码失败）。
#
# 用法：
#   cd backend && bash scripts/run-backend-tests.sh          # 默认 3 次
#   cd backend && bash scripts/run-backend-tests.sh 1        # 只跑 1 次
set -u

RUNS="${1:-3}"
GAP="${2:-70}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1

fail_total=0
for i in $(seq 1 "$RUNS"); do
  out="/tmp/backend-tests-run-$i.txt"
  echo "── 第 $i/$RUNS 次：node --test --test-concurrency=1 tests/*.test.js"
  node --test --test-concurrency=1 tests/*.test.js > "$out" 2>&1
  summary="$(grep -E '^# (tests|pass|fail|skipped)' "$out" | tr '\n' ' ')"
  echo "   $summary"
  if grep -q "RATE_LIMITED" "$out"; then
    echo "   ⚠ 本次运行遇到数据库接口限流（RATE_LIMITED）——属环境限制，请间隔 70 秒后重跑"
  fi
  fails="$(grep -E '^# fail ' "$out" | awk '{print $3}')"
  if [ "${fails:-1}" != "0" ]; then
    fail_total=$((fail_total + 1))
    echo "   ✗ 本次存在失败，详见 $out"
  fi
  if [ "$i" -lt "$RUNS" ]; then sleep "$GAP"; fi
done

echo
if [ "$fail_total" -eq 0 ]; then
  echo "全部 $RUNS 次运行均为 fail=0 ✓"
  exit 0
fi
echo "有 $fail_total 次运行出现失败 ✗"
exit 1
