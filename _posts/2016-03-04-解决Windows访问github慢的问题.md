---
layout: post_layout
title: "2023-10-01-解决Win访问github卡的问题"
date: 2023-10-01 14:30:00 +0800
categories: [博客搭建]
location: 上海
excerpt_separator: "```"
---

GitHub国内访问卡到崩溃？1招教你极速上车: 修改Hosts | 直连最优IP

1. 查询最新IP

	访问 https://github.com.ipaddress.com
	
	获取 github.com 和 github.global.ssl.fastly.net 的当前IP
2. 编辑Hosts文件
	
		# Windows路径  
		C:\Windows\System32\drivers\etc\hosts
		# 添加以下内容  
		140.82.113.3 github.com  
		199.232.69.194 github.global.ssl.fastly.net 

3. 刷新DNS缓存

		ipconfig /flushdns  # Windows

