---
layout: post_layout
title: "GitHub国内访问卡到崩溃？1招教你极速上车: 修改Hosts | 直连最优IP"
date: 2025-08-29 14:16:00 +0800
categories: [博客搭建]
location: 西安
excerpt_separator: "```"
---

<p style="">1. 查询最新IP</p><p style="">	<strong>获取GitHub IP地址‌：</strong>通过DNS查询工具（如https://www.ip138.com/）获取 github.com 和 github.global.ssl.fastly.net的IP地址</p><p style="">2. 编辑Hosts文件</p><pre><code># Windows路径  
C:\Windows\System32\drivers\etc\hosts
# 添加以下内容  
20.205.243.166 github.com 
104.244.46.5 github.global.ssl.fastly.net  </code></pre><p style="">3. 刷新DNS缓存</p><pre><code>ipconfig /flushdns  # Windows</code></pre><p style=""></p>