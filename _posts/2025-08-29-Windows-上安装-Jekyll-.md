---
layout: post_layout
title: "Windows 上安装 Jekyll "
date: 2025-08-29 19:08:23 +0800
categories: [博客搭建]
location: 西安
excerpt_separator: "```"
---

<p style=""></p><p style="">在 Windows 上安装 Jekyll 需要一些额外的步骤，因为 Jekyll 原本是为 macOS/Linux 设计的。</p><p style="">也就是说，在Linux上安装同理：</p><p style="">1. 由于Jekyll 是用 Ruby 编写的，所以需要先安装 Ruby:</p><p style="">	- 下载 Ruby Installer:访问 [RubyInstaller for Windows](https://rubyinstaller.org/downloads/)</p><p style="">	- 运行安装程序</p><p style="">	- 验证 Ruby 安装</p><p style="">				</p><p style="">			ruby -v</p><p style="">2. 安装 Jekyll 和 Bundler</p><p style="">			</p><p style="">		gem install jekyll bundler</p><p style="">	验证安装</p><p style="">		</p><p style="">	</p><p style="">		jekyll -v</p><p style="">	</p><p style="">3. 创建 Jekyll 网站</p><p style="">		jekyll new myblog</p><p style="">		cd myblog</p><p style="">		bundle exec jekyll serve</p><p style="">访问 http://localhost:4000 查看网站。</p>