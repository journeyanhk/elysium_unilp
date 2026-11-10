/**
 * GET /api/memory —— 项目记忆（仓库内 MEMORY.md / PROGRESS.md / MAINTENANCE.md 原文）。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const FILES = ['MEMORY.md', 'PROGRESS.md', 'MAINTENANCE.md'];

router.get('/', (_req, res) => {
  const files = FILES.map((name) => {
    try {
      return { name, content: fs.readFileSync(path.resolve(__dirname, '..', '..', name), 'utf-8') };
    } catch (e) {
      return { name, content: null, error: '文件不存在' };
    }
  });
  res.json({ files, at: new Date().toISOString() });
});

module.exports = router;
