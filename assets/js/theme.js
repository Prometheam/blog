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
          document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
          this.updateIcon();
        }
      });
    },

    current() {
      return document.documentElement.getAttribute('data-theme') || 'dark';
    },

    switch() {
      const next = this.current() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      this.updateIcon();
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
      this.observeHeadings(headings);
    },

    observeHeadings(headings) {
      // 使用 IntersectionObserver 高亮当前章节
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            document.querySelectorAll('.toc-link').forEach(l => l.classList.remove('active'));
            const activeLink = document.querySelector('.toc-link[href="#' + entry.target.id + '"]');
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
  // 6. 导航栏活动链接高亮
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
  // 初始化
  // ============================================
  document.addEventListener('DOMContentLoaded', () => {
    ThemeManager.init();
    TOC.init();
    CodeCopy.init();
    BackToTop.init();
    ReadingTime.init();
    NavHighlight.init();
  });

})();
