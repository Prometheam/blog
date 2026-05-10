/**
 * theme.js — 博客主题增强功能
 * 功能：暗色模式切换、TOC 目录生成、代码复制按钮、回到顶部、阅读时间估算
 */

(function () {
  'use strict';

  // ============================================
  // 1. 暗色模式切换
  // ============================================
  const ThemeManager = {
    init() {
      this.toggle = document.getElementById('themeToggle');
      this.icon = document.getElementById('themeIcon');
      if (!this.toggle) return;

      this.toggle.addEventListener('click', () => this.switch());
      this.updateIcon();

      // 监听系统主题偏好变化
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
          const next = e.matches ? 'dark' : 'light';
          document.documentElement.setAttribute('data-theme', next);
          this.updateIcon();
          this.syncUtterances(next);
        }
      });
    },

    current() {
      return document.documentElement.getAttribute('data-theme') || 'dark';
    },

    switch() {
      const next = this.current() === 'dark' ? 'light' : 'dark';
      // 加过渡类，切换完成后移除，避免影响防闪烁脚本
      document.documentElement.classList.add('theme-transitioning');
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      this.updateIcon();
      this.syncUtterances(next);
      window.setTimeout(() => {
        document.documentElement.classList.remove('theme-transitioning');
      }, 350);
    },

    syncUtterances(theme) {
      const container = document.getElementById('utterances-container');
      if (!container) return;
      const utterancesTheme = theme === 'dark' ? 'github-dark' : 'github-light';
      // 销毁旧实例，重新注入 script，彻底避免 postMessage 跨域问题
      container.innerHTML = '';
      const s = document.createElement('script');
      s.src = 'https://utteranc.es/client.js';
      s.setAttribute('repo', 'mengguowan/mengguowan.github.io');
      s.setAttribute('issue-term', 'pathname');
      s.setAttribute('label', '💬 评论');
      s.setAttribute('theme', utterancesTheme);
      s.setAttribute('crossorigin', 'anonymous');
      s.async = true;
      container.appendChild(s);
    },

    updateIcon() {
      if (!this.icon) return;
      const isDark = this.current() === 'dark';
      this.icon.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
      this.toggle.title = isDark ? '切换到亮色模式' : '切换到暗色模式';
    }
  };

  // ============================================
  // 2. 文章目录 (TOC)
  // ============================================
  const TOC = {
    init() {
      const content = document.getElementById('postContent');
      const tocList = document.getElementById('tocList');
      const tocSidebar = document.getElementById('tocSidebar');
      if (!content || !tocList) return;

      const headings = content.querySelectorAll('h2, h3');
      if (headings.length < 3) {
        // 标题少于3个时隐藏 TOC
        if (tocSidebar) tocSidebar.style.display = 'none';
        return;
      }

      const fragment = document.createDocumentFragment();
      headings.forEach((heading, index) => {
        // 确保标题有 id
        if (!heading.id) {
          heading.id = 'heading-' + index;
        }

        const li = document.createElement('li');
        li.className = 'toc-item toc-' + heading.tagName.toLowerCase();

        const a = document.createElement('a');
        a.href = '#' + heading.id;
        a.textContent = heading.textContent;
        a.className = 'toc-link';

        li.appendChild(a);
        fragment.appendChild(li);
      });

      tocList.appendChild(fragment);

      // 一次性构建 id → linkEl 映射，避免 IntersectionObserver 回调中重复 querySelectorAll
      const linkMap = new Map();
      tocList.querySelectorAll('.toc-link').forEach(link => {
        const id = link.getAttribute('href').slice(1);
        linkMap.set(id, link);
      });

      this.observeHeadings(headings, linkMap);
    },

    observeHeadings(headings, linkMap) {
      // 使用 IntersectionObserver 高亮当前章节
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            linkMap.forEach(l => l.classList.remove('active'));
            const activeLink = linkMap.get(entry.target.id);
            if (activeLink) activeLink.classList.add('active');
          }
        });
      }, { rootMargin: '-80px 0px -70% 0px' });

      headings.forEach(h => observer.observe(h));
    }
  };

  // ============================================
  // 3. 代码块复制按钮
  // ============================================
  const CodeCopy = {
    init() {
      // 查找所有代码块
      const codeBlocks = document.querySelectorAll('pre');
      codeBlocks.forEach(pre => {
        if (pre.querySelector('.copy-btn')) return; // 避免重复

        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);

        // 读取语言（Rouge 生成的 class 格式：language-cpp）
        const codeEl = pre.querySelector('code[class*="language-"]');
        const langClass = codeEl ? codeEl.className.match(/language-(\S+)/) : null;
        const lang = langClass ? langClass[1] : '';

        // 创建语言标签（有语言才显示）
        if (lang) {
          const langLabel = document.createElement('span');
          langLabel.className = 'code-lang-label';
          langLabel.textContent = lang;
          wrapper.appendChild(langLabel);
        }

        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.innerHTML = '<i class="fa-regular fa-copy"></i>';
        btn.title = '复制代码';
        btn.setAttribute('aria-label', '复制代码');

        btn.addEventListener('click', () => {
          const code = pre.querySelector('code') || pre;
          const text = code.textContent;
          navigator.clipboard.writeText(text).then(() => {
            btn.innerHTML = '<i class="fa-solid fa-check"></i>';
            btn.classList.add('copied');
            setTimeout(() => {
              btn.innerHTML = '<i class="fa-regular fa-copy"></i>';
              btn.classList.remove('copied');
            }, 2000);
          });
        });

        wrapper.appendChild(btn);
      });
    }
  };

  // ============================================
  // 4. 回到顶部按钮
  // ============================================
  const BackToTop = {
    init() {
      this.btn = document.getElementById('backToTop');
      if (!this.btn) return;

      window.addEventListener('scroll', () => {
        this.btn.classList.toggle('visible', window.scrollY > 400);
      }, { passive: true });

      this.btn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  };

  // ============================================
  // 5. 阅读时间估算
  // ============================================
  const ReadingTime = {
    init() {
      const content = document.getElementById('postContent');
      const display = document.getElementById('readingTime');
      if (!content || !display) return;

      const text = content.textContent || '';
      // 中文：约400字/分钟；英文：约200词/分钟
      const chineseChars = (text.match(/[一-鿿]/g) || []).length;
      const englishWords = text.replace(/[一-鿿]/g, ' ').split(/\s+/).filter(w => w.length > 0).length;

      const minutes = Math.max(1, Math.ceil(chineseChars / 400 + englishWords / 200));
      display.textContent = '约 ' + minutes + ' 分钟';
    }
  };

  // ============================================
  // 6. 阅读进度条
  // ============================================
  const ReadingProgress = {
    init() {
      this.bar = document.getElementById('readingProgressBar');
      if (!this.bar) return;

      window.addEventListener('scroll', () => this.update(), { passive: true });
      this.update();
    },

    update() {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = docHeight > 0 ? Math.min(100, (scrollTop / docHeight) * 100) : 0;
      this.bar.style.width = progress + '%';
    }
  };

  // ============================================
  // 7. 导航栏活动链接高亮
  // ============================================
  const NavHighlight = {
    init() {
      const currentPath = window.location.pathname;
      const links = document.querySelectorAll('.nav-link');

      links.forEach(link => {
        const href = link.getAttribute('href');
        if (href && (href === currentPath || (href !== '/' && currentPath.startsWith(href)))) {
          link.classList.add('active');
        }
      });
    }
  };

  // ============================================
  // 8. 图片懒加载
  // ============================================
  const LazyLoad = {
    init() {
      document.querySelectorAll('.post-content img:not([loading])').forEach(img => {
        img.setAttribute('loading', 'lazy');
      });
    }
  };

  // ============================================
  // 9. JS 客户端分页
  // ============================================
  const Pagination = {
    pageSize: 10,
    init() {
      const posts = document.querySelectorAll('.post-card');
      const nav = document.getElementById('paginationNav');
      if (!nav || posts.length <= this.pageSize) return;
      this.posts = Array.from(posts);
      this.total = Math.ceil(posts.length / this.pageSize);
      this.goto(1);
    },
    goto(page) {
      this.current = page;
      this.posts.forEach((p, i) => {
        p.style.display = (i >= (page - 1) * this.pageSize && i < page * this.pageSize) ? '' : 'none';
      });
      this.render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    render() {
      const nav = document.getElementById('paginationNav');
      if (!nav) return;
      let html = '';
      if (this.current > 1) {
        html += '<button class="page-btn page-prev" data-page="' + (this.current - 1) + '"><i class="fa-solid fa-chevron-left"></i></button>';
      }
      for (let i = 1; i <= this.total; i++) {
        if (
          i === 1 || i === this.total ||
          (i >= this.current - 2 && i <= this.current + 2)
        ) {
          html += '<button class="page-btn' + (i === this.current ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
        } else if (i === this.current - 3 || i === this.current + 3) {
          html += '<span class="page-ellipsis">…</span>';
        }
      }
      if (this.current < this.total) {
        html += '<button class="page-btn page-next" data-page="' + (this.current + 1) + '"><i class="fa-solid fa-chevron-right"></i></button>';
      }
      nav.innerHTML = html;
      nav.querySelectorAll('.page-btn').forEach(btn => {
        btn.addEventListener('click', () => this.goto(parseInt(btn.dataset.page)));
      });
    }
  };

  // ============================================
  // 10. 移动端 TOC 抽屉
  // ============================================
  const MobileTOC = {
    init() {
      const btn = document.getElementById('tocMobileBtn');
      const drawer = document.getElementById('tocMobileDrawer');
      const overlay = document.getElementById('tocMobileOverlay');
      const closeBtn = document.getElementById('tocMobileClose');
      const tocListMobile = document.getElementById('tocListMobile');
      const tocList = document.getElementById('tocList');

      if (!btn || !drawer || !tocList) return;

      // 克隆桌面端 TOC 列表到移动端
      const cloned = tocList.cloneNode(true);
      cloned.querySelectorAll('.toc-link').forEach(link => {
        link.classList.remove('active');
      });
      tocListMobile.appendChild(cloned);

      // 点击链接后关闭抽屉
      tocListMobile.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', () => this.close(drawer, overlay));
      });

      btn.addEventListener('click', () => {
        const isOpen = drawer.classList.contains('open');
        isOpen ? this.close(drawer, overlay) : this.open(drawer, overlay);
      });

      if (overlay) overlay.addEventListener('click', () => this.close(drawer, overlay));
      if (closeBtn) closeBtn.addEventListener('click', () => this.close(drawer, overlay));

      // 仅在移动端显示按钮（CSS 已控制，JS 仅在有标题时才显示）
      if (tocList.children.length === 0) {
        btn.style.display = 'none';
      }
    },

    open(drawer, overlay) {
      drawer.classList.add('open');
      if (overlay) overlay.classList.add('active');
      document.body.style.overflow = 'hidden';
    },

    close(drawer, overlay) {
      drawer.classList.remove('open');
      if (overlay) overlay.classList.remove('active');
      document.body.style.overflow = '';
    }
  };

  // ============================================
  // 初始化
  // ============================================
  document.addEventListener('DOMContentLoaded', () => {
    ThemeManager.init();
    TOC.init();
    CodeCopy.init();
    BackToTop.init();
    ReadingTime.init();
    ReadingProgress.init();
    NavHighlight.init();
    LazyLoad.init();
    MobileTOC.init();
    Pagination.init();
  });

})();
