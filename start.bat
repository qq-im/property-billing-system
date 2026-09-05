@echo off
chcp 65001 >nul
title 物业账单管家
echo 正在启动物业与租户综合账单管理系统...
echo 启动后请在浏览器打开 http://localhost:3000
node server.js
pause
