# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 与用户交互时请使用中文。

## 常用命令

```bash
# 安装依赖
bundle install

# 启动本地开发服务器（支持热重载）
bundle exec jekyll serve

# 构建静态站点到 _site/ 目录
bundle exec jekyll build

# 启动开发服务器并显示草稿文章
bundle exec jekyll serve --drafts
```

## 架构概览

本项目是一个基于 Jekyll 4.4.1 的个人技术博客，部署在 GitHub Pages（`prometheam.github.io`）。

### 页面 / 布局层级

| URL | 源文件 | 使用的布局 |
|-----|--------|-----------|
| `/` | `index.html` | 无（自包含 HTML，含粒子动画首页） |
| `/blog` | `blog.html` | `blog_layout` |
| `/archives/` | `archives/index.html` | `blog_layout` |
| `/categories/` | `categories/index.html` | `blog_layout` |
| `/about/` | `about/index.html` | `author_layout` |
| `/YYYY/MM/DD/title/` | `_posts/*.md` | `post_layout`（由 `_config.yml` 全局默认设置） |

所有布局文件位于 `_layouts/`，通过 `_includes/` 中的局部模板组合而成：
- `head.html` — `<head>` 标签，包含 CSS、字体、防主题闪烁脚本
- `navbar.html` — 响应式导航栏 + 搜索浮层 + 主题切换（JS 内联）
- `footer.html`、`post_footer.html`、`blog_header.html`、`author_header.html`、`comments.html`

### 数据文件（`_data/`）

- `navigation.yml` — 控制导航栏链接（支持 `dropdown` 子菜单）
- `author.yml` — 控制 `/about/` 页面内容（工作经历、教育经历、技能）
- `blog.yml` — 导航栏品牌名称（博客标题）

### 搜索功能

`search.json`（仓库根目录）是一个 Jekyll 模板，构建时生成包含所有文章信息（标题、URL、日期、分类、摘要）的 JSON 数组。`navbar.html` 在首次搜索时通过 XHR 加载该文件，之后在客户端本地过滤，无需外部搜索服务。

### 评论系统

`_includes/comments.html` 接入了 **utterances**（基于 GitHub Issues 的评论），关联仓库为 `Prometheam/blog`。评论主题在页面加载时自动与深色/浅色模式同步。

### 样式

- `assets/css/blog.css` — 主题样式表（使用 CSS 变量支持深色/浅色模式，包含所有组件样式）
- `assets/css/syntax.css` — Rouge 代码块语法高亮样式
- `assets/css/admin.css` — 管理面板样式（生产页面中未使用）

深色/浅色主题通过在 `<html>` 上设置 `data-theme` 属性切换，并持久化到 `localStorage('theme')`。`head.html` 中的防闪烁脚本会在渲染前提前应用已保存的主题。

### 新建文章

在 `_posts/` 目录下创建 `YYYY-MM-DD-slug.md` 文件，添加以下 Front Matter：

```yaml
---
title: "文章标题"
categories: [分类名]   # 可选
location: "城市"       # 可选，显示在文章元信息中
---
```

`layout: post` 和 `show_in_archives: true` 已在 `_config.yml` 中全局配置为默认值，无需在每篇文章中重复声明。

### Markdown 配置

`_config.yml` 中配置了 Kramdown 渲染器，使用 GFM（GitHub 风格 Markdown）输入模式，Rouge 负责语法高亮。代码块加语言标识符即可高亮（如 ` ```cpp `）。
