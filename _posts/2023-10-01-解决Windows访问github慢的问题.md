---
layout: post_layout
title: "解决Win访问github卡的问题"
date: 2023-10-01 14:30:00 +0800
categories: [博客搭建]
location: 西安
excerpt_separator: "```"
---

GitHub国内访问卡到崩溃？1招教你极速上车: 修改Hosts | 直连最优IP

1. 查询最新IP

	**获取GitHub IP地址**‌：通过DNS查询工具（如https://www.ip138.com/）获取 github.com 和        github.global.ssl.fastly.net的IP地址
	
2. 编辑Hosts文件
	
		# Windows路径  
		C:\Windows\System32\drivers\etc\hosts
		# 添加以下内容  
		20.205.243.166 github.com 
		104.244.46.5 github.global.ssl.fastly.net  

3. 刷新DNS缓存

		```
		ipconfig /flushdns  # Windows
		```
		
		

