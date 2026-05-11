/**
 * admin.js — 博客管理后台核心逻辑
 * 模块：配置、认证、API、Front Matter、路由、文章列表、编辑器、主题
 */
(function () {
  'use strict';

  // ==================== 配置 ====================
  const CONFIG = {
    owner: 'mengguowan',
    repo: 'mengguowan.github.io',
    branch: 'gh-pages',
    postsDir: '_posts',
    draftsDir: '_drafts',
    apiBase: 'https://api.github.com',
    tokenKey: 'mgw_admin_token',
    userKey: 'mgw_admin_user',
    sessionTimeout: 30 * 60 * 1000 // 30分钟
  };

  // ==================== 工具函数 ====================
  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return document.querySelectorAll(selector); }

  // UTF-8 安全的 Base64 编解码
  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function base64ToUtf8(base64) {
    return decodeURIComponent(escape(atob(base64)));
  }

  // Toast 提示
  function showToast(message, type) {
    var toast = $('#toast');
    toast.textContent = message;
    toast.className = 'toast toast-' + (type || 'success');
    toast.classList.remove('d-none');
    setTimeout(function () {
      toast.classList.add('d-none');
    }, 3000);
  }

  // ==================== 认证模块 ====================
  const Auth = {
    lastActivity: Date.now(),

    init: function () {
      // 监听用户活动
      var self = this;
      ['click', 'keydown', 'mousemove'].forEach(function (event) {
        document.addEventListener(event, function () {
          self.lastActivity = Date.now();
        }, { passive: true });
      });

      // 定期检查会话超时
      setInterval(function () {
        if (self.isAuthenticated() && Date.now() - self.lastActivity > CONFIG.sessionTimeout) {
          self.logout();
          Router.navigate('login');
          showToast('会话超时，请重新登录', 'error');
        }
      }, 60000);
    },

    async login(token) {
      var resp = await fetch(CONFIG.apiBase + '/user', {
        headers: { 'Authorization': 'token ' + token }
      });
      if (!resp.ok) throw new Error('Token 无效或已过期');

      var user = await resp.json();
      if (user.login !== CONFIG.owner) {
        throw new Error('无权限：你不是仓库所有者');
      }

      localStorage.setItem(CONFIG.tokenKey, token);
      localStorage.setItem(CONFIG.userKey, JSON.stringify({ login: user.login, avatar: user.avatar_url }));
      this.lastActivity = Date.now();
      return user;
    },

    logout: function () {
      localStorage.removeItem(CONFIG.tokenKey);
      localStorage.removeItem(CONFIG.userKey);
    },

    getToken: function () {
      return localStorage.getItem(CONFIG.tokenKey);
    },

    getUser: function () {
      var data = localStorage.getItem(CONFIG.userKey);
      return data ? JSON.parse(data) : null;
    },

    isAuthenticated: function () {
      return !!this.getToken();
    }
  };

  // ==================== GitHub API 模块 ====================
  const API = {
    headers: function () {
      return {
        'Authorization': 'token ' + Auth.getToken(),
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      };
    },

    // 获取文章列表
    async listPosts() {
      var url = CONFIG.apiBase + '/repos/' + CONFIG.owner + '/' + CONFIG.repo +
        '/contents/' + CONFIG.postsDir + '?ref=' + CONFIG.branch;
      var resp = await fetch(url, { headers: this.headers() });
      if (!resp.ok) throw new Error('获取文章列表失败: ' + resp.status);

      var files = await resp.json();
      return files
        .filter(function (f) { return f.name.endsWith('.md'); })
        .sort(function (a, b) { return b.name.localeCompare(a.name); });
    },

    // 获取草稿列表
    async listDrafts() {
      var url = CONFIG.apiBase + '/repos/' + CONFIG.owner + '/' + CONFIG.repo +
        '/contents/' + CONFIG.draftsDir + '?ref=' + CONFIG.branch;
      var resp = await fetch(url, { headers: this.headers() });
      // 草稿目录可能不存在，返回空数组
      if (resp.status === 404) return [];
      if (!resp.ok) throw new Error('获取草稿列表失败: ' + resp.status);
      var files = await resp.json();
      return files
        .filter(function (f) { return f.name.endsWith('.md'); })
        .sort(function (a, b) { return b.name.localeCompare(a.name); });
    },

    // 获取单篇文章
    async getPost(path) {
      var url = CONFIG.apiBase + '/repos/' + CONFIG.owner + '/' + CONFIG.repo +
        '/contents/' + path + '?ref=' + CONFIG.branch;
      var resp = await fetch(url, { headers: this.headers() });
      if (!resp.ok) throw new Error('获取文章失败: ' + resp.status);

      var data = await resp.json();
      var content = base64ToUtf8(data.content.replace(/\n/g, ''));
      return { content: content, sha: data.sha, name: data.name, path: data.path };
    },

    // 创建或更新文章
    async savePost(path, content, message, sha) {
      var url = CONFIG.apiBase + '/repos/' + CONFIG.owner + '/' + CONFIG.repo +
        '/contents/' + path;
      var body = {
        message: message,
        content: utf8ToBase64(content),
        branch: CONFIG.branch
      };
      if (sha) body.sha = sha;

      var resp = await fetch(url, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        var err = await resp.json();
        throw new Error('保存失败: ' + (err.message || resp.status));
      }
      return await resp.json();
    },

    // 删除文章
    async deletePost(path, sha, message) {
      var url = CONFIG.apiBase + '/repos/' + CONFIG.owner + '/' + CONFIG.repo +
        '/contents/' + path;
      var resp = await fetch(url, {
        method: 'DELETE',
        headers: this.headers(),
        body: JSON.stringify({
          message: message,
          sha: sha,
          branch: CONFIG.branch
        })
      });
      if (!resp.ok) throw new Error('删除失败: ' + resp.status);
      return await resp.json();
    }
  };

  // ==================== Front Matter 模块 ====================
  const FM = {
    // 解析 Markdown 文件中的 Front Matter
    parse: function (content) {
      var match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (!match) return { meta: {}, excerpt: '', body: content };

      var meta = {};
      var lines = match[1].split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        var key = line.substring(0, colonIdx).trim();
        var val = line.substring(colonIdx + 1).trim();

        // 处理数组格式 [a, b]
        if (val.startsWith('[') && val.endsWith(']')) {
          val = val.slice(1, -1).split(',').map(function (s) { return s.trim(); });
        }
        // 去除引号
        if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1);
        }
        meta[key] = val;
      }

      // 分离摘要和正文（以 excerpt_separator 为界）
      var fullBody = match[2];
      var excerpt = '';
      var body = fullBody;

      // excerpt_separator 是 ```，找到第一个代码块标记作为分隔
      var sepIdx = fullBody.indexOf('```');
      if (sepIdx > 0) {
        excerpt = fullBody.substring(0, sepIdx).trim();
        body = fullBody.substring(sepIdx);
      }

      return { meta: meta, excerpt: excerpt, body: body };
    },

    // 生成完整 Markdown 文件
    generate: function (meta, excerpt, body) {
      var lines = ['---'];
      lines.push('layout: ' + (meta.layout || 'post_layout'));
      lines.push('title: "' + meta.title + '"');
      lines.push('date: ' + meta.date);

      if (meta.categories && meta.categories.length > 0) {
        var cats = Array.isArray(meta.categories) ? meta.categories : [meta.categories];
        cats = cats.filter(function (c) { return c; });
        if (cats.length > 0) {
          lines.push('categories: [' + cats.join(', ') + ']');
        }
      }

      if (meta.location) {
        lines.push('location: ' + meta.location);
      }

      lines.push('excerpt_separator: "```"');
      lines.push('---');
      lines.push('');

      // 摘要段落（在正文之前）
      if (excerpt) {
        lines.push(excerpt);
        lines.push('');
      }

      lines.push(body);
      return lines.join('\n');
    },

    // 生成文件名
    generateFilename: function (title, date) {
      // 简单处理：替换空格和特殊字符
      var slug = title
        .toLowerCase()
        .replace(/[^\w一-鿿\-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      return date + '-' + slug + '.md';
    }
  };

  // ==================== 路由模块 ====================
  const Router = {
    init: function () {
      var self = this;
      window.addEventListener('hashchange', function () { self.route(); });
      this.route();
    },

    navigate: function (view) {
      location.hash = '#/' + view;
    },

    route: function () {
      var hash = location.hash || '';

      // 未认证时跳转登录
      if (!Auth.isAuthenticated() && hash !== '#/login') {
        this.navigate('login');
        return;
      }

      // 已认证时不显示登录页
      if (Auth.isAuthenticated() && (hash === '#/login' || hash === '' || hash === '#/')) {
        this.navigate('posts');
        return;
      }

      // 隐藏所有视图
      $$('.view').forEach(function (v) { v.classList.add('d-none'); });

      // 更新导航栏状态
      this.updateNavbar();

      // 路由匹配
      if (hash === '#/login') {
        this.showLogin();
      } else if (hash === '#/posts') {
        this.showPosts();
      } else if (hash === '#/editor/new') {
        this.showEditor(null);
      } else if (hash.startsWith('#/editor/')) {
        var path = decodeURIComponent(hash.replace('#/editor/', ''));
        this.showEditor(path);
      } else {
        this.navigate('posts');
      }
    },

    updateNavbar: function () {
      var user = Auth.getUser();
      var userInfo = $('#userInfo');
      var logoutBtn = $('#logoutBtn');
      var brand = $('#adminBrand');
      var isLogin = (location.hash === '#/login' || location.hash === '');

      // 登录页隐藏"文章管理"导航品牌按钮（保留占位，避免右侧按钮位移）
      if (brand) {
        brand.style.visibility = isLogin ? 'hidden' : 'visible';
      }

      if (Auth.isAuthenticated() && user) {
        userInfo.textContent = user.login;
        userInfo.classList.remove('d-none');
        logoutBtn.classList.remove('d-none');
      } else {
        userInfo.classList.add('d-none');
        logoutBtn.classList.add('d-none');
      }
    },

    showLogin: function () {
      $('#view-login').classList.remove('d-none');
      Mascots.mount();
    },

    showPosts: function () {
      $('#view-posts').classList.remove('d-none');
      Mascots.destroy();
      PostList.load();
    },

    showEditor: function (path) {
      $('#view-editor').classList.remove('d-none');
      Mascots.destroy();
      Editor.load(path);
    }
  };

  // ==================== 文章列表模块 ====================
  const PostList = {
    posts: [],
    drafts: [],
    currentTab: 'published',
    loading: false,

    async load() {
      if (this.loading) return;
      this.loading = true;

      var listEl = $('#postsList');
      var loadingEl = $('#postsLoading');
      var emptyEl = $('#postsEmpty');

      listEl.innerHTML = '';
      loadingEl.classList.remove('d-none');
      emptyEl.classList.add('d-none');

      try {
        // 并行请求已发布文章和草稿
        var results = await Promise.all([API.listPosts(), API.listDrafts()]);
        this.posts = results[0];
        this.drafts = results[1];

        loadingEl.classList.add('d-none');

        // 更新 Tab 计数
        var pubCount = $('#tabPublishedCount');
        var draftCount = $('#tabDraftsCount');
        if (pubCount) pubCount.textContent = this.posts.length || '';
        if (draftCount) draftCount.textContent = this.drafts.length || '';

        this.renderCurrent();
      } catch (e) {
        loadingEl.classList.add('d-none');
        showToast('加载失败: ' + e.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    switchTab: function (tab) {
      this.currentTab = tab;
      // 更新 Tab 激活状态
      $$('.posts-tab').forEach(function (btn) {
        if (btn.getAttribute('data-tab') === tab) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
      this.renderCurrent();
    },

    renderCurrent: function () {
      var emptyEl = $('#postsEmpty');
      if (this.currentTab === 'drafts') {
        if (this.drafts.length === 0) {
          $('#postsList').innerHTML = '';
          emptyEl.classList.remove('d-none');
          emptyEl.querySelector('p').textContent = '暂无草稿';
        } else {
          emptyEl.classList.add('d-none');
          this.render(this.drafts, true);
        }
      } else {
        if (this.posts.length === 0) {
          $('#postsList').innerHTML = '';
          emptyEl.classList.remove('d-none');
          emptyEl.querySelector('p').textContent = '暂无文章';
        } else {
          emptyEl.classList.add('d-none');
          this.render(this.posts, false);
        }
      }
    },

    render: function (posts, isDraft) {
      var listEl = $('#postsList');
      var html = '';

      for (var i = 0; i < posts.length; i++) {
        var file = posts[i];
        var match = file.name.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
        var date = match ? match[1] : '';
        var titleSlug = match ? match[2] : file.name.replace(/\.md$/, '');
        var displayTitle = decodeURIComponent(titleSlug.replace(/-/g, ' '));

        var draftBadge = isDraft ? '<span class="draft-badge">草稿</span>' : '';

        html += '<div class="post-item">' +
          '<div class="post-info">' +
          '<h4>' + this.escapeHtml(displayTitle) + ' ' + draftBadge + '</h4>' +
          '<div class="post-meta">' +
          (date ? '<span><i class="fas fa-calendar"></i> ' + date + '</span>' : '') +
          '</div>' +
          '</div>' +
          '<div class="post-actions">' +
          '<button class="admin-btn admin-btn-ghost" title="预览" data-path="' + file.path + '" onclick="AdminApp.previewPost(this)">' +
          '<i class="fas fa-eye"></i></button>' +
          '<a href="#/editor/' + encodeURIComponent(file.path) + '" class="admin-btn admin-btn-ghost">' +
          '<i class="fas fa-edit"></i> 编辑</a>' +
          '<button class="admin-btn admin-btn-danger" data-path="' + file.path + '" data-sha="' + file.sha + '" data-name="' + this.escapeHtml(displayTitle) + '" onclick="AdminApp.confirmDelete(this)">' +
          '<i class="fas fa-trash"></i></button>' +
          '</div>' +
          '</div>';
      }

      listEl.innerHTML = html;
    },

    filter: function (keyword) {
      var source = this.currentTab === 'drafts' ? this.drafts : this.posts;
      var isDraft = this.currentTab === 'drafts';

      if (!keyword) {
        this.render(source, isDraft);
        return;
      }
      var lk = keyword.toLowerCase();
      var filtered = source.filter(function (f) {
        return f.name.toLowerCase().indexOf(lk) !== -1;
      });
      this.render(filtered, isDraft);

      if (filtered.length === 0) {
        $('#postsList').innerHTML = '<div class="post-item" style="justify-content:center;color:var(--admin-text-muted)">没有匹配的文章</div>';
      }
    },

    escapeHtml: function (str) {
      var div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  };

  // ==================== 编辑器模块 ====================
  const Editor = {
    instance: null,
    currentSha: null,
    currentPath: null,
    isDirty: false,
    isDraft: false,

    async load(path) {
      // 初始化 EasyMDE
      if (!this.instance) {
        this.instance = new EasyMDE({
          element: $('#markdown-editor'),
          spellChecker: false,
          minHeight: '400px',
          placeholder: '开始撰写文章内容...',
          autosave: {
            enabled: true,
            uniqueId: 'mgw-admin-editor',
            delay: 10000
          },
          renderingConfig: {
            sanitizerFunction: function (html) {
              return DOMPurify.sanitize(html);
            }
          },
          toolbar: [
            'bold', 'italic', 'strikethrough', '|',
            'heading-1', 'heading-2', 'heading-3', '|',
            'code', 'quote', 'unordered-list', 'ordered-list', 'table', '|',
            'link', 'image', 'horizontal-rule', '|',
            'preview', 'side-by-side', 'fullscreen'
          ],
          status: ['lines', 'words', 'cursor']
        });

        // 监听内容变化
        var self = this;
        this.instance.codemirror.on('change', function () {
          self.isDirty = true;
        });
      }

      // 清除自动保存的内容（如果是加载新文章）
      this.isDirty = false;
      this.isDraft = false;
      this.updateStatus('');

      if (path) {
        // 编辑已有文章（可能是草稿或已发布）
        this.updateStatus('加载中...', '');
        try {
          var post = await API.getPost(path);
          var parsed = FM.parse(post.content);

          $('#postTitle').value = parsed.meta.title || '';
          var dateVal = parsed.meta.date || '';
          // 提取日期部分 YYYY-MM-DD
          var dateMatch = dateVal.match(/(\d{4}-\d{2}-\d{2})/);
          $('#postDate').value = dateMatch ? dateMatch[1] : '';

          var categories = parsed.meta.categories;
          if (Array.isArray(categories)) {
            $('#postCategories').value = categories.join(', ');
          } else {
            $('#postCategories').value = categories || '';
          }
          $('#postLocation').value = parsed.meta.location || '';
          $('#postExcerpt').value = parsed.excerpt || '';

          this.instance.value(parsed.body);
          this.currentSha = post.sha;
          this.currentPath = post.path;
          this.updateStatus('');

          // 判断是否为草稿
          this.isDraft = post.path.startsWith(CONFIG.draftsDir + '/');

          // 更新按钮文字
          if (this.isDraft) {
            $('#publishBtn').innerHTML = '<i class="fas fa-paper-plane"></i> 发布';
            $('#saveDraftBtn').innerHTML = '<i class="fas fa-file-alt"></i> 更新草稿';
          } else {
            $('#publishBtn').innerHTML = '<i class="fas fa-save"></i> 更新';
            $('#saveDraftBtn').innerHTML = '<i class="fas fa-file-alt"></i> 保存草稿';
          }
        } catch (e) {
          this.updateStatus('加载失败: ' + e.message, 'error');
        }
      } else {
        // 新建文章
        $('#postTitle').value = '';
        $('#postDate').value = new Date().toISOString().split('T')[0];
        $('#postCategories').value = '';
        $('#postLocation').value = '';
        $('#postExcerpt').value = '';
        this.instance.value('');
        this.currentSha = null;
        this.currentPath = null;

        // 更新发布按钮文字
        $('#publishBtn').innerHTML = '<i class="fas fa-paper-plane"></i> 发布';
        $('#saveDraftBtn').innerHTML = '<i class="fas fa-file-alt"></i> 保存草稿';
      }
    },

    async publish() {
      var title = $('#postTitle').value.trim();
      var date = $('#postDate').value;
      var categories = $('#postCategories').value.trim();
      var location = $('#postLocation').value.trim();
      var excerpt = $('#postExcerpt').value.trim();
      var body = this.instance.value();

      // 校验
      if (!title) {
        showToast('请填写文章标题', 'error');
        $('#postTitle').focus();
        return;
      }
      if (!date) {
        showToast('请选择日期', 'error');
        $('#postDate').focus();
        return;
      }
      if (!body.trim()) {
        showToast('请填写文章内容', 'error');
        return;
      }

      // 组装 Front Matter
      var meta = {
        layout: 'post_layout',
        title: title,
        date: date + ' 12:00:00 +0800',
        categories: categories ? categories.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
        location: location
      };

      var content = FM.generate(meta, excerpt, body);

      this.updateStatus('保存中...', '');
      $('#publishBtn').disabled = true;

      try {
        if (this.isDraft) {
          // ---- 草稿升级：保存到 _posts/，再删除 _drafts/ 旧文件 ----
          var oldDraftPath = this.currentPath;
          var oldDraftSha  = this.currentSha;
          var newPostPath  = CONFIG.postsDir + '/' + FM.generateFilename(title, date);

          var result = await API.savePost(newPostPath, content, '发布文章: ' + title, null);

          // 删除草稿（失败不阻断发布）
          try {
            await API.deletePost(oldDraftPath, oldDraftSha, '发布草稿，删除原草稿: ' + title);
          } catch (delErr) {
            console.warn('草稿删除失败（已忽略）:', delErr);
          }

          this.currentSha  = result.content.sha;
          this.currentPath = result.content.path;
          this.isDraft     = false;
          this.isDirty     = false;
          this.updateStatus('✓ 已发布', 'success');
          showToast('草稿已发布，等待自动构建...', 'success');
          $('#publishBtn').innerHTML   = '<i class="fas fa-save"></i> 更新';
          $('#saveDraftBtn').innerHTML = '<i class="fas fa-file-alt"></i> 保存草稿';
        } else {
          // ---- 普通发布 / 更新 ----
          var isUpdate = !!this.currentSha;
          var path     = this.currentPath || (CONFIG.postsDir + '/' + FM.generateFilename(title, date));
          var message  = isUpdate ? '更新文章: ' + title : '发布文章: ' + title;

          var result = await API.savePost(path, content, message, this.currentSha);
          this.currentSha  = result.content.sha;
          this.currentPath = result.content.path;
          this.isDirty     = false;
          this.updateStatus('✓ 已保存', 'success');
          showToast(isUpdate ? '文章已更新，等待自动构建...' : '文章已发布，等待自动构建...', 'success');
          $('#publishBtn').innerHTML = '<i class="fas fa-save"></i> 更新';
        }
      } catch (e) {
        this.updateStatus('保存失败', 'error');
        showToast('保存失败: ' + e.message, 'error');
      } finally {
        $('#publishBtn').disabled = false;
      }
    },

    async saveDraft() {
      var title      = $('#postTitle').value.trim();
      var date       = $('#postDate').value || new Date().toISOString().split('T')[0];
      var categories = $('#postCategories').value.trim();
      var location   = $('#postLocation').value.trim();
      var excerpt    = $('#postExcerpt').value.trim();
      var body       = this.instance.value();

      if (!title) {
        showToast('请填写文章标题', 'error');
        $('#postTitle').focus();
        return;
      }

      // 补全日期输入框（若用户未填）
      if (!$('#postDate').value) {
        $('#postDate').value = date;
      }

      var meta = {
        layout: 'post_layout',
        title: title,
        date: date + ' 12:00:00 +0800',
        categories: categories ? categories.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
        location: location
      };

      var content  = FM.generate(meta, excerpt, body);

      // 若已是草稿，保持原路径（更新）；否则生成新路径
      var path    = (this.isDraft && this.currentPath)
        ? this.currentPath
        : CONFIG.draftsDir + '/' + FM.generateFilename(title, date);
      var sha     = (this.isDraft && this.currentPath) ? this.currentSha : null;
      var message = (this.isDraft && this.currentPath)
        ? '更新草稿: ' + title
        : '保存草稿: ' + title;

      this.updateStatus('保存中...', '');
      $('#saveDraftBtn').disabled = true;

      try {
        var result = await API.savePost(path, content, message, sha);
        this.currentSha  = result.content.sha;
        this.currentPath = result.content.path;
        this.isDraft     = true;
        this.isDirty     = false;
        this.updateStatus('✓ 草稿已保存', 'success');
        showToast('草稿已保存', 'success');
        $('#saveDraftBtn').innerHTML = '<i class="fas fa-file-alt"></i> 更新草稿';
        $('#publishBtn').innerHTML   = '<i class="fas fa-paper-plane"></i> 发布';
      } catch (e) {
        this.updateStatus('保存失败', 'error');
        showToast('保存失败: ' + e.message, 'error');
      } finally {
        $('#saveDraftBtn').disabled = false;
      }
    },

    updateStatus: function (text, type) {
      var el = $('#saveStatus');
      el.textContent = text;
      el.className = 'save-status' + (type ? ' ' + type : '');
    }
  };

  // ==================== 主题切换 ====================
  const Theme = {
    init: function () {
      var toggle = $('#themeToggle');
      if (!toggle) return;

      toggle.addEventListener('click', function () {
        var current = document.documentElement.getAttribute('data-theme') || 'dark';
        var next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        Theme.updateIcon();
      });

      this.updateIcon();
    },

    updateIcon: function () {
      var icon = $('#themeIcon');
      if (!icon) return;
      var isDark = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark';
      icon.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    }
  };

  // ==================== 删除功能 ====================
  const DeleteHandler = {
    pendingPath: null,
    pendingSha: null,

    show: function (path, sha, name) {
      this.pendingPath = path;
      this.pendingSha = sha;
      $('#deletePostName').textContent = name;
      $('#deleteModal').classList.remove('d-none');
    },

    hide: function () {
      $('#deleteModal').classList.add('d-none');
      this.pendingPath = null;
      this.pendingSha = null;
    },

    async confirm() {
      if (!this.pendingPath) return;

      var name = $('#deletePostName').textContent;
      $('#confirmDeleteBtn').disabled = true;

      try {
        await API.deletePost(this.pendingPath, this.pendingSha, '删除文章: ' + name);
        this.hide();
        showToast('文章已删除', 'success');
        PostList.load();
      } catch (e) {
        showToast('删除失败: ' + e.message, 'error');
      } finally {
        $('#confirmDeleteBtn').disabled = false;
      }
    }
  };

  // ==================== 预览功能 ====================
  const PreviewHandler = {
    show: function (path) {
      var modal     = $('#previewModal');
      var titleEl   = $('#previewTitle');
      var loadingEl = $('#previewLoading');
      var errorEl   = $('#previewError');
      var metaEl    = $('#previewMeta');
      var contentEl = $('#previewContent');
      var bodyEl    = $('#previewBody');

      // 重置状态
      titleEl.textContent = '文章预览';
      loadingEl.classList.remove('d-none');
      errorEl.classList.add('d-none');
      metaEl.classList.add('d-none');
      contentEl.classList.add('d-none');
      contentEl.innerHTML = '';
      if (bodyEl) bodyEl.scrollTop = 0;

      modal.classList.remove('d-none');

      API.getPost(path).then(function (post) {
        var parsed = FM.parse(post.content);
        var meta   = parsed.meta;

        titleEl.textContent = meta.title || post.name.replace(/\.md$/, '');

        var metaHtml = '';
        if (meta.date) {
          var dateStr = String(meta.date).split(' ')[0];
          metaHtml += '<span><i class="fas fa-calendar"></i> ' + PostList.escapeHtml(dateStr) + '</span>';
        }
        if (meta.categories) {
          var cats = Array.isArray(meta.categories) ? meta.categories : [meta.categories];
          cats.forEach(function (c) {
            if (c) {
              metaHtml += '<span class="preview-category"><i class="fas fa-tag"></i> ' +
                PostList.escapeHtml(c) + '</span>';
            }
          });
        }
        if (meta.location) {
          metaHtml += '<span><i class="fas fa-map-marker-alt"></i> ' +
            PostList.escapeHtml(meta.location) + '</span>';
        }

        var fullText = (parsed.excerpt ? parsed.excerpt + '\n\n' : '') + parsed.body;
        var rawHtml  = marked.parse(fullText);
        var safeHtml = DOMPurify.sanitize(rawHtml);

        loadingEl.classList.add('d-none');
        if (metaHtml) {
          metaEl.innerHTML = metaHtml;
          metaEl.classList.remove('d-none');
        }
        contentEl.innerHTML = safeHtml;
        contentEl.classList.remove('d-none');

      }).catch(function (e) {
        loadingEl.classList.add('d-none');
        errorEl.textContent = '加载失败：' + e.message;
        errorEl.classList.remove('d-none');
      });
    },

    hide: function () {
      $('#previewModal').classList.add('d-none');
    }
  };

  // ==================== 初始化 ====================
  document.addEventListener('DOMContentLoaded', function () {
    Auth.init();
    Theme.init();

    // 登录按钮
    $('#loginBtn').addEventListener('click', async function () {
      var token = $('#tokenInput').value.trim();
      var errorEl = $('#loginError');
      errorEl.classList.add('d-none');

      if (!token) {
        errorEl.textContent = '请输入 Token';
        errorEl.classList.remove('d-none');
        return;
      }

      this.disabled = true;
      this.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 验证中...';

      try {
        await Auth.login(token);
        Router.navigate('posts');
      } catch (e) {
        errorEl.textContent = e.message;
        errorEl.classList.remove('d-none');
      } finally {
        this.disabled = false;
        this.innerHTML = '<i class="fas fa-sign-in-alt"></i> 验证并登录';
      }
    });

    // Token 输入框回车登录
    $('#tokenInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        $('#loginBtn').click();
      }
    });

    // 退出按钮
    $('#logoutBtn').addEventListener('click', function () {
      Auth.logout();
      Router.navigate('login');
      showToast('已退出登录');
    });

    // 搜索
    $('#postsSearchInput').addEventListener('input', function () {
      PostList.filter(this.value.trim());
    });

    // 返回列表
    $('#backToListBtn').addEventListener('click', function () {
      if (Editor.isDirty) {
        if (!confirm('内容尚未保存，确定要离开吗？')) return;
      }
      Router.navigate('posts');
    });

    // 发布按钮
    $('#publishBtn').addEventListener('click', function () {
      Editor.publish();
    });

    // 保存草稿按钮
    $('#saveDraftBtn').addEventListener('click', function () {
      Editor.saveDraft();
    });

    // Tab 切换
    $$('.posts-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        PostList.switchTab(this.getAttribute('data-tab'));
      });
    });

    // Ctrl+S 快捷键保存
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (!$('#view-editor').classList.contains('d-none')) {
          Editor.publish();
        }
      }
      if (e.key === 'Escape') {
        if (!$('#previewModal').classList.contains('d-none')) {
          PreviewHandler.hide();
        }
      }
    });

    // 删除模态框
    $('#deleteModalClose').addEventListener('click', function () { DeleteHandler.hide(); });
    $('#deleteCancelBtn').addEventListener('click', function () { DeleteHandler.hide(); });
    $('#confirmDeleteBtn').addEventListener('click', function () { DeleteHandler.confirm(); });
    $('#deleteModal').addEventListener('click', function (e) {
      if (e.target === this) DeleteHandler.hide();
    });

    // 预览模态框
    $('#previewModalClose').addEventListener('click', function () { PreviewHandler.hide(); });
    $('#previewModal').addEventListener('click', function (e) {
      if (e.target === this) PreviewHandler.hide();
    });

    // 初始化路由
    Router.init();
  });

  // 暴露全局接口（给 HTML onclick 使用）
  window.AdminApp = {
    confirmDelete: function (btn) {
      var path = btn.getAttribute('data-path');
      var sha  = btn.getAttribute('data-sha');
      var name = btn.getAttribute('data-name');
      DeleteHandler.show(path, sha, name);
    },
    previewPost: function (btn) {
      var path = btn.getAttribute('data-path');
      PreviewHandler.show(path);
    }
  };

  // ==================== 卡通角色 ====================
  var Mascots = {
    mouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    isTyping: false,
    isLooking: false,
    lookTimer: null,
    rafId: null,
    _bound: false,

    // 动态挂载角色 DOM 并启动动画（仅登录页调用）
    mount: function () {
      if (document.getElementById('mascotsPanel')) return; // 幂等
      var panel = document.createElement('div');
      panel.className = 'mascots-panel';
      panel.id = 'mascotsPanel';
      panel.innerHTML =
        '<div class="mascot mascot-purple" id="m-purple">' +
          '<div class="mascot-face" id="m-purple-face">' +
            '<div class="eyeball" data-max-dist="5"><div class="eyeball-pupil"></div></div>' +
            '<div class="eyeball" data-max-dist="5"><div class="eyeball-pupil"></div></div>' +
          '</div>' +
        '</div>' +
        '<div class="mascot mascot-black" id="m-black">' +
          '<div class="mascot-face" id="m-black-face">' +
            '<div class="eyeball" data-max-dist="4"><div class="eyeball-pupil"></div></div>' +
            '<div class="eyeball" data-max-dist="4"><div class="eyeball-pupil"></div></div>' +
          '</div>' +
        '</div>' +
        '<div class="mascot mascot-orange" id="m-orange">' +
          '<div class="mascot-face" id="m-orange-face">' +
            '<div class="pupil" data-max-dist="5"></div>' +
            '<div class="pupil" data-max-dist="5"></div>' +
          '</div>' +
        '</div>' +
        '<div class="mascot mascot-yellow" id="m-yellow">' +
          '<div class="mascot-face" id="m-yellow-face">' +
            '<div class="pupil" data-max-dist="5"></div>' +
            '<div class="pupil" data-max-dist="5"></div>' +
          '</div>' +
          '<div class="mascot-mouth" id="m-yellow-mouth"></div>' +
        '</div>';
      document.body.appendChild(panel);
      this._start();
    },

    // 销毁角色 DOM 并停止动画（切换到非登录页时调用）
    destroy: function () {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      var panel = document.getElementById('mascotsPanel');
      if (panel) panel.parentNode.removeChild(panel);
    },

    // 启动事件监听和 RAF（内部调用）
    _start: function () {
      var self = this;
      // 事件监听只注册一次（跨 mount/destroy 周期复用）
      if (!this._bound) {
        window.addEventListener('mousemove', function (e) {
          self.mouse.x = e.clientX;
          self.mouse.y = e.clientY;
        }, { passive: true });
        document.addEventListener('focusin', function (e) {
          if (e.target.matches('input, textarea') || e.target.closest('.CodeMirror')) {
            self.setTyping(true);
          }
        });
        document.addEventListener('focusout', function (e) {
          if (e.target.matches('input, textarea') || e.target.closest('.CodeMirror')) {
            setTimeout(function () {
              var a = document.activeElement;
              if (!a || (!a.matches('input, textarea') && !a.closest('.CodeMirror'))) {
                self.setTyping(false);
              }
            }, 80);
          }
        });
        this._bound = true;
      }
      // 启动 RAF tick
      var tick = function () {
        self.tick();
        self.rafId = requestAnimationFrame(tick);
      };
      self.rafId = requestAnimationFrame(tick);
      // 推迟到下一帧再启动眨眼，确保 DOM 已完成渲染后再查询节点
      requestAnimationFrame(function () {
        self.startBlink('#m-purple', 9);
        self.startBlink('#m-black', 7);
      });
    },

    // 计算 body 倾斜 + face 偏移（参考 1.txt，cy 取 height/3）
    calcPos: function (el) {
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 3;
      var dx = this.mouse.x - cx;
      var dy = this.mouse.y - cy;
      return {
        faceX:    Math.max(-15, Math.min(15, dx / 20)),
        faceY:    Math.max(-10, Math.min(10, dy / 30)),
        bodySkew: Math.max(-6,  Math.min(6, -dx / 120))
      };
    },

    // 计算眼球/瞳孔偏移
    calcEyePos: function (el, maxDist) {
      var r = el.getBoundingClientRect();
      var dx = this.mouse.x - (r.left + r.width / 2);
      var dy = this.mouse.y - (r.top + r.height / 2);
      var dist = Math.min(Math.sqrt(dx * dx + dy * dy), maxDist);
      var angle = Math.atan2(dy, dx);
      return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
    },

    tick: function () {
      var purple = document.getElementById('m-purple');
      var black  = document.getElementById('m-black');
      var orange = document.getElementById('m-orange');
      var yellow = document.getElementById('m-yellow');
      var pFace  = document.getElementById('m-purple-face');
      var bFace  = document.getElementById('m-black-face');
      var oFace  = document.getElementById('m-orange-face');
      var yFace  = document.getElementById('m-yellow-face');
      var yMouth = document.getElementById('m-yellow-mouth');
      if (!purple || !black || !orange || !yellow) return;

      // 紫色
      var pp = this.calcPos(purple);
      if (this.isTyping) {
        purple.style.transform = 'skewX(' + (pp.bodySkew - 12) + 'deg) translateX(10px)';
        purple.style.height = '210px';
      } else {
        purple.style.transform = 'skewX(' + pp.bodySkew + 'deg)';
        purple.style.height = '';
      }
      if (!this.isLooking && pFace) {
        var pfx = pp.faceX >= 0 ? Math.min(20, pp.faceX * 1.5) : pp.faceX;
        pFace.style.transform = 'translate(' + pfx + 'px,' + pp.faceY + 'px)';
      }

      // 黑色
      var bp = this.calcPos(black);
      if (this.isLooking) {
        black.style.transform = 'skewX(' + (bp.bodySkew * 1.5 + 10) + 'deg) translateX(5px)';
      } else if (this.isTyping) {
        black.style.transform = 'skewX(' + (bp.bodySkew * 1.5) + 'deg)';
      } else {
        black.style.transform = 'skewX(' + bp.bodySkew + 'deg)';
      }
      if (!this.isLooking && bFace) {
        bFace.style.transform = 'translate(' + bp.faceX + 'px,' + bp.faceY + 'px)';
      }

      // 橙色
      var op = this.calcPos(orange);
      orange.style.transform = 'skewX(' + op.bodySkew + 'deg)';
      if (oFace) oFace.style.transform = 'translate(' + op.faceX + 'px,' + op.faceY + 'px)';

      // 黄色
      var yp = this.calcPos(yellow);
      yellow.style.transform = 'skewX(' + yp.bodySkew + 'deg)';
      if (yFace)  yFace.style.transform  = 'translate(' + yp.faceX + 'px,' + yp.faceY + 'px)';
      if (yMouth) yMouth.style.transform = 'translate(' + yp.faceX + 'px,' + yp.faceY + 'px)';

      // 裸瞳孔（橙/黄）
      var self = this;
      document.querySelectorAll('#mascotsPanel .pupil').forEach(function (p) {
        var maxD = parseFloat(p.getAttribute('data-max-dist')) || 5;
        var pos = self.calcEyePos(p, maxD);
        p.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px)';
      });

      // 白眼球内瞳孔（非对视状态时正常跟随鼠标）
      if (!this.isLooking) {
        document.querySelectorAll('#mascotsPanel .eyeball').forEach(function (eb) {
          var maxD = parseFloat(eb.getAttribute('data-max-dist')) || 5;
          var pupil = eb.querySelector('.eyeball-pupil');
          if (!pupil) return;
          var pos = self.calcEyePos(eb, maxD);
          pupil.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px)';
        });
      }
    },

    setTyping: function (active) {
      this.isTyping = active;
      var self = this;
      if (active && !this.isLooking) {
        this.isLooking = true;
        this._lookAt();
        clearTimeout(this.lookTimer);
        this.lookTimer = setTimeout(function () {
          self.isLooking = false;
        }, 800);
      } else if (!active) {
        clearTimeout(this.lookTimer);
        this.isLooking = false;
      }
    },

    // 紫/黑互相对视
    _lookAt: function () {
      var pFace = document.getElementById('m-purple-face');
      var bFace = document.getElementById('m-black-face');
      if (pFace) pFace.style.transform = 'translate(12px,20px)';
      document.querySelectorAll('#m-purple .eyeball-pupil').forEach(function (p) {
        p.style.transform = 'translate(3px,4px)';
      });
      if (bFace) bFace.style.transform = 'translate(0px,-18px)';
      document.querySelectorAll('#m-black .eyeball-pupil').forEach(function (p) {
        p.style.transform = 'translate(0px,-4px)';
      });
    },

    // 随机眨眼（眼球高度 collapse）
    startBlink: function (selector, size) {
      var schedule = function () {
        setTimeout(function () {
          // 每次眨眼时实时查询 DOM，panel 被 destroy 后自动停止调度
          var eyes = document.querySelectorAll(selector + ' .eyeball');
          if (!eyes.length) return;
          eyes.forEach(function (e) { e.style.height = '2px'; });
          setTimeout(function () {
            var eyes2 = document.querySelectorAll(selector + ' .eyeball');
            eyes2.forEach(function (e) { e.style.height = size + 'px'; });
            schedule();
          }, 150);
        }, Math.random() * 4000 + 3000);
      };
      schedule();
    }
  };

})();
